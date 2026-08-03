from __future__ import annotations

import struct
import unittest

from stugu_host_updater.bootstrap import fat_filesystem_bytes, require_reserved_tail
from stugu_host_updater.errors import ActivationBlocked


class FactoryBootstrapTests(unittest.TestCase):
    def test_fat_geometry_stays_before_the_reserved_record_tail(self) -> None:
        sector = bytearray(512)
        struct.pack_into("<H", sector, 11, 512)
        struct.pack_into("<I", sector, 32, 95 * 1024**2 // 512)
        sector[510:512] = b"\x55\xaa"
        self.assertEqual(fat_filesystem_bytes(bytes(sector)), 95 * 1024**2)

    def test_invalid_fat_geometry_fails_closed(self) -> None:
        with self.assertRaisesRegex(ActivationBlocked, "FAT boot sector"):
            fat_filesystem_bytes(bytes(512))

    def test_layout_v1_full_partition_fat_cannot_use_v2_raw_tail(self) -> None:
        with self.assertRaisesRegex(ActivationBlocked, "FAT overlaps"):
            require_reserved_tail(96 * 1024**2, 96 * 1024**2)

    def test_layout_v2_reserves_the_final_mibibyte(self) -> None:
        require_reserved_tail(96 * 1024**2, 95 * 1024**2)


if __name__ == "__main__":
    unittest.main()
