# Changelog

All notable Stugu releases are recorded here.

## Unreleased

## 0.19.3 - 2026-07-29

- Read quiesced WAL-mode SQLite databases safely from read-only backup mounts
  during cutover, while failing closed if a WAL sidecar remains.
- Keep appliance maintenance locks writable by both root services and the
  authenticated `stugu` migration user after clean boots and updates.
- Allow clean-install safety backups without an integration-secrets file and
  keep Timescale ownership validation compatible with non-interactive `psql`.

## 0.19.2 - 2026-07-29

- Run appliance maintenance and migration jobs with the active last-known-good
  application release, including after updating an older immutable factory OS.
- Treat absent auto-discovered optional secret roots as empty while retaining
  strict validation for explicitly configured migration inputs.

## 0.19.1 - 2026-07-29

- Include the split live-migration target modules in the maintenance image and
  guard their packaging so appliance seed and cutover commands work in releases.

## 0.19.0 - 2026-07-29

- Add read-only direct Gree/Wilfa heat-pump discovery, Home-scoped setup,
  polling, durable observations, Timescale history, protected connection
  settings, migration support, and localized web guidance.
- Move bucketed measurement analytics into complete database-side archive
  rollups, preserve quality, counter, rate, and coverage semantics, and name
  partial Home-performance evidence sources instead of reporting only a count.
- Make Pi 4 USB factory images boot their complete first FAT partition directly,
  preserve firmware-qualified slot aliases across `switch_root`, repair clean
  shared-state initialization, and reject self-redirecting `autoboot.txt`
  layouts that caused seven-flash and reboot-loop failures.
- Keep LAN, persistent Tailscale, full-disk growth, EEPROM USB compatibility,
  and health-gated GitHub container updates enabled in clean appliance builds.
  Stable application releases install automatically in a weekly window;
  unsafe Raspberry Pi Connect OS partition deployment is disabled for Pi 4 USB.
- Existing SQLite and Timescale databases migrate automatically. Tailnet login
  remains a one-time operator authorization, and immutable OS/kernel changes
  require a newly validated factory image plus backup or migration.

## 0.18.2 - 2026-07-29

- Fixed clean Raspberry Pi factory builds so the first-partition USB rescue
  filesystem receives the complete firmware, kernel, initramfs, and autoboot
  payload instead of only its partition metadata.

## 0.18.1 - 2026-07-28

- Fixed Raspberry Pi factory-image generation by using a valid FAT16 cluster
  size for the enlarged first-partition USB rescue filesystem.

## 0.18.0 - 2026-07-28

- Add bounded hybrid SQLite/Timescale history reads, archival coverage and
  recovery safeguards, richer daily analytics, and full electricity-history
  exploration without presenting incomplete archive data as complete.
- Add replay-aware outdoor context and influence overlays, resumable
  integration discovery, and clearer Stuguby grant/identity repair workflows
  across the API and web product.
- Make Raspberry Pi 4 factory images boot reliably from USB SSDs with a
  complete first-partition rescue payload, explicit Pi 4 kernel/initramfs
  selection, portable initramfs A/B aliases, and firmware-qualified udev
  device links.
- Expand the final persistent partition across the complete SSD after moving
  the backup GPT, remove early-boot systemd ordering cycles, seed shared
  container state once per release, and accept either Ethernet or Wi-Fi as
  the appliance uplink.
- Keep stable EEPROM USB settings, LAN access, and an enabled persistent
  Tailscale client in every appliance build. Existing application databases
  migrate automatically; Tailnet enrollment remains a one-time operator step.

## 0.17.1 - 2026-07-28

- Make Raspberry Pi appliances reachable on their private LAN by default,
  include an enabled Tailscale client whose identity persists across A/B
  updates, and add one-command Tailnet login and access discovery.
- Keep first-owner setup protected on network-bound appliances with a
  device-generated persistent secret delivered through a private browser
  fragment instead of weakening the local bootstrap boundary.

## 0.17.0 - 2026-07-28

- Make clean Raspberry Pi installations self-healing when PostgreSQL
  initialization is interrupted, persist the APNS secret mount, and include
  every update-agent module in its container image.
- Validate the complete factory image under Linux before release, including
  the protective MBR, GPT, six named partitions, A/B slot contents, filesystem
  signatures, and Pi firmware boot files required for USB SSD boot.
- Redesign calendar comparison around two explicit periods. Week views now
  align Monday through Sunday, months use seven-day blocks, years use months,
  and decades use years. The view can compare a stable selected-sensor
  aggregate or one sensor, reports signed headline differences over shared
  completed buckets, and preserves local-time partial and missing evidence.
- Poll T110 trigger logs every 500 ms by default so quick door/window cycles are
  retained once, even when both transitions occur between full hub polls, and
  replay retained logs after restarts to backfill recoverable outage events.
  Push persisted opening states over the existing live stream so both 2D and 3D
  views update without waiting for their periodic reconciliation poll. Keep
  every Home visual event-driven too: streamed measurements, readings, weather,
  alerts, and spatial layers now render without waiting for the visual clock.
