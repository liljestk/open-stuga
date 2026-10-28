# Stugu architecture

Stugu is a local-first digital twin for observing environmental
measurements across one or more homes. Temperature and relative humidity are the
initial use case, not the storage model: a registry describes CO2 and other
finite numeric scalar measurements. TP-Link/Tapo equipment and Home Assistant
remain replaceable adapters, so history, visualisation, alerts, replay, and
integrations do not depend on a particular sensor vendor or a fixed metric list.

## Design goals

- Keep telemetry and floor plans on the user's own machine by default.
- Show new readings quickly while retaining queryable history independently of
  Home Assistant's recorder retention.
- Represent several Homes, floors, rooms, sensors, manual observations, and
  static building properties without hard-coded labels or locale assumptions.
- Use one versioned contract for the web app and external clients.
- Degrade clearly: live, reconnecting, stale, and replay data must not be
  visually confused.
- Keep ingestion, storage, prediction, alerts, and presentation modular so a
  production deployment can replace one piece without rewriting the others.

## Deployment topology

Stugu ships as container images and as a Raspberry Pi appliance image. It does
not run on a hosted platform. One Compose project holds the whole system; the
optional services sit behind Compose profiles and stay absent until enabled.

```mermaid
flowchart LR
    people["Browser, iPhone,<br/>iPad, Mac"] -->|"HTTP :8080<br/>loopback by default"| web

    subgraph compose["One Compose project"]
        web["web<br/>Nginx: static app,<br/>/api reverse proxy, SSE"]
        api["api<br/>Express, SQLite,<br/>background services,<br/>Python device bridges"]
        tsdb[("timescaledb<br/>permanent telemetry")]
        scheduler["stugu-backup-scheduler<br/>verified recovery sets"]
        web --> api
        api --> tsdb
        scheduler --> tsdb

        subgraph optional["Optional profiles"]
            agent["stugu-update-agent<br/>self-update"]
            cloudflared["cloudflared<br/>cloudflare"]
            r2["stugu-r2-backup<br/>r2-backup"]
            mqtt["mqtt + nexus433<br/>433 MHz receiver"]
            tapo["tapo-export-runner<br/>tapo-history"]
            maint["stugu-backup, migration,<br/>telemetry-migrate<br/>maintenance"]
        end

        api <-.->|"bounded request and<br/>status files"| agent
        cloudflared -.-> web
        mqtt -.-> api
        tapo -.-> api
        scheduler -.->|"encrypted copies"| r2
    end

    api -->|"local LAN polling"| devices["Tapo hubs, Tuya,<br/>Gree, Home Assistant"]
    api -->|"HTTPS"| providers["FMI, Open-Meteo,<br/>price feed"]
    agent -->|"digest-pinned images"| ghcr["GitHub Releases<br/>+ GHCR"]
```

- The API container is private to the Compose network; only `web` publishes a
  host port. Containers keep state in named volumes, so `docker compose down`
  keeps history.
- The update agent is the only service with Docker access. The API asks it for
  work through files in a shared operations directory and never replaces
  itself. See [System updates](system-updates.md).
- On the [Raspberry Pi appliance](raspberry-pi-appliance.md), the same Compose
  project runs on an immutable A/B Raspberry Pi OS root. A native TUF + RAUC
  host updater owns the operating system, and Docker state, databases and
  backups live on the shared persistent partition.
- Cloudflare Tunnel and Access are an optional, operator-owned way in. See
  [Cloudflare Tunnel and Access](cloudflare-access.md).

## Runtime view

