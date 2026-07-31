from __future__ import annotations

import io
import json
import queue
import sys
from types import SimpleNamespace
from typing import Any

import pytest

import tuya_bridge as bridge
from tuya_profiles import LIGHT_PROFILE


LIGHT_STATUS = {
    "dps": {"20": True, "21": "white", "22": 500, "23": 500, "24": "0000000003e8"}
}
SWITCH_STATUS = {"dps": {"1": True}}


class FakeDevice:
    def __init__(
        self,
        status: dict[str, Any] | BaseException = LIGHT_STATUS,
        command_response: dict[str, Any] | None = None,
    ) -> None:
        self.status_value = status
        self.command_response = command_response or {}
        self.closed = False
        self.commands: list[dict[str, Any]] = []

    def status(self) -> dict[str, Any]:
        if isinstance(self.status_value, BaseException):
            raise self.status_value
        return self.status_value

    def set_multiple_values(self, values: dict[str, Any]) -> dict[str, Any]:
        self.commands.append(values)
        return self.command_response

    def close(self) -> None:
        self.closed = True


def config(**changes: Any) -> dict[str, Any]:
    return {
        "host": "192.168.1.10",
        "deviceId": "device-id",
        "localKey": "local-key",
        "protocolVersion": "3.5",
        "pollIntervalMs": 5000,
        "profileId": LIGHT_PROFILE,
        **changes,
    }


def stdin(monkeypatch: pytest.MonkeyPatch, content: bytes) -> None:
    monkeypatch.setattr(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(content)))


def emitted(capsys: pytest.CaptureFixture[str]) -> list[dict[str, Any]]:
    return [json.loads(line) for line in capsys.readouterr().out.splitlines()]


def feed_worker(
    monkeypatch: pytest.MonkeyPatch, messages: list[dict[str, Any] | None]
) -> None:
    def reader(target: queue.Queue[dict[str, Any] | None]) -> None:
        for message in messages:
            target.put(message)

    class ImmediateThread:
        def __init__(self, *, target: Any, args: tuple[Any, ...], daemon: bool) -> None:
            assert target is reader
            assert daemon is True
            self.args = args

        def start(self) -> None:
            reader(*self.args)

    monkeypatch.setattr(bridge, "input_reader", reader)
    monkeypatch.setattr(bridge.threading, "Thread", ImmediateThread)


def test_emit_and_error_fallback_are_safe(
    capsys: pytest.CaptureFixture[str],
) -> None:
    bridge.emit({"message": "hyvää"})
    assert emitted(capsys) == [{"message": "hyvää"}]
    assert bridge.public_error(OSError(""), fallback="safe failure") == "safe failure"
    assert len(bridge.public_error(OSError("x" * 600))) == 500


