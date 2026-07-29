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


def test_runtime_and_value_helpers(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(bridge, "Device", None)
    monkeypatch.setattr(bridge, "Discovery", None)
    with pytest.raises(RuntimeError, match="greeclimate is not installed"):
        bridge.require_runtime()

    bridge.emit({"type": "status", "name": "Nordkapp"})
    assert capsys.readouterr().out == '{"type":"status","name":"Nordkapp"}\n'

    closed: list[bool] = []
    bridge.safe_close(SimpleNamespace(close=lambda: closed.append(True)))
    bridge.safe_close(object())

    class BrokenClose:
        def close(self) -> None:
            raise RuntimeError("already closed")

    bridge.safe_close(BrokenClose())
    assert closed == [True]
    assert bridge.optional_text(None) is None
    assert bridge.optional_text("  ") is None
    assert bridge.optional_text(" Wilfa ") == "Wilfa"
    assert bridge.enum_label(Mode, Mode.Heat) == "Heat"
    assert bridge.enum_label(Mode, 99) == "unknown-99"
    assert bridge.enum_label(None, 1) is None
    assert bridge.celsius(None, 0) is None
    assert bridge.celsius(True, 0) is None
    assert bridge.celsius("invalid", 0) is None
    assert bridge.celsius(68, bridge.TemperatureUnits.F.value) == 20


def test_discovery_targets_and_device_info(monkeypatch: pytest.MonkeyPatch) -> None:
    info = SimpleNamespace(
        ip="192.168.100.44",
        port="7000",
        mac="aa:bb:cc:dd:ee:ff",
        name=" Nordkapp ",
        brand=" ",
        model=None,
        version="4.0",
    )
    assert bridge.device_info_json(info) == {
        "host": "192.168.100.44",
        "port": 7000,
        "mac": "AABBCCDDEEFF",
        "name": "Nordkapp",
        "brand": None,
        "model": None,
        "version": "4.0",
    }

    monkeypatch.setenv("GREE_DISCOVERY_TARGETS", "192.168.100.255, ,10.0.0.255")
    targets = bridge.discovery_targets()
    assert targets is not None
    assert [str(target) for target in targets] == ["192.168.100.255", "10.0.0.255"]
    monkeypatch.delenv("GREE_DISCOVERY_TARGETS")
    assert bridge.discovery_targets() is None


def test_scan_devices_closes_discovery(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: dict[str, object] = {}

    class Discovery:
        def __init__(self, *, timeout: int) -> None:
            calls["timeout"] = timeout

        async def scan(
            self, *, wait_for: int, bcast_ifaces: list[object] | None
        ) -> list[str]:
            calls["wait_for"] = wait_for
            calls["targets"] = bcast_ifaces
            return ["heat-pump"]

        def close(self) -> None:
            calls["closed"] = True

    monkeypatch.setattr(bridge, "Device", object())
    monkeypatch.setattr(bridge, "Discovery", Discovery)
    monkeypatch.setenv("GREE_DISCOVERY_TARGETS", "192.168.100.255")

    assert asyncio.run(bridge.scan_devices(wait_for=1)) == ["heat-pump"]
    assert calls["timeout"] == 2
    assert calls["wait_for"] == 1
    assert [str(target) for target in calls["targets"]] == ["192.168.100.255"]
    assert calls["closed"] is True


def test_refresh_registers_and_removes_response_handlers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result_event = object()
    data_event = object()
    monkeypatch.setattr(
        bridge, "Response", SimpleNamespace(RESULT=result_event, DATA=data_event)
    )

    class Device:
        def __init__(self) -> None:
            self.handlers: dict[object, object] = {}
            self.removed: list[object] = []

        def add_handler(self, event: object, handler: object) -> None:
            self.handlers[event] = handler

        def remove_handler(self, event: object, handler: object) -> None:
            assert self.handlers[event] is handler
            self.removed.append(event)

        async def update_state(self) -> None:
            self.handlers[result_event]("response")

    device = Device()
    asyncio.run(bridge.refresh(device, timeout_seconds=1))
    assert device.removed == [result_event, data_event]


def test_bind_and_discover_emit_sanitized_devices(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    info = SimpleNamespace(
        ip="192.168.100.44",
        port=7000,
        mac="AA:BB:CC:DD:EE:FF",
        name="Nordkapp",
        brand="Wilfa",
        model="Nordkapp 30",
        version="4.0",
    )
    emitted: list[dict[str, object]] = []

    async def missing_scan() -> list[object]:
        return []

    monkeypatch.setattr(bridge, "scan_devices", missing_scan)
    with pytest.raises(RuntimeError, match="selected heat pump was not found"):
        asyncio.run(bridge.bind_device("AA:BB:CC:DD:EE:FF"))

    class CipherV2:
        pass

    class Device:
        def __init__(
            self, device_info: object, timeout: int, bind_timeout: int
        ) -> None:
            assert timeout == 15
            assert bind_timeout == 10
            self.device_info = device_info
            self.device_cipher = CipherV2()
            self.device_key = "secret-binding-key"
            self.closed = False

        async def bind(self) -> None:
            return None

        def close(self) -> None:
            self.closed = True

    async def found_scan() -> list[object]:
        return [info]

    async def no_op(_device: object) -> None:
        return None

    monkeypatch.setattr(bridge, "scan_devices", found_scan)
    monkeypatch.setattr(bridge, "CipherV2", CipherV2)
    monkeypatch.setattr(bridge, "Device", Device)
    monkeypatch.setattr(bridge, "refresh", no_op)
    monkeypatch.setattr(bridge, "state_json", lambda _device: {"power": False})
    monkeypatch.setattr(bridge, "emit", emitted.append)

    asyncio.run(bridge.bind_device("AA-BB-CC-DD-EE-FF"))
    assert emitted == [
        {
            "type": "bound",
            "device": {
                "host": "192.168.100.44",
                "port": 7000,
                "mac": "AABBCCDDEEFF",
                "name": "Nordkapp",
                "brand": "Wilfa",
                "model": "Nordkapp 30",
                "version": "4.0",
            },
            "key": "secret-binding-key",
            "cipherVersion": 2,
            "state": {"power": False},
        }
    ]

    emitted.clear()

    async def duplicate_scan() -> list[object]:
        duplicate = SimpleNamespace(**vars(info))
        duplicate.name = "Updated name"
        return [info, duplicate]

    monkeypatch.setattr(bridge, "scan_devices", duplicate_scan)
    asyncio.run(bridge.discover())
    assert emitted[0]["type"] == "discovery"
    assert emitted[0]["devices"][0]["name"] == "Updated name"


def test_configured_and_recovered_device_info(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: list[tuple[object, ...]] = []

    def device_info(*args: object) -> object:
        captured.append(args)
        return SimpleNamespace(
            ip=args[0],
            port=args[1],
            mac=args[2],
            name=args[3],
            brand=args[4],
            model=args[5],
            version=args[6],
        )

    monkeypatch.setattr(bridge, "DeviceInfo", device_info)
    monkeypatch.setenv("GREE_HOST", " 192.168.100.44 ")
    monkeypatch.setenv("GREE_PORT", "7001")
    monkeypatch.setenv("GREE_MAC", "aa:bb:cc:dd:ee:ff")
    monkeypatch.setenv("GREE_NAME", "")
    monkeypatch.setenv("GREE_BRAND", " Wilfa ")
    monkeypatch.setenv("GREE_MODEL", "")
    monkeypatch.setenv("GREE_VERSION", " 4.0 ")

    info = bridge.configured_info()
    assert captured == [
        (
            "192.168.100.44",
            7001,
            "AABBCCDDEEFF",
            "aa:bb:cc:dd:ee:ff",
            "Wilfa",
            None,
            "4.0",
        )
    ]

    async def scan() -> list[object]:
        return [info]

    monkeypatch.setattr(bridge, "scan_devices", scan)
    assert asyncio.run(bridge.recover_info("AABBCCDDEEFF")) is info
    assert asyncio.run(bridge.recover_info("112233445566")) is None


def test_poll_recovers_after_timeouts_and_reports_host_change(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Stop:
        stopped = False

        def is_set(self) -> bool:
            return self.stopped

        async def wait(self) -> None:
            return None

    class Device:
        def __init__(self, info: object, timeout: int) -> None:
            assert timeout == 15
            self.info = info

        def close(self) -> None:
            return None

    old_info = SimpleNamespace(ip="192.168.100.44", mac="AABBCCDDEEFF")
    new_info = SimpleNamespace(ip="192.168.100.45", mac="AABBCCDDEEFF")
    emitted: list[dict[str, object]] = []
    stop = Stop()
    waits = 0

    async def no_op(*_args: object) -> None:
        return None

    async def timeout_refresh(_device: object) -> None:
        raise TimeoutError

    async def recover(_mac: str) -> object:
        return new_info

    async def finish_after_second_wait(awaitable: object, timeout: float) -> None:
        nonlocal waits
        waits += 1
        assert timeout in (1, 2)
        close = getattr(awaitable, "close", None)
        if close:
            close()
        if waits == 2:
            stop.stopped = True
        raise TimeoutError

    monkeypatch.setenv("GREE_KEY", "saved-key")
    monkeypatch.setenv("GREE_CIPHER_VERSION", "2")
    monkeypatch.setenv("GREE_POLL_INTERVAL_MS", "10000")
    monkeypatch.setattr(bridge, "_STOP", stop)
    monkeypatch.setattr(bridge, "Device", Device)
    monkeypatch.setattr(bridge, "require_runtime", lambda: None)
    monkeypatch.setattr(bridge, "configured_info", lambda: old_info)
    monkeypatch.setattr(bridge, "cipher_for", lambda _version: object())
    monkeypatch.setattr(bridge, "connect_with_key", no_op)
    monkeypatch.setattr(bridge, "refresh", timeout_refresh)
    monkeypatch.setattr(bridge, "recover_info", recover)
    monkeypatch.setattr(bridge, "emit", emitted.append)
    monkeypatch.setattr(bridge.asyncio, "wait_for", finish_after_second_wait)

    asyncio.run(bridge.poll())
    assert [message["type"] for message in emitted] == [
        "error",
        "error",
        "host-change",
    ]
    assert emitted[-1] == {
        "type": "host-change",
        "previousHost": "192.168.100.44",
        "host": "192.168.100.45",
    }


def test_poll_rejects_missing_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(bridge, "require_runtime", lambda: None)
    monkeypatch.delenv("GREE_KEY", raising=False)
    monkeypatch.setenv("GREE_CIPHER_VERSION", "0")
    with pytest.raises(
        ValueError, match="GREE_KEY and a valid GREE_CIPHER_VERSION are required"
    ):
        asyncio.run(bridge.poll())


@pytest.mark.parametrize(
    ("arguments", "expected"),
    [(["--discover"], "discover"), (["--bind"], "bind"), ([], "poll")],
)
def test_main_dispatches_requested_mode(
    monkeypatch: pytest.MonkeyPatch, arguments: list[str], expected: str
) -> None:
    called: list[str] = []

    async def discover() -> None:
        called.append("discover")

    async def bind(mac: str) -> None:
        assert mac == "AABBCCDDEEFF"
        called.append("bind")

    async def poll() -> None:
        called.append("poll")

    monkeypatch.setenv("GREE_MAC", "AABBCCDDEEFF")
    monkeypatch.setattr(sys, "argv", ["gree_bridge.py", *arguments])
    monkeypatch.setattr(bridge, "require_runtime", lambda: None)
    monkeypatch.setattr(bridge, "discover", discover)
    monkeypatch.setattr(bridge, "bind_device", bind)
    monkeypatch.setattr(bridge, "poll", poll)

    asyncio.run(bridge.main())
    assert called == [expected]
