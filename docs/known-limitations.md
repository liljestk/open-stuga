# Known MVP limitations

Review these constraints before using physical data, alerts, or external
automations. They distinguish the working vertical slice from the hardened
system described in the roadmap.

## Analytics foundation

- The analytics query is a bounded, on-demand first slice, not the complete
  Graphing and Stats subsystem. It supports house-scoped sensor series and
  deterministic descriptive summaries, explicit evidence-query controls, and
  ranges through one year; saved views, comparison periods, brush selection,
  distributions, scientific derived metrics, findings, topology models,
  validated forecasts, and predictive-maintenance signals remain deferred.
- Stuga currently uses a database-wide, one-way demo-to-real transition rather
  than `dataMode` columns and composite constraints on every telemetry row. The
  analytics request, response, and export require an explicit mode and reject a
  mismatch, but a future coordinated storage migration is still needed to meet
  the full per-record isolation design.
- Rollups are computed in memory from a bounded SQLite/Timescale read. Requests
  fail at the source or output budget instead of truncating silently. There are
  no persisted rollups, semantic cache, or late-data invalidation jobs yet.
- Buckets are aligned to UTC. The requested house timezone is preserved for
  rendering and export, but local-calendar daily aggregation and explicit
  23/24/25-hour daylight-saving behavior are not implemented yet.
- Coverage is inferred from the median cadence present in the requested series.
  It is useful evidence of missingness, not a substitute for a source-declared
  sampling schedule. Only source-estimated, stale, missing, low-coverage, and
  counter-reset quality states currently reach generic rollups. Source-quality
  filtering includes or excludes whole source samples; it does not repair or
  interpolate the intervals they leave behind.
- Rate rollups cap the held value at 1.5 inferred cadences; cumulative counters
  treat decreases as resets. Meter-specific rollover maxima and energy
  conservation validation require device metadata and are not inferred.
- The existing SVG chart is retained. The new evidence section has an accessible
  table, but manual screen-reader/keyboard and visual-regression review is still
  required before claiming complete WCAG 2.2 AA coverage.

## Physical ingest correctness

- Direct H100/H200 ingestion depends on the community-maintained `python-kasa`
  implementation of TP-Link's local protocol. Supported firmware fixtures can
  lag new hub firmware; validate before upgrading a working deployment.
- T310/T315 child state does not provide a distinct source measurement time
  through this path. Direct samples use the successful local poll time. Values
  are written on change and at least every minute when unchanged.
- Direct and Home Assistant adapters may run together, but there is no automatic
  cross-adapter deduplication. Map a physical child through only one adapter.
- The bridge fetches current mapped states at startup/reconnect, converts
  Fahrenheit and Kelvin to canonical Celsius, and caches paired temperature,
  humidity, and battery values per sensor for v1 compatibility. Generic v2
  mappings persist each metric independently with its Home Assistant
  `last_updated` time. Unknown temperature units are rejected rather than
  silently corrupting history.
- Sensor/metric availability transitions are recorded as durable data gaps. A
  15-minute periodic scan also examines the preceding 30 days, but only for
  `good` direct TP-Link samples. Estimated retained/private/app rows are not
  treated as exact cadence proof. Home Assistant entities are event-driven and
  stable values can be silent, so they are deliberately excluded from periodic
  timestamp-hole discovery. Availability gaps after a reconnect still query
  Home Assistant recorder history in bounded chunks.
- The direct `python-kasa` path can request retained T310/T315 climate buckets
  from an H100/H200 and supported power history from an energy device. These are
  reverse-engineered local commands, not a TP-Link compatibility contract.
  Climate recovery is at most 96 15-minute buckets (approximately one day), not
  the original two-second stream. Power interval and retention depend on model
  and firmware. Retained rows are `estimated`; unsupported, out-of-retention,
  and missing-bucket results remain visible as `not-supported` or `partial`.
- After local TP-Link retention is incomplete, an explicitly configured private
  compatibility adapter is tried before Appium. It is not an official API and
  accepted rows remain `estimated`; failure falls through to the documented app
  export instead of being treated as proof that no data exists.
- The optional older-history fallback controls the Tapo Android UI through
  Appium. It is disabled and inert by default. Enabled mode requires a stable
  target-lock ID; exact UDID/platform/language/locale, Appium, UiAutomator2, and
  APK pins; hardened Appium logging; a dedicated-account attestation; and either
  login credentials or a per-account proof. It remains sensitive to selector,
  screen, login, 2FA, consent, and firmware changes. Unknown UI states stop at
  `needs-attention`; they are never interpreted as successful exports.
