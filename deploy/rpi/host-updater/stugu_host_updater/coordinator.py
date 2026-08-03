"""Durable signed host-update state machine."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
import uuid

from .bootcontrol import BootControlStore, BootRecord, SlotState
from .command import CommandRunner
from .config import UpdaterConfig
from .contracts import (
    CHANNELS,
    HEX_SHA256,
    MAX_JSON_INTEGER,
    ReleaseManifest,
    validate_target_path,
)
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
from .health import HealthChecker
from .metrics import MetricsExporter
from .platform import ApplianceDisk, DeviceResolver, hardware_fingerprint
from .preflight import Preflight
from .rauc import RaucClient
from .repository import TufRepository, VerifiedTarget


JOURNAL_SCHEMA = "stugu-host-update-journal/v1"
STATUS_SCHEMA = "stugu-host-update-status/v1"
REUSABLE_PHASES = frozenset({"complete", "cancelled", "returned"})
JOURNAL_PHASES = REUSABLE_PHASES | frozenset(
    {
        "prepared",
        "installed",
        "pending",
        "probation",
        "failed",
        "recovery-needed",
    }
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


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


def require_trial_record(
    record: BootRecord,
    *,
    source: str,
    target: str,
    generation: int,
    manifest_sha256: str,
    phase: str,
    trial_count: int,
) -> None:
    target_state = record.slots[target]
    if phase == "pending":
        expected_tries = {0: 1, 1: 0}.get(trial_count)
        valid = (
            expected_tries is not None
            and record.committed == source
            and record.pending == target
            and record.fallback == source
            and record.state == "pending"
            and target_state.tries_remaining == expected_tries
        )
    elif phase == "probation" and trial_count == 2:
        valid = (
            record.committed == target
            and record.pending is None
            and record.fallback == source
            and record.state == "probation"
            and target_state.tries_remaining == 2
        )
    else:
        valid = False
    if (
        not valid
        or target_state.generation != generation
        or target_state.manifest_sha256 != manifest_sha256
        or target_state.successful
    ):
        raise TrustError("Boot shim did not durably account for the expected trial")


def fallback_record(record: BootRecord, source: str, target: str) -> BootRecord:
    slots = dict(record.slots)
    slots[source] = replace(slots[source], successful=True, tries_remaining=3)
    slots[target] = replace(slots[target], successful=False, tries_remaining=0)
    return replace(
        record,
        sequence=record.sequence + 1,
        committed=source,
        pending=None,
        fallback=target,
        state="fallback",
        slots=slots,
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
        value: dict[str, object] = {
            "schema": STATUS_SCHEMA,
            "operationId": operation_id,
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
        if isinstance(value, dict) and value.get("schema") == STATUS_SCHEMA:
            return value
        return {
            "schema": STATUS_SCHEMA,
            "operationId": None,
            "phase": "idle",
            "detail": "No host update is active",
            "updatedAt": None,
        }

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
        value = read_json(self.journal_path)
        if value is None:
            return None
        required = {
            "schema",
            "operationId",
            "phase",
            "createdAt",
            "updatedAt",
            "channel",
            "targetPath",
            "targetLength",
            "targetSha256",
            "bundlePath",
            "raucManifestHash",
            "manifest",
            "manifestSha256",
            "sourceSlot",
            "targetSlot",
            "sourceGeneration",
            "targetGeneration",
            "persistentPartuuid",
            "slotPartuuids",
            "trialCount",
            "repair",
        }
        optional = {"health", "rollbackReason", "rollbackError"}
        if (
            not isinstance(value, dict)
            or set(value) - required - optional
            or required - set(value)
            or value.get("schema") != JOURNAL_SCHEMA
            or value.get("phase") not in JOURNAL_PHASES
        ):
            raise TrustError("Persistent host-update journal is invalid")
        try:
            operation_id = str(uuid.UUID(str(value["operationId"])))
            persistent = str(uuid.UUID(str(value["persistentPartuuid"])))
        except ValueError as error:
            raise TrustError(
                "Persistent host-update journal identity is invalid"
            ) from error
        if (
            operation_id != value["operationId"]
            or persistent != value["persistentPartuuid"]
        ):
            raise TrustError("Persistent host-update journal identity is not canonical")
        channel = value["channel"]
        try:
            target_path = validate_target_path(value["targetPath"])
        except ContractError as error:
            raise TrustError(
                "Persistent host-update journal target is invalid"
            ) from error
        if channel not in CHANNELS - {"recovery"} or target_path != value["targetPath"]:
            raise TrustError("Persistent host-update journal target is invalid")
        integers = (
            value["targetLength"],
            value["sourceGeneration"],
            value["targetGeneration"],
            value["trialCount"],
        )
        if (
            any(
                isinstance(item, bool)
                or not isinstance(item, int)
                or not 0 <= item <= MAX_JSON_INTEGER
                for item in integers
            )
            or not 0 < int(value["targetLength"]) <= 8 * 1024**3
        ):
            raise TrustError("Persistent host-update journal counters are invalid")
        if not isinstance(value["repair"], bool):
            raise TrustError("Persistent host-update journal repair mode is invalid")
        phase = str(value["phase"])
        trial_count = int(value["trialCount"])
        phase_trials = {
            "prepared": {0},
            "installed": {0},
            "pending": {0, 1},
            "probation": {2},
            "complete": {2},
            "cancelled": {0},
        }
        if phase in phase_trials and trial_count not in phase_trials[phase]:
            raise TrustError("Persistent host-update journal trial state is invalid")
        if value["sourceSlot"] not in {"a", "b"} or value["targetSlot"] not in {
            "a",
            "b",
        }:
            raise TrustError("Persistent host-update journal slot is invalid")
        if value["sourceSlot"] == value["targetSlot"]:
            raise TrustError("Persistent host-update journal slots overlap")
        for field in ("targetSha256", "raucManifestHash", "manifestSha256"):
            if not isinstance(value[field], str) or not HEX_SHA256.fullmatch(
                str(value[field])
            ):
                raise TrustError("Persistent host-update journal digest is invalid")
        slots = value["slotPartuuids"]
        expected_slots = {"sourceBoot", "sourceSystem", "targetBoot", "targetSystem"}
        if not isinstance(slots, dict) or set(slots) != expected_slots:
            raise TrustError(
                "Persistent host-update journal partition identities are invalid"
            )
        try:
            canonical_slots = [
                str(uuid.UUID(str(slots[name]))) for name in sorted(expected_slots)
            ]
        except ValueError as error:
            raise TrustError(
                "Persistent host-update journal partition UUID is invalid"
            ) from error
        if (
            canonical_slots != [slots[name] for name in sorted(expected_slots)]
            or len(set(canonical_slots)) != 4
        ):
            raise TrustError(
                "Persistent host-update journal partition UUIDs are ambiguous"
            )
        manifest = self._manifest_from_journal(value)
        if (
            manifest.digest != value["manifestSha256"]
            or manifest.host_generation != value["targetGeneration"]
            or manifest.product != self.config.product
            or manifest.layout != self.config.layout
        ):
            raise TrustError("Persistent host-update journal manifest is inconsistent")
        return value

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
        source_state = record.slots[source]
        if source_state.generation != int(journal["sourceGeneration"]):
            raise TrustError(
                "Recorded fallback generation does not match the staged source host"
            )
        already_returned = (
            record.committed == source
            and record.pending is None
            and source_state.successful
            and source_state.generation == int(journal["sourceGeneration"])
        )
        try:
            if not already_returned:
                self.boot_control.write(fallback_record(record, source, target), disk)
        except Exception as error:
            error_code = (
                error.code
                if isinstance(error, UpdaterError)
                else "BOOT_CONTROL_WRITE_FAILED"
                if isinstance(error, OSError)
                else "BOOT_CONTROL_INTERNAL_ERROR"
            )
            self._write_journal(
                journal,
                "recovery-needed",
                rollbackReason=reason,
                rollbackError=error_code,
            )
            status = self._status(
                "recovery-needed",
                "Candidate failed and the fallback record could not be verified",
                operationId=journal["operationId"],
                rollbackReason=reason,
                errorCode=error_code,
            )
            self.runner.run(["systemctl", "reboot"], timeout=10)
            return status
        self._write_journal(journal, "returned", rollbackReason=reason)
        status = self._status(
            "returned",
            "Returned to the previous host version",
            operationId=journal["operationId"],
            rollbackReason=reason,
        )
        if reboot:
            self.runner.run(["systemctl", "reboot"], timeout=10)
        return status

    def check(self, channel: str = "stable") -> dict[str, object]:
        with exclusive_lock(self.config.paths.lock):
            self._status("checking", "Checking signed update metadata")
            target = self._target(channel)
            return self._status(
                "available"
                if target.custom.host_generation > self.config.host_generation
                else "current",
                "A signed host update is available"
                if target.custom.host_generation > self.config.host_generation
                else "Host is current",
                channel=channel,
                targetVersion=target.custom.version,
                targetGeneration=target.custom.host_generation,
                bytes=target.length,
                metadataVersions=target.metadata_versions,
            )

    def stage(self, channel: str = "stable", repair: bool = False) -> dict[str, object]:
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
                channel=channel,
            )
            target = self._target(channel)
            prepared = self.preflight.prepare(
                self.trust.load(), bundle_length=target.length
            )
            self._require_clean_boot_control(prepared.disk, require_qualification=False)
            self._status(
                "downloading",
                "Downloading and verifying the complete signed bundle",
                operationId=operation_id,
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
            self._require_clean_boot_control(disk, require_qualification=False)
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
            atomic_json(self.journal_path, journal)
            self._status(
                "installing",
                "Writing the inactive host slot",
                operationId=operation_id,
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
            return self._status(
                "ready-to-restart",
                "Update is staged in the inactive slot",
                operationId=operation_id,
                targetVersion=manifest.version,
                targetGeneration=manifest.host_generation,
                targetSlot=disk.inactive_slot,
            )

    def _manifest_from_journal(self, journal: dict[str, object]) -> ReleaseManifest:
        return ReleaseManifest.parse(journal.get("manifest"))

    def activate(self, confirm: bool) -> dict[str, object]:
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
            record = self._require_clean_boot_control(disk)
            target = str(journal["targetSlot"])
            slots = dict(record.slots)
            slots[target] = SlotState(
                manifest.host_generation, manifest.digest, False, 2
            )
            pending = replace(
                record,
                sequence=record.sequence + 1,
                committed=str(journal["sourceSlot"]),
                pending=target,
                fallback=str(journal["sourceSlot"]),
                state="pending",
                slots=slots,
            )
            self.boot_control.write(pending, disk)
            self._write_journal(journal, "pending", trialCount=0)
            status = self._status(
                "restarting",
                "Restarting into the staged update for verification",
                operationId=journal["operationId"],
                targetSlot=target,
                trial=1,
            )
            self.runner.run(["systemctl", "reboot"], timeout=10)
            return status

    def cancel(self) -> dict[str, object]:
        with exclusive_lock(self.config.paths.lock), self._mutation_lease():
            journal = self._journal()
            if not journal or journal.get("phase") not in {"prepared", "installed"}:
                raise UpdaterError(
                    "CANCEL_TOO_LATE", "Update can be cancelled only before activation"
                )
            journal = self._write_journal(journal, "cancelled")
            return self._status(
                "cancelled",
                "Staged update will not be activated",
                operationId=journal["operationId"],
            )

    def reconcile(self) -> dict[str, object]:
        with exclusive_lock(self.config.paths.lock), self._mutation_lease():
            journal = self._journal()
            if not journal or journal.get("phase") not in {"pending", "probation"}:
                return self.status()
            disk = self.resolver.resolve()
            self._require_journal_disk(disk, journal)
            source = str(journal["sourceSlot"])
            target = str(journal["targetSlot"])
            record, _ = self.boot_control.validate_disk(disk)
            if disk.active_slot == source:
                return self._return_to_source(
                    disk, journal, record, "bootloader-fallback", reboot=False
                )
            if disk.active_slot != target:
                raise TrustError(
                    "Booted slot is neither staged candidate nor recorded fallback"
                )
            trial_count = int(journal.get("trialCount", 0))
            manifest = self._manifest_from_journal(journal)
            try:
                require_trial_record(
                    record,
                    source=source,
                    target=target,
                    generation=int(journal["targetGeneration"]),
                    manifest_sha256=manifest.digest,
                    phase=str(journal["phase"]),
                    trial_count=trial_count,
                )
                result = self.health.run(
                    disk,
                    target,
                    int(journal["targetGeneration"]),
                    self.trust.load().maximum_trusted_time,
                )
            except Exception as error:
                reason = (
                    error.code
                    if isinstance(error, UpdaterError)
                    else "HEALTH_INTERNAL_ERROR"
                )
                return self._return_to_source(
                    disk, journal, record, reason, reboot=True
                )
            if journal["phase"] == "pending" and trial_count == 0:
                self._write_journal(
                    journal, "pending", trialCount=1, health=result.checks
                )
                status = self._status(
                    "verifying",
                    "First trial passed; repeating the candidate boot",
                    operationId=journal["operationId"],
                    trial=2,
                    health=result.checks,
                )
                self.runner.run(["systemctl", "reboot"], timeout=10)
                return status
            if journal["phase"] == "pending" and trial_count == 1:
                slots = dict(record.slots)
                slots[target] = replace(
                    slots[target], successful=False, tries_remaining=3
                )
                committed = replace(
                    record,
                    sequence=record.sequence + 1,
                    committed=target,
                    pending=None,
                    fallback=source,
                    state="probation",
                    slots=slots,
                )
                self.boot_control.write(committed, disk)
                self._write_journal(
                    journal, "probation", trialCount=2, health=result.checks
                )
                status = self._status(
                    "verifying",
                    "Two trials passed; starting committed probation",
                    operationId=journal["operationId"],
                    trial=3,
                    health=result.checks,
                )
                self.runner.run(["systemctl", "reboot"], timeout=10)
                return status
            slots = dict(record.slots)
            slots[target] = replace(slots[target], successful=True, tries_remaining=3)
            successful = replace(
                record, sequence=record.sequence + 1, state="successful", slots=slots
            )
            self.boot_control.write(successful, disk)
            self._write_journal(journal, "complete", health=result.checks)
            return self._status(
                "complete",
                "Host update completed successfully",
                operationId=journal["operationId"],
                targetGeneration=journal["targetGeneration"],
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
                return self.check(str(request.get("channel", "stable")))
            if operation == "stage":
                return self.stage(
                    str(request.get("channel", "stable")),
                    bool(request.get("repair", False)),
                )
            if operation == "activate":
                return self.activate(bool(request.get("confirm", False)))
            if operation == "cancel":
                return self.cancel()
            if operation == "reconcile":
                return self.reconcile()
            if operation == "export-diagnostics":
                return self.export_diagnostics()
            raise ContractError("Unsupported operation")
        except UpdaterError as error:
            self._status("failed", str(error), errorCode=error.code)
            raise
        except Exception:
            self._status(
                "failed",
                "Host updater failed internally",
                errorCode="INTERNAL_ERROR",
            )
            raise
