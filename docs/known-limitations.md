# Known MVP limitations

Review these constraints before using physical data, alerts, or external
automations. They distinguish the working vertical slice from the hardened
system described in the roadmap.

## Physical ingest correctness

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
  five seconds; device sampling and network delay are additional.

## House weather and map

- Current conditions come from the nearest recent FMI station with temperature
  data, first within roughly 40 km and then 120 km. They are not a measurement
  at the house; terrain, elevation, coast, urban effects, and localized
  precipitation can differ substantially.
- The 10-minute weather cache is process-local and not historical storage. A
  failed refresh can return the previous same-location/same-horizon response as
  `stale` for up to 60 minutes; expired forecast points and warnings are
  removed. Restart or location change removes that fallback.
- Forecast, short-range supplement, observation, and warning sources can fail
  independently. Callers must inspect `unavailable`, timestamps, station
  provenance, and `stale`; an empty forecast/warning array is not sufficient
  quality information by itself.
- The selected FMI product set does not cover every outdoor influence.
  Radar/lightning, a standalone UV-index series, pollen, air quality,
  flood/fire, road/soil, and hyperlocal property data need separately licensed
  and validated adapters. CAP can still contain official UV advisories.
- FMI and the standard OSM tile service are best-effort external services with
  attribution, request/caching, and privacy obligations. Opening the map sends
  tile requests from the browser; browser geolocation itself is disabled.
- Weather values are not persisted as sensor history and must not directly
  drive safety-critical HVAC, freeze protection, shutters, or alarms. See
  [FMI weather and house location](weather.md).

## Alerts and delivery

- Sustained-duration state is in process memory and evaluated only when another
  reading arrives. It resets on restart and does not fire on a wall-clock timer
  while a value remains flat.
- The MVP sends a new alert webhook once with a 10-second timeout. It has no
  durable retry/dead-letter queue, signature, destination allowlist, or fan-out.
- Only one outbound URL is configured. Multiple destinations need a relay.
- Climate Twin is not a certified safety/alarm system.

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
  from sparse point sensors. It is not a measured airflow path, contaminant
  transport model, room-average exposure, or building-physics simulation.
- Measurement availability differs by sensor and metric. The latest CO2 value
  may be older or newer than temperature at the same placed sensor; freshness,
  source, and quality must be read from that metric's own sample.

## API, stream, MCP, and access

- There is no general API user authentication or per-house authorization. The
  optional ingestion key protects `POST /api/v1/readings` and
  `POST /api/v2/measurements`. The local API
  defaults to `127.0.0.1` and Compose keeps it behind the loopback-bound web
  proxy; add a trusted authenticated gateway/VPN before widening either bind.
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
  heights, observations, a sparse-sample XYZ cloud, and supported 3D scalar
  gradients from structured floor geometry. It assumes floors share the same
  horizontal origin and orientation. Elevation and sensor `z` are metres;
  horizontal plans may use a calibrated local coordinate system. The renderer
  uses an orthographic camera and vertical normalization for legibility.
- The API can retain glTF/GLB assets, but importing, aligning, interactively
  rendering, or editing those models remains a roadmap capability. Essential
  controls and values continue to have non-3D representations.
- Interpolated environmental movement is a visual estimate between sparse point
  sensors, not a measured airflow or building-physics simulation.

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
- Raw-sample/readings retention runs daily; other records and backups need an explicit
  user policy and lifecycle.
- There is no built-in online-backup/restore command or audit log yet. Stop the
  API for simple file backups or use SQLite's online backup tooling.
- Home Assistant configuration supports one base URL/token/map per API process.
  Run separate adapters/instances or add a relay for several HA installations.

Planned remedies and release gates are in [Modular roadmap](roadmap.md).
