# Stugu 0.35.5 host-update bridge startup correction

Stugu 0.35.5 completes the native updater bridge fix for both upgraded and
fresh Raspberry Pi appliances. The bridge account was already embedded in the
immutable host root; this patch also creates its bounded persistent work
directory before systemd builds the service sandbox.

## What changed

- Appliance startup creates `update-operations/host-bridge` while the
  persistent volume is mounted and before the bridge service starts.
- The bridge service still creates and verifies its separately permissioned
  request and status subdirectories as root before dropping to the dedicated
  unprivileged account.
- Regression coverage binds directory creation to the service ordering rule.

The bridge retains no network, device, Docker socket, RAUC, sudo, or broad
host access. Host selection and writes remain in the signed native updater;
activation still requires explicit restart confirmation and A/B probation.

There is no persistent-data migration change. Kernel, Pi boot-firmware,
EEPROM, boot-chain, and recovery-class zero-touch updates remain deferred work
rather than a claim of this release.
