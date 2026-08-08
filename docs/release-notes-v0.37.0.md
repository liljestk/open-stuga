# Stugu 0.37.0 Raspberry Pi responsiveness and bounded background work

Stugu 0.37.0 removes the main sources of sustained API load found on the
Raspberry Pi appliance. It is an application-only release compatible with the
existing generation-15 host; no new signed host update is included.

## What changed

- **Opening state:** the ordinary current-state request reads a bounded SQLite
  candidate projection and never queries TimescaleDB. Explicit history and
  replay retain archive semantics with a five-second timeout and request
  cancellation. The browser hydrates once, follows opening SSE events, pauses
  during House editing/hidden views, and uses a slow exponential fallback only
  when the stream is stale.
- **Derived analytics:** Thermal isolation, Moisture response, and Home
  Performance now read durable last-good artifacts. Opening a page is a pure
  status read; it neither fetches telemetry nor fits a model. Owners can request
  one coalesced refresh, while normal refreshes use stable Home-local nightly
  scheduling. Thermal and moisture fitting runs in a resource-limited worker.
- **Outdoor weather:** Home pages and MCP read a canonical persisted 48-hour
  snapshot. One serialized monitor owns FMI/Open-Meteo network work, coalesces
  Homes at the same location, and preserves last-good data and component error
  state across failure/restart. Recovery discovery is checkpointed, bounded,
  throttled, and cancellable.
- **Experimental spatial layers:** inference is available only as an explicitly
  started 30-240 minute Home session with a 5-30 minute cadence. It is off by
  default, authorized for local writers, max-one, host-load-gated, cancellable,
  and no longer fans out across Properties or wakes for every measurement.
- **Host load safety:** daily findings and historical sensor-gap recovery now
  default off. SQLite startup avoids repeated synthetic-data scans, live alert
  evaluation is driven from its bounded queue, and TP-Link source capabilities
  use a tiny incremental catalogue rather than retained measurement history.
- **Replay and lifecycle controls:** opening and spatial replay prefetch bounded
  ranges instead of issuing cursor-frequency requests. House switches, closing
  panels, visibility changes, and navigation abort or fence outstanding work.

## Upgrade impact

First start creates idempotent SQLite tables/triggers for current opening
candidates, source capabilities, weather snapshots, and derived analytics
artifacts/jobs. It does not build a new full-history measurement index and does
not delete retained telemetry, spatial configuration, snapshots, or raw data.

The v2 Home Performance response now uses the common durable-artifact envelope
(`state`, optional last-good `artifact`/`result`, and failure/freshness status).
Clients that consumed the previous direct v2 result must update. The existing v1
exact-window thermal and moisture routes remain compatible; their CPU fitting is
isolated, though those compatibility routes still perform request-scoped history
reads.

Deployments must set `SPATIAL_LAYERS_ENABLED=true` to expose the timed House
control. This enables the capability only: no session or background inference is
started. `DAILY_ANALYTICS_FINDINGS_ENABLED` and `SENSOR_GAP_RECOVERY_ENABLED`
remain explicit opt-ins. On an installation with no persisted weather snapshot,
Outdoor may report unavailable until the first serialized monitor refresh.