```mermaid
flowchart LR
    subgraph Home[Home network]
        S[Tapo T310 / T315 sensors] -->|Sub-GHz| H[Tapo H100 / H200 hub]
        H -->|local LAN polling| HA[Home Assistant\nTP-Link Smart Home integration]
        TU[Tuya-compatible lamp,\noutlet, or switch]
    end

    subgraph Twin[Stugu]
        HAB[Home Assistant adapter] --> N[Normalizer and validation]
        TPL[Direct TP-Link adapter\npython-kasa helper] --> N
        TU -->|encrypted local polling\nand absolute commands| TUA[Supervised Tuya LAN adapter]
        TUA --> CD[(Provider-neutral device state,\nplacement, command journal)]
        TUA -->|verified measured power only| N
        M[Mock / replay adapter] --> N
        I[Versioned ingest API] --> N
        GRB[Gree heat-pump adapter\nlocal or EWPE Smart] --> DB
        MQ[Nexus433 receiver\nvia private MQTT] --> N
        N --> DB[(SQLite control plane,\noutbox, current projections)]
        DB --> AR[Checkpointed archive reconciler]
        AR --> TS[(TimescaleDB raw telemetry\nand continuous rollups)]
        DB --> HR[Hybrid raw-telemetry reader]
        TS --> HR
        N --> AQ[(Durable alert evaluation queue)]
        AQ --> A[Alert evaluator]
        HR --> P[Forecast service]
        DB --> Q[Query service]
        HR --> Q
        TS -->|rollups| Q
        DB --> SL[Experimental spatial-layer host]
        HR --> SL
        SL --> SDB[(Experimental spatial SQLite)]
        DB --> WM[Bounded multi-home\nweather monitor]
        WM --> WX[House weather service\nbounded provider coalescing]
        WX --> WS[(Durable canonical\n48 h weather snapshot)]
        WX --> WEB[Provider-neutral\nweather event broker]
        WEB --> ODB[(Outdoor boundary history)]
        WEB --> E
        DB --> PHY[Effective thermal model]
        ODB --> PHY
        N --> E[Live event stream]
        A --> E
        A --> NO[(Durable notification outbox)]
        NO --> W[Outbound webhook adapter]
        NO --> TG[Telegram Bot API adapter]
        Q --> API[REST APIs /api/v1 + /api/v2]
        SL --> API
        P --> API
        WX --> API
        CD --> API
        TUA --> E
        API --> LD[Location discovery]
        API --> UI[2D digital-twin web app]
        API --> IOSAPP[Native iPhone companion]
        UI --> APPLE[Full iPad and Mac client\nWebKit native shell]
        API --> APPLE
        E --> UI
        E --> IOSAPP
        MCP[Read-only MCP servers\nstdio and Streamable HTTP] --> Q
        HR --> K[Analytics kernel\nstatistics, kWh, calendar]
        K --> Q
        K --> P
    end

    HA -->|WebSocket state changes| HAB
    H -->|local LAN polling| TPL
    W --> HA2[Home Assistant automation webhook]
    W --> EXT[DayOps / OpenWearable adapter]
    TG --> TGC[Private Telegram bot chat]
    WX -->|HTTPS WFS + CAP| FMI[Finnish Meteorological Institute]
    WX -->|HTTPS forecast API| OM[Open-Meteo]
    LD -->|HTTPS geocoding + timezone| OM
    UI -->|attributed HTTPS tiles| OSM[OpenStreetMap tile service]
    CLIENT[Other clients] --> API
    IOS[iOS Shortcuts] <-->|scoped maintenance capture\n+ dated snapshot| API
    IOS --> NOTES[Apple Notes]
```

The API is the sole authority for scientific and operational derivations: Home
Performance, Home monitoring/insights, opening activity, calendar comparison,
and daily findings. Results carry algorithm versions, provenance, scope,
completeness, and warnings through shared contracts. Web and iPhone select user
intent and render results; they do not independently choose evidence windows,
truncate sensor scope, or reproduce decision rules. The web owns one pair of
telemetry transports through `LiveEventCoordinator`, which updates the live
snapshot and invalidates only affected query resources.

Heavy interactive analytics pass through one bounded process coordinator. At
most two historical analytics, energy, or thermal-simulation operations run
concurrently and at most 32 wait; overflow receives a retryable
`ANALYTICS_BUSY` response. Foreground work is admitted ahead of low-priority
work. Thermal isolation, moisture response, and Home Performance never fit on
an HTTP request: GET performs only bounded SQLite artifact/job lookups and
returns the immutable last-good artifact plus idle, queued, refreshing, stale,
or failed state. It never creates or promotes work. An authorized refresh or
the night scheduler coalesces one canonical Home/window/cutoff/algorithm/evidence
job. One durable worker fits at most one such job at a time. It refreshes
seven-day defaults once per last-complete day at a stable per-Home night-time
jitter; explicit refresh uses the same idempotent queue. A two-minute appliance
startup grace cannot be shortened by page polling, and persisted background
jobs are claimable only inside that Home's night window unless a person opens
or refreshes the corresponding panel. Four successful generations per
canonical view are retained, and restart or failure does not replace the
last-good result. Each thermal or moisture numerical fit runs in a
resource-limited worker thread; the durable coordinator starts at most one,
while v1 exact-window compatibility operations retain their existing bounded
interactive admission. Their legacy telemetry reads remain request-scoped.
Late measurement/import, weather-recovery, and opening evidence invalidates the
revision only when it overlaps an already evaluated artifact/job window;
ordinary current-day ingestion after the cutoff cannot churn daily identities.

Home monitoring and whole-Home energy still single-flight through bounded LRU
caches. Monitoring separates a two-second current-state snapshot from
minute-cached trend evidence, and the browser coalesces duplicate
legacy/measurement refresh signals before invalidating monitoring.

