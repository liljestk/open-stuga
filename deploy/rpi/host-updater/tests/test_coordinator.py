from __future__ import annotations

import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from stugu_host_updater.bootcontrol import BootRecord, SlotState
from stugu_host_updater.contracts import ReleaseManifest, TargetContract
from stugu_host_updater.coordinator import (
    accepted_metadata_state,
    accepted_target_state,
    Coordinator,
    fallback_record,
    require_metadata_progress,
    require_trial_record,
)
from stugu_host_updater.durable import TrustState
from stugu_host_updater.errors import TrustError
from stugu_host_updater.repository import VerifiedTarget

from .support import release_manifest


def target(versions: dict[str, int], roots: int = 2) -> VerifiedTarget:
    custom = TargetContract(
        "stable", "a" * 64, "product", "layout", 2, "1.0.0", "b" * 64, "c" * 64
    )
    return VerifiedTarget(
        "stable/bundle.raucb", 1, {"sha256": "d" * 64}, custom, versions, roots
    )


class MetadataAntiRollbackTests(unittest.TestCase):
    def test_cached_high_water_marks_survive_metadata_cache_loss(self) -> None:
        trust = TrustState(
            1, "e" * 64, 1, None, None, 0, {"timestamp": 9, "snapshot": 7}, 2
        )
        require_metadata_progress(target({"timestamp": 9, "snapshot": 8}), trust)
        with self.assertRaisesRegex(TrustError, "timestamp"):
            require_metadata_progress(target({"timestamp": 8, "snapshot": 8}), trust)
        with self.assertRaisesRegex(TrustError, "root chain"):
            require_metadata_progress(
                target({"timestamp": 9, "snapshot": 8}, roots=1), trust
            )

    def test_tuf_and_rauc_match_advances_all_durable_high_water_marks(self) -> None:
        trust = TrustState(1, "e" * 64, 1, "0" * 64, None, 100, {"timestamp": 9}, 1)
        candidate = target({"timestamp": 10, "snapshot": 8}, roots=2)
        accepted = accepted_target_state(candidate, trust, 200)
        self.assertEqual(accepted.highest_host_generation, 2)
        self.assertEqual(accepted.highest_manifest_sha256, "a" * 64)
        self.assertEqual(accepted.maximum_trusted_time, 200)
        self.assertEqual(accepted.metadata_versions, {"timestamp": 10, "snapshot": 8})
        self.assertEqual(accepted.root_chain_length, 2)

    def test_metadata_check_cannot_burn_a_host_generation_without_rauc(self) -> None:
        trust = TrustState(1, "e" * 64, 1, "0" * 64, None, 100, {"timestamp": 9}, 1)
        accepted = accepted_metadata_state(
            target({"timestamp": 10, "snapshot": 8}, roots=2), trust, 200
        )
        self.assertEqual(accepted.highest_host_generation, 1)
        self.assertEqual(accepted.highest_manifest_sha256, "0" * 64)
        self.assertEqual(accepted.maximum_trusted_time, 200)
        self.assertEqual(accepted.metadata_versions, {"timestamp": 10, "snapshot": 8})
        self.assertEqual(accepted.root_chain_length, 2)

    def test_same_generation_target_equivocation_is_rejected(self) -> None:
        trust = TrustState(1, "e" * 64, 2, "f" * 64, None, 100, {}, 1)
        with self.assertRaisesRegex(TrustError, "equivocates"):
            accepted_target_state(target({"timestamp": 1}), trust, 100)


