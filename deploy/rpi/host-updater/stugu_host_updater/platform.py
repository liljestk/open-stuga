"""Exact firmware-selected disk and immutable six-partition layout checks."""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import stat
from typing import Any
import uuid

from .command import CommandRunner
from .errors import PreflightError


MICROSOFT_BASIC_DATA = "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7"
LINUX_FILESYSTEM = "0fc63daf-8483-4772-8e79-3d69d8477de4"
EXPECTED_PARTITIONS = {
    "bootconfig": (1, 96 * 1024**2, "vfat", MICROSOFT_BASIC_DATA),
    "boot_a": (2, 256 * 1024**2, "vfat", MICROSOFT_BASIC_DATA),
    "boot_b": (3, 256 * 1024**2, "vfat", MICROSOFT_BASIC_DATA),
    "system_a": (4, 3 * 1024**3, "erofs", LINUX_FILESYSTEM),
    "system_b": (5, 3 * 1024**3, "erofs", LINUX_FILESYSTEM),
    "persistent": (6, 1 * 1024**3, "ext4", LINUX_FILESYSTEM),
}


@dataclass(frozen=True)
class Partition:
    label: str
    path: Path
    partuuid: str
    number: int
    size: int
    fstype: str


@dataclass(frozen=True)
class ApplianceDisk:
    path: Path
    name: str
    disk_guid: str
    disk_serial: str
    partitions: dict[str, Partition]
    active_slot: str

    @property
    def inactive_slot(self) -> str:
        return "b" if self.active_slot == "a" else "a"

    def slot(self, suffix: str, kind: str) -> Partition:
        return self.partitions[f"{kind}_{suffix}"]


