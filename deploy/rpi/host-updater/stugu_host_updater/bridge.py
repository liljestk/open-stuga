"""Narrow file bridge from the application plane to the native host updater.

The bridge deliberately accepts only versioned, bounded intents.  It never
accepts paths, URLs, devices, RAUC arguments, recovery mode, or repair flags.
Only the native daemon owns TUF selection, qualification, block writes, boot
control, activation, and rollback.
"""

from __future__ import annotations

import argparse
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import re
import signal
import threading
import time
from typing import Callable
import uuid

from .config import UpdaterConfig
from .contracts import HEX_SHA256
from .durable import atomic_json, exclusive_lock, fsync_directory, read_json


BRIDGE_REQUEST_SCHEMA = "stugu-host-update-bridge-request/v1"
BRIDGE_STATUS_SCHEMA = "stugu-host-update-bridge-status/v1"
DEFAULT_CONFIG = Path("/etc/stugu-host-update/config.json")
DEFAULT_DIRECTORY = Path("/persistent/stugu/update-operations/host-bridge")
MAX_REQUEST_BYTES = 16 * 1024
HEARTBEAT_SECONDS = 30.0
POLL_SECONDS = 2.0
VERSION = "1.0.0"

_VERSION = re.compile(
    r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$"
)
_REQUEST_FILE = re.compile(
    r"^request-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.json$"
)
_STATUS_FIELDS = (
    "phase",
    "detail",
    "operationId",
    "intentId",
    "updatedAt",
    "channel",
    "targetVersion",
    "targetGeneration",
    "sourceGeneration",
    "targetSlot",
    "bytes",
    "bytesTotal",
    "bytesComplete",
    "trial",
    "manifestSha256",
    "errorCode",
    "rollbackReason",
    "journalPhase",
)


class BridgeContractError(ValueError):
    """A stable, sanitized bridge request failure."""


def _canonical_uuid(value: object, label: str) -> str:
    if not isinstance(value, str) or len(value) != 36:
        raise BridgeContractError(f"{label} must be a canonical UUID")
    try:
        canonical = str(uuid.UUID(value))
    except ValueError as error:
        raise BridgeContractError(f"{label} must be a canonical UUID") from error
    if canonical != value:
        raise BridgeContractError(f"{label} must be a canonical UUID")
    return value