The browser does not talk to Home Assistant, TP-Link, Tuya devices, FMI, or Open-Meteo
directly. The API owns credentials, normalisation, retention, alert evaluation,
provider selection, weather/location-service retrieval, caching, and reconnect
logic. The location picker's attributed OpenStreetMap tiles are the one direct
third-party browser flow and are loaded only after an explicit action. Browser
geolocation is requested only after **Use this device's location**; the selected
coordinates then flow through the API. See
[Outdoor weather and home location](weather.md) for those privacy boundaries.
The native iPhone companion uses the same server-managed session, permission
checks, measurement snapshots/history, alerts, and authenticated event stream
as the browser. iPad and Mac Catalyst synchronize that session into a native
WebKit shell and present the same server-hosted interface as the browser, so
desktop workflows do not acquire a second Swift implementation. Every Apple
surface connects directly to the selected Stugu origin and introduces no
intermediary telemetry service.
Telegram is an explicit, per-rule server-side outbound flow. Apple Notes is not
a server integration: a user-run Shortcut calls a Home-scoped bridge and then
creates or reads a note on the device. Stugu never receives an Apple Account
credential and remains the canonical maintenance record.
In the default Docker deployment an Nginx web service serves the static app and
reverse-proxies `/api/*` to the API, including the server-sent event stream.
LAN integration discovery is an owner- and Home-scoped API job: the start
request returns immediately, discovery continues in the API process, and the
browser receives the job snapshot over SSE with REST polling as a reconnect
fallback. The browser remembers only the job ID so Set up can resume after
navigation; draft credentials stay in the server-side run and are never part of
the job snapshot. After a TP-Link hub is saved, its bridge keeps discovering
paired sensors and the normal integration event stream updates the UI, without
a page-owned retry loop.

The HTTP boundary resolves a built-in local account from a server-managed
HttpOnly session. One installation has one workspace. The API enforces roles
and property/house/area grants for every list, detail, history, and mutation
request; Guest mutations are rejected. The MCP server is a separate local
read-only inspection process and does not use browser sessions. It opens the
existing SQLite database with SQLite read-only and query-only enforcement;
schema migrations and all mutations remain the API process's responsibility.

The web information architecture follows ownership. Workspace navigation holds
**Overview**, **Properties**, and **Alerts**. A selected Property owns its
**Property**, **Maintenance**, and **Electricity** destinations, including
land-only Properties. A selected Home owns **Home**, **Sensors**, and **Set up**;
Activity and Outdoor are Home-scoped operational subviews. **Set up** has six
deep-linkable, keyboard-operable sections: **Overview** for readiness,
**Layout** for the floor-plan editor, **Connections** for that Home's TP-Link,
Tuya, Gree, and Home Assistant connections, **Weather** for location/timezone
and the automatic-provider summary, **Operations** for bulk source mapping and
history work, and **Automations** for Home rules. The retired `/setup/homes`
destination remains a compatibility redirect; Property map and placement tools
own that work. Current conditions, warnings, and the 48-hour forecast belong on
Outdoor rather than crowding **Set up**. Canonical URLs retain Property and
optional Home scope across refresh, Back/Forward, and copied links. Activity's
Timeline and Observations views and the meaningful evidence controls on
Property map/inventory, Home dashboard, Outdoor, Maintenance, Electricity,
Sensors, and Analytics preserve nested state with validated, default-omitting
query parameters. Discrete choices push history, search typing replaces it,
and `popstate` restores state without discarding unrelated parameters or hashes.

Overview and Alerts share one explainable Home-monitoring selector. It applies
the same freshness and quality gates as Home Pulse before presenting a Home as
currently monitored. Its ordered states are `action-required`, `unknown`,
`inspection-recommended`, and `monitoring-ok`: an unresolved warning or critical
alert wins, missing/stale coverage prevents an all-clear, and aging data or an
informational alert recommends inspection. Coverage requires the metrics used
by enabled rules and declared sensor bindings; battery-only telemetry is not
proof of indoor conditions. Estimated-only evidence and a disconnected adapter
that supplied current samples recommend inspection rather than producing a
confirmed state. Acknowledgement records that someone
saw an alert; it does not resolve the underlying condition. Surfaces show the
blocking alert or coverage gap instead of deriving an opaque readiness score.

Manual observations are mutable current records backed by append-only revision
snapshots. Their observed time and precision are independent of immutable
server-recorded time. SQLite uses optimistic revisions, validates
house/floor/sensor context, and retains actor attribution. An explicit
open/resolved lifecycle requires a resolution outcome, records resolution time
on the server, and preserves resolved/reopened transitions in those snapshots. See
[Manual observations and evidence time](observations.md).

Maintenance tasks are a Property-owned revisioned aggregate rather than another
observation state. They may target a Home/floor or Property area/equipment and
carry an explicit trust basis, priority, planned and due calendar dates,
same-Home observation links, and independent work
completion and verification evidence. Completing a task never mutates linked
observations. SQLite uses normalized link tables, optimistic revisions, and
append-only actor-attributed snapshots. See
[Activity and maintenance work](maintenance.md).

Electricity contract configuration and raw/effective price history are also
Property-owned; consumption sensors and Home Assistant/direct TP-Link
connections remain Home-owned. Telegram delivery configuration is owned by the
Workspace rather than any Property or Home.

## Data flow

