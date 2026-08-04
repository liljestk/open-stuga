from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from stugu_host_updater.command import CommandResult
from stugu_host_updater.errors import PreflightError
from stugu_host_updater.platform import (
    ApplianceDisk,
    DeviceResolver,
    LINUX_FILESYSTEM,
    MICROSOFT_BASIC_DATA,
    hardware_fingerprint,
)


class FakeRunner:
    def __init__(self, payload: dict[str, object]) -> None:
        self.payload = payload

    def run(self, argv: list[str], **_: object) -> CommandResult:
        if argv[0].endswith("stugu-usb-bootdev"):
            return CommandResult("sda\n", "", 0)
        if argv[0] == "lsblk":
            return CommandResult(json.dumps(self.payload), "", 0)
        if argv[0] == "blkid":
            return CommandResult("9b9ba270-1dd2-4b49-9600-123456789abc\n", "", 0)
        raise AssertionError(argv)


def inventory() -> dict[str, object]:
    definitions = (
        ("bootconfig", 1, 96 * 1024**2, "vfat", MICROSOFT_BASIC_DATA),
        ("boot_a", 2, 256 * 1024**2, "vfat", MICROSOFT_BASIC_DATA),
        ("boot_b", 3, 256 * 1024**2, "vfat", MICROSOFT_BASIC_DATA),
        ("system_a", 4, 3 * 1024**3, "erofs", LINUX_FILESYSTEM),
        ("system_b", 5, 3 * 1024**3, "erofs", LINUX_FILESYSTEM),
        ("persistent", 6, 2 * 1024**3, "ext4", LINUX_FILESYSTEM),
    )
    children = []
    for label, number, size, fstype, parttype in definitions:
        children.append(
            {
                "name": f"/dev/sda{number}",
                "path": f"/dev/sda{number}",
                "type": "part",
                "size": size,
                "fstype": fstype,
                "partlabel": label,
                "partuuid": f"00000000-0000-4000-8000-{number:012d}",
                "parttype": parttype,
                "partn": number,
                "pkname": "/dev/sda",
            }
        )
    return {
        "blockdevices": [
            {
                "name": "/dev/sda",
                "path": "/dev/sda",
                "type": "disk",
                "size": 16 * 1024**3,
                "serial": "storejet-1",
                "model": "TS240GESD230C",
                "children": children,
            }
        ]
    }


def realpath(value: object) -> str:
    path = Path(value).as_posix()
    return {
        "/dev/disk/by-slot/active/system": "/dev/sda4",
        "/dev/disk/by-slot/a/boot": "/dev/sda2",
        "/dev/disk/by-slot/a/system": "/dev/sda4",
        "/dev/disk/by-slot/b/boot": "/dev/sda3",
        "/dev/disk/by-slot/b/system": "/dev/sda5",
    }.get(path, path)


class DeviceResolverTests(unittest.TestCase):
    def resolve(self, value: dict[str, object]):
        with (
            patch("stugu_host_updater.platform.require_block_device"),
            patch("stugu_host_updater.platform.os.path.realpath", side_effect=realpath),
        ):
            return DeviceResolver(FakeRunner(value), Path("/dev")).resolve()

    def test_exact_layout_and_aliases_resolve(self) -> None:
        disk = self.resolve(inventory())
        self.assertEqual(disk.active_slot, "a")
        self.assertEqual(disk.disk_model, "TS240GESD230C")
        self.assertEqual(disk.partitions["persistent"].number, 6)

    def test_partition_type_mismatch_fails_closed(self) -> None:
        value = inventory()
        value["blockdevices"][0]["children"][5]["parttype"] = MICROSOFT_BASIC_DATA  # type: ignore[index]
        with self.assertRaisesRegex(PreflightError, "layout v2"):
            self.resolve(value)

    def test_boot_filesystem_must_be_identified(self) -> None:
        value = inventory()
        value["blockdevices"][0]["children"][1]["fstype"] = ""  # type: ignore[index]
        with self.assertRaisesRegex(PreflightError, "layout v2"):
            self.resolve(value)

    def test_partition_uuids_must_be_unique(self) -> None:
        value = inventory()
        children = value["blockdevices"][0]["children"]  # type: ignore[index]
        children[1]["partuuid"] = children[0]["partuuid"]  # type: ignore[index]
        with self.assertRaisesRegex(PreflightError, "not unique"):
            self.resolve(value)


