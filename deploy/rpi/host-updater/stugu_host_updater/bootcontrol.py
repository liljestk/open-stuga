"""Redundant fixed boot-control records in p1's non-filesystem tail.

The final MiB of the 96 MiB bootconfig partition is outside its 95 MiB FAT
image. Both offsets are build-contract constants, never request input, so raw
record updates cannot modify FAT metadata. Activation remains hardware-gated.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import struct
import uuid
import zlib

from .command import CommandRunner
from .contracts import canonical_json, decode_json
from .errors import ActivationBlocked, ContractError, TrustError, UpdaterError
from .platform import ApplianceDisk


RECORD_SIZE = 4096
RESERVED_START = 95 * 1024**2
RESERVED_END = 96 * 1024**2
RECORD_OFFSETS = (RESERVED_START, RESERVED_START + RECORD_SIZE)
WATCHDOG_CONFIG = Path("/etc/systemd/system.conf.d/stugu-watchdog.conf")
MAGIC = b"STUGUBC1"
HEADER = struct.Struct("<8sHHQI")
CRC = struct.Struct("<I")
STATES = frozenset({"successful", "pending", "probation", "fallback", "rescue"})
# Phase 0 has not produced a production selector or a runtime matcher for the
# qualified Pi/EEPROM/USB matrix. A receipt alone must never enable activation.
HARDWARE_ACTIVATION_IMPLEMENTED = False


@dataclass(frozen=True)
class SlotState:
    generation: int
    manifest_sha256: str
    successful: bool
    tries_remaining: int

    @classmethod
    def parse(cls, value: object, path: str) -> "SlotState":
        if not isinstance(value, dict) or set(value) != {
            "generation",
            "manifestSha256",
            "successful",
            "triesRemaining",
        }:
            raise ContractError(f"{path} is invalid")
        generation = value["generation"]
        tries = value["triesRemaining"]
        digest = value["manifestSha256"]
        successful = value["successful"]
        if (
            isinstance(generation, bool)
            or not isinstance(generation, int)
            or not 0 <= generation < 2**64
        ):
            raise ContractError(f"{path}.generation is invalid")
        if isinstance(tries, bool) or not isinstance(tries, int) or not 0 <= tries <= 7:
            raise ContractError(f"{path}.triesRemaining is invalid")
        if not isinstance(successful, bool):
            raise ContractError(f"{path}.successful is invalid")
        if (
            not isinstance(digest, str)
            or len(digest) != 64
            or any(char not in "0123456789abcdef" for char in digest)
        ):
            raise ContractError(f"{path}.manifestSha256 is invalid")
        return cls(generation, digest, successful, tries)

    def json(self) -> dict[str, object]:
        return {
            "generation": self.generation,
            "manifestSha256": self.manifest_sha256,
            "successful": self.successful,
            "triesRemaining": self.tries_remaining,
        }


@dataclass(frozen=True)
class BootRecord:
    sequence: int
    disk_guid: str
    bootconfig_partuuid: str
    committed: str
    pending: str | None
    fallback: str | None
    state: str
    slots: dict[str, SlotState]

    @classmethod
    def parse(cls, value: object, sequence: int) -> "BootRecord":
        expected = {
            "schema",
            "diskGuid",
            "bootconfigPartuuid",
            "committed",
            "pending",
            "fallback",
            "state",
            "slots",
        }
        if (
            not isinstance(value, dict)
            or set(value) != expected
            or value.get("schema") != "stugu-boot-control/v1"
        ):
            raise ContractError("boot-control payload is invalid")
        for key in ("diskGuid", "bootconfigPartuuid"):
            if (
                not isinstance(value[key], str)
                or not 1 <= len(value[key]) <= 80
                or not value[key].isascii()
            ):
                raise ContractError(f"boot-control {key} is invalid")
        for key in ("committed", "pending", "fallback"):
            if value[key] is not None and value[key] not in {"a", "b"}:
                raise ContractError(f"boot-control {key} is invalid")
        if value["committed"] not in {"a", "b"} or value["state"] not in STATES:
            raise ContractError("boot-control state is invalid")
        slots = value["slots"]
        if not isinstance(slots, dict) or set(slots) != {"a", "b"}:
            raise ContractError("boot-control slots are invalid")
        return cls(
            sequence,
            value["diskGuid"],
            value["bootconfigPartuuid"],
            value["committed"],
            value["pending"],
            value["fallback"],
            value["state"],
            {
                suffix: SlotState.parse(slots[suffix], f"slots.{suffix}")
                for suffix in ("a", "b")
            },
        )

    def payload(self) -> dict[str, object]:
        return {
            "schema": "stugu-boot-control/v1",
            "diskGuid": self.disk_guid,
            "bootconfigPartuuid": self.bootconfig_partuuid,
            "committed": self.committed,
            "pending": self.pending,
            "fallback": self.fallback,
            "state": self.state,
            "slots": {suffix: self.slots[suffix].json() for suffix in ("a", "b")},
        }

    def encode(self) -> bytes:
        if not 0 <= self.sequence < 2**64:
            raise ContractError("boot-control sequence is invalid")
        payload = canonical_json(self.payload())
        maximum = RECORD_SIZE - HEADER.size - CRC.size
        if len(payload) > maximum:
            raise ContractError("boot-control payload is too large")
        prefix = (
            HEADER.pack(MAGIC, 1, HEADER.size, self.sequence, len(payload)) + payload
        )
        padded = prefix + bytes(RECORD_SIZE - CRC.size - len(prefix))
        return padded + CRC.pack(zlib.crc32(padded) & 0xFFFFFFFF)

    @classmethod
    def decode(cls, data: bytes) -> "BootRecord":
        if len(data) != RECORD_SIZE:
            raise ContractError("boot-control record size is invalid")
        expected_crc = CRC.unpack_from(data, RECORD_SIZE - CRC.size)[0]
        if zlib.crc32(data[: -CRC.size]) & 0xFFFFFFFF != expected_crc:
            raise ContractError("boot-control checksum is invalid")
        magic, version, header_size, sequence, payload_size = HEADER.unpack_from(data)
        if magic != MAGIC or version != 1 or header_size != HEADER.size:
            raise ContractError("boot-control format is unsupported")
        if payload_size > RECORD_SIZE - HEADER.size - CRC.size:
            raise ContractError("boot-control payload length is invalid")
        payload = decode_json(
            data[HEADER.size : HEADER.size + payload_size],
            maximum=RECORD_SIZE,
            label="boot-control record",
        )
        return cls.parse(payload, sequence)


@dataclass(frozen=True)
class RecordExtent:
    physical_offset: int


@dataclass(frozen=True)
class BootstrapReceipt:
    disk_guid: str
    bootconfig_partuuid: str
    bootconfig_device: Path
    mountpoint: Path
    records: tuple[RecordExtent, RecordExtent]
    boot_shim_generation: int
    selector_path: Path
    selector_sha256: str

    @classmethod
    def load(cls, path: Path) -> "BootstrapReceipt":
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ActivationBlocked(
                "Signed bootstrap receipt is missing or invalid"
            ) from error
        expected = {
            "schema",
            "diskGuid",
            "bootconfigPartuuid",
            "bootconfigDevice",
            "mountpoint",
            "recordSize",
            "recordOffsets",
            "bootShimGeneration",
            "selectorPath",
            "selectorSha256",
        }
        if (
            not isinstance(value, dict)
            or set(value) != expected
            or value.get("schema") != "stugu-bootstrap-receipt/v1"
        ):
            raise ActivationBlocked("Bootstrap receipt schema is invalid")
        records = value.get("recordOffsets")
        if value.get("recordSize") != RECORD_SIZE or records != list(RECORD_OFFSETS):
            raise ActivationBlocked("Bootstrap receipt record layout is invalid")
        generation = value.get("bootShimGeneration")
        if (
            isinstance(generation, bool)
            or not isinstance(generation, int)
            or generation < 1
        ):
            raise ActivationBlocked("Bootstrap receipt shim generation is invalid")
        selector_text = str(value.get("selectorPath"))
        bootconfig_text = str(value.get("bootconfigDevice"))
        mountpoint_text = str(value.get("mountpoint"))
        selector_path = Path(selector_text)
        bootconfig_device = Path(bootconfig_text)
        mountpoint = Path(mountpoint_text)
        selector_posix = PurePosixPath(selector_text)
        bootconfig_posix = PurePosixPath(bootconfig_text)
        mountpoint_posix = PurePosixPath(mountpoint_text)
        selector_sha = value.get("selectorSha256")
        try:
            disk_guid = str(uuid.UUID(str(value.get("diskGuid"))))
            partuuid = str(uuid.UUID(str(value.get("bootconfigPartuuid"))))
        except ValueError as error:
            raise ActivationBlocked(
                "Bootstrap receipt disk identity is invalid"
            ) from error
        if (
            not selector_posix.is_absolute()
            or not bootconfig_posix.is_absolute()
            or not mountpoint_posix.is_absolute()
            or bootconfig_posix != PurePosixPath("/dev/disk/by-partuuid") / partuuid
            or selector_posix != mountpoint_posix / "stugu-boot.scr"
            or not isinstance(selector_sha, str)
            or len(selector_sha) != 64
            or any(character not in "0123456789abcdef" for character in selector_sha)
        ):
            raise ActivationBlocked("Bootstrap receipt selector identity is invalid")
        return cls(
            disk_guid,
            partuuid,
            bootconfig_device,
            mountpoint,
            (RecordExtent(RECORD_OFFSETS[0]), RecordExtent(RECORD_OFFSETS[1])),
            generation,
            selector_path,
            selector_sha,
        )


class BootControlStore:
    def __init__(
        self,
        receipt_path: Path,
        qualification_path: Path,
        expected_boot_shim_generation: int,
        runner: CommandRunner | None = None,
    ) -> None:
        self.receipt_path = receipt_path
        self.qualification_path = qualification_path
        self.expected_boot_shim_generation = expected_boot_shim_generation
        self.runner = runner or CommandRunner()

    def _qualification(self, receipt: BootstrapReceipt) -> None:
        if not HARDWARE_ACTIVATION_IMPLEMENTED:
            raise ActivationBlocked(
                "Host activation awaits the production selector and hardware-matrix matcher"
            )
        try:
            value = json.loads(self.qualification_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ActivationBlocked(
                "This image has no hardware qualification receipt"
            ) from error
        expected = {
            "schema",
            "activationEnabled",
            "bootShimGeneration",
            "evidence",
            "selectorSha256",
            "watchdogSeconds",
            "recordOffsets",
            "hardwareMatrix",
        }
        if (
            not isinstance(value, dict)
            or set(value) != expected
            or value.get("schema") != "stugu-pi4-qualification/v1"
        ):
            raise ActivationBlocked("Hardware qualification receipt is invalid")
        evidence = value.get("evidence")
        selector_sha = value.get("selectorSha256")
        watchdog = value.get("watchdogSeconds")
        matrix = value.get("hardwareMatrix")
        if (
            value.get("activationEnabled") is not True
            or not isinstance(evidence, str)
            or len(evidence) != 64
            or any(character not in "0123456789abcdef" for character in evidence)
            or evidence == "0" * 64
            or not isinstance(selector_sha, str)
            or len(selector_sha) != 64
            or any(character not in "0123456789abcdef" for character in selector_sha)
            or selector_sha == "0" * 64
            or isinstance(watchdog, bool)
            or not isinstance(watchdog, int)
            or not 1 <= watchdog <= 15
            or value.get("recordOffsets") != list(RECORD_OFFSETS)
            or not isinstance(matrix, list)
            or not matrix
            or any(
                not isinstance(item, str) or not item or len(item) > 120
                for item in matrix
            )
        ):
            raise ActivationBlocked(
                "Pi 4 host activation has not passed the hardware power-cut gate"
            )
        if value.get("bootShimGeneration") != receipt.boot_shim_generation:
            raise ActivationBlocked(
                "Bootstrap and hardware qualification shim generations differ"
            )
        if selector_sha != receipt.selector_sha256:
            raise ActivationBlocked(
                "Qualified boot selector differs from the bootstrapped selector"
            )
        try:
            watchdog_config = WATCHDOG_CONFIG.read_text(encoding="ascii")
        except (OSError, UnicodeDecodeError) as error:
            raise ActivationBlocked(
                "Qualified watchdog configuration is unavailable"
            ) from error
        expected_watchdog = (
            "[Manager]\n"
            "# Generated from the immutable hardware qualification receipt.\n"
            f"RuntimeWatchdogSec={watchdog}s\n"
        )
        if watchdog_config != expected_watchdog:
            raise ActivationBlocked(
                "Runtime watchdog configuration differs from qualification"
            )
        try:
            selector = receipt.selector_path
            if selector.is_symlink() or not selector.is_file():
                raise OSError("selector is not a regular file")
            actual_selector_sha = hashlib.sha256(selector.read_bytes()).hexdigest()
        except OSError as error:
            raise ActivationBlocked("Qualified boot selector is unavailable") from error
        if actual_selector_sha != selector_sha:
            raise ActivationBlocked("Qualified boot selector hash does not match")

    def _receipt(self, *, require_qualification: bool = True) -> BootstrapReceipt:
        receipt = BootstrapReceipt.load(self.receipt_path)
        if receipt.boot_shim_generation != self.expected_boot_shim_generation:
            raise ActivationBlocked(
                "Bootstrap receipt does not match the configured boot-shim generation"
            )
        if require_qualification:
            self._qualification(receipt)
        options = self.runner.run(
            [
                "findmnt",
                "--noheadings",
                "--output",
                "SOURCE,OPTIONS",
                "--target",
                str(receipt.mountpoint),
            ],
            timeout=10,
            check=False,
        )
        fields = options.stdout.strip().split()
        if (
            options.returncode != 0
            or len(fields) != 2
            or Path(os.path.realpath(fields[0]))
            != Path(os.path.realpath(receipt.bootconfig_device))
            or "ro" not in fields[1].split(",")
        ):
            raise ActivationBlocked(
                "Bootconfig must be mounted read-only while extents are verified"
            )
        first, second = sorted(item.physical_offset for item in receipt.records)
        if (
            (first, second) != RECORD_OFFSETS
            or first + RECORD_SIZE > second
            or second + RECORD_SIZE > RESERVED_END
            or first % 512
            or second % 512
        ):
            raise ActivationBlocked("Boot-control fixed extents overlap")
        return receipt

    @staticmethod
    def _read_descriptor(
        receipt: BootstrapReceipt, descriptor: int
    ) -> tuple[BootRecord, int]:
        records: list[tuple[BootRecord, int]] = []
        for index, extent in enumerate(receipt.records):
            data = os.pread(descriptor, RECORD_SIZE, extent.physical_offset)
            try:
                records.append((BootRecord.decode(data), index))
            except ContractError:
                continue
        if not records:
            raise TrustError("Both boot-control records are invalid")
        highest_sequence = max(item[0].sequence for item in records)
        newest = [item for item in records if item[0].sequence == highest_sequence]
        if len(newest) > 1 and any(item[0] != newest[0][0] for item in newest[1:]):
            raise TrustError("Boot-control records conflict at the same sequence")
        record, index = newest[0]
        if (
            record.disk_guid != receipt.disk_guid
            or record.bootconfig_partuuid.lower() != receipt.bootconfig_partuuid
        ):
            raise TrustError(
                "Boot-control appliance identity does not match bootstrap receipt"
            )
        return record, index

    def _read_device(
        self, receipt: BootstrapReceipt, device: Path
    ) -> tuple[BootRecord, int]:
        descriptor = os.open(device, os.O_RDONLY | os.O_CLOEXEC)
        try:
            return self._read_descriptor(receipt, descriptor)
        finally:
            os.close(descriptor)

    @staticmethod
    def _open_verified_device(
        receipt: BootstrapReceipt, disk_path: Path, flags: int
    ) -> int:
        """Open the stable partition identity and pin that exact device for mutation."""
        descriptor = os.open(receipt.bootconfig_device, flags)
        try:
            opened = os.fstat(descriptor)
            stable = os.stat(receipt.bootconfig_device)
            resolved = os.stat(disk_path)
            if (
                not stat.S_ISBLK(opened.st_mode)
                or opened.st_rdev != stable.st_rdev
                or opened.st_rdev != resolved.st_rdev
            ):
                raise TrustError(
                    "Boot-control device identity changed while it was opened"
                )
            return descriptor
        except Exception:
            os.close(descriptor)
            raise

    def read(self, disk: ApplianceDisk) -> tuple[BootRecord, int]:
        return self.validate_disk(disk)

    def validate_disk(
        self,
        disk: ApplianceDisk,
        *,
        require_qualification: bool = True,
    ) -> tuple[BootRecord, int]:
        receipt = self._receipt(require_qualification=require_qualification)
        bootconfig = disk.partitions["bootconfig"]
        if (
            receipt.disk_guid != disk.disk_guid
            or receipt.bootconfig_partuuid != bootconfig.partuuid
            or Path(os.path.realpath(receipt.bootconfig_device)) != bootconfig.path
            or bootconfig.size < RESERVED_END
        ):
            raise TrustError(
                "Boot-control identity does not match the active appliance disk"
            )
        return self._read_device(receipt, bootconfig.path)

    def write(self, record: BootRecord, disk: ApplianceDisk) -> None:
        receipt = self._receipt()
        bootconfig = disk.partitions["bootconfig"]
        if (
            receipt.disk_guid != disk.disk_guid
            or receipt.bootconfig_partuuid != bootconfig.partuuid
            or Path(os.path.realpath(receipt.bootconfig_device)) != bootconfig.path
            or bootconfig.size < RESERVED_END
        ):
            raise TrustError(
                "Boot-control write does not target the active appliance disk"
            )
        flags = os.O_RDWR | os.O_CLOEXEC | getattr(os, "O_DSYNC", 0)
        descriptor = self._open_verified_device(receipt, bootconfig.path, flags)
        unmounted = False
        try:
            current, newest_index = self._read_descriptor(receipt, descriptor)
            if record.sequence != current.sequence + 1:
                raise ContractError("boot-control sequence must advance exactly once")
            if (record.disk_guid, record.bootconfig_partuuid.lower()) != (
                receipt.disk_guid,
                receipt.bootconfig_partuuid,
            ):
                raise ContractError("boot-control write targets another appliance")
            target = receipt.records[1 - newest_index]
            data = record.encode()
            self.runner.run(["umount", str(receipt.mountpoint)], timeout=30)
            unmounted = True
            mounted = self.runner.run(
                ["findmnt", "--noheadings", "--source", str(receipt.bootconfig_device)],
                timeout=10,
                check=False,
            )
            if mounted.returncode == 0 and mounted.stdout.strip():
                raise ActivationBlocked(
                    "Bootconfig remains mounted before raw boot-control write"
                )
            written = os.pwrite(descriptor, data, target.physical_offset)
            if written != RECORD_SIZE:
                raise UpdaterError(
                    "BOOT_CONTROL_SHORT_WRITE",
                    "Boot-control record write was incomplete",
                )
            os.fsync(descriptor)
            self.runner.run(
                ["blockdev", "--flushbufs", str(receipt.bootconfig_device)], timeout=30
            )
            verified = BootRecord.decode(
                os.pread(descriptor, RECORD_SIZE, target.physical_offset)
            )
            if verified != record:
                raise TrustError("Boot-control read-back verification failed")
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
                            str(receipt.bootconfig_device),
                            str(receipt.mountpoint),
                        ],
                        timeout=30,
                        check=False,
                    )
                    if remount.returncode != 0:
                        raise UpdaterError(
                            "BOOTCONFIG_REMOUNT_FAILED",
                            "Bootconfig could not be restored read-only",
                        )
