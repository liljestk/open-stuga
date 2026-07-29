"""Discover, bind, and read Gree/Wilfa heat pumps over the local network.

The process speaks NDJSON with Stugu. Binding keys only appear in the one-shot
``--bind`` response and are never logged.
"""

from __future__ import annotations

import argparse
import asyncio
import ipaddress
import json
import logging
import os
import signal
from datetime import UTC, datetime
from typing import Any

try:
    from greeclimate.cipher import CipherV1, CipherV2
    from greeclimate.device import (
        Device,
        DeviceInfo,
        FanSpeed,
        HorizontalSwing,
        Mode,
        Props,
        TemperatureUnits,
        VerticalSwing,
    )
    from greeclimate.discovery import Discovery
    from greeclimate.network import Response
except ImportError:  # Importable without optional dependencies for unit tests.
    CipherV1 = CipherV2 = Device = DeviceInfo = None  # type: ignore[assignment]
    FanSpeed = HorizontalSwing = Mode = Props = None  # type: ignore[assignment]
    TemperatureUnits = VerticalSwing = Discovery = Response = None  # type: ignore[assignment]


logging.getLogger("greeclimate").setLevel(logging.WARNING)
_STOP = asyncio.Event()


def emit(message: dict[str, Any]) -> None:
    print(json.dumps(message, separators=(",", ":"), ensure_ascii=False), flush=True)


def require_runtime() -> None:
    if Device is None or Discovery is None:
        raise RuntimeError("greeclimate is not installed")


def safe_close(protocol: Any) -> None:
    try:
        protocol.close()
    except (AttributeError, RuntimeError):
        pass


def normalized_mac(value: str) -> str:
    normalized = value.replace(":", "").replace("-", "").strip().upper()
    if len(normalized) != 12 or any(character not in "0123456789ABCDEF" for character in normalized):
        raise ValueError("GREE_MAC is invalid")
    return normalized


def optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def device_info_json(info: Any) -> dict[str, Any]:
    return {
        "host": str(info.ip),
        "port": int(info.port),
        "mac": normalized_mac(str(info.mac)),
        "name": optional_text(info.name),
        "brand": optional_text(info.brand),
        "model": optional_text(info.model),
        "version": optional_text(info.version),
    }


def discovery_targets() -> list[ipaddress.IPv4Address] | None:
    values = []
    for candidate in os.environ.get("GREE_DISCOVERY_TARGETS", "").split(","):
        candidate = candidate.strip()
        if candidate:
            values.append(ipaddress.IPv4Address(candidate))
    return values or None


async def scan_devices(wait_for: int = 3) -> list[Any]:
    require_runtime()
    discovery = Discovery(timeout=max(2, wait_for))
    try:
        return await discovery.scan(wait_for=wait_for, bcast_ifaces=discovery_targets())
    finally:
        safe_close(discovery)


def enum_label(enum_type: Any, value: Any) -> str | None:
    if value is None or enum_type is None:
        return None
    try:
        return enum_type(int(value)).name
    except (TypeError, ValueError):
        return f"unknown-{value}"


