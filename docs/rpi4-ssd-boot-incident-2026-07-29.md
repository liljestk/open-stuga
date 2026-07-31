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
- GPT geometry, FAT, EROFS, and ext4 read back correctly. Windows reports the
  SSD healthy; its offline state is the expected SAN policy, and the recorded
  UASP resets belong to the separate card reader. This does not exclude a
  boot-time USB enumeration race.

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

## 2026-07-30 timing diagnosis

The later `v0.23.0` SSD had the intended factory GPT offsets byte-for-byte:
`bootconfig` at 8 MiB, `boot_a` at 104 MiB, `boot_b` at 360 MiB, `system_a` at
616 MiB, `system_b` at 3688 MiB, and `persistent` at 6760 MiB. Persistent was
still 1 GiB on the 224 GiB disk, proving that this image had never completed
its first boot.

The preserved first partition and initramfs were then tested without changing
the GPT or system slot. With the diagnostic netconsole command line:

1. the StoreJet appeared as `/dev/sda` at 2.025 seconds;
2. the mapper selected slot A at 5.895 seconds;
3. the kernel switched root and reached systemd; and
4. first-boot growth expanded persistent to about 214 GiB.

The same initramfs and a normal Stugu command line plus netconsole subsequently
booted `v0.23.0` completely, with no failed units and all application containers
healthy. Removing netconsole left the Pi offline for more than four minutes;
the same initramfs with its stock, non-netconsole command line had also failed
to become reachable.

The initramfs explicitly loads netconsole and waits roughly five seconds for
Ethernet carrier. That incidental wait is the isolated difference: it gives
the USB-SATA device time to appear before active-slot mapping. The production
candidate therefore keeps `rootwait` and adds `rootdelay=6`, which sleeps after
essential drivers load and before the mapper runs. This fix remains pending
hardware approval until it completes the release gate below without netconsole.

The same candidate appends `cgroup_enable=memory`. Raspberry Pi's downstream
device-tree command line disables the memory controller by default; the later
kernel argument enables Docker memory limits and metrics and makes
limit-aware database tuning possible. It is independent of the boot failure
and must be verified after the production boot.

There is no watchdog or `panic=` reboot setting in the appliance. With EEPROM
`BOOT_ORDER=0xf14`, the visible loop is firmware retrying USB, then SD, then
restart after the USB handoff fails.

## 2026-07-31 StoreJet repair result

The timing candidate was written only after identifying the StoreJet by serial
`36308586045G76223197` and rechecking the expected 240,057,409,536-byte GPT
layout. The original 96 MiB first partition was preserved byte-for-byte:

- original SHA-256:
  `4fe0fd6ee0ac0799c0eff44962be2d7aae5e614cd0bf19e10e5fda3e0c4f299d`;
- candidate/readback SHA-256:
  `96e7daa14aac510a9b923d0fd152040d347dbfb0279daf3e7c0cadeef032e2b9`.

The active payload changed only the command line by adding `rootdelay=6`; its
known-working initramfs remained
`f1f545956c11d34f3d7fa1af479af4e35f5f4475a3eba008ec93256ade75a13c`.
The guarded raw write was read back and matched before the disk returned to the
Pi.

The Pi then completed repeated SSD-only cold boots without an SD card or
netconsole. Boot IDs `d449c847-1d31-4fb8-8857-3d4ab6cc69cc` and
`471eadfc-4ecb-465e-9bd0-09b9acf9d97a` were observed across consecutive
power cycles. On the latter boot:

- SSH returned in about 20 seconds and the API was healthy at 25 seconds;
- `/proc/cmdline` contained `rootwait rootdelay=6 cgroup_enable=memory`;
- `/` was the read-only EROFS
  `/dev/disk/by-slot/active/system`;
- `/persistent` was read/write ext4, 214 GiB total and 3% used;
- the cgroup v2 controller list included `memory`;
- systemd was running with no failed units;
- every Stugu, TimescaleDB, update-agent, backup, web, API, and Cloudflare
  container returned healthy;
- the restored SQLite database passed `PRAGMA integrity_check` and retained
  its homes, sensors, rules, and alert history; and
- the Pi reported no throttling while the public Cloudflare boundary check
  passed.

This proves the six-second delay fixes the observed StoreJet enumeration race
for the tested direct-boot payload. It does not yet approve the complete
`v0.24.0` factory image: its exact generated first partition still needs the
byte-comparison and SSD boot checks, and the automatic unhealthy-slot rollback
gate remains outstanding.

