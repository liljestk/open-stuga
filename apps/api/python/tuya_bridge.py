"""Local-only Tuya discovery, verification, polling, and command worker.

Secrets arrive over stdin and never appear in process arguments, environment,
logs, discovery output, or runtime state messages. Stdout is NDJSON reserved
for the Stugu API process.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import queue
import select
import socket
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

try:
    import tinytuya
except ImportError:  # Importable for unit tests without optional dependencies.
    tinytuya = None  # type: ignore[assignment]

from tuya_profiles import command_datapoints, detect_profile, normalized_state, profile


MAX_LINE_BYTES = 64 * 1024
SUPPORTED_VERSIONS = {"3.1", "3.2", "3.3", "3.4", "3.5"}


def emit(message: dict[str, Any]) -> None:
    print(json.dumps(message, separators=(",", ":"), ensure_ascii=False), flush=True)


def public_error(
    error: BaseException,
    config: dict[str, Any] | None = None,
    fallback: str = "Tuya LAN request failed",
) -> str:
    message = str(error).strip()
    if config:
        for field in ("localKey", "deviceId"):
            secret = str(config.get(field, ""))
            if secret:
                message = message.replace(secret, "[redacted]")
    return message[:500] or fallback


def require_runtime() -> None:
    if tinytuya is None:
        raise RuntimeError("tinytuya is not installed")


def read_message() -> dict[str, Any]:
    line = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
    if not line or len(line) > MAX_LINE_BYTES:
        raise ValueError("The Tuya helper input is missing or too large")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise ValueError("The Tuya helper input must be an object")
    return value


def validated_config(value: Any, require_profile: bool = False) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Tuya configuration is invalid")
    host = str(value.get("host", "")).strip()
    device_id = str(value.get("deviceId", "")).strip()
    local_key = str(value.get("localKey", ""))
    version = str(value.get("protocolVersion", "")).strip()
    profile_id = str(value.get("profileId", "")).strip()
    poll_interval_ms = value.get("pollIntervalMs", 5000)
    try:
        address = ipaddress.IPv4Address(host)
    except ipaddress.AddressValueError as error:
        raise ValueError("The Tuya host must be an IPv4 address") from error
    local_networks = (
        ipaddress.IPv4Network("10.0.0.0/8"),
        ipaddress.IPv4Network("100.64.0.0/10"),
        ipaddress.IPv4Network("127.0.0.0/8"),
        ipaddress.IPv4Network("169.254.0.0/16"),
        ipaddress.IPv4Network("172.16.0.0/12"),
        ipaddress.IPv4Network("192.168.0.0/16"),
    )
    if not any(address in network for network in local_networks):
        raise ValueError("The Tuya host must be on the local network")
    if not device_id or len(device_id) > 200:
        raise ValueError("The Tuya device identity is invalid")
    if not local_key or len(local_key) > 256:
        raise ValueError("The Tuya local key is invalid")
    if version not in SUPPORTED_VERSIONS:
        raise ValueError("The Tuya protocol version is not supported")
    if require_profile:
        profile(profile_id)
    if (
        isinstance(poll_interval_ms, bool)
        or not isinstance(poll_interval_ms, (int, float))
        or poll_interval_ms < 2000
        or poll_interval_ms > 900000
    ):
        raise ValueError("The Tuya poll interval is invalid")
    return {
        "host": host,
        "deviceId": device_id,
        "localKey": local_key,
        "protocolVersion": version,
        "pollIntervalMs": round(float(poll_interval_ms)),
        **({"profileId": profile_id} if profile_id else {}),
    }


def device_for(config: dict[str, Any], host: str | None = None) -> Any:
    require_runtime()
    device = tinytuya.Device(
        config["deviceId"],
        host or config["host"],
        config["localKey"],
        version=float(config["protocolVersion"]),
        persist=True,
        connection_timeout=3,
        connection_retry_limit=1,
        connection_retry_delay=0,
    )
    return device


def checked_status(device: Any) -> dict[str, Any]:
    status = device.status()
    if not isinstance(status, dict) or "dps" not in status:
        message = status.get("Error") if isinstance(status, dict) else None
        raise OSError(str(message or "Tuya device did not return a valid status"))
    return status


def safe_close(device: Any) -> None:
    try:
        device.close()
    except (AttributeError, OSError):
        pass


def public_discovery(value: Any, host: str) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    device_id = str(value.get("gwId") or value.get("devId") or "").strip()
    version = str(value.get("version") or "").strip()
    if not device_id or len(device_id) > 200 or version not in SUPPORTED_VERSIONS:
        return None
    product_key = value.get("productKey")
    mac = value.get("mac")
    return {
        "host": host,
        "deviceId": device_id,
        "protocolVersion": version,
        "productKey": str(product_key).strip()[:200] if product_key else None,
        "mac": str(mac).strip()[:32] if mac else None,
    }


def discover(timeout_seconds: float = 8.0) -> list[dict[str, Any]]:
    """Listen on each Tuya UDP port independently so one conflict is non-fatal."""
    require_runtime()
    sockets: list[socket.socket] = []
    for port in (6666, 6667, 7000):
        listener = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("", port))
            listener.setblocking(False)
            sockets.append(listener)
        except OSError:
            listener.close()
    found: dict[str, dict[str, Any]] = {}
    deadline = time.monotonic() + max(1.0, min(15.0, timeout_seconds))
    try:
        while sockets and time.monotonic() < deadline:
            readable, _, _ = select.select(sockets, [], [], min(0.5, deadline - time.monotonic()))
            for listener in readable:
                try:
                    payload, address = listener.recvfrom(65535)
                    decoded = tinytuya.decrypt_udp(payload)
                    item = public_discovery(decoded, address[0])
                    if item:
                        found[item["deviceId"]] = item
                except (OSError, ValueError, TypeError):
                    continue
    finally:
        for listener in sockets:
            listener.close()
    return sorted(found.values(), key=lambda item: (item["host"], item["deviceId"]))


def probe(config: dict[str, Any]) -> dict[str, Any]:
    device = device_for(config)
    try:
        status = checked_status(device)
        selected = detect_profile(status)
        return {
            "type": "verified",
            "host": config["host"],
            "profile": selected,
            "state": normalized_state(status, selected["id"]),
        }
    finally:
        safe_close(device)


def local_candidates(host: str) -> list[str]:
    network = ipaddress.ip_network(f"{host}/24", strict=False)

    def open_port(candidate: str) -> str | None:
        try:
            with socket.create_connection((candidate, 6668), timeout=0.18):
                return candidate
        except OSError:
            return None

    addresses = [str(address) for address in network.hosts()]
    with ThreadPoolExecutor(max_workers=32) as executor:
        return [candidate for candidate in executor.map(open_port, addresses) if candidate]


def recover_host(config: dict[str, Any]) -> tuple[str, Any, dict[str, Any]] | None:
    for host in local_candidates(config["host"]):
        if host == config["host"]:
            continue
        device = device_for(config, host)
        try:
            status = checked_status(device)
            detected = detect_profile(status)
            if detected["id"] != config["profileId"]:
                safe_close(device)
                continue
            return host, device, status
        except (OSError, ValueError, TypeError):
            safe_close(device)
    return None


def input_reader(messages: queue.Queue[dict[str, Any] | None]) -> None:
    while True:
        line = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
        if not line:
            messages.put(None)
            return
        if len(line) > MAX_LINE_BYTES:
            continue
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                messages.put(value)
        except (TypeError, ValueError):
            continue


def worker(config: dict[str, Any], poll_interval: float) -> None:
    messages: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=100)
    threading.Thread(target=input_reader, args=(messages,), daemon=True).start()
    device: Any = None
    host = config["host"]
    failures = 0
    next_poll = 0.0
    while True:
        timeout = max(0.0, next_poll - time.monotonic())
        try:
            message = messages.get(timeout=timeout)
        except queue.Empty:
            message = {"type": "poll"}
        if message is None:
            safe_close(device)
            return
        request_id = str(message.get("requestId", ""))[:200]
        command_succeeded = False
        try:
            if device is None:
                device = device_for(config, host)
            if message.get("type") == "command":
                datapoints = command_datapoints(message.get("command"), config["profileId"])
                response = device.set_multiple_values(datapoints)
                if isinstance(response, dict) and response.get("Error"):
                    raise OSError(str(response["Error"]))
                status = checked_status(device)
                command_succeeded = True
            elif message.get("type") == "poll":
                status = checked_status(device)
            else:
                continue
            emit(
                {
                    "type": "snapshot",
                    "host": host,
                    "state": normalized_state(status, config["profileId"]),
                }
            )
            if command_succeeded:
                emit({"type": "command-result", "requestId": request_id, "ok": True})
            failures = 0
            next_poll = time.monotonic() + poll_interval
        except (OSError, ValueError, TypeError) as error:
            safe_close(device)
            device = None
            failures += 1
            emit(
                {
                    "type": "error",
                    "requestId": request_id or None,
                    "message": public_error(error, config),
                }
            )
            if failures >= 3:
                recovered = recover_host(config)
                if recovered:
                    previous = host
                    host, device, status = recovered
                    config["host"] = host
                    failures = 0
                    emit({"type": "host-change", "previousHost": previous, "host": host})
                    emit(
                        {
                            "type": "snapshot",
                            "host": host,
                            "state": normalized_state(status, config["profileId"]),
                        }
                    )
            next_poll = time.monotonic() + min(60.0, max(poll_interval, 2**failures))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--discover", action="store_true")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--worker", action="store_true")
    args = parser.parse_args()
    config: dict[str, Any] = {}
    try:
        if args.discover:
            emit({"type": "discovery", "devices": discover()})
            return 0
        config = validated_config(read_message(), require_profile=args.worker)
        if args.probe:
            emit(probe(config))
            return 0
        if args.worker:
            worker(config, float(config["pollIntervalMs"]) / 1000)
            return 0
        raise ValueError("Choose --discover, --probe, or --worker")
    except (OSError, RuntimeError, ValueError, TypeError) as error:
        emit({"type": "fatal", "message": public_error(error, config, "Tuya helper failed")})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