def celsius(value: Any, temperature_units: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if TemperatureUnits is not None and temperature_units == TemperatureUnits.F.value:
        number = (number - 32.0) * 5.0 / 9.0
    return round(number, 1)


def reported_temperature_c(device: Any) -> float | None:
    """Decode TemSen directly so greeclimate cannot fall back to the target."""
    raw = device.get_property(Props.TEMP_SENSOR)
    if raw is None or isinstance(raw, bool):
        return None
    try:
        encoded = float(raw)
    except (TypeError, ValueError):
        return None
    version = optional_text(getattr(device, "version", None))
    try:
        version_major = int(version.split(".", 1)[0]) if version else None
    except ValueError:
        version_major = None
    if version_major != 4:
        if encoded == 0:
            return None
        encoded -= 40
    if encoded < -60 or encoded > 60:
        return None
    units = device.temperature_units
    if TemperatureUnits is not None and units == TemperatureUnits.F.value:
        converter = getattr(device, "_convert_to_units", None)
        if not callable(converter):
            return None
        bit = device.get_property(Props.TEMP_BIT)
        try:
            encoded = converter(encoded, 0 if bit is None else bit)
        except (TypeError, ValueError):
            return None
    return celsius(encoded, units)


def state_json(device: Any) -> dict[str, Any]:
    current_temperature = reported_temperature_c(device)
    power = device.power
    selected_mode = enum_label(Mode, device.mode)
    mode = selected_mode.lower() if selected_mode and not selected_mode.startswith("unknown-") else None
    activity = "off" if power is False else "unknown"
    return {
        "observedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "available": True,
        "power": power,
        "selectedMode": mode,
        "targetTemperatureC": celsius(device.target_temperature, device.temperature_units),
        "currentTemperatureC": current_temperature,
        "currentTemperatureSource": "reported" if current_temperature is not None else "unavailable",
        "fanSpeed": enum_label(FanSpeed, device.fan_speed),
        "horizontalSwing": enum_label(HorizontalSwing, device.horizontal_swing),
        "verticalSwing": enum_label(VerticalSwing, device.vertical_swing),
        "quiet": bool(device.quiet) if device.quiet is not None else None,
        "turbo": device.turbo,
        "xfan": device.xfan,
        "activity": activity,
        "activityEvidence": "protocol" if power is False else "unavailable",
    }


async def refresh(device: Any, timeout_seconds: int = 15) -> None:
    response = asyncio.Event()

    def updated(*_args: Any) -> None:
        response.set()

    device.add_handler(Response.RESULT, updated)
    device.add_handler(Response.DATA, updated)
    try:
        await device.update_state()
        await asyncio.wait_for(response.wait(), timeout=timeout_seconds)
    finally:
        device.remove_handler(Response.RESULT, updated)
        device.remove_handler(Response.DATA, updated)


def cipher_for(version: int) -> Any:
    return CipherV2() if version == 2 else CipherV1()


async def connect_with_key(device: Any, key: str, cipher: Any) -> None:
    """Install a saved cipher and open the UDP transport omitted by bind(key=...)."""
    await device.bind(key=key, cipher=cipher)
    await asyncio.get_running_loop().create_datagram_endpoint(
        lambda: device,
        remote_addr=(str(device.device_info.ip), int(device.device_info.port)),
    )


async def bind_device(mac: str) -> None:
    target = normalized_mac(mac)
    infos = await scan_devices()
    info = next((item for item in infos if normalized_mac(str(item.mac)) == target), None)
    if info is None:
        raise RuntimeError("The selected heat pump was not found")
    device = Device(info, timeout=15, bind_timeout=10)
    try:
        await device.bind()
        await refresh(device)
        cipher_version = 2 if isinstance(device.device_cipher, CipherV2) else 1
        emit({
            "type": "bound",
            "device": device_info_json(info),
            "key": device.device_key,
            "cipherVersion": cipher_version,
            "state": state_json(device),
        })
    finally:
        safe_close(device)


async def discover() -> None:
    devices = [device_info_json(info) for info in await scan_devices()]
    unique = {device["mac"]: device for device in devices}
    emit({"type": "discovery", "devices": list(unique.values())})


def configured_info() -> Any:
    return DeviceInfo(
        os.environ["GREE_HOST"].strip(),
        int(os.environ.get("GREE_PORT", "7000")),
        normalized_mac(os.environ["GREE_MAC"]),
        os.environ.get("GREE_NAME", "").strip() or os.environ["GREE_MAC"],
        os.environ.get("GREE_BRAND", "").strip() or None,
        os.environ.get("GREE_MODEL", "").strip() or None,
        os.environ.get("GREE_VERSION", "").strip() or None,
    )


async def recover_info(mac: str) -> Any | None:
    infos = await scan_devices()
    return next((item for item in infos if normalized_mac(str(item.mac)) == mac), None)


async def poll() -> None:
    require_runtime()
    key = os.environ.get("GREE_KEY", "")
    cipher_version = int(os.environ.get("GREE_CIPHER_VERSION", "0"))
    if not key or cipher_version not in (1, 2):
        raise ValueError("GREE_KEY and a valid GREE_CIPHER_VERSION are required")
    interval = max(10, int(os.environ.get("GREE_POLL_INTERVAL_MS", "60000")) // 1000)
    info = configured_info()
    mac = normalized_mac(str(info.mac))
    failures = 0
    while not _STOP.is_set():
        device = Device(info, timeout=15)
        successful = False
        try:
            await connect_with_key(device, key, cipher_for(cipher_version))
            await refresh(device)
            emit({"type": "snapshot", "device": device_info_json(info), "state": state_json(device)})
            failures = 0
            successful = True
        except TimeoutError:
            failures += 1
            emit({"type": "error", "message": "Heat-pump poll timed out"})
        except asyncio.CancelledError:
            raise
        except Exception:
            failures += 1
            emit({"type": "error", "message": "Heat-pump poll failed"})
        finally:
            safe_close(device)
        if _STOP.is_set():
            break
        if successful:
            try:
                await asyncio.wait_for(_STOP.wait(), timeout=interval)
            except TimeoutError:
                pass
            continue
        if failures >= 2:
            try:
                recovered = await recover_info(mac)
                if recovered is not None:
                    previous_host = str(info.ip)
                    info = recovered
                    if str(info.ip) != previous_host:
                        emit({
                            "type": "host-change",
                            "previousHost": previous_host,
                            "host": str(info.ip),
                        })
                    failures = 0
            except Exception:
                pass
        try:
            await asyncio.wait_for(_STOP.wait(), timeout=min(60, 2 ** min(failures, 5)))
        except TimeoutError:
            pass


def stop() -> None:
    _STOP.set()


async def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--discover", action="store_true")
    parser.add_argument("--bind", action="store_true")
    args, _unknown = parser.parse_known_args()
    require_runtime()
    if args.discover:
        await discover()
    elif args.bind:
        await bind_device(os.environ.get("GREE_MAC", ""))
    else:
        await poll()


if __name__ == "__main__":
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        for signal_name in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(signal_name, stop)
            except (NotImplementedError, RuntimeError):
                pass
        loop.run_until_complete(main())
    except (KeyError, ValueError) as error:
        emit({"type": "error", "message": str(error)})
        raise SystemExit(2)
    except RuntimeError as error:
        emit({"type": "error", "message": str(error)})
        raise SystemExit(1)
    except KeyboardInterrupt:
        pass
    except Exception:
        emit({"type": "error", "message": "Gree bridge failed"})
        raise SystemExit(1)
