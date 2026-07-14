"""Poll a local TP-Link Tapo H100/H200 and emit child sensor snapshots as NDJSON."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import UTC, datetime
from typing import Any

try:
    from kasa import Discover
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


def child_snapshot(child: Any) -> dict[str, Any]:
    info = child.sys_info
    try:
        alias = child.alias
    except Exception:
        alias = None
    return {
        "deviceId": str(info.get("device_id", child.device_id)),
        "model": str(info.get("model", child.model)),
        "alias": alias,
        "status": info.get("status"),
        "temperature": optional_number(info.get("current_temp")),
        "temperatureUnit": info.get("temp_unit"),
        "humidity": optional_number(info.get("current_humidity")),
        "battery": optional_number(info.get("battery_percentage")),
    }


async def connect_and_poll(
    host: str, username: str, password: str, interval_seconds: float, list_once: bool
) -> None:
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
    if model not in {"H100", "H200"}:
        raise RuntimeError(
            f"Device at {host} is {model}, not a supported H100 or H200 hub"
        )

    while True:
        emit(
            {
                "type": "snapshot",
                "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                "hubModel": model,
                "devices": [child_snapshot(child) for child in device.children],
            }
        )
        if list_once:
            return
        await asyncio.sleep(interval_seconds)
        await device.update(update_children=True)


async def discover_hubs(username: str, password: str) -> None:
    credentials = (
        {"username": username, "password": password} if username and password else {}
    )
    devices = await Discover.discover(discovery_timeout=5, timeout=10, **credentials)
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
    emit({"type": "discovery", "hubs": sorted(hubs, key=lambda item: item["host"])})


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
        try:
            await connect_and_poll(
                host, username, password, interval_ms / 1000, list_once
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
