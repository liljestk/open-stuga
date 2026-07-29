from __future__ import annotations

import asyncio
import importlib.util
import sys
from enum import IntEnum
from pathlib import Path
from types import SimpleNamespace

import pytest


MODULE_PATH = Path(__file__).parents[1] / "python" / "gree_bridge.py"
SPEC = importlib.util.spec_from_file_location("gree_bridge", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
bridge = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bridge
SPEC.loader.exec_module(bridge)


class Mode(IntEnum):
    Auto = 0
    Cool = 1
    Dry = 2
    Fan = 3
    Heat = 4


class FanSpeed(IntEnum):
    Auto = 0


class Swing(IntEnum):
    Default = 0
    FullSwing = 1


class FakeDevice:
    def __init__(self, raw_temperature: int | None) -> None:
        self.raw_temperature = raw_temperature
        self.version = "3.31"
        self.current_temperature = 72
        self.temperature_units = 1
        self.target_temperature = 68
        self.power = True
        self.mode = Mode.Cool
        self.fan_speed = FanSpeed.Auto
        self.horizontal_swing = Swing.Default
        self.vertical_swing = Swing.FullSwing
        self.quiet = 0
        self.turbo = False
        self.xfan = True

    def get_property(self, property_name: object) -> int | None:
        if property_name is bridge.Props.TEMP_SENSOR:
            return self.raw_temperature
        return 0

    def _convert_to_units(self, _value: float, _bit: int) -> int:
        return self.current_temperature


@pytest.fixture(autouse=True)
def enums(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        bridge, "Props", SimpleNamespace(TEMP_SENSOR=object(), TEMP_BIT=object())
    )
    monkeypatch.setattr(
        bridge, "TemperatureUnits", SimpleNamespace(F=SimpleNamespace(value=1))
    )
    monkeypatch.setattr(bridge, "Mode", Mode)
    monkeypatch.setattr(bridge, "FanSpeed", FanSpeed)
    monkeypatch.setattr(bridge, "HorizontalSwing", Swing)
    monkeypatch.setattr(bridge, "VerticalSwing", Swing)


def test_normalizes_mac_without_exposing_address_format_variants() -> None:
    assert bridge.normalized_mac("aa:bb:cc:dd:ee:ff") == "AABBCCDDEEFF"
    assert bridge.normalized_mac("AA-BB-CC-DD-EE-FF") == "AABBCCDDEEFF"
    with pytest.raises(ValueError, match="GREE_MAC is invalid"):
        bridge.normalized_mac("not-a-mac")


def test_snapshot_keeps_selected_mode_separate_from_actual_activity() -> None:
    state = bridge.state_json(FakeDevice(raw_temperature=72))
    assert state["power"] is True
    assert state["selectedMode"] == "cool"
    assert state["activity"] == "unknown"
    assert state["activityEvidence"] == "unavailable"
    assert state["targetTemperatureC"] == 20
    assert state["currentTemperatureC"] == 22.2
    assert state["currentTemperatureSource"] == "reported"


@pytest.mark.parametrize("raw_temperature", [None, 0])
def test_snapshot_never_substitutes_target_for_missing_indoor_temperature(
    raw_temperature: int | None,
) -> None:
    state = bridge.state_json(FakeDevice(raw_temperature))
    assert state["targetTemperatureC"] == 20
    assert state["currentTemperatureC"] is None
    assert state["currentTemperatureSource"] == "unavailable"


def test_snapshot_accepts_a_real_zero_degree_v4_reading() -> None:
    device = FakeDevice(0)
    device.version = "4.0"
    device.current_temperature = 0
    device.temperature_units = 0
    state = bridge.state_json(device)
    assert state["currentTemperatureC"] == 0
    assert state["currentTemperatureSource"] == "reported"


def test_snapshot_rejects_invalid_sensor_data_instead_of_using_target() -> None:
    device = FakeDevice(255)
    device.current_temperature = device.target_temperature
    state = bridge.state_json(device)
    assert state["currentTemperatureC"] is None
    assert state["currentTemperatureSource"] == "unavailable"


def test_saved_key_connection_opens_a_udp_transport() -> None:
    class Protocol(asyncio.DatagramProtocol):
        def __init__(self) -> None:
            self.device_info = SimpleNamespace(ip="127.0.0.1", port=9)
            self.transport = None
            self.binding = None

        async def bind(self, *, key: str, cipher: object) -> None:
            self.binding = (key, cipher)

        def connection_made(self, transport: asyncio.BaseTransport) -> None:
            self.transport = transport

    async def run() -> None:
        device = Protocol()
        cipher = object()
        await bridge.connect_with_key(device, "saved-key", cipher)
        assert device.binding == ("saved-key", cipher)
        assert device.transport is not None
        device.transport.close()

    asyncio.run(run())


def test_normal_poll_interval_does_not_emit_a_timeout_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Stop:
        stopped = False

        def is_set(self) -> bool:
            return self.stopped

        async def wait(self) -> None:
            return None

    class Device:
        def __init__(self, _info: object, timeout: int) -> None:
            assert timeout == 15

        def close(self) -> None:
            return None

    stop = Stop()
    info = SimpleNamespace(
        ip="127.0.0.1",
        port=7000,
        mac="AABBCCDDEEFF",
        name="Nordkapp",
        brand="Wilfa",
        model="Nordkapp 30",
        version="4.0",
    )
    emitted: list[dict[str, object]] = []

    async def no_op(*_args: object) -> None:
        return None

    async def finish_interval(awaitable: object, timeout: float) -> None:
        assert timeout == 60
        close = getattr(awaitable, "close", None)
        if close:
            close()
        stop.stopped = True
        raise TimeoutError

    monkeypatch.setenv("GREE_KEY", "saved-key")
    monkeypatch.setenv("GREE_CIPHER_VERSION", "1")
    monkeypatch.setenv("GREE_POLL_INTERVAL_MS", "60000")
    monkeypatch.setattr(bridge, "_STOP", stop)
    monkeypatch.setattr(bridge, "Device", Device)
    monkeypatch.setattr(bridge, "require_runtime", lambda: None)
    monkeypatch.setattr(bridge, "configured_info", lambda: info)
    monkeypatch.setattr(bridge, "cipher_for", lambda _version: object())
    monkeypatch.setattr(bridge, "connect_with_key", no_op)
    monkeypatch.setattr(bridge, "refresh", no_op)
    monkeypatch.setattr(bridge, "state_json", lambda _device: {})
    monkeypatch.setattr(bridge, "emit", emitted.append)
    monkeypatch.setattr(bridge.asyncio, "wait_for", finish_interval)

    asyncio.run(bridge.poll())

    assert [message["type"] for message in emitted] == ["snapshot"]
