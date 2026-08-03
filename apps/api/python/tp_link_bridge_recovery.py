# ruff: noqa: F401, F403, F405
"""TP-Link bridge implementation domain."""

from __future__ import annotations

from tp_link_bridge_common import *
from tp_link_bridge_common import (
    _aligned_request_bounds,
    _device_matches,
    _finite_protocol_number,
    _history_state,
    _history_target,
    _method_result,
    _raw_history_query,
)


def _not_supported_history(device_id: str, metric: str, message: str) -> dict[str, Any]:
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
        install_h500_compatibility(device)
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
            model = (
                str(
                    target_info.get("model", getattr(target, "model", ""))
                    if isinstance(target_info, dict)
                    else getattr(target, "model", "")
                )
                .upper()
                .split("(", 1)[0]
                .strip()
            )
            if model not in {"T310", "T315"}:
                return _not_supported_history(
                    device_id,
                    metric,
                    f"Local retained climate history is unsupported for {model or 'this device'}",
                )
            try:
                payload = await _raw_history_query(target, "get_temp_humidity_records")
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
                    cursor + interval_seconds * POWER_HISTORY_MAX_POINTS_PER_REQUEST,
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
                    chunk_to if retained_to is None else max(retained_to, chunk_to)
                )
                cursor = request_end
            samples = [
                samples_by_timestamp[key] for key in sorted(samples_by_timestamp)
            ]
            effective_from = retained_from if retained_from is not None else first
            effective_to = (
                retained_to if retained_to is not None else first - interval_seconds
            )
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


def _recovery_source(
    host: str, device: Any, expected_device_id: str | None
) -> dict[str, Any] | None:
    model = normalized_device_model(device)
    is_hub = is_supported_hub(model)
    if not is_hub and not direct_energy_snapshots(device):
        return None
    if expected_device_id and not _device_matches(device, expected_device_id):
        return None
    device_id = source_device_id(device)
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
            install_h500_compatibility(device)
            await device.update(update_children=True)
        return _recovery_source(host, device, expected_device_id)
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


async def _inspect_recovery_discovery_device(
    host: str,
    device: Any,
    expected_device_id: str | None,
    semaphore: asyncio.Semaphore,
) -> dict[str, Any] | None:
    try:
        async with semaphore:
            install_h500_compatibility(device)
            await device.update(update_children=True)
        return _recovery_source(host, device, expected_device_id)
    except asyncio.CancelledError:
        raise
    except Exception:
        return None
    finally:
        try:
            await device.disconnect()
        except Exception:
            pass


async def discover_recovery_sources(
    username: str,
    password: str,
    expected_device_id: str | None,
    targets: list[str | None] | None = None,
) -> list[dict[str, Any]]:
    """Discover supported sources on current LAN broadcasts for host recovery."""
    configured_targets = [
        target.strip()
        for target in os.environ.get("TP_LINK_DISCOVERY_TARGETS", "").split(",")
        if target.strip()
    ]
    discovery_targets = list(
        dict.fromkeys(targets if targets is not None else configured_targets)
    ) or [None]
    results = await asyncio.gather(
        *(
            Discover.discover(
                discovery_timeout=5,
                timeout=10,
                **({"target": target} if target else {}),
                username=username,
                password=password,
            )
            for target in discovery_targets
        ),
        return_exceptions=True,
    )
    devices: dict[str, Any] = {}
    for result in results:
        if isinstance(result, BaseException):
            if isinstance(result, asyncio.CancelledError):
                raise result
            continue
        for host, device in result.items():
            host_text = str(host)
            if host_text not in devices:
                devices[host_text] = device
                continue
            try:
                await device.disconnect()
            except Exception:
                pass
    semaphore = asyncio.Semaphore(16)
    inspected = await asyncio.gather(
        *(
            _inspect_recovery_discovery_device(
                host, device, expected_device_id, semaphore
            )
            for host, device in devices.items()
        )
    )
    return sorted(
        (source for source in inspected if source is not None),
        key=lambda source: source["host"],
    )


async def recover_source_host(
    previous_host: str,
    username: str,
    password: str,
    expected_device_id: str | None,
) -> dict[str, Any] | None:
    broadcast_matches = await discover_recovery_sources(
        username, password, expected_device_id
    )
    if expected_device_id and len(broadcast_matches) == 1:
        return broadcast_matches[0]

    # A directed broadcast address also identifies the current bounded /24
    # fallback when broadcast traffic is hidden by a VM or container bridge.
    current_targets = [
        target.strip()
        for target in os.environ.get("TP_LINK_DISCOVERY_TARGETS", "").split(",")
        if target.strip()
    ]
    scanned_matches = await scan_recovery_subnets(
        list(dict.fromkeys([previous_host, *current_targets])),
        username,
        password,
        expected_device_id,
    )
    matches = {match["host"]: match for match in [*broadcast_matches, *scanned_matches]}
    # Without a learned stable identity, fail closed when credentials can open
    # more than one supported source across the reachable networks.
    return next(iter(matches.values())) if len(matches) == 1 else None
