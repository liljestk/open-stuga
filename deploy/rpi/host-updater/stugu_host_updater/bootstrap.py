"""Idempotently seed unused fixed boot-control records on factory images."""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import stat
import struct

from .bootcontrol import (
    BootstrapReceipt,
    BootRecord,
    RECORD_OFFSETS,
    RECORD_SIZE,
    RESERVED_END,
    RESERVED_START,
    SlotState,
)
from .command import CommandRunner
from .config import UpdaterConfig
from .contracts import canonical_json
from .durable import atomic_json, read_bounded_regular
from .errors import ActivationBlocked, ContractError, TrustError, UpdaterError
from .platform import ApplianceDisk, DeviceResolver


BOOTCONFIG_MOUNT = Path("/bootfs")
SELECTOR = Path("/usr/bin/stugu-boot-select")
ZERO_SHA256 = "0" * 64


def fat_filesystem_bytes(sector: bytes) -> int:
    if len(sector) != 512 or sector[510:512] != b"\x55\xaa":
        raise ActivationBlocked("Bootconfig does not contain a valid FAT boot sector")
    bytes_per_sector = struct.unpack_from("<H", sector, 11)[0]
    total16 = struct.unpack_from("<H", sector, 19)[0]
    total32 = struct.unpack_from("<I", sector, 32)[0]
    total = total16 or total32
    if bytes_per_sector not in {512, 1024, 2048, 4096} or total <= 0:
        raise ActivationBlocked("Bootconfig FAT geometry is invalid")
    return bytes_per_sector * total


def require_reserved_tail(partition_bytes: int, filesystem_bytes: int) -> None:
    """Reject layout v1: its FAT occupies the bytes reserved by layout v2."""
    if partition_bytes < RESERVED_END:
        raise ActivationBlocked("Bootconfig lacks the reserved boot-control tail")
    if filesystem_bytes > RESERVED_START:
        raise ActivationBlocked(
            "Bootconfig FAT overlaps the reserved boot-control tail"
        )