- The account email/proof is HMAC-bound into the deployment fingerprint, but it
  is an operator attestation rather than a Tapo-issued runtime identity. Runtime
  safety still depends on a globally unique live alias and the exact immutable
  `deviceProofs[deviceId]` value on the device page. Checked-in `CHANGE_ME`
  selectors and unit tests cannot replace a live canary against the exact APK.
- Tapo CSV files do not reliably include a stable device ID. Stuga correlates a
  job through a random capability plus-address and stored sensor/device binding.
  It requires a unique alias discovered for the immutable device ID, then makes
  the flow tap and re-verify that alias. Every leased attempt rotates the hidden
  address, so late mail from a retry/cancelled generation cannot complete the
  current generation.
- A canary must span at least eight export intervals and no more than
  `max(7 days, 8 intervals)`. It proves both climate columns against overlapping
  trusted-good live data; its staged rows are excluded from ingestion and gap
  recovery. Approval is scoped to the target/device/alias/timezone/interval,
  runner fingerprint, exact API build/acceptance/parser revision, and observed
  CSV schema. It expires after 30 days and is renewed ahead of expiry when work
  is queued. Any relevant deployment change or schema drift relocks ordinary
  jobs until a fresh canary passes.
- One attachment is limited to 8 MiB and 23,000 raw data rows; no more than
  20,000 accepted rows (about 40,000 climate samples) complete one job. Explicit
  recovery is limited to the most recent two years and normally split into
  sequential segments no longer than 30 days; the one-minute row budget is
  shorter. The flow's bounded `repeatTap` calendar action supports zero through
  24 month steps, but its selectors still require live calibration.
- Parsing fails closed on ambiguous/missing columns, invalid UTF-8, a missing or
  conflicting Celsius/Fahrenheit declaration, timezone/range/cadence gaps,
  excessive malformed rows, duplicate conflicts, or canary-schema drift.
  Completed jobs retain the exact attachment SHA-256/byte length, parser version,
  and schema signature for audit; they do not expose the recipient capability or
  Gmail message ID. Stuga does not retain a second raw CSV or RFC-message copy,
  so later byte-for-byte replay depends on the operator's Gmail retention policy.
- Gmail ingestion requires offline OAuth with the restricted `gmail.readonly`
  scope and accepts only mail to the hidden job alias with a Gmail timestamp no
  earlier than the server-recorded app submission. The mailbox must support plus addressing and
  preserve the tagged recipient header. The token's `/users/me/profile` identity
  must match the configured primary Gmail account; Workspace aliases/catch-alls
  need an explicit override. The default permits only one claimed/running or
  waiting-email generation. Authenticated health reports expose last success,
  last error/code, consecutive failures, and Gmail budget exhaustion; the setup
  UI summarizes the current error, queue cap, worker, and deployment. The reader
  does not delete or mark mail read, so mailbox retention and privacy are
  operator responsibilities.
- The supported topology is exactly one runner process for each Android target.
  API leases serialize claimed jobs, but two replicas sharing one UDID can still
  interfere while reconciling Appium sessions before either process claims work.
- TP-Link states that a T310/T315 hub must remain online to upload history, that
  power-outage intervals are lost, and that restarting the hub can delete
  unuploaded history. Neither local recovery, Home Assistant, nor app automation
  can reconstruct a sample that no source retained.
- TP-Link does not publish an end-user Tapo smart-home API. The optional private
  HTTPS adapter is explicitly experimental and operator-maintained; endpoint,
  identity, units, time range, authentication, rate limits, terms, and version
  compatibility require independent validation. It is not enabled by Tapo
  account credentials alone. See
  [Automated Tapo history recovery](tapo-history-automation.md).
- Separate temperature and humidity entities can update a few seconds apart.
  The v1 combined reading therefore contains the newest known value of each
  metric rather than an atomic sample. Use v2 samples when source timing matters.
- Generic string mappings require a Home Assistant unit that exactly matches
  the definition's canonical unit. The explicit binding form supports a declared
  linear scale/offset; CO2 ppb-to-ppm is `scale: 0.001`. No mg/m³-to-ppm
  conversion is inferred because it needs additional context.
- Home Assistant `unknown`, `unavailable`, non-numeric, and non-finite states are
  ignored. They are not converted into zeros.
- **Freshness is source-bounded.** The official TP-Link integration polls every
  five seconds and the direct bridge defaults to two seconds; device sampling
  and network delay are additional.

## House weather and map

