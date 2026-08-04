# Stugu 0.33.0 preview

Stugu 0.33.0 is the combined H500 and signed Raspberry Pi host-updater
hardware-validation release. It replaces the unpublished v0.32.3 image, which
could not unpack RAUC bundles because `unsquashfs` was absent.

## Highlights

- Discover and poll H500 hubs and locally exposed T310/T315 children while
  retaining the normal H100/H200 protocol path.
- Add read-only Gree and Wilfa heat-pump discovery through the local LAN and
  EWPE Cloud, encrypted credentials, Timescale history, and qualitative 2D/3D
  influence markers. Stugu does not send heat-pump control commands.
- Preserve complete SQLite telemetry when `RETENTION_DAYS=0`, including during
  TimeDB interruptions, without reporting a false archive gap.
- Include `squashfs-tools` in the immutable host image and fail closed before
  download or at build time if RAUC's unpacking dependencies are absent.
- Build and verify signed RAUC root-filesystem bundles through a TUF repository,
  with exact-device qualification, redundant boot records, A/B probation, and
  automatic return to the known-good root after failed health checks.

## Preview and recovery boundary

This release is validated on the available Raspberry Pi 4 and disposable USB
disk rather than a general hardware fleet. Host-update testing requires the
verified off-device backup and recoverable original production SSD retained for
this test. The updater writes only the inactive immutable root; kernel,
firmware, EEPROM, and canonical first-partition changes remain recovery-class.
Existing layout-v1 appliances require a backed-up factory transition.

H500 cameras, recordings, recognition, and children hidden by H500 firmware
remain outside the local integration. The separately located H500 installation
can validate locally exposed children with this same preview after the host and
H200 compatibility drill succeeds.
