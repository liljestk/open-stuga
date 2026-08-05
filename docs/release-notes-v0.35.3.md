# Stugu 0.35.3 TS240 preview

Stugu 0.35.3 is the direct installation candidate for the current Raspberry Pi
4 and TS240 SSD appliance. It includes the complete v0.35.2 application and
host-update experience while replacing the earlier Verbatim-only host
qualification with a single-device TS240 qualification.

## What is included

- One **Advanced → System** workflow that reports application and host updates
  separately, creates and verifies a backup first, and offers **Update
  everything** without giving the web/API process block-device or RAUC access.
- Native signed TUF/RAUC host staging, exact workflow binding, shared mutation
  locks, explicit **Restart and install** confirmation, reboot reconnection,
  A/B probation, and automatic rollback.
- Application-container update and verification through the existing update
  agent, including its existing rollback path.
- Fail-closed explanations for unsupported, unqualified, stale, busy, and
  recovery-needed states.

## Exact-device boundary

Host activation is enabled only for hardware fingerprint
`sha256:11e2d0011f648eb98c7dcecc4ccc80d1317c462fcc191f7adffd50defeede9f2`,
derived from the current Pi, EEPROM, USB bridge, and TS240 storage identity.
This is a bounded preview, not a general Raspberry Pi or SSD qualification.

The user has accepted that the first physical write, boot, probation, and
rollback-path validation will occur on this non-critical appliance. The signed
qualification evidence records that limitation; it does not claim those checks
were completed before installation.

## Transition and recovery

The currently installed generation-6 v0.34.2 system cannot safely acquire the
new host bridge and layout guarantees in place. Preserve and verify the existing
backup, write the v0.35.3 factory image to the disconnected TS240 SSD, boot it,
restore persistent data, and verify both update components before declaring the
transition complete. After that transition, routine supported application and
host-root updates are OTA; host activation remains manual by default.

Kernel, Pi boot-firmware, EEPROM, boot-chain, and recovery-class zero-touch
updates remain a documented future goal. Hardware replacement, irrecoverable
storage failure, and loss of power or network are outside that promise.

There is no persistent-data schema migration change from v0.35.2. The host
publication uses generation 9; v0.35.2 and its generation-8 artifacts remain
immutable.
