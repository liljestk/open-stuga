from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from stugu_host_updater.bootcontrol import (
    BootControlStore,
    BootstrapReceipt,
    BootRecord,
    HARDWARE_ACTIVATION_IMPLEMENTED,
    RECORD_OFFSETS,
    RECORD_SIZE,
    RecordExtent,
    SlotState,
)
from stugu_host_updater.errors import ActivationBlocked, ContractError, TrustError


def record(sequence: int = 10) -> BootRecord:
    return BootRecord(
        sequence=sequence,
        disk_guid="9b9ba270-1dd2-4b49-9600-123456789abc",
        bootconfig_partuuid="11111111-2222-3333-4444-555555555555",
        committed="a",
        pending=None,
        fallback=None,
        state="successful",
        slots={
            "a": SlotState(41, "a" * 64, True, 3),
            "b": SlotState(40, "b" * 64, True, 3),
        },
    )


class BootControlTests(unittest.TestCase):
    def test_hardware_receipt_cannot_enable_unimplemented_activation(self) -> None:
        self.assertFalse(HARDWARE_ACTIVATION_IMPLEMENTED)
        store = BootControlStore(Path("/receipt"), Path("/qualification"), 1)
        with self.assertRaisesRegex(ActivationBlocked, "production selector"):
            store._qualification(object())  # type: ignore[arg-type]

    def test_record_round_trips_in_one_fixed_sector_aligned_extent(self) -> None:
        original = record()
        encoded = original.encode()
        self.assertEqual(len(encoded), RECORD_SIZE)
        self.assertEqual(len(encoded) % 512, 0)
        self.assertEqual(BootRecord.decode(encoded), original)

    def test_torn_or_corrupt_record_is_rejected(self) -> None:
        encoded = bytearray(record().encode())
        encoded[100] ^= 0x80
        with self.assertRaisesRegex(ContractError, "checksum"):
            BootRecord.decode(bytes(encoded))
        with self.assertRaisesRegex(ContractError, "size"):
            BootRecord.decode(bytes(encoded[:-1]))

    def test_pending_record_preserves_exact_fallback(self) -> None:
        current = record()
        slots = dict(current.slots)
        slots["b"] = SlotState(42, "c" * 64, False, 2)
        pending = replace(
            current,
            sequence=current.sequence + 1,
            pending="b",
            fallback="a",
            state="pending",
            slots=slots,
        )
        decoded = BootRecord.decode(pending.encode())
        self.assertEqual(decoded.fallback, "a")
        self.assertEqual(decoded.pending, "b")
        self.assertEqual(decoded.slots["b"].tries_remaining, 2)
        self.assertFalse(decoded.slots["b"].successful)

    def test_sequence_and_try_bounds_fail_closed(self) -> None:
        with self.assertRaisesRegex(ContractError, "sequence"):
            replace(record(), sequence=2**64).encode()
        raw = record().payload()
        raw["slots"]["a"]["triesRemaining"] = 8  # type: ignore[index]
        with self.assertRaisesRegex(ContractError, "triesRemaining"):
            BootRecord.parse(raw, 1)

    def test_same_sequence_divergent_redundant_records_fail_closed(self) -> None:
        first = record()
        second = replace(first, committed="b")
        receipt = BootstrapReceipt(
            disk_guid=first.disk_guid,
            bootconfig_partuuid=first.bootconfig_partuuid,
            bootconfig_device=Path("/dev/disk/by-partuuid/test"),
            mountpoint=Path("/bootfs"),
            records=(RecordExtent(RECORD_OFFSETS[0]), RecordExtent(RECORD_OFFSETS[1])),
            boot_shim_generation=1,
            selector_path=Path("/bootfs/stugu-boot.scr"),
            selector_sha256="0" * 64,
        )
        store = BootControlStore(Path("/receipt"), Path("/qualification"), 1)
        with (
            patch("stugu_host_updater.bootcontrol.os.O_CLOEXEC", 0, create=True),
            patch("stugu_host_updater.bootcontrol.os.open", return_value=7),
            patch(
                "stugu_host_updater.bootcontrol.os.pread",
                side_effect=[first.encode(), second.encode()],
                create=True,
            ),
            patch("stugu_host_updater.bootcontrol.os.close"),
            self.assertRaisesRegex(TrustError, "conflict"),
        ):
            store._read_device(receipt, Path("/dev/sda1"))

    def test_bootstrap_receipt_requires_stable_partuuid_device_identity(self) -> None:
        value = {
            "schema": "stugu-bootstrap-receipt/v1",
            "diskGuid": "9b9ba270-1dd2-4b49-9600-123456789abc",
            "bootconfigPartuuid": "11111111-2222-3333-4444-555555555555",
            "bootconfigDevice": "/dev/disk/by-partuuid/11111111-2222-3333-4444-555555555555",
            "mountpoint": "/bootfs",
            "recordSize": RECORD_SIZE,
            "recordOffsets": list(RECORD_OFFSETS),
            "bootShimGeneration": 1,
            "selectorPath": "/bootfs/stugu-boot.scr",
            "selectorSha256": "0" * 64,
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            path.write_text(json.dumps(value), encoding="utf-8")
            receipt = BootstrapReceipt.load(path)
            self.assertEqual(receipt.bootconfig_device, Path(value["bootconfigDevice"]))
            value["bootconfigDevice"] = "/dev/sda1"
            path.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(ActivationBlocked, "identity"):
                BootstrapReceipt.load(path)

    def test_runtime_shim_generation_must_match_bootstrap_receipt(self) -> None:
        store = BootControlStore(Path("/receipt"), Path("/qualification"), 2)
        receipt = BootstrapReceipt(
            disk_guid=record().disk_guid,
            bootconfig_partuuid=record().bootconfig_partuuid,
            bootconfig_device=Path(
                "/dev/disk/by-partuuid/11111111-2222-3333-4444-555555555555"
            ),
            mountpoint=Path("/bootfs"),
            records=(RecordExtent(RECORD_OFFSETS[0]), RecordExtent(RECORD_OFFSETS[1])),
            boot_shim_generation=1,
            selector_path=Path("/bootfs/stugu-boot.scr"),
            selector_sha256="0" * 64,
        )
        with (
            patch.object(BootstrapReceipt, "load", return_value=receipt),
            self.assertRaisesRegex(ActivationBlocked, "configured boot-shim"),
        ):
            store._receipt(require_qualification=False)


if __name__ == "__main__":
    unittest.main()
