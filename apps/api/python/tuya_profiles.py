"""Strict Tuya datapoint profiles used by Stugu's local bridge.

Unknown layouts are deliberately rejected. A wrong Tuya datapoint write can
change unrelated device settings, so support is added profile by profile.
"""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime
from typing import Any


LIGHT_PROFILE = "tuya-light-dp20-v1"
METERED_OUTLET_PROFILE = "tuya-outlet-dp1-meter-v1"
SWITCH_PROFILE = "tuya-switch-dp1-v1"


def _dps_map(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Tuya status did not contain datapoints")
    raw = value.get("dps", value)
    if not isinstance(raw, dict):
        raise ValueError("Tuya status did not contain datapoints")
    return {str(key): item for key, item in raw.items()}


def _capabilities(
    *,
    brightness: bool = False,
    color_temperature: bool = False,
    color: bool = False,
    measured_power: bool = False,
    measured_energy: bool = False,
) -> dict[str, bool]:
    return {
        "power": True,
        "brightness": brightness,
        "colorTemperature": color_temperature,
        "color": color,
        "measuredPower": measured_power,
        "measuredEnergy": measured_energy,
    }


def detect_profile(status: Any) -> dict[str, Any]:
    dps = _dps_map(status)
    if (
        isinstance(dps.get("20"), bool)
        and isinstance(dps.get("22"), (int, float))
        and not isinstance(dps.get("22"), bool)
        and isinstance(dps.get("23"), (int, float))
        and not isinstance(dps.get("23"), bool)
        and isinstance(dps.get("24"), str)
    ):
        return {
            "id": LIGHT_PROFILE,
            "kind": "light",
            "capabilities": _capabilities(
                brightness=True, color_temperature=True, color=True
            ),
        }
    if (
        isinstance(dps.get("1"), bool)
        and isinstance(dps.get("18"), (int, float))
        and not isinstance(dps.get("18"), bool)
        and isinstance(dps.get("19"), (int, float))
        and not isinstance(dps.get("19"), bool)
        and isinstance(dps.get("20"), (int, float))
        and not isinstance(dps.get("20"), bool)
    ):
        return {
            "id": METERED_OUTLET_PROFILE,
            "kind": "outlet",
            "capabilities": _capabilities(measured_power=True),
        }
    if isinstance(dps.get("1"), bool):
        return {
            "id": SWITCH_PROFILE,
            "kind": "switch",
            "capabilities": _capabilities(),
        }
    raise ValueError("This Tuya datapoint layout is not supported safely")


def profile(profile_id: str) -> dict[str, Any]:
    if profile_id == LIGHT_PROFILE:
        return {
            "id": LIGHT_PROFILE,
            "kind": "light",
            "capabilities": _capabilities(
                brightness=True, color_temperature=True, color=True
            ),
        }
    if profile_id == METERED_OUTLET_PROFILE:
        return {
            "id": METERED_OUTLET_PROFILE,
            "kind": "outlet",
            "capabilities": _capabilities(measured_power=True),
        }
    if profile_id == SWITCH_PROFILE:
        return {
            "id": SWITCH_PROFILE,
            "kind": "switch",
            "capabilities": _capabilities(),
        }
    raise ValueError("The configured Tuya profile is not supported")


def _number(value: Any, divisor: float = 1.0) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number):
        return None
    return round(number / divisor, 4)


def _light_color(value: Any) -> dict[str, float] | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if len(text) >= 12 and all(
        character in "0123456789abcdefABCDEF" for character in text[:12]
    ):
        hue = int(text[0:4], 16)
        saturation = int(text[4:8], 16) / 10
        brightness = int(text[8:12], 16) / 10
        if 0 <= hue <= 360 and 0 <= saturation <= 100 and 0 <= brightness <= 100:
            return {
                "hue": hue,
                "saturation": round(saturation, 1),
                "value": round(brightness, 1),
            }
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    try:
        hue = float(parsed["h"])
        saturation = float(parsed["s"]) / 10
        brightness = float(parsed["v"]) / 10
    except (KeyError, TypeError, ValueError):
        return None
    if 0 <= hue <= 360 and 0 <= saturation <= 100 and 0 <= brightness <= 100:
        return {
            "hue": round(hue, 1),
            "saturation": round(saturation, 1),
            "value": round(brightness, 1),
        }
    return None


