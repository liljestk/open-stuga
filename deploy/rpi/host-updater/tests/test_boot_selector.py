from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from stugu_host_updater.bootcontrol import (
    BootRecord,
    RECORD_OFFSETS,
    RECORD_SIZE,
    RESERVED_END,
    SlotState,
)


def record(*, sequence: int = 10, state: str = "successful") -> BootRecord:
    return BootRecord(
        sequence=sequence,
        disk_guid="9b9ba270-1dd2-4b49-9600-123456789abc",
        bootconfig_partuuid="11111111-2222-3333-4444-555555555555",
        committed="a",
        pending="b" if state == "pending" else None,
        fallback="a" if state in {"pending", "probation"} else "b",
        state=state,
        slots={
            "a": SlotState(41, "a" * 64, True, 3),
            "b": SlotState(42, "b" * 64, False, 2),
        },
    )


class BootSelectorTests(unittest.TestCase):
    compiler_directory: tempfile.TemporaryDirectory[str]
    selector: Path

    @classmethod
    def setUpClass(cls) -> None:
        compiler = shutil.which("cc")
        if compiler is None:
            raise unittest.SkipTest("C compiler is unavailable")
        cls.compiler_directory = tempfile.TemporaryDirectory()
        cls.selector = Path(cls.compiler_directory.name) / "stugu-boot-select"
        source = (
            Path(__file__).resolve().parents[2]
            / "boot-selector"
            / "stugu-boot-select.c"
        )
        subprocess.run(
            [
                compiler,
                "-std=c11",
                "-O2",
                "-Wall",
                "-Wextra",
                "-Werror",
                str(source),
                "-o",
                str(cls.selector),
            ],
            check=True,
            capture_output=True,
            text=True,
        )

    @classmethod
    def tearDownClass(cls) -> None:
        if hasattr(cls, "compiler_directory"):
            cls.compiler_directory.cleanup()

    def image(self, records: tuple[bytes, bytes] | None = None) -> Path:
        path = Path(self.temporary.name) / "bootconfig.img"
        with path.open("wb") as handle:
            handle.truncate(RESERVED_END)
            if records is not None:
                for offset, value in zip(RECORD_OFFSETS, records, strict=True):
                    handle.seek(offset)
                    handle.write(value)
        return path

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def select(
        self, image: Path, *, check: bool = True
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(self.selector), "--test-file", str(image)],
            check=check,
            capture_output=True,
            text=True,
        )

    @staticmethod
    def newest(image: Path) -> BootRecord:
        decoded: list[BootRecord] = []
        with image.open("rb") as handle:
            for offset in RECORD_OFFSETS:
                handle.seek(offset)
                decoded.append(BootRecord.decode(handle.read(RECORD_SIZE)))
        return max(decoded, key=lambda item: item.sequence)

    def test_zero_initialized_factory_tail_selects_slot_a(self) -> None:
        image = self.image()
        self.assertEqual(self.select(image).stdout, "a\n")
        with image.open("rb") as handle:
            handle.seek(RECORD_OFFSETS[0])
            self.assertEqual(handle.read(RECORD_SIZE * 2), bytes(RECORD_SIZE * 2))

    def test_pending_attempts_are_durable_and_then_fall_back(self) -> None:
        original = record(state="pending")
        image = self.image((original.encode(), replace(original, sequence=11).encode()))

        self.assertEqual(self.select(image).stdout, "b\n")
        first = self.newest(image)
        self.assertEqual((first.sequence, first.slots["b"].tries_remaining), (12, 1))

        self.assertEqual(self.select(image).stdout, "b\n")
        second = self.newest(image)
        self.assertEqual((second.sequence, second.slots["b"].tries_remaining), (13, 0))

        self.assertEqual(self.select(image).stdout, "a\n")
        self.assertEqual(self.newest(image), second)

    def test_probation_attempt_is_consumed_before_selecting_candidate(self) -> None:
        original = replace(
            record(state="probation"),
            committed="b",
            pending=None,
            fallback="a",
            slots={
                "a": SlotState(41, "a" * 64, True, 3),
                "b": SlotState(42, "b" * 64, False, 3),
            },
        )
        image = self.image((original.encode(), replace(original, sequence=11).encode()))
        self.assertEqual(self.select(image).stdout, "b\n")
        newest = self.newest(image)
        self.assertEqual((newest.sequence, newest.slots["b"].tries_remaining), (12, 2))

    def test_one_corrupt_copy_does_not_hide_the_valid_record(self) -> None:
        valid = record()
        corrupt = bytearray(replace(valid, sequence=11).encode())
        corrupt[100] ^= 0x80
        image = self.image((valid.encode(), bytes(corrupt)))
        self.assertEqual(self.select(image).stdout, "a\n")

    def test_same_sequence_divergence_fails_closed(self) -> None:
        left = record()
        right = replace(left, committed="b")
        image = self.image((left.encode(), right.encode()))
        result = self.select(image, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("conflict", result.stderr)


if __name__ == "__main__":
    unittest.main()
