# Changelog

All notable Stuga releases are recorded here.

## Unreleased

## 0.6.0 - 2026-07-23

- Added Owner/Admin system-update management backed by GitHub Releases,
  including installed/latest version visibility, release notes, stable or
  preview channels, configurable checks and local-time maintenance windows,
  manual update requests, and live operation status.
- Added a platform-neutral Docker update agent with trusted GHCR release
  validation, pre-update backup, health-gated replacement, and automatic
  rollback. Docker Desktop and ordinary Docker Engine can run it on the host;
  Raspberry Pi appliance images enable the isolated `self-update` sidecar and
  preserve the selected container release across A/B operating-system slots.
  No database migration is required.

## 0.5.0 - 2026-07-23

- Added resumable live Stuga-to-Stuga migration over authenticated SSH with
  online seed snapshots, content-addressed chunks, portable settings and secret
  transfer, final writer quiescence, isolated TimescaleDB candidate restore,
  full backup verification, health-gated commit, automatic target rollback,
  durable receipts, and fail-closed split-brain protection.
- Added inert-until-granted Stugby federation for independently administered Stuga nodes,
  including shared common-property management, per-Home/per-dataset consent,
  privacy-preserving publication IDs, signed and replay-protected HTTPS events,
  durable SSE cursor notifications, bounded raw telemetry sharing, replica
  retention and deletion receipts, a translated owner UI, and strict protocol
  rejection of integrations, secrets, account identities, and remote control.
  The coordinator-only Cloudflare path is now automated with a server-pinned
  origin, narrowly scoped Access exception, origin rate limits, and fail-closed
  boundary verification; participants remain outbound-only.

## 0.4.1 - 2026-07-22

- Fixed the Raspberry Pi factory-image export on Debian Trixie by using the
  portable `zstd -o` output option after the hosted ARM64 build completes.

## 0.4.0 - 2026-07-22

- Refined the primary Home, property, setup, alert, and analytics workflows
  with progressive disclosure, lazy-loaded specialist surfaces, exact CSV
  export, correct connection-first remediation, multi-P110 integration
  coverage, actionable local-origin guidance, and extensive keyboard and
  screen-reader improvements.
- Added an idempotent daily Home analytics run with persisted month-to-date
  findings for indoor sensors, observed outdoor weather, electricity
  power/energy, and heartbeat-deduplicated door/window openings, plus an
  evidence-first responsive UI and read-only v2 endpoint.
- Added house-timezone calendar comparisons for sensor days, ISO weeks,
  months, years, and decades across all available SQLite/Timescale history,
  reusing the all/single/multiple-series selection with coverage-aware
  aggregation, archive warnings, and an accessible responsive table and chart.
- Added webhook fan-out to as many as 16 stable destinations with independent
  credentials and health, optional HMAC-SHA256 signatures, exact host
  allowlisting, immutable per-destination outbox rows, bounded attempts, durable
  dead letters, and Owner/Admin manual retry.
- Added an Owner/Admin-only append-only security audit API for authentication,
  membership, integration credential, and bridge-grant lifecycles, plus
  restart-persistent automated credential rotation/revocation drills that prove
  retired secrets do not remain in the protected secrets file or audit records.
- Verified restart-safe wall-clock alert deadlines: durable sustained
  conditions now have explicit integration coverage proving they open without
  a second sensor sample and without inventing telemetry.
- Hardened the optional Cloudflare Tunnel/Access deployment with a durable
  static edge-operator allowlist, separation from the local Stuga owner login,
  fail-closed upgrade validation, generated-config regression coverage, and a
  provisioning, rotation, recovery, and rollback runbook.
- Added independently toggleable experimental Air movement and Sensor support
  overlays to both the 2D Home plan and 3D Home volume, with persisted view
  preferences, sparse-data qualification, in-view placement markers, and
  research-grounded suggestions for improving sensors and building inputs.
- Added a local-only, failure-isolated experimental spatial-layer engine with a
  separate state database, versioned house/property snapshots, sensor-quality
  and psychrometric layers, graph-constrained propagation evidence, research
  zone-activity evidence, and shared accessible 2D/3D presentation contracts.
- Added property management with required house-to-property ownership,
  user-drawn mapped areas, area equipment, targeted notes, and property-owned
  maintenance that also works for land-only properties.
- Added built-in local owner, administrator, and Guest accounts for one
  workspace, with server-managed HttpOnly sessions, read-only Guest access,
  least-privilege property, house, and area grants, and fail-closed historical
  access.
- Hardened live telemetry hydration and reconnects with subscribe-before-snapshot
  buffering, bounded SSE backpressure, exact history truncation, chronological
  downsampling, and provenance-safe real-data state transitions.
- Added a durable, retrying outbox for alert notifications, with stable webhook
  idempotency keys and revision/generation fences that prevent stale delivery
  attempts from overwriting newer work.
