# Raspberry Pi 4 SSD boot incident — 2026-07-29

## Scope

This records the Pi 4 USB-SSD investigation and the release gates derived from
it. The target is `stugu` at `192.168.100.17`, booting a Transcend
`TS240GESD230C` through a USB-SATA bridge in a blue Pi 4 USB 3 port.

Never overwrite partition 6 (`persistent`) during slot recovery.

## Preserved recovery artifacts

The SSD data partition retains pre-upgrade images under
`/persistent/stugu/os-upgrade-v0198`:

| Artifact | SHA-256 |
| --- | --- |
| `current-v0182-sda1.raw.gz` | `8829b725d16fc808dfa3fed80a38386c9ec12a486775d86367fbdf02e20539f8` |
| `current-v0182-sda2.raw.gz` | `ffaceb32095e598f5864b2a1545e97b47f38e39f28316d9beb79f96665736e44` |
| `current-v0182-sda4.raw.gz` | `579ca72238dc36c1453dfc4dbfe008873e8b435380ee317d4808e4d9f38802f8` |
| `pre-diagnostic-sda5.raw.gz` | `579ca72238dc36c1453dfc4dbfe008873e8b435380ee317d4808e4d9f38802f8` |

Partition 6 fills the remaining SSD, remains intact, and reports 214 GiB total
with about 175 GiB free after the migration and preserved backups.

## Artifact verification

Release `v0.19.8` is commit
`caa44dc54f6ad60b7f0cc72dfb2b7f1b83b29f10`.

- Factory image SHA-256:
  `bfd541f9043392de19a9d4807ac0401f960c5338c8c7b430f19fa0f73ccf2e0c`.
- The OTA system payload and factory `system_a` are byte-identical.
- The v0.19.8 image in `/dev/sda5` read back byte-for-byte correctly.
- The v0.18.2 and v0.19.8 Pi kernel and firmware files are byte-identical.
- GPT, FAT, EROFS, ext4, EEPROM USB boot, and the USB-SATA bridge are healthy.

## Diagnostic correction

An earlier test put `root=/dev/sda5` on the kernel command line, but the upstream
initramfs script `90-rpi-ab-root` unconditionally replaced it with
`/dev/disk/by-slot/active/system`. Stugu's USB mapper treated the first
`bootconfig` partition as slot A, so that test actually booted v0.18.2 from
`/dev/sda4`.

The controlled test was repeated with an initramfs whose only two content
changes selected B for `bootconfig`. Netconsole then proved:

1. the kernel mounted EROFS root `/dev/sda5`;
2. `/etc/stugu-version` reported `0.19.8`;
3. persistent initialization completed successfully;
4. SSH, LAN HTTP, Tailscale, Docker, API, web, TimescaleDB, backup scheduler,
   and update agent became healthy; and
5. no systemd units failed.

The shared journal also contains earlier A-slot boots. The prior statement that
all failed attempts left no journal was based on reading the obsolete per-slot
journal path rather than `/persistent/log/journal`.

The pre-release mapper was then tested directly on the same SSD. The exact
source script (SHA-256
`5544719896a3dfd2a438b40566172b6a2d5b252a959f6b8dc681e04fd2228e2f`)
was installed in both initramfs stages, `stugu-active-slot` contained `b`, and
`config.txt` retained `auto_initramfs=1` without explicit overrides. An
SSD-only reboot logged `active slot b`, mounted `/dev/sda5`, restored LAN and
Tailscale access, and returned every application container to health.

## v0.19.9 factory-image regression

Release `v0.19.9` is commit
`64466619fa8f103bec55c012b1fcd839d696ce4e`. Its application containers run
successfully on the Pi, but its exact factory boot artifacts did not pass the
SSD hardware gate.

The inactive A partitions and first FAT partition were written and read back
byte-for-byte:

| Partition | SHA-256 |
| --- | --- |
| `bootconfig` (`/dev/sda1`) | `02442f2f6796d0651bff93d7565a1e59b6a57f2382ed3952e795db839caaa28c` |
| `boot_a` (`/dev/sda2`) | `bbcdc3cf16ba4a55141a540f8cf85baea3964574d7bc0007f07ffce4bb367631` |
| `system_a` (`/dev/sda4`) | `0c084c26171f7ee79ce172cc6cc2e333c94080b06fb014bcd9a99ff55a0e77cf` |

