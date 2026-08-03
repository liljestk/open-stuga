# ruff: noqa: F403, F405
"""TP-Link bridge implementation domain."""

from __future__ import annotations

from tp_link_bridge_common import *
from tp_link_bridge_common import (
    _finite_protocol_number,
    _method_result,
    _raw_history_query,
)
from tp_link_bridge_recovery import *

CONTACT_EVENT_MAX_CLOCK_SKEW_SECONDS = 5 * 60


def advance_poll_deadline(
    previous_deadline: float, interval_seconds: float, now: float
) -> float:
    """Advance a fixed-rate poll schedule without bunching after a slow update."""
    deadline = previous_deadline + interval_seconds
    if deadline < now:
        missed_intervals = int((now - deadline) // interval_seconds) + 1
        deadline += missed_intervals * interval_seconds
    return deadline


def normalize_contact_events(
    payload: Any,
    device_id: str,
    known_event_ids: set[str] | None,
    polled_at_epoch: float,
) -> tuple[list[dict[str, Any]], set[str]]:
    """Normalize new T110 trigger-log entries in chronological order."""
    raw = _method_result(payload, "get_trigger_logs")
    logs = raw.get("logs")
    if not isinstance(logs, list):
        raise ValueError("TP-Link contact trigger log did not contain a logs array")

    current_event_ids: set[str] = set()
    candidates: list[tuple[float, float | int, str, str]] = []
    for item in logs:
        if not isinstance(item, dict):
            continue
        event = item.get("event")
        state = (
            "open"
            if isinstance(event, str) and event.strip().casefold() == "open"
            else (
                "closed"
                if isinstance(event, str)
                and event.strip().casefold() in {"close", "closed"}
                else None
            )
        )
        timestamp = _finite_protocol_number(item.get("timestamp"))
        raw_event_id = item.get("eventId")
        event_id = raw_event_id.strip() if isinstance(raw_event_id, str) else ""
        sequence = _finite_protocol_number(item.get("id"))
        if not event_id or len(event_id) > 512 or timestamp is None or timestamp <= 0:
            continue
        current_event_ids.add(event_id)
        if state is None or (
            known_event_ids is not None and event_id in known_event_ids
        ):
            continue
        if timestamp > polled_at_epoch + CONTACT_EVENT_MAX_CLOCK_SKEW_SECONDS:
            continue
        candidates.append(
            (
                float(timestamp),
                sequence if sequence is not None else -1,
                event_id,
                state,
            )
        )

    candidates.sort(key=lambda item: (item[0], item[1], item[2]))
    return (
        [
            {
                "deviceId": device_id,
                "eventId": event_id,
                **({"sequence": sequence} if sequence >= 0 else {}),
                "state": state,
                "timestamp": history_timestamp(timestamp),
            }
            for timestamp, sequence, event_id, state in candidates
        ],
        current_event_ids,
    )


async def collect_contact_events(
    device: Any,
    known_event_ids: dict[str, set[str]],
) -> list[dict[str, Any]]:
    """Read retained contact transitions without running a full hub update."""
    events: list[dict[str, Any]] = []
    trigger_key = getattr(Module, "TriggerLogs", None)
    if trigger_key is None:
        return events
    for child in getattr(device, "children", []):
        try:
            modules = child.modules
            if modules.get(trigger_key) is None:
                continue
            info = child.sys_info
            device_id = str(info.get("device_id", child.device_id)).strip()
            if not device_id:
                continue
            payload = await _raw_history_query(
                child, "get_trigger_logs", {"start_id": 0}
            )
            normalized, current_ids = normalize_contact_events(
                payload,
                device_id,
                known_event_ids.get(device_id),
                time.time(),
            )
            known_event_ids[device_id] = current_ids
            events.extend(normalized)
        except Exception:
            # Current-state snapshots remain the safe fallback for firmware that
            # does not expose or temporarily rejects the private trigger log.
            continue
    return sorted(
        events,
        key=lambda item: (
            item["timestamp"],
            item["deviceId"],
            item.get("sequence", -1),
            item["eventId"],
        ),
    )


async def serve_contact_events(
    device: Any,
    interval_seconds: float,
    query_lock: asyncio.Lock,
    known_event_ids: dict[str, set[str]],
) -> None:
    """Poll T110 trigger logs quickly so short open/close cycles are retained."""
    loop = asyncio.get_running_loop()
    next_poll_at = loop.time()
    while True:
        now = loop.time()
        next_poll_at = advance_poll_deadline(next_poll_at, interval_seconds, now)
        await asyncio.sleep(max(0.0, next_poll_at - now))
        async with query_lock:
            events = await collect_contact_events(device, known_event_ids)
        if events:
            emit(
                {
                    "type": "contact-events",
                    "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                    "events": events,
                }
            )


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
            except Exception as error:
                emit(
                    {
                        "type": "error",
                        **({"requestId": request_id} if request_id is not None else {}),
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
    contact_interval_seconds: float = 0.5,
    contact_events_enabled: bool = True,
) -> None:
    device: Any | None = None
    history_task: asyncio.Task[None] | None = None
    contact_task: asyncio.Task[None] | None = None
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
        install_h500_compatibility(device)
        await device.update(update_children=True)
        device_id = source_device_id(device)
        if expected_device_id and device_id != expected_device_id:
            raise RuntimeError(
                "The TP-Link device at the saved address has a different identity"
            )
        if device_id is not None and on_identity is not None:
            on_identity(device_id)
        model = normalized_device_model(device)
        is_hub = is_supported_hub(model)
        if not is_hub and not direct_energy_snapshots(device):
            raise RuntimeError(
                f"Device at {host} is {model}, not an H100/H200/H500 hub or a device "
                "with a python-kasa Energy module"
            )
        try:
            source_alias = device.alias
        except Exception:
            source_alias = None

        query_lock = asyncio.Lock()
        if not list_once:
            if is_hub and contact_events_enabled:
                contact_task = asyncio.create_task(
                    serve_contact_events(
                        device,
                        contact_interval_seconds,
                        query_lock,
                        {},
                    )
                )
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
            warning = h500_child_enumeration_warning(device, len(snapshots))
            emit(
                {
                    "type": "snapshot",
                    "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                    "hubModel": model,
                    "sourceType": "hub" if is_hub else "energy-device",
                    "sourceDeviceId": device_id,
                    "sourceAlias": (
                        str(source_alias) if source_alias is not None else None
                    ),
                    "reportedChildCount": reported_child_count(device),
                    "warning": warning,
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
        if contact_task is not None:
            contact_task.cancel()
            try:
                await contact_task
            except asyncio.CancelledError:
                pass
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
