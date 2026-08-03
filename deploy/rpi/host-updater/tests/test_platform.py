from __future__ import annotations

import json
from pathlib import Path
import unittest
from unittest.mock import patch

from stugu_host_updater.command import CommandResult
from stugu_host_updater.errors import PreflightError
from stugu_host_updater.platform import (
    DeviceResolver,
    LINUX_FILESYSTEM,
    MICROSOFT_BASIC_DATA,
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


if __name__ == "__main__":
    unittest.main()