def test_runtime_and_input_validation(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(bridge, "tinytuya", None)
    with pytest.raises(RuntimeError, match="not installed"):
        bridge.require_runtime()

    stdin(monkeypatch, b'{"host":"192.168.1.10"}\n')
    assert bridge.read_message() == {"host": "192.168.1.10"}
    stdin(monkeypatch, b"[]\n")
    with pytest.raises(ValueError, match="must be an object"):
        bridge.read_message()
    stdin(monkeypatch, b"")
    with pytest.raises(ValueError, match="missing or too large"):
        bridge.read_message()
    stdin(monkeypatch, b"x" * (bridge.MAX_LINE_BYTES + 1))
    with pytest.raises(ValueError, match="missing or too large"):
        bridge.read_message()


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"host": "invalid"}, "IPv4"),
        ({"deviceId": ""}, "identity"),
        ({"localKey": ""}, "local key"),
        ({"protocolVersion": "4.0"}, "version"),
        ({"pollIntervalMs": True}, "poll interval"),
        ({"pollIntervalMs": 1999}, "poll interval"),
        ({"pollIntervalMs": 900001}, "poll interval"),
    ],
)
def test_validated_config_rejects_unsafe_values(
    changes: dict[str, Any], message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        bridge.validated_config(config(**changes), require_profile=True)


def test_validated_config_normalizes_values_and_requires_known_profile() -> None:
    value = bridge.validated_config(
        config(host=" 127.0.0.1 ", pollIntervalMs=2500.4), require_profile=True
    )
    assert value["host"] == "127.0.0.1"
    assert value["pollIntervalMs"] == 2500
    with pytest.raises(ValueError, match="profile"):
        bridge.validated_config(config(profileId="unknown"), require_profile=True)
    with pytest.raises(ValueError, match="invalid"):
        bridge.validated_config(None)


def test_device_creation_status_check_and_safe_close(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    def factory(*args: Any, **kwargs: Any) -> FakeDevice:
        created.append((args, kwargs))
        return FakeDevice()

    monkeypatch.setattr(bridge, "tinytuya", SimpleNamespace(Device=factory))
    device = bridge.device_for(config(), "192.168.1.20")
    assert created[0][0] == ("device-id", "192.168.1.20", "local-key")
    assert created[0][1]["version"] == 3.5
    assert bridge.checked_status(device) == LIGHT_STATUS
    bridge.safe_close(device)
    assert device.closed is True

    with pytest.raises(OSError, match="denied"):
        bridge.checked_status(SimpleNamespace(status=lambda: {"Error": "denied"}))
    with pytest.raises(OSError, match="valid status"):
        bridge.checked_status(SimpleNamespace(status=lambda: []))
    bridge.safe_close(object())
    bridge.safe_close(SimpleNamespace(close=lambda: (_ for _ in ()).throw(OSError())))


def test_public_discovery_removes_private_fields_and_rejects_unknown_devices() -> None:
    assert bridge.public_discovery(None, "192.168.1.2") is None
    assert bridge.public_discovery({"gwId": "id", "version": "4.0"}, "host") is None
    assert bridge.public_discovery(
        {
            "devId": " device ",
            "version": "3.5",
            "productKey": " product ",
            "mac": "AA:BB:CC:DD:EE:FF",
            "localKey": "must-not-leak",
        },
        "192.168.1.2",
    ) == {
        "host": "192.168.1.2",
        "deviceId": "device",
        "protocolVersion": "3.5",
        "productKey": "product",
        "mac": "AA:BB:CC:DD:EE:FF",
    }


def test_discovery_tolerates_port_conflicts_and_bad_packets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Listener:
        def __init__(self, index: int) -> None:
            self.index = index
            self.closed = False

        def setsockopt(self, *_args: Any) -> None:
            return None

        def bind(self, address: tuple[str, int]) -> None:
            if address[1] == 6667:
                raise OSError("in use")

        def setblocking(self, _enabled: bool) -> None:
            return None

        def recvfrom(self, _size: int) -> tuple[bytes, tuple[str, int]]:
            if self.index == 2:
                raise ValueError("bad packet")
            return b"valid", ("192.168.1.40", 6666)

        def close(self) -> None:
            self.closed = True

    listeners: list[Listener] = []

    def socket_factory(*_args: Any) -> Listener:
        listener = Listener(len(listeners))
        listeners.append(listener)
        return listener

    clock = iter([0.0, 0.1, 0.2, 2.0])
    monkeypatch.setattr(bridge.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(bridge.socket, "socket", socket_factory)
    monkeypatch.setattr(
        bridge.select, "select", lambda sockets, *_args: (sockets, [], [])
    )
    monkeypatch.setattr(
        bridge,
        "tinytuya",
        SimpleNamespace(
            decrypt_udp=lambda _payload: {"gwId": "device", "version": "3.5"}
        ),
    )
    assert bridge.discover(0.1) == [
        {
            "host": "192.168.1.40",
            "deviceId": "device",
            "protocolVersion": "3.5",
            "productKey": None,
            "mac": None,
        }
    ]
    assert all(listener.closed for listener in listeners)


def test_probe_closes_device_and_returns_normalized_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    device = FakeDevice()
    monkeypatch.setattr(bridge, "device_for", lambda _config: device)
    result = bridge.probe(config())
    assert result["type"] == "verified"
    assert result["profile"]["id"] == LIGHT_PROFILE
    assert result["state"]["power"] is True
    assert device.closed is True


def test_local_candidates_checks_only_open_tuya_ports(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Connection:
        def __enter__(self) -> Connection:
            return self

        def __exit__(self, *_args: Any) -> None:
            return None

    class Executor:
        def __init__(self, *, max_workers: int) -> None:
            assert max_workers == 32

        def __enter__(self) -> Executor:
            return self

        def __exit__(self, *_args: Any) -> None:
            return None

        def map(self, function: Any, values: list[str]) -> Any:
            return map(function, values)

    def connect(address: tuple[str, int], *, timeout: float) -> Connection:
        assert address[1] == 6668
        assert timeout == 0.18
        if address[0] != "192.168.1.42":
            raise OSError("closed")
        return Connection()

    monkeypatch.setattr(bridge, "ThreadPoolExecutor", Executor)
    monkeypatch.setattr(bridge.socket, "create_connection", connect)
    assert bridge.local_candidates("192.168.1.10") == ["192.168.1.42"]


def test_host_recovery_skips_current_failed_and_wrong_profile_hosts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    devices = {
        "192.168.1.20": FakeDevice(SWITCH_STATUS),
        "192.168.1.30": FakeDevice(OSError("offline")),
        "192.168.1.40": FakeDevice(LIGHT_STATUS),
    }
    monkeypatch.setattr(
        bridge,
        "local_candidates",
        lambda _host: [
            "192.168.1.10",
            "192.168.1.20",
            "192.168.1.30",
            "192.168.1.40",
        ],
    )
    monkeypatch.setattr(bridge, "device_for", lambda _config, host: devices[host])
    recovered = bridge.recover_host(config())
    assert recovered == ("192.168.1.40", devices["192.168.1.40"], LIGHT_STATUS)
    assert devices["192.168.1.20"].closed is True
    assert devices["192.168.1.30"].closed is True
    assert devices["192.168.1.40"].closed is False


def test_input_reader_ignores_oversize_malformed_and_non_object_messages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    content = b"x" * (bridge.MAX_LINE_BYTES + 1) + b'\ninvalid\n[]\n{"type":"poll"}\n'
    stdin(monkeypatch, content)
    messages: queue.Queue[dict[str, Any] | None] = queue.Queue()
    bridge.input_reader(messages)
    assert messages.get_nowait() == {"type": "poll"}
    assert messages.get_nowait() is None


def test_worker_processes_absolute_commands_and_closes_on_eof(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    device = FakeDevice()
    feed_worker(
        monkeypatch,
        [
            {"type": "ignored"},
            {"type": "command", "requestId": "request", "command": {"power": False}},
            {"type": "poll"},
            None,
        ],
    )
    monkeypatch.setattr(bridge, "device_for", lambda *_args: device)
    bridge.worker(config(), 5.0)
    output = emitted(capsys)
    assert device.commands == [{"20": False}]
    assert [message["type"] for message in output] == [
        "snapshot",
        "command-result",
        "snapshot",
    ]
    assert output[1] == {"type": "command-result", "requestId": "request", "ok": True}
    assert device.closed is True


def test_worker_bounds_recovery_scans_and_adopts_a_verified_host(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    failed = [FakeDevice(OSError("offline local-key")) for _ in range(3)]
    recovered = FakeDevice(LIGHT_STATUS)
    feed_worker(monkeypatch, [{"type": "poll"}] * 3 + [None])
    monkeypatch.setattr(bridge, "device_for", lambda *_args: failed.pop(0))
    recoveries: list[str] = []

    def recover(value: dict[str, Any]) -> tuple[str, FakeDevice, dict[str, Any]]:
        recoveries.append(value["host"])
        return "192.168.1.50", recovered, LIGHT_STATUS

    monkeypatch.setattr(bridge, "recover_host", recover)
    bridge.worker(config(), 2.0)
    output = emitted(capsys)
    assert recoveries == ["192.168.1.10"]
    assert [message["type"] for message in output] == [
        "error",
        "error",
        "error",
        "host-change",
        "snapshot",
    ]
    assert output[0]["message"] == "offline [redacted]"
    assert output[3]["host"] == "192.168.1.50"
    assert recovered.closed is True


def test_worker_reports_command_rejection_without_success(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    device = FakeDevice(command_response={"Error": "rejected"})
    feed_worker(
        monkeypatch,
        [{"type": "command", "requestId": "r", "command": {"power": True}}, None],
    )
    monkeypatch.setattr(bridge, "device_for", lambda *_args: device)
    bridge.worker(config(), 2.0)
    assert emitted(capsys) == [
        {"type": "error", "requestId": "r", "message": "rejected"}
    ]


@pytest.mark.parametrize("mode", ["discover", "probe", "worker"])
def test_main_dispatches_modes(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    mode: str,
) -> None:
    monkeypatch.setattr(sys, "argv", ["tuya_bridge.py", f"--{mode}"])
    if mode == "discover":
        monkeypatch.setattr(bridge, "discover", lambda: [{"deviceId": "id"}])
    else:
        stdin(monkeypatch, (json.dumps(config()) + "\n").encode())
    if mode == "probe":
        monkeypatch.setattr(bridge, "probe", lambda _value: {"type": "verified"})
    if mode == "worker":
        called: list[float] = []
        monkeypatch.setattr(
            bridge, "worker", lambda _value, interval: called.append(interval)
        )
    assert bridge.main() == 0
    if mode == "worker":
        assert called == [5.0]
    else:
        assert emitted(capsys)[0]["type"] in {"discovery", "verified"}


def test_main_reports_fatal_errors_without_credentials(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(sys, "argv", ["tuya_bridge.py"])
    stdin(monkeypatch, (json.dumps(config()) + "\n").encode())
    assert bridge.main() == 1
    assert emitted(capsys) == [
        {"type": "fatal", "message": "Choose --discover, --probe, or --worker"}
    ]
