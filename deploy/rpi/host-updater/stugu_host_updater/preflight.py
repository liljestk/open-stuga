"""Host, data, interlock, and rollback checks performed before slot mutation."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import time
from typing import Iterable

from .command import CommandRunner
from .config import UpdaterConfig
from .contracts import ReleaseManifest
from .durable import TrustState
from .errors import ActivationBlocked, PreflightError
from .platform import ApplianceDisk, DeviceResolver
from .rauc import hash_prefix


ACTIVE_PHASES = frozenset(
    {
        "queued",
        "preparing",
        "validating",
        "backup",
        "backing-up",
        "quiescing",
        "copying",
        "pulling",
        "applying",
        "verifying",
        "rolling-back",
        "manual-intervention",
        "mutation-active",
        "termination-uncertain",
    }
)
INACTIVE_PHASES = frozenset(
    {"cancelled", "complete", "disabled", "failed", "idle", "ready", "returned"}
)
DEFAULT_INTERLOCKS = (
    Path("/persistent/stugu/update-operations/status.json"),
    Path("/persistent/stugu/update-operations/update-journal.json"),
    Path("/persistent/stugu/update-operations/storage-status.json"),
    Path("/persistent/stugu/update-operations/storage-journal.json"),
    Path("/persistent/stugu/migration/checkpoint.json"),
    Path("/persistent/stugu/restore-operations/status.json"),
)
REQUIRED_EEPROM_SETTINGS = {
    "BOOT_ORDER": "0xf14",
    "ENABLE_SELF_UPDATE": "1",
    "USB_MSD_PWR_OFF_TIME": "0",
}
REQUIRED_HOST_EXECUTABLES = (
    Path("/usr/bin/rauc"),
    Path("/usr/bin/unsquashfs"),
)


@dataclass(frozen=True)
class PreflightResult:
    disk: ApplianceDisk
    trusted_time: int
    available_bytes: int


class Preflight:
    def __init__(
        self,
        config: UpdaterConfig,
        resolver: DeviceResolver | None = None,
        runner: CommandRunner | None = None,
        interlocks: Iterable[Path] = DEFAULT_INTERLOCKS,
        eeprom_incompatible: Path = Path("/run/stugu-eeprom-incompatible"),
    ) -> None:
        self.config = config
        self.runner = runner or CommandRunner()
        self.resolver = resolver or DeviceResolver(self.runner)
        self.interlocks = tuple(interlocks)
        self.eeprom_incompatible = eeprom_incompatible

    def trusted_time(self, trust: TrustState) -> int:
        now = int(time.time())
        result = self.runner.run(
            ["timedatectl", "show", "--property=NTPSynchronized", "--value"],
            timeout=10,
            check=False,
        )
        if result.returncode != 0 or result.stdout.strip().lower() != "yes":
            raise PreflightError(
                "TIME_UNTRUSTED",
                "System time is not synchronized; signed metadata cannot be refreshed",
            )
        if now < trust.maximum_trusted_time:
            raise PreflightError(
                "CLOCK_ROLLBACK",
                "System clock is earlier than the last trusted update time",
            )
        return now

    def _interlocks(self) -> None:
        for path in self.interlocks:
            try:
                if "journal" in path.name and path.exists():
                    raise PreflightError(
                        "MUTATION_INTERLOCK",
                        "An appliance mutation journal requires reconciliation",
                    )
                value = json.loads(path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                continue
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
                raise PreflightError(
                    "MUTATION_INTERLOCK",
                    f"Cannot verify appliance interlock {path.name}",
                ) from error
            if not isinstance(value, dict):
                raise PreflightError(
                    "MUTATION_INTERLOCK",
                    f"Cannot verify appliance interlock {path.name}",
                )
            operation = value.get("operation")
            if operation is not None and not isinstance(operation, dict):
                raise PreflightError(
                    "MUTATION_INTERLOCK",
                    f"Cannot verify appliance interlock {path.name}",
                )
            phases = (
                value.get("phase"),
                operation.get("phase") if isinstance(operation, dict) else None,
            )
            if any(phase in ACTIVE_PHASES for phase in phases):
                raise PreflightError(
                    "MUTATION_INTERLOCK", f"Appliance operation {path.name} is active"
                )
            if any(
                phase is not None
                and (not isinstance(phase, str) or phase not in INACTIVE_PHASES)
                for phase in phases
            ):
                raise PreflightError(
                    "MUTATION_INTERLOCK",
                    f"Cannot verify appliance interlock {path.name}",
                )

    def _hardware_identity(self) -> None:
        try:
            model = (
                Path("/proc/device-tree/model")
                .read_bytes()
                .rstrip(b"\x00")
                .decode("ascii")
            )
        except (OSError, UnicodeDecodeError) as error:
            raise PreflightError(
                "HARDWARE_IDENTITY_UNKNOWN", "Raspberry Pi model cannot be verified"
            ) from error
        if "Raspberry Pi 4" not in model:
            raise PreflightError(
                "HARDWARE_INCOMPATIBLE", "This host is not a qualified Raspberry Pi 4"
            )

    @staticmethod
    def _runtime_dependencies() -> None:
        for path in REQUIRED_HOST_EXECUTABLES:
            if not path.is_file() or not os.access(path, os.X_OK):
                raise PreflightError(
                    "HOST_RUNTIME_INCOMPLETE",
                    f"Host updater runtime dependency is unavailable: {path.name}",
                )

    def _hardware(self, manifest: ReleaseManifest) -> None:
        self._hardware_identity()
        self._eeprom_configuration()
        try:
            build = Path(
                "/proc/device-tree/chosen/bootloader/build-timestamp"
            ).read_bytes()
            if len(build) != 4:
                raise ValueError("wrong timestamp length")
            current_eeprom = int.from_bytes(build, "big")
            minimum = manifest.min_eeprom
            if minimum.isdecimal():
                minimum_eeprom = int(minimum)
            else:
                minimum_eeprom = int(
                    datetime.strptime(minimum, "%Y-%m-%d")
                    .replace(tzinfo=timezone.utc)
                    .timestamp()
                )
        except (OSError, UnicodeDecodeError, ValueError, OverflowError) as error:
            raise PreflightError(
                "EEPROM_VERSION_UNKNOWN",
                "Pi EEPROM version or signed minimum is invalid",
            ) from error
        if current_eeprom < minimum_eeprom:
            raise PreflightError(
                "EEPROM_TOO_OLD", "Update requires a recovery-class local EEPROM update"
            )

    def _eeprom_configuration(self) -> None:
        if self.eeprom_incompatible.exists() or self.eeprom_incompatible.is_symlink():
            raise PreflightError(
                "EEPROM_CONFIGURATION_INCOMPATIBLE",
                "Pi EEPROM USB settings require recovery-class local maintenance",
            )
        output = self.runner.run(["rpi-eeprom-config"], timeout=15).stdout
        for name, expected in REQUIRED_EEPROM_SETTINGS.items():
            values = [
                line.split("=", 1)[1].strip()
                for line in output.splitlines()
                if line.startswith(f"{name}=")
            ]
            if values != [expected]:
                raise PreflightError(
                    "EEPROM_CONFIGURATION_INCOMPATIBLE",
                    "Pi EEPROM USB settings differ from the appliance contract",
                )

    def _manifest(
        self, manifest: ReleaseManifest, trust: TrustState, repair: bool
    ) -> None:
        if (
            manifest.product != self.config.product
            or manifest.layout != self.config.layout
        ):
            raise PreflightError(
                "PLATFORM_INCOMPATIBLE",
                "Signed update targets another appliance layout",
            )
        if self.config.model not in manifest.models:
            raise PreflightError(
                "HARDWARE_INCOMPATIBLE",
                "Signed update does not support this Raspberry Pi model",
            )
        if manifest.min_contract > self.config.updater_contract:
            raise PreflightError(
                "UPDATER_TOO_OLD",
                "The host updater must be upgraded by a recovery release first",
            )
        if manifest.result_contract < self.config.updater_contract:
            raise PreflightError(
                "CONTRACT_ROLLBACK", "Signed update would lower the updater contract"
            )
        if manifest.boot_shim_generation > self.config.boot_shim_generation:
            raise PreflightError(
                "BOOT_SHIM_TOO_OLD",
                "Update requires a separately qualified boot-shim update",
            )
        if manifest.recovery_class_update:
            raise ActivationBlocked(
                "Recovery-class boot updates require local recovery workflow"
            )
        if not manifest.data.permits_automatic_from(self.config.data_epoch):
            raise PreflightError(
                "DATA_EPOCH_INCOMPATIBLE",
                "Update is not automatically rollback-safe for persistent data",
            )
        if manifest.data.epoch not in self.config.readable_data_epochs:
            raise PreflightError(
                "FALLBACK_DATA_INCOMPATIBLE",
                "The current fallback host cannot read the candidate data epoch",
            )
        if manifest.migrations:
            raise PreflightError(
                "MIGRATION_EXECUTOR_UNAVAILABLE",
                "This updater contract does not execute persistent-data migrations",
            )
        if manifest.container_release_schema != 3:
            raise PreflightError(
                "CONTAINER_CONTRACT_INCOMPATIBLE",
                "Candidate containers use an unsupported release contract",
            )
        if (
            manifest.runtime.docker_epoch != self.config.docker_epoch
            or manifest.runtime.tailscale_epoch != self.config.tailscale_epoch
        ):
            raise PreflightError(
                "RUNTIME_EPOCH_INCOMPATIBLE",
                "Shared runtime state is not rollback-compatible",
            )
        if manifest.host_generation < self.config.host_generation:
            raise PreflightError(
                "HOST_ROLLBACK_REJECTED",
                "Signed update generation is below the running host generation",
            )
        if manifest.host_generation < trust.highest_host_generation:
            raise PreflightError(
                "HOST_ROLLBACK_REJECTED",
                "Signed update generation is below the highest accepted generation",
            )
        if manifest.host_generation == trust.highest_host_generation:
            exact = manifest.digest == trust.highest_manifest_sha256
            if self.config.host_generation == manifest.host_generation:
                # Factory bootstrap establishes the running generation as a
                # rollback floor before any signed release manifest has been
                # accepted. Permit one explicit repair to bind that missing
                # digest after TUF and RAUC verification; once bound, every
                # same-generation repair must remain exact.
                factory_digest_unbound = trust.highest_manifest_sha256 is None
                if not repair or (not exact and not factory_digest_unbound):
                    raise PreflightError(
                        "HOST_REINSTALL_REJECTED",
                        "Same-generation reinstall requires exact signed repair mode",
                    )
            elif not exact:
                raise PreflightError(
                    "HOST_GENERATION_EQUIVOCATION",
                    "Candidate differs from the previously accepted manifest for this generation",
                )
        if manifest.minimum_fallback_generation > self.config.host_generation:
            raise PreflightError(
                "FALLBACK_INCOMPATIBLE",
                "Current known-good slot is below the signed fallback floor",
            )

    @staticmethod
    def _shared_boot_compatibility(
        manifest: ReleaseManifest, disk: ApplianceDisk
    ) -> None:
        """Keep ordinary A/B updates compatible with the immutable p1 boot payload."""

        active_boot = disk.slot(disk.active_slot, "boot")
        if (
            manifest.artifacts.boot_size != active_boot.size
            or hash_prefix(active_boot.path, manifest.artifacts.boot_size)
            != manifest.artifacts.boot_sha256
        ):
            raise ActivationBlocked(
                "Kernel or firmware changes require a recovery-class update while "
                "the direct-boot payload is shared"
            )

    def _environment(self, trust: TrustState, *, bundle_length: int) -> PreflightResult:
        self._runtime_dependencies()
        trusted_time = self.trusted_time(trust)
        self._interlocks()
        disk = self.resolver.resolve()
        persistent = disk.partitions["persistent"]
        mounted_source = self.runner.run(
            [
                "findmnt",
                "--noheadings",
                "--output",
                "SOURCE",
                "--target",
                str(self.config.paths.persistent_mount),
            ],
            timeout=10,
            check=False,
        )
        if (
            mounted_source.returncode != 0
            or Path(os.path.realpath(mounted_source.stdout.strip())) != persistent.path
        ):
            raise PreflightError(
                "PERSISTENT_IDENTITY_MISMATCH",
                "Persistent data is not mounted from the appliance partition",
            )
        if not os.access(self.config.paths.persistent_mount, os.W_OK):
            raise PreflightError(
                "PERSISTENT_READ_ONLY", "Persistent data is not writable"
            )
        available = shutil.disk_usage(self.config.paths.persistent_mount).free
        if available < bundle_length + 256 * 1024**2:
            raise PreflightError(
                "STAGING_SPACE_LOW", "Not enough space to stage this update"
            )
        return PreflightResult(disk, trusted_time, available)

    def prepare(self, trust: TrustState, *, bundle_length: int) -> PreflightResult:
        """Run immutable host/storage checks before downloading a target."""
        self._hardware_identity()
        return self._environment(trust, bundle_length=bundle_length)

    def run(
        self,
        manifest: ReleaseManifest,
        trust: TrustState,
        *,
        bundle_length: int,
        repair: bool = False,
    ) -> PreflightResult:
        self._manifest(manifest, trust, repair)
        self._hardware(manifest)
        result = self._environment(trust, bundle_length=bundle_length)
        self._shared_boot_compatibility(manifest, result.disk)
        return result