```mermaid
sequenceDiagram
    participant T as Tapo child sensor
    participant H as H200
    participant D as Stugu direct adapter
    participant HA as Home Assistant
    participant B as Stugu HA adapter
    participant DB as SQLite
    participant SSE as /api/v2/measurements/events
    participant UI as Web app

    T->>H: device measurement
    par Direct path
        D->>H: local poll (configurable, 2 s default)
        H-->>D: hub and child sensor states
        D->>D: child-device map, unit normalization, validation
        D->>DB: append temperature/humidity samples
        D->>H: T110 trigger-log poll (500 ms default)
        H-->>D: timestamped open/close events
        D->>DB: append idempotent opening transitions
    and Home Assistant path
        HA->>H: local poll (currently every 5 s)
        H-->>HA: hub and child sensor states
        HA-->>B: state_changed over WebSocket
        B->>B: entity-map lookup, normalization, source arbitration
        alt same metric has a healthy direct binding
            B->>B: retain HA as failover, suppress duplicate live sample
        else direct metric unavailable or unrelated metric
            B->>DB: append sparse metric sample
        end
    end
    B-->>SSE: measurement event
    SSE-->>UI: update current values and map
    UI->>DB: metric history request through /api/v2
    DB-->>UI: samples + supported forecast through /api/v2
```

"Near real-time" is deliberately not called "instantaneous." Stugu's full
direct-device interval defaults to two seconds, its T110 trigger-log interval
defaults to 500 ms, and Home Assistant's official integration currently polls
every five seconds. End-to-end freshness is the device reporting delay plus the
chosen polling path, network/processing time, and browser delivery. Stugu cannot
make the upstream sensor report more frequently. The UI must display timestamps
and stale state rather than implying otherwise.

## Domain and storage model

The shared TypeScript contracts define the stable domain vocabulary:

- `House` contains floors, an IANA timezone, and may contain a WGS84 `location`
  used only for house-scoped outdoor context. Location metadata can retain its
  country code, discovery source/confidence/time, and whether a user overrode
  the suggestion. Its optional `orientationDegrees` is the
  clockwise true-north bearing of the floor plan's top edge; absence means
  unknown. A `Floor` contains dimensions, walls, rooms, and an optional
  background drawing.
- `Sensor` has floor-local `(x, y)` placement and an absolute metre-based `z`
  height, plus room, model, tags, enabled state, and optional Home Assistant
  entity bindings keyed by measurement ID. Floor elevation uses the same
  vertical origin.
- `MeasurementDefinition` is the registry entry for a stable metric ID. It owns
  localized labels, canonical unit, precision and valid/display ranges, colour
  scale, interpolation settings, and spatial/forecast capability flags. The
  built-ins are temperature in °C, relative humidity in %, and CO2 in ppm.
- `MeasurementSample` stores one sensor, one registered metric, one finite
  numeric value, canonical unit, UTC source timestamp, source (`mock`,
  `home-assistant`, `api`, or `replay`), and quality. Metrics from the same
  sensor are deliberately sparse and asynchronous; a CO2 update does not copy
  or re-timestamp temperature or humidity.
- `Reading` remains the required temperature/humidity tuple used by `/api/v1`.
  It is a compatibility projection, not the normalized v2 storage contract.
- `StaticParameter` adds building context such as wall material, HVAC type,
  insulation, window orientation, or room volume without changing telemetry.
- `ManualObservation` records a leak, condensation, mould, ventilation event,
  maintenance action, or note at a house/floor/sensor/coordinate.
- `MaintenanceTask` plans work independently of evidence, classifies why it is
  proposed, links same-house observations, and records completion and
  verification as separate server-timed lifecycle steps.
- `AlertRule` and `AlertEvent` separate desired policy from its lifecycle.
- `MeasurementForecastPoint` includes one registered metric's point estimate
  and low/high bounds so uncertainty can be rendered instead of hidden. A
  definition may explicitly opt out of forecasting.
- `HouseWeather` is a provider-neutral response view with the request location,
  provider/attribution, fetch and forecast issue times, optional observation
  station, current values, hourly forecast, warnings, stale state, and a list of
  independently unavailable upstream parts. Per-component status distinguishes
  availability, coverage, and whether an empty result is authoritative.
- `WeatherUpdateEvent` wraps an accepted `HouseWeather` snapshot with a stable
  event ID, publication time, and scheduled/on-demand trigger. It is the
  contract between pull or future push adapters and downstream projections.
- `OutdoorTemperatureSample` stores only fresh observed outdoor temperature in
  a separate boundary table keyed by house and an opaque location digest.
  Location changes erase old boundary rows. Forecasts and stale fallbacks are
  not observations and are not inserted.
- `ThermalModelV1`, `ThermalCalibrationResult`, and `ThermalSimulationPoint`
  keep fitted parameters, quality gates, observations, simulation, and signed
  residuals explicit. Simulated values never become measurement samples.
- `OutdoorBoundaryContext` is a web-side derived view. It normalizes the
  provider's wind-from bearing against `House.orientationDegrees`, exposes a windward plan
  edge and inward vector, and preserves the weather timestamp/stale state. It
  never creates indoor measurements.

