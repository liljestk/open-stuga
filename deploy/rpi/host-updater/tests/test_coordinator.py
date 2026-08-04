from __future__ import annotations

import unittest
from contextlib import nullcontext
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from stugu_host_updater.bootcontrol import BootRecord, SlotState
from stugu_host_updater.boottransitions import (
    BootTransition,
    pending_record,
    probation_record,
)
from stugu_host_updater.contracts import ReleaseManifest, TargetContract
from stugu_host_updater.coordinator import (
    accepted_metadata_state,
    accepted_target_state,
    Coordinator,
    fallback_record,
    require_metadata_progress,
    require_trial_record,
)
from stugu_host_updater.durable import TrustState, atomic_json, read_json
from stugu_host_updater.errors import TrustError, UpdaterError
from stugu_host_updater.hostjournal import require_expected_staged_identity
from stugu_host_updater.rauc import InspectedBundle
from stugu_host_updater.repository import VerifiedTarget

from .support import release_manifest


def health_evidence() -> dict[str, str]:
    return {
        "slot": "passed",
        "generation": "passed",
        "root": "passed",
        "persistent": "passed",
        "bootconfig": "passed",
        "clock": "passed",
        "watchdog": "passed",
        "containerRuntime": "passed",
        "containers": "passed",
        "sqlite": "passed",
        "tailscale": "passed",
        "application": "passed",
    }


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

    def clean_record(self) -> BootRecord:
        return BootRecord(
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

    def journal(
        self,
        phase: str,
        *,
        trial_count: int,
        transition: BootTransition | None = None,
        health: dict[str, str] | None = None,
    ) -> dict[str, object]:
        manifest = ReleaseManifest.parse(release_manifest())
        value: dict[str, object] = {
            "phase": phase,
            "manifest": manifest.raw,
            "manifestSha256": manifest.digest,
            "sourceSlot": "a",
            "targetSlot": "b",
            "sourceGeneration": 41,
            "sourceManifestSha256": "a" * 64,
            "targetGeneration": manifest.host_generation,
            "operationId": "f6d11af3-a5de-4855-8be1-796bd8a725dd",
            "intentId": "b9aed8c9-36e7-46be-9dbd-1741ec955eb0",
            "trialCount": trial_count,
            "repair": False,
        }
        if transition is not None:
            value["bootTransition"] = transition.json()
        if health is not None:
            value["health"] = health
        return value

    def coordinator_fixture(
        self,
        journal: dict[str, object],
        record: BootRecord,
        *,
        active_slot: str,
        fail_phase: str | None = None,
    ):
        disk = SimpleNamespace(
            active_slot=active_slot,
            inactive_slot="a" if active_slot == "b" else "b",
        )
        state: dict[str, object] = {"journal": journal, "record": record}
        events: list[tuple[str, object]] = []
        fault = {"armed": fail_phase is not None}

        def write_journal(current, phase, **values):
            events.append(("journal", phase))
            if fault["armed"] and phase == fail_phase:
                fault["armed"] = False
                raise OSError(f"fault before {phase} journal commit")
            updated = {**current, **values, "phase": phase}
            state["journal"] = updated
            return updated

        class BootControl:
            def validate_disk(self, _disk, **_kwargs):
                return state["record"], 0

            def write(self, updated, _disk):
                events.append(("boot", updated.state))
                state["record"] = updated

        def health(*_args):
            events.append(("health", active_slot))
            return SimpleNamespace(checks=health_evidence())

        coordinator = Coordinator.__new__(Coordinator)
        coordinator.config = SimpleNamespace(paths=SimpleNamespace(lock=Path("/lock")))
        coordinator._mutation_lease = lambda: nullcontext()
        coordinator._journal = lambda: state["journal"]
        coordinator._write_journal = write_journal
        coordinator._require_journal_disk = lambda *_args: None
        coordinator._require_clean_boot_control = lambda *_args, **_kwargs: state[
            "record"
        ]
        coordinator.resolver = SimpleNamespace(resolve=lambda: disk)
        coordinator.boot_control = BootControl()
        coordinator.health = SimpleNamespace(run=health)
        coordinator.trust = SimpleNamespace(
            load=lambda: SimpleNamespace(maximum_trusted_time=0)
        )
        coordinator.runner = SimpleNamespace(
            run=lambda command, **_kwargs: events.append(("run", tuple(command)))
        )
        coordinator._status = lambda phase, _detail, **values: {
            "phase": phase,
            **values,
        }
        coordinator.status = lambda: {"phase": state["journal"]["phase"]}
        return coordinator, state, events, disk

    def test_hardware_id_reports_the_firmware_selected_disk(self) -> None:
        disk = SimpleNamespace(path=Path("/dev/sda"), active_slot="a")
        coordinator = Coordinator.__new__(Coordinator)
        coordinator.resolver = SimpleNamespace(resolve=lambda: disk)
        with patch(
            "stugu_host_updater.coordinator.hardware_fingerprint",
            return_value="sha256:" + "a" * 64,
        ) as fingerprint:
            result = coordinator.hardware_id()
        fingerprint.assert_called_once_with(disk)
        self.assertEqual(
            result,
            {
                "schema": "stugu-host-hardware-id/v1",
                "fingerprint": "sha256:" + "a" * 64,
                "bootDisk": str(Path("/dev/sda")),
                "activeSlot": "a",
            },
        )

    def test_pending_and_probation_require_bootloader_consumed_attempts(self) -> None:
        require_trial_record(
            self.record(tries=1),
            source="a",
            target="b",
            source_generation=41,
            source_manifest_sha256="a" * 64,
            generation=42,
            manifest_sha256="b" * 64,
            phase="pending",
            trial_count=0,
        )
        require_trial_record(
            self.record(tries=0),
            source="a",
            target="b",
            source_generation=41,
            source_manifest_sha256="a" * 64,
            generation=42,
            manifest_sha256="b" * 64,
            phase="pending",
            trial_count=1,
        )
        require_trial_record(
            self.record(tries=2, state="probation"),
            source="a",
            target="b",
            source_generation=41,
            source_manifest_sha256="a" * 64,
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
                source_generation=41,
                source_manifest_sha256="a" * 64,
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
        coordinator._require_clean_boot_control = lambda *_, **__: record
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
            "sourceManifestSha256": "a" * 64,
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

    def test_activation_intent_precedes_boot_write_and_survives_journal_fault(
        self,
    ) -> None:
        journal = self.journal("installed", trial_count=0)
        coordinator, state, events, disk = self.coordinator_fixture(
            journal, self.clean_record(), active_slot="a", fail_phase="pending"
        )
        coordinator.preflight = SimpleNamespace(
            run=lambda *_args, **_kwargs: SimpleNamespace(disk=disk)
        )
        with (
            patch(
                "stugu_host_updater.coordinator.exclusive_lock",
                lambda _: nullcontext(),
            ),
            self.assertRaisesRegex(OSError, "pending journal"),
        ):
            coordinator.activate(True)
        self.assertEqual(
            events[:3],
            [
                ("journal", "activation-intent"),
                ("boot", "pending"),
                ("journal", "pending"),
            ],
        )
        self.assertEqual(state["journal"]["phase"], "activation-intent")
        transition = BootTransition.parse(state["journal"]["bootTransition"])
        self.assertTrue(transition.matches_to(state["record"]))

    def test_probation_intent_recovers_exact_write_without_skipping_a_boot(
        self,
    ) -> None:
        manifest = ReleaseManifest.parse(release_manifest())
        pending = pending_record(
            self.clean_record(),
            source="a",
            target="b",
            generation=manifest.host_generation,
            manifest_sha256=manifest.digest,
        )
        pending = replace(
            pending,
            sequence=pending.sequence + 2,
            slots={
                **pending.slots,
                "b": replace(pending.slots["b"], tries_remaining=0),
            },
        )
        coordinator, state, events, _ = self.coordinator_fixture(
            self.journal("pending", trial_count=1),
            pending,
            active_slot="b",
            fail_phase="probation",
        )
        with (
            patch(
                "stugu_host_updater.coordinator.exclusive_lock",
                lambda _: nullcontext(),
            ),
            self.assertRaisesRegex(OSError, "probation journal"),
        ):
            coordinator.reconcile()
        self.assertEqual(
            events[:4],
            [
                ("health", "b"),
                ("journal", "probation-intent"),
                ("boot", "probation"),
                ("journal", "probation"),
            ],
        )
        self.assertEqual(state["journal"]["phase"], "probation-intent")

        resumed, resumed_state, resumed_events, _ = self.coordinator_fixture(
            state["journal"], state["record"], active_slot="b"
        )
        with patch(
            "stugu_host_updater.coordinator.exclusive_lock", lambda _: nullcontext()
        ):
            resumed.reconcile()
        self.assertEqual(resumed_state["journal"]["phase"], "probation")
        self.assertNotIn(("health", "b"), resumed_events)
        self.assertNotIn(("boot", "fallback"), resumed_events)
        self.assertIn(("run", ("systemctl", "reboot")), resumed_events)

    def test_activation_intent_rejects_nonselector_boot_record_mutation(self) -> None:
        manifest = ReleaseManifest.parse(release_manifest())
        pending = pending_record(
            self.clean_record(),
            source="a",
            target="b",
            generation=manifest.host_generation,
            manifest_sha256=manifest.digest,
        )
        transition = BootTransition.create("activate", self.clean_record(), pending)
        consumed_and_mutated = replace(
            pending,
            sequence=pending.sequence + 1,
            slots={
                "a": replace(pending.slots["a"], tries_remaining=2),
                "b": replace(pending.slots["b"], tries_remaining=1),
            },
        )
        coordinator, state, events, _ = self.coordinator_fixture(
            self.journal("activation-intent", trial_count=0, transition=transition),
            consumed_and_mutated,
            active_slot="b",
        )
        with patch(
            "stugu_host_updater.coordinator.exclusive_lock", lambda _: nullcontext()
        ):
            result = coordinator.reconcile()
        self.assertEqual(result["phase"], "returned")
        self.assertEqual(state["journal"]["phase"], "returned")
        self.assertIn(("boot", "fallback"), events)

    def test_probation_intent_rejects_nonselector_boot_record_mutation(self) -> None:
        manifest = ReleaseManifest.parse(release_manifest())
        pending = pending_record(
            self.clean_record(),
            source="a",
            target="b",
            generation=manifest.host_generation,
            manifest_sha256=manifest.digest,
        )
        pending = replace(
            pending,
            sequence=pending.sequence + 2,
            slots={
                **pending.slots,
                "b": replace(pending.slots["b"], tries_remaining=0),
            },
        )
        probation = probation_record(pending, source="a", target="b")
        transition = BootTransition.create("probation", pending, probation)
        consumed_and_mutated = replace(
            probation,
            sequence=probation.sequence + 1,
            slots={
                "a": replace(probation.slots["a"], tries_remaining=2),
                "b": replace(probation.slots["b"], tries_remaining=2),
            },
        )
        coordinator, state, events, _ = self.coordinator_fixture(
            self.journal("probation-intent", trial_count=2, transition=transition),
            consumed_and_mutated,
            active_slot="b",
        )
        with patch(
            "stugu_host_updater.coordinator.exclusive_lock", lambda _: nullcontext()
        ):
            result = coordinator.reconcile()
        self.assertEqual(result["phase"], "returned")
        self.assertEqual(state["journal"]["phase"], "returned")
        self.assertIn(("boot", "fallback"), events)

    def test_success_intent_requires_exact_success_record_and_health_evidence(
        self,
    ) -> None:
        manifest = ReleaseManifest.parse(release_manifest())
        pending = pending_record(
            self.clean_record(),
            source="a",
            target="b",
            generation=manifest.host_generation,
            manifest_sha256=manifest.digest,
        )
        pending = replace(
            pending,
            sequence=pending.sequence + 2,
            slots={
                **pending.slots,
                "b": replace(pending.slots["b"], tries_remaining=0),
            },
        )
        probation = probation_record(pending, source="a", target="b")
        probation = replace(
            probation,
            sequence=probation.sequence + 1,
            slots={
                **probation.slots,
                "b": replace(probation.slots["b"], tries_remaining=2),
            },
        )
        coordinator, state, events, _ = self.coordinator_fixture(
            self.journal("probation", trial_count=2),
            probation,
            active_slot="b",
            fail_phase="complete",
        )
        with (
            patch(
                "stugu_host_updater.coordinator.exclusive_lock",
                lambda _: nullcontext(),
            ),
            self.assertRaisesRegex(OSError, "complete journal"),
        ):
            coordinator.reconcile()
        self.assertEqual(
            events[:4],
            [
                ("health", "b"),
                ("journal", "success-intent"),
                ("boot", "successful"),
                ("journal", "complete"),
            ],
        )
        self.assertEqual(state["journal"]["phase"], "success-intent")

        resumed, resumed_state, resumed_events, _ = self.coordinator_fixture(
            state["journal"], state["record"], active_slot="b"
        )
        with patch(
            "stugu_host_updater.coordinator.exclusive_lock", lambda _: nullcontext()
        ):
            result = resumed.reconcile()
        self.assertEqual(result["phase"], "complete")
        self.assertEqual(resumed_state["journal"]["phase"], "complete")
        self.assertNotIn(("health", "b"), resumed_events)
        self.assertFalse(any(event[0] == "boot" for event in resumed_events))

    def test_stale_installed_journal_disarms_pending_boot_before_returning(
        self,
    ) -> None:
        manifest = ReleaseManifest.parse(release_manifest())
        pending = pending_record(
            self.clean_record(),
            source="a",
            target="b",
            generation=manifest.host_generation,
            manifest_sha256=manifest.digest,
        )
        pending = replace(
            pending,
            sequence=pending.sequence + 1,
            slots={
                **pending.slots,
                "b": replace(pending.slots["b"], tries_remaining=1),
            },
        )
        coordinator, state, events, _ = self.coordinator_fixture(
            self.journal("installed", trial_count=0), pending, active_slot="b"
        )
        with patch(
            "stugu_host_updater.coordinator.exclusive_lock", lambda _: nullcontext()
        ):
            result = coordinator.reconcile()
        self.assertEqual(result["phase"], "returned")
        self.assertEqual(state["journal"]["phase"], "returned")
        self.assertEqual(state["record"].committed, "a")
        self.assertEqual(
            [event for event in events if event[0] in {"journal", "boot"}],
            [
                ("journal", "return-intent"),
                ("boot", "fallback"),
                ("journal", "returned"),
            ],
        )

    def test_success_record_requires_exact_durable_health_evidence(
        self,
    ) -> None:
        manifest = ReleaseManifest.parse(release_manifest())
        pending = pending_record(
            self.clean_record(),
            source="a",
            target="b",
            generation=manifest.host_generation,
            manifest_sha256=manifest.digest,
        )
        probation = probation_record(pending, source="a", target="b")
        probation = replace(
            probation,
            slots={
                **probation.slots,
                "b": replace(probation.slots["b"], tries_remaining=2),
            },
        )
        successful = replace(
            probation,
            sequence=probation.sequence + 1,
            state="successful",
            slots={
                **probation.slots,
                "b": replace(probation.slots["b"], successful=True, tries_remaining=3),
            },
        )
        transition = BootTransition.create("success", probation, successful)
        invalid_evidence = (
            None,
            {"slot": "passed", "containers": "passed"},
            {**health_evidence(), "watchdog": "healthy"},
        )
        for health in invalid_evidence:
            with self.subTest(health=health):
                coordinator, state, _, _ = self.coordinator_fixture(
                    self.journal(
                        "success-intent",
                        trial_count=2,
                        transition=transition,
                        health=health,
                    ),
                    successful,
                    active_slot="b",
                )
                with patch(
                    "stugu_host_updater.coordinator.exclusive_lock",
                    lambda _: nullcontext(),
                ):
                    result = coordinator.reconcile()
                self.assertEqual(result["phase"], "returned")
                self.assertEqual(state["journal"]["phase"], "returned")
                self.assertEqual(state["record"].committed, "a")

    def test_cancel_disarms_a_stale_pending_record_instead_of_releasing_it(
        self,
    ) -> None:
        manifest = ReleaseManifest.parse(release_manifest())
        pending = pending_record(
            self.clean_record(),
            source="a",
            target="b",
            generation=manifest.host_generation,
            manifest_sha256=manifest.digest,
        )
        coordinator, state, events, _ = self.coordinator_fixture(
            self.journal("installed", trial_count=0), pending, active_slot="a"
        )
        with patch(
            "stugu_host_updater.coordinator.exclusive_lock", lambda _: nullcontext()
        ):
            result = coordinator.cancel()
        self.assertEqual(result["phase"], "returned")
        self.assertEqual(state["journal"]["phase"], "returned")
        self.assertEqual(events[0], ("journal", "return-intent"))
        self.assertIn(("boot", "fallback"), events)

    def test_cancel_rejects_same_generation_source_manifest_substitution(self) -> None:
        clean = self.clean_record()
        substituted = replace(
            clean,
            slots={
                **clean.slots,
                "a": replace(clean.slots["a"], manifest_sha256="c" * 64),
            },
        )
        coordinator, state, events, _ = self.coordinator_fixture(
            self.journal("installed", trial_count=0), substituted, active_slot="a"
        )
        with patch(
            "stugu_host_updater.coordinator.exclusive_lock", lambda _: nullcontext()
        ):
            result = coordinator.cancel()
        self.assertEqual(result["phase"], "recovery-needed")
        self.assertEqual(result["errorCode"], "SOURCE_RECORD_MISMATCH")
        self.assertEqual(state["journal"]["phase"], "recovery-needed")
        self.assertFalse(any(event[0] == "boot" for event in events))

    def test_return_intent_rejects_an_unrelated_clean_source_record(self) -> None:
        manifest = ReleaseManifest.parse(release_manifest())
        pending = pending_record(
            self.clean_record(),
            source="a",
            target="b",
            generation=manifest.host_generation,
            manifest_sha256=manifest.digest,
        )
        returned = fallback_record(pending, "a", "b")
        transition = BootTransition.create("return", pending, returned)
        coordinator, state, events, _ = self.coordinator_fixture(
            self.journal("return-intent", trial_count=0, transition=transition),
            self.clean_record(),
            active_slot="a",
        )
        with patch(
            "stugu_host_updater.coordinator.exclusive_lock", lambda _: nullcontext()
        ):
            result = coordinator.reconcile()
        self.assertEqual(result["phase"], "recovery-needed")
        self.assertEqual(result["errorCode"], "BOOT_TRANSITION_MISMATCH")
        self.assertEqual(state["journal"]["phase"], "recovery-needed")
        self.assertFalse(any(event[0] == "boot" for event in events))

    def test_durable_journal_remains_authoritative_over_transient_status(self) -> None:
        manifest = ReleaseManifest.parse(release_manifest())
        operation_id = "f6d11af3-a5de-4855-8be1-796bd8a725dd"
        intent_id = "b9aed8c9-36e7-46be-9dbd-1741ec955eb0"
        with TemporaryDirectory() as directory:
            coordinator = Coordinator.__new__(Coordinator)
            coordinator.status_path = Path(directory) / "status.json"
            atomic_json(
                coordinator.status_path,
                {
                    "schema": "stugu-host-update-status/v1",
                    "operationId": None,
                    "intentId": None,
                    "phase": "available",
                    "detail": "A later check completed",
                    "updatedAt": "2026-08-04T12:00:00.000Z",
                },
            )
            coordinator._journal = lambda: {
                "phase": "installed",
                "operationId": operation_id,
                "intentId": intent_id,
                "targetGeneration": manifest.host_generation,
                "manifestSha256": manifest.digest,
                "targetSlot": "b",
            }
            coordinator._manifest_from_journal = lambda _: manifest
            result = coordinator.status()
        self.assertEqual(result["phase"], "ready-to-restart")
        self.assertEqual(result["operationId"], operation_id)
        self.assertEqual(result["intentId"], intent_id)
        self.assertEqual(result["journalPhase"], "installed")

    def test_newer_terminal_journal_recovers_stale_verifying_status(self) -> None:
        manifest = ReleaseManifest.parse(release_manifest())
        operation_id = "f6d11af3-a5de-4855-8be1-796bd8a725dd"
        intent_id = "b9aed8c9-36e7-46be-9dbd-1741ec955eb0"
        health = health_evidence()
        with TemporaryDirectory() as directory:
            coordinator = Coordinator.__new__(Coordinator)
            coordinator.status_path = Path(directory) / "status.json"
            atomic_json(
                coordinator.status_path,
                {
                    "schema": "stugu-host-update-status/v1",
                    "operationId": operation_id,
                    "intentId": intent_id,
                    "phase": "verifying",
                    "detail": "Verifying the committed host during probation",
                    "updatedAt": "2026-08-04T12:00:00.000Z",
                },
            )
            coordinator._journal = lambda: {
                "phase": "complete",
                "operationId": operation_id,
                "intentId": intent_id,
                "targetGeneration": manifest.host_generation,
                "manifestSha256": manifest.digest,
                "targetSlot": "b",
                "health": health,
                "updatedAt": "2026-08-04T12:00:01.000Z",
            }
            coordinator._manifest_from_journal = lambda _: manifest
            result = coordinator.status()
        self.assertEqual(result["phase"], "complete")
        self.assertEqual(result["detail"], "Host update completed successfully")
        self.assertEqual(result["operationId"], operation_id)
        self.assertEqual(result["intentId"], intent_id)
        self.assertEqual(result["targetVersion"], manifest.version)
        self.assertEqual(result["targetGeneration"], manifest.host_generation)
        self.assertEqual(result["manifestSha256"], manifest.digest)
        self.assertEqual(result["targetSlot"], "b")
        self.assertEqual(result["journalPhase"], "complete")
        self.assertEqual(result["health"], health)

    def test_later_status_supersedes_reusable_terminal_journal(self) -> None:
        manifest = ReleaseManifest.parse(release_manifest())
        with TemporaryDirectory() as directory:
            coordinator = Coordinator.__new__(Coordinator)
            coordinator.status_path = Path(directory) / "status.json"
            expected = {
                "schema": "stugu-host-update-status/v1",
                "operationId": None,
                "intentId": None,
                "phase": "current",
                "detail": "Host is current",
                "updatedAt": "2026-08-04T12:00:01.000Z",
            }
            atomic_json(coordinator.status_path, expected)
            coordinator._journal = lambda: {
                "phase": "complete",
                "operationId": "f6d11af3-a5de-4855-8be1-796bd8a725dd",
                "intentId": "b9aed8c9-36e7-46be-9dbd-1741ec955eb0",
                "targetGeneration": manifest.host_generation,
                "manifestSha256": manifest.digest,
                "targetSlot": "b",
                "updatedAt": "2026-08-04T12:00:00.000Z",
            }
            coordinator._manifest_from_journal = lambda _: manifest
            result = coordinator.status()
        self.assertEqual(result, expected)

    def test_failed_inactive_slot_write_becomes_durable_recovery(self) -> None:
        manifest = ReleaseManifest.parse(release_manifest())
        custom = TargetContract(
            "stable",
            manifest.digest,
            manifest.product,
            manifest.layout,
            manifest.host_generation,
            manifest.version,
            manifest.artifacts.boot_sha256,
            manifest.artifacts.root_sha256,
        )
        candidate = VerifiedTarget(
            "stable/bundle.raucb",
            4096,
            {"sha256": "d" * 64},
            custom,
            {"timestamp": 2, "snapshot": 2},
            1,
        )
        partitions = {
            name: SimpleNamespace(partuuid=f"{index:08x}-1111-2222-3333-444444444444")
            for index, name in enumerate(
                ("boot_a", "system_a", "boot_b", "system_b", "persistent"),
                start=1,
            )
        }
        disk = SimpleNamespace(
            active_slot="a",
            inactive_slot="b",
            partitions=partitions,
            slot=lambda suffix, kind: partitions[f"{kind}_{suffix}"],
        )

        class Trust:
            state = TrustState(1, "e" * 64, 41, None, None, 1, {}, 1)

            def load(self):
                return self.state

            def write(self, value):
                self.state = value

        class Rauc:
            def inspect(self, _bundle, _manifest_name):
                return InspectedBundle(
                    manifest,
                    "f" * 64,
                    f"{manifest.product}:{manifest.layout}:arm64",
                    "verity",
                )

            def install(self, *_args):
                raise UpdaterError(
                    "RAUC_INSTALL_FAILED", "RAUC failed while writing the inactive slot"
                )

        with TemporaryDirectory() as directory:
            root = Path(directory)
            coordinator = Coordinator.__new__(Coordinator)
            coordinator.config = SimpleNamespace(
                host_generation=41,
                product=manifest.product,
                layout=manifest.layout,
                paths=SimpleNamespace(
                    lock=root / "host.lock",
                    persistent_mount=root,
                    release_manifest_name="stugu-host-release.json",
                ),
            )
            coordinator.journal_path = root / "journal.json"
            coordinator.status_path = root / "status.json"
            coordinator._active_stage_operation_id = None
            coordinator.audit = SimpleNamespace(append=lambda _value: None)
            coordinator.metrics = SimpleNamespace(update=lambda _phase, _value: None)
            coordinator._mutation_lease = lambda: nullcontext()
            coordinator._journal = lambda: read_json(coordinator.journal_path)
            coordinator._target = lambda _channel: candidate
            coordinator._require_clean_boot_control = lambda *_args, **_kwargs: (
                self.clean_record()
            )
            coordinator.preflight = SimpleNamespace(
                prepare=lambda *_args, **_kwargs: SimpleNamespace(disk=disk),
                run=lambda *_args, **_kwargs: SimpleNamespace(
                    disk=disk, trusted_time=2
                ),
            )
            coordinator.repository = SimpleNamespace(
                download=lambda _target: root / "bundle.raucb"
            )
            coordinator.trust = Trust()
            coordinator.rauc = Rauc()

            with (
                patch(
                    "stugu_host_updater.coordinator.exclusive_lock",
                    lambda _: nullcontext(),
                ),
                self.assertRaisesRegex(UpdaterError, "inactive slot"),
            ):
                coordinator.stage(
                    intent_id="b9aed8c9-36e7-46be-9dbd-1741ec955eb0",
                    expected_version=manifest.version,
                    expected_generation=manifest.host_generation,
                    expected_manifest_sha256=manifest.digest,
                )

            journal = read_json(coordinator.journal_path)
            self.assertEqual(journal["phase"], "recovery-needed")
            status = coordinator.status()
            self.assertEqual(status["phase"], "recovery-needed")
            self.assertEqual(status["journalPhase"], "recovery-needed")
            self.assertEqual(status["operationId"], journal["operationId"])

    def test_check_does_not_replace_a_staged_journal_status(self) -> None:
        coordinator = Coordinator.__new__(Coordinator)
        coordinator.config = SimpleNamespace(
            paths=SimpleNamespace(lock=Path("/run/host.lock"))
        )
        coordinator._journal = lambda: {"phase": "installed"}
        coordinator.status = lambda: {"phase": "ready-to-restart"}
        coordinator._target = lambda _: self.fail("check fetched metadata while staged")
        with patch(
            "stugu_host_updater.coordinator.exclusive_lock", lambda _: nullcontext()
        ):
            result = coordinator.check()
        self.assertEqual(result["phase"], "ready-to-restart")

    def test_stale_confirmation_cannot_activate_another_candidate(self) -> None:
        manifest = ReleaseManifest.parse(release_manifest())
        journal = {
            "intentId": "b9aed8c9-36e7-46be-9dbd-1741ec955eb0",
            "operationId": "f6d11af3-a5de-4855-8be1-796bd8a725dd",
            "targetGeneration": manifest.host_generation,
            "manifestSha256": manifest.digest,
            "manifest": manifest.raw,
        }
        with self.assertRaisesRegex(UpdaterError, "changed"):
            require_expected_staged_identity(
                journal,
                intent_id=str(journal["intentId"]),
                expected_operation_id=str(journal["operationId"]),
                expected_version=manifest.version,
                expected_generation=manifest.host_generation + 1,
                expected_manifest_sha256=manifest.digest,
            )


if __name__ == "__main__":
    unittest.main()
