# Known MVP limitations

Review these constraints before using physical data, alerts, or external
automations. They distinguish the working vertical slice from the hardened
system described in the roadmap.

## Physical ingest correctness

- Direct H100/H200 ingestion depends on the community-maintained `python-kasa`
  implementation of TP-Link's local protocol. Supported firmware fixtures can
  lag new hub firmware; validate before upgrading a working deployment.
- T310/T315 child state does not provide a distinct source measurement time
  through this path. Direct samples use the successful local poll time. Values
  are written on change and at least every five minutes when unchanged.
- Direct and Home Assistant adapters may run together, but there is no automatic
  cross-adapter deduplication. Map a physical child through only one adapter.
- The bridge fetches current mapped states at startup/reconnect, converts
  Fahrenheit and Kelvin to canonical Celsius, and caches paired temperature,
  humidity, and battery values per sensor for v1 compatibility. Generic v2
  mappings persist each metric independently with its Home Assistant
  `last_updated` time. Unknown temperature units are rejected rather than
  silently corrupting history.
- Home Assistant's current-state reconciliation does not backfill every event
  missed during an outage. Use Home Assistant history import or another
  ingestion adapter when gap-free source history is required.
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
  five seconds and the direct bridge defaults to ten seconds; device sampling
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
  fallbacks, and forecasts are not historical observations. Moving or clearing
  the independent map placement does not purge this history. Weather and fitted
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
  horizontal plans may use a calibrated local coordinate system. The renderer
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
  There is not yet a comprehensive operator audit log.
- Home Assistant and direct TP-Link configuration are Home-scoped. Several
  Homes may use independent credentials and local endpoints in one Stuga
  installation. A Home Assistant connection remains one URL/token per Home;
  direct TP-Link supports multiple named connections and mapped devices.

Planned remedies and release gates are in [Modular roadmap](roadmap.md).
