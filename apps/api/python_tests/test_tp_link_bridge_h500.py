# ruff: noqa: F403, F405
from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path

from tp_link_bridge_test_support import *  # noqa: F403


class FakeH500Protocol:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []

    async def _handle_response_lists(self, *args: Any) -> None:
        self.calls.append(args)


class CompatibilityH500(FakeHub):
    def __init__(self) -> None:
        super().__init__("H500")
        self.protocol = FakeH500Protocol()
        self.sys_info["child_num"] = 3
        self.children = []
        self._last_update: dict[str, Any] = {}
        self.children_update_calls = 0

    async def update(self, *, update_children: bool) -> None:
        assert getattr(self, "_stugu_h500_compatibility", False)
        await super().update(update_children=update_children)

    async def _update_children_info(self) -> bool:
        self.children_update_calls += 1
        return True


def test_h500_compatibility_matches_the_pinned_python_kasa_contract() -> None:
    bridge_directory = Path(__file__).parents[1] / "python"
    script = textwrap.dedent(
        f"""
        import asyncio
        from importlib.metadata import version
        import sys
        from types import MethodType

        sys.path.insert(0, {str(bridge_directory)!r})
        from kasa import DeviceConfig
        from kasa.protocols.smartprotocol import SmartProtocol
        from kasa.smart.smartdevice import SmartDevice
        from kasa.transports.basetransport import BaseTransport
        from tp_link_bridge_h500 import install_h500_compatibility

        assert version("python-kasa") == "0.10.2"

        class DummyTransport(BaseTransport):
            @property
            def default_port(self):
                return 0

            @property
            def credentials_hash(self):
                return None

            async def send(self, request):
                return {{}}

            async def close(self):
                return None

            async def reset(self):
                return None

        def smart_device(model):
            protocol = SmartProtocol(
                transport=DummyTransport(config=DeviceConfig(host="192.0.2.50"))
            )
            device = SmartDevice("192.0.2.50", protocol=protocol)
            device._info = {{"device_model": model, "child_num": 2}}
            return device

        async def verify():
            device = smart_device("H500")
            install_h500_compatibility(device)
            await device.protocol._handle_response_lists(
                {{"start_index": 0, "sum": 0}}, "getChildDeviceList", {{}}, 3
            )
            await device.protocol._handle_response_lists(
                {{"child_device_list": [], "start_index": 0, "sum": 0}},
                "getChildDeviceList", {{}}, 3,
            )

            device._last_update = {{
                "get_child_device_list": {{"start_index": 0, "sum": 0}},
                "get_child_device_component_list": {{"start_index": 0, "sum": 0}},
            }}
            assert await device._update_children_info() is False

            calls = []
            async def create_delete(_device, child_info, component_info):
                calls.append((child_info, component_info))
                return True
            device._create_delete_children = MethodType(create_delete, device)
            device._info["child_num"] = 0
            device._last_update = {{
                "get_child_device_list": {{"child_device_list": []}},
                "get_child_device_component_list": {{"child_component_list": []}},
            }}
            assert await device._update_children_info() is True
            assert len(calls) == 1

            h200 = smart_device("H200")
            protocol_handler = h200.protocol._handle_response_lists.__func__
            children_handler = h200._update_children_info.__func__
            install_h500_compatibility(h200)
            assert h200.protocol._handle_response_lists.__func__ is protocol_handler
            assert h200._update_children_info.__func__ is children_handler
            assert not hasattr(h200, "_stugu_h500_compatibility")

        asyncio.run(verify())
        """
    )
    completed = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr


@pytest.mark.asyncio
async def test_h500_compatibility_tolerates_missing_child_list_envelopes() -> None:
    hub = CompatibilityH500()
    bridge.install_h500_compatibility(hub)

    await hub.protocol._handle_response_lists(
        {"start_index": 0, "sum": 0}, "getChildDeviceList", {}, 3
    )
    assert hub.protocol.calls == []

    valid = {"child_device_list": [], "start_index": 0, "sum": 0}
    await hub.protocol._handle_response_lists(valid, "getChildDeviceList", {}, 3)
    assert hub.protocol.calls == [(valid, "getChildDeviceList", {}, 3)]

    hub._last_update = {
        "get_child_device_list": {"start_index": 0, "sum": 0},
        "get_child_device_component_list": {"start_index": 0, "sum": 0},
    }
    assert await hub._update_children_info() is False
    assert hub.children_update_calls == 0

    hub.sys_info["child_num"] = 0
    hub._last_update = {
        "get_child_device_list": {"child_device_list": []},
        "get_child_device_component_list": {"child_component_list": []},
    }
    assert await hub._update_children_info() is True
    assert hub.children_update_calls == 1


def test_h500_warning_is_explicit_about_locally_hidden_children() -> None:
    hub = CompatibilityH500()

    assert bridge.h500_child_enumeration_warning(hub, 0) == (
        "H500 connected, but its local API reports 3 paired devices and exposes "
        "0 to Stugu; only locally exposed devices are available."
    )
    assert bridge.h500_child_enumeration_warning(FakeHub("H200"), 0) is None


@pytest.mark.asyncio
async def test_connect_and_poll_accepts_h500_and_reports_partial_enumeration(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    hub = CompatibilityH500()

    async def discover_single(*_args: Any, **_kwargs: Any) -> CompatibilityH500:
        return hub

    monkeypatch.setattr(
        bridge, "Discover", SimpleNamespace(discover_single=discover_single)
    )
    await bridge.connect_and_poll("192.0.2.50", "user", "password", 10, True)

    payload = emitted_lines(capsys)[0]
    assert payload["hubModel"] == "H500"
    assert payload["sourceType"] == "hub"
    assert payload["reportedChildCount"] == 3
    assert payload["devices"] == []
    assert "only locally exposed devices" in payload["warning"]


@pytest.mark.asyncio
async def test_h500_history_installs_compatibility_before_updating(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hub = CompatibilityH500()

    async def discover_single(*_args: Any, **_kwargs: Any) -> CompatibilityH500:
        return hub

    monkeypatch.setattr(
        bridge, "Discover", SimpleNamespace(discover_single=discover_single)
    )
    result = await bridge.recover_device_history(
        "192.0.2.50",
        "user",
        "password",
        "missing-child",
        "temperature",
        bridge.parse_history_timestamp("2025-07-19T11:45:00Z", "from"),
        bridge.parse_history_timestamp("2025-07-19T12:00:00Z", "to"),
    )

    assert result["state"] == "not-supported"
    assert hub.updated == [True]
    assert hub.disconnected
