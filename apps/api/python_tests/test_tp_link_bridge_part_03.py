# ruff: noqa: F403, F405
from __future__ import annotations

from tp_link_bridge_test_support import *  # noqa: F403


@pytest.mark.asyncio
async def test_main_retries_an_unavailable_hub_until_connection_recovers(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    attempts = 0
    retry_delays: list[int] = []

    async def connect_and_poll(*_args: Any, **kwargs: Any) -> None:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise RuntimeError("hub unavailable")
        kwargs["on_success"]()
        raise asyncio.CancelledError

    async def sleep(delay: int) -> None:
        retry_delays.append(delay)

    async def no_recovery(*_args: Any) -> None:
        return None

    monkeypatch.setattr(bridge, "connect_and_poll", connect_and_poll)
    monkeypatch.setattr(bridge, "recover_source_host", no_recovery)
    monkeypatch.setattr(bridge.asyncio, "sleep", sleep)
    monkeypatch.setattr(sys, "argv", ["tp_link_bridge.py"])
    monkeypatch.setenv("TP_LINK_HOST", "192.0.2.10")
    monkeypatch.setenv("TP_LINK_USERNAME", "user")
    monkeypatch.setenv("TP_LINK_PASSWORD", "password")

    with pytest.raises(asyncio.CancelledError):
        await bridge.main()

    assert attempts == 3
    assert retry_delays == [1, 2]
    assert emitted_lines(capsys) == [
        {"type": "error", "message": "TP-Link connection failed: hub unavailable"},
        {"type": "error", "message": "TP-Link connection failed: hub unavailable"},
    ]


@pytest.mark.asyncio
async def test_main_recovers_a_changed_ip_and_emits_the_persistable_update(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    attempted_hosts: list[str] = []

    async def connect_and_poll(host: str, *_args: Any, **_kwargs: Any) -> None:
        attempted_hosts.append(host)
        if host == "192.168.68.54":
            raise RuntimeError("hub unavailable")
        raise asyncio.CancelledError

    async def recover(*_args: Any) -> dict[str, Any]:
        return {
            "host": "192.168.68.56",
            "model": "H200",
            "alias": "Hallway hub",
            "sourceType": "hub",
            "sourceDeviceId": "expected-hub",
        }

    async def sleep(_delay: int) -> None:
        return None

    monkeypatch.setattr(bridge, "connect_and_poll", connect_and_poll)
    monkeypatch.setattr(bridge, "recover_source_host", recover)
    monkeypatch.setattr(bridge.asyncio, "sleep", sleep)
    monkeypatch.setattr(bridge.time, "monotonic", lambda: 1_000.0)
    monkeypatch.setattr(sys, "argv", ["tp_link_bridge.py"])
    monkeypatch.setenv("TP_LINK_HOST", "192.168.68.54")
    monkeypatch.setenv("TP_LINK_USERNAME", "user")
    monkeypatch.setenv("TP_LINK_PASSWORD", "password")

    with pytest.raises(asyncio.CancelledError):
        await bridge.main()

    assert attempted_hosts == ["192.168.68.54", "192.168.68.54", "192.168.68.56"]
    assert emitted_lines(capsys)[-1] == {
        "type": "host-change",
        "previousHost": "192.168.68.54",
        "host": "192.168.68.56",
        "sourceDeviceId": "expected-hub",
    }


@pytest.mark.asyncio
async def test_main_reports_discovery_failure(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def discover_sources(*_args: Any) -> None:
        raise RuntimeError("network unavailable")

    monkeypatch.setattr(bridge, "discover_sources", discover_sources)
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
    async def connect_and_poll(*_args: Any, **_kwargs: Any) -> None:
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
    async def connect_and_poll(*_args: Any, **_kwargs: Any) -> None:
        raise asyncio.CancelledError

    monkeypatch.setattr(bridge, "connect_and_poll", connect_and_poll)
    monkeypatch.setattr(sys, "argv", ["tp_link_bridge.py"])
    monkeypatch.setenv("TP_LINK_HOST", "192.0.2.10")
    monkeypatch.setenv("TP_LINK_USERNAME", "user")
    monkeypatch.setenv("TP_LINK_PASSWORD", "password")

    with pytest.raises(asyncio.CancelledError):
        await bridge.main()
