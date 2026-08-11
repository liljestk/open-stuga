# Stugu 0.39.0 verified analytics and release operations

Stugu 0.39.0 is an application release for the Raspberry Pi appliance.
It combines the application work prepared since the last public release with a
receipt-driven release workflow that makes every published build traceable to
the exact code and verification evidence.

## What changed since 0.35.7

- Cancelled page requests no longer appear as server faults, and upgraded
  installations can again complete audited system and integration changes.
- Owners and Admins can configure the optional bug-report relay from the app.
- Heavy analytics, weather, replay, and experimental spatial work now runs in
  bounded background jobs and serves durable last-good results instead of
  repeatedly scanning history during normal page loads.
- Thermal and moisture fits exclude powered, compressor-active, unavailable,
  stale, and insufficiently observed heat-pump periods. Removed equipment no
  longer leaves analytics permanently blocked, and insufficient evidence keeps
  the previous good result rather than publishing an empty replacement.
- Local verification, release preparation, release verification, and final
  publication now exchange commit-pinned receipts. A bounded, read-only
  Raspberry Pi doctor supplies the appliance evidence used by that workflow.

## Upgrade impact

The first application start performs idempotent database updates for audit,
weather, projections, and durable analytics jobs. Existing telemetry and
last-good results are retained. Spatial inference and other expensive work stay
off unless explicitly enabled. This release does not require a signed host
update or a factory image.
