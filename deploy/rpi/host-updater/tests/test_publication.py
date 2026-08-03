from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = (
    Path(__file__).resolve().parents[4] / "scripts" / "verify-host-tuf-publication.py"
)
SPEC = importlib.util.spec_from_file_location("stugu_verify_host_publication", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
publication = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publication)


def request() -> dict[str, object]:
    return {
        "schema": "stugu-tuf-target-request/v1",
        "targetPath": "channels/stable/stugu-rpi4-usb.raucb",
        "length": 1024,
        "hashes": {"sha256": "a" * 64},
        "custom": {
            "stugu": {
                "schema": "stugu-host-target/v1",
                "channel": "stable",
                "manifestSha256": "b" * 64,
                "product": "stugu-rpi4-usb",
                "layout": "stugu-gpt-ab-v2",
                "hostGeneration": 42,
                "version": "1.2.3",
                "bootSha256": "c" * 64,
                "rootSha256": "d" * 64,
            }
        },
    }


class PublicationRequestTests(unittest.TestCase):
    def load(self, value: object):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "request.json"
            path.write_text(json.dumps(value), encoding="utf-8")
            return publication.load_request(path)

    def test_valid_request_is_accepted(self) -> None:
        self.assertEqual(self.load(request())["length"], 1024)

    def test_request_cannot_exceed_on_device_bundle_limit(self) -> None:
        value = request()
        value["length"] = 4 * 1024**3 + 1
        with self.assertRaisesRegex(ValueError, "length"):
            self.load(value)

    def test_version_is_strict(self) -> None:
        value = request()
        value["custom"]["stugu"]["version"] = "latest"  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "routing"):
            self.load(value)

    def test_generation_must_be_json_safe(self) -> None:
        value = request()
        value["custom"]["stugu"]["hostGeneration"] = 2**53  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "routing"):
            self.load(value)

    def test_publication_versions_must_advance_from_previous_receipt(self) -> None:
        previous = {
            "targetPath": "channels/stable/stugu-rpi4-usb.raucb",
            "targetLength": 1024,
            "targetSha256": "a" * 64,
            "targetVersion": "1.2.3",
            "hostGeneration": 42,
            "manifestSha256": "b" * 64,
            "metadataVersions": {
                "root": 1,
                "timestamp": 7,
                "snapshot": 6,
                "targets": 4,
            },
            "targetRoleVersions": {"targets": 4},
        }
        publication.require_publication_progress(
            {"root": 1, "timestamp": 8, "snapshot": 7, "targets": 5},
            {"targets": 5},
            previous,
            request(),
        )
        with self.assertRaisesRegex(ValueError, "timestamp"):
            publication.require_publication_progress(
                {"root": 1, "timestamp": 7, "snapshot": 7, "targets": 5},
                {"targets": 5},
                previous,
                request(),
            )
        with self.assertRaisesRegex(ValueError, "signed role"):
            publication.require_publication_progress(
                {"root": 1, "timestamp": 8, "snapshot": 7, "targets": 4},
                {"targets": 4},
                previous,
                request(),
            )
        with self.assertRaisesRegex(ValueError, "signed role"):
            publication.require_publication_progress(
                {"root": 1, "timestamp": 8, "snapshot": 7, "targets": 5},
                {"replacement-role": 1},
                previous,
                request(),
            )

    def test_publication_history_requires_receipt_or_version_one_genesis(self) -> None:
        versions = {"root": 1, "timestamp": 1, "snapshot": 1, "targets": 1}
        with self.assertRaisesRegex(ValueError, "previous receipt"):
            publication.require_publication_progress(
                versions, {"targets": 1}, None, request()
            )
        publication.require_publication_progress(
            versions,
            {"targets": 1},
            None,
            request(),
            initial_publication=True,
        )
        versions["timestamp"] = 2
        with self.assertRaisesRegex(ValueError, "version 1"):
            publication.require_publication_progress(
                versions,
                {"targets": 1},
                None,
                request(),
                initial_publication=True,
            )

    def test_publication_generation_cannot_roll_back_or_equivocate(self) -> None:
        previous = {
            "targetPath": "channels/stable/stugu-rpi4-usb.raucb",
            "targetLength": 1024,
            "targetSha256": "a" * 64,
            "targetVersion": "1.2.3",
            "hostGeneration": 42,
            "manifestSha256": "b" * 64,
            "metadataVersions": {
                "root": 1,
                "timestamp": 7,
                "snapshot": 6,
                "targets": 4,
            },
            "targetRoleVersions": {"targets": 4},
        }
        rolled_back = request()
        rolled_back["custom"]["stugu"]["hostGeneration"] = 41  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "generation rolled back"):
            publication.require_publication_progress(
                {"root": 1, "timestamp": 8, "snapshot": 7, "targets": 5},
                {"targets": 5},
                previous,
                rolled_back,
            )
        equivocation = request()
        equivocation["custom"]["stugu"]["manifestSha256"] = "e" * 64  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "equivocates"):
            publication.require_publication_progress(
                {"root": 1, "timestamp": 8, "snapshot": 7, "targets": 5},
                {"targets": 5},
                previous,
                equivocation,
            )

    def test_receipt_binds_the_independently_verified_rauc_manifest(self) -> None:
        receipt = {
            "schema": publication.RECEIPT_SCHEMA,
            "verifiedAt": "2026-08-02T10:00:00Z",
            "immutableRootSha256": "1" * 64,
            "requestSha256": "2" * 64,
            "targetPath": "channels/stable/stugu-rpi4-usb.raucb",
            "targetLength": 1024,
            "targetSha256": "3" * 64,
            "targetChannel": "stable",
            "targetVersion": "1.2.3",
            "hostGeneration": 42,
            "manifestSha256": "4" * 64,
            "raucManifestHash": "5" * 64,
            "metadataVersions": {
                "root": 1,
                "timestamp": 7,
                "snapshot": 6,
                "targets": 4,
            },
            "targetRoleVersions": {"targets": 4},
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            path.write_text(json.dumps(receipt), encoding="utf-8")
            self.assertEqual(
                publication.load_receipt(path)["raucManifestHash"], "5" * 64
            )
            del receipt["raucManifestHash"]
            path.write_text(json.dumps(receipt), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "shape"):
                publication.load_receipt(path)

    def test_publication_root_chain_fails_when_version_33_exists(self) -> None:
        class Signed:
            def __init__(self, version: int) -> None:
                self.version = version

            def verify_delegate(self, *_: object) -> None:
                pass

        class Parsed:
            def __init__(self, version: int) -> None:
                self.signed = Signed(version)
                self.signed_bytes = b"signed"
                self.signatures = []

        class Parser:
            @staticmethod
            def from_bytes(data: bytes) -> Parsed:
                return Parsed(int(data.decode("ascii")))

        class MetadataType:
            @classmethod
            def __class_getitem__(cls, _: object):
                return Parser

        class Response:
            headers: dict[str, str] = {}

            def __init__(self, version: int) -> None:
                self.version = version

            def __enter__(self):
                return self

            def __exit__(self, *_: object) -> None:
                pass

            def read(self, _: int) -> bytes:
                return str(self.version).encode("ascii")

        def response(request_value, timeout: int):
            self.assertEqual(timeout, 20)
            version = int(request_value.full_url.rsplit("/", 1)[1].split(".", 1)[0])
            return Response(version)

        with (
            patch.object(publication.urllib.request, "urlopen", side_effect=response),
            patch.object(publication, "require_root_policy"),
            self.assertRaisesRegex(ValueError, "exceeds the verifier bound"),
        ):
            publication.extend_root_chain(
                b"1", "https://updates.example.test/metadata/", MetadataType, object
            )


if __name__ == "__main__":
    unittest.main()
