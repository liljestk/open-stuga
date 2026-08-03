from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from stugu_host_updater.contracts import canonical_json
from stugu_host_updater.durable import (
    RedundantTrustStore,
    _refresh_lease_heartbeat,
    exclusive_file_lease,
    read_json,
)
from stugu_host_updater.errors import ContractError, TrustError, UpdaterError


class TrustStoreTests(unittest.TestCase):
    def test_json_reader_rejects_oversized_and_non_regular_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            oversized = root / "oversized.json"
            oversized.write_bytes(b" " * 65)
            with self.assertRaisesRegex(ContractError, "oversized"):
                read_json(oversized, maximum=64)
            with self.assertRaisesRegex(ContractError, "regular file"):
                read_json(root, maximum=64)

    def test_highest_valid_redundant_copy_wins(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = RedundantTrustStore(Path(directory), b"immutable root v1")
            initial = store.load()
            first = initial.next(
                highest_host_generation=41, highest_manifest_sha256="a" * 64
            )
            store.write(first)
            second = first.next(
                highest_host_generation=42,
                highest_manifest_sha256="b" * 64,
                fallback_host_generation=41,
            )
            store.write(second)
            self.assertEqual(store.load(), second)
            # Simulate a torn newest copy: the prior checksummed copy remains valid.
            (Path(directory) / "trust-state.0.json").write_text("{", encoding="utf-8")
            self.assertEqual(store.load(), first)

    def test_both_corrupt_copies_require_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = RedundantTrustStore(Path(directory), b"immutable root v1")
            initial = store.load()
            store.write(initial.next(highest_host_generation=1))
            (Path(directory) / "trust-state.0.json").write_text("{}", encoding="utf-8")
            (Path(directory) / "trust-state.1.json").write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(TrustError, "Both persistent"):
                store.load()

    def test_same_sequence_divergent_trust_copies_require_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = RedundantTrustStore(Path(directory), b"immutable root v1")
            first = store.load().next(
                highest_host_generation=41, highest_manifest_sha256="a" * 64
            )
            store.write(first)
            payload = first.to_payload()
            payload["highestManifestSha256"] = "b" * 64
            envelope = {
                "payload": payload,
                "sha256": hashlib.sha256(canonical_json(payload)).hexdigest(),
            }
            (Path(directory) / "trust-state.0.json").write_text(
                json.dumps(envelope), encoding="utf-8"
            )
            with self.assertRaisesRegex(TrustError, "conflict"):
                store.load()

    def test_state_cannot_be_reanchored_to_another_factory_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            first = RedundantTrustStore(Path(directory), b"root one")
            first.write(first.load().next(highest_host_generation=1))
            second = RedundantTrustStore(Path(directory), b"root two")
            with self.assertRaisesRegex(TrustError, "different immutable root"):
                second.load()

    def test_high_water_marks_cannot_move_backwards_or_equivocate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = RedundantTrustStore(Path(directory), b"immutable root v1")
            first = store.load().next(
                highest_host_generation=42,
                highest_manifest_sha256="a" * 64,
                maximum_trusted_time=200,
                metadata_versions={"timestamp": 9},
                root_chain_length=2,
            )
            store.write(first)
            invalid = (
                first.next(highest_host_generation=41),
                first.next(highest_manifest_sha256="b" * 64),
                first.next(maximum_trusted_time=199),
                first.next(metadata_versions={"timestamp": 8}),
                first.next(root_chain_length=1),
            )
            for state in invalid:
                with self.subTest(state=state), self.assertRaises(TrustError):
                    store.write(state)


class CrossOperationLeaseTests(unittest.TestCase):
    def test_heartbeat_uses_the_owned_descriptor_or_safe_windows_interlock(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "agent.lock"
            path.write_text("lease", encoding="ascii")
            with path.open("r+b") as lease:
                self.assertTrue(_refresh_lease_heartbeat(lease.fileno(), path))

    def test_file_lease_is_exclusive_and_removes_only_its_own_lock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "agent.lock"
            with exclusive_file_lease(path, heartbeat_seconds=0.01):
                self.assertTrue(path.exists())
                self.assertRegex(
                    path.read_text(encoding="ascii"),
                    r"^stugu-mutation-lock/v1 host-updater (?:unknown|[0-9a-f-]+) [0-9]+$",
                )
                with self.assertRaisesRegex(UpdaterError, "mutation is active"):
                    with exclusive_file_lease(path, heartbeat_seconds=0.01):
                        pass
            self.assertFalse(path.exists())

    def test_lease_from_a_previous_boot_is_reclaimed_without_waiting(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "agent.lock"
            path.write_text(
                "stugu-mutation-lock/v1 container-updater "
                "11111111-1111-4111-8111-111111111111 7\n",
                encoding="ascii",
            )
            with patch(
                "stugu_host_updater.durable._boot_id",
                return_value="22222222-2222-4222-8222-222222222222",
            ):
                with exclusive_file_lease(path, heartbeat_seconds=0.01):
                    self.assertIn(
                        "22222222-2222-4222-8222-222222222222", path.read_text("ascii")
                    )

    def test_malformed_boot_identity_cannot_trigger_immediate_reclaim(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "agent.lock"
            path.write_text(
                "stugu-mutation-lock/v1 container-updater deadbeef 7\n",
                encoding="ascii",
            )
            with (
                patch(
                    "stugu_host_updater.durable._boot_id",
                    return_value="22222222-2222-4222-8222-222222222222",
                ),
                self.assertRaisesRegex(UpdaterError, "mutation is active"),
            ):
                with exclusive_file_lease(path, heartbeat_seconds=0.01):
                    pass


if __name__ == "__main__":
    unittest.main()