- For Finnish homes, current conditions come from the nearest recent FMI station
  with temperature data, first within roughly 40 km and then 120 km. For other
  homes, Open-Meteo current conditions are modelled. Neither is a measurement at
  the house; terrain, elevation, coast, urban effects, model resolution, and
  localized precipitation can differ substantially.
- Automatic routing chooses one provider from the saved country code or a
  conservative Finland outline; it is not failover between providers. A wrong
  manual coordinate/country can choose the wrong path. Open-Meteo coverage and
  model availability also vary by location, and this adapter provides no
  official warning service outside FMI's covered Finnish path.
- The 10-minute weather cache is process-local and not historical storage. A
  failed refresh can return the previous same-location/same-horizon response as
  `stale` for up to 60 minutes; expired forecast points and warnings are
  removed. Restart or a `House.location` change removes that fallback.
- The production background monitor refreshes all located homes with concurrency
  two, jitter, and per-home exponential backoff, but its schedule/backoff state
  is process-local. Restarting the API resets that operational state. Provider
  quotas still need to be budgeted across the number of homes, replicas, manual
  refreshes, and other clients.
- The provider-neutral weather broker and local weather SSE fan-out are also
  process-local, not a durable event log. Identical cache replays coalesce and
  events have stable IDs, but disconnected clients must reload the house weather
  REST snapshot.
- Forecast, short-range supplement, observation, and warning sources can fail
  or be inapplicable independently. Callers must inspect `componentStatus`,
  `unavailable`, timestamps, provider/station provenance, and `stale`; an empty
  forecast/warning array is not sufficient quality information by itself. "No
  warnings" is authoritative only for a fresh, available, covered component
  whose metadata explicitly makes an empty result authoritative.
- The selected FMI/Open-Meteo product set does not cover every outdoor influence.
  Radar/lightning, a standalone UV-index series, pollen, air quality,
  flood/fire, road/soil, and hyperlocal property data need separately licensed
  and validated adapters. CAP can still contain official UV advisories.
- FMI, Open-Meteo, and the standard OSM tile service are best-effort external
  services with attribution, request/caching, and privacy obligations. Place
  search sends text to Open-Meteo geocoding. Device geolocation requests browser
  permission only after an explicit action; loading the map is a separate
  explicit action that sends tile requests from the browser.
- Fresh outdoor temperature observations are persisted only in a separate,
  location-isolated boundary table with opaque location keys, weather-location
  change/clear erasure, and configured retention; other weather fields, stale
  fallbacks, and forecasts are not historical observations. Within the retained
  30-day scan window, provider-supported observation gaps are discovered and
  backfilled into SQLite and TimescaleDB; recovery cannot exceed upstream
  availability or the configured retention window. Moving or clearing the
  independent map placement does not purge this history. Weather and fitted
  models must not directly drive safety-critical HVAC, freeze protection,
  shutters, or alarms. See [Outdoor weather and home location](weather.md).
- House orientation is a user-supplied bearing for the top of the plan, not a
  surveyed building transform. When it is unknown, plan-relative wind arrows
  are deliberately omitted. Map centre, footprint floor, and scale are also
  user-supplied rather than surveyed; once calibrated, the footprint is drawn
  at geographic scale as the map zoom changes, but its accuracy is only as good
  as those inputs and the floor-plan geometry.
- A Property map combines that Property's precisely placed homes and legacy
  weather-located homes, with pins for homes that lack calibrated map
  placement. Stuga models Property membership but does not import authoritative
  surveyed parcel boundaries; user-drawn areas remain contextual geometry.
- The visualisation can identify a windward rectangular **plan edge**, not a
  verified exterior wall segment. Walls do not yet carry envelope/interior
  classification, outward normals, openings, adjacency, material conductance,
  airtightness, or calibrated scale. Irregular footprints need that topology
  before the system can make wall-level claims.
- The outdoor arrow is a current external boundary cue. Provider temperature and
  humidity are not injected into indoor scalar interpolation. Fresh oriented
  wind can provide a weak normalized circulation force only near a modeled
  windward window; window state, leakage area, and pressure coefficients remain
  unknown, so this must not be interpreted as infiltration volume. The optional first-order thermal
  model is a sensor-scoped empirical temperature baseline, not a physical
  heat-loss, pressure, infiltration, moisture-transport, airflow, or CFD model.
  Live outdoor context is withheld during historical replay.

## Alerts and delivery

- Sustained-duration state is persisted in SQLite and chronology-fenced, so it
  survives API restarts. Evaluation remains sample-driven: a flat value does not
  fire on a wall-clock timer until another reading arrives.
