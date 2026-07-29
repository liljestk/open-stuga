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

Partition 6 expanded to 217 GiB and remains intact. It has about 192 GiB free.

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

## Root cause and permanent design

Two independent Pi 4 USB behaviors caused misleading recovery cycles:

- The target bridge cannot reliably follow Raspberry Pi firmware GPT
  `autoboot.txt` handoffs to later FAT partitions. The first FAT partition must
  directly load the kernel and initramfs.
- The source image replaced `auto_initramfs=1` with a late explicit Pi 4
  `kernel=kernel8.img` / `initramfs ... followkernel` block. The exact
  previously working first partition used automatic kernel/initramfs pairing;
  the explicit build repeatedly produced the pre-kernel seven-flash symptom.

Direct boot must also know which immutable system slot to mount without relying
on firmware partition selection. The corrected design stores a one-line
`stugu-active-slot` marker on `bootconfig`:

- fresh factory images contain `a`;
- the initramfs accepts only `a` or `b`;
- a missing, unreadable, or invalid marker fails closed to A; and
- `autoboot.txt` remains forbidden on the rescue partition.

Application releases continue to update automatically from trusted GitHub
releases. They do not need to rewrite the immutable OS slots.

## Release gate

A Pi 4 SSD release is accepted only after:

1. the raw image validator requires `auto_initramfs=1`, rejects explicit
   kernel/initramfs overrides, requires `stugu-active-slot` to default to A,
   and rejects `autoboot.txt`;
2. the complete factory image passes GPT, filesystem, firmware, slot equality,
   and payload checks;
3. the target Pi boots the release from SSD with the SD card removed;
4. root device, OS version, LAN, Tailscale, persistent capacity, containers,
   and automatic GitHub update settings are verified; and
5. two consecutive SSD-only reboots complete before migration.
