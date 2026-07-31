from __future__ import annotations

import pytest

from tuya_bridge import public_error, validated_config
from tuya_profiles import (
    LIGHT_PROFILE,
    METERED_OUTLET_PROFILE,
    command_datapoints,
    detect_profile,
    normalized_state,
)


def test_light_profile_normalizes_without_exposing_raw_datapoints() -> None:
    raw = {
        "dps": {
            "20": True,
            "21": "colour",
            "22": 650,
            "23": 500,
            "24": "007803e80320",
            "25": "opaque-scene",
        }
    }
    selected = detect_profile(raw)
    state = normalized_state(raw, selected["id"])
    assert selected["id"] == LIGHT_PROFILE
    assert state["power"] is True
    assert state["brightnessPercent"] == 65
    assert state["colorTemperatureKelvin"] == 4600
    assert state["color"] == {"hue": 120, "saturation": 100.0, "value": 80.0}
    assert "dps" not in state


def test_light_commands_are_absolute_and_bounded() -> None:
    assert command_datapoints(
        {
            "power": True,
            "brightnessPercent": 55,
            "colorTemperatureKelvin": 2700,
        },
        LIGHT_PROFILE,
    ) == {"20": True, "21": "white", "22": 550, "23": 0}
    assert command_datapoints(
        {"color": {"hue": 240, "saturation": 50, "value": 75}},
        LIGHT_PROFILE,
    ) == {"21": "colour", "24": "00f001f402ee"}
    with pytest.raises(ValueError):
        command_datapoints({"brightnessPercent": 0}, LIGHT_PROFILE)


def test_metered_outlet_uses_verified_scaling_without_inventing_energy() -> None:
    raw = {"dps": {"1": True, "18": 123, "19": 456, "20": 2301}}
    selected = detect_profile(raw)
    state = normalized_state(raw, selected["id"])
    assert selected["id"] == METERED_OUTLET_PROFILE
    assert state["currentAmps"] == 0.123
    assert state["powerWatts"] == 45.6
    assert state["voltageVolts"] == 230.1
    assert state["energyKwh"] is None
    assert selected["capabilities"]["measuredEnergy"] is False


def test_unknown_datapoints_are_rejected() -> None:
    with pytest.raises(ValueError, match="not supported safely"):
        detect_profile({"dps": {"7": 42}})


def test_bridge_errors_redact_credentials_and_device_identity() -> None:
    config = {"localKey": "private-local-key", "deviceId": "private-device-id"}
    message = public_error(
        OSError("private-device-id rejected private-local-key"),
        config,
    )
    assert message == "[redacted] rejected [redacted]"


def test_bridge_rejects_non_local_device_addresses() -> None:
    with pytest.raises(ValueError, match="local network"):
        validated_config({
            "host": "8.8.8.8",
            "deviceId": "device",
            "localKey": "key",
            "protocolVersion": "3.5",
        })
