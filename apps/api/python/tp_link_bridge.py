"""Poll a local TP-Link hub or energy device and emit snapshots as NDJSON."""

from __future__ import annotations

import asyncio
import ipaddress
import inspect
import json
import math
import os
import sys
import time
from collections.abc import Callable
from datetime import UTC, datetime
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


CLIMATE_HISTORY_INTERVAL_SECONDS = 15 * 60
POWER_HISTORY_FINE_INTERVAL_SECONDS = 5 * 60
POWER_HISTORY_COARSE_INTERVAL_SECONDS = 60 * 60
POWER_HISTORY_MAX_POINTS_PER_REQUEST = 144
TP_LINK_MISSING_CLIMATE_VALUE = -1000
TP_LINK_MISSING_POWER_VALUE = -1


def parse_history_timestamp(value: Any, field: str) -> datetime:
    """Parse a protocol timestamp and require an explicit UTC offset."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"History request {field} must be an ISO-8601 timestamp")
    normalized = value.strip()
    if normalized.endswith(("Z", "z")):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise ValueError(
            f"History request {field} must be an ISO-8601 timestamp"
        ) from error
    if parsed.tzinfo is None:
        raise ValueError(f"History request {field} must include a UTC offset")
    return parsed.astimezone(UTC)


def history_timestamp(epoch_seconds: int | float) -> str:
    return (
        datetime.fromtimestamp(epoch_seconds, UTC)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _finite_protocol_number(value: Any) -> float | int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) else None


def _method_result(payload: Any, method: str) -> dict[str, Any]:
    """Unwrap python-kasa Smart/SmartCam child protocol response envelopes."""
    current = payload
    for _depth in range(8):
        if not isinstance(current, dict):
            break
        if method in current:
            current = current[method]
            continue
        advanced = False
        for key in ("responseData", "response_data", "result"):
            nested = current.get(key)
            if isinstance(nested, dict):
                current = nested
                advanced = True
                break
        if not advanced:
            break
    if not isinstance(current, dict):
        raise ValueError(f"TP-Link {method} response did not contain a result")
    return current


def _aligned_request_bounds(
    from_timestamp: datetime, to_timestamp: datetime, interval_seconds: int
) -> tuple[int, int]:
    first = math.ceil(from_timestamp.timestamp() / interval_seconds) * interval_seconds
    last = math.floor(to_timestamp.timestamp() / interval_seconds) * interval_seconds
    return first, last


def _history_state(
    samples: list[dict[str, Any]],
    from_timestamp: datetime,
    to_timestamp: datetime,
    interval_seconds: int,
    retained_from: int,
    retained_to: int,
) -> tuple[str, str | None]:
    first_expected, last_expected = _aligned_request_bounds(
        from_timestamp, to_timestamp, interval_seconds
    )
    available = {
        int(datetime.fromisoformat(sample["timestamp"].replace("Z", "+00:00")).timestamp())
        for sample in samples
    }
    expected_count = (
        ((last_expected - first_expected) // interval_seconds) + 1
        if first_expected <= last_expected
        else 0
    )
    available_count = sum(
        1
        for timestamp in available
        if first_expected <= timestamp <= last_expected
    )
    # Retained records are interval buckets. Sub-interval seconds at either
    # edge do not require a synthetic bucket and must not trigger an app export.
    covers_range = expected_count == 0 or (
        retained_from <= first_expected and retained_to >= last_expected
    )
    if covers_range and available_count == expected_count:
        return "complete", None
    reasons: list[str] = []
    if not covers_range:
        reasons.append("the requested interval extends outside retained device history")
    missing_count = max(0, expected_count - available_count)
    if missing_count:
        reasons.append(f"{missing_count} retained buckets contain no usable reading")
    return "partial", "; ".join(reasons) or "local history is incomplete"


def parse_climate_history(
    payload: Any,
    device_id: str,
    metric: str,
    from_timestamp: datetime,
    to_timestamp: datetime,
) -> dict[str, Any]:
    """Normalize a T310/T315 96-bucket retained-history response.

    `local_time` is a Unix UTC timestamp. Firmware anchors the final array item
    to the current 15-minute boundary and stores temperature in tenths of the
    declared unit. The paired exception arrays describe comfort-limit
    deviations; non-zero values remain valid measurements, while their -1000
    sentinel marks the same unavailable bucket as the value arrays.
    """
    raw = _method_result(payload, "get_temp_humidity_records")
    local_time = _finite_protocol_number(raw.get("local_time"))
    if local_time is None or local_time <= 0:
        raise ValueError("TP-Link climate history has an invalid local_time")
    anchor = (int(local_time) // CLIMATE_HISTORY_INTERVAL_SECONDS) * CLIMATE_HISTORY_INTERVAL_SECONDS
    if metric == "temperature":
        values_key = "past24h_temp"
        exceptions_key = "past24h_temp_exception"
        canonical_unit = "°C"
    elif metric == "humidity":
        values_key = "past24h_humidity"
        exceptions_key = "past24h_humidity_exception"
        canonical_unit = "%"
    else:
        raise ValueError(f"Unsupported climate history metric {metric}")
    values = raw.get(values_key)
    exceptions = raw.get(exceptions_key)
    if not isinstance(values, list) or not values or len(values) > 96:
        raise ValueError(f"TP-Link climate history has an invalid {values_key} array")
    if exceptions is not None and (
        not isinstance(exceptions, list) or len(exceptions) != len(values)
    ):
        raise ValueError(
            f"TP-Link climate history has an invalid {exceptions_key} array"
        )
    retained_from = anchor - (len(values) - 1) * CLIMATE_HISTORY_INTERVAL_SECONDS
    from_epoch = from_timestamp.timestamp()
    to_epoch = to_timestamp.timestamp()
    declared_unit = str(raw.get("temp_unit", "celsius")).strip().lower()
    samples: list[dict[str, Any]] = []
    for index, candidate in enumerate(values):
        timestamp = retained_from + index * CLIMATE_HISTORY_INTERVAL_SECONDS
        if timestamp < from_epoch or timestamp > to_epoch:
            continue
        value = _finite_protocol_number(candidate)
        exception = (
            _finite_protocol_number(exceptions[index])
            if isinstance(exceptions, list)
            else 0
        )
        if (
            value is None
            or value == TP_LINK_MISSING_CLIMATE_VALUE
            or exception is None
            or exception == TP_LINK_MISSING_CLIMATE_VALUE
        ):
            continue
        if metric == "temperature":
            value = float(value) / 10
            if declared_unit in {"fahrenheit", "f", "°f"}:
                value = (value - 32) * 5 / 9
            elif declared_unit not in {"celsius", "c", "°c"}:
                raise ValueError(
                    f"TP-Link climate history has unsupported unit {declared_unit}"
                )
        samples.append(
            {
                "deviceId": device_id,
                "metric": metric,
                "value": value,
                "canonicalUnit": canonical_unit,
                "timestamp": history_timestamp(timestamp),
                # Retained buckets are historical/aggregated vendor data; only
                # direct live observations may claim exact/good quality.
                "quality": "estimated",
            }
        )
    state, error = _history_state(
        samples,
        from_timestamp,
        to_timestamp,
        CLIMATE_HISTORY_INTERVAL_SECONDS,
        retained_from,
        anchor,
    )
    return {
        "state": state,
        "samples": samples,
        "error": error,
        "retainedFrom": history_timestamp(retained_from),
        "retainedTo": history_timestamp(anchor),
        "intervalSeconds": CLIMATE_HISTORY_INTERVAL_SECONDS,
    }


def parse_power_history_chunk(
    payload: Any,
    device_id: str,
    from_timestamp: datetime,
    to_timestamp: datetime,
) -> tuple[list[dict[str, Any]], int, int, int]:
    """Normalize one `get_power_data` response (W, with -1/null missing)."""
    raw = _method_result(payload, "get_power_data")
    data = raw.get("data")
    start = _finite_protocol_number(raw.get("start_timestamp"))
    end = _finite_protocol_number(raw.get("end_timestamp"))
    interval_minutes = _finite_protocol_number(raw.get("interval"))
    if not isinstance(data, list) or len(data) > POWER_HISTORY_MAX_POINTS_PER_REQUEST:
        raise ValueError("TP-Link power history has an invalid data array")
    if start is None or end is None or interval_minutes not in {5, 60}:
        raise ValueError("TP-Link power history has invalid interval metadata")
    start_epoch = int(start)
    end_epoch = int(end)
    interval_seconds = int(interval_minutes) * 60
    if start_epoch <= 0 or end_epoch < start_epoch:
        raise ValueError("TP-Link power history has invalid timestamps")
    from_epoch = from_timestamp.timestamp()
    to_epoch = to_timestamp.timestamp()
    samples: list[dict[str, Any]] = []
    for index, candidate in enumerate(data):
        timestamp = start_epoch + index * interval_seconds
        if timestamp < from_epoch or timestamp > to_epoch:
            continue
        value = _finite_protocol_number(candidate)
        if value is None or value == TP_LINK_MISSING_POWER_VALUE:
            continue
        if value < 0:
            raise ValueError("TP-Link power history contained a negative reading")
        samples.append(
            {
                "deviceId": device_id,
                "metric": "power",
                "value": value,
                "canonicalUnit": "W",
                "timestamp": history_timestamp(timestamp),
                "quality": "estimated",
            }
        )
    retained_to = start_epoch + max(0, len(data) - 1) * interval_seconds
    return samples, start_epoch, retained_to, interval_seconds


async def _raw_history_query(
    target: Any, method: str, params: dict[str, Any] | None = None
) -> Any:
    query = getattr(target, "_query_helper", None)
    if not callable(query):
        raise NotImplementedError(
            f"Installed python-kasa cannot issue the private {method} request"
        )
    try:
        required_parameters = [
            parameter
            for parameter in inspect.signature(query).parameters.values()
            if parameter.kind
            in {
                inspect.Parameter.POSITIONAL_ONLY,
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
            }
            and parameter.default is inspect.Parameter.empty
        ]
    except (TypeError, ValueError):
        required_parameters = []
    # Legacy XOR/IoT devices expose a different three-argument helper
    # (module, command, parameters). `get_power_data` is a Smart protocol call.
    if len(required_parameters) > 1:
        raise NotImplementedError(
            f"{method} is unavailable through this TP-Link device protocol"
        )
    return await query(method, params)


def _device_matches(candidate: Any, device_id: str) -> bool:
    try:
        info = candidate.sys_info
    except Exception:
        info = {}
    values = [
        info.get("device_id") if isinstance(info, dict) else None,
        getattr(candidate, "device_id", None),
    ]
    expected = device_id.strip().casefold()
    return any(
        value is not None and str(value).strip().casefold() == expected
        for value in values
    )


def _history_target(device: Any, device_id: str) -> Any | None:
    targets = [device, *getattr(device, "children", [])]
    return next(
        (candidate for candidate in targets if _device_matches(candidate, device_id)),
        None,
    )


def _not_supported_history(
    device_id: str, metric: str, message: str
) -> dict[str, Any]:
    return {
        "state": "not-supported",
        "samples": [],
        "error": message,
        "deviceId": device_id,
        "metric": metric,
    }


async def recover_device_history(
    host: str,
    username: str,
    password: str,
    device_id: str,
    metric: str,
    from_timestamp: datetime,
    to_timestamp: datetime,
    expected_source_device_id: str | None = None,
    connected_device: Any | None = None,
) -> dict[str, Any]:
    """Read retained local history for one mapped TP-Link device."""
    device: Any | None = connected_device
    owns_device = connected_device is None
    try:
        if device is None:
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
        source_id = source_device_id(device)
        if expected_source_device_id and source_id != expected_source_device_id:
            raise RuntimeError(
                "The TP-Link device at the saved address has a different identity"
            )
        target = _history_target(device, device_id)
        if target is None:
            return _not_supported_history(
                device_id, metric, "The mapped TP-Link device was not found"
            )
        if metric in {"temperature", "humidity"}:
            try:
                target_info = target.sys_info
            except Exception:
                target_info = {}
            model = str(
                target_info.get("model", getattr(target, "model", ""))
                if isinstance(target_info, dict)
                else getattr(target, "model", "")
            ).upper().split("(", 1)[0].strip()
            if model not in {"T310", "T315"}:
                return _not_supported_history(
                    device_id,
                    metric,
                    f"Local retained climate history is unsupported for {model or 'this device'}",
                )
            try:
                payload = await _raw_history_query(
                    target, "get_temp_humidity_records"
                )
            except NotImplementedError as error:
                return _not_supported_history(device_id, metric, str(error))
            return {
                **parse_climate_history(
                    payload, device_id, metric, from_timestamp, to_timestamp
                ),
                "deviceId": device_id,
                "metric": metric,
            }
        if metric == "power":
            if energy_module(target) is None:
                return _not_supported_history(
                    device_id,
                    metric,
                    "The mapped TP-Link device does not expose energy monitoring",
                )
            duration = to_timestamp.timestamp() - from_timestamp.timestamp()
            interval_seconds = (
                POWER_HISTORY_FINE_INTERVAL_SECONDS
                if duration <= 12 * 60 * 60
                else POWER_HISTORY_COARSE_INTERVAL_SECONDS
            )
            first, last = _aligned_request_bounds(
                from_timestamp, to_timestamp, interval_seconds
            )
            if first > last:
                return {
                    "state": "complete",
                    "samples": [],
                    "error": None,
                    "deviceId": device_id,
                    "metric": metric,
                    "intervalSeconds": interval_seconds,
                }
            after_last = last + interval_seconds
            cursor = first
            samples_by_timestamp: dict[str, dict[str, Any]] = {}
            retained_from: int | None = None
            retained_to: int | None = None
            while cursor < after_last:
                request_end = min(
                    after_last,
                    cursor
                    + interval_seconds * POWER_HISTORY_MAX_POINTS_PER_REQUEST,
                )
                try:
                    payload = await _raw_history_query(
                        target,
                        "get_power_data",
                        {
                            "start_timestamp": cursor,
                            "end_timestamp": request_end,
                            "interval": interval_seconds // 60,
                        },
                    )
                except NotImplementedError as error:
                    return _not_supported_history(device_id, metric, str(error))
                chunk, chunk_from, chunk_to, response_interval = (
                    parse_power_history_chunk(
                        payload, device_id, from_timestamp, to_timestamp
                    )
                )
                if response_interval != interval_seconds:
                    raise ValueError(
                        "TP-Link power history returned an unexpected interval"
                    )
                for sample in chunk:
                    samples_by_timestamp[sample["timestamp"]] = sample
                retained_from = (
                    chunk_from
                    if retained_from is None
                    else min(retained_from, chunk_from)
                )
                retained_to = (
                    chunk_to
                    if retained_to is None
                    else max(retained_to, chunk_to)
                )
                cursor = request_end
            samples = [samples_by_timestamp[key] for key in sorted(samples_by_timestamp)]
            effective_from = retained_from if retained_from is not None else first
            effective_to = retained_to if retained_to is not None else first - interval_seconds
            state, error = _history_state(
                samples,
                from_timestamp,
                to_timestamp,
                interval_seconds,
                effective_from,
                effective_to,
            )
            return {
                "state": state,
                "samples": samples,
                "error": error,
                "deviceId": device_id,
                "metric": metric,
                "retainedFrom": history_timestamp(effective_from),
                "retainedTo": history_timestamp(effective_to),
                "intervalSeconds": interval_seconds,
            }
        if metric == "energy":
            return _not_supported_history(
                device_id,
                metric,
                "TP-Link interval energy is not the cumulative energy metric used by this service",
            )
        return _not_supported_history(
            device_id, metric, f"TP-Link retained history does not support {metric}"
        )
    finally:
        if owns_device and device is not None:
            try:
                disconnect = getattr(device, "disconnect", None)
                if callable(disconnect):
                    await disconnect()
            except Exception:
                pass


class HistoryRequestError(ValueError):
    def __init__(self, message: str, request_id: str | None = None) -> None:
        super().__init__(message)
        self.request_id = request_id


def parse_history_request(request: Any) -> dict[str, Any]:
    """Validate one decoded history request for one-shot or live-helper IPC."""
    if not isinstance(request, dict):
        raise HistoryRequestError("History request type must be history-request")
    raw_request_id = request.get("requestId")
    request_id = (
        raw_request_id
        if isinstance(raw_request_id, str)
        and bool(raw_request_id)
        and len(raw_request_id) <= 256
        else None
    )
    try:
        if request.get("type") != "history-request":
            raise ValueError("History request type must be history-request")
        device_id = request.get("deviceId")
        metric = request.get("metric")
        if (
            not isinstance(device_id, str)
            or not device_id.strip()
            or len(device_id) > 1_024
        ):
            raise ValueError("History request deviceId is invalid")
        if not isinstance(metric, str) or not metric.strip() or len(metric) > 128:
            raise ValueError("History request metric is invalid")
        if raw_request_id is not None and request_id is None:
            raise ValueError("History request requestId is invalid")
        from_timestamp = parse_history_timestamp(request.get("from"), "from")
        to_timestamp = parse_history_timestamp(request.get("to"), "to")
        if to_timestamp < from_timestamp:
            raise ValueError("History request to must not be earlier than from")
        if (to_timestamp - from_timestamp).total_seconds() > 31 * 24 * 60 * 60:
            raise ValueError("History requests are limited to 31 days")
    except ValueError as error:
        raise HistoryRequestError(str(error), request_id) from error
    return {
        "requestId": request_id,
        "deviceId": device_id.strip(),
        "metric": metric.strip(),
        "from": from_timestamp,
        "to": to_timestamp,
    }


def read_history_request() -> dict[str, Any]:
    line = sys.stdin.readline(65_537)
    if not line or len(line) > 65_536:
        raise HistoryRequestError(
            "History mode requires one JSON request smaller than 64 KiB"
        )
    try:
        request = json.loads(line)
    except json.JSONDecodeError as error:
        raise HistoryRequestError(
            "History mode requires one valid JSON request"
        ) from error
    return parse_history_request(request)


def source_device_id(device: Any) -> str | None:
    try:
        info = device.sys_info
    except Exception:
        info = {}
    candidates = [
        info.get("device_id") if isinstance(info, dict) else None,
        getattr(device, "device_id", None),
    ]
    return next(
        (
            str(value).strip()
            for value in candidates
            if value is not None and str(value).strip()
        ),
        None,
    )


def recovery_targets(reference_hosts: list[str]) -> list[str]:
    """Return a bounded same-/24 unicast scan ordered around the last-known IP."""
    targets: dict[str, tuple[int, int]] = {}
    for reference_index, reference in enumerate(reference_hosts):
        try:
            address = ipaddress.ip_address(reference)
        except ValueError:
            continue
        if not isinstance(address, ipaddress.IPv4Address) or not address.is_private:
            continue
        network = ipaddress.ip_network(f"{address}/24", strict=False)
        for candidate in network.hosts():
            if candidate == address:
                continue
            candidate_text = str(candidate)
            rank = (reference_index, abs(int(candidate) - int(address)))
            if candidate_text not in targets or rank < targets[candidate_text]:
                targets[candidate_text] = rank
    return sorted(
        targets, key=lambda target: (*targets[target], ipaddress.ip_address(target))
    )


async def _probe_recovery_target(
    host: str,
    username: str,
    password: str,
    expected_device_id: str | None,
    semaphore: asyncio.Semaphore,
) -> dict[str, Any] | None:
    device: Any | None = None
    try:
        async with semaphore:
            device = await Discover.discover_single(
                host,
                username=username,
                password=password,
                discovery_timeout=1,
                timeout=2,
            )
            if device is None:
                return None
            await device.update(update_children=True)
        model = str(device.model).upper().split("(", 1)[0].strip()
        is_hub = model in {"H100", "H200"}
        if not is_hub and not direct_energy_snapshots(device):
            return None
        device_id = source_device_id(device)
        if expected_device_id and device_id != expected_device_id:
            return None
        try:
            alias = device.alias
        except Exception:
            alias = None
        return {
            "host": host,
            "model": model,
            "alias": str(alias) if alias is not None else None,
            "sourceType": "hub" if is_hub else "energy-device",
            "sourceDeviceId": device_id,
        }
    except asyncio.CancelledError:
        raise
    except Exception:
        return None
    finally:
        if device is not None:
            try:
                await device.disconnect()
            except Exception:
                pass


async def scan_recovery_subnets(
    reference_hosts: list[str],
    username: str,
    password: str,
    expected_device_id: str | None = None,
    targets: list[str] | None = None,
) -> list[dict[str, Any]]:
    candidates = targets if targets is not None else recovery_targets(reference_hosts)
    semaphore = asyncio.Semaphore(32)
    results = await asyncio.gather(
        *(
            _probe_recovery_target(
                target, username, password, expected_device_id, semaphore
            )
            for target in candidates
        )
    )
    return sorted(
        (result for result in results if result is not None),
        key=lambda result: result["host"],
    )


async def recover_source_host(
    previous_host: str,
    username: str,
    password: str,
    expected_device_id: str | None,
) -> dict[str, Any] | None:
    matches = await scan_recovery_subnets(
        [previous_host], username, password, expected_device_id
    )
    # Without a learned stable identity, fail closed when credentials can open
    # more than one supported source on the subnet.
    return matches[0] if len(matches) == 1 else None


def advance_poll_deadline(
    previous_deadline: float, interval_seconds: float, now: float
) -> float:
    """Advance a fixed-rate poll schedule without bunching after a slow update."""
    deadline = previous_deadline + interval_seconds
    if deadline < now:
        missed_intervals = int((now - deadline) // interval_seconds) + 1
        deadline += missed_intervals * interval_seconds
    return deadline


async def serve_live_history_requests(
    device: Any,
    expected_source_device_id: str | None,
    query_lock: asyncio.Lock,
) -> None:
    """Serve NDJSON history requests through the poller's existing session."""
    loop = asyncio.get_running_loop()
    requests: asyncio.Queue[str | None] = asyncio.Queue()

    def stdin_ready() -> None:
        line = sys.stdin.readline(65_537)
        if not line:
            loop.remove_reader(sys.stdin.fileno())
            requests.put_nowait(None)
            return
        requests.put_nowait(line)

    loop.add_reader(sys.stdin.fileno(), stdin_ready)
    try:
        while (line := await requests.get()) is not None:
            request_id: str | None = None
            try:
                if len(line) > 65_536:
                    raise HistoryRequestError(
                        "History mode requires one JSON request smaller than 64 KiB"
                    )
                try:
                    decoded = json.loads(line)
                except json.JSONDecodeError as error:
                    raise HistoryRequestError(
                        "History mode requires one valid JSON request"
                    ) from error
                request = parse_history_request(decoded)
                request_id = request["requestId"]
                async with query_lock:
                    result = await recover_device_history(
                        "",
                        "",
                        "",
                        request["deviceId"],
                        request["metric"],
                        request["from"],
                        request["to"],
                        expected_source_device_id,
                        connected_device=device,
                    )
                emit(
                    {
                        "type": "history-result",
                        **(
                            {"requestId": request_id}
                            if request_id is not None
                            else {}
                        ),
                        **result,
                    }
                )
            except ValueError as error:
                if isinstance(error, HistoryRequestError):
                    request_id = error.request_id
                emit(
                    {
                        "type": "error",
                        **(
                            {"requestId": request_id}
                            if request_id is not None
                            else {}
                        ),
                        "message": str(error),
                    }
                )
            except Exception as error:
                emit(
                    {
                        "type": "error",
                        **(
                            {"requestId": request_id}
                            if request_id is not None
                            else {}
                        ),
                        "message": f"TP-Link history recovery failed: {error}",
                    }
                )
    finally:
        loop.remove_reader(sys.stdin.fileno())


