# ruff: noqa: F403, F405
from __future__ import annotations

from tp_link_bridge_test_support import *  # noqa: F403


def test_normalize_contact_events_retains_available_backlog_once() -> None:
    payload = {
        "get_trigger_logs": {
            "logs": [
                {
                    "id": 4,
                    "eventId": "event-close",
                    "timestamp": 104,
                    "event": "close",
                },
                {
                    "id": 3,
                    "eventId": "event-keep-open",
                    "timestamp": 103,
                    "event": "keepOpen",
                },
                {
                    "id": 2,
                    "eventId": "event-open",
                    "timestamp": 102,
                    "event": "open",
                },
                {
                    "id": 1,
                    "eventId": "event-from-backlog",
                    "timestamp": 99,
                    "event": "open",
                },
            ]
        }
    }

    events, known = bridge.normalize_contact_events(payload, "contact-1", None, 105)
    assert events == [
        {
            "deviceId": "contact-1",
            "eventId": "event-from-backlog",
            "sequence": 1,
            "state": "open",
            "timestamp": "1970-01-01T00:01:39Z",
        },
        {
            "deviceId": "contact-1",
            "eventId": "event-open",
            "sequence": 2,
            "state": "open",
            "timestamp": "1970-01-01T00:01:42Z",
        },
        {
            "deviceId": "contact-1",
            "eventId": "event-close",
            "sequence": 4,
            "state": "closed",
            "timestamp": "1970-01-01T00:01:44Z",
        },
    ]
    assert known == {
        "event-from-backlog",
        "event-close",
        "event-keep-open",
        "event-open",
    }
    repeated, _ = bridge.normalize_contact_events(payload, "contact-1", known, 105)
    assert repeated == []


def test_normalize_contact_events_rejects_malformed_and_future_entries() -> None:
    with pytest.raises(ValueError, match="logs array"):
        bridge.normalize_contact_events(
            {"get_trigger_logs": {}}, "contact-1", None, 100
        )

    payload = {
        "get_trigger_logs": {
            "logs": [
                None,
                {"event": "open", "timestamp": 99},
                {
                    "event": "open",
                    "eventId": "event-future",
                    "timestamp": 401,
                },
                {
                    "event": "closed",
                    "eventId": " event-without-sequence ",
                    "timestamp": 100,
                },
            ]
        }
    }

    events, known = bridge.normalize_contact_events(payload, "contact-1", None, 100)
    assert events == [
        {
            "deviceId": "contact-1",
            "eventId": "event-without-sequence",
            "state": "closed",
            "timestamp": "1970-01-01T00:01:40Z",
        }
    ]
    assert known == {"event-future", "event-without-sequence"}


@pytest.mark.asyncio
async def test_collect_contact_events_uses_t110_trigger_log() -> None:
    child = FakeChild()
    child.sys_info.update({"device_id": "contact-1", "model": "T110", "open": False})
    child.modules = {
        bridge.Module.ContactSensor: SimpleNamespace(is_open=False),
        bridge.Module.TriggerLogs: SimpleNamespace(),
    }
    queries: list[tuple[str, dict[str, Any] | None]] = []

    async def query(
        method: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        queries.append((method, params))
        return {
            method: {
                "logs": [
                    {
                        "id": 8,
                        "eventId": "event-8",
                        "timestamp": 108,
                        "event": "open",
                    }
                ]
            }
        }

    child._query_helper = query  # type: ignore[attr-defined]
    hub = FakeHub()
    hub.children = [child]
    known: dict[str, set[str]] = {}

    assert await bridge.collect_contact_events(hub, known) == [
        {
            "deviceId": "contact-1",
            "eventId": "event-8",
            "sequence": 8,
            "state": "open",
            "timestamp": "1970-01-01T00:01:48Z",
        }
    ]
    assert queries == [("get_trigger_logs", {"start_id": 0})]
    assert await bridge.collect_contact_events(hub, known) == []


@pytest.mark.asyncio
async def test_collect_contact_events_skips_unsupported_and_failing_children() -> None:
    unsupported = FakeChild()

    missing_id = FakeChild()
    missing_id.sys_info["device_id"] = " "
    missing_id.modules = {bridge.Module.TriggerLogs: SimpleNamespace()}

    failing = FakeChild()
    failing.modules = {bridge.Module.TriggerLogs: SimpleNamespace()}

    async def fail_query(
        method: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        raise RuntimeError("trigger log unavailable")

    failing._query_helper = fail_query  # type: ignore[attr-defined]
    hub = FakeHub()
    hub.children = [unsupported, missing_id, failing]
    known: dict[str, set[str]] = {}

    assert await bridge.collect_contact_events(hub, known) == []
    assert known == {}


@pytest.mark.asyncio
async def test_collect_contact_events_handles_missing_trigger_module(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delattr(bridge.Module, "TriggerLogs")

    assert await bridge.collect_contact_events(FakeHub(), {}) == []


@pytest.mark.asyncio
async def test_serve_contact_events_emits_retained_transitions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events = [{"deviceId": "contact-1", "eventId": "event-1", "state": "open"}]
    emitted: list[dict[str, Any]] = []
    calls = 0

    async def collect(
        device: Any, known_event_ids: dict[str, set[str]]
    ) -> list[dict[str, Any]]:
        nonlocal calls
        calls += 1
        if calls > 1:
            raise asyncio.CancelledError
        return events

    monkeypatch.setattr(bridge, "collect_contact_events", collect)
    monkeypatch.setattr(bridge, "emit", emitted.append)

    with pytest.raises(asyncio.CancelledError):
        await bridge.serve_contact_events(FakeHub(), 0.001, asyncio.Lock(), {})

    assert len(emitted) == 1
    assert emitted[0]["type"] == "contact-events"
    assert emitted[0]["timestamp"].endswith("Z")
    assert emitted[0]["events"] == events