With `stugu-active-slot` set to A and the SD card removed, the Pi did not reach
DHCP, SSH, Tailscale, or netconsole and repeatedly reset or showed seven short
green flashes. This rules out a Windows raw-write or partition checksum error.

Restoring the preserved known-working first partition immediately restored
SSD-only boot into B (`/dev/sda5`) with the same bridge and disk. Its raw
SHA-256 is
`a13d57768eae66661a153f151e0501b1b24898870c07531c8c1a8e43d608c2b0`;
the known-working initramfs SHA-256 is
`f1f545956c11d34f3d7fa1af479af4e35f5f4475a3eba008ec93256ade75a13c`.

The operational state after migration is therefore immutable OS `0.19.8` on
slot B with application release `0.19.9`. The public `v0.19.9` factory image is
not hardware-approved for this USB-SATA bridge.

## Isolated boot-artifact difference

The complete FAT inventories were then extracted from the failed factory
partition and the known-working partition. The firmware, Pi 4 DTB,
`kernel8.img`, and `config.txt` are byte-identical. FAT geometry is also
identical, and the factory kernel occupies one contiguous cluster chain.

The strongest isolated difference is the initramfs archive layout:

| Artifact | Size | Layout |
| --- | ---: | --- |
| v0.19.9 factory `initramfs8` | 15,002,507 bytes | 4,467,200-byte uncompressed CPIO followed by zstd |
| known-working `initramfs8` | 15,737,584 bytes | one zstd stream |

Both unpack to the same 414-file payload. Only the intended active-slot mapper
and its ordering files differ. The exact mapper was previously installed in a
single-stream initramfs and booted this SSD successfully.

The split CPIO plus compressed-stream format is valid according to the Linux
initramfs buffer specification. Treating it as a compatibility regression on
this Pi 4 firmware/USB-SATA path is therefore an evidence-based hardware
workaround, not a claim that the upstream format is generally invalid.

The next factory build patches `initramfs-tools` before its final build pass so
all files are emitted in one zstd stream. The image validator rejects a leading
uncompressed archive and rejects any difference between the rescue, A, and B
direct-boot payloads. This candidate remains unapproved until it passes the
physical SSD gate below.

## Required design

Two independent Pi 4 USB behaviors caused misleading recovery cycles:

- The target bridge cannot reliably follow Raspberry Pi firmware GPT
  `autoboot.txt` handoffs to later FAT partitions. The first FAT partition must
  directly load the kernel and initramfs.
- Explicit Pi 4 `kernel=kernel8.img` / `initramfs ... followkernel` overrides
  produced the pre-kernel seven-flash symptom in earlier tests. Automatic
  pairing is still required.

Direct boot must also know which immutable system slot to mount without relying
on firmware partition selection. The corrected design stores a one-line
`stugu-active-slot` marker on `bootconfig`:

- fresh factory images contain `a`;
- the initramfs accepts only `a` or `b`;
- a missing, unreadable, or invalid marker fails closed to A; and
- `autoboot.txt` remains forbidden on the rescue partition.

Application releases continue to update automatically from trusted GitHub
releases. They do not rewrite the immutable OS slots. An OS updater must retain
the last-known-good first partition, arm a bounded boot attempt, and roll the
slot marker back unless userspace records health. A failure before the kernel
starts cannot be repaired by userspace, so the updater must not replace the
working first partition until the candidate boot files have passed this exact
SSD hardware gate.

## Release gate

A Pi 4 SSD release is accepted only after:

1. the raw image validator requires `auto_initramfs=1`, rejects explicit
   kernel/initramfs overrides, requires `stugu-active-slot` to default to A,
   and rejects `autoboot.txt`;
2. the complete factory image passes GPT, filesystem, firmware, slot equality,
   and payload checks;
3. the candidate first partition is byte-compared with its release artifact;
4. the target Pi boots the release from SSD with the SD card removed;
5. root device, OS version, LAN, Tailscale, persistent capacity, containers,
   and automatic GitHub update settings are verified;
6. two consecutive SSD-only reboots complete; and
7. a deliberately unhealthy, kernel-reachable system slot proves automatic
   rollback to the last-known-good slot.

No release note may call an RPi 4 factory image SSD-compatible until all seven
checks pass on the target bridge.