class FactoryBootstrap:
    def __init__(
        self,
        config: UpdaterConfig,
        runner: CommandRunner | None = None,
        resolver: DeviceResolver | None = None,
    ) -> None:
        self.config = config
        self.runner = runner or CommandRunner()
        self.resolver = resolver or DeviceResolver(self.runner)
        self.receipt_path = config.paths.state / "bootstrap-receipt.json"

    def _seed_digest(self) -> str:
        immutable_root = read_bounded_regular(
            self.config.paths.immutable_root, maximum=512 * 1024
        )
        assert isinstance(immutable_root, bytes)
        identity = {
            "schema": "stugu-factory-host-seed/v1",
            "product": self.config.product,
            "layout": self.config.layout,
            "hostGeneration": self.config.host_generation,
            "immutableRootSha256": hashlib.sha256(immutable_root).hexdigest(),
        }
        return hashlib.sha256(canonical_json(identity)).hexdigest()

    def _record(self, disk: ApplianceDisk, sequence: int) -> BootRecord:
        state = SlotState(self.config.host_generation, self._seed_digest(), True, 3)
        return BootRecord(
            sequence=sequence,
            disk_guid=disk.disk_guid,
            bootconfig_partuuid=disk.partitions["bootconfig"].partuuid,
            committed=disk.active_slot,
            pending=None,
            fallback=disk.inactive_slot,
            state="successful",
            slots={"a": state, "b": state},
        )

    def _validate_layout(self, disk: ApplianceDisk) -> None:
        partition = disk.partitions["bootconfig"]
        descriptor = os.open(partition.path, os.O_RDONLY | os.O_CLOEXEC)
        try:
            filesystem_bytes = fat_filesystem_bytes(os.pread(descriptor, 512, 0))
        finally:
            os.close(descriptor)
        require_reserved_tail(partition.size, filesystem_bytes)
        source = self.runner.run(
            [
                "findmnt",
                "--noheadings",
                "--output",
                "SOURCE,OPTIONS",
                "--target",
                str(BOOTCONFIG_MOUNT),
            ],
            timeout=10,
            check=False,
        )
        fields = source.stdout.strip().split()
        if (
            source.returncode != 0
            or len(fields) != 2
            or Path(os.path.realpath(fields[0])) != partition.path
            or "ro" not in fields[1].split(",")
        ):
            raise ActivationBlocked(
                "Bootconfig must be mounted read-only from the appliance disk"
            )

    @staticmethod
    def _existing(data: bytes, expected: BootRecord) -> bool:
        if data == bytes(RECORD_SIZE):
            return False
        try:
            decoded = BootRecord.decode(data)
        except ContractError as error:
            raise TrustError(
                "Reserved boot-control bytes are neither empty nor valid"
            ) from error
        if decoded != expected:
            raise TrustError(
                "Existing boot-control seed differs from this factory identity"
            )
        return True

    def _initialize_records(self, disk: ApplianceDisk) -> None:
        partition_info = disk.partitions["bootconfig"]
        partition = partition_info.path
        stable = Path("/dev/disk/by-partuuid") / partition_info.partuuid
        expected = (self._record(disk, 1), self._record(disk, 2))
        flags = os.O_RDWR | os.O_CLOEXEC | getattr(os, "O_DSYNC", 0)
        descriptor = os.open(stable, flags)
        unmounted = False
        try:
            opened = os.fstat(descriptor)
            if (
                not stat.S_ISBLK(opened.st_mode)
                or opened.st_rdev != os.stat(stable).st_rdev
                or opened.st_rdev != os.stat(partition).st_rdev
            ):
                raise TrustError(
                    "Factory boot-control device identity changed while opening"
                )
            existing = tuple(
                self._existing(os.pread(descriptor, RECORD_SIZE, offset), record)
                for offset, record in zip(RECORD_OFFSETS, expected, strict=True)
            )
            if all(existing):
                return
            self.runner.run(["umount", str(BOOTCONFIG_MOUNT)], timeout=30)
            unmounted = True
            mounted = self.runner.run(
                ["findmnt", "--noheadings", "--source", str(stable)],
                timeout=10,
                check=False,
            )
            if mounted.returncode == 0 and mounted.stdout.strip():
                raise ActivationBlocked(
                    "Bootconfig remains mounted before factory raw write"
                )
            for present, offset, record in zip(
                existing, RECORD_OFFSETS, expected, strict=True
            ):
                if present:
                    continue
                if os.pwrite(descriptor, record.encode(), offset) != RECORD_SIZE:
                    raise UpdaterError(
                        "BOOT_CONTROL_SHORT_WRITE",
                        "Factory boot-control initialization was incomplete",
                    )
            os.fsync(descriptor)
            self.runner.run(["blockdev", "--flushbufs", str(stable)], timeout=30)
            for offset, record in zip(RECORD_OFFSETS, expected, strict=True):
                if (
                    BootRecord.decode(os.pread(descriptor, RECORD_SIZE, offset))
                    != record
                ):
                    raise TrustError(
                        "Factory boot-control read-back verification failed"
                    )
        finally:
            try:
                os.close(descriptor)
            finally:
                if unmounted:
                    remount = self.runner.run(
                        [
                            "mount",
                            "--options",
                            "ro",
                            str(stable),
                            str(BOOTCONFIG_MOUNT),
                        ],
                        timeout=30,
                        check=False,
                    )
                    if remount.returncode != 0:
                        raise UpdaterError(
                            "BOOTCONFIG_REMOUNT_FAILED",
                            "Bootconfig could not be restored read-only",
                        )

    def _validate_existing_receipt(self, disk: ApplianceDisk) -> None:
        receipt = BootstrapReceipt.load(self.receipt_path)
        partition = disk.partitions["bootconfig"]
        if (
            receipt.disk_guid != disk.disk_guid
            or receipt.bootconfig_partuuid != partition.partuuid
            or Path(os.path.realpath(receipt.bootconfig_device)) != partition.path
            or receipt.boot_shim_generation != self.config.boot_shim_generation
        ):
            raise TrustError(
                "Bootstrap receipt does not match the firmware-selected appliance disk"
            )
        valid = 0
        descriptor = os.open(partition.path, os.O_RDONLY | os.O_CLOEXEC)
        try:
            for offset in RECORD_OFFSETS:
                try:
                    record = BootRecord.decode(
                        os.pread(descriptor, RECORD_SIZE, offset)
                    )
                except ContractError:
                    continue
                if (
                    record.disk_guid != disk.disk_guid
                    or record.bootconfig_partuuid.lower() != partition.partuuid
                ):
                    raise TrustError(
                        "Boot-control record belongs to another appliance disk"
                    )
                valid += 1
        finally:
            os.close(descriptor)
        if valid == 0:
            raise TrustError("Both boot-control records are invalid")
        selector_sha = (
            hashlib.sha256(SELECTOR.read_bytes()).hexdigest()
            if SELECTOR.is_file() and not SELECTOR.is_symlink()
            else ZERO_SHA256
        )
        if selector_sha != receipt.selector_sha256:
            raise TrustError("Boot selector differs from the bootstrap receipt")

    def run(self) -> None:
        disk = self.resolver.resolve()
        self._validate_layout(disk)
        if self.receipt_path.exists():
            self._validate_existing_receipt(disk)
            return
        self._initialize_records(disk)
        selector_sha = (
            hashlib.sha256(SELECTOR.read_bytes()).hexdigest()
            if SELECTOR.is_file() and not SELECTOR.is_symlink()
            else ZERO_SHA256
        )
        receipt = {
            "schema": "stugu-bootstrap-receipt/v1",
            "diskGuid": disk.disk_guid,
            "bootconfigPartuuid": disk.partitions["bootconfig"].partuuid,
            "bootconfigDevice": str(
                Path("/dev/disk/by-partuuid") / disk.partitions["bootconfig"].partuuid
            ),
            "mountpoint": str(BOOTCONFIG_MOUNT),
            "recordSize": RECORD_SIZE,
            "recordOffsets": list(RECORD_OFFSETS),
            "bootShimGeneration": self.config.boot_shim_generation,
            "selectorPath": str(SELECTOR),
            "selectorSha256": selector_sha,
        }
        atomic_json(self.receipt_path, receipt)
        BootstrapReceipt.load(self.receipt_path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="stugu-host-bootstrap")
    parser.add_argument(
        "--config", type=Path, default=Path("/etc/stugu-host-update/config.json")
    )
    args = parser.parse_args(argv)
    FactoryBootstrap(UpdaterConfig.load(args.config)).run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