class HardwareFingerprintTests(unittest.TestCase):
    def fixture(self, root: Path, *, sysfs_model: bytes, inventory_model: str):
        proc_root = root / "proc"
        sys_root = root / "sys"
        block_path = sys_root / "class" / "block" / "sda"
        storage_device = block_path / "device"
        storage_device.mkdir(parents=True)

        (storage_device / "idVendor").write_bytes(b"152d\n")
        (storage_device / "idProduct").write_bytes(b"0578\n")
        (storage_device / "bcdDevice").write_bytes(b"0209\n")
        (storage_device / "bInterfaceClass").write_bytes(b"08\n")
        (storage_device / "driver").mkdir()
        (storage_device / "vendor").write_bytes(b"StoreJet\n")
        (storage_device / "model").write_bytes(sysfs_model)
        (storage_device / "rev").write_bytes(b"0\n")

        (proc_root / "device-tree" / "chosen" / "bootloader").mkdir(parents=True)
        (proc_root / "device-tree" / "model").write_bytes(
            b"Raspberry Pi 4 Model B Rev 1.1\x00"
        )
        timestamp_path = (
            proc_root / "device-tree" / "chosen" / "bootloader" / "build-timestamp"
        )
        timestamp_path.write_bytes((1_700_000_000).to_bytes(4, byteorder="big"))
        (proc_root / "cpuinfo").write_text(
            "Hardware\t: BCM2711\nRevision\t: c03111\n", encoding="ascii"
        )
        disk = ApplianceDisk(
            Path("/dev/sda"),
            "sda",
            "9b9ba270-1dd2-4b49-9600-123456789abc",
            "79132267G54068580363",
            inventory_model,
            {},
            "a",
        )
        return disk, proc_root, sys_root

    def test_blank_sysfs_model_uses_inventory_model(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            disk, proc_root, sys_root = self.fixture(
                root, sysfs_model=b"                \n", inventory_model="TS240GESD230C"
            )
            fallback_fingerprint = hardware_fingerprint(
                disk, proc_root=proc_root, sys_root=sys_root
            )
            storage_model = sys_root / "class" / "block" / "sda" / "device" / "model"
            storage_model.write_bytes(b"TS240GESD230C\n")
            primary_fingerprint = hardware_fingerprint(
                disk, proc_root=proc_root, sys_root=sys_root
            )
            self.assertEqual(fallback_fingerprint, primary_fingerprint)

    def test_blank_sysfs_and_inventory_models_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            disk, proc_root, sys_root = self.fixture(
                Path(temporary), sysfs_model=b" \n", inventory_model=" "
            )
            with self.assertRaisesRegex(PreflightError, "Storage model is invalid"):
                hardware_fingerprint(disk, proc_root=proc_root, sys_root=sys_root)

    def test_nonblank_sysfs_model_takes_precedence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            disk, proc_root, sys_root = self.fixture(
                root, sysfs_model=b"Existing model\n", inventory_model="fallback-one"
            )
            first = hardware_fingerprint(disk, proc_root=proc_root, sys_root=sys_root)
            changed_fallback = ApplianceDisk(
                disk.path,
                disk.name,
                disk.disk_guid,
                disk.disk_serial,
                "fallback-two",
                disk.partitions,
                disk.active_slot,
            )
            second = hardware_fingerprint(
                changed_fallback, proc_root=proc_root, sys_root=sys_root
            )
            self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