async def connect_and_poll(
    host: str,
    username: str,
    password: str,
    interval_seconds: float,
    list_once: bool,
    on_success: Callable[[], None] | None = None,
    expected_device_id: str | None = None,
    on_identity: Callable[[str], None] | None = None,
) -> None:
    device: Any | None = None
    history_task: asyncio.Task[None] | None = None
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
        device_id = source_device_id(device)
        if expected_device_id and device_id != expected_device_id:
            raise RuntimeError(
                "The TP-Link device at the saved address has a different identity"
            )
        if device_id is not None and on_identity is not None:
            on_identity(device_id)
        model = str(device.model).upper().split("(", 1)[0].strip()
        is_hub = model in {"H100", "H200"}
        if not is_hub and not direct_energy_snapshots(device):
            raise RuntimeError(
                f"Device at {host} is {model}, not an H100/H200 hub or a device "
                "with a python-kasa Energy module"
            )

        query_lock = asyncio.Lock()
        if not list_once:
            history_task = asyncio.create_task(
                serve_live_history_requests(device, expected_device_id, query_lock)
            )
        loop = asyncio.get_running_loop()
        next_poll_at = loop.time()
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
                    "sourceDeviceId": device_id,
                    "devices": snapshots,
                }
            )
            if on_success is not None:
                on_success()
            if list_once:
                return
            now = loop.time()
            next_poll_at = advance_poll_deadline(next_poll_at, interval_seconds, now)
            await asyncio.sleep(max(0.0, next_poll_at - now))
            async with query_lock:
                await device.update(update_children=True)
    finally:
        if history_task is not None:
            history_task.cancel()
            try:
                await history_task
            except asyncio.CancelledError:
                pass
        if device is not None:
            try:
                disconnect = getattr(device, "disconnect", None)
                if callable(disconnect):
                    await disconnect()
            except Exception:
                pass


