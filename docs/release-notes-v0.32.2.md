# Stugu 0.32.2 preview

Stugu 0.32.2 bundles TP-Link Tapo H500 support with the signed, exact-device
Raspberry Pi host updater. It supersedes the unpublished 0.32.1 candidate and
corrects Raspberry Pi 4 USB 3 boot-disk topology matching.

## Highlights

- Discover and poll H500 hubs and locally exposed T310/T315 children. H100 and
  H200 continue on the normal `python-kasa` path.
- Safely follow identity-verified DHCP changes without persisting a temporary
  address collision.
- Build and verify signed RAUC root-filesystem bundles through a TUF repository.
- Select A/B roots from redundant boot records, consume candidate attempts
  durably, and return to the recorded known-good root after failed probation.
- Bind activation to the exact Pi, EEPROM, USB bridge, and disk fingerprint.
- Translate the Pi 4 VL805 firmware USB 3 root port to Linux's split USB 3
  devpath while retaining strict wrong-disk rejection.

## Preview and recovery boundary

This release is validated on the available Pi 4 and disposable USB disk rather
than a general hardware fleet. Host-update testing requires a verified
off-device backup and a recoverable original production disk. The updater
touches only the inactive immutable root; kernel, firmware, EEPROM, and
canonical first-partition changes remain recovery-class. Existing layout-v1
appliances cannot be converted in place by this updater.

H500 cameras, recordings, recognition, and children hidden by H500 firmware
remain outside the local integration.
