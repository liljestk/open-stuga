# Stugu 0.34.2 preview

Stugu 0.34.2 is the combined H500 and signed Raspberry Pi host-updater
hardware-validation release. It supersedes the unpublished v0.34.1 candidate
after physical HD testing showed that RAUC 1.13 requires generic `.img` bundle
member names when writing the appliance's raw A/B slots.

## Highlights

- Discover and poll H500 hubs and locally exposed T310/T315 children while
  retaining the normal H100/H200 protocol path.
- Add a pinnable Home or Property overview on mobile web and iPhone, with
  configurable temperature, humidity, electricity, and CO2 quick stats,
  attention-first status, and Room or Home breakdowns.
- Add read-only Gree and Wilfa heat-pump discovery through the local LAN and
  EWPE Cloud, encrypted credentials, Timescale history, and qualitative 2D/3D
  influence markers. Stugu does not send heat-pump control commands.
- Preserve complete SQLite telemetry when `RETENTION_DAYS=0`, including during
  TimeDB interruptions, without reporting a false archive gap.
- Install `rauc-service` alongside RAUC and `squashfs-tools`, then fail closed
  before download or at build time if extraction, systemd, or D-Bus runtime
  dependencies are absent.
- Name both signed slot payloads as generic `.img` members so RAUC 1.13 uses
  raw-copy handlers while their exact boot and EROFS bytes remain hash-bound.
- Build and verify signed RAUC root-filesystem bundles through a TUF repository,
  with exact-device qualification, redundant boot records, A/B probation, and
  automatic return to the known-good root after failed health checks.
- Let a fresh factory generation bind its first signed same-generation repair
  manifest after explicit repair authorization; every later repair remains
  pinned to that exact accepted manifest.

## Preview and recovery boundary

This release is validated on the available Raspberry Pi 4 and disposable USB
disk rather than a general hardware fleet. Testing uses a verified off-device
backup, while the original production SSD remains disconnected and recoverable.
The updater writes only the inactive immutable root; kernel, firmware, EEPROM,
and canonical first-partition changes remain recovery-class. Existing layout-v1
appliances require a backed-up factory transition.

H500 cameras, recordings, recognition, and children hidden by H500 firmware
remain outside the local integration. The separately located H500 installation
can validate locally exposed children with this same preview after the host and
H200 compatibility drill succeeds.