async def _inspect_discovered_source(
    host: str,
    device: Any,
    can_authenticate: bool,
    semaphore: asyncio.Semaphore,
) -> tuple[dict[str, Any] | None, str | None]:
    try:
        model = str(device.model).upper().split("(", 1)[0].strip()
        source_type: str | None = "hub" if model in {"H100", "H200"} else None
        if source_type is None:
            energy_snapshots = direct_energy_snapshots(device)
            if not energy_snapshots:
                try:
                    async with semaphore:
                        await device.update(update_children=True)
                    energy_snapshots = direct_energy_snapshots(device)
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    if not can_authenticate:
                        return None, None
                    return (
                        None,
                        f"TP-Link device at {host} could not be checked for energy monitoring: {str(error)[:200]}",
                    )
            if not energy_snapshots:
                return None, None
            source_type = "energy-device"
        try:
            alias = device.alias
        except Exception:
            alias = None
        return (
            {
                "host": host,
                "model": model,
                "alias": str(alias) if alias is not None else None,
                "sourceType": source_type,
            },
            None,
        )
    finally:
        try:
            await device.disconnect()
        except Exception:
            pass


async def discover_sources(username: str, password: str) -> None:
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
    semaphore = asyncio.Semaphore(16)
    inspected = await asyncio.gather(
        *(
            _inspect_discovered_source(
                host, device, bool(username and password), semaphore
            )
            for host, device in devices.items()
        )
    )
    sources = [source for source, _warning in inspected if source is not None]
    warnings = [
        f"TP-Link discovery via {target or 'the default broadcast'} failed: {str(error)[:200]}"
        for target, error in failures
    ]
    warnings.extend(warning for _source, warning in inspected if warning is not None)
    recovery_hosts = list(
        dict.fromkeys(
            host.strip()
            for host in os.environ.get("TP_LINK_RECOVERY_HOSTS", "").split(",")
            if host.strip()
        )
    )
    if recovery_hosts and username and password:
        # Docker networks may pass only some LAN broadcasts. Always supplement
        # them with a bounded same-/24 unicast scan around saved sources so a
        # responding H200 cannot mask a legacy HS110 or another energy device.
        known_hosts = {source["host"] for source in sources}
        direct_targets = [host for host in recovery_hosts if host not in known_hosts]
        recovered = await scan_recovery_subnets(
            recovery_hosts, username, password, targets=direct_targets
        ) if direct_targets else []
        known_hosts.update(result["host"] for result in recovered)
        subnet_targets = [
            host for host in recovery_targets(recovery_hosts) if host not in known_hosts
        ]
        recovered.extend(
            await scan_recovery_subnets(
                recovery_hosts, username, password, targets=subnet_targets
            )
        )
        for result in recovered:
            if result["host"] in {source["host"] for source in sources}:
                continue
            sources.append(
                {
                    "host": result["host"],
                    "model": result["model"],
                    "alias": result["alias"],
                    "sourceType": result["sourceType"],
                }
            )
    emit(
        {
            "type": "discovery",
            "sources": sorted(sources, key=lambda item: item["host"]),
            "warnings": warnings,
        }
    )