- Bring those TP-Link door/window contacts into the native iPhone companion
  with live state, protected offline snapshots, bounded opening history,
  transition summaries, and a handoff to the full management surface.

## 0.16.1 - 2026-07-27

- Fixed Raspberry Pi 4 factory images installed on USB storage so initramfs
  securely resolves the firmware-selected disk and binds its A/B system slots.

## 0.16.0 - 2026-07-27

- Redesigned opt-in equipment tracking around explicit profiles, bounded
  evidence, people-presence sharing, and matching iOS and web workflows.
- Isolated Stuguby shared Homes from local demo/replay telemetry, integrations,
  gap recovery, weather, analytics, alerts, openings, and other local-authority
  data, including browser fallbacks and stale federation projections.
- Existing databases migrate automatically. Federation grant, suspension,
  revocation, and regrant transitions now clean and rematerialize projections
  without transferring local credentials or integration state.

## 0.15.0 - 2026-07-27

- Move expensive AMD64/ARM64 container and Raspberry Pi artifact publishing to
  a guarded local release command, with immutable image digest resolution,
  release asset upload, optional Connect deployment, and an explicitly
  confirmed GitHub-hosted fallback.

## 0.14.2 - 2026-07-27

- Align the Raspberry Pi image-generator layer and build overrides on the
  declared `stugu` variable prefix so appliance assets and immutable image
  references reach the custom image hook.

## 0.14.1 - 2026-07-27

- Build architecture-neutral web assets on the native Docker builder before
  packaging AMD64 and ARM64 images, preventing Raspberry Pi release builds from
  timing out under ARM emulation.

## 0.14.0 - 2026-07-27

- Split oversized application, API, persistence, protocol, localization,
  styling, tooling, and test sources into focused modules while preserving
  existing public entry points, and added an enforced 600-line source-file
  ceiling.
- Made iPad and Mac Catalyst present the complete server-hosted web product
  with shared sessions, native downloads and confirmations, Apple-only actions,
  deep links, and a protected offline companion fallback; iPhone keeps the
  deliberately lighter native tab interface.
- Expanded the iOS 26 Inventory map with Property boundaries, areas, and Homes,
  plus one-shot current-location and Property-aware map-pin choices when adding
  equipment.

## 0.13.0 - 2026-07-26

- Added actionable native iOS notifications sent directly from each Stugu
  server through APNs, with per-device Home/severity filters, generic previews
  by default, and invalid-token cleanup.
- Added protected offline Home snapshots and chart history, bounded idempotent
  queues for field capture and alert acknowledgement, and explicit cached-data
  freshness.
- Added iOS Home and Lock Screen widgets, App Shortcuts, deep links, QR-assisted
  quick capture, and evidence-based read-only Today guidance.
- Added reviewed, geometry-only RoomPlan imports for supported LiDAR devices
  and a dependent Apple Watch companion for status and alert acknowledgement;
  neither path copies Stugu credentials or raw room imagery to the Watch/server.
- Existing databases migrate automatically. Push remains inert unless the
  complete optional APNs credential tuple is configured.

## 0.12.0 - 2026-07-26

- Added a Property-wide Inventory for maintainable equipment with stable QR
  identity, notes and issues, borrowing and return history, assigned locations,
  and an uncertainty-aware tracked state without creating a second asset model.
- Added opt-in BLE equipment tracking with rotating authenticated identifiers,
  scoped observer credentials, bounded evidence retention, confidence and
  freshness estimates, movement and exit signals, a simulator, and an
  explicitly estimated Property map. Tracking remains inert until its
  deployment flags are enabled.
- Added a native iOS companion for authenticated Home monitoring, alert
  acknowledgement, inventory QR scanning, BLE observation, Find nearby, and
  explicit foreground member-presence sharing that expires promptly and does
  not retain a location trail.
- Encrypted provisioned tracking secrets with a host-held key, required that
  key in verified backups containing tags, limited observer request size and
  credential abuse, stopped unavailable tracking polls, and accepted weak
  inventory ETags.

## 0.11.1 - 2026-07-25

- Clarified the Stuguby Host and Client flow: Hosts connect their Property
  without migration, moved Client Homes retain their authority and full edit
  access, and other participants receive a read-only overview marked with the
  three-cottage Stuguby symbol unless broader access is explicitly shared.
- Expanded the local MCP server to a strictly read-only 54-tool inspection
  surface covering current Stuguby, analytics, energy, actions, maintenance,
  integrations, backup, and readiness data, with SQLite read-only and
  query-only enforcement.
- Added a guarded maintenance script for removing an orphaned legacy Stuguby
  when malformed pre-0.11 grant data prevents the normal UI lifecycle. It
  requires exact identity confirmation, creates and verifies a complete backup,
  refuses adopted Properties, preserves Home and Property rows, restores
  stopped services after failure, and verifies SQLite after restart.

## 0.11.0 - 2026-07-25

- Added Stuguby Property adoption with clear separation from local Properties,
  reviewed merge-and-delete migration, durable offline edits, coordinator-wins
  conflict handling, and explicit permanent disconnect.