- Hardened Home Assistant, TP-Link, Telegram, and weather
  integrations around validation, lifecycle cleanup, credential consistency,
  bounded handshakes, and race-safe configuration changes.
- Added native Telegram alert delivery with guided private-chat discovery,
  write-only bot credentials, delivery testing, redacted health, and an
  independent per-rule opt-in that keeps mock/replay data local.
- Added a house-scoped Apple Notes bridge for iOS Shortcuts with revocable
  Shortcut grants, operator-only device labels, idempotent note-to-maintenance
  capture, dated generated snapshots, and explicit iCloud credential-sync,
  retry, and platform/security limitations.
- Added an Automations setup workspace with step-by-step Telegram and Apple
  Notes onboarding, one-time secret handling, connection warnings, tests, and
  disconnect/revocation controls.
- Added house-scoped Activity and Maintenance workspaces, a prominent Home
  quick-observation flow that does not require map placement, and explicit
  observation-to-maintenance planning links.
- Added revisioned maintenance tasks across local REST/MCP, SQLite, and the web
  application, including planned versus due dates, trust basis, priority,
  completion outcomes, independent verification, and conflict-safe editing.
- Added an explicit observation resolution lifecycle: outcome notes such as
  "Fixed leak", server-recorded resolution times, reopening, visually distinct
  resolved markers, and revisioned actor attribution in local storage.
- Protected observation floor membership and placed coordinates during layout
  edits and concurrent writes, while retaining historical sensor provenance
  without blocking later note or resolution updates.

## 0.3.0 - 2026-07-15

- Added a precise manual-observation time model with separate observed and
  immutable recorded times, exact/approximate/date/date-range/unknown
  precision, validity ranges, source provenance, and confidence.
- Added optimistic observation updates and append-only revision snapshots to
  the local SQLite REST/MCP surface, including channel actor attribution and
  legacy backfills.
- Expanded observation authoring and activity context so imprecise dates,
  ongoing conditions, provenance, confidence, and revision metadata remain
  visible instead of being flattened into one editable timestamp.
- Unified Overview and Alerts around an explainable monitoring result: open
  alerts remain blockers, while missing, stale, or aging sensor coverage can no
  longer be presented as a healthy all-clear.
- Added a persistent, visually distinct demo shell driven by the API-confirmed
  data mode, while retaining the irreversible local real-data latch and keeping
  scenario controls out of real installations.
- Added a provider-neutral weather event broker that turns scheduled pulls and
  accepted on-demand snapshots into deduplicated live SSE events after guarded
  outdoor-boundary projection.

## 0.2.0 - 2026-07-14

- Added multi-home setup, typed floor and sensor management, shared map
  placement, plan orientation, and guided location discovery.
- Added direct local TP-Link H100/H200 discovery and polling alongside guided
  Home Assistant discovery, connection testing, secure credential storage, and
  explicit real-data mode transitions.
- Added automatic location-based weather routing: Finnish locations use FMI
  observations, forecasts, and official warnings, while other locations use
  Open-Meteo current conditions and forecasts with explicit attribution and
  coverage semantics.
- Added durable, location-isolated outdoor temperature observations from fresh
  FMI results; stale responses and forecasts are not stored as observations.
- Added a shared 2D/3D sensor-constrained indoor-flow layer using paired
  temperature/RH virtual-temperature buoyancy, wall/door constraints, weak
  fresh-wind window leakage, pressure projection, passive CO2 seeding, replay
  driver history, and an honestly labelled scalar-gradient fallback.
- Added an experimental sensor-scoped first-order thermal calibration,
  fitted reconstruction, untouched holdout metrics, residual analysis, and
  constant-outdoor weather scenario.
- Added bounded five-minute calibration buckets, continuous-coverage gates,
  stale scenario-anchor protection, and privacy-aware boundary retention.
- Added a distinct Twin physics panel for observed, simulated, empirical-band,
  and signed-residual values, including honest collecting/provisional states.
- Added model provenance, calibration metrics, OpenAPI documentation, and
  deterministic physics/API/UI tests.
- Expanded the REST/OpenAPI and local MCP surfaces across home authoring,
  integrations, measurements, alerts, observations, weather, replay, and
  simulation workflows, with structured schemas and redacted integration
  responses.
- Added Home Pulse, prioritized room comfort, a moisture and ventilation coach,
  indoor/outdoor comparison, and a unified home activity timeline.
- Added responsive portfolio, outdoor-weather, sensor-management, home-insight,
  and setup experiences, plus keyboard navigation, drawer focus isolation,
  accessible state labels, and English/Finnish copy corrections.
- Added JavaScript/TypeScript and Python coverage ingestion plus a blocking
  SonarQube Cloud quality gate in CI.
- Added a canonical runtime system version, release consistency check, and
  pre-1.0 pull-request versioning policy.

## 0.1.0

- Initial local-first Stuga digital-twin vertical slice.
