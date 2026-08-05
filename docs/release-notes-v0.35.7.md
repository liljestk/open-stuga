# Stugu 0.35.7 host-update bridge contract correction

Stugu 0.35.7 restores the Raspberry Pi host-update status in **Advanced →
System**. The native updater was connected and healthy, but its completed
generation-14 record omitted the target application version required by the
API parser.

## What changed

- The API accepts that legacy completed record only when the target generation
  exactly matches the current host generation and its manifest digest is valid.
- New completed native records include the target application version and
  satisfy the full bridge contract directly.
- An older GitHub release is labelled **Latest stable** or **Latest preview**,
  not **Available**, and redundant target information is hidden.

The compatibility path cannot stage, activate, retry, or select a host target.
All actionable states remain identity-bound and fail closed. The bridge retains
no device, Docker socket, RAUC, sudo, network, or broad host access.

There is no persistent-data migration change. Exact-device qualification,
explicit restart confirmation, signed TUF/RAUC selection, shared mutation
locks, A/B probation, and automatic rollback are unchanged. Kernel, Pi
boot-firmware, EEPROM, boot-chain, and recovery-class zero-touch updates remain
deferred.
