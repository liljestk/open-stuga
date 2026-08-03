"""Daemon entry point and stugu-host-update client."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import signal
import threading

from .config import UpdaterConfig
from .coordinator import Coordinator
from .protocol import UnixServer, call


DEFAULT_CONFIG = Path("/etc/stugu-host-update/config.json")
DEFAULT_SOCKET = Path("/run/stugu-host-update/updater.sock")


def daemon(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="stugu-host-updated")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    args = parser.parse_args(argv)
    config = UpdaterConfig.load(args.config)
    coordinator = Coordinator(config)
    with UnixServer(config.paths.socket, coordinator.handle) as server:

        def stop(*_: object) -> None:
            threading.Thread(target=server.shutdown, daemon=True).start()

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        server.serve_forever(poll_interval=0.5)
    return 0


def client(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="stugu-host-update")
    parser.add_argument("--socket", type=Path, default=DEFAULT_SOCKET)
    subparsers = parser.add_subparsers(dest="operation", required=True)
    for operation in (
        "status",
        "hardware-id",
        "cancel",
        "export-diagnostics",
        "reconcile",
    ):
        subparsers.add_parser(operation)
    for operation in ("check", "stage"):
        child = subparsers.add_parser(operation)
        child.add_argument("--channel", choices=("stable", "preview"), default="stable")
        if operation == "stage":
            child.add_argument("--repair", action="store_true")
    activate = subparsers.add_parser("activate")
    activate.add_argument("--confirm", action="store_true")
    args = parser.parse_args(argv)
    request: dict[str, object] = {
        "schema": "stugu-host-update-request/v1",
        "operation": args.operation,
    }
    if hasattr(args, "channel"):
        request["channel"] = args.channel
    if getattr(args, "repair", False):
        request["repair"] = True
    if getattr(args, "confirm", False):
        request["confirm"] = True
    timeout = {
        "stage": 65 * 60,
        "reconcile": 15 * 60,
        "activate": 120,
    }.get(args.operation, 65)
    response = call(args.socket, request, timeout=timeout)
    print(
        json.dumps(
            response.get("result") if response.get("ok") else response,
            indent=2,
            sort_keys=True,
        )
    )
    return 0 if response.get("ok") else 1
