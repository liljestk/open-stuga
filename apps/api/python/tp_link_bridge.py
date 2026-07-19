"""Poll a local TP-Link hub or energy device and emit snapshots as NDJSON."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import UTC, datetime
from collections.abc import Callable
from typing import Any

try:
    from kasa import Discover, Module
except ImportError:
    print(
        json.dumps({"type": "error", "message": "python-kasa is not installed"}),
        flush=True,
    )
    raise SystemExit(2)


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def optional_number(value: Any) -> float | int | None:
    if isinstance(value, bool):
        return None
    return value if isinstance(value, (int, float)) else None


def energy_module(device: Any) -> Any | None:
    try:
        return device.modules.get(Module.Energy)
    except Exception:
        return None


def contact_open(device: Any, info: dict[str, Any]) -> bool | None:
    try:
        modules = device.modules
        contact_key = getattr(Module, "ContactSensor", None)
        contact = modules.get(contact_key) if contact_key is not None else None
        if contact is None:
            contact = next(
                (module for module in modules.values() if hasattr(module, "is_open")),
                None,
            )
        value = getattr(contact, "is_open") if contact is not None else None
        if isinstance(value, bool):
            return value
    except Exception:
        pass
    value = info.get("open")
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in {0, 1}:
        return bool(value)
    return None


def optional_attribute_number(target: Any, name: str) -> float | int | None:
    try:
        return optional_number(getattr(target, name))
    except Exception:
        return None


def child_snapshot(child: Any) -> dict[str, Any]:
    info = child.sys_info
    try:
        alias = child.alias
    except Exception:
        alias = None
    snapshot = {
        "deviceId": str(info.get("device_id", child.device_id)),
        "model": str(info.get("model", child.model)),
        "alias": alias,
        "status": info.get("status"),
        "temperature": optional_number(info.get("current_temp")),
        "temperatureUnit": info.get("temp_unit"),
        "humidity": optional_number(info.get("current_humidity")),
        "battery": optional_number(info.get("battery_percentage")),
        "contactOpen": contact_open(child, info),
    }
    if (energy := energy_module(child)) is not None:
        snapshot.update(
            {
                "power": optional_attribute_number(energy, "current_consumption"),
                # python-kasa defines this as kWh accumulated since reboot.
                # Its daily/monthly counters intentionally are not substituted.
                "energy": optional_attribute_number(energy, "consumption_total"),
            }
        )
    return snapshot


def direct_energy_snapshots(device: Any) -> list[dict[str, Any]]:
    children = [
        child
        for child in getattr(device, "children", [])
        if energy_module(child) is not None
    ]
    targets = children or ([device] if energy_module(device) is not None else [])
    return [child_snapshot(target) for target in targets]


async def connect_and_poll(
    host: str,
    username: str,
    password: str,
    interval_seconds: float,
    list_once: bool,
    on_success: Callable[[], None] | None = None,
) -> None:
    device: Any | None = None
    try:
        device = await Discover.discover_single(
            host,
            username=username,
            password=password,
            discovery_timeout=10,
            timeout=10,
        )
        if device is None:
            raise RuntimeError(f"No supported TP-Link device responded at {host}")
        await device.update(update_children=True)
        model = str(device.model).upper().split("(", 1)[0].strip()
        is_hub = model in {"H100", "H200"}
        if not is_hub and not direct_energy_snapshots(device):
            raise RuntimeError(
                f"Device at {host} is {model}, not an H100/H200 hub or a device "
                "with a python-kasa Energy module"
            )

        while True:
            snapshots = (
                [child_snapshot(child) for child in device.children]
                if is_hub
                else direct_energy_snapshots(device)
            )
            emit(
                {
                    "type": "snapshot",
                    "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                    "hubModel": model,
                    "sourceType": "hub" if is_hub else "energy-device",
                    "devices": snapshots,
                }
            )
            if on_success is not None:
                on_success()
            if list_once:
                return
            await asyncio.sleep(interval_seconds)
            await device.update(update_children=True)
    finally:
        if device is not None:
            try:
                disconnect = getattr(device, "disconnect", None)
                if callable(disconnect):
                    await disconnect()
            except Exception:
                pass


async def discover_hubs(username: str, password: str) -> None:
    credentials = (
        {"username": username, "password": password} if username and password else {}
    )
    configured_targets = [
        target.strip()
        for target in os.environ.get("TP_LINK_DISCOVERY_TARGETS", "").split(",")
        if target.strip()
    ]
    targets: list[str | None] = list(dict.fromkeys(configured_targets)) or [None]
    attempts = [
        Discover.discover(
            discovery_timeout=5,
            timeout=10,
            **({"target": target} if target else {}),
            **credentials,
        )
        for target in targets
    ]
    results = await asyncio.gather(*attempts, return_exceptions=True)
    devices: dict[str, Any] = {}
    failures: list[tuple[str | None, BaseException]] = []
    for target, result in zip(targets, results, strict=True):
        if isinstance(result, BaseException):
            if isinstance(result, asyncio.CancelledError):
                raise result
            failures.append((target, result))
            continue
        for host, device in result.items():
            if host in devices:
                try:
                    await device.disconnect()
                except Exception:
                    pass
                continue
            devices[host] = device
    if not devices and len(failures) == len(results):
        raise RuntimeError(str(failures[0][1]))
    hubs: list[dict[str, Any]] = []
    for host, device in devices.items():
        try:
            model = str(device.model).upper().split("(", 1)[0].strip()
            if model not in {"H100", "H200"}:
                continue
            try:
                alias = device.alias
            except Exception:
                alias = None
            hubs.append(
                {
                    "host": host,
                    "model": model,
                    "alias": str(alias) if alias is not None else None,
                }
            )
        finally:
            try:
                await device.disconnect()
            except Exception:
                pass
    warnings = [
        f"TP-Link discovery via {target or 'the default broadcast'} failed: {str(error)[:200]}"
        for target, error in failures
    ]
    emit(
        {
            "type": "discovery",
            "hubs": sorted(hubs, key=lambda item: item["host"]),
            "warnings": warnings,
        }
    )


async def main() -> None:
    host = os.environ.get("TP_LINK_HOST", "").strip()
    username = os.environ.get("TP_LINK_USERNAME", "").strip()
    password = os.environ.get("TP_LINK_PASSWORD", "")
    if "--discover" in sys.argv[1:]:
        try:
            await discover_hubs(username, password)
        except Exception as error:
            emit({"type": "error", "message": f"TP-Link discovery failed: {error}"})
            raise SystemExit(1)
        return

    try:
        interval_ms = max(
            1000, int(os.environ.get("TP_LINK_POLL_INTERVAL_MS", "10000"))
        )
    except ValueError:
        interval_ms = 10000
    if not host or not username or not password:
        emit(
            {
                "type": "error",
                "message": "TP_LINK_HOST, TP_LINK_USERNAME, and TP_LINK_PASSWORD are required",
            }
        )
        raise SystemExit(2)

    list_once = "--list" in sys.argv[1:]
    backoff_seconds = 1
    while True:

        def reset_backoff() -> None:
            nonlocal backoff_seconds
            backoff_seconds = 1

        try:
            await connect_and_poll(
                host,
                username,
                password,
                interval_ms / 1000,
                list_once,
                on_success=reset_backoff,
            )
            if list_once:
                return
        except asyncio.CancelledError:
            raise
        except Exception as error:
            emit({"type": "error", "message": f"TP-Link connection failed: {error}"})
            if list_once:
                raise SystemExit(1)
            await asyncio.sleep(backoff_seconds)
            backoff_seconds = min(60, backoff_seconds * 2)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
