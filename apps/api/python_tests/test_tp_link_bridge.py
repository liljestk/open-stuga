from __future__ import annotations

import asyncio
import importlib.util
import io
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest


MODULE_PATH = Path(__file__).parents[1] / "python" / "tp_link_bridge.py"
sys.modules.setdefault(
    "kasa",
    SimpleNamespace(
        Discover=object(),
        Module=SimpleNamespace(Energy="Energy", ContactSensor="ContactSensor"),
    ),
)
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
        self.modules: dict[Any, Any] = {}
        self._alias_raises = alias_raises

    @property
    def alias(self) -> str:
        if self._alias_raises:
            raise RuntimeError("alias unavailable")
        return "Kitchen"


class FakeHistoryChild(FakeChild):
    def __init__(self, response: dict[str, Any]) -> None:
        super().__init__()
        self.response = response
        self.queries: list[tuple[str, dict[str, Any] | None]] = []

    async def _query_helper(
        self, method: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        self.queries.append((method, params))
        return self.response


class FakeHub:
    def __init__(
        self,
        model: str = "H100",
        *,
        alias_raises: bool = False,
        device_id: str = "hub-device-id",
    ) -> None:
        self.model = model
        self.device_id = device_id
        self.sys_info = {"device_id": device_id, "model": model}
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


class FakeEnergy:
    def __init__(self, power: float | None, total: float | None) -> None:
        self.current_consumption = power
        self.consumption_total = total


class FakeEnergyDevice:
    def __init__(self, model: str, power: float | None, total: float | None) -> None:
        self.model = model
        self.device_id = f"{model.lower()}-device"
        self.sys_info = {"device_id": self.device_id, "model": model}
        self.alias = f"{model} outlet"
        self.children: list[Any] = []
        self.modules = {bridge.Module.Energy: FakeEnergy(power, total)}
        self.updated: list[bool] = []
        self.disconnected = False

    async def update(self, *, update_children: bool) -> None:
        self.updated.append(update_children)

    async def disconnect(self) -> None:
        self.disconnected = True


class FakePowerHistoryDevice(FakeEnergyDevice):
    def __init__(self) -> None:
        super().__init__("P110", 12.5, 1.25)
        self.queries: list[tuple[str, dict[str, Any] | None]] = []

    async def _query_helper(
        self, method: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        self.queries.append((method, params))
        assert params is not None
        interval_seconds = int(params["interval"]) * 60
        count = (int(params["end_timestamp"]) - int(params["start_timestamp"])) // interval_seconds
        return {
            method: {
                "data": list(range(1, count + 1)),
                "start_timestamp": params["start_timestamp"],
                "end_timestamp": params["end_timestamp"],
                "interval": params["interval"],
            }
        }


class FakeDeferredEnergyDevice(FakeEnergyDevice):
    def __init__(self, model: str, power: float | None, total: float | None) -> None:
        super().__init__(model, power, total)
        self._energy = self.modules.pop(bridge.Module.Energy)

    async def update(self, *, update_children: bool) -> None:
        await super().update(update_children=update_children)
        self.modules[bridge.Module.Energy] = self._energy


def emitted_lines(capsys: pytest.CaptureFixture[str]) -> list[dict[str, Any]]:
    return [json.loads(line) for line in capsys.readouterr().out.splitlines()]


@pytest.mark.parametrize(
    ("value", "expected"),
    [(True, None), (False, None), ("21", None), (21, 21), (21.5, 21.5), (None, None)],
)
def test_optional_number_rejects_non_numeric_values(value: Any, expected: Any) -> None:
    assert bridge.optional_number(value) == expected


@pytest.mark.parametrize(
    ("previous_deadline", "interval_seconds", "now", "expected"),
    [
        (100.0, 2.0, 100.8, 102.0),
        (100.0, 2.0, 102.0, 102.0),
        (100.0, 2.0, 102.8, 104.0),
        (100.0, 2.0, 106.1, 108.0),
    ],
)
def test_advance_poll_deadline_keeps_fixed_rate_without_bunching(
    previous_deadline: float,
    interval_seconds: float,
    now: float,
    expected: float,
) -> None:
    assert bridge.advance_poll_deadline(
        previous_deadline, interval_seconds, now
    ) == pytest.approx(expected)


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
        "contactOpen": None,
    }
    assert bridge.child_snapshot(FakeChild(alias_raises=True))["alias"] is None


def test_child_snapshot_normalizes_contact_state() -> None:
    child = FakeChild()
    child.modules[bridge.Module.ContactSensor] = SimpleNamespace(is_open=True)
    assert bridge.child_snapshot(child)["contactOpen"] is True

    child.modules = {"capability": SimpleNamespace(is_open=False)}
    assert bridge.child_snapshot(child)["contactOpen"] is False

    child.modules.clear()
    child.sys_info["open"] = 0
    assert bridge.child_snapshot(child)["contactOpen"] is False


def test_parse_climate_history_uses_utc_quarter_hour_buckets_and_sentinels() -> None:
    result = bridge.parse_climate_history(
        {
            "get_temp_humidity_records": {
                # 12:07:31 UTC: the final value is anchored at 12:00 UTC.
                "local_time": 1_752_926_851,
                "past24h_temp": [200, -1000, 220, 230],
                "past24h_temp_exception": [0, -1000, 3, 0],
                "temp_unit": "celsius",
            }
        },
        "sensor-1",
        "temperature",
        bridge.parse_history_timestamp("2025-07-19T11:15:00Z", "from"),
        bridge.parse_history_timestamp("2025-07-19T12:00:00Z", "to"),
    )

    assert result["retainedFrom"] == "2025-07-19T11:15:00Z"
    assert result["retainedTo"] == "2025-07-19T12:00:00Z"
    assert result["state"] == "partial"
    assert "1 retained buckets" in result["error"]
    assert result["samples"] == [
        {
            "deviceId": "sensor-1",
            "metric": "temperature",
            "value": 20.0,
            "canonicalUnit": "°C",
            "timestamp": "2025-07-19T11:15:00Z",
            "quality": "estimated",
        },
        {
            "deviceId": "sensor-1",
            "metric": "temperature",
            "value": 22.0,
            "canonicalUnit": "°C",
            "timestamp": "2025-07-19T11:45:00Z",
            "quality": "estimated",
        },
        {
            "deviceId": "sensor-1",
            "metric": "temperature",
            "value": 23.0,
            "canonicalUnit": "°C",
            "timestamp": "2025-07-19T12:00:00Z",
            "quality": "estimated",
        },
    ]


def test_parse_climate_history_keeps_nonzero_comfort_exceptions() -> None:
    result = bridge.parse_climate_history(
        {
            "responseData": {
                "result": {
                    "local_time": 1_752_926_851,
                    "past24h_humidity": [60, 64, 61],
                    # Non-zero entries mean outside a comfort threshold, not bad data.
                    "past24h_humidity_exception": [0, 4, 1],
                }
            }
        },
        "sensor-1",
        "humidity",
        bridge.parse_history_timestamp("2025-07-19T11:30:00Z", "from"),
        bridge.parse_history_timestamp("2025-07-19T12:00:00Z", "to"),
    )

    assert result["state"] == "complete"
    assert [sample["value"] for sample in result["samples"]] == [60, 64, 61]
    assert [sample["timestamp"] for sample in result["samples"]] == [
        "2025-07-19T11:30:00Z",
        "2025-07-19T11:45:00Z",
        "2025-07-19T12:00:00Z",
    ]


def test_parse_climate_history_marks_truncated_ranges_partial() -> None:
    result = bridge.parse_climate_history(
        {
            "local_time": 1_752_926_851,
            "past24h_humidity": [60, 61],
            "past24h_humidity_exception": [0, 0],
        },
        "sensor-1",
        "humidity",
        bridge.parse_history_timestamp("2025-07-19T11:30:00Z", "from"),
        bridge.parse_history_timestamp("2025-07-19T12:00:00Z", "to"),
    )

    assert result["state"] == "partial"
    assert "outside retained device history" in result["error"]
    assert result["retainedFrom"] == "2025-07-19T11:45:00Z"


def test_parse_climate_history_validates_paired_exception_arrays() -> None:
    with pytest.raises(ValueError, match="past24h_temp_exception"):
        bridge.parse_climate_history(
            {
                "local_time": 1_752_926_851,
                "past24h_temp": [200, 201],
                "past24h_temp_exception": [0],
            },
            "sensor-1",
            "temperature",
            bridge.parse_history_timestamp("2025-07-19T11:45:00Z", "from"),
            bridge.parse_history_timestamp("2025-07-19T12:00:00Z", "to"),
        )


def test_parse_power_history_chunk_skips_documented_missing_values() -> None:
    samples, retained_from, retained_to, interval = bridge.parse_power_history_chunk(
        {
            "get_power_data": {
                "data": [10, -1, None, 40],
                "start_timestamp": 1_752_922_800,
                "end_timestamp": 1_752_924_000,
                "interval": 5,
            }
        },
        "plug-1",
        bridge.parse_history_timestamp("2025-07-19T11:00:00Z", "from"),
        bridge.parse_history_timestamp("2025-07-19T12:00:00Z", "to"),
    )

    assert retained_from == 1_752_922_800
    assert retained_to == 1_752_923_700
    assert interval == 300
    assert [(sample["timestamp"], sample["value"]) for sample in samples] == [
        ("2025-07-19T11:00:00Z", 10),
        ("2025-07-19T11:15:00Z", 40),
    ]


@pytest.mark.asyncio
async def test_recover_device_history_queries_the_matching_hub_child(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    child = FakeHistoryChild(
        {
            "get_temp_humidity_records": {
                    "local_time": 1_752_926_851,
                "past24h_temp": [200, 210],
                "past24h_temp_exception": [0, 0],
                "temp_unit": "celsius",
            }
        }
    )
    hub = FakeHub()
    hub.children = [child]

    async def discover_single(*_args: Any, **_kwargs: Any) -> FakeHub:
        return hub

    monkeypatch.setattr(
        bridge, "Discover", SimpleNamespace(discover_single=discover_single)
    )
    result = await bridge.recover_device_history(
        "192.0.2.10",
        "user",
        "password",
        "sensor-1",
        "temperature",
        bridge.parse_history_timestamp("2025-07-19T11:45:00Z", "from"),
        bridge.parse_history_timestamp("2025-07-19T12:00:00Z", "to"),
        "hub-device-id",
    )

    assert result["state"] == "complete"
    assert child.queries == [("get_temp_humidity_records", None)]
    assert hub.updated == [True]
    assert hub.disconnected


@pytest.mark.asyncio
async def test_recover_device_history_reuses_live_session_without_disconnect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    child = FakeHistoryChild(
        {
            "get_temp_humidity_records": {
                "local_time": 1_752_926_851,
                "past24h_temp": [200, 210],
                "past24h_temp_exception": [0, 0],
                "temp_unit": "celsius",
            }
        }
    )
    hub = FakeHub()
    hub.children = [child]

    async def unexpected_discovery(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("live history must not open another encrypted session")

    monkeypatch.setattr(
        bridge, "Discover", SimpleNamespace(discover_single=unexpected_discovery)
    )
    result = await bridge.recover_device_history(
        "",
        "",
        "",
        "sensor-1",
        "temperature",
        bridge.parse_history_timestamp("2025-07-19T11:45:00Z", "from"),
        bridge.parse_history_timestamp("2025-07-19T12:00:00Z", "to"),
        "hub-device-id",
        connected_device=hub,
    )

    assert result["state"] == "complete"
    assert hub.updated == [True]
    assert not hub.disconnected


@pytest.mark.asyncio
async def test_recover_device_power_history_chunks_and_uses_hourly_data(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    device = FakePowerHistoryDevice()

    async def discover_single(*_args: Any, **_kwargs: Any) -> FakePowerHistoryDevice:
        return device

    monkeypatch.setattr(
        bridge, "Discover", SimpleNamespace(discover_single=discover_single)
    )
    result = await bridge.recover_device_history(
        "192.0.2.30",
        "user",
        "password",
        "p110-device",
        "power",
        bridge.parse_history_timestamp("2025-07-01T00:00:00Z", "from"),
        bridge.parse_history_timestamp("2025-07-19T00:00:00Z", "to"),
    )

    assert result["state"] == "complete"
    assert result["intervalSeconds"] == 3600
    assert len(result["samples"]) == 433
    assert len(device.queries) == 4
    assert all(query[1]["interval"] == 60 for query in device.queries)
    assert all(
        query[1]["end_timestamp"] - query[1]["start_timestamp"]
        <= 144 * 60 * 60
        for query in device.queries
    )
    assert device.disconnected


@pytest.mark.asyncio
async def test_recover_device_history_does_not_relabel_interval_energy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    device = FakePowerHistoryDevice()

    async def discover_single(*_args: Any, **_kwargs: Any) -> FakePowerHistoryDevice:
        return device

    monkeypatch.setattr(
        bridge, "Discover", SimpleNamespace(discover_single=discover_single)
    )
    result = await bridge.recover_device_history(
        "192.0.2.30",
        "user",
        "password",
        "p110-device",
        "energy",
        bridge.parse_history_timestamp("2025-07-19T11:00:00Z", "from"),
        bridge.parse_history_timestamp("2025-07-19T12:00:00Z", "to"),
    )

    assert result["state"] == "not-supported"
    assert "cumulative energy metric" in result["error"]
    assert device.queries == []


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
    assert payload["sourceDeviceId"] == "hub-device-id"
    assert payload["timestamp"].endswith("Z")
    assert payload["devices"][0]["deviceId"] == "sensor-1"
    assert hub.updated == [True]
    assert hub.disconnected


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
            {"host": "192.0.2.10", "model": "H100", "alias": None, "sourceType": "hub"},
            {
                "host": "192.0.2.20",
                "model": "H200",
                "alias": "Hallway hub",
                "sourceType": "hub",
            },
            {
                "host": "192.0.2.25",
                "model": "P110",
                "alias": "P110 outlet",
                "sourceType": "energy-device",
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
            },
            {
                "host": "198.51.100.10",
                "model": "H100",
                "alias": "Hallway hub",
                "sourceType": "hub",
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
            return [{
                "host": "192.168.68.57",
                "model": "HS110",
                "alias": "Workshop plug",
                "sourceType": "energy-device",
                "sourceDeviceId": "legacy-plug",
            }]
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
        },
        {
            "host": "192.168.68.57",
            "model": "HS110",
            "alias": "Workshop plug",
            "sourceType": "energy-device",
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

    async def connect_and_poll(*args: Any, **kwargs: Any) -> None:
        calls.append((*args, kwargs.get("on_success")))
        kwargs["on_success"]()

    monkeypatch.setattr(bridge, "connect_and_poll", connect_and_poll)
    monkeypatch.setattr(sys, "argv", ["tp_link_bridge.py", "--list"])
    monkeypatch.setenv("TP_LINK_HOST", "192.0.2.10")
    monkeypatch.setenv("TP_LINK_USERNAME", "user")
    monkeypatch.setenv("TP_LINK_PASSWORD", "password")
    monkeypatch.setenv("TP_LINK_POLL_INTERVAL_MS", "invalid")

    await bridge.main()
    assert calls[0][:-1] == ("192.0.2.10", "user", "password", 2.0, True)
    assert callable(calls[0][-1])


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