def normalized_state(status: Any, profile_id: str) -> dict[str, Any]:
    dps = _dps_map(status)
    selected = profile(profile_id)
    state: dict[str, Any] = {
        "observedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "available": True,
        "power": None,
        "brightnessPercent": None,
        "colorTemperatureKelvin": None,
        "color": None,
        "workMode": None,
        "powerWatts": None,
        "energyKwh": None,
        "currentAmps": None,
        "voltageVolts": None,
    }
    if selected["id"] == LIGHT_PROFILE:
        state.update(
            {
                "power": dps.get("20") if isinstance(dps.get("20"), bool) else None,
                "brightnessPercent": (
                    max(1, min(100, round(float(dps["22"]) / 10)))
                    if _number(dps.get("22")) is not None
                    else None
                ),
                "colorTemperatureKelvin": (
                    round(2700 + max(0, min(1000, float(dps["23"]))) * 3.8)
                    if _number(dps.get("23")) is not None
                    else None
                ),
                "color": _light_color(dps.get("24")),
                "workMode": dps.get("21") if isinstance(dps.get("21"), str) else None,
            }
        )
    elif selected["id"] == METERED_OUTLET_PROFILE:
        state.update(
            {
                "power": dps.get("1") if isinstance(dps.get("1"), bool) else None,
                "currentAmps": _number(dps.get("18"), 1000),
                "powerWatts": _number(dps.get("19"), 10),
                "voltageVolts": _number(dps.get("20"), 10),
            }
        )
    else:
        state["power"] = dps.get("1") if isinstance(dps.get("1"), bool) else None
    return state


def _bounded_number(value: Any, minimum: float, maximum: float, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number")
    number = float(value)
    if not math.isfinite(number) or number < minimum or number > maximum:
        raise ValueError(f"{name} is outside its supported range")
    return number


def command_datapoints(command: Any, profile_id: str) -> dict[str, Any]:
    if not isinstance(command, dict) or not command:
        raise ValueError("The Tuya command is empty")
    allowed = {"power", "brightnessPercent", "colorTemperatureKelvin", "color"}
    if set(command) - allowed:
        raise ValueError("The Tuya command contains unsupported fields")
    selected = profile(profile_id)
    result: dict[str, Any] = {}
    power_dp = "20" if profile_id == LIGHT_PROFILE else "1"
    if "power" in command:
        if not isinstance(command["power"], bool):
            raise ValueError("power must be true or false")
        result[power_dp] = command["power"]
    if "brightnessPercent" in command:
        if not selected["capabilities"]["brightness"]:
            raise ValueError("This Tuya device does not support brightness")
        value = _bounded_number(
            command["brightnessPercent"], 1, 100, "brightnessPercent"
        )
        result.update({"21": "white", "22": max(10, min(1000, round(value * 10)))})
    if "colorTemperatureKelvin" in command:
        if not selected["capabilities"]["colorTemperature"]:
            raise ValueError("This Tuya device does not support colour temperature")
        value = _bounded_number(
            command["colorTemperatureKelvin"], 2700, 6500, "colorTemperatureKelvin"
        )
        result.update({"21": "white", "23": round((value - 2700) / 3.8)})
    if "color" in command:
        if not selected["capabilities"]["color"]:
            raise ValueError("This Tuya device does not support colour")
        color = command["color"]
        if not isinstance(color, dict) or set(color) != {"hue", "saturation", "value"}:
            raise ValueError("color must contain hue, saturation, and value")
        hue = round(_bounded_number(color["hue"], 0, 360, "color.hue"))
        saturation = round(
            _bounded_number(color["saturation"], 0, 100, "color.saturation") * 10
        )
        brightness = round(_bounded_number(color["value"], 1, 100, "color.value") * 10)
        result.update(
            {"21": "colour", "24": f"{hue:04x}{saturation:04x}{brightness:04x}"}
        )
    if not result:
        raise ValueError("The Tuya command did not contain a supported change")
    return result
