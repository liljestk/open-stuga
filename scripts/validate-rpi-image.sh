#!/bin/bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/validate-rpi-image.sh IMAGE

Validate a raw Stugu Raspberry Pi factory image without mounting it.
EOF
}

if [[ "$#" -ne 1 ]]; then
  usage >&2
  exit 2
fi

readonly image="$1"
if [[ ! -f "$image" && ! -b "$image" ]]; then
  echo "Factory image or whole-disk block device does not exist: $image" >&2
  exit 1
fi
if [[ -f "$image" && ! -s "$image" ]]; then
  echo "Factory image is empty: $image" >&2
  exit 1
fi
if [[ ! -r "$image" ]]; then
  echo "Factory image or disk is not readable (try sudo for a disk): $image" >&2
  exit 1
fi

for command_name in python3 sfdisk mdir mtype; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required image-validation command is unavailable: $command_name" >&2
    exit 1
  fi
done

readonly partition_json="$(mktemp)"
cleanup() {
  rm -f -- "$partition_json"
}
trap cleanup EXIT

sfdisk --verify "$image"
sfdisk --json "$image" > "$partition_json"

python3 - "$image" "$partition_json" <<'PY'
from __future__ import annotations

import hashlib
import json
import fcntl
from datetime import date, datetime
from pathlib import Path
import re
import stat
import struct
import subprocess
import sys

