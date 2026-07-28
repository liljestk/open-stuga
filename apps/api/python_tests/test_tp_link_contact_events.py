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
