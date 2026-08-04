"""Durable signed host-update state machine."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import uuid

from .bootcontrol import BootControlStore, BootRecord
from .boottransitions import (
    BootTransition,
    fallback_record,
    is_clean_source_record,
    is_pending_record,
    is_probation_record,
    is_successful_record,
    pending_record,
    probation_record,
    require_trial_record,
    selector_consumed_transition_matches,
    source_is_usable,
    successful_record,
)
from .command import CommandRunner
from .config import UpdaterConfig
from .contracts import ReleaseManifest
from .durable import (
    AuditLog,
    RedundantTrustStore,
    TrustState,
    atomic_json,
    exclusive_file_lease,
    exclusive_lock,
    read_bounded_regular,
    read_json,
)
from .errors import ContractError, TrustError, UpdaterError
from .health import HealthChecker, valid_health_evidence
from .hostjournal import (
    INTENT_PHASES,
    JOURNAL_SCHEMA,
    REUSABLE_PHASES,
    require_expected_staged_identity,
    validate_host_journal,
)
from .metrics import MetricsExporter
from .platform import ApplianceDisk, DeviceResolver, hardware_fingerprint
from .preflight import Preflight
from .rauc import RaucClient
from .repository import TufRepository, VerifiedTarget


STATUS_SCHEMA = "stugu-host-update-status/v1"


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _utc_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.endswith("Z"):
        return None
    try:
        parsed = datetime.fromisoformat(f"{value[:-1]}+00:00")
    except ValueError:
        return None
    if parsed.utcoffset() != timezone.utc.utcoffset(None):
        return None
    return parsed


def require_metadata_progress(target: VerifiedTarget, trust: TrustState) -> None:
    if target.root_chain_length < trust.root_chain_length:
        raise TrustError("TUF root chain is older than the highest accepted chain")
    for role, highest in trust.metadata_versions.items():
        current = target.metadata_versions.get(role)
        if current is None or current < highest:
            raise TrustError(
                f"TUF {role} metadata is older than the highest accepted version"
            )


def accepted_target_state(
    target: VerifiedTarget, trust: TrustState, trusted_time: int
) -> TrustState:
    require_metadata_progress(target, trust)
    generation = target.custom.host_generation
    manifest_sha = target.custom.manifest_sha256
    if generation < trust.highest_host_generation:
        raise TrustError("TUF target is below the highest accepted host generation")
    if (
        generation == trust.highest_host_generation
        and trust.highest_manifest_sha256 is not None
        and manifest_sha != trust.highest_manifest_sha256
    ):
        raise TrustError("TUF target equivocates within an accepted host generation")
    return trust.next(
        highest_host_generation=generation,
        highest_manifest_sha256=manifest_sha,
        maximum_trusted_time=max(trust.maximum_trusted_time, trusted_time),
        metadata_versions=target.metadata_versions,
        root_chain_length=target.root_chain_length,
    )


def accepted_metadata_state(
    target: VerifiedTarget, trust: TrustState, trusted_time: int
) -> TrustState:
    """Advance repository freshness without trusting TUF alone to burn a host generation."""
    require_metadata_progress(target, trust)
    return trust.next(
        maximum_trusted_time=max(trust.maximum_trusted_time, trusted_time),
        metadata_versions=target.metadata_versions,
        root_chain_length=target.root_chain_length,
    )


class Coordinator:
    def __init__(
        self,
        config: UpdaterConfig,
        *,
        repository: TufRepository | None = None,
        rauc: RaucClient | None = None,
        preflight: Preflight | None = None,
        resolver: DeviceResolver | None = None,
        boot_control: BootControlStore | None = None,
        health: HealthChecker | None = None,
        runner: CommandRunner | None = None,
    ) -> None:
        self.config = config
        self.runner = runner or CommandRunner()
        immutable_root = read_bounded_regular(
            config.paths.immutable_root, maximum=512 * 1024
        )
        assert isinstance(immutable_root, bytes)
        self.trust = RedundantTrustStore(config.paths.state / "trust", immutable_root)
        self._ensure_trust_seed()
        self.repository = repository or TufRepository(
            metadata_base_url=config.metadata_base_url,
            target_base_url=config.target_base_url,
            metadata_dir=config.paths.state / "tuf" / "metadata",
            target_dir=config.paths.cache / "targets",
            immutable_root=immutable_root,
            maximum_target_bytes=config.maximum_bundle_bytes,
        )
        self.rauc = rauc or RaucClient(config.paths.rauc_keyring, self.runner)
        self.resolver = resolver or DeviceResolver(self.runner)
        self.preflight = preflight or Preflight(config, self.resolver, self.runner)
        self.boot_control = boot_control or BootControlStore(
            config.paths.state / "bootstrap-receipt.json",
            config.paths.qualification,
            config.boot_shim_generation,
            self.runner,
        )
        self.health = health or HealthChecker(config, self.runner)
        self.audit = AuditLog(config.paths.state / "audit.ndjson")
        self.metrics = MetricsExporter(config.paths.state)
        self.journal_path = config.paths.state / "journal.json"
        self.status_path = config.paths.state / "status.json"
        # A prepared journal exists before RAUC mutates the inactive slot.  Keep
        # the in-memory owner explicit so status can distinguish a live install
        # from an interrupted/partial install after this daemon restarts.
        self._active_stage_operation_id: str | None = None

    def _ensure_trust_seed(self) -> None:
        trust = self.trust.load()
        if trust.highest_host_generation >= self.config.host_generation:
            return
        self.trust.write(
            trust.next(
                highest_host_generation=self.config.host_generation,
                highest_manifest_sha256=None,
            )
        )

    def _status(self, phase: str, detail: str, **values: object) -> dict[str, object]:
        previous = read_json(self.status_path) or {}
        operation_id = values.pop("operationId", None) or (
            previous.get("operationId") if isinstance(previous, dict) else None
        )
        intent_id = values.pop("intentId", None)
        value: dict[str, object] = {
            "schema": STATUS_SCHEMA,
            "operationId": operation_id,
            "intentId": intent_id,
            "phase": phase,
            "detail": detail[:500],
            "updatedAt": now(),
        }
        value.update(values)
        atomic_json(self.status_path, value, mode=0o640)
        self.audit.append(
            {
                "schema": "stugu-host-update-audit/v1",
                "at": value["updatedAt"],
                "operationId": operation_id,
                "phase": phase,
                "code": values.get("errorCode"),
            }
        )
        self.metrics.update(phase, value)
        return value

    def status(self) -> dict[str, object]:
        value = read_json(self.status_path)
        if not isinstance(value, dict) or value.get("schema") != STATUS_SCHEMA:
            value = {
                "schema": STATUS_SCHEMA,
                "operationId": None,
                "intentId": None,
                "phase": "idle",
                "detail": "No host update is active",
                "updatedAt": None,
            }
        journal = self._journal()
        if not journal:
            return value
        journal_phase = str(journal["phase"])
        if journal_phase in REUSABLE_PHASES:
            journal_updated_at = _utc_timestamp(journal.get("updatedAt"))
            status_updated_at = _utc_timestamp(value.get("updatedAt"))
            if journal_updated_at is None or (
                status_updated_at is not None
                and status_updated_at >= journal_updated_at
            ):
                return value
        manifest = self._manifest_from_journal(journal)
        interrupted_preparation = journal_phase == "prepared" and getattr(
            self, "_active_stage_operation_id", None
        ) != journal.get("operationId")
        phase = {
            "prepared": (
                "recovery-needed" if interrupted_preparation else "installing"
            ),
            "installed": "ready-to-restart",
            "pending": "verifying",
            "probation": "verifying",
            "activation-intent": "restarting",
            "probation-intent": "verifying",
            "success-intent": "verifying",
            "return-intent": "verifying",
        }.get(journal_phase, journal_phase)
        detail = {
            "prepared": (
                "Host staging was interrupted after the inactive slot became mutable; recovery is required"
                if interrupted_preparation
                else "Preparing the verified inactive host slot"
            ),
            "installed": "Update is staged in the inactive slot",
            "pending": "Verifying the staged host through repeated trial boots",
            "probation": "Verifying the committed host during probation",
            "activation-intent": "Reconciling the durable activation intent",
            "probation-intent": "Reconciling the probation transition",
            "success-intent": "Reconciling the final success transition",
            "return-intent": "Returning to the previous host version",
            "complete": "Host update completed successfully",
            "cancelled": "Staged update will not be activated",
            "returned": "Returned to the previous host version",
            "recovery-needed": "Host update recovery is required",
        }.get(
            journal_phase, str(value.get("detail") or "Host update requires attention")
        )
        result = {
            **value,
            "operationId": journal["operationId"],
            "intentId": journal.get("intentId"),
            "phase": phase,
            "detail": detail,
            "targetVersion": manifest.version,
            "targetGeneration": journal["targetGeneration"],
            "manifestSha256": journal["manifestSha256"],
            "targetSlot": journal["targetSlot"],
            "journalPhase": journal_phase,
        }
        for field in ("health", "rollbackReason", "rollbackError"):
            if field in journal:
                result[field] = journal[field]
        return result

    def hardware_id(self) -> dict[str, object]:
        """Report the exact local qualification identity without mutating state."""

        disk = self.resolver.resolve()
        return {
            "schema": "stugu-host-hardware-id/v1",
            "fingerprint": hardware_fingerprint(disk),
            "bootDisk": str(disk.path),
            "activeSlot": disk.active_slot,
        }

    def _journal(self) -> dict[str, object] | None:
        return validate_host_journal(
            read_json(self.journal_path),
            product=self.config.product,
            layout=self.config.layout,
        )

    @contextmanager
    def _mutation_lease(self):
        # Host startup/migrations use the runtime flock; the container update
        # agent uses the persistent O_EXCL lease. Holding both closes the race
        # between a preflight snapshot and the first slot or journal mutation.
        with (
            exclusive_lock(Path("/run/lock/stugu-compose.lock")),
            exclusive_file_lease(
                self.config.paths.persistent_mount
                / "stugu"
                / "update-operations"
                / "agent.lock"
            ),
        ):
            yield

    def _write_journal(
        self, journal: dict[str, object], phase: str, **values: object
    ) -> dict[str, object]:
        updated = {**journal, **values, "phase": phase, "updatedAt": now()}
        atomic_json(self.journal_path, updated)
        return updated

    def _target(self, channel: str) -> VerifiedTarget:
        path = self.config.targets.get(channel)
        if path is None:
            raise ContractError("Requested update channel is not configured")
        trust = self.trust.load()
        trusted_time = self.preflight.trusted_time(trust)
        self.repository.refresh()
        target = self.repository.target(path)
        accepted = accepted_metadata_state(target, trust, trusted_time)
        self.trust.write(accepted)
        return target

    def _require_clean_boot_control(
        self,
        disk: ApplianceDisk,
        *,
        require_qualification: bool = True,
        expected_manifest_sha256: str | None = None,
    ) -> BootRecord:
        boot_record, _ = self.boot_control.validate_disk(
            disk,
            require_qualification=require_qualification,
        )
        active_slot = disk.active_slot
        active_state = boot_record.slots[active_slot]
        if (
            boot_record.committed != active_slot
            or boot_record.pending is not None
            or boot_record.state not in {"successful", "fallback"}
            or active_state.generation != self.config.host_generation
            or (
                expected_manifest_sha256 is not None
                and active_state.manifest_sha256 != expected_manifest_sha256
            )
            or not active_state.successful
        ):
            raise TrustError("Boot-control state is not a clean committed source slot")
        return boot_record

    @staticmethod
    def _require_journal_disk(disk: ApplianceDisk, journal: dict[str, object]) -> None:
        source = journal.get("sourceSlot")
        target = journal.get("targetSlot")
        slots = journal.get("slotPartuuids")
        if (
            source not in {"a", "b"}
            or target not in {"a", "b"}
            or source == target
            or not isinstance(slots, dict)
            or journal.get("persistentPartuuid")
            != disk.partitions["persistent"].partuuid
            or slots.get("sourceBoot") != disk.slot(str(source), "boot").partuuid
            or slots.get("sourceSystem") != disk.slot(str(source), "system").partuuid
            or slots.get("targetBoot") != disk.slot(str(target), "boot").partuuid
            or slots.get("targetSystem") != disk.slot(str(target), "system").partuuid
        ):
            raise TrustError(
                "Appliance partition identity changed after update staging"
            )

    def _return_to_source(
        self,
        disk: ApplianceDisk,
        journal: dict[str, object],
        record: BootRecord,
        reason: str,
        *,
        reboot: bool,
    ) -> dict[str, object]:
        source = str(journal["sourceSlot"])
        target = str(journal["targetSlot"])
        source_generation = int(journal["sourceGeneration"])
        source_manifest = str(journal["sourceManifestSha256"])
        if not source_is_usable(
            record,
            source=source,
            generation=source_generation,
            manifest_sha256=source_manifest,
        ):
            return self._recovery_needed(
                journal,
                reason,
                "SOURCE_RECORD_MISMATCH",
                "The recorded fallback source cannot be verified",
            )
        existing = (
            BootTransition.parse(journal.get("bootTransition"))
            if journal.get("phase") == "return-intent"
            else None
        )
        already_returned = is_clean_source_record(
            record,
            source=source,
            generation=source_generation,
            manifest_sha256=source_manifest,
        )
        if (
            already_returned
            and existing is not None
            and not existing.matches_to(record)
        ):
            return self._recovery_needed(
                journal,
                reason,
                "BOOT_TRANSITION_MISMATCH",
                "Boot state changed while returning to the previous host",
            )
        if not already_returned:
            returned = fallback_record(record, source, target)
            transition = existing or BootTransition.create("return", record, returned)
            if (
                transition.kind != "return"
                or not transition.matches_from(record)
                or transition.to_sha256
                != BootTransition.create("return", record, returned).to_sha256
            ):
                return self._recovery_needed(
                    journal,
                    reason,
                    "BOOT_TRANSITION_MISMATCH",
                    "Boot state changed while returning to the previous host",
                )
            journal = self._write_journal(
                journal,
                "return-intent",
                bootTransition=transition.json(),
                rollbackReason=reason,
            )
            self.boot_control.write(returned, disk)
        self._write_journal(
            journal, "returned", bootTransition=None, rollbackReason=reason
        )
        status = self._status(
            "returned",
            "Returned to the previous host version",
            operationId=journal["operationId"],
            intentId=journal.get("intentId"),
            rollbackReason=reason,
        )
        if reboot:
            self.runner.run(["systemctl", "reboot"], timeout=10)
        return status

    def _recovery_needed(
        self, journal: dict[str, object], reason: str, code: str, detail: str
    ) -> dict[str, object]:
        journal = self._write_journal(
            journal,
            "recovery-needed",
            bootTransition=None,
            rollbackReason=reason,
            rollbackError=code,
        )
        return self._status(
            "recovery-needed",
            detail,
            operationId=journal["operationId"],
            intentId=journal.get("intentId"),
            rollbackReason=reason,
            errorCode=code,
        )

    def check(
        self, channel: str = "stable", intent_id: str | None = None
    ) -> dict[str, object]:
        with exclusive_lock(self.config.paths.lock):
            journal = self._journal()
            if journal and journal.get("phase") not in REUSABLE_PHASES:
                return self.status()
            self._status(
                "checking", "Checking signed update metadata", intentId=intent_id
            )
            target = self._target(channel)
            return self._status(
                "available"
                if target.custom.host_generation > self.config.host_generation
                else "current",
                "A signed host update is available"
                if target.custom.host_generation > self.config.host_generation
                else "Host is current",
                intentId=intent_id,
                channel=channel,
                targetVersion=target.custom.version,
                targetGeneration=target.custom.host_generation,
                manifestSha256=target.custom.manifest_sha256,
                bytes=target.length,
                metadataVersions=target.metadata_versions,
            )

    def stage(
        self,
        channel: str = "stable",
        repair: bool = False,
        intent_id: str | None = None,
        expected_version: str | None = None,
        expected_generation: int | None = None,
        expected_manifest_sha256: str | None = None,
    ) -> dict[str, object]:
        operation_id = str(uuid.uuid4())
        with exclusive_lock(self.config.paths.lock), self._mutation_lease():
            existing = self._journal()
            if existing and existing.get("phase") not in REUSABLE_PHASES:
                raise UpdaterError(
                    "UPDATE_BUSY", "A host update journal already requires completion"
                )
            self._status(
                "checking",
                "Verifying signed update metadata",
                operationId=operation_id,
                intentId=intent_id,
                channel=channel,
            )
            target = self._target(channel)
            expected_target = (
                expected_version,
                expected_generation,
                expected_manifest_sha256,
            )
            actual_target = (
                target.custom.version,
                target.custom.host_generation,
                target.custom.manifest_sha256,
            )
            if any(value is not None for value in expected_target) and (
                any(value is None for value in expected_target)
                or expected_target != actual_target
            ):
                raise UpdaterError(
                    "TARGET_CHANGED",
                    "The signed host target changed; check again before staging",
                )
            prepared = self.preflight.prepare(
                self.trust.load(), bundle_length=target.length
            )
            self._require_clean_boot_control(prepared.disk, require_qualification=False)
            self._status(
                "downloading",
                "Downloading and verifying the complete signed bundle",
                operationId=operation_id,
                intentId=intent_id,
                channel=channel,
                bytesTotal=target.length,
                bytesComplete=0,
            )
            bundle = self.repository.download(target)
            inspected = self.rauc.inspect(
                bundle, self.config.paths.release_manifest_name
            )
            target.custom.require_matches(inspected.manifest, channel)
            preflight = self.preflight.run(
                inspected.manifest,
                self.trust.load(),
                bundle_length=target.length,
                repair=repair,
            )
            compatible = f"{self.config.product}:{self.config.layout}:arm64"
            if inspected.compatible != compatible:
                raise UpdaterError(
                    "RAUC_COMPATIBLE_MISMATCH",
                    "RAUC compatible string does not match this appliance",
                )
            disk = preflight.disk
            manifest = inspected.manifest
            source_record = self._require_clean_boot_control(
                disk, require_qualification=False
            )
            # Only a TUF-authorized, independently RAUC-signed, locally
            # compatible release may advance the host anti-rollback generation.
            current_trust = self.trust.load()
            self.trust.write(
                accepted_target_state(target, current_trust, preflight.trusted_time)
            )
            journal: dict[str, object] = {
                "schema": JOURNAL_SCHEMA,
                "operationId": operation_id,
                "phase": "prepared",
                "createdAt": now(),
                "updatedAt": now(),
                "channel": channel,
                "targetPath": target.path,
                "targetLength": target.length,
                "targetSha256": target.hashes["sha256"],
                "bundlePath": str(bundle),
                "raucManifestHash": inspected.rauc_manifest_hash,
                "manifest": manifest.raw,
                "manifestSha256": manifest.digest,
                "sourceSlot": disk.active_slot,
                "targetSlot": disk.inactive_slot,
                "sourceGeneration": self.config.host_generation,
                "sourceManifestSha256": source_record.slots[
                    disk.active_slot
                ].manifest_sha256,
                "targetGeneration": manifest.host_generation,
                "persistentPartuuid": disk.partitions["persistent"].partuuid,
                "slotPartuuids": {
                    "sourceBoot": disk.slot(disk.active_slot, "boot").partuuid,
                    "sourceSystem": disk.slot(disk.active_slot, "system").partuuid,
                    "targetBoot": disk.slot(disk.inactive_slot, "boot").partuuid,
                    "targetSystem": disk.slot(disk.inactive_slot, "system").partuuid,
                },
                "trialCount": 0,
                "repair": repair,
            }
            if intent_id is not None:
                journal["intentId"] = intent_id
            self._active_stage_operation_id = operation_id
            try:
                atomic_json(self.journal_path, journal)
                self._status(
                    "installing",
                    "Writing the inactive host slot",
                    operationId=operation_id,
                    intentId=intent_id,
                    sourceSlot=disk.active_slot,
                    targetSlot=disk.inactive_slot,
                    sourceGeneration=self.config.host_generation,
                    targetGeneration=manifest.host_generation,
                )
                self.rauc.install(
                    bundle, operation_id, target.hashes["sha256"], target.length
                )
                installed_disk = self.resolver.resolve()
                self._require_journal_disk(installed_disk, journal)
                if (installed_disk.active_slot, installed_disk.inactive_slot) != (
                    journal["sourceSlot"],
                    journal["targetSlot"],
                ):
                    raise TrustError(
                        "Active/inactive slots changed while installing the update"
                    )
                self.rauc.verify_inactive(installed_disk, manifest)
                disk = installed_disk
                journal = self._write_journal(journal, "installed")
                current_trust = self.trust.load()
                self.trust.write(
                    current_trust.next(
                        fallback_host_generation=self.config.host_generation,
                    )
                )
            except Exception:
                # Once this journal exists, the inactive slot may be partially
                # written.  Never present that ambiguity as a retryable failure
                # or an indefinitely live install.
                if self.journal_path.exists():
                    self._write_journal(journal, "recovery-needed")
                raise
            finally:
                self._active_stage_operation_id = None
            return self._status(
                "ready-to-restart",
                "Update is staged in the inactive slot",
                operationId=operation_id,
                intentId=intent_id,
                targetVersion=manifest.version,
                targetGeneration=manifest.host_generation,
                manifestSha256=manifest.digest,
                targetSlot=disk.inactive_slot,
            )

    def _manifest_from_journal(self, journal: dict[str, object]) -> ReleaseManifest:
        return ReleaseManifest.parse(journal.get("manifest"))

    def activate(
        self,
        confirm: bool,
        *,
        intent_id: str | None = None,
        expected_operation_id: str | None = None,
        expected_version: str | None = None,
        expected_generation: int | None = None,
        expected_manifest_sha256: str | None = None,
    ) -> dict[str, object]:
        if not confirm:
            raise UpdaterError(
                "CONFIRMATION_REQUIRED", "Activation requires an explicit confirmation"
            )
        with exclusive_lock(self.config.paths.lock), self._mutation_lease():
            journal = self._journal()
            if not journal or journal.get("phase") != "installed":
                raise UpdaterError(
                    "NOT_READY", "No completely verified inactive slot is ready"
                )
            require_expected_staged_identity(
                journal,
                intent_id=intent_id,
                expected_operation_id=expected_operation_id,
                expected_version=expected_version,
                expected_generation=expected_generation,
                expected_manifest_sha256=expected_manifest_sha256,
            )
            manifest = self._manifest_from_journal(journal)
            preflight = self.preflight.run(
                manifest,
                self.trust.load(),
                bundle_length=0,
                repair=bool(journal["repair"]),
            )
            disk = preflight.disk
            self._require_journal_disk(disk, journal)
            if (disk.active_slot, disk.inactive_slot) != (
                journal.get("sourceSlot"),
                journal.get("targetSlot"),
            ):
                raise TrustError("Active/inactive slots changed after staging")
            record = self._require_clean_boot_control(
                disk,
                expected_manifest_sha256=str(journal["sourceManifestSha256"]),
            )
            source = str(journal["sourceSlot"])
            target = str(journal["targetSlot"])
            pending = pending_record(
                record,
                source=source,
                target=target,
                generation=manifest.host_generation,
                manifest_sha256=manifest.digest,
            )
            transition = BootTransition.create("activate", record, pending)
            journal = self._write_journal(
                journal,
                "activation-intent",
                bootTransition=transition.json(),
            )
            self.boot_control.write(pending, disk)
            self._write_journal(journal, "pending", trialCount=0, bootTransition=None)
            status = self._status(
                "restarting",
                "Restarting into the staged update for verification",
                operationId=journal["operationId"],
                intentId=journal.get("intentId"),
                targetSlot=target,
                targetVersion=manifest.version,
                targetGeneration=manifest.host_generation,
                manifestSha256=manifest.digest,
                trial=1,
            )
            self.runner.run(["systemctl", "reboot"], timeout=10)
            return status

    def cancel(
        self,
        *,
        intent_id: str | None = None,
        expected_operation_id: str | None = None,
        expected_version: str | None = None,
        expected_generation: int | None = None,
        expected_manifest_sha256: str | None = None,
    ) -> dict[str, object]:
        with exclusive_lock(self.config.paths.lock), self._mutation_lease():
            journal = self._journal()
            if not journal or journal.get("phase") != "installed":
                raise UpdaterError(
                    "CANCEL_TOO_LATE", "Update can be cancelled only before activation"
                )
            require_expected_staged_identity(
                journal,
                intent_id=intent_id,
                expected_operation_id=expected_operation_id,
                expected_version=expected_version,
                expected_generation=expected_generation,
                expected_manifest_sha256=expected_manifest_sha256,
            )
            disk = self.resolver.resolve()
            self._require_journal_disk(disk, journal)
            record, _ = self.boot_control.validate_disk(
                disk, require_qualification=False
            )
            source = str(journal["sourceSlot"])
            if not (
                disk.active_slot == source
                and is_clean_source_record(
                    record,
                    source=source,
                    generation=int(journal["sourceGeneration"]),
                    manifest_sha256=str(journal["sourceManifestSha256"]),
                )
            ):
                return self._return_to_source(
                    disk,
                    journal,
                    record,
                    "cancelled-interrupted-activation",
                    reboot=disk.active_slot != source,
                )
            manifest = self._manifest_from_journal(journal)
            journal = self._write_journal(journal, "cancelled")
            return self._status(
                "cancelled",
                "Staged update will not be activated",
                operationId=journal["operationId"],
                intentId=journal.get("intentId"),
                targetVersion=manifest.version,
                targetGeneration=manifest.host_generation,
                manifestSha256=manifest.digest,
            )

    def reconcile(self) -> dict[str, object]:
        with exclusive_lock(self.config.paths.lock), self._mutation_lease():
            journal = self._journal()
            active_phases = {"installed", "pending", "probation"} | INTENT_PHASES
            if not journal or journal.get("phase") not in active_phases:
                return self.status()
            disk = self.resolver.resolve()
            self._require_journal_disk(disk, journal)
            source = str(journal["sourceSlot"])
            target = str(journal["targetSlot"])
            source_generation = int(journal["sourceGeneration"])
            source_manifest = str(journal["sourceManifestSha256"])
            target_generation = int(journal["targetGeneration"])
            record, _ = self.boot_control.validate_disk(disk)
            phase = str(journal["phase"])
            if (
                phase == "installed"
                and disk.active_slot == source
                and is_clean_source_record(
                    record,
                    source=source,
                    generation=source_generation,
                    manifest_sha256=source_manifest,
                )
            ):
                return self.status()
            if disk.active_slot == source:
                return self._return_to_source(
                    disk, journal, record, "bootloader-fallback", reboot=False
                )
            if disk.active_slot != target:
                raise TrustError(
                    "Booted slot is neither staged candidate nor recorded fallback"
                )
            if phase == "installed":
                return self._return_to_source(
                    disk, journal, record, "activation-journal-mismatch", reboot=True
                )
            if phase == "return-intent":
                return self._return_to_source(
                    disk,
                    journal,
                    record,
                    str(journal.get("rollbackReason") or "interrupted-return"),
                    reboot=True,
                )
            trial_count = int(journal.get("trialCount", 0))
            manifest = self._manifest_from_journal(journal)
            identity = {
                "source": source,
                "target": target,
                "source_generation": source_generation,
                "source_manifest_sha256": source_manifest,
                "target_generation": target_generation,
                "manifest_sha256": manifest.digest,
            }
            if phase == "activation-intent":
                transition = BootTransition.parse(journal.get("bootTransition"))
                if (
                    transition.kind == "activate"
                    and selector_consumed_transition_matches(
                        transition, record, slot=target
                    )
                    and is_pending_record(record, tries_remaining=1, **identity)
                ):
                    journal = self._write_journal(
                        journal, "pending", trialCount=0, bootTransition=None
                    )
                    phase = "pending"
                elif transition.kind == "activate" and transition.matches_to(record):
                    journal = self._write_journal(
                        journal, "pending", trialCount=0, bootTransition=None
                    )
                    status = self._status(
                        "restarting",
                        "Restarting into the staged update for verification",
                        operationId=journal["operationId"],
                        intentId=journal.get("intentId"),
                        trial=1,
                    )
                    self.runner.run(["systemctl", "reboot"], timeout=10)
                    return status
                else:
                    return self._return_to_source(
                        disk,
                        journal,
                        record,
                        "activation-transition-incomplete",
                        reboot=True,
                    )
            if phase == "probation-intent":
                transition = BootTransition.parse(journal.get("bootTransition"))
                if (
                    transition.kind == "probation"
                    and selector_consumed_transition_matches(
                        transition, record, slot=target
                    )
                    and is_probation_record(record, tries_remaining=2, **identity)
                ):
                    journal = self._write_journal(
                        journal, "probation", bootTransition=None
                    )
                    phase = "probation"
                elif transition.kind == "probation" and transition.matches_to(record):
                    journal = self._write_journal(
                        journal, "probation", bootTransition=None
                    )
                    status = self._status(
                        "verifying",
                        "Two trials passed; starting committed probation",
                        operationId=journal["operationId"],
                        intentId=journal.get("intentId"),
                        trial=3,
                        health=journal.get("health"),
                    )
                    self.runner.run(["systemctl", "reboot"], timeout=10)
                    return status
                else:
                    return self._return_to_source(
                        disk,
                        journal,
                        record,
                        "probation-transition-incomplete",
                        reboot=True,
                    )
            if phase == "success-intent":
                transition = BootTransition.parse(journal.get("bootTransition"))
                health = journal.get("health")
                if (
                    transition.kind == "success"
                    and transition.matches_to(record)
                    and is_successful_record(record, **identity)
                    and valid_health_evidence(health)
                ):
                    journal = self._write_journal(
                        journal, "complete", bootTransition=None
                    )
                    return self._status(
                        "complete",
                        "Host update completed successfully",
                        operationId=journal["operationId"],
                        intentId=journal.get("intentId"),
                        targetGeneration=target_generation,
                        manifestSha256=manifest.digest,
                        health=health,
                    )
                return self._return_to_source(
                    disk,
                    journal,
                    record,
                    "success-transition-incomplete",
                    reboot=True,
                )
            if (
                phase == "pending"
                and trial_count == 1
                and is_pending_record(record, tries_remaining=1, **identity)
            ) or (
                phase == "probation"
                and is_probation_record(record, tries_remaining=3, **identity)
            ):
                status = self._status(
                    "verifying",
                    "Waiting for the next boot before continuing verification",
                    operationId=journal["operationId"],
                    intentId=journal.get("intentId"),
                    health=journal.get("health"),
                )
                self.runner.run(["systemctl", "reboot"], timeout=10)
                return status
            try:
                require_trial_record(
                    record,
                    source=source,
                    target=target,
                    source_generation=source_generation,
                    source_manifest_sha256=source_manifest,
                    generation=target_generation,
                    manifest_sha256=manifest.digest,
                    phase=phase,
                    trial_count=trial_count,
                )
                result = self.health.run(
                    disk,
                    target,
                    target_generation,
                    self.trust.load().maximum_trusted_time,
                )
            except Exception as error:
                reason = (
                    error.code
                    if isinstance(error, UpdaterError)
                    else "BOOT_STATE_MISMATCH"
                    if isinstance(error, TrustError)
                    else "HEALTH_INTERNAL_ERROR"
                )
                return self._return_to_source(
                    disk, journal, record, reason, reboot=True
                )
            if phase == "pending" and trial_count == 0:
                journal = self._write_journal(
                    journal, "pending", trialCount=1, health=result.checks
                )
                status = self._status(
                    "verifying",
                    "First trial passed; repeating the candidate boot",
                    operationId=journal["operationId"],
                    intentId=journal.get("intentId"),
                    targetGeneration=journal["targetGeneration"],
                    manifestSha256=journal["manifestSha256"],
                    trial=2,
                    health=result.checks,
                )
                self.runner.run(["systemctl", "reboot"], timeout=10)
                return status
            if phase == "pending" and trial_count == 1:
                committed = probation_record(record, source=source, target=target)
                transition = BootTransition.create("probation", record, committed)
                journal = self._write_journal(
                    journal,
                    "probation-intent",
                    trialCount=2,
                    health=result.checks,
                    bootTransition=transition.json(),
                )
                self.boot_control.write(committed, disk)
                journal = self._write_journal(journal, "probation", bootTransition=None)
                status = self._status(
                    "verifying",
                    "Two trials passed; starting committed probation",
                    operationId=journal["operationId"],
                    intentId=journal.get("intentId"),
                    targetGeneration=journal["targetGeneration"],
                    manifestSha256=journal["manifestSha256"],
                    trial=3,
                    health=result.checks,
                )
                self.runner.run(["systemctl", "reboot"], timeout=10)
                return status
            successful = successful_record(record, target=target)
            transition = BootTransition.create("success", record, successful)
            journal = self._write_journal(
                journal,
                "success-intent",
                health=result.checks,
                bootTransition=transition.json(),
            )
            self.boot_control.write(successful, disk)
            journal = self._write_journal(journal, "complete", bootTransition=None)
            return self._status(
                "complete",
                "Host update completed successfully",
                operationId=journal["operationId"],
                intentId=journal.get("intentId"),
                targetGeneration=journal["targetGeneration"],
                manifestSha256=journal["manifestSha256"],
                health=result.checks,
            )

    def export_diagnostics(self) -> dict[str, object]:
        output = self.config.paths.state / "diagnostics.json"
        value = {
            "schema": "stugu-host-update-diagnostics/v1",
            "createdAt": now(),
            "status": self.status(),
            "journalPresent": self.journal_path.exists(),
            "trust": self.trust.load().to_payload(),
        }
        atomic_json(output, value, mode=0o640)
        return {
            "schema": "stugu-host-update-diagnostics-result/v1",
            "path": str(output),
        }

    def handle(self, request: dict[str, object]) -> dict[str, object]:
        operation = request["operation"]
        try:
            if operation == "status":
                return self.status()
            if operation == "hardware-id":
                return self.hardware_id()
            if operation == "check":
                return self.check(
                    str(request.get("channel", "stable")),
                    str(request["intentId"]) if "intentId" in request else None,
                )
            if operation == "stage":
                return self.stage(
                    str(request.get("channel", "stable")),
                    bool(request.get("repair", False)),
                    str(request["intentId"]) if "intentId" in request else None,
                    str(request["expectedVersion"])
                    if "expectedVersion" in request
                    else None,
                    int(request["expectedGeneration"])
                    if "expectedGeneration" in request
                    else None,
                    str(request["expectedManifestSha256"])
                    if "expectedManifestSha256" in request
                    else None,
                )
            if operation == "activate":
                return self.activate(
                    bool(request.get("confirm", False)),
                    intent_id=(
                        str(request["intentId"]) if "intentId" in request else None
                    ),
                    expected_operation_id=(
                        str(request["expectedOperationId"])
                        if "expectedOperationId" in request
                        else None
                    ),
                    expected_version=(
                        str(request["expectedVersion"])
                        if "expectedVersion" in request
                        else None
                    ),
                    expected_generation=(
                        int(request["expectedGeneration"])
                        if "expectedGeneration" in request
                        else None
                    ),
                    expected_manifest_sha256=(
                        str(request["expectedManifestSha256"])
                        if "expectedManifestSha256" in request
                        else None
                    ),
                )
            if operation == "cancel":
                return self.cancel(
                    intent_id=(
                        str(request["intentId"]) if "intentId" in request else None
                    ),
                    expected_operation_id=(
                        str(request["expectedOperationId"])
                        if "expectedOperationId" in request
                        else None
                    ),
                    expected_version=(
                        str(request["expectedVersion"])
                        if "expectedVersion" in request
                        else None
                    ),
                    expected_generation=(
                        int(request["expectedGeneration"])
                        if "expectedGeneration" in request
                        else None
                    ),
                    expected_manifest_sha256=(
                        str(request["expectedManifestSha256"])
                        if "expectedManifestSha256" in request
                        else None
                    ),
                )
            if operation == "reconcile":
                return self.reconcile()
            if operation == "export-diagnostics":
                return self.export_diagnostics()
            raise ContractError("Unsupported operation")
        except UpdaterError as error:
            if operation not in {"activate", "cancel"}:
                self._status(
                    "failed",
                    str(error),
                    intentId=request.get("intentId"),
                    errorCode=error.code,
                )
            raise
        except Exception:
            self._status(
                "failed",
                "Host updater failed internally",
                intentId=request.get("intentId"),
                errorCode="INTERNAL_ERROR",
            )
            raise
