# ruff: noqa: F403, F405
from __future__ import annotations

from tp_link_bridge_test_support import *  # noqa: F403


@pytest.mark.asyncio
async def test_recovery_discovers_a_learned_source_on_the_current_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expected = FakeHub("H200", device_id="expected-hub")
    other = FakeHub("H100", device_id="other-hub")

    async def discover(**kwargs: Any) -> dict[str, FakeHub]:
        assert kwargs["target"] == "192.168.71.255"
        assert kwargs["username"] == "user"
        assert kwargs["password"] == "password"
        return {"192.168.71.42": expected, "192.168.71.43": other}

    monkeypatch.setattr(bridge, "Discover", SimpleNamespace(discover=discover))
    monkeypatch.setenv("TP_LINK_DISCOVERY_TARGETS", "192.168.71.255")

    recovered = await bridge.recover_source_host(
        "192.168.68.54", "user", "password", "EXPECTED-HUB"
    )

    assert recovered == {
        "host": "192.168.71.42",
        "model": "H200",
        "alias": "Hallway hub",
        "sourceType": "hub",
        "sourceDeviceId": "expected-hub",
    }
    assert expected.updated == [True] and other.updated == [True]
    assert expected.disconnected and other.disconnected


@pytest.mark.asyncio
async def test_recovery_scans_the_current_target_when_broadcast_is_blocked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    references: list[str] = []

    async def discover(*_args: Any, **_kwargs: Any) -> list[dict[str, Any]]:
        return []

    async def scan(
        reference_hosts: list[str], *_args: Any, **_kwargs: Any
    ) -> list[dict[str, Any]]:
        references.extend(reference_hosts)
        return [
            {
                "host": "192.168.71.42",
                "model": "H200",
                "alias": "Recovered hub",
                "sourceType": "hub",
                "sourceDeviceId": "expected-hub",
            }
        ]

    monkeypatch.setattr(bridge, "discover_recovery_sources", discover)
    monkeypatch.setattr(bridge, "scan_recovery_subnets", scan)
    monkeypatch.setenv("TP_LINK_DISCOVERY_TARGETS", "192.168.71.255")

    recovered = await bridge.recover_source_host(
        "192.168.68.54", "user", "password", "expected-hub"
    )

    assert references == ["192.168.68.54", "192.168.71.255"]
    assert recovered is not None and recovered["host"] == "192.168.71.42"


@pytest.mark.asyncio
async def test_recovery_without_an_identity_rejects_ambiguous_sources(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = FakeHub("H200", device_id="first-hub")
    second = FakeHub("H100", device_id="second-hub")

    async def discover(**_kwargs: Any) -> dict[str, FakeHub]:
        return {"192.168.71.42": first, "192.168.71.43": second}

    async def scan(*_args: Any, **_kwargs: Any) -> list[dict[str, Any]]:
        return []

    monkeypatch.setattr(bridge, "Discover", SimpleNamespace(discover=discover))
    monkeypatch.setattr(bridge, "scan_recovery_subnets", scan)
    monkeypatch.setenv("TP_LINK_DISCOVERY_TARGETS", "192.168.71.255")

    assert (
        await bridge.recover_source_host("192.168.68.54", "user", "password", None)
        is None
    )
    assert first.disconnected and second.disconnected
