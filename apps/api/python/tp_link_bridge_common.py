# ruff: noqa: F401
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
    return datetime.fromtimestamp(epoch_seconds, UTC).isoformat().replace("+00:00", "Z")


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
        int(
            datetime.fromisoformat(
                sample["timestamp"].replace("Z", "+00:00")
            ).timestamp()
        )
        for sample in samples
    }
    expected_count = (
        ((last_expected - first_expected) // interval_seconds) + 1
        if first_expected <= last_expected
        else 0
    )
    available_count = sum(
        1 for timestamp in available if first_expected <= timestamp <= last_expected
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
    anchor = (
        int(local_time) // CLIMATE_HISTORY_INTERVAL_SECONDS
    ) * CLIMATE_HISTORY_INTERVAL_SECONDS
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
