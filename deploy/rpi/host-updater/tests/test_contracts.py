from __future__ import annotations

import copy
import json
import unittest

from stugu_host_updater.contracts import (
    ReleaseManifest,
    TargetContract,
    canonical_json,
    validate_request,
)
from stugu_host_updater.errors import ContractError

from .support import release_manifest, target_custom


class ReleaseContractTests(unittest.TestCase):
    def test_valid_contract_is_strict_and_canonical(self) -> None:
        raw = release_manifest()
        manifest = ReleaseManifest.from_bytes(json.dumps(raw).encode())
        self.assertEqual(manifest.host_generation, 42)
        self.assertEqual(manifest.data.readable_epochs, (6, 7))
        self.assertEqual(len(manifest.digest), 64)
        self.assertEqual(
            manifest.digest, ReleaseManifest.from_bytes(canonical_json(raw)).digest
        )

    def test_unknown_field_is_rejected(self) -> None:
        raw = release_manifest()
        raw["downloadUrl"] = "https://attacker.invalid/bundle"
        with self.assertRaisesRegex(ContractError, "unknown fields"):
            ReleaseManifest.parse(raw)

    def test_updater_contract_order_and_payload_filename_aliases_are_rejected(
        self,
    ) -> None:
        raw = release_manifest()
        raw["updater"]["resultContract"] = 3  # type: ignore[index]
        with self.assertRaisesRegex(ContractError, "cannot be below"):
            ReleaseManifest.parse(raw)
        raw = release_manifest()
        raw["supplyChain"]["sbomFile"] = "stugu-release-manifest-v1.json"  # type: ignore[index]
        with self.assertRaisesRegex(ContractError, "filenames must be distinct"):
            ReleaseManifest.parse(raw)

    def test_artifact_sizes_and_lowercase_hashes_are_required(self) -> None:
        raw = release_manifest()
        raw["artifacts"]["rootSha256"] = "B" * 64  # type: ignore[index]
        with self.assertRaisesRegex(ContractError, "lowercase SHA-256"):
            ReleaseManifest.parse(raw)
        raw = release_manifest()
        raw["artifacts"]["bootSize"] = 0  # type: ignore[index]
        with self.assertRaisesRegex(ContractError, "between"):
            ReleaseManifest.parse(raw)

    def test_data_epoch_contract_is_internally_consistent(self) -> None:
        raw = release_manifest()
        raw["data"]["writableEpoch"] = 6  # type: ignore[index]
        with self.assertRaisesRegex(ContractError, "equal writableEpoch"):
            ReleaseManifest.parse(raw)
        manifest = ReleaseManifest.parse(release_manifest())
        self.assertTrue(manifest.data.permits_automatic_from(6))
        self.assertFalse(manifest.data.permits_automatic_from(5))
        self.assertFalse(
            ReleaseManifest.parse(
                release_manifest(rollback="restore-required")
            ).data.permits_automatic_from(6)
        )

    def test_tuf_custom_metadata_must_match_signed_inner_manifest(self) -> None:
        manifest = ReleaseManifest.parse(release_manifest())
        target = TargetContract.parse(target_custom(manifest))
        target.require_matches(manifest, "stable")
        mismatched = copy.deepcopy(target_custom(manifest))
        mismatched["stugu"]["rootSha256"] = "d" * 64  # type: ignore[index]
        with self.assertRaisesRegex(ContractError, "does not match"):
            TargetContract.parse(mismatched).require_matches(manifest, "stable")

    def test_daemon_request_does_not_accept_paths_urls_or_devices(self) -> None:
        self.assertEqual(
            validate_request(
                {"schema": "stugu-host-update-request/v1", "operation": "stage"}
            ),
            {
                "schema": "stugu-host-update-request/v1",
                "operation": "stage",
                "channel": "stable",
            },
        )
        for field, value in (
            ("target", "other.raucb"),
            ("url", "https://attacker.invalid"),
            ("device", "/dev/sda4"),
            ("command", "sh"),
        ):
            with (
                self.subTest(field=field),
                self.assertRaisesRegex(ContractError, "unknown fields"),
            ):
                validate_request(
                    {
                        "schema": "stugu-host-update-request/v1",
                        "operation": "stage",
                        field: value,
                    }
                )

    def test_activation_confirmation_is_boolean(self) -> None:
        with self.assertRaisesRegex(ContractError, "must be boolean"):
            validate_request(
                {
                    "schema": "stugu-host-update-request/v1",
                    "operation": "activate",
                    "confirm": "yes",
                }
            )

    def test_hardware_id_is_a_parameterless_read_only_request(self) -> None:
        self.assertEqual(
            validate_request(
                {
                    "schema": "stugu-host-update-request/v1",
                    "operation": "hardware-id",
                }
            ),
            {
                "schema": "stugu-host-update-request/v1",
                "operation": "hardware-id",
            },
        )

    def test_operation_specific_flags_are_rejected_elsewhere(self) -> None:
        for operation, field in (("status", "confirm"), ("activate", "repair")):
            with (
                self.subTest(operation=operation, field=field),
                self.assertRaisesRegex(ContractError, "valid only"),
            ):
                validate_request(
                    {
                        "schema": "stugu-host-update-request/v1",
                        "operation": operation,
                        field: True,
                    }
                )


if __name__ == "__main__":
    unittest.main()
