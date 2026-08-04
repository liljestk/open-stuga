from __future__ import annotations

from pathlib import Path
import json
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from stugu_host_updater.config import Paths, UpdaterConfig
from stugu_host_updater.contracts import ReleaseManifest
from stugu_host_updater.durable import TrustState
from stugu_host_updater.errors import ActivationBlocked, PreflightError
from stugu_host_updater.preflight import Preflight

from .support import release_manifest


def config() -> UpdaterConfig:
    return UpdaterConfig(
        metadata_base_url="https://updates.example.test/metadata/",
        target_base_url="https://updates.example.test/targets/",
        targets={"stable": "stable/stugu.raucb"},
        product="stugu-rpi4-usb",
        layout="stugu-gpt-ab-v2",
        model="raspberry-pi-4",
        host_generation=41,
        updater_contract=4,
        boot_shim_generation=1,
        data_epoch=6,
        readable_data_epochs=(6, 7),
        docker_epoch=2,
        tailscale_epoch=1,
        maximum_bundle_bytes=4 * 1024**3,
        paths=Paths(
            state=Path("/state"),
            cache=Path("/cache"),
            immutable_root=Path("/root.json"),
            rauc_keyring=Path("/ca.pem"),
            qualification=Path("/qualification.json"),
            socket=Path("/run/socket"),
            lock=Path("/run/lock"),
            persistent_mount=Path("/persistent"),
            release_manifest_name="stugu-host-manifest.json",
        ),
    )


def trust(highest: int = 41, digest: str | None = "d" * 64) -> TrustState:
    return TrustState(1, "f" * 64, highest, digest, 40, 0, {}, 1)


class PreflightPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.preflight = Preflight(config(), interlocks=())

    def test_host_runtime_requires_rauc_tools_and_service_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rauc = root / "rauc"
            unsquashfs = root / "unsquashfs"
            rauc_service = root / "rauc.service"
            dbus_activation = root / "de.pengutronix.rauc.service"
            dbus_policy = root / "de.pengutronix.rauc.conf"
            service_launcher = root / "rauc-service.sh"
            for executable in (rauc, unsquashfs):
                executable.write_text("#!/bin/sh\n", encoding="ascii")
                executable.chmod(0o755)
            for service_file in (
                rauc_service,
                dbus_activation,
                dbus_policy,
                service_launcher,
            ):
                service_file.write_text("service\n", encoding="ascii")
            with (
                patch(
                    "stugu_host_updater.preflight.REQUIRED_HOST_EXECUTABLES",
                    (rauc, unsquashfs),
                ),
                patch(
                    "stugu_host_updater.preflight.REQUIRED_HOST_SERVICE_FILES",
                    (rauc_service, dbus_activation, dbus_policy, service_launcher),
                ),
            ):
                self.preflight._runtime_dependencies()
                unsquashfs.unlink()
                with self.assertRaisesRegex(PreflightError, "unsquashfs"):
                    self.preflight._runtime_dependencies()
                unsquashfs.write_text("#!/bin/sh\n", encoding="ascii")
                unsquashfs.chmod(0o755)
                dbus_activation.unlink()
                with self.assertRaisesRegex(
                    PreflightError, "de.pengutronix.rauc.service"
                ):
                    self.preflight._runtime_dependencies()

    def test_generation_rollback_and_unapproved_reinstall_are_rejected(self) -> None:
        with self.assertRaisesRegex(PreflightError, "below the"):
            self.preflight._manifest(
                ReleaseManifest.parse(release_manifest(40)), trust(), False
            )
        same = ReleaseManifest.parse(release_manifest(41))
        with self.assertRaisesRegex(PreflightError, "repair mode"):
            self.preflight._manifest(same, trust(41, same.digest), False)
        self.preflight._manifest(same, trust(41, same.digest), True)

    def test_running_host_generation_is_an_independent_rollback_floor(self) -> None:
        with self.assertRaisesRegex(PreflightError, "running host"):
            self.preflight._manifest(
                ReleaseManifest.parse(release_manifest(40)), trust(39), False
            )

    def test_repair_requires_exact_same_signed_manifest(self) -> None:
        same = ReleaseManifest.parse(release_manifest(41))
        with self.assertRaisesRegex(PreflightError, "repair mode"):
            self.preflight._manifest(same, trust(41, "e" * 64), True)

    def test_factory_generation_can_bind_its_first_signed_repair_manifest(self) -> None:
        same = ReleaseManifest.parse(release_manifest(41))
        with self.assertRaisesRegex(PreflightError, "repair mode"):
            self.preflight._manifest(same, trust(41, None), False)
        self.preflight._manifest(same, trust(41, None), True)

    def test_previously_seen_new_generation_can_stage_only_the_exact_manifest(
        self,
    ) -> None:
        candidate = ReleaseManifest.parse(release_manifest(42))
        self.preflight._manifest(candidate, trust(42, candidate.digest), False)
        with self.assertRaisesRegex(PreflightError, "previously accepted"):
            self.preflight._manifest(candidate, trust(42, "e" * 64), False)

    def test_fallback_floor_is_compared_with_the_running_known_good_host(self) -> None:
        candidate = release_manifest(42)
        candidate["rollback"]["minimumFallbackGeneration"] = 42  # type: ignore[index]
        with self.assertRaisesRegex(PreflightError, "known-good"):
            self.preflight._manifest(
                ReleaseManifest.parse(candidate),
                trust(42, ReleaseManifest.parse(candidate).digest),
                False,
            )

    def test_runtime_and_data_epoch_changes_fail_closed(self) -> None:
        raw = release_manifest()
        raw["runtimeState"]["dockerEpoch"] = 3  # type: ignore[index]
        with self.assertRaisesRegex(PreflightError, "runtime state"):
            self.preflight._manifest(ReleaseManifest.parse(raw), trust(), False)
        with self.assertRaisesRegex(PreflightError, "rollback-safe"):
            self.preflight._manifest(
                ReleaseManifest.parse(release_manifest(rollback="restore-required")),
                trust(),
                False,
            )
        self.preflight.config = self.preflight.config.__class__(
            **{**self.preflight.config.__dict__, "readable_data_epochs": (6,)}
        )
        with self.assertRaisesRegex(PreflightError, "fallback host"):
            self.preflight._manifest(
                ReleaseManifest.parse(release_manifest()), trust(), False
            )

    def test_undeclared_executor_and_container_contract_fail_closed(self) -> None:
        raw = release_manifest()
        raw["migrations"] = [
            {
                "id": "data-v7",
                "filename": "migration-data-v7.json",
                "sha256": "a" * 64,
                "kind": "filesystem",
                "backwardCompatible": True,
            }
        ]
        with self.assertRaisesRegex(PreflightError, "does not execute"):
            self.preflight._manifest(ReleaseManifest.parse(raw), trust(), False)
        raw = release_manifest()
        raw["containers"]["releaseSchema"] = 4  # type: ignore[index]
        with self.assertRaisesRegex(PreflightError, "container"):
            self.preflight._manifest(ReleaseManifest.parse(raw), trust(), False)

    def test_recovery_class_boot_mutation_is_not_an_ordinary_update(self) -> None:
        raw = release_manifest()
        raw["bootShim"]["requiresRecoveryClassUpdate"] = True  # type: ignore[index]
        with self.assertRaisesRegex(ActivationBlocked, "Recovery-class"):
            self.preflight._manifest(ReleaseManifest.parse(raw), trust(), False)

    def test_ordinary_update_must_keep_the_shared_boot_payload(self) -> None:
        manifest = ReleaseManifest.parse(release_manifest())
        boot = SimpleNamespace(path=Path("/dev/sda2"), size=256 * 1024**2)
        disk = SimpleNamespace(active_slot="a", slot=lambda suffix, kind: boot)
        with patch(
            "stugu_host_updater.preflight.hash_prefix",
            return_value=manifest.artifacts.boot_sha256,
        ):
            self.preflight._shared_boot_compatibility(manifest, disk)
        with (
            patch("stugu_host_updater.preflight.hash_prefix", return_value="f" * 64),
            self.assertRaisesRegex(ActivationBlocked, "Kernel or firmware"),
        ):
            self.preflight._shared_boot_compatibility(manifest, disk)

    def test_updater_and_boot_shim_minimums_are_enforced(self) -> None:
        raw = release_manifest()
        raw["updater"]["minContract"] = 5  # type: ignore[index]
        raw["updater"]["resultContract"] = 5  # type: ignore[index]
        with self.assertRaisesRegex(PreflightError, "upgraded"):
            self.preflight._manifest(ReleaseManifest.parse(raw), trust(), False)
        raw = release_manifest()
        raw["bootShim"]["minGeneration"] = 2  # type: ignore[index]
        with self.assertRaisesRegex(PreflightError, "boot-shim"):
            self.preflight._manifest(ReleaseManifest.parse(raw), trust(), False)

    def test_actual_container_and_storage_journals_interlock_host_updates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            update_journal = root / "update-journal.json"
            update_journal.write_text("{}", encoding="utf-8")
            guarded = Preflight(config(), interlocks=(update_journal,))
            with self.assertRaisesRegex(PreflightError, "requires reconciliation"):
                guarded._interlocks()

            update_journal.unlink()
            storage_status = root / "storage-status.json"
            storage_status.write_text(
                json.dumps({"operation": {"phase": "copying"}}), encoding="utf-8"
            )
            guarded.interlocks = (storage_status,)
            with self.assertRaisesRegex(PreflightError, "is active"):
                guarded._interlocks()
            storage_status.write_text(
                json.dumps({"operation": {"phase": "complete"}}), encoding="utf-8"
            )
            guarded._interlocks()
            for malformed in ([], {"operation": "unknown"}, {"phase": "future"}):
                storage_status.write_text(json.dumps(malformed), encoding="utf-8")
                with (
                    self.subTest(malformed=malformed),
                    self.assertRaisesRegex(PreflightError, "Cannot verify"),
                ):
                    guarded._interlocks()

    def test_eeprom_configuration_must_match_the_usb_boot_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "incompatible"

            class Runner:
                output = (
                    "BOOT_ORDER=0xf14\nENABLE_SELF_UPDATE=1\nUSB_MSD_PWR_OFF_TIME=0\n"
                )

                def run(self, *_: object, **__: object):
                    return SimpleNamespace(stdout=self.output)

            runner = Runner()
            guarded = Preflight(
                config(), runner=runner, interlocks=(), eeprom_incompatible=marker
            )
            guarded._eeprom_configuration()
            runner.output = runner.output.replace(
                "BOOT_ORDER=0xf14", "BOOT_ORDER=0xf41"
            )
            with self.assertRaisesRegex(PreflightError, "differ"):
                guarded._eeprom_configuration()
            runner.output = runner.output.replace(
                "BOOT_ORDER=0xf41", "BOOT_ORDER=0xf14"
            )
            marker.write_text("", encoding="ascii")
            with self.assertRaisesRegex(PreflightError, "recovery-class"):
                guarded._eeprom_configuration()


if __name__ == "__main__":
    unittest.main()
