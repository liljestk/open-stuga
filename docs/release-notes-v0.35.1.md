# Stugu 0.35.1 preview

Stugu 0.35.1 contains the archived-sensor analytics and appliance identity
work from 0.35.0, plus the test-fixture correction required for a reproducible
clean-container release build and a unified, safety-gated system-update
experience.

## Highlights

- Treat connected Wilfa/Gree heat pumps as full Stugu sensors: retain and
  backfill temperature, humidity, power/on-off periods, operating modes,
  targets, fan/swing/compressor state, and diagnostics for history and
  analytics.
- Give heat pumps a coherent room inspector and readable markers in both the
  2D floor plan and 3D building view, including useful live state without
  crowding the map.
- Show application and native Raspberry Pi host availability, installed
  versions, progress, and recovery state separately in Advanced -> System.
- Add **Update everything**: verify a backup, stage the signed and qualified
  A/B host target, wait for explicit **Restart and install**, reconnect through
  probation/automatic fallback, and update the application only after the host
  is accepted.
- Bind restart and cancel actions to the exact staged operation, version,
  generation, and manifest digest so a stale browser cannot activate another
  candidate.
- Keep the web/API outside the host trust boundary through a dedicated,
  no-network/no-device/no-capability bridge that accepts no paths, URLs, raw
  commands, repair flags, or recovery channel.
- Preserve progress across service restarts and host reboots, and fail closed
  with a specific reason for unsupported, unqualified, busy, stale, returned,
  or recovery-needed states.
- Fail before host download when RAUC or SquashFS extraction support is absent,
  and preserve exact-device qualification on USB storage whose model is
  available through `lsblk` but not sysfs.

Host activation is manual. A generation-6 appliance needs one audited CLI or
factory transition because that immutable host predates the bridge; the UI
enables the unified workflow only after the new host and update agent advertise
support.

This factory candidate uses host generation 7. Host-update activation remains
disabled unless a matching hardware qualification receipt is supplied.
