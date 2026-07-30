# ruff: noqa: E402, F401, F403, F405
"""Poll a local TP-Link hub or energy device and emit snapshots as NDJSON."""

from __future__ import annotations

import asyncio
import ipaddress
import inspect
import json
import math
import os
import sys
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

try:
    from kasa import Discover, Module
except ImportError:
    print(
        json.dumps({"type": "error", "message": "python-kasa is not installed"}),
        flush=True,
    )
    raise SystemExit(2)

from pathlib import Path
from types import ModuleType

_BRIDGE_DIRECTORY = str(Path(__file__).resolve().parent)
if _BRIDGE_DIRECTORY not in sys.path:
    sys.path.insert(0, _BRIDGE_DIRECTORY)

import tp_link_bridge_common as bridge_common
import tp_link_bridge_discovery as bridge_discovery
import tp_link_bridge_recovery as bridge_recovery
import tp_link_bridge_runtime as bridge_runtime
from tp_link_bridge_common import *
from tp_link_bridge_discovery import *
from tp_link_bridge_recovery import *
from tp_link_bridge_runtime import *


class _BridgeFacadeModule(ModuleType):
    """Keep replaceable bridge dependencies synchronized across domains."""

    def __setattr__(self, name: str, value: Any) -> None:
        super().__setattr__(name, value)
        for domain in (
            bridge_common,
            bridge_recovery,
            bridge_runtime,
            bridge_discovery,
        ):
            if hasattr(domain, name):
                setattr(domain, name, value)


sys.modules[__name__].__class__ = _BridgeFacadeModule


async def main() -> None:
    host = os.environ.get("TP_LINK_HOST", "").strip()
    username = os.environ.get("TP_LINK_USERNAME", "").strip()
    password = os.environ.get("TP_LINK_PASSWORD", "")
    if "--discover" in sys.argv[1:]:
        try:
            await discover_sources(username, password)
        except Exception as error:
            emit({"type": "error", "message": f"TP-Link discovery failed: {error}"})
            raise SystemExit(1)
        return

    if "--history" in sys.argv[1:]:
        request_id: str | None = None
        try:
            if not host or not username or not password:
                raise ValueError(
                    "TP_LINK_HOST, TP_LINK_USERNAME, and TP_LINK_PASSWORD are required"
                )
            request = read_history_request()
            request_id = request["requestId"]
            result = await recover_device_history(
                host,
                username,
                password,
                request["deviceId"],
                request["metric"],
                request["from"],
                request["to"],
                os.environ.get("TP_LINK_DEVICE_ID", "").strip() or None,
            )
            emit(
                {
                    "type": "history-result",
                    **({"requestId": request_id} if request_id is not None else {}),
                    **result,
                }
            )
        except ValueError as error:
            if isinstance(error, HistoryRequestError):
                request_id = error.request_id
            emit(
                {
                    "type": "error",
                    **({"requestId": request_id} if request_id is not None else {}),
                    "message": str(error),
                }
            )
            raise SystemExit(2)
        except Exception as error:
            emit(
                {
                    "type": "error",
                    **({"requestId": request_id} if request_id is not None else {}),
                    "message": f"TP-Link history recovery failed: {error}",
                }
            )
            raise SystemExit(1)
        return

    try:
        interval_ms = max(1000, int(os.environ.get("TP_LINK_POLL_INTERVAL_MS", "2000")))
    except ValueError:
        interval_ms = 2000
    try:
        contact_interval_ms = max(
            250, int(os.environ.get("TP_LINK_CONTACT_POLL_INTERVAL_MS", "500"))
        )
    except ValueError:
        contact_interval_ms = 500
    contact_events_enabled = os.environ.get(
        "TP_LINK_CONTACT_EVENTS_ENABLED", "1"
    ).strip().lower() not in {"0", "false", "no", "off"}
    if not host or not username or not password:
        emit(
            {
                "type": "error",
                "message": "TP_LINK_HOST, TP_LINK_USERNAME, and TP_LINK_PASSWORD are required",
            }
        )
        raise SystemExit(2)

    list_once = "--list" in sys.argv[1:]
    backoff_seconds = 1
    expected_device_id = os.environ.get("TP_LINK_DEVICE_ID", "").strip() or None
    connection_failures = 0
    last_recovery_scan = 0.0
    while True:

        def reset_backoff() -> None:
            nonlocal backoff_seconds, connection_failures
            backoff_seconds = 1
            connection_failures = 0

        def remember_identity(device_id: str) -> None:
            nonlocal expected_device_id
            expected_device_id = device_id

        try:
            await connect_and_poll(
                host,
                username,
                password,
                interval_ms / 1000,
                list_once,
                on_success=reset_backoff,
                expected_device_id=expected_device_id,
                on_identity=remember_identity,
                contact_interval_seconds=contact_interval_ms / 1000,
                contact_events_enabled=contact_events_enabled,
            )
            if list_once:
                return
        except asyncio.CancelledError:
            raise
        except Exception as error:
            emit({"type": "error", "message": f"TP-Link connection failed: {error}"})
            if list_once:
                raise SystemExit(1)
            connection_failures += 1
            now = time.monotonic()
            if connection_failures >= 2 and now - last_recovery_scan >= 300:
                last_recovery_scan = now
                recovered = await recover_source_host(
                    host, username, password, expected_device_id
                )
                if recovered is not None and recovered["host"] != host:
                    previous_host = host
                    host = recovered["host"]
                    expected_device_id = (
                        recovered["sourceDeviceId"] or expected_device_id
                    )
                    emit(
                        {
                            "type": "host-change",
                            "previousHost": previous_host,
                            "host": host,
                            "sourceDeviceId": expected_device_id,
                        }
                    )
                    backoff_seconds = 1
                    connection_failures = 0
                    continue
            await asyncio.sleep(backoff_seconds)
            backoff_seconds = min(60, backoff_seconds * 2)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
