"""Narrow compatibility support for TP-Link H500 hubs."""

from __future__ import annotations

from types import MethodType
from typing import Any


SUPPORTED_HUB_MODELS = frozenset({"H100", "H200", "H500"})


def normalized_device_model(device: Any) -> str:
    try:
        return str(device.model).upper().split("(", 1)[0].strip()
    except Exception:
        return ""


def is_supported_hub(device_or_model: Any) -> bool:
    model = (
        normalized_device_model(device_or_model)
        if not isinstance(device_or_model, str)
        else device_or_model.upper().split("(", 1)[0].strip()
    )
    return model in SUPPORTED_HUB_MODELS


def reported_child_count(device: Any) -> int | None:
    try:
        info = device.sys_info
    except Exception:
        return None
    candidates = [info]
    if isinstance(info, dict):
        candidates.extend(
            candidate
            for candidate in (
                info.get("basic_info"),
                info.get("device_info"),
            )
            if isinstance(candidate, dict)
        )
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        value = candidate.get("child_num")
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
    return None


def h500_child_enumeration_warning(device: Any, exposed_child_count: int) -> str | None:
    if normalized_device_model(device) != "H500":
        return None
    paired_count = reported_child_count(device)
    if paired_count is None or paired_count <= exposed_child_count:
        return None
    return (
        f"H500 connected, but its local API reports {paired_count} paired "
        f"device{'s' if paired_count != 1 else ''} and exposes "
        f"{exposed_child_count} to Stugu; only locally exposed devices are available."
    )


def install_h500_compatibility(device: Any) -> None:
    """Tolerate H500 child-list envelopes omitted by python-kasa 0.10.2.

    The patch is scoped to one H500 instance. It only handles malformed/empty
    list envelopes; normal child responses still use python-kasa unchanged.
    """
    if normalized_device_model(device) != "H500" or getattr(
        device, "_stugu_h500_compatibility", False
    ):
        return

    protocol = getattr(device, "protocol", None)
    original_list_handler = getattr(protocol, "_handle_response_lists", None)
    if callable(original_list_handler):

        async def safe_list_handler(
            _protocol: Any,
            response_result: Any,
            method: str,
            params: dict[str, Any] | None,
            retry_count: int,
        ) -> None:
            if (
                isinstance(response_result, dict)
                and "start_index" in response_result
                and response_result.get("sum") is not None
                and not any(
                    isinstance(value, list) for value in response_result.values()
                )
            ):
                return
            await original_list_handler(response_result, method, params, retry_count)

        protocol._handle_response_lists = MethodType(safe_list_handler, protocol)

    original_children_update = getattr(device, "_update_children_info", None)
    if callable(original_children_update):

        async def safe_children_update(_device: Any) -> bool:
            last_update = getattr(_device, "_last_update", {})
            child_info = None
            component_info = None
            if isinstance(last_update, dict):
                child_info = next(
                    (
                        last_update[key]
                        for key in ("get_child_device_list", "getChildDeviceList")
                        if key in last_update
                    ),
                    None,
                )
                component_info = next(
                    (
                        last_update[key]
                        for key in (
                            "get_child_device_component_list",
                            "getChildDeviceComponentList",
                        )
                        if key in last_update
                    ),
                    None,
                )
            if isinstance(child_info, dict) and (
                not isinstance(child_info.get("child_device_list"), list)
                or not isinstance(component_info, dict)
                or not isinstance(component_info.get("child_component_list"), list)
            ):
                return False
            if (
                isinstance(child_info, dict)
                and child_info.get("child_device_list") == []
                and (reported_child_count(_device) or 0) > 0
            ):
                return False
            return bool(await original_children_update())

        device._update_children_info = MethodType(safe_children_update, device)

    device._stugu_h500_compatibility = True