- New webhook and Telegram notifications are persisted in a SQLite outbox and
  retried with bounded exponential backoff. Delivery is at-least-once: a process
  failure after the remote service accepts a request but before the local commit
  can cause a duplicate. Webhooks carry a stable `Idempotency-Key`; receivers
  should deduplicate it. Telegram has no equivalent idempotency facility.
- Each row stores an immutable rendered payload and a one-way destination
  credential reference. Rule retirement preserves its alert history and queue;
  destination rotation abandons mismatched old work instead of rerouting it.
  Legacy unbound queued rows are retained but fail closed rather than being
  attached to whichever destination happens to be configured after migration.
  A sensor referenced by alert history must be disabled instead of deleted.
- The outbox currently has no maximum-attempt/dead-letter policy, webhook
  signature, destination allowlist, or fan-out. A successful Bot API response
  confirms acceptance by Telegram, not that the recipient read it. Mock and
  replay samples are blocked from both external channels.
- Telegram currently sends newly opened threshold alerts only. Maintenance due
  reminders and task completion/verification notifications are not scheduled
  or delivered automatically.
- Only one outbound URL is configured. Multiple destinations need a relay.
- Repeated open events are grouped for presentation, but there is not yet a
  durable issue/incident lifecycle, snooze state, escalation policy, seasonal
  baseline, or cross-sensor/weather correlation engine. Acknowledgement does not
  resolve the event.
- Overview and Alerts now withhold a monitoring all-clear when enabled sensors
  are missing, stale, estimated-only, missing an enabled-rule/declared metric,
  or depend on a disconnected TP-Link/Home Assistant source, and explain the
  strongest blocker. TP-Link and Home Assistant connections are Home-scoped;
  one installation can run independent connections for several Homes. This is monitoring
  coverage, not full arrival/departure readiness: operating modes, water/window
  state, asset checks, and inspection checklists are not yet modelled.
- Stuga is not a certified safety/alarm system.

## Apple Notes bridge

- Apple does not publish a server API for the Apple Notes database. The bridge
  runs only when the user invokes or schedules an iOS Shortcut; Stuga cannot
  react invisibly to an arbitrary note edit.
- Current documented Notes actions do not provide conflict-aware arbitrary
  body replacement. Stuga creates dated generated snapshots and accepts
  explicit note-to-task capture instead of overwriting a personal note.
- A Notes checkbox is not treated as maintenance completion or verification.
  Those lifecycle steps retain their required notes, server timestamps, and
  optimistic revision checks in Stuga.
- Personal automations are configured per Apple device. The Shortcut can sync
  through iCloud, but its personal automation does not.

## Measurement registry and visualisation

- The registry accepts finite numeric scalar measurements only. Categorical,
  boolean, vector, spectrum, structured, and arbitrary text samples need a
  separately typed future model; do not encode categories as magic numbers.
- Built-ins are temperature (°C), relative humidity (%), and CO2 (ppm). A custom
  sample's unit must exactly match its definition's canonical unit. Definition
  IDs/units should be treated as immutable once integrations, history, or rules
  refer to them; disable obsolete definitions rather than reuse their identity.
- A definition with `spatialInterpolation: false` is shown only as sensor
  markers and history. A definition with `forecastSupported: false` has no
  forecast. These are deliberate capability results, not missing-data errors.
- Even when enabled, a heat/air-quality surface is an interpolation estimate
  from sparse point sensors. The separate indoor-motion paths use a coarse
  normalized buoyancy and pressure-projection model with wall/door constraints;
  they are not measured airflow, physical speed, calibrated CFD, contaminant
  exposure, or a ventilation-compliance result.
- Measurement availability differs by sensor and metric. The latest CO2 value
  may be older or newer than temperature at the same placed sensor; freshness,
  source, and quality must be read from that metric's own sample.

## API, stream, MCP, and access

- Built-in accounts protect browser REST and SSE access in one local workspace.
  The API enforces owner/administrator roles and read-only Guest property,
  house, and area grants. The optional ingestion key protects external machine
  ingestion and is separate from browser sessions. Authentication does not
  encrypt traffic; keep the default loopback bind or add TLS with a trusted VPN
  or reverse proxy before widening it.
- Credential setup and account/access administration require an owner or
  administrator. A hidden client control is not an authorization boundary; all
  role and grant checks must remain server-side.
- Home Assistant mDNS and TP-Link broadcast discovery are best-effort. Guest
  Wi-Fi isolation, VLANs, firewalls, and Docker bridge networking can hide a
  device from a scan even when its manually entered address is routable.
