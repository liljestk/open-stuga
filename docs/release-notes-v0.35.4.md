# Stugu 0.35.4 TS240 host-bridge correction

Stugu 0.35.4 is the hardware-validated correction to the v0.35.3 TS240
candidate. The application and storage expansion started correctly on the
exact appliance, but the native updater UI bridge could not start because its
dedicated service identity had not been materialized into the immutable root.

## What changed

- The image build now creates the bounded `stugu-update-bridge` account and its
  supplementary `stugu` group membership before EROFS is generated.
- Release validation reads `/etc/passwd` and `/etc/group` back from the actual
  EROFS payload and fails closed when either identity contract is absent.
- The bridge remains unprivileged, without network, device, RAUC, Docker socket,
  or broad host access. Native staging and activation still stay in the signed
  host-updater daemon.

## Appliance transition

The current generation-9 v0.35.3 appliance can receive generation 10 over its
existing signed native updater through the recovery SSH CLI; the failed web
bridge is not used for that one correction. Staging must complete before an
explicit activation and reboot. After probation succeeds, application and host
status are available separately in **Advanced → System**, including the guarded
backup-first **Update everything** workflow.

There is no persistent-data migration change. The exact-device qualification
remains limited to fingerprint
`sha256:11e2d0011f648eb98c7dcecc4ccc80d1317c462fcc191f7adffd50defeede9f2`.
Kernel, Pi boot-firmware, EEPROM, boot-chain, and recovery-class zero-touch
updates remain deferred work rather than a claim of this release.
