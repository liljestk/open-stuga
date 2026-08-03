# Stugu 0.32.1 preview

Stugu 0.32.1 bundles TP-Link Tapo H500 support with the first signed,
exact-device Raspberry Pi host-updater preview. It supersedes the unpublished
0.32.0 build attempt and fixes collection of the generated host SBOM.

## Highlights

- Discover and poll H500 hubs and locally exposed T310/T315 children. The
  compatibility adapter is installed only for H500 instances; H100 and H200
  continue on the normal `python-kasa` path.
- Safely follow identity-verified DHCP changes, including two TP-Link devices
  swapping addresses, without persisting a temporary collision.
- Build and verify signed RAUC root-filesystem bundles through a TUF repository.
- Select A/B roots from redundant p1 boot records in early initramfs, consume
  candidate attempts durably, and return to the recorded known-good root when
  probation is exhausted.
- Bind activation to the exact Pi, EEPROM, USB bridge, and disk fingerprint and
  reject wrong-disk or persistent-partition writes.

## Preview and recovery boundary

This release does not claim general fleet hardware qualification. Host-update
testing requires a verified off-device backup and a disposable layout-v2 disk.
The preview updates only the inactive immutable root; its boot artifact must be
byte-identical to the active one. Kernel, firmware, EEPROM, and canonical p1
changes remain recovery-class. The preview does not enable an unqualified
runtime watchdog; an early-boot hang therefore requires a manual power cycle,
after which the selector's bounded attempt count still drives fallback.

Existing layout-v1 appliances cannot be converted in place by this updater.
Back up the appliance, flash a validated layout-v2 factory image to a separate
disk, and keep the original production disk disconnected during destructive
testing. H500 cameras, recordings, recognition, and children hidden by H500
firmware remain outside the local integration.