## v0.24.0 recovery OTA and performance result

The verified recovery source was backup
`stugu-backup-2026-07-30T12-50-47-264Z` in the operator's local Stugu Backups
directory. Recovery migration `96c6a743-6a6d-4030-930b-bc659c44c226` restored
the persistent application data, and the restored SQLite database passed its
integrity check. The pre-OTA safety backup was retained at
`/persistent/stugu/backups/stugu-backup-2026-07-31T07-47-03-639Z`.

OTA operation `542307f2-502b-4ce7-8151-1b85bf730207` then installed application
release `v0.24.0`. This did not replace the immutable host: `/etc/stugu-version`
remains `v0.23.0`, with the repaired `rootdelay=6` and memory-cgroup command
line applied directly to the preserved boot partition. A complete `v0.24.0`
factory image and automatic unhealthy-slot rollback remain outside the proven
gate.

TimescaleDB was restarted after applying and verifying:

- `max_worker_processes=16`;
- `max_parallel_workers=4`; and
- `timescaledb.max_background_workers=12`.

All three settings reported `pending_restart=false`. During repeated monitoring
for more than eight minutes after settling, host idle stayed at 88–98%,
generally about 96%; load stayed near 0.3–0.6; temperature stayed at
55.5–58.4 °C; and throttling remained `0x0`. The API used about 4–9% CPU and
205–219 MiB, while TimescaleDB used about 35–54 MiB. `/persistent` was 4% used,
with no failed units, OOM events, container restarts, kernel I/O errors, or
undervoltage warnings. A host-monitor snapshot reported 4.8% CPU, 15.8% memory,
7.4% storage, 57 °C, and no active alerts.

The monitoring ended at 7,489 seconds uptime on the same boot ID, so it is not
evidence of another reboot. The OTA also exposed an ownership defect: the
root-running updater atomically replaced `release.env` and `known-good.env` as
`root:root` mode `0640`, preventing unprivileged `stuguctl` from reading the
selected release until a root service restart repaired ownership. Release
`v0.24.1` assigns each candidate, known-good, and rollback temporary file the
owning release-state directory's UID/GID before the atomic rename, while
retaining mode `0640`.

## Superseded boot-artifact hypothesis

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

This difference motivated a monolithic-zstd compatibility candidate, but the
later timing test did not reproduce compression as the deciding variable. The
split CPIO plus compressed stream is valid according to the Linux initramfs
buffer specification, and the same known initramfs succeeded with netconsole
but remained offline without it. Archive layout, zstd settings, GPT geometry,
and the active-slot marker are therefore not established causes of this boot
failure. The build may retain a monolithic archive for deterministic
compatibility, but `rootdelay=6` is the hardware candidate under test.

## Required design

Separate Pi 4 USB results still require the established direct-boot design:

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

The marker-aware A/B design is preserved. It is independent of the USB timing
fix: the direct-boot command line uses `rootwait rootdelay=6`, then the
initramfs reads the marker after the delay.

Application releases continue to update automatically from trusted GitHub
releases. They do not rewrite the immutable OS slots. An OS updater must retain
the last-known-good first partition, arm a bounded boot attempt, and roll the
slot marker back unless userspace records health. A failure before the kernel
starts cannot be repaired by userspace, so the updater must not replace the
working first partition until the candidate boot files have passed this exact
SSD hardware gate.

## Release gate

A Pi 4 SSD release is accepted only after:

1. the raw image validator requires `auto_initramfs=1`,
   `rootwait rootdelay=6`, and `cgroup_enable=memory`; rejects explicit
   kernel/initramfs overrides; requires `stugu-active-slot` to default to A;
   and rejects `autoboot.txt`;
2. the complete factory image passes GPT, filesystem, firmware, slot equality,
   and payload checks;
3. the candidate first partition is byte-compared with its release artifact;
4. the target Pi boots the production command line from SSD with the SD card
   removed and without netconsole;
5. root device, OS version, LAN, Tailscale, persistent capacity, containers,
   automatic GitHub update settings, the cgroup v2 memory controller, and
   Docker memory metrics are verified;
6. two consecutive SSD-only reboots complete; and
7. a deliberately unhealthy, kernel-reachable system slot proves automatic
   rollback to the last-known-good slot.

No release note may call an RPi 4 factory image SSD-compatible until all seven
checks pass on the target bridge.