- Neither v1 nor v2 SSE has a durable event ID/resume cursor. The bundled client
  subscribes before hydrating, buffers intervening events, and refreshes the
  relevant snapshot/history after reconnects. Other clients must do the same.
- MCP authorization is the ability to launch the local stdio process and access
  its database; it does not use browser account sessions or Guest grants.
  `create_observation` and `update_observation` mutate data. Their revision actor
  identifies the trusted local channel rather than a browser account.
- SQLite is the single-host store. Multi-process MCP/API access is appropriate
  for this scale but not a substitute for a multi-user database deployment.

## Assets and digital-twin authoring

- The asset API accepts only PNG, JPEG, WebP, glTF, and GLB blobs up to 10 MiB;
  model files are forced to download and asset responses use a sandbox policy.
  It does not yet verify file signatures or enforce image dimensions/model
  complexity, so accept trusted files only.
- The working UI includes a responsive 2D floor editor and a generated,
  orbitable whole-building 3D projection. It renders all floors, sensor mounting
  heights, observations, a sparse-sample XYZ cloud, and a shared 2D/3D
  sensor-constrained relative flow estimate with scalar-gradient fallback. It assumes floors share the same
  horizontal origin and orientation. Elevation and sensor `z` are metres;
  horizontal plans may use a calibrated local coordinate system. A measured
  wall can calibrate `Floor.metersPerPlanUnit`; every wall length, area, and
  volume is then derived from that shared level scale rather than stored as a
  conflicting independent measurement. Legacy map-placement scale remains a
  fallback. The renderer
  uses an orthographic camera and vertical normalization for legibility.
- The API can retain glTF/GLB assets, but importing, aligning, interactively
  rendering, or editing those models remains a roadmap capability. Essential
  controls and values continue to have non-3D representations.
- The indoor-motion layer has no opening state/effective area, vent mode/flow,
  HVAC state, horizontal metre scale, stairs, or shafts. It keeps floors
  isolated and reports only relative direction. See
  [Sensor-constrained indoor flow](airflow-simulation.md).

## Predictions and replay

- `linear-v1` is a damped trend baseline for interface/testing work, not a
  calibrated predictive-maintenance model or diagnosis.
- Only registry definitions with `forecastSupported` enabled can use this
  baseline; unsupported metrics report no forecast rather than fabricated bands.
- Ambient relative humidity does not directly measure surface condensation,
  hidden leakage, structural moisture, or mould.
- Mock scenarios validate software paths, not model accuracy.
- Replay is transient, labeled, and does not re-run the alert engine in the MVP;
  it is a visual/event-stream replay rather than a complete policy backtest.

## Data lifecycle and operations

- High-frequency samples grow per metric. Ten sensors times three metrics every
  five seconds produce about 15.6 million metric samples in a 30-day month.
  Compose now archives raw telemetry in TimescaleDB hypertables and maintains
  5-minute, 1-hour, and 1-day measurement rollups, but disk growth still needs
  monitoring and capacity headroom.
- Raw samples are not deleted from TimescaleDB. `RETENTION_DAYS=0` keeps the
  complete redundant SQLite copy; values of 30 or more enable guarded hot-copy
  pruning only after the archive is caught up and clean. A full raw JSON export
  after pruning is intentionally rejected; use the verified dual-database
  backup until an archive-streaming export is added.
- Observation revisions are append-only while an observation exists, but
  permanent observation deletion also deletes its revision ledger. There is no
  soft-delete/legal-hold workflow; export evidence before deletion.
- Demo and real telemetry are separated by a persistent one-way database latch,
  provenance checks, and a visually distinct browser shell. They do not occupy
  independently addressable workspaces inside one local installation. Use
  separate databases/installations and credentials when a demo must coexist
  with production.
- The backup CLI creates and verifies consistent SQLite snapshots and an
  opt-in full TimescaleDB dump. Restoration remains an explicit operator
  procedure, and each new recovery point still needs an isolated restore drill.
  The security ledger covers authentication, membership, integration credential,
  and bridge-grant lifecycles. It is not yet a comprehensive audit of every
  Property, layout, observation, maintenance, export, or data-lifecycle mutation.
- Home Assistant and direct TP-Link configuration are Home-scoped. Several
  Homes may use independent credentials and local endpoints in one Stuga
  installation. A Home Assistant connection remains one URL/token per Home;
  direct TP-Link supports multiple named connections and mapped devices.

Planned remedies and release gates are in [Modular roadmap](roadmap.md).
