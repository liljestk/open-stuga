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
- The shared map combines every precisely placed house and every legacy
  weather-located house, with pins for legacy houses that lack calibrated map
  placement. Stuga does not yet model property/site grouping or surveyed
  parcel boundaries, so one view can span multiple unrelated properties.
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

- Sustained-duration state is in process memory and evaluated only when another
  reading arrives. It resets on restart and does not fire on a wall-clock timer
  while a value remains flat.
- The MVP sends a new alert webhook once with a 10-second timeout. It has no
  durable retry/dead-letter queue, signature, destination allowlist, or fan-out.
- Only one outbound URL is configured. Multiple destinations need a relay.
- Stuga is not a certified safety/alarm system.

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

- There is no general API user authentication or per-house authorization. The
  optional ingestion key protects `POST /api/v1/readings` and
  `POST /api/v2/measurements`. The local API
  defaults to `127.0.0.1` and Compose keeps it behind the loopback-bound web
  proxy; add a trusted authenticated gateway/VPN before widening either bind.
- The credential setup routes share that same trust boundary. Anyone who can
  reach the API can replace integration settings. Keep the default loopback
  bind or place the whole application behind authenticated access before LAN or
  internet exposure.
- Home Assistant mDNS and TP-Link broadcast discovery are best-effort. Guest
  Wi-Fi isolation, VLANs, firewalls, and Docker bridge networking can hide a
  device from a scan even when its manually entered address is routable.
- Neither v1 nor v2 SSE has a durable event ID/resume cursor. Reconnecting
  clients must refresh the relevant snapshot/history.
- MCP authorization is the ability to launch the local stdio process and access
  its database. `create_observation` mutates data.
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

- High-frequency samples grow per metric. Ten sensors × three metrics every five
  seconds produce about 15.6 million metric samples in a 30-day month. Tune
  sampling intervals and `RETENTION_DAYS` for the host, monitor the database,
  and add downsampling/rollups or a time-series repository before long
  multi-year production retention.
- Raw samples, compatibility readings, and outdoor temperature boundaries are
  purged daily; other records and backups need an explicit user policy and
  lifecycle.
- There is no built-in online-backup/restore command or audit log yet. Stop the
  API for simple file backups or use SQLite's online backup tooling.
- Home Assistant configuration supports one base URL/token/map and direct
  TP-Link configuration supports one hub account/host per API process. The
  Setup home selector does not scope those credentials per home. Run separate
  adapters/instances or add a relay for several source installations.

Planned remedies and release gates are in [Modular roadmap](roadmap.md).