Core SQLite is the transactional control plane, canonical store for Property,
Home, floor-plan, sensor, and other non-time-series records, and first durable
telemetry commit. Metric samples use an entity-attribute-value outbox keyed by sensor, metric,
timestamp, and source; temperature and humidity rows written through the
compatibility API are also projected into it. A checkpointed, idempotent worker
then writes indoor measurements, compatibility readings, complete outdoor
observations, electricity-price intervals, opening-state events, and every
timestamped direct heat-pump observation into PostgreSQL with TimescaleDB. Once
all six families are durably acknowledged,
SQLite compacts history and keeps current projections.
The shared `HybridTelemetryReader` presents SQLite's unacknowledged/current tail
and Timescale's permanent history as one logical source to APIs, MCP, analytics,
forecasts, recovery, replay, and experimental spatial inference. It merges
natural-key overlaps, applies the active demo/real boundary, and fails closed
when an unavailable TimeDB could make a range incomplete. Existing
legacy rows are idempotently unpivoted into temperature/humidity samples during
migration, so reopening the database does not duplicate them.

Bucketed measurement analytics take a dedicated archive path because derived
aggregates cannot safely merge an overlapping SQLite tail. The reader waits for
archive reconciliation, then PostgreSQL computes bounded UTC buckets over the
complete raw range. Raw rows remain permanent but do not cross the API process
boundary for these queries. Exact quality, counter-reset, cadence, and
time-weighted semantics continue to use raw archive rows where the existing
continuous aggregates cannot reproduce them. Request admission, single-flight
caches, a bounded connection pool, and disabled PostgreSQL per-query worker
fan-out prevent those exact reads from multiplying into CPU spikes.

SQLite WAL mode remains a good fit for the single local writer and keeps an
archive outage from blocking ingestion. TimescaleDB supplies time partitioning,
cold-chunk optimization, and continuous rollups for multi-year history. House
location metadata stays in the control plane. Fresh provider temperatures are
also retained in a location-isolated outdoor-boundary series for physics
calibration; one bounded 48-hour last-good weather snapshot per Home remains in
SQLite for local foreground reads. All stored
timestamps are UTC ISO-8601, and a Home timezone controls display and calendar
grouping.

Optional experimental spatial state has its own WAL SQLite file. It stores only
versioned overlays/configuration, bindings, calibrations, context, jobs,
checkpoints, model runs, ground truth, and derived snapshots. It never copies
core Property/sensor masters or raw samples. A persisted core source UUID plus
demo/real mode partitions that state, so moving the core database does not
orphan it and a different database at the same path cannot silently inherit it.

The provider-neutral weather broker is the process-local middle layer between
weather retrieval and consumers. Its durable projector runs before live
publication, identical cache replays coalesce, and a stable event ID supports
idempotent downstream handling. The broker itself is not a durable log: after
a reconnect, clients still refresh the REST snapshot before resuming live SSE.

Outbound alert delivery is decoupled from alert creation by a durable SQLite
outbox. Alert creation atomically stores one immutable rendered-payload row per
enabled channel and webhook destination plus a one-way reference to each
credential tuple; secrets remain in their protected configuration source.
Later rule edits or retirement cannot re-render or cascade-delete historical
events and queued rows, and sensors referenced by alert history must be disabled
rather than deleted. A destination rotation terminally abandons mismatched older
work rather than sending it somewhere new. Webhook and Telegram transient
failures use bounded exponential backoff until the policy's maximum attempt
count, then remain in a durable dead-letter state for Owner/Admin inspection and
manual retry. The contract is at-least-once and survives process restarts; this
bounded delivery ledger is not a general message broker.

Raw archive retention is unlimited in TimescaleDB. With TimeDB enabled,
`RETENTION_DAYS=0` keeps the complete acknowledged SQLite duplicate; a value of
30 or more compacts it to a bounded local cache. The worker reconciles all six telemetry
families before compaction, requires a healthy and caught-up archive, rejects
mutable dirty rows, and preserves current projections. It pauses without
deleting anything whenever those proofs are unavailable. Historical, bucketed,
replay, MCP, forecast, analytics, opening, and spatial readers use the shared
hybrid reader, so older data remains available from TimescaleDB. Sample count grows per metric: ten sensors times
three metrics every five seconds is about 15.6 million metric samples per
30-day month. Pruning runs outside request handling and does not configure a raw
Timescale retention policy.
See [Backend storage and operations](backend-storage.md) for the current
retention, migration, backup, and restore contract.

## Analytics pipeline

Charts, summaries, energy costs and comparisons go through one query path.
Results that take minutes, such as thermal and moisture fits, are computed in
the background and read back as stored artifacts.

```mermaid
flowchart TD
    clients["Web, iPhone, MCP"] --> routes["Analytics routes<br/>validate, authorise,<br/>data-mode guard"]
    routes --> cache{"Query cache<br/>request, sensors,<br/>revisions, release"}
    cache -->|hit| response["Response<br/>values, coverage, provenance,<br/>cache.hit"]
    cache -->|miss| limiter["Work limiter<br/>2 running, 32 waiting,<br/>else ANALYTICS_BUSY"]
    limiter --> path{"Bucketed and<br/>archive ready?"}
    path -->|yes| rollup["TimescaleDB<br/>buckets computed in SQL<br/>over the complete archive"]
    path -->|no| hybrid["Hybrid reader<br/>archive and SQLite tail read together,<br/>local telemetry worker thread"]
    hybrid --> kernel["Analytics kernel<br/>median, percentiles, time-weighted<br/>means, counter deltas, kWh, calendar"]
    rollup -.->|"parity-tested to 1e-9"| kernel
    rollup --> response
    kernel --> response
    response --> latency[("Latency histogram<br/>for appliance diagnostics")]
```