SECTOR_SIZE = 512
ALIGNMENT_SECTORS = 8 * 1024 * 1024 // SECTOR_SIZE
MICROSOFT_BASIC_DATA = "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7"
LINUX_FILESYSTEM = "0fc63daf-8483-4772-8e79-3d69d8477de4"
EXPECTED = (
    ("bootconfig", MICROSOFT_BASIC_DATA, 96 * 1024 * 1024 // SECTOR_SIZE),
    ("boot_a", MICROSOFT_BASIC_DATA, 256 * 1024 * 1024 // SECTOR_SIZE),
    ("boot_b", MICROSOFT_BASIC_DATA, 256 * 1024 * 1024 // SECTOR_SIZE),
    ("system_a", LINUX_FILESYSTEM, 3 * 1024 * 1024 * 1024 // SECTOR_SIZE),
    ("system_b", LINUX_FILESYSTEM, 3 * 1024 * 1024 * 1024 // SECTOR_SIZE),
    ("persistent", LINUX_FILESYSTEM, 1024 * 1024 * 1024 // SECTOR_SIZE),
)


def fail(message: str) -> None:
    raise SystemExit(f"Factory image validation failed: {message}")


def read_at(handle, offset: int, length: int) -> bytes:
    handle.seek(offset)
    data = handle.read(length)
    if len(data) != length:
        fail(f"short read at byte offset {offset}")
    return data


def hash_partition(path: Path, start: int, size: int) -> str:
    digest = hashlib.sha256()
    remaining = size * SECTOR_SIZE
    with path.open("rb", buffering=0) as handle:
        handle.seek(start * SECTOR_SIZE)
        while remaining:
            block = handle.read(min(8 * 1024 * 1024, remaining))
            if not block:
                fail("unexpected end of image while hashing A/B slots")
            digest.update(block)
            remaining -= len(block)
    return digest.hexdigest()


def mtools(*arguments: str) -> str:
    result = subprocess.run(
        arguments,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        fail(f"{arguments[0]} failed: {result.stderr.strip()}")
    return result.stdout


def mtools_binary(*arguments: str) -> bytes:
    result = subprocess.run(
        arguments,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        fail(f"{arguments[0]} failed: {result.stderr.decode(errors='replace').strip()}")
    return result.stdout


image_path = Path(sys.argv[1])
layout = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
table = layout.get("partitiontable", {})
if str(table.get("label", "")).lower() != "gpt":
    fail("partition table is not GPT")
if int(table.get("sectorsize", 0)) != SECTOR_SIZE:
    fail("GPT does not use 512-byte logical sectors")

partitions = table.get("partitions", [])
if len(partitions) != len(EXPECTED):
    fail(f"expected six partitions, found {len(partitions)}")

previous_end = 0
for index, (partition, expected) in enumerate(zip(partitions, EXPECTED), start=1):
    expected_name, expected_type, expected_size = expected
    name = str(partition.get("name", ""))
    partition_type = str(partition.get("type", "")).lower()
    start = int(partition.get("start", -1))
    size = int(partition.get("size", -1))
    if name != expected_name:
        fail(f"partition {index} is named {name!r}, expected {expected_name!r}")
    if partition_type != expected_type:
        fail(f"partition {index} has unexpected GPT type {partition_type!r}")
    if size != expected_size:
        fail(f"partition {expected_name} has {size} sectors, expected {expected_size}")
    if start < previous_end:
        fail(f"partition {expected_name} overlaps the preceding partition")
    if start % ALIGNMENT_SECTORS:
        fail(f"partition {expected_name} is not aligned to 8 MiB")
    previous_end = start + size

image_stat = image_path.stat()
if stat.S_ISBLK(image_stat.st_mode):
    with image_path.open("rb", buffering=0) as handle:
        image_size = struct.unpack(
            "Q", fcntl.ioctl(handle.fileno(), 0x80081272, b"\0" * 8)
        )[0]
else:
    image_size = image_stat.st_size
if image_size % SECTOR_SIZE:
    fail("image size is not a whole number of sectors")
if previous_end + 33 > image_size // SECTOR_SIZE:
    fail("backup GPT has no room after the final partition")

with image_path.open("rb", buffering=0) as handle:
    protective_mbr = read_at(handle, 0, SECTOR_SIZE)
    if protective_mbr[510:512] != b"\x55\xaa":
        fail("protective MBR signature is missing")
    if protective_mbr[450] != 0xEE:
        fail("protective MBR does not contain a GPT 0xEE entry")

    for partition, (name, _, _) in zip(partitions[:3], EXPECTED[:3]):
        offset = int(partition["start"]) * SECTOR_SIZE
        boot_sector = read_at(handle, offset, SECTOR_SIZE)
        if boot_sector[510:512] != b"\x55\xaa":
            fail(f"{name} FAT boot-sector signature is missing")
        if boot_sector[54:62] != b"FAT16   " and boot_sector[82:90] != b"FAT32   ":
            fail(f"{name} does not contain a recognized FAT filesystem")

    for partition, (name, _, _) in zip(partitions[3:5], EXPECTED[3:5]):
        offset = int(partition["start"]) * SECTOR_SIZE + 1024
        if read_at(handle, offset, 4) != b"\xe2\xe1\xf5\xe0":
            fail(f"{name} does not contain an EROFS superblock")

    persistent_offset = int(partitions[5]["start"]) * SECTOR_SIZE + 1024 + 56
    if read_at(handle, persistent_offset, 2) != b"\x53\xef":
        fail("persistent does not contain an ext4 superblock")

for partition, slot in zip(
    partitions[:3], ("bootconfig rescue", "boot_a", "boot_b")
):
    offset = int(partition["start"]) * SECTOR_SIZE
    listing = mtools("mdir", "-b", "-i", f"{image_path}@@{offset}", "::")
    names = {
        re.split(r"[/\\]", entry.strip())[-1].lower()
        for entry in listing.splitlines()
        if entry.strip()
    }
    if slot == "bootconfig rescue" and "autoboot.txt" in names:
        fail("bootconfig rescue contains autoboot.txt and can firmware-loop")
    for required in ("config.txt", "start4.elf", "fixup4.dat"):
        if required not in names:
            fail(f"{slot} is missing {required}")
    if not any(name.startswith("kernel") and name.endswith(".img") for name in names):
        fail(f"{slot} is missing a Raspberry Pi kernel image")
    if not any(name.startswith("initramfs") for name in names):
        fail(f"{slot} is missing an initramfs")
    config = mtools(
        "mtype", "-i", f"{image_path}@@{offset}", "::config.txt"
    ).replace("\r\n", "\n")
    for required_line in (
        "arm_64bit=1",
        "kernel=kernel8.img",
        "initramfs initramfs8 followkernel",
    ):
        if required_line not in config.splitlines():
            fail(f"{slot} config.txt is missing {required_line!r}")
    cmdline = mtools(
        "mtype", "-i", f"{image_path}@@{offset}", "::cmdline.txt"
    ).replace("\r\n", "\n")
    if "root=/dev/disk/by-slot/active/system" not in cmdline.split():
        fail(f"{slot} cmdline.txt does not select the active A/B system")

firmware = mtools_binary(
    "mtype",
    "-i",
    f"{image_path}@@{int(partitions[0]['start']) * SECTOR_SIZE}",
    "::start4.elf",
)
firmware_date_match = re.search(
    rb"VC_BUILD_ID_(?:DATE|TIME): ([A-Z][a-z]{2} +[0-9]{1,2} +[0-9]{4})",
    firmware,
)
if firmware_date_match is None:
    fail("start4.elf does not expose a parseable Raspberry Pi firmware build date")
firmware_date = datetime.strptime(
    firmware_date_match.group(1).decode("ascii"), "%b %d %Y"
).date()
if firmware_date < date(2025, 1, 22):
    fail(
        "start4.elf predates the 2025-01-22 GPT autoboot partition-number fix"
    )

if hash_partition(
    image_path, int(partitions[1]["start"]), int(partitions[1]["size"])
) != hash_partition(
    image_path, int(partitions[2]["start"]), int(partitions[2]["size"])
):
    fail("boot_a and boot_b differ in the factory image")

if hash_partition(
    image_path, int(partitions[3]["start"]), int(partitions[3]["size"])
) != hash_partition(
    image_path, int(partitions[4]["start"]), int(partitions[4]["size"])
):
    fail("system_a and system_b differ in the factory image")

print(
    "Validated GPT, protective MBR, six aligned partitions, FAT/EROFS/ext4 "
    f"filesystems, Pi firmware dated {firmware_date.isoformat()}, USB rescue "
    "direct-boot files without autoboot.txt, and identical A/B slots."
)
PY
