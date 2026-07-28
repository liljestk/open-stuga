# ruff: noqa: F401
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
        Module=SimpleNamespace(
            Energy="Energy",
            ContactSensor="ContactSensor",
            TriggerLogs="TriggerLogs",
        ),
    ),
)
SPEC = importlib.util.spec_from_file_location("tp_link_bridge", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
bridge = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bridge
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
        count = (
            int(params["end_timestamp"]) - int(params["start_timestamp"])
        ) // interval_seconds
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