- **One implementation of the maths.** `@climate-twin/analytics-kernel` owns
  statistics, time-weighted means, counter-reset handling, power-to-energy
  integration and local-calendar helpers for the API and the web app.
  `check:architecture` rejects API-local copies, and
  `apps/api/tests/analytics-kernel-parity.test.ts` runs seeded series through
  both the archive rollup SQL and the kernel, which must agree within 1e-9.
- **Caching.** The server shares identical queries across tabs and household
  members. A range that ended more than two hours ago is kept for up to an hour,
  and one that reaches the present for 30 seconds. The key carries the release,
  the house and registry revisions and the late-history revision, so an import
  of older readings recomputes. An answer built without the merged archive is
  never shared. HTTP responses stay `no-store`.
- **Fixed summary bases.** Medians, percentiles and extremes come from fixed
  1-minute, 15-minute or hourly buckets chosen by range, not from the chart's
  resolution. Coverage is measured against each sensor's usual reporting
  interval.
- **Evidence over time.** Chart queries and the 30-day energy summary record
  their latency, so
  `GET /api/v2/analytics/diagnostics` can report on the appliance itself how
  fast charts answered, how forecasts and the energy projection did, and how
  many invoices the cost model matched.

```mermaid
flowchart LR
    night["Night scheduler<br/>per-Home jitter"] --> coordinator["Derived analytics coordinator<br/>one job per Home, window,<br/>cutoff, algorithm, evidence"]
    refresh["Refresh by an<br/>Owner or Admin"] --> coordinator
    coordinator --> fit["Fit worker thread<br/>one at a time,<br/>resource-limited"]
    fit --> artifacts[("Thermal, moisture and<br/>Home Performance artifacts<br/>last four good generations")]
    read["GET request"] -->|"lookup only,<br/>never fits"| artifacts
    findings["Daily findings worker<br/>every 6 hours"] --> snapshots[("One findings snapshot<br/>per completed local day")]
    forecasts["Forecast service<br/>backtest vs. no change and<br/>same time yesterday"] --> evaluations[("Forecast evaluations<br/>kept for a year")]
```

Forecasts start from the latest reading. Temperature uses the room's thermal
response driven by the outdoor forecast; other measurements use a daily-rhythm
model. Each sensor's forecast is backtested on the last two weeks, and its 90 %
band comes from those errors. A forecast that does not beat "no change" at six
hours is withheld, and the response says why. See
[Analytics foundation](analytics-foundation.md),
[thermal simulation](thermal-simulation.md) and
[electricity prices](electricity-prices.md) for the individual models.

## Live, history, replay, and prediction semantics

- **Live:** normalized metric samples are persisted first, then emitted. Each
  metric retains its own timestamp/source/quality. A client reconnect should
  refresh snapshots/history rather than assume it saw every event.
- **Live weather:** the scheduled monitor converts pull-only provider results
  into `weather` events and updates the durable local snapshot. Foreground reads
  never own provider work.
  The full provider-neutral snapshot is emitted only after the guarded outdoor
  boundary projection succeeds. Cache hits with identical content do not
  invent another event.
