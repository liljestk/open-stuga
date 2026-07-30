# ruff: noqa: F403, F405
from __future__ import annotations

from tp_link_bridge_test_support import *  # noqa: F403


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("model", "power", "total"),
    [("P110", 12.5, None), ("HS110", 90.0, 3.25)],
)
async def test_connect_and_poll_emits_capability_based_direct_energy_snapshot(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    model: str,
    power: float,
    total: float | None,
) -> None:
    device = FakeEnergyDevice(model, power, total)

    async def discover_single(*_args: Any, **_kwargs: Any) -> FakeEnergyDevice:
        return device

    monkeypatch.setattr(
        bridge, "Discover", SimpleNamespace(discover_single=discover_single)
    )
    await bridge.connect_and_poll("192.0.2.30", "user", "password", 10, True)

    payload = emitted_lines(capsys)[0]
    assert payload["sourceType"] == "energy-device"
    assert payload["hubModel"] == model
    assert payload["sourceAlias"] == f"{model} outlet"
    assert payload["devices"] == [
        {
            "deviceId": f"{model.lower()}-device",
            "model": model,
            "alias": f"{model} outlet",
            "status": None,
            "temperature": None,
            "temperatureUnit": None,
            "humidity": None,
            "battery": None,
            "contactOpen": None,
            "power": power,
            "energy": total,
        }
    ]
    assert device.updated == [True]
    assert device.disconnected


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
async def test_discover_sources_filters_sorts_and_disconnects(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    first = FakeHub("H200")
    second = FakeHub("H100", alias_raises=True)
    energy = FakeDeferredEnergyDevice("P110", 42.5, None)
    unsupported = FakeHub("P100")

    async def discover(**kwargs: Any) -> dict[str, FakeHub]:
        assert kwargs["username"] == "user"
        assert kwargs["password"] == "password"
        assert kwargs["target"] == "192.0.2.255"
        return {
            "192.0.2.20": first,
            "192.0.2.10": second,
            "192.0.2.25": energy,
            "192.0.2.30": unsupported,
        }

    monkeypatch.setattr(bridge, "Discover", SimpleNamespace(discover=discover))
    monkeypatch.setenv("TP_LINK_DISCOVERY_TARGETS", "192.0.2.255")
    await bridge.discover_sources("user", "password")

    payload = emitted_lines(capsys)[0]
    assert payload == {
        "type": "discovery",
        "sources": [
            {
                "host": "192.0.2.10",
                "model": "H100",
                "alias": None,
                "sourceType": "hub",
                "deviceId": "hub-device-id",
            },
            {
                "host": "192.0.2.20",
                "model": "H200",
                "alias": "Hallway hub",
                "sourceType": "hub",
                "deviceId": "hub-device-id",
            },
            {
                "host": "192.0.2.25",
                "model": "P110",
                "alias": "P110 outlet",
                "sourceType": "energy-device",
                "deviceId": "p110-device",
            },
        ],
        "warnings": [],
    }
    assert (
        first.disconnected
        and second.disconnected
        and energy.disconnected
        and unsupported.disconnected
    )
    assert energy.updated == [True]


@pytest.mark.asyncio
async def test_discover_sources_merges_multiple_directed_broadcasts(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    first = FakeHub("H200")
    second = FakeHub("H100")
    calls: list[str] = []

    async def discover(**kwargs: Any) -> dict[str, FakeHub]:
        target = kwargs["target"]
        calls.append(target)
        return (
            {"192.0.2.20": first}
            if target == "192.0.2.255"
            else {"198.51.100.10": second}
        )

    monkeypatch.setattr(bridge, "Discover", SimpleNamespace(discover=discover))
    monkeypatch.setenv(
        "TP_LINK_DISCOVERY_TARGETS",
        "192.0.2.255,198.51.100.255,192.0.2.255",
    )
    await bridge.discover_sources("", "")

    assert sorted(calls) == ["192.0.2.255", "198.51.100.255"]
    assert emitted_lines(capsys)[0] == {
        "type": "discovery",
        "sources": [
            {
                "host": "192.0.2.20",
                "model": "H200",
                "alias": "Hallway hub",
                "sourceType": "hub",
                "deviceId": "hub-device-id",
            },
            {
                "host": "198.51.100.10",
                "model": "H100",
                "alias": "Hallway hub",
                "sourceType": "hub",
                "deviceId": "hub-device-id",
            },
        ],
        "warnings": [],
    }
    assert first.disconnected and second.disconnected


@pytest.mark.asyncio
async def test_discover_sources_updates_legacy_energy_devices_without_credentials(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    energy = FakeDeferredEnergyDevice("HS110", 90.0, 3.25)

    async def discover(**kwargs: Any) -> dict[str, FakeEnergyDevice]:
        assert "username" not in kwargs
        assert "password" not in kwargs
        return {"192.0.2.40": energy}

    monkeypatch.setattr(bridge, "Discover", SimpleNamespace(discover=discover))
    await bridge.discover_sources("", "")

    assert emitted_lines(capsys)[0] == {
        "type": "discovery",
        "sources": [
            {
                "host": "192.0.2.40",
                "model": "HS110",
                "alias": "HS110 outlet",
                "sourceType": "energy-device",
                "deviceId": "hs110-device",
            }
        ],
        "warnings": [],
    }
    assert energy.updated == [True]
    assert energy.disconnected


@pytest.mark.asyncio
async def test_discover_sources_surfaces_partial_target_failures(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def discover(**kwargs: Any) -> dict[str, FakeHub]:
        if kwargs["target"] == "192.0.2.255":
            raise OSError("subnet unreachable")
        return {}

    monkeypatch.setattr(bridge, "Discover", SimpleNamespace(discover=discover))
    monkeypatch.setenv("TP_LINK_DISCOVERY_TARGETS", "192.0.2.255,198.51.100.255")

    await bridge.discover_sources("", "")

    assert emitted_lines(capsys)[0] == {
        "type": "discovery",
        "sources": [],
        "warnings": ["TP-Link discovery via 192.0.2.255 failed: subnet unreachable"],
    }


def test_recovery_targets_stay_in_the_last_known_private_subnet() -> None:
    targets = bridge.recovery_targets(["192.168.68.54", "public.example.test"])

    assert targets[:4] == [
        "192.168.68.53",
        "192.168.68.55",
        "192.168.68.52",
        "192.168.68.56",
    ]
    assert len(targets) == 253
    assert "192.168.68.54" not in targets


@pytest.mark.asyncio
async def test_recovery_scan_requires_the_learned_device_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expected = FakeHub("H200", device_id="expected-hub")
    other = FakeHub("H200", device_id="other-hub")

    async def discover_single(host: str, **_kwargs: Any) -> FakeHub | None:
        return {
            "192.168.68.56": expected,
            "192.168.68.57": other,
        }.get(host)

    monkeypatch.setattr(
        bridge, "Discover", SimpleNamespace(discover_single=discover_single)
    )
    matches = await bridge.scan_recovery_subnets(
        ["192.168.68.54"],
        "user",
        "password",
        "expected-hub",
        targets=["192.168.68.56", "192.168.68.57"],
    )

    assert matches == [
        {
            "host": "192.168.68.56",
            "model": "H200",
            "alias": "Hallway hub",
            "sourceType": "hub",
            "sourceDeviceId": "expected-hub",
        }
    ]
    assert expected.disconnected and other.disconnected


@pytest.mark.asyncio
async def test_discovery_falls_back_to_saved_host_subnets(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    scan_targets: list[list[str] | None] = []

    async def discover(**_kwargs: Any) -> dict[str, FakeHub]:
        return {}

    async def scan(*_args: Any, **_kwargs: Any) -> list[dict[str, Any]]:
        scan_targets.append(_kwargs.get("targets"))
        return [
            {
                "host": "192.168.68.56",
                "model": "H200",
                "alias": "Recovered hub",
                "sourceType": "hub",
                "sourceDeviceId": "expected-hub",
            }
        ]

    monkeypatch.setattr(bridge, "Discover", SimpleNamespace(discover=discover))
    monkeypatch.setattr(bridge, "scan_recovery_subnets", scan)
    monkeypatch.setenv("TP_LINK_RECOVERY_HOSTS", "192.168.68.54")
    await bridge.discover_sources("user", "password")

    assert emitted_lines(capsys)[0]["sources"] == [
        {
            "host": "192.168.68.56",
            "model": "H200",
            "alias": "Recovered hub",
            "sourceType": "hub",
            "deviceId": "expected-hub",
        }
    ]
    assert scan_targets[0] == ["192.168.68.54"]
    assert scan_targets[1] is not None
    assert len(scan_targets[1]) == 252
    assert "192.168.68.54" not in scan_targets[1]
    assert "192.168.68.56" not in scan_targets[1]


@pytest.mark.asyncio
async def test_discovery_supplements_a_partial_broadcast_with_energy_devices(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    hub = FakeHub("H200")
    scan_targets: list[list[str] | None] = []

    async def discover(**_kwargs: Any) -> dict[str, FakeHub]:
        return {"192.168.68.54": hub}

    async def scan(*_args: Any, **_kwargs: Any) -> list[dict[str, Any]]:
        targets = _kwargs.get("targets")
        scan_targets.append(targets)
        if targets and "192.168.68.57" in targets:
            return [
                {
                    "host": "192.168.68.57",
                    "model": "HS110",
                    "alias": "Workshop plug",
                    "sourceType": "energy-device",
                    "sourceDeviceId": "legacy-plug",
                }
            ]
        return []

    monkeypatch.setattr(bridge, "Discover", SimpleNamespace(discover=discover))
    monkeypatch.setattr(bridge, "scan_recovery_subnets", scan)
    monkeypatch.setenv("TP_LINK_RECOVERY_HOSTS", "192.168.68.54")
    await bridge.discover_sources("user", "password")

    assert emitted_lines(capsys)[0]["sources"] == [
        {
            "host": "192.168.68.54",
            "model": "H200",
            "alias": "Hallway hub",
            "sourceType": "hub",
            "deviceId": "hub-device-id",
        },
        {
            "host": "192.168.68.57",
            "model": "HS110",
            "alias": "Workshop plug",
            "sourceType": "energy-device",
            "deviceId": "legacy-plug",
        },
    ]
    assert len(scan_targets) == 1
    assert "192.168.68.57" in scan_targets[0]


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
async def test_main_history_protocol_echoes_request_id_and_exits_after_result(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[tuple[Any, ...]] = []

    async def recover_device_history(*args: Any, **_kwargs: Any) -> dict[str, Any]:
        calls.append(args)
        return {
            "state": "complete",
            "samples": [
                {
                    "deviceId": "sensor-1",
                    "metric": "temperature",
                    "value": 21.5,
                    "canonicalUnit": "°C",
                    "timestamp": "2025-07-19T12:00:00Z",
                    "quality": "good",
                }
            ],
            "error": None,
            "deviceId": "sensor-1",
            "metric": "temperature",
        }

    monkeypatch.setattr(bridge, "recover_device_history", recover_device_history)
    monkeypatch.setattr(sys, "argv", ["tp_link_bridge.py", "--history"])
    monkeypatch.setattr(
        sys,
        "stdin",
        io.StringIO(
            json.dumps(
                {
                    "type": "history-request",
                    "requestId": "gap-42",
                    "deviceId": "sensor-1",
                    "metric": "temperature",
                    "from": "2025-07-19T11:45:00Z",
                    "to": "2025-07-19T12:00:00Z",
                }
            )
            + "\n"
        ),
    )
    monkeypatch.setenv("TP_LINK_HOST", "192.0.2.10")
    monkeypatch.setenv("TP_LINK_USERNAME", "user")
    monkeypatch.setenv("TP_LINK_PASSWORD", "password")
    monkeypatch.setenv("TP_LINK_DEVICE_ID", "hub-device-id")

    await bridge.main()

    assert len(calls) == 1
    assert calls[0][:6] == (
        "192.0.2.10",
        "user",
        "password",
        "sensor-1",
        "temperature",
        bridge.parse_history_timestamp("2025-07-19T11:45:00Z", "from"),
    )
    assert calls[0][7] == "hub-device-id"
    assert emitted_lines(capsys) == [
        {
            "type": "history-result",
            "requestId": "gap-42",
            "state": "complete",
            "samples": [
                {
                    "deviceId": "sensor-1",
                    "metric": "temperature",
                    "value": 21.5,
                    "canonicalUnit": "°C",
                    "timestamp": "2025-07-19T12:00:00Z",
                    "quality": "good",
                }
            ],
            "error": None,
            "deviceId": "sensor-1",
            "metric": "temperature",
        }
    ]


@pytest.mark.asyncio
async def test_main_history_protocol_rejects_unbounded_or_naive_requests(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(sys, "argv", ["tp_link_bridge.py", "--history"])
    monkeypatch.setattr(
        sys,
        "stdin",
        io.StringIO(
            json.dumps(
                {
                    "type": "history-request",
                    "requestId": "gap-invalid",
                    "deviceId": "sensor-1",
                    "metric": "temperature",
                    "from": "2025-07-19T11:45:00",
                    "to": "2025-07-19T12:00:00Z",
                }
            )
            + "\n"
        ),
    )
    monkeypatch.setenv("TP_LINK_HOST", "192.0.2.10")
    monkeypatch.setenv("TP_LINK_USERNAME", "user")
    monkeypatch.setenv("TP_LINK_PASSWORD", "password")

    with pytest.raises(SystemExit, match="2"):
        await bridge.main()

    assert emitted_lines(capsys) == [
        {
            "type": "error",
            "requestId": "gap-invalid",
            "message": "History request from must include a UTC offset",
        }
    ]


@pytest.mark.asyncio
async def test_main_uses_safe_interval_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[Any, ...]] = []
    contact_intervals: list[float] = []
    contact_event_settings: list[bool] = []

    async def connect_and_poll(*args: Any, **kwargs: Any) -> None:
        calls.append((*args, kwargs.get("on_success")))
        contact_intervals.append(kwargs["contact_interval_seconds"])
        contact_event_settings.append(kwargs["contact_events_enabled"])
        kwargs["on_success"]()

    monkeypatch.setattr(bridge, "connect_and_poll", connect_and_poll)
    monkeypatch.setattr(sys, "argv", ["tp_link_bridge.py", "--list"])
    monkeypatch.setenv("TP_LINK_HOST", "192.0.2.10")
    monkeypatch.setenv("TP_LINK_USERNAME", "user")
    monkeypatch.setenv("TP_LINK_PASSWORD", "password")
    monkeypatch.setenv("TP_LINK_POLL_INTERVAL_MS", "invalid")
    monkeypatch.setenv("TP_LINK_CONTACT_POLL_INTERVAL_MS", "invalid")

    await bridge.main()
    assert calls[0][:-1] == ("192.0.2.10", "user", "password", 2.0, True)
    assert callable(calls[0][-1])
    assert contact_intervals == [0.5]
    assert contact_event_settings == [True]


@pytest.mark.asyncio
async def test_main_can_disable_the_contact_event_poll_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    contact_event_settings: list[bool] = []

    async def connect_and_poll(*_args: Any, **kwargs: Any) -> None:
        contact_event_settings.append(kwargs["contact_events_enabled"])

    monkeypatch.setattr(bridge, "connect_and_poll", connect_and_poll)
    monkeypatch.setattr(sys, "argv", ["tp_link_bridge.py", "--list"])
    monkeypatch.setenv("TP_LINK_HOST", "192.0.2.10")
    monkeypatch.setenv("TP_LINK_USERNAME", "user")
    monkeypatch.setenv("TP_LINK_PASSWORD", "password")
    monkeypatch.setenv("TP_LINK_CONTACT_EVENTS_ENABLED", "false")

    await bridge.main()

    assert contact_event_settings == [False]