async def main() -> None:
    host = os.environ.get("TP_LINK_HOST", "").strip()
    username = os.environ.get("TP_LINK_USERNAME", "").strip()
    password = os.environ.get("TP_LINK_PASSWORD", "")
    if "--discover" in sys.argv[1:]:
        try:
            await discover_sources(username, password)
        except Exception as error:
            emit({"type": "error", "message": f"TP-Link discovery failed: {error}"})
            raise SystemExit(1)
        return

    if "--history" in sys.argv[1:]:
        request_id: str | None = None
        try:
            if not host or not username or not password:
                raise ValueError(
                    "TP_LINK_HOST, TP_LINK_USERNAME, and TP_LINK_PASSWORD are required"
                )
            request = read_history_request()
            request_id = request["requestId"]
            result = await recover_device_history(
                host,
                username,
                password,
                request["deviceId"],
                request["metric"],
                request["from"],
                request["to"],
                os.environ.get("TP_LINK_DEVICE_ID", "").strip() or None,
            )
            emit(
                {
                    "type": "history-result",
                    **({"requestId": request_id} if request_id is not None else {}),
                    **result,
                }
            )
        except ValueError as error:
            if isinstance(error, HistoryRequestError):
                request_id = error.request_id
            emit(
                {
                    "type": "error",
                    **({"requestId": request_id} if request_id is not None else {}),
                    "message": str(error),
                }
            )
            raise SystemExit(2)
        except Exception as error:
            emit(
                {
                    "type": "error",
                    **({"requestId": request_id} if request_id is not None else {}),
                    "message": f"TP-Link history recovery failed: {error}",
                }
            )
            raise SystemExit(1)
        return

    try:
        interval_ms = max(1000, int(os.environ.get("TP_LINK_POLL_INTERVAL_MS", "2000")))
    except ValueError:
        interval_ms = 2000
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
    expected_device_id = os.environ.get("TP_LINK_DEVICE_ID", "").strip() or None
    connection_failures = 0
    last_recovery_scan = 0.0
    while True:

        def reset_backoff() -> None:
            nonlocal backoff_seconds, connection_failures
            backoff_seconds = 1
            connection_failures = 0

        def remember_identity(device_id: str) -> None:
            nonlocal expected_device_id
            expected_device_id = device_id

        try:
            await connect_and_poll(
                host,
                username,
                password,
                interval_ms / 1000,
                list_once,
                on_success=reset_backoff,
                expected_device_id=expected_device_id,
                on_identity=remember_identity,
            )
            if list_once:
                return
        except asyncio.CancelledError:
            raise
        except Exception as error:
            emit({"type": "error", "message": f"TP-Link connection failed: {error}"})
            if list_once:
                raise SystemExit(1)
            connection_failures += 1
            now = time.monotonic()
            if connection_failures >= 2 and now - last_recovery_scan >= 300:
                last_recovery_scan = now
                recovered = await recover_source_host(
                    host, username, password, expected_device_id
                )
                if recovered is not None and recovered["host"] != host:
                    previous_host = host
                    host = recovered["host"]
                    expected_device_id = (
                        recovered["sourceDeviceId"] or expected_device_id
                    )
                    emit(
                        {
                            "type": "host-change",
                            "previousHost": previous_host,
                            "host": host,
                            "sourceDeviceId": expected_device_id,
                        }
                    )
                    backoff_seconds = 1
                    connection_failures = 0
                    continue
            await asyncio.sleep(backoff_seconds)
            backoff_seconds = min(60, backoff_seconds * 2)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
