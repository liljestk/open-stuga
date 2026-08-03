from __future__ import annotations

import copy
from pathlib import Path
import tempfile
import unittest

from stugu_host_updater.errors import ContractError, TrustError
from stugu_host_updater.rauc import _parse_info, _rauc_extraction_destination


def bundle_info() -> dict[str, object]:
    return {
        "update": {
            "version": "1.2.3",
            "compatible": "stugu-rpi4-usb:stugu-gpt-ab-v2:arm64",
        },
        "images": [
            {
                "slot-class": "rootfs",
                "filename": "system.erofs",
                "checksum": "b" * 64,
                "size": 3 * 1024 * 1024 * 1024,
                "hooks": [],
            },
            {
                "slot-class": "boot",
                "filename": "boot.vfat",
                "checksum": "a" * 64,
                "size": 256 * 1024 * 1024,
                "hooks": [],
            },
        ],
        "manifest-hash": "c" * 64,
        "bundle": {"format": "verity", "verity-size": 4096},
        "meta": {},
    }


class RaucInfoTests(unittest.TestCase):
    def test_rauc_extraction_destination_is_reserved_but_does_not_exist(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory) / ".inspection"
            destination = _rauc_extraction_destination(parent)
            self.assertTrue(parent.is_dir())
            self.assertEqual(destination.parent, parent)
            self.assertFalse(destination.exists())

    def test_exact_verity_image_shape_is_accepted(self) -> None:
        compatible, version, manifest_hash, bundle_format, images = _parse_info(
            bundle_info()
        )
        self.assertEqual(compatible, "stugu-rpi4-usb:stugu-gpt-ab-v2:arm64")
        self.assertEqual(version, "1.2.3")
        self.assertEqual(manifest_hash, "c" * 64)
        self.assertEqual(bundle_format, "verity")
        self.assertEqual(set(images), {"boot", "rootfs"})

    def test_hooks_and_duplicate_image_classes_are_rejected(self) -> None:
        with_hook = copy.deepcopy(bundle_info())
        with_hook["images"][1]["hooks"] = ["install"]  # type: ignore[index]
        with self.assertRaisesRegex(ContractError, "hooks"):
            _parse_info(with_hook)

        duplicate = copy.deepcopy(bundle_info())
        duplicate["images"][1]["slot-class"] = "rootfs"  # type: ignore[index]
        with self.assertRaisesRegex(ContractError, "duplicated"):
            _parse_info(duplicate)

    def test_non_verity_and_malformed_manifest_hash_are_rejected(self) -> None:
        plain = copy.deepcopy(bundle_info())
        plain["bundle"]["format"] = "plain"  # type: ignore[index]
        with self.assertRaisesRegex(TrustError, "verity"):
            _parse_info(plain)

        malformed = copy.deepcopy(bundle_info())
        malformed["manifest-hash"] = "not-a-digest"
        with self.assertRaisesRegex(TrustError, "manifest hash"):
            _parse_info(malformed)


if __name__ == "__main__":
    unittest.main()