def _requested_at(value: object) -> str:
    if not isinstance(value, str) or len(value) > 40 or not value.endswith("Z"):
        raise BridgeContractError("requestedAt must be a UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise BridgeContractError("requestedAt must be a UTC timestamp") from error
    if parsed.tzinfo != timezone.utc:
        raise BridgeContractError("requestedAt must be a UTC timestamp")
    return parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _generation(value: object, label: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 1 <= value <= 2**53 - 1
    ):
        raise BridgeContractError(f"{label} must be a positive bounded integer")
    return value


def _digest(value: object, label: str) -> str:
    if not isinstance(value, str) or not HEX_SHA256.fullmatch(value):
        raise BridgeContractError(f"{label} must be a lowercase SHA-256 digest")
    return value


@dataclass(frozen=True)
class BridgeRequest:
    id: str
    requested_at: str
    operation: str
    workflow_id: str | None = None
    expected_version: str | None = None
    expected_operation_id: str | None = None
    expected_generation: int | None = None
    expected_manifest_sha256: str | None = None

    @property
    def intent_id(self) -> str:
        return self.workflow_id or self.id

    def native_request(self) -> dict[str, object]:
        value: dict[str, object] = {
            "schema": "stugu-host-update-request/v1",
            "operation": self.operation,
            "intentId": self.intent_id,
        }
        if self.operation in {"check", "stage"}:
            value["channel"] = "stable"
        if self.operation == "stage":
            value.update(
                {
                    "expectedVersion": self.expected_version,
                    "expectedGeneration": self.expected_generation,
                    "expectedManifestSha256": self.expected_manifest_sha256,
                }
            )
        if self.operation in {"activate", "cancel"}:
            value.update(
                {
                    "expectedOperationId": self.expected_operation_id,
                    "expectedVersion": self.expected_version,
                    "expectedGeneration": self.expected_generation,
                    "expectedManifestSha256": self.expected_manifest_sha256,
                }
            )
        if self.operation == "activate":
            value["confirm"] = True
        return value


def validate_bridge_request(value: object, filename: str) -> BridgeRequest:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise BridgeContractError("request must be an object")
    common = {"schema", "id", "requestedAt", "operation"}
    operation = value.get("operation")
    expected = {
        "check": common,
        "stage": common
        | {
            "workflowId",
            "channel",
            "expectedVersion",
            "expectedGeneration",
            "expectedManifestSha256",
        },
        "activate": common
        | {
            "workflowId",
            "confirmation",
            "expectedOperationId",
            "expectedVersion",
            "expectedGeneration",
            "expectedManifestSha256",
        },
        "cancel": common
        | {
            "workflowId",
            "expectedOperationId",
            "expectedVersion",
            "expectedGeneration",
            "expectedManifestSha256",
        },
    }.get(operation)
    if (
        value.get("schema") != BRIDGE_REQUEST_SCHEMA
        or expected is None
        or set(value) != expected
    ):
        raise BridgeContractError(
            "request schema, operation, or fields are unsupported"
        )
    request_id = _canonical_uuid(value["id"], "id")
    match = _REQUEST_FILE.fullmatch(filename)
    if not match or match.group(1) != request_id:
        raise BridgeContractError("request filename does not match its id")
    requested_at = _requested_at(value["requestedAt"])
    if operation == "check":
        return BridgeRequest(request_id, requested_at, operation)
    workflow_id = _canonical_uuid(value["workflowId"], "workflowId")
    if operation == "stage":
        version = value["expectedVersion"]
        if not isinstance(version, str) or not _VERSION.fullmatch(version):
            raise BridgeContractError("expectedVersion is invalid")
        if value["channel"] != "stable":
            raise BridgeContractError("the web bridge supports only the stable channel")
        return BridgeRequest(
            request_id,
            requested_at,
            operation,
            workflow_id,
            version,
            expected_generation=_generation(
                value["expectedGeneration"], "expectedGeneration"
            ),
            expected_manifest_sha256=_digest(
                value["expectedManifestSha256"], "expectedManifestSha256"
            ),
        )
    if operation == "activate" and value["confirmation"] != "RESTART_AND_INSTALL":
        raise BridgeContractError(
            "activation requires RESTART_AND_INSTALL confirmation"
        )
    version = value["expectedVersion"]
    if not isinstance(version, str) or not _VERSION.fullmatch(version):
        raise BridgeContractError("expectedVersion is invalid")
    return BridgeRequest(
        request_id,
        requested_at,
        operation,
        workflow_id,
        version,
        expected_operation_id=_canonical_uuid(
            value["expectedOperationId"], "expectedOperationId"
        ),
        expected_generation=_generation(
            value["expectedGeneration"], "expectedGeneration"
        ),
        expected_manifest_sha256=_digest(
            value["expectedManifestSha256"], "expectedManifestSha256"
        ),
    )


@dataclass
class ActiveRequest:
    request: BridgeRequest
    path: Path
    future: Future[dict[str, object]] | None
    submitted: bool


Call = Callable[[Path, dict[str, object], int], dict[str, object]]


def call_native(
    socket_path: Path, request: dict[str, object], timeout: int
) -> dict[str, object]:
    # The native protocol imports Linux-only peer credential modules. Keep that
    # boundary lazy so the strict bridge contract remains portable to tests.
    from .protocol import call

    return call(socket_path, request, timeout)


class HostUpdateBridge:
    def __init__(
        self,
        config: UpdaterConfig,
        directory: Path = DEFAULT_DIRECTORY,
        *,
        call_impl: Call = call_native,
    ) -> None:
        self.config = config
        self.directory = directory
        self.requests = directory / "requests"
        self.status_directory = directory / "status"
        self.status_path = self.status_directory / "status.json"
        self.call = call_impl
        self.executor = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="host-update-bridge"
        )
        self.active: ActiveRequest | None = None
        self.last_payload: dict[str, object] | None = None
        self.last_write = 0.0
        self.requests.mkdir(parents=True, exist_ok=True)
        self.status_directory.mkdir(parents=True, exist_ok=True)

    def close(self) -> None:
        self.executor.shutdown(wait=False, cancel_futures=False)

    def _native_call(
        self, request: dict[str, object], timeout: int
    ) -> dict[str, object]:
        return self.call(self.config.paths.socket, request, timeout)

    def _native_status(self) -> tuple[dict[str, object] | None, dict[str, str] | None]:
        try:
            response = self._native_call(
                {"schema": "stugu-host-update-request/v1", "operation": "status"},
                10,
            )
        except Exception:
            return None, {
                "code": "HOST_UPDATER_OFFLINE",
                "message": "The native host updater is temporarily unavailable",
            }
        if response.get("ok") is not True or not isinstance(
            response.get("result"), dict
        ):
            error = (
                response.get("error") if isinstance(response.get("error"), dict) else {}
            )
            return None, {
                "code": str(error.get("code") or "HOST_UPDATER_OFFLINE")[:80],
                "message": str(
                    error.get("message") or "The native host updater is unavailable"
                )[:500],
            }
        return response["result"], None  # type: ignore[return-value]

    @staticmethod
    def _sanitized_native(native: dict[str, object] | None) -> dict[str, object]:
        if not native:
            return {}
        return {field: native[field] for field in _STATUS_FIELDS if field in native}

    def _publish(
        self,
        native: dict[str, object] | None,
        request: BridgeRequest | None = None,
        error: dict[str, str] | None = None,
    ) -> None:
        if (
            error is None
            and native
            and native.get("phase")
            in {
                "failed",
                "returned",
                "recovery-needed",
            }
        ):
            fallback = {
                "failed": "HOST_UPDATE_FAILED",
                "returned": "HOST_UPDATE_RETURNED",
                "recovery-needed": "HOST_RECOVERY_NEEDED",
            }[str(native["phase"])]
            raw_code = str(
                native.get("errorCode") or native.get("rollbackReason") or fallback
            )
            normalized_code = re.sub(r"[^A-Z0-9_]", "_", raw_code.upper())[:80]
            error = {
                "code": normalized_code or fallback,
                "message": str(
                    native.get("detail")
                    or "The native host update did not complete successfully"
                )[:500],
            }
        try:
            previous = self.last_payload or (
                read_json(self.status_path, maximum=MAX_REQUEST_BYTES)
                if self.status_path.exists()
                else None
            )
        except Exception:
            previous = None
        preserved: dict[str, object] = {}
        intent_id = native.get("intentId") if native else None
        if (
            isinstance(previous, dict)
            and intent_id is not None
            and previous.get("intentId") == intent_id
        ):
            for field in (
                "requestId",
                "workflowId",
                "requestOperation",
                "operationId",
                "targetVersion",
                "targetGeneration",
                "manifestSha256",
                "targetSlot",
            ):
                if field in previous:
                    preserved[field] = previous[field]
        payload: dict[str, object] = {
            "schema": BRIDGE_STATUS_SCHEMA,
            "bridgeVersion": VERSION,
            "available": native is not None,
            "currentGeneration": self.config.host_generation,
            "updatedAt": datetime.now(timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            **preserved,
            **self._sanitized_native(native),
            "error": error,
        }
        if request is not None:
            payload.update(
                {
                    "requestId": request.id,
                    "workflowId": request.workflow_id,
                    "requestOperation": request.operation,
                }
            )
        else:
            payload.setdefault("requestId", None)
            payload.setdefault("workflowId", None)
            payload.setdefault("requestOperation", None)
        comparable = {
            key: value for key, value in payload.items() if key != "updatedAt"
        }
        previous_comparable = (
            {
                key: value
                for key, value in self.last_payload.items()
                if key != "updatedAt"
            }
            if self.last_payload
            else None
        )
        monotonic = time.monotonic()
        if (
            comparable == previous_comparable
            and monotonic - self.last_write < HEARTBEAT_SECONDS
        ):
            return
        atomic_json(self.status_path, payload, mode=0o640)
        self.last_payload = payload
        self.last_write = monotonic

    def _remove(self, path: Path) -> None:
        path.unlink(missing_ok=True)
        fsync_directory(path.parent)

    def _oldest_request(self) -> tuple[BridgeRequest, Path] | None:
        candidates: list[tuple[str, str, BridgeRequest, Path]] = []
        for path in self.requests.glob("request-*.json"):
            if path.is_symlink() or not path.is_file():
                continue
            try:
                value = read_json(path, maximum=MAX_REQUEST_BYTES)
                request = validate_bridge_request(value, path.name)
                candidates.append((request.requested_at, request.id, request, path))
            except Exception as error:
                self._publish(
                    None,
                    error={
                        "code": "BRIDGE_REQUEST_INVALID",
                        "message": str(error)[:500],
                    },
                )
                self._remove(path)
        if candidates:
            _, _, request, path = min(candidates)
            return request, path
        return None

    @staticmethod
    def _matches(request: BridgeRequest, native: dict[str, object] | None) -> bool:
        return bool(native and native.get("intentId") == request.intent_id)

    @staticmethod
    def _accepted(request: BridgeRequest, phase: object) -> bool:
        accepted = {
            "check": {"available", "current"},
            "stage": {
                "ready-to-restart",
                "restarting",
                "verifying",
                "complete",
            },
            "activate": {
                "restarting",
                "verifying",
                "complete",
            },
            "cancel": {"cancelled"},
        }
        return phase in accepted[request.operation]

    def _start(self, request: BridgeRequest, path: Path) -> None:
        native, status_error = self._native_status()
        if status_error:
            self.active = ActiveRequest(request, path, None, False)
            self._publish(native, request, status_error)
            return
        active_phase = native.get("phase") if native else None
        if not self._matches(request, native) and active_phase in {
            "checking",
            "downloading",
            "installing",
            "ready-to-restart",
            "restarting",
            "verifying",
            "recovery-needed",
        }:
            stale = request.operation in {"activate", "cancel"}
            self._publish(
                native,
                error={
                    "code": "STALE_CONFIRMATION" if stale else "HOST_UPDATE_BUSY",
                    "message": (
                        "The staged host update changed; review it before continuing"
                        if stale
                        else "A host update already requires completion"
                    ),
                },
            )
            self._remove(path)
            return
        if self._matches(request, native):
            phase = native.get("phase") if native else None
            if self._accepted(request, phase):
                self._publish(native, request)
                self._remove(path)
                return
            if phase in {"checking", "downloading", "installing"}:
                self.active = ActiveRequest(request, path, None, True)
                self._publish(native, request)
                return
            if phase in {"failed", "returned", "recovery-needed"}:
                self._publish(
                    native,
                    request,
                    {
                        "code": str(native.get("errorCode") or "HOST_UPDATE_FAILED"),
                        "message": str(native.get("detail") or "Host update failed")[
                            :500
                        ],
                    },
                )
                self._remove(path)
                return
        timeout = {"stage": 65 * 60, "activate": 120}.get(request.operation, 65)
        future = self.executor.submit(
            self._native_call, request.native_request(), timeout
        )
        self.active = ActiveRequest(request, path, future, True)
        self._publish(native, request)

    def _finish_response(
        self,
        active: ActiveRequest,
        response: dict[str, object] | None,
        call_error: Exception | None,
    ) -> None:
        native, status_error = self._native_status()
        if (
            response
            and response.get("ok") is True
            and isinstance(response.get("result"), dict)
        ):
            native = response["result"]  # type: ignore[assignment]
            status_error = None
        if response and response.get("ok") is False:
            raw = (
                response.get("error") if isinstance(response.get("error"), dict) else {}
            )
            status_error = {
                "code": str(raw.get("code") or "HOST_UPDATE_FAILED")[:80],
                "message": str(raw.get("message") or "Host update failed")[:500],
            }
        if native and native.get("phase") in {"failed", "returned", "recovery-needed"}:
            status_error = {
                "code": str(
                    native.get("errorCode")
                    or native.get("rollbackReason")
                    or "HOST_UPDATE_FAILED"
                )[:80],
                "message": str(native.get("detail") or "Host update did not complete")[
                    :500
                ],
            }
        if call_error and not (
            self._matches(active.request, native)
            and self._accepted(active.request, native.get("phase") if native else None)
        ):
            # A reboot can cut the activation response. Keep the durable request
            # until the same intent is visible again after the host reconnects.
            self._publish(native, active.request, status_error)
            active.future = None
            active.submitted = True
            return
        self._publish(native, active.request, status_error)
        self._remove(active.path)
        self.active = None

    def tick(self) -> None:
        if self.active is None:
            pending = self._oldest_request()
            if pending:
                self._start(*pending)
            else:
                native, error = self._native_status()
                self._publish(native, error=error)
            return
        active = self.active
        if active.future is not None and active.future.done():
            try:
                response = active.future.result()
                call_error = None
            except Exception as error:
                response = None
                call_error = error
            self._finish_response(active, response, call_error)
            return
        native, error = self._native_status()
        if active.future is None and not active.submitted and native is not None:
            timeout = {"stage": 65 * 60, "activate": 120}.get(
                active.request.operation, 65
            )
            active.future = self.executor.submit(
                self._native_call, active.request.native_request(), timeout
            )
            active.submitted = True
            self._publish(native, active.request)
            return
        if active.future is None and self._matches(active.request, native):
            phase = native.get("phase") if native else None
            if self._accepted(active.request, phase) or phase in {
                "failed",
                "returned",
                "recovery-needed",
            }:
                terminal_error = error
                if phase in {"failed", "returned", "recovery-needed"}:
                    terminal_error = {
                        "code": str(
                            native.get("errorCode")
                            or native.get("rollbackReason")
                            or "HOST_UPDATE_FAILED"
                        )[:80],
                        "message": str(
                            native.get("detail") or "Host update did not complete"
                        )[:500],
                    }
                self._publish(native, active.request, terminal_error)
                self._remove(active.path)
                self.active = None
                return
        if (
            active.future is None
            and active.submitted
            and native is not None
            and not self._matches(active.request, native)
        ):
            # Socket is back but a durable in-flight request is no longer visible.
            self._publish(
                native,
                active.request,
                {
                    "code": "BRIDGE_RECOVERY_REQUIRED",
                    "message": "The host updater lost the queued intent; manual recovery is required",
                },
            )
            return
        self._publish(native, active.request, error)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="stugu-host-update-bridge")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--directory", type=Path, default=DEFAULT_DIRECTORY)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    config = UpdaterConfig.load(args.config)
    with exclusive_lock(args.directory / "status" / "bridge.lock"):
        bridge = HostUpdateBridge(config, args.directory)
        if args.once:
            try:
                bridge.tick()
            finally:
                bridge.close()
            return 0
        stopped = threading.Event()

        def stop(*_: object) -> None:
            stopped.set()

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        try:
            while not stopped.is_set():
                bridge.tick()
                stopped.wait(POLL_SECONDS)
        finally:
            bridge.close()
    return 0


if __name__ == "__main__":  # pragma: no cover - wrapper owns production entry
    raise SystemExit(main())
