from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest


MODULE_PATH = Path(__file__).parents[1] / "python" / "tp_link_bridge.py"
sys.modules.setdefault("kasa", SimpleNamespace(Discover=object()))
SPEC = importlib.util.spec_from_file_location("tp_link_bridge", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class FakeChild:
    def __init__(self, *, alias_raises: bool = False) -> None:
        self.sys_info = {
            "device_id": "sensor-1",
            "model": "T315",
            "status": "online",
            "current_temp": 21.5,
            "temp_unit": "celsius",
            "current_humidity": 48,
            "battery_percentage": 91,
        }
        self.device_id = "fallback-id"
        self.model = "fallback-model"
        self._alias_raises = alias_raises

    @property
    def alias(self) -> str:
        if self._alias_raises:
            raise RuntimeError("alias unavailable")
        return "Kitchen"


class FakeHub:
    def __init__(self, model: str = "H100", *, alias_raises: bool = False) -> None:
        self.model = model
        self.children = [FakeChild()]
        self.updated: list[bool] = []
        self.disconnected = False
        self._alias_raises = alias_raises

    @property
    def alias(self) -> str:
        if self._alias_raises:
            raise RuntimeError("alias unavailable")
        return "Hallway hub"

    async def update(self, *, update_children: bool) -> None:
        self.updated.append(update_children)

    async def disconnect(self) -> None:
        self.disconnected = True


def emitted_lines(capsys: pytest.CaptureFixture[str]) -> list[dict[str, Any]]:
    return [json.loads(line) for line in capsys.readouterr().out.splitlines()]


@pytest.mark.parametrize(
    ("value", "expected"),
    [(True, None), (False, None), ("21", None), (21, 21), (21.5, 21.5), (None, None)],
)
def test_optional_number_rejects_non_numeric_values(value: Any, expected: Any) -> None:
    assert bridge.optional_number(value) == expected


def test_child_snapshot_normalizes_supported_fields() -> None:
    assert bridge.child_snapshot(FakeChild()) == {
        "deviceId": "sensor-1",
        "model": "T315",
        "alias": "Kitchen",
        "status": "online",
        "temperature": 21.5,
        "temperatureUnit": "celsius",
        "humidity": 48,
        "battery": 91,
    }
    assert bridge.child_snapshot(FakeChild(alias_raises=True))["alias"] is None


@pytest.mark.asyncio
async def test_connect_and_poll_emits_one_snapshot(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    hub = FakeHub("H100 (EU)")

    async def discover_single(*args: Any, **kwargs: Any) -> FakeHub:
        assert args == ("192.0.2.10",)
        assert kwargs["username"] == "person@example.com"
        assert kwargs["password"] == "secret"
        return hub

    monkeypatch.setattr(
        bridge, "Discover", SimpleNamespace(discover_single=discover_single)
    )
    await bridge.connect_and_poll(
        "192.0.2.10", "person@example.com", "secret", 10, True
    )

    payload = emitted_lines(capsys)[0]
    assert payload["type"] == "snapshot"
    assert payload["hubModel"] == "H100"
    assert payload["timestamp"].endswith("Z")
    assert payload["devices"][0]["deviceId"] == "sensor-1"
    assert hub.updated == [True]


@pytest.mark.asyncio
@pytest.mark.parametrize("result", [None, FakeHub("P100")])
async def test_connect_and_poll_rejects_missing_or_unsupported_hubs(
    monkeypatch: pytest.MonkeyPatch, result: FakeHub | None
) -> None:
    async def discover_single(*_args: Any, **_kwargs: Any) -> FakeHub | None:
        return result

    monkeypatch.setattr(
        bridge, "Discover", SimpleNamespace(discover_single=discover_single)
    )
    with pytest.raises(RuntimeError):
        await bridge.connect_and_poll("192.0.2.10", "user", "password", 10, True)


@pytest.mark.asyncio
async def test_discover_hubs_filters_sorts_and_disconnects(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    first = FakeHub("H200")
    second = FakeHub("H100", alias_raises=True)
    unsupported = FakeHub("P100")

    async def discover(**kwargs: Any) -> dict[str, FakeHub]:
        assert kwargs["username"] == "user"
        assert kwargs["password"] == "password"
        return {"192.0.2.20": first, "192.0.2.10": second, "192.0.2.30": unsupported}

    monkeypatch.setattr(bridge, "Discover", SimpleNamespace(discover=discover))
    await bridge.discover_hubs("user", "password")

    payload = emitted_lines(capsys)[0]
    assert payload == {
        "type": "discovery",
        "hubs": [
            {"host": "192.0.2.10", "model": "H100", "alias": None},
            {"host": "192.0.2.20", "model": "H200", "alias": "Hallway hub"},
        ],
    }
    assert first.disconnected and second.disconnected and unsupported.disconnected


@pytest.mark.asyncio
async def test_main_requires_connection_credentials(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(sys, "argv", ["tp_link_bridge.py", "--list"])
    for name in ("TP_LINK_HOST", "TP_LINK_USERNAME", "TP_LINK_PASSWORD"):
        monkeypatch.delenv(name, raising=False)

    with pytest.raises(SystemExit, match="2"):
        await bridge.main()
    assert emitted_lines(capsys) == [
        {
            "type": "error",
            "message": "TP_LINK_HOST, TP_LINK_USERNAME, and TP_LINK_PASSWORD are required",
        }
    ]


@pytest.mark.asyncio
async def test_main_uses_safe_interval_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[Any, ...]] = []

    async def connect_and_poll(*args: Any) -> None:
        calls.append(args)

    monkeypatch.setattr(bridge, "connect_and_poll", connect_and_poll)
    monkeypatch.setattr(sys, "argv", ["tp_link_bridge.py", "--list"])
    monkeypatch.setenv("TP_LINK_HOST", "192.0.2.10")
    monkeypatch.setenv("TP_LINK_USERNAME", "user")
    monkeypatch.setenv("TP_LINK_PASSWORD", "password")
    monkeypatch.setenv("TP_LINK_POLL_INTERVAL_MS", "invalid")

    await bridge.main()
    assert calls == [("192.0.2.10", "user", "password", 10.0, True)]


@pytest.mark.asyncio
async def test_main_reports_discovery_failure(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def discover_hubs(*_args: Any) -> None:
        raise RuntimeError("network unavailable")

    monkeypatch.setattr(bridge, "discover_hubs", discover_hubs)
    monkeypatch.setattr(sys, "argv", ["tp_link_bridge.py", "--discover"])
    with pytest.raises(SystemExit, match="1"):
        await bridge.main()
    assert emitted_lines(capsys) == [
        {"type": "error", "message": "TP-Link discovery failed: network unavailable"}
    ]


@pytest.mark.asyncio
async def test_main_reports_list_failure(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def connect_and_poll(*_args: Any) -> None:
        raise RuntimeError("login rejected")

    monkeypatch.setattr(bridge, "connect_and_poll", connect_and_poll)
    monkeypatch.setattr(sys, "argv", ["tp_link_bridge.py", "--list"])
    monkeypatch.setenv("TP_LINK_HOST", "192.0.2.10")
    monkeypatch.setenv("TP_LINK_USERNAME", "user")
    monkeypatch.setenv("TP_LINK_PASSWORD", "password")

    with pytest.raises(SystemExit, match="1"):
        await bridge.main()
    assert emitted_lines(capsys) == [
        {"type": "error", "message": "TP-Link connection failed: login rejected"}
    ]


@pytest.mark.asyncio
async def test_main_preserves_cancellation(monkeypatch: pytest.MonkeyPatch) -> None:
    async def connect_and_poll(*_args: Any) -> None:
        raise asyncio.CancelledError

    monkeypatch.setattr(bridge, "connect_and_poll", connect_and_poll)
    monkeypatch.setattr(sys, "argv", ["tp_link_bridge.py"])
    monkeypatch.setenv("TP_LINK_HOST", "192.0.2.10")
    monkeypatch.setenv("TP_LINK_USERNAME", "user")
    monkeypatch.setenv("TP_LINK_PASSWORD", "password")

    with pytest.raises(asyncio.CancelledError):
        await bridge.main()
