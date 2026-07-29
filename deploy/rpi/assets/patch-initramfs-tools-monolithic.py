#!/usr/bin/env python3
"""Emit the known-working single-stream initramfs layout for Pi 4 USB."""

from pathlib import Path
import sys


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if source.count(old) != 1:
        raise SystemExit(f"unexpected initramfs-tools {label} implementation")
    return source.replace(old, new)


if len(sys.argv) != 2:
    raise SystemExit("usage: patch-initramfs-tools-monolithic.py MKINITRAMFS")

path = Path(sys.argv[1])
source = path.read_text(encoding="utf-8")
source = replace_once(
    source,
    "\t\tfind . \\( ! -type d ! -name '*.zst' ! -name '*.xz' \\) -o \\( -type d -empty \\) ||",
    "\t\t# Stugu Pi 4 USB boot requires one compressed initramfs stream.\n"
    "\t\tfind . ! -type d -o \\( -type d -empty \\) ||",
    "main archive",
)
source = replace_once(
    source,
    "\t\tfind . -name '*.zst' -o -name '*.xz' ||",
    "\t\tfind . -false ||",
    "uncompressed archive",
)
path.write_text(source, encoding="utf-8")
