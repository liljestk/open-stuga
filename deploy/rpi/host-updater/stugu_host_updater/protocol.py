"""Small versioned JSON-over-Unix-socket protocol."""

from __future__ import annotations

import grp
import json
import os
from pathlib import Path
import socket
import socketserver
from typing import Callable

from .contracts import canonical_json, validate_request
from .errors import ContractError, UpdaterError


MAX_REQUEST = 64 * 1024


class _Handler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        data = self.rfile.readline(MAX_REQUEST + 1)
        if len(data) > MAX_REQUEST or not data.endswith(b"\n"):
            self._send_error("REQUEST_TOO_LARGE", "Request exceeds the protocol limit")
            return
        try:
            value = json.loads(data.decode("utf-8"))
            request = validate_request(value)
            result = self.server.dispatch(request)  # type: ignore[attr-defined]
            response = {
                "schema": "stugu-host-update-response/v1",
                "ok": True,
                "result": result,
            }
        except UpdaterError as error:
            response = {
                "schema": "stugu-host-update-response/v1",
                "ok": False,
                "error": {"code": error.code, "message": str(error)[:500]},
            }
        except (UnicodeDecodeError, json.JSONDecodeError, ContractError) as error:
            code = error.code if isinstance(error, UpdaterError) else "CONTRACT_INVALID"
            response = {
                "schema": "stugu-host-update-response/v1",
                "ok": False,
                "error": {"code": code, "message": str(error)[:500]},
            }
        except Exception:
            response = {
                "schema": "stugu-host-update-response/v1",
                "ok": False,
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": "Host updater failed internally",
                },
            }
        self.wfile.write(canonical_json(response) + b"\n")

    def _send_error(self, code: str, message: str) -> None:
        self.wfile.write(
            canonical_json(
                {
                    "schema": "stugu-host-update-response/v1",
                    "ok": False,
                    "error": {"code": code, "message": message},
                }
            )
            + b"\n"
        )


class UnixServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True

    def __init__(
        self, path: Path, dispatch: Callable[[dict[str, object]], dict[str, object]]
    ) -> None:
        self.path = path
        self.dispatch = dispatch
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        path.unlink(missing_ok=True)
        super().__init__(str(path), _Handler)
        os.chmod(path, 0o660)
        try:
            os.chown(path, 0, grp.getgrnam("stugu").gr_gid)
        except KeyError:
            self.server_close()
            path.unlink(missing_ok=True)
            raise RuntimeError("stugu group is missing")

    def server_close(self) -> None:
        super().server_close()
        self.path.unlink(missing_ok=True)


def call(
    socket_path: Path, request: dict[str, object], timeout: int = 65
) -> dict[str, object]:
    data = canonical_json(request) + b"\n"
    if len(data) > MAX_REQUEST:
        raise ValueError("request is too large")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(timeout)
        client.connect(str(socket_path))
        client.sendall(data)
        chunks = bytearray()
        while not chunks.endswith(b"\n"):
            block = client.recv(8192)
            if not block:
                break
            chunks.extend(block)
            if len(chunks) > MAX_REQUEST:
                raise RuntimeError("updater response is too large")
    value = json.loads(chunks.decode("utf-8"))
    if (
        not isinstance(value, dict)
        or value.get("schema") != "stugu-host-update-response/v1"
    ):
        raise RuntimeError("updater response is invalid")
    return value
