from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import uuid

from stugu_host_updater.bridge import (
    BRIDGE_REQUEST_SCHEMA,
    BridgeContractError,
    HostUpdateBridge,
    validate_bridge_request,
)
from stugu_host_updater.durable import atomic_json, read_json


def request_id() -> str:
    return str(uuid.uuid4())


def request_path(directory: Path, value: dict[str, object]) -> Path:
    path = directory / "requests" / f"request-{value['id']}.json"
    atomic_json(path, value, mode=0o660)
    return path


def stage_request(*, identifier: str | None = None) -> dict[str, object]:
    return {
        "schema": BRIDGE_REQUEST_SCHEMA,
        "id": identifier or request_id(),
        "requestedAt": "2026-08-04T12:00:00.000Z",
        "operation": "stage",
        "workflowId": request_id(),
        "channel": "stable",
        "expectedVersion": "1.2.3",
        "expectedGeneration": 42,
        "expectedManifestSha256": "a" * 64,
    }


class BridgeContractTests(unittest.TestCase):
    def test_stage_intent_is_strict_and_forwards_no_privileged_selectors(self) -> None:
        value = stage_request()
        request = validate_bridge_request(value, f"request-{value['id']}.json")
        self.assertEqual(
            request.native_request(),
            {
                "schema": "stugu-host-update-request/v1",
                "operation": "stage",
                "intentId": value["workflowId"],
                "channel": "stable",
                "expectedVersion": "1.2.3",
                "expectedGeneration": 42,
                "expectedManifestSha256": "a" * 64,
            },
        )
        for field, bad in (
            ("url", "https://attacker.invalid"),
            ("path", "/tmp/payload"),
            ("device", "/dev/sda"),
            ("repair", True),
        ):
            with (
                self.subTest(field=field),
                self.assertRaisesRegex(BridgeContractError, "unsupported"),
            ):
                validate_bridge_request(
                    {**value, field: bad}, f"request-{value['id']}.json"
                )

    def test_activation_requires_literal_confirmation_and_exact_identity(self) -> None:
        identifier = request_id()
        value = {
            "schema": BRIDGE_REQUEST_SCHEMA,
            "id": identifier,
            "requestedAt": "2026-08-04T12:00:00.000Z",
            "operation": "activate",
            "workflowId": request_id(),
            "confirmation": "RESTART_AND_INSTALL",
            "expectedOperationId": request_id(),
            "expectedVersion": "1.2.3",
            "expectedGeneration": 42,
            "expectedManifestSha256": "a" * 64,
        }
        request = validate_bridge_request(value, f"request-{identifier}.json")
        self.assertTrue(request.native_request()["confirm"])
        self.assertEqual(request.native_request()["expectedVersion"], "1.2.3")
        with self.assertRaisesRegex(BridgeContractError, "confirmation"):
            validate_bridge_request(
                {**value, "confirmation": "yes"}, f"request-{identifier}.json"
            )


