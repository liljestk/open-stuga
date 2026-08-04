# Stugu 0.35.0 preview

Stugu 0.35.0 makes historical data from archived sensors useful without adding
archived devices back to the live experience. It also hardens appliance identity
resolution for USB SSDs whose model is available through `lsblk` but not sysfs.

## Highlights

- Select archived sensors explicitly in Data & analytics, CSV/XLSX exports,
  and calendar comparison when Stugu knows they recorded the chosen metric.
- Keep archived sensors out of live defaults, forecasts, gap warnings, and
  scheduled exports; the interface explains when a live sensor is required.
- Retain a compact catalogue of measurements observed for each sensor even when
  old samples are removed under the configured retention policy.
- Backfill that catalogue from existing SQLite samples during startup with no
  manual migration or configuration step.
- Fall back to the `lsblk` storage model only when the Raspberry Pi host's sysfs
  storage model is blank, preserving every already-valid device fingerprint.
- Continue to fail closed when the fallback identity is absent or invalid.

## Upgrade and preview boundary

The new SQLite catalogue table is created and populated automatically. It stores
only measurement identifiers, not additional telemetry samples, and does not
change the configured retention period. Existing enabled-sensor behaviour and
nonblank hardware fingerprints are unchanged.

Host updating remains a hardware-qualified preview. This release does not
activate an update on an appliance, upload a factory image, or publish private
sensor archives. Factory images, signing inputs, and migration backups remain
local recovery assets.