class BootTrialStateTests(unittest.TestCase):
    def record(self, *, tries: int = 1, state: str = "pending") -> BootRecord:
        return BootRecord(
            sequence=10,
            disk_guid="9b9ba270-1dd2-4b49-9600-123456789abc",
            bootconfig_partuuid="11111111-2222-3333-4444-555555555555",
            committed="a" if state == "pending" else "b",
            pending="b" if state == "pending" else None,
            fallback="a",
            state=state,
            slots={
                "a": SlotState(41, "a" * 64, True, 3),
                "b": SlotState(42, "b" * 64, False, tries),
            },
        )

    def test_pending_and_probation_require_bootloader_consumed_attempts(self) -> None:
        require_trial_record(
            self.record(tries=1),
            source="a",
            target="b",
            generation=42,
            manifest_sha256="b" * 64,
            phase="pending",
            trial_count=0,
        )
        require_trial_record(
            self.record(tries=0),
            source="a",
            target="b",
            generation=42,
            manifest_sha256="b" * 64,
            phase="pending",
            trial_count=1,
        )
        require_trial_record(
            self.record(tries=2, state="probation"),
            source="a",
            target="b",
            generation=42,
            manifest_sha256="b" * 64,
            phase="probation",
            trial_count=2,
        )
        with self.assertRaisesRegex(TrustError, "account"):
            require_trial_record(
                self.record(tries=2),
                source="a",
                target="b",
                generation=42,
                manifest_sha256="b" * 64,
                phase="pending",
                trial_count=0,
            )

    def test_failed_candidate_record_returns_to_exact_source(self) -> None:
        returned = fallback_record(self.record(tries=0), "a", "b")
        self.assertEqual(returned.sequence, 11)
        self.assertEqual(returned.committed, "a")
        self.assertIsNone(returned.pending)
        self.assertEqual(returned.state, "fallback")
        self.assertTrue(returned.slots["a"].successful)
        self.assertFalse(returned.slots["b"].successful)
        self.assertEqual(returned.slots["b"].tries_remaining, 0)

    def test_staging_can_validate_records_without_claiming_hardware_qualification(
        self,
    ) -> None:
        record = BootRecord(
            sequence=10,
            disk_guid="9b9ba270-1dd2-4b49-9600-123456789abc",
            bootconfig_partuuid="11111111-2222-3333-4444-555555555555",
            committed="a",
            pending=None,
            fallback="b",
            state="successful",
            slots={
                "a": SlotState(41, "a" * 64, True, 3),
                "b": SlotState(41, "a" * 64, True, 3),
            },
        )

        class Store:
            required: bool | None = None

            def validate_disk(
                self, _disk: object, *, require_qualification: bool = True
            ):
                self.required = require_qualification
                return record, 0

        coordinator = Coordinator.__new__(Coordinator)
        coordinator.config = SimpleNamespace(host_generation=41)
        coordinator.boot_control = Store()
        coordinator._require_clean_boot_control(
            SimpleNamespace(active_slot="a"), require_qualification=False
        )
        self.assertIs(coordinator.boot_control.required, False)

    def test_activation_repeats_preflight_before_any_boot_control_write(self) -> None:
        manifest = ReleaseManifest.parse(release_manifest())
        disk = SimpleNamespace(active_slot="a", inactive_slot="b")
        record = self.record(tries=3)
        record = BootRecord(
            sequence=record.sequence,
            disk_guid=record.disk_guid,
            bootconfig_partuuid=record.bootconfig_partuuid,
            committed="a",
            pending=None,
            fallback="b",
            state="successful",
            slots={
                "a": SlotState(41, "a" * 64, True, 3),
                "b": SlotState(41, "a" * 64, True, 3),
            },
        )
        observed: dict[str, object] = {}

        class Preflight:
            def run(self, candidate, trust, *, bundle_length, repair=False):
                observed.update(
                    {
                        "manifest": candidate,
                        "trust": trust,
                        "bundleLength": bundle_length,
                        "repair": repair,
                    }
                )
                return SimpleNamespace(disk=disk)

        class BootControl:
            def write(self, pending, selected_disk):
                observed["record"] = pending
                observed["disk"] = selected_disk

        coordinator = Coordinator.__new__(Coordinator)
        coordinator.config = SimpleNamespace(
            paths=SimpleNamespace(
                lock=Path("/run/host.lock"), persistent_mount=Path("/persistent")
            )
        )
        coordinator.preflight = Preflight()
        coordinator.trust = SimpleNamespace(load=lambda: "trusted-state")
        coordinator.resolver = SimpleNamespace(
            resolve=lambda: self.fail("activation used a stale resolver result")
        )
        coordinator.boot_control = BootControl()
        coordinator.runner = SimpleNamespace(run=lambda *args, **kwargs: None)
        coordinator._mutation_lease = lambda: nullcontext()
        coordinator._require_journal_disk = lambda *_: None
        coordinator._require_clean_boot_control = lambda *_: record
        coordinator._write_journal = lambda journal, phase, **values: {
            **journal,
            **values,
            "phase": phase,
        }
        coordinator._status = lambda phase, detail, **values: {"phase": phase, **values}
        coordinator._journal = lambda: {
            "phase": "installed",
            "manifest": manifest.raw,
            "sourceSlot": "a",
            "targetSlot": "b",
            "operationId": "f6d11af3-a5de-4855-8be1-796bd8a725dd",
            "repair": True,
        }
        with patch(
            "stugu_host_updater.coordinator.exclusive_lock", lambda _: nullcontext()
        ):
            coordinator.activate(True)
        self.assertEqual(observed["manifest"].digest, manifest.digest)
        self.assertEqual(observed["trust"], "trusted-state")
        self.assertEqual(observed["bundleLength"], 0)
        self.assertIs(observed["repair"], True)
        self.assertIs(observed["disk"], disk)


if __name__ == "__main__":
    unittest.main()
