# ruff: noqa: F403, F405
from __future__ import annotations

from tp_link_bridge_test_support import *  # noqa: F403


@pytest.mark.parametrize(
    ("value", "expected"),
    [(True, None), (False, None), ("21", None), (21, 21), (21.5, 21.5), (None, None)],
)
def test_optional_number_rejects_non_numeric_values(value: Any, expected: Any) -> None:
    assert bridge.optional_number(value) == expected


def test_optional_device_accessors_fail_closed() -> None:
    class BrokenDevice:
        @property
        def modules(self) -> dict[Any, Any]:
            raise RuntimeError("modules unavailable")

    class BrokenAttribute:
        @property
        def current_consumption(self) -> float:
            raise RuntimeError("measurement unavailable")

    device = BrokenDevice()
    assert bridge.energy_module(device) is None
    assert bridge.contact_open(device, {"open": 1}) is True
    assert bridge.contact_open(device, {"open": False}) is False
    assert (
        bridge.optional_attribute_number(BrokenAttribute(), "current_consumption")
        is None
    )


@pytest.mark.parametrize(
    "candidate",
    [
        None,
        {"type": "not-history"},
        {
            "type": "history-request",
            "deviceId": "",
            "metric": "temperature",
            "from": "2026-01-01T00:00:00Z",
            "to": "2026-01-01T01:00:00Z",
        },
        {
            "type": "history-request",
            "deviceId": "sensor-1",
            "metric": "",
            "from": "2026-01-01T00:00:00Z",
            "to": "2026-01-01T01:00:00Z",
        },
        {
            "type": "history-request",
            "requestId": "",
            "deviceId": "sensor-1",
            "metric": "temperature",
            "from": "2026-01-01T00:00:00Z",
            "to": "2026-01-01T01:00:00Z",
        },
        {
            "type": "history-request",
            "deviceId": "sensor-1",
            "metric": "temperature",
            "from": "2026-01-02T00:00:00Z",
            "to": "2026-01-01T00:00:00Z",
        },
        {
            "type": "history-request",
            "deviceId": "sensor-1",
            "metric": "temperature",
            "from": "2026-01-01T00:00:00Z",
            "to": "2026-02-02T00:00:00Z",
        },
    ],
)
def test_parse_history_request_rejects_invalid_protocol_shapes(candidate: Any) -> None:
    with pytest.raises(bridge.HistoryRequestError):
        bridge.parse_history_request(candidate)


@pytest.mark.parametrize(
    "payload",
    ["", "{not-json}", "x" * 65_537],
    ids=["empty", "malformed", "oversized"],
)
def test_read_history_request_rejects_missing_malformed_or_oversized_input(
    monkeypatch: pytest.MonkeyPatch,
    payload: str,
) -> None:
    monkeypatch.setattr(sys, "stdin", io.StringIO(payload))
    with pytest.raises(bridge.HistoryRequestError):
        bridge.read_history_request()


def test_source_device_id_uses_the_public_fallback_when_sys_info_fails() -> None:
    class Device:
        device_id = " fallback-id "

        @property
        def sys_info(self) -> dict[str, Any]:
            raise RuntimeError("sys_info unavailable")

    assert bridge.source_device_id(Device()) == "fallback-id"


@pytest.mark.asyncio
async def test_recover_source_host_accepts_one_identity_matched_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    match = {"host": "192.168.1.24", "sourceDeviceId": "hub-1"}

    async def scan(
        reference_hosts: list[str],
        username: str,
        password: str,
        expected_device_id: str | None = None,
        targets: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        assert (reference_hosts, username, password, expected_device_id, targets) == (
            ["192.168.1.20"],
            "user",
            "secret",
            "hub-1",
            None,
        )
        return [match]

    monkeypatch.setattr(bridge, "scan_recovery_subnets", scan)
    assert (
        await bridge.recover_source_host("192.168.1.20", "user", "secret", "hub-1")
        == match
    )


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
        query[1]["end_timestamp"] - query[1]["start_timestamp"] <= 144 * 60 * 60
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