- **History:** v2 API queries read one metric's persisted samples in a caller-selected
  range. Analytics queries bucket long ranges inside PostgreSQL instead (see
  [Analytics pipeline](#analytics-pipeline)); raw rows stay permanent.
- **Replay:** persisted or mock readings are emitted on a virtual clock. Replay
  has source `replay`, must not be written back as if it were a new physical
  measurement, and must not trigger real outbound notifications unless the user
  explicitly enables a safe test sink.
- **Prediction:** forecasts are derived views with intervals and model metadata,
  never sensor facts. If `forecastSupported` is false, or the backtested
  forecast does not beat "no change", the UI and API show no forecast rather
  than fabricate one. See
  [Predictive maintenance](predictive-maintenance.md).
- **Spatial view:** only definitions with `spatialInterpolation` enabled produce
  an estimated field. The 2D plan renders a floor field as soft hotspot clouds;
  the orbitable 3D view interpolates a bounded XYZ volume across fresh positioned
  samples and depth-sorts its translucent blobs. When a floor has at least two
  fresh temperature anchors, both views share a separate coarse normalized
  velocity estimate from `airflowSimulation.ts`: paired temperature/RH becomes
  virtual-temperature buoyancy, walls block faces, modeled doors permit
  crossing, supported windward windows can receive weak fresh-wind leakage
  forcing, and pressure projection reduces divergence. CO2 affects passive
  tracer seed placement but never forces the air. Without enough driver data,
  dashed vectors retain the prior high-to-low scalar-gradient fallback and are
  labelled accordingly. Regions far from a reporting sensor are masked rather
  than confidently extrapolated. Plan dimensions are not guaranteed metres, so
  flow direction is relative and animation speed is fixed. See
  [Sensor-constrained indoor flow](airflow-simulation.md); neither layer is
  measured airflow or calibrated CFD.
- **Experimental spatial layers:** a local backend engine can independently
  derive versioned sensor-quality, psychrometric, inter-zone propagation, and
  unexplained-activity evidence. It reads canonical core topology through a
  read-only port and raw history through the same hybrid reader as regular
  queries, writes only experimental/derived state to its separate database, and
  supplies one renderer-neutral snapshot to the house/property 2D and 3D views.
  These layers never become measurements, alerts, or control inputs. Client-only
  spatial previews remain non-authoritative and do not write either database. See
  [Experimental spatial-layer engine](spatial-layer-engine.md).
- **Outdoor boundary:** the live 2D/3D views can render current provider temperature,
  humidity, and wind around the oriented plan. Directional geometry is omitted
  when orientation or wind direction is unknown. It is kept outside the indoor
  interpolation pipeline and hidden during historical replay so current
  outside conditions cannot be mistaken for historical inputs.

## Module boundaries

| Module | Owns | Must not own |
| --- | --- | --- |
| Source adapters | Direct TP-Link, direct Tuya, Home Assistant, mock, replay, API ingestion | UI layout or database-specific queries |
| Connected-device service | provider-neutral current state, shared 2D/3D placement, bounded absolute commands, idempotent command journal | raw vendor datapoints, credentials, or energy estimates |
| Measurement registry | stable IDs, labels, units, ranges, display and capability metadata | sensor samples or site-specific thresholds |
| Normalizer | entity mapping, canonical units, validation, quality | vendor credentials or forecast policy |
| Repository | schema, transactions, retention queries | HTTP or visualisation |
| Alert engine | rule evaluation and event lifecycle | delivery-specific secrets |
| Forecast service | features, backtests, forecast output, uncertainty | presenting forecasts as facts |
| Analytics kernel (`packages/analytics-kernel`) | statistics, time-weighted means, counter/kWh integration, local-calendar helpers | I/O, storage, HTTP, or a second API-local implementation |
| Derived analytics coordinator | durable night/refresh jobs, fit worker threads, last-good artifacts | fitting on an HTTP request |
| Experimental spatial-layer host | optional local scheduling, versioned research-model execution, separate overlays/state/snapshots, renderer-neutral semantic layers | duplicated core masters/raw samples, core telemetry writes, alerts, controls, or UI graphics |
| Weather adapters and monitor | automatic FMI/Open-Meteo routing, source mapping, warning authority, bounded cache/concurrency, jitter, per-home backoff, stale-write fencing | browser map tiles, event transports, or indoor measurement history |
| Weather event broker | provider-neutral acceptance, durable projection ordering, cache-replay deduplication, stable event identity, live fan-out | upstream provider protocols or UI rendering |
| REST/SSE transport | versioning, validation, errors, live fan-out | Home Assistant device protocol |
| MCP server | read-only tool schemas, SQLite control-plane projections, and hybrid TimeDB telemetry reads | writes, schema migration, credentials, binary assets, or browser authorization |
| Web app | accessible interaction and rendering | secrets or authoritative storage |

Adapters depend inward on domain services. Domain services depend on repository
interfaces, not on HTTP, Home Assistant, or a rendering library. The same
boundaries let the TimescaleDB archive and the MQTT adapter arrive without
changing the public concepts, and leave room for an imported-model renderer.

### Workspace packages

The npm workspaces depend in one direction: apps use packages, and packages do
not depend on apps or on each other. `npm run check:architecture` enforces the
direction, and a type shared by two workspaces lives once in
`packages/contracts`.

```mermaid
flowchart BT
    contracts["packages/contracts<br/>domain types, validators"]
    kernel["packages/analytics-kernel<br/>statistics, kWh, calendar"]
    spatial["packages/spatial-layers<br/>spatial inference"]
    protocol["packages/stuguby-protocol<br/>federation protocol"]
    api["apps/api"] --> contracts
    api --> kernel
    api --> spatial
    api --> protocol
    web["apps/web"] --> contracts
    web --> kernel
    web --> spatial
    web --> protocol
    relay["apps/bug-report-relay"] --> contracts
```

`@climate-twin/contracts` and `@climate-twin/analytics-kernel` resolve to their
built `dist` folders, so run `npm run build:packages` after editing them.
`apps/ios` and `apps/tapo-export-runner` share no TypeScript package; they talk
to the API over HTTP.

### REST response envelopes

Every REST endpoint documents one success body in OpenAPI and always returns
it. A collection is an object holding its array under a plural key
(`{ sensors }`, `{ events }`); a single entity is an object holding it under its
singular name (`{ sensor }`, `{ rule }`, `{ parameter }`). Clients read that one
shape and never unwrap alternatives.

Compatibility aliases (`/alerts`, `/alerts/{id}/acknowledge`, `/events`,
`/snapshot`, `/static-parameters`, `PUT /sensors/{id}`) call the canonical
handler and only adapt its envelope. The web client uses the canonical routes;
the aliases remain for the iOS companion and for operator scripts.

Two deliberate exceptions answer a single entity bare:

- **Maintenance tasks** (`POST /maintenance-tasks`, `GET` and
  `PATCH /maintenance-tasks/{id}`). Installed iOS companion builds decode the
  task directly, so wrapping it would break them until they are rebuilt. A
  change to this shape must ship together with the iOS decoder and a
  compatibility window.
- **Stuguby federation** routes (`/stugbys/**` and `/stugby-protocol/**`).
  They answer with the federation records defined in
  `@climate-twin/stuguby-protocol` (`StugubySummary`, `StugubyShareGrant`,
  `StugubyPropertyCommandResult`, ...) and change with that protocol's version,
  not with this convention.

## Reliability and observability

The compatibility health endpoint is `GET /api/v1/health`; integration status is
exposed by the versioned API. Operationally important signals are connection state, last
Home Assistant event time, mapped entity count, ingest/validation errors,
database errors, SSE clients, alert delivery attempts, forecast age, configured
weather locations, selected provider, last successful weather fetch, component
coverage/availability, and weather error state.

Recommended failure behaviour:

1. Reconnect Home Assistant WebSocket with capped exponential backoff and jitter.
2. After reconnect, retain durable latest values and reconcile the current
   mapped Home Assistant states without inventing missing historical samples.
3. For a sensor/metric bound through both adapters, use the healthy direct
   TP-Link path as live primary and Home Assistant as failover. Keep one
   canonical Sensor row; never infer physical identity from display names.
4. Recover a direct gap in this order: local retained history, the matching
   Home Assistant recorder entity, then configured Tapo private/app export.
   De-duplicate retries on sensor, metric, source timestamp, and source.
5. Persist alert state and delivery work atomically. Treat delivery as
   at-least-once: send a stable webhook idempotency key and accept that Telegram
   can duplicate after an ambiguous remote success.
6. Mark each metric sample and its UI representation stale independently after
   a configured freshness threshold.
7. Supervise each Tuya LAN worker independently, serialize its bounded command
   queue, preserve the last confirmed state on failure, and recover a changed
   address only after the same device key and profile authenticate.

The production weather monitor runs only with background services enabled. It
refreshes located homes in non-overlapping cycles with concurrency two, startup
and interval jitter, and independent exponential backoff per home. It rechecks
the home revision and location key before persistence so an in-flight response
cannot write after that home is moved. Manual Outdoor requests share the same
provider service and bounded cache. Both accepted paths publish through the
weather broker, so provider polling is an input adapter rather than a constraint
on event-driven consumers.

The Home Assistant adapter fetches initial mapped states and resumes the event
stream with capped reconnect backoff. Generic measurement mappings ingest each
metric independently and preserve the entity's `last_updated` time. Temperature
accepts Celsius and normalizes Fahrenheit/Kelvin to Celsius; CO2 accepts ppm, or
an explicit ppb binding can scale by 0.001 to ppm. Other custom mappings must
already use the definition's canonical unit unless an explicit configured
linear conversion is provided. The
legacy temperature/humidity keys remain available for `/api/v1` compatibility.
See [Known MVP limitations](known-limitations.md) before enabling physical ingest.

## Accessibility and internationalisation

Canvas/SVG/3D views are enhancements, not the only representation. Each view
should have a keyboard-operable sensor list/table conveying the same current
values, timestamps, alerts, and selections. Do not encode state by colour alone;
respect reduced motion; expose chart summaries; preserve focus; and target WCAG
2.2 AA. Labels, date/number formats, unit display, and thresholds belong in
locale/configuration data rather than source-code strings.

## Source references

- [Home Assistant: TP-Link Smart Home](https://www.home-assistant.io/integrations/tplink/)
  documents H200, T310, and T315 support, local polling, and the current five
  second update interval.
- [Home Assistant WebSocket API](https://developers.home-assistant.io/docs/api/websocket/)
  documents authentication and event subscriptions.
- [Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/)
  documents bearer authentication and entity state reads.
- [FMI open data manual](https://en.ilmatieteenlaitos.fi/open-data-manual)
  documents the WFS download interface and stored queries.
- [FMI CAP warning guide](https://www.ilmatieteenlaitos.fi/varoitusten-latauspalvelun-pikaohje)
  documents the current-warning Atom feeds and CAP 1.2 profile.
- [Open-Meteo weather API](https://open-meteo.com/en/docs) documents the
  worldwide modelled current and hourly fields and best-match model selection.
- [Open-Meteo geocoding API](https://open-meteo.com/en/docs/geocoding-api)
  documents the place search used for suggested home defaults.
- [Open-Meteo licence](https://open-meteo.com/en/license) documents attribution
  and licensing for Open-Meteo output.
- [OpenStreetMap tile policy](https://operations.osmfoundation.org/policies/tiles/)
  documents attribution, identification, caching, and privacy obligations for
  the standard map tiles.

Product and integration behaviour was checked on 2026-07-14; verify upstream
documentation again when upgrading Home Assistant, sensor firmware, FMI or
Open-Meteo products, or the map layer.