class DeviceResolver:
    def __init__(
        self, runner: CommandRunner | None = None, dev_root: Path = Path("/dev")
    ) -> None:
        self.runner = runner or CommandRunner()
        self.dev_root = dev_root

    def resolve(self) -> ApplianceDisk:
        boot_name = self.runner.run(
            ["/usr/bin/stugu-usb-bootdev"], timeout=15
        ).stdout.strip()
        if not boot_name or "/" in boot_name:
            raise PreflightError(
                "DISK_IDENTITY_INVALID", "Firmware-selected USB disk is invalid"
            )
        disk_path = self.dev_root / boot_name
        require_block_device(disk_path)
        payload = self.runner.run(
            [
                "lsblk",
                "--json",
                "--bytes",
                "--paths",
                "--output",
                "NAME,PATH,TYPE,SIZE,FSTYPE,PARTLABEL,PARTUUID,PARTTYPE,PARTN,PKNAME,SERIAL",
                str(disk_path),
            ],
            timeout=20,
        ).json("lsblk")
        if not isinstance(payload, dict) or not isinstance(
            payload.get("blockdevices"), list
        ):
            raise PreflightError(
                "DISK_LAYOUT_INVALID", "Block-device inventory is malformed"
            )
        devices = payload["blockdevices"]
        if len(devices) != 1 or not isinstance(devices[0], dict):
            raise PreflightError(
                "DISK_IDENTITY_AMBIGUOUS", "Expected exactly one firmware-selected disk"
            )
        disk: dict[str, Any] = devices[0]
        if disk.get("type") != "disk" or Path(str(disk.get("path"))) != disk_path:
            raise PreflightError(
                "DISK_IDENTITY_MISMATCH",
                "Block inventory does not match firmware-selected disk",
            )
        disk_guid = (
            self.runner.run(
                ["blkid", "--match-tag", "PTUUID", "--output", "value", str(disk_path)],
                timeout=10,
            )
            .stdout.strip()
            .lower()
        )
        try:
            disk_guid = str(uuid.UUID(disk_guid))
        except ValueError as error:
            raise PreflightError(
                "DISK_IDENTITY_INVALID", "Appliance GPT disk GUID is invalid"
            ) from error
        children = disk.get("children")
        if not isinstance(children, list) or len(children) != 6:
            raise PreflightError(
                "DISK_LAYOUT_INVALID",
                "Appliance disk must contain exactly six partitions",
            )
        partitions: dict[str, Partition] = {}
        for child in children:
            if not isinstance(child, dict) or child.get("type") != "part":
                raise PreflightError(
                    "DISK_LAYOUT_INVALID", "Unexpected non-partition on appliance disk"
                )
            label = child.get("partlabel")
            if label not in EXPECTED_PARTITIONS or label in partitions:
                raise PreflightError(
                    "DISK_LAYOUT_INVALID", "Partition labels are missing or duplicated"
                )
            expected_number, minimum_size, expected_fstype, expected_parttype = (
                EXPECTED_PARTITIONS[label]
            )
            number = child.get("partn")
            size_value = child.get("size")
            try:
                size = int(size_value)
                number = int(number)
            except (TypeError, ValueError) as error:
                raise PreflightError(
                    "DISK_LAYOUT_INVALID", "Partition size or number is invalid"
                ) from error
            fstype = str(child.get("fstype") or "")
            parttype = str(child.get("parttype") or "").lower()
            # EROFS may be reported as empty while the inactive slot is uninitialized.
            size_matches = (
                size >= minimum_size if label == "persistent" else size == minimum_size
            )
            filesystem_matches = (
                fstype in {"", expected_fstype}
                if label.startswith("system_")
                else fstype == expected_fstype
            )
            if (
                number != expected_number
                or not size_matches
                or not filesystem_matches
                or parttype != expected_parttype
                or Path(str(child.get("pkname") or "")) != disk_path
            ):
                raise PreflightError(
                    "DISK_LAYOUT_INVALID", f"Partition {label} does not match layout v2"
                )
            partuuid = child.get("partuuid")
            path = child.get("path")
            if (
                not isinstance(partuuid, str)
                or not partuuid
                or not isinstance(path, str)
            ):
                raise PreflightError(
                    "DISK_LAYOUT_INVALID", f"Partition {label} lacks stable identity"
                )
            try:
                partuuid = str(uuid.UUID(partuuid))
            except ValueError as error:
                raise PreflightError(
                    "DISK_LAYOUT_INVALID", f"Partition {label} UUID is invalid"
                ) from error
            partition_path = Path(path)
            require_block_device(partition_path)
            partitions[label] = Partition(
                label, partition_path, partuuid, number, size, fstype
            )

        if len({partition.partuuid for partition in partitions.values()}) != len(
            partitions
        ):
            raise PreflightError(
                "DISK_IDENTITY_AMBIGUOUS", "Partition UUIDs are not unique"
            )

        active_system = Path(os.path.realpath("/dev/disk/by-slot/active/system"))
        active_slot = next(
            (
                suffix
                for suffix in ("a", "b")
                if partitions[f"system_{suffix}"].path == active_system
            ),
            None,
        )
        if active_slot is None:
            raise PreflightError(
                "ACTIVE_SLOT_UNKNOWN",
                "Active root is not on the firmware-selected disk",
            )
        for suffix in ("a", "b"):
            for kind in ("boot", "system"):
                alias = Path(f"/dev/disk/by-slot/{suffix}/{kind}")
                if Path(os.path.realpath(alias)) != partitions[f"{kind}_{suffix}"].path:
                    raise PreflightError(
                        "SLOT_ALIAS_MISMATCH", f"Exact-device alias {alias} is invalid"
                    )
        return ApplianceDisk(
            disk_path,
            boot_name,
            disk_guid,
            str(disk.get("serial") or ""),
            partitions,
            active_slot,
        )


def require_block_device(path: Path) -> None:
    try:
        mode = path.stat().st_mode
    except OSError as error:
        raise PreflightError(
            "BLOCK_DEVICE_MISSING", f"Required device {path} is unavailable"
        ) from error
    if not stat.S_ISBLK(mode):
        raise PreflightError(
            "BLOCK_DEVICE_INVALID", f"Required path {path} is not a block device"
        )