class BridgeLifecycleTests(unittest.TestCase):
    def test_terminal_native_failure_remains_visible_on_idle_heartbeats(self) -> None:
        operation_id = request_id()

        def native(_socket: Path, request: dict[str, object], _timeout: int):
            self.assertEqual(request["operation"], "status")
            return {
                "ok": True,
                "result": {
                    "phase": "recovery-needed",
                    "detail": "Inactive slot verification failed",
                    "operationId": operation_id,
                    "errorCode": "TRUST_VERIFICATION_FAILED",
                },
            }

        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            config = type(
                "Config",
                (),
                {
                    "host_generation": 41,
                    "paths": type("Paths", (), {"socket": Path("/run/updater.sock")})(),
                },
            )()
            bridge = HostUpdateBridge(config, directory, call_impl=native)
            try:
                bridge.tick()
                first = read_json(directory / "status" / "status.json")
                bridge.last_write = 0
                bridge.tick()
                second = read_json(directory / "status" / "status.json")
            finally:
                bridge.close()

        for status in (first, second):
            self.assertEqual(status["phase"], "recovery-needed")
            self.assertEqual(status["error"]["code"], "TRUST_VERIFICATION_FAILED")
            self.assertEqual(
                status["error"]["message"], "Inactive slot verification failed"
            )

    def test_check_cannot_mask_an_existing_staged_operation(self) -> None:
        staged_intent = request_id()
        calls: list[str] = []

        def native(_socket: Path, request: dict[str, object], _timeout: int):
            calls.append(str(request["operation"]))
            return {
                "ok": True,
                "result": {
                    "phase": "ready-to-restart",
                    "intentId": staged_intent,
                    "operationId": request_id(),
                },
            }

        value = {
            "schema": BRIDGE_REQUEST_SCHEMA,
            "id": request_id(),
            "requestedAt": "2026-08-04T12:00:00.000Z",
            "operation": "check",
        }
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            path = request_path(directory, value)
            config = type(
                "Config",
                (),
                {
                    "host_generation": 41,
                    "paths": type("Paths", (), {"socket": Path("/run/updater.sock")})(),
                },
            )()
            bridge = HostUpdateBridge(config, directory, call_impl=native)
            try:
                bridge.tick()
                status = read_json(directory / "status" / "status.json")
            finally:
                bridge.close()
            self.assertFalse(path.exists())
            self.assertEqual(calls, ["status"])
            self.assertEqual(status["phase"], "ready-to-restart")
            self.assertEqual(status["error"]["code"], "HOST_UPDATE_BUSY")

    def test_successful_stage_is_persisted_and_request_is_consumed(self) -> None:
        calls: list[dict[str, object]] = []

        def native(_socket: Path, request: dict[str, object], _timeout: int):
            calls.append(request)
            if request["operation"] == "status":
                return {
                    "ok": True,
                    "result": {"phase": "idle", "intentId": None},
                }
            return {
                "ok": True,
                "result": {
                    "phase": "ready-to-restart",
                    "intentId": request["intentId"],
                    "operationId": request_id(),
                    "targetVersion": "1.2.3",
                    "targetGeneration": 42,
                    "manifestSha256": "a" * 64,
                },
            }

        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            value = stage_request()
            path = request_path(directory, value)
            config = type(
                "Config",
                (),
                {
                    "host_generation": 41,
                    "paths": type("Paths", (), {"socket": Path("/run/updater.sock")})(),
                },
            )()
            bridge = HostUpdateBridge(config, directory, call_impl=native)
            try:
                bridge.tick()
                assert bridge.active and bridge.active.future
                bridge.active.future.result(timeout=2)
                bridge.tick()
                status = read_json(directory / "status" / "status.json")
            finally:
                bridge.close()
            self.assertFalse(path.exists())
            self.assertEqual(status["phase"], "ready-to-restart")
            self.assertEqual(status["workflowId"], value["workflowId"])
            forwarded = next(call for call in calls if call["operation"] == "stage")
            self.assertNotIn("path", forwarded)
            self.assertNotIn("device", forwarded)

    def test_lost_activation_response_recovers_from_matching_native_journal(
        self,
    ) -> None:
        state = {"activated": False}
        workflow_id = request_id()
        operation_id = request_id()

        def native(_socket: Path, request: dict[str, object], _timeout: int):
            if request["operation"] == "activate":
                state["activated"] = True
                raise ConnectionError("expected reboot")
            if state["activated"]:
                return {
                    "ok": True,
                    "result": {
                        "phase": "verifying",
                        "intentId": workflow_id,
                        "operationId": operation_id,
                        "targetVersion": "1.2.3",
                        "targetGeneration": 42,
                        "manifestSha256": "a" * 64,
                    },
                }
            return {
                "ok": True,
                "result": {
                    "phase": "ready-to-restart",
                    "intentId": workflow_id,
                    "operationId": operation_id,
                },
            }

        value = {
            "schema": BRIDGE_REQUEST_SCHEMA,
            "id": request_id(),
            "requestedAt": "2026-08-04T12:00:00.000Z",
            "operation": "activate",
            "workflowId": workflow_id,
            "confirmation": "RESTART_AND_INSTALL",
            "expectedOperationId": operation_id,
            "expectedVersion": "1.2.3",
            "expectedGeneration": 42,
            "expectedManifestSha256": "a" * 64,
        }
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            path = request_path(directory, value)
            config = type(
                "Config",
                (),
                {
                    "host_generation": 41,
                    "paths": type("Paths", (), {"socket": Path("/run/updater.sock")})(),
                },
            )()
            bridge = HostUpdateBridge(config, directory, call_impl=native)
            try:
                bridge.tick()
                assert bridge.active and bridge.active.future
                try:
                    bridge.active.future.result(timeout=2)
                except ConnectionError:
                    pass
                bridge.tick()
                bridge.tick()
                status = read_json(directory / "status" / "status.json")
            finally:
                bridge.close()
            self.assertFalse(path.exists())
            self.assertEqual(status["phase"], "verifying")
            self.assertEqual(status["workflowId"], workflow_id)
            self.assertIsNone(status["error"])

    def test_requests_are_processed_by_timestamp_not_random_filename(self) -> None:
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            newer = stage_request(identifier="00000000-0000-4000-8000-000000000001")
            older = stage_request(identifier="ffffffff-ffff-4fff-bfff-ffffffffffff")
            newer["requestedAt"] = "2026-08-04T12:01:00.000Z"
            older["requestedAt"] = "2026-08-04T12:00:00.000Z"
            request_path(directory, newer)
            request_path(directory, older)
            config = type(
                "Config",
                (),
                {
                    "host_generation": 41,
                    "paths": type("Paths", (), {"socket": Path("/run/updater.sock")})(),
                },
            )()
            bridge = HostUpdateBridge(config, directory, call_impl=lambda *_: {})
            try:
                selected = bridge._oldest_request()
            finally:
                bridge.close()
            self.assertIsNotNone(selected)
            self.assertEqual(selected[0].id, older["id"])


if __name__ == "__main__":
    unittest.main()
