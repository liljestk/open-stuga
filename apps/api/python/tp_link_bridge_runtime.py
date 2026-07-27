# ruff: noqa: F403, F405
"""TP-Link bridge implementation domain."""

from __future__ import annotations

from tp_link_bridge_common import *
from tp_link_bridge_recovery import *


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
