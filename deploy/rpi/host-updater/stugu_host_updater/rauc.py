"""RAUC signed-bundle inspection, installation, and read-back verification."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import re
import shutil
import tempfile
from typing import Iterator

from .command import CommandRunner
from .contracts import ReleaseManifest
from .errors import ContractError, TrustError, UpdaterError
from .platform import ApplianceDisk


@dataclass(frozen=True)
class InspectedBundle:
    manifest: ReleaseManifest
    rauc_manifest_hash: str
    compatible: str
    bundle_format: str


def _walk(value: object) -> Iterator[tuple[str, object]]:
    if isinstance(value, dict):
        for key, item in value.items():
            yield str(key), item
            yield from _walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from _walk(item)


def _field(value: object, names: set[str]) -> object | None:
    normalized = {name.replace("_", "-").lower() for name in names}
    for key, item in _walk(value):
        if key.replace("_", "-").lower() in normalized:
            return item
    return None


def _nonempty_hooks(value: object) -> bool:
    for key, item in _walk(value):
        if key.replace("_", "-").lower() in {"hook", "hooks"} and item not in (
            None,
            "",
            [],
            {},
        ):
            return True
    return False


def _rauc_extraction_destination(parent: Path) -> Path:
    parent.mkdir(mode=0o700, exist_ok=True)
    destination = Path(tempfile.mkdtemp(prefix="bundle-", dir=parent))
    # RAUC 1.13 creates the destination itself and rejects an existing
    # directory. The private parent makes reserving then removing this
    # unpredictable name safe from substitution by other users.
    destination.rmdir()
    return destination


def _parse_info(
    value: object,
) -> tuple[str, str, str, str, dict[str, dict[str, object]]]:
    if not isinstance(value, dict):
        raise TrustError("RAUC returned an invalid bundle description")
    update = value.get("update")
    bundle = value.get("bundle")
    images = value.get("images")
    if (
        not isinstance(update, dict)
        or not isinstance(bundle, dict)
        or not isinstance(images, list)
    ):
        raise TrustError("RAUC returned an incomplete bundle description")
    compatible = update.get("compatible")
    version = update.get("version")
    manifest_hash = value.get("manifest-hash")
    bundle_format = bundle.get("format")
    if not isinstance(compatible, str) or not compatible:
        raise TrustError("RAUC bundle does not declare compatibility")
    if not isinstance(version, str) or not version:
        raise TrustError("RAUC bundle does not declare a version")
    if not isinstance(manifest_hash, str) or not re.fullmatch(
        r"[0-9a-f]{64}", manifest_hash
    ):
        raise TrustError("RAUC did not report a signed manifest hash")
    if bundle_format != "verity":
        raise TrustError("Only RAUC verity bundles are accepted")
    if _nonempty_hooks(value):
        raise ContractError(
            "RAUC bundle hooks are not allowed by host-release contract v1"
        )
    declared: dict[str, dict[str, object]] = {}
    if len(images) != 2:
        raise ContractError("RAUC bundle must declare exactly boot and rootfs images")
    for image in images:
        if not isinstance(image, dict):
            raise ContractError("RAUC image declaration is invalid")
        slot_class = image.get("slot-class")
        if slot_class not in {"boot", "rootfs"} or slot_class in declared:
            raise ContractError("RAUC image classes are invalid or duplicated")
        if (
            not isinstance(image.get("filename"), str)
            or not isinstance(image.get("checksum"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", str(image.get("checksum")))
            or isinstance(image.get("size"), bool)
            or not isinstance(image.get("size"), int)
            or int(image["size"]) < 4096
        ):
            raise ContractError("RAUC image declaration is incomplete")
        declared[str(slot_class)] = image
    return compatible, version, manifest_hash, str(bundle_format), declared


class RaucClient:
    def __init__(
        self,
        keyring: Path,
        runner: CommandRunner | None = None,
        config_path: Path = Path("/etc/rauc/system.conf"),
    ) -> None:
        self.keyring = keyring
        self.runner = runner or CommandRunner()
        self.config_path = config_path

    def _base(self) -> list[str]:
        return ["rauc", f"--conf={self.config_path}", f"--keyring={self.keyring}"]

    def inspect(
        self,
        bundle: Path,
        manifest_name: str,
        *,
        extraction_root: Path | None = None,
    ) -> InspectedBundle:
        info = self.runner.run(
            [*self._base(), "info", "--output-format=json-2", str(bundle)], timeout=120
        ).json("rauc info")
        compatible, version, manifest_hash, bundle_format, image_declarations = (
            _parse_info(info)
        )

        extraction = _rauc_extraction_destination(
            extraction_root or bundle.parent / ".inspection"
        )
        try:
            self.runner.run(
                [*self._base(), "extract", str(bundle), str(extraction)], timeout=300
            )
            manifest_path = extraction / manifest_name
            if not manifest_path.is_file() or manifest_path.is_symlink():
                raise ContractError(
                    "RAUC bundle lacks the signed Stugu release manifest"
                )
            manifest = ReleaseManifest.from_bytes(manifest_path.read_bytes())
            if version != manifest.version:
                raise ContractError("RAUC and Stugu release versions do not match")
            allowed = {
                manifest_name,
                manifest.container_manifest_file,
                "boot.vfat",
                "system.erofs",
                manifest.supply_chain.sbom_file,
                manifest.supply_chain.provenance_file,
                *(migration.filename for migration in manifest.migrations),
            }
            extracted = set()
            for path in extraction.iterdir():
                if not path.is_file() or path.is_symlink():
                    raise ContractError(
                        "RAUC bundle contains a non-regular top-level entry"
                    )
                extracted.add(path.name)
            if extracted - {"manifest.raucm"} != allowed:
                raise ContractError(
                    "RAUC bundle contents do not exactly match the signed release contract"
                )
            signed_files = (
                (manifest.container_manifest_file, manifest.container_manifest_sha256),
                (manifest.supply_chain.sbom_file, manifest.supply_chain.sbom_sha256),
                (
                    manifest.supply_chain.provenance_file,
                    manifest.supply_chain.provenance_sha256,
                ),
                *(
                    (migration.filename, migration.sha256)
                    for migration in manifest.migrations
                ),
            )
            for filename, expected_sha in signed_files:
                if hash_file(extraction / filename) != expected_sha:
                    raise TrustError(
                        f"Signed bundle metadata digest failed for {filename}"
                    )
            expected_images = {
                "boot": (
                    "boot.vfat",
                    manifest.artifacts.boot_sha256,
                    manifest.artifacts.boot_size,
                ),
                "rootfs": (
                    "system.erofs",
                    manifest.artifacts.root_sha256,
                    manifest.artifacts.root_size,
                ),
            }
            for slot_class, (
                filename,
                expected_sha,
                expected_size,
            ) in expected_images.items():
                declaration = image_declarations[slot_class]
                path = extraction / filename
                if (
                    declaration["filename"] != filename
                    or declaration["checksum"] != expected_sha
                    or declaration["size"] != expected_size
                    or path.stat().st_size != expected_size
                    or hash_file(path) != expected_sha
                ):
                    raise TrustError(
                        f"RAUC {slot_class} image does not match the signed release contract"
                    )
        finally:
            shutil.rmtree(extraction, ignore_errors=True)
        return InspectedBundle(manifest, manifest_hash, compatible, bundle_format)

    def install(
        self,
        bundle: Path,
        operation_id: str,
        expected_sha256: str,
        expected_length: int,
    ) -> None:
        if (
            bundle.stat().st_size != expected_length
            or hash_file(bundle) != expected_sha256
        ):
            raise TrustError("Verified bundle changed before RAUC installation")
        os.chmod(bundle, 0o400)
        self.runner.run(
            [
                *self._base(),
                "install",
                f"--transaction-id={operation_id}",
                str(bundle),
            ],
            timeout=60 * 60,
        )
        if (
            bundle.stat().st_size != expected_length
            or hash_file(bundle) != expected_sha256
        ):
            raise TrustError("Verified bundle changed during RAUC installation")

    def status(self) -> object:
        return self.runner.run(
            [*self._base(), "status", "--detailed", "--output-format=json"], timeout=30
        ).json("rauc status")

    def verify_inactive(self, disk: ApplianceDisk, manifest: ReleaseManifest) -> None:
        suffix = disk.inactive_slot
        expected = (
            (
                disk.slot(suffix, "boot").path,
                manifest.artifacts.boot_size,
                manifest.artifacts.boot_sha256,
            ),
            (
                disk.slot(suffix, "system").path,
                manifest.artifacts.root_size,
                manifest.artifacts.root_sha256,
            ),
        )
        for path, length, digest in expected:
            self.runner.run(["blockdev", "--flushbufs", str(path)], timeout=30)
            if hash_prefix(path, length) != digest:
                raise TrustError(
                    f"Read-back verification failed for inactive {path.name}"
                )


def hash_prefix(path: Path, length: int) -> str:
    digest = hashlib.sha256()
    remaining = length
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
        try:
            while remaining:
                block = os.read(descriptor, min(8 * 1024 * 1024, remaining))
                if not block:
                    raise UpdaterError(
                        "SLOT_READBACK_SHORT",
                        f"{path} ended before the signed image length",
                    )
                digest.update(block)
                remaining -= len(block)
        finally:
            os.close(descriptor)
    except OSError as error:
        raise UpdaterError(
            "SLOT_READBACK_FAILED", f"Cannot verify inactive slot {path}"
        ) from error
    return digest.hexdigest()


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
    except OSError as error:
        raise UpdaterError(
            "BUNDLE_CONTENT_READ_FAILED", f"Cannot verify {path.name}"
        ) from error
    return digest.hexdigest()