- Shared Homes are read-only by default and can opt into synchronized manual
  inventory edits. One designated successor can retain a complete sanitized
  recovery copy and promote it during Server decommissioning; integrations,
  endpoints, credentials, controls, and accounts remain local.
- Added subtle Stuguby ownership, edit, pending, conflict, recovery, and offline
  states throughout the existing Property and Home interface, plus the
  three-cottage Stuguby mark.
- Enforced the same Stuguby ownership rules across REST and MCP, including
  owner-only integrations and binary floor-plan authoring.
- A sensor can now keep direct TP-Link and Home Assistant bindings together:
  the healthy direct path is preferred for live data, Home Assistant provides
  failover and recovery, and equivalent handover samples are not duplicated.
- Stuguby coordinators can now be connected to Cloudflare from the authenticated
  local Stugu UI. Stugu registers a private OAuth client from a one-time OAuth
  Client Write bootstrap token, completes PKCE consent, hands the in-memory
  grant once to the trusted host agent, provisions and verifies the boundary,
  and revokes temporary access. Existing installations reuse their runtime
  Access-group token; new installations enter it once in the UI. No provider
  token is stored in browser storage or the host-agent queue. Interactive
  Docker installs and remote-UI upgrades now continue in this UI automatically;
  explicit Cloudflare CLI flags remain available for automation and recovery.
- Stuguby setup now asks how people will use Stugu, suggests and verifies the
  existing secure address, and gives plain recovery guidance instead of a
  disabled technical form. Existing Cloudflare remote access upgrades reuse
  the retained runtime approval, request one temporary owner approval, then
  provision and verify the coordinator automatically. Reruns preserve the
  installed runtime, data mode, web port, and connected update helper.
- Cloudflare provisioning can now obtain its temporary approval through an
  Authorization Code + PKCE browser flow. Setup validates a loopback callback,
  never retains the OAuth token, revokes the access token after success or
  failure, and keeps the exact-zone API-token path available for multi-zone
  accounts.
- Added a guarded **Delete Stuguby** action under Advanced. It removes local
  federation records and cached assets without touching Home data, and refuses
  deletion while memberships, Home grants, or replica deletion receipts remain
  active.

## 0.10.1 - 2026-07-24

- Fixed Docker and Podman startup permissions across Linux, macOS, and Windows
  by selecting rootless-safe named volumes, applying shared SELinux labels to
  host binds, and writing explicit exports with the runtime-mapped identity.
- Added portable local-mode CI, verified scheduled-backup export, dynamic
  container DNS for API recreation, and cross-platform setup/runtime checks.

## 0.10.0 - 2026-07-24

- Added an explicit Docker setup option to install and immediately start the
  host update agent as a per-user startup service. The opt-in wizard warns that
  the agent has Docker-administrator authority; unattended setup must pass
  `--install-update-agent`.
- Fixed host update agents to target the Compose project derived from the
  installation directory instead of an unrelated hard-coded project. The
  agent now verifies the running API and web before backup and never attempts
  rollback when a pre-update backup fails before release state changes.

## 0.9.0 - 2026-07-24

- Added guided Cloudflare Tunnel + Access onboarding to the setup wizard for
  Docker and Podman. It accepts tokens only through hidden input or protected
  files, enforces separate setup/runtime credentials, provisions least-scope
  path policies, starts the connector, verifies the complete edge boundary,
  and stops public ingress automatically if verification fails.
- Fixed Stuguby coordinator upgrades to repin unjoined loopback federations,
  revoke stale origin-bound invitations, block unusable admissions, recreate
  origin-consuming services, and verify the complete public invitation handoff.

## 0.8.0 - 2026-07-24

- Added a cross-platform setup wizard for local Node.js, Docker, Podman, and
  Raspberry Pi appliance onboarding. It configures only the essential data
  mode and container port, preserves existing secrets and advanced settings,
  validates container Compose configuration, and supports dry-run automation.
- Fixed local API, development, and MCP commands to load the root `.env` and
  resolve runtime paths from the repository root. No data migration is needed.

## 0.7.0 - 2026-07-24

- Added an evidence-led Home performance review covering comfort exposure,
  ventilation recovery, opening effectiveness, heating-energy normalization,
  measured maintenance outcomes, and sensor health, with explicit provenance,
  coverage limits, responsive presentation, and English, Finnish, and Swedish
  guidance.
- Added bounded opening-state history and Home-scoped action-run queries, while
  enforcing maintenance-task ownership across Home and property boundaries.

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

- Added resumable live Stugu-to-Stugu migration over authenticated SSH with
  online seed snapshots, content-addressed chunks, portable settings and secret
  transfer, final writer quiescence, isolated TimescaleDB candidate restore,
  full backup verification, health-gated commit, automatic target rollback,
  durable receipts, and fail-closed split-brain protection.
- Added inert-until-granted Stuguby federation for independently administered Stugu nodes,
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
  static edge-operator allowlist, separation from the local Stugu owner login,
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

- Initial local-first Stugu digital-twin vertical slice.
