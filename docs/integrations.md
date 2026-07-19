# API, weather, MCP, Home Assistant alerts, DayOps, and OpenWearable

Stuga exposes one local workspace through three transports:

- REST under `/api/v1` for the original temperature/humidity compatibility
  contract and `/api/v2` for registered sparse measurements;
- server-sent events at `/api/v1/stream` for compatibility readings,
  provider-neutral weather snapshots, and integration state, plus
  `/api/v2/measurements/events` for per-metric live updates;
- a local stdio MCP server for trusted agent/tool hosts.

Browser HTTP requests use built-in local accounts and a server-managed HttpOnly
session. The API enforces owner/administrator roles and read-only Guest scopes;
account and session administration are deliberately not added to the trusted
local stdio MCP. The ingestion API key, when configured, remains a separate
machine credential rather than a browser account session.

Outbound alerts can independently target Telegram and one generic webhook.
The webhook can reach Home Assistant or an integration relay; a relay is still
required to fan that single generic destination out to Home Assistant, DayOps,
and OpenWearable simultaneously. See the guided [Apple Notes bridge and
Telegram setup](apple-notes-telegram.md).

Home-scoped outdoor context is a v1 resource with automatic provider routing
(`House` and `houseId` remain the compatibility API names).
Finnish homes use FMI open data; other homes use Open-Meteo worldwide modelled
weather. The API stores each home's optional WGS84 weather location, IANA
timezone, and independent precise map placement. Provider, geocoding, and
timezone requests are server-side; the explicitly loaded Property Home map uses
attributed OpenStreetMap tiles.

The **Set up** Home selector at
`/properties/{propertyId}/homes/{homeId}/setup/{section}` scopes location,
timezone, map placement, orientation, Home Assistant credentials, and direct
TP-Link connections. Each configured Home runs its own Home Assistant WebSocket
session. A Home may also run
multiple TP-Link workers for an H100/H200 and one or more energy sockets.

## REST API v1 compatibility

The machine-readable description is available from a running instance at:

```text
GET /api/v1/openapi.json
```

All request/response bodies other than downloaded assets and SSE are JSON. Error
responses use:

```json
{
  "error": {
    "code": "INVALID_FIELD",
    "message": "humidity must be between 0 and 100 percent"
  }
}
```

Major groups are:

| Group | Routes |
| --- | --- |
| Health/schema | `GET /health`, `GET /openapi.json` |
| Digital twin | `/houses`, `/houses/{id}`, `/houses/{id}/layout`, `/houses/{id}/opening-states`, `/sensors`, `/sensors/snapshots` |
| Weather | `GET /houses/{id}/weather` after setting `House.location` |
| Location discovery | `GET /locations/search`, `GET /locations/defaults` |
| Telemetry | `POST /readings`, `GET /readings/latest`, `GET /history`, `GET /forecast` |
| Live | `GET /stream` |
| Alerts | `/alert-rules`, `/alert-events`, `/alert-events/{id}/acknowledge` |
| Context | `/observations`, `/parameters` |
| Property management | `/properties`, `/property-areas`, `/area-equipment`, `/property-notes` |
| Property electricity | `/properties/{id}/electricity`, `/properties/{id}/electricity/config`, `/properties/{id}/electricity/refresh` |
| Maintenance | `/maintenance-tasks`, `/maintenance-tasks/{id}`, `/maintenance-tasks/{id}/revisions` |
| Assets | `/assets`, `/assets/{id}` |
| Integrations | `/integrations/status`, LAN adapter setup/test routes, `/integrations/telegram/*`, and the scoped `/integrations/apple-notes/*` Shortcut bridge |
| Testing | `/mock/scenarios`, `/mock/scenario`, `/mock/tick`, `/replay` |

Prefix every route in the table with `/api/v1`.

`GET /houses/{id}/opening-states` returns the effective door, window, and vent
state plus the bounded observation history used to resolve it; an optional
`at` timestamp supports replay. `POST` accepts only `manual` or `api`
provenance. Home Assistant and Tapo provenance is adapter-owned so a generic
client cannot impersonate a trusted contact source. Fresh bound provider state
wins, while missing, unknown, expired, or stale state falls back to the layout's
configured state and then its conservative architectural default.

`/api/v1` intentionally keeps its existing flat `Reading` semantics:
temperature and humidity remain required together, the `reading` SSE event is
unchanged, and existing MCP/API clients can continue to operate. New clients
and asynchronous measurements such as CO2 should use `/api/v2`; do not combine
independently timed values into a fabricated v1 reading.
An optional `measurements` map may appear on a v1 object as an additive
projection, but it cannot carry per-metric timestamps/source/quality and is not
the generic persistence contract.

## REST API v2 measurements

The v2 measurement model is registry-driven and sparse. Each sample contains
exactly one metric with its own timestamp, source, quality, value, and canonical
unit. Built-in definitions are `temperature` (°C), `humidity` (%), `co2`
(ppm), instantaneous `power` (W), cumulative `energy` (kWh), and
`electricity_price` (€/kWh). The three electricity metrics intentionally do not
claim spatial interpolation or forecast support. Administrators can register
other finite numeric scalar measurements; categorical/object values are not
accepted.

The version-specific machine-readable descriptions are served at
`GET /api/v1/openapi.json` and `GET /api/v2/openapi.json`; each document lists
only routes available under that version.

### Definitions

| Operation | Route | Envelope |
| --- | --- | --- |
| List | `GET /api/v2/measurement-definitions` | `{ "definitions": [...] }` |
| Create | `POST /api/v2/measurement-definitions` | request definition; response `{ "definition": {...} }` |
| Update | `PATCH /api/v2/measurement-definitions/{id}` | request patch; response `{ "definition": {...} }` |
| Disable | `DELETE /api/v2/measurement-definitions/{id}` | `{ "definition": {...} }` with `enabled: false` |

A definition contains localized `labels`, `unit`, `precision`, valid and display
ranges, `interpolationDelta`, `colorScale`, `enabled`, and two capability flags:
`spatialInterpolation` and `forecastSupported`; `builtin` identifies seeded
definitions and is not client-editable. Disabling retains its history.
Stable IDs and canonical units should not be repurposed after samples, alert
rules, or integrations refer to them; create a new definition for a different
physical meaning or unit.
The list includes disabled definitions by default; pass `includeDisabled=false`
when populating a selector that should offer only active metrics.

Example custom definition:

```json
{
  "id": "voc_index",
  "labels": { "en": "VOC index", "fi": "VOC-indeksi" },
  "unit": "index",
  "precision": 0,
  "validMin": 0,
  "validMax": 500,
  "displayMin": 0,
  "displayMax": 500,
  "interpolationDelta": 25,
  "colorScale": "air-quality",
  "enabled": true,
  "spatialInterpolation": false,
  "forecastSupported": false
}
```

### Ingest and query samples

`POST /api/v2/measurements` accepts one sample, an array, or a
`{ "sample": ... }` / `{ "samples": [...] }` envelope and returns
`{ "accepted": number, "samples": [...] }`. The same optional ingestion key
used by v1 applies. For example:

```sh
curl --request POST http://localhost:8080/api/v2/measurements \
  --header "Content-Type: application/json" \
  --header "X-API-Key: $CLIMATE_TWIN_INGEST_KEY" \
  --data '{
    "sample": {
      "sensorId": "sensor-01",
      "metric": "co2",
      "value": 842,
      "canonicalUnit": "ppm",
      "timestamp": "2026-07-14T08:00:03Z",
      "source": "api",
      "quality": "good"
    }
  }'
```

The batch limit is 1,000. Values must be finite, the sensor and enabled metric
must exist, the canonical unit must exactly match the definition, and the value
must fall within its valid range. Live timestamps may be at most five minutes
ahead of the server clock to accommodate ordinary device clock skew. A retry of the same
sensor/metric/timestamp/source is idempotent; another metric at the same time is
a separate sample.

| Query | Response envelope |
| --- | --- |
| `POST /api/v2/measurements/import` | `{ "accepted": 100, "ignoredDuplicates": 5 }` |
| `GET /api/v2/measurements/snapshot?houseId=house-main` | `{ "snapshot": [{ "sensorId": "...", "measurements": { "co2": sample } }] }` |
| `GET /api/v2/measurements/history?sensorId=sensor-01&metric=co2&from=...&to=...&limit=20000` | `{ "samples": [...] }` |
| `GET /api/v2/measurements/forecast?sensorId=sensor-01&metric=co2&hours=12` | `{ "forecast": [...] }` |

Snapshot entries are maps because sensors need not expose the same metrics and
their latest timestamps can differ. History selects one sensor and one metric.
Forecasts are available only where the definition sets `forecastSupported`;
unsupported metrics return `FORECAST_UNSUPPORTED` rather than invented bands.

The dedicated historical import route accepts `{ "samples": [...] }` batches
of up to 10,000. It forces `source: "import"`, accepts archived sensors, and
deduplicates by sensor/metric/timestamp across all sources. Imported samples do
not publish live SSE events, evaluate alerts, or deliver webhooks. The guided
browser workflow sends smaller retry-safe batches and refreshes the house after
completion.

### Live v2 events

```js
const events = new EventSource(
  "/api/v2/measurements/events?sensorId=sensor-01&metric=co2"
);

events.addEventListener("measurement", (event) => {
  const sample = JSON.parse(event.data);
  console.log(sample.metric, sample.value, sample.canonicalUnit, sample.timestamp);
});
```

The event payload is the `MeasurementSample` itself. `sensorId` and `metric`
filters may be repeated or comma-separated. Heartbeats keep idle connections
visible. As with v1, there is no durable resume cursor; refresh the v2 snapshot
and required histories after reconnect.

### Alerts, mock data, and replay

Alert rules refer to a registered `metric` ID and evaluate only samples for that
metric; a CO2 event cannot accidentally satisfy a humidity rule. Thresholds and
durations remain site configuration rather than registry metadata.

Mock mode generates realistic-but-synthetic temperature, humidity, and CO2 for
the seeded sensors. It does not invent values for newly registered custom
metrics, so their correct initial state is "no data" until an adapter, API call,
or explicit scenario provides samples. Historical replay loads the selected
metric's v2 samples and retains each sample's timestamp/source/quality while
labeling replayed presentation as replay. Replay remains a test/visualisation
path and must not deliver real notifications by default.

The database begins in `demo` mode. Saving Home Assistant or TP-Link credentials,
accepting any `home-assistant`, `tp-link`, `api`, or `import` telemetry, or
persisting a fresh provider outdoor value,
atomically changes it to permanent `real` mode. That transition purges rows with
`mock`/`replay` provenance, synthetic outdoor boundaries, and alert events whose
source cannot otherwise be proven; it also resets in-memory alert duration state
and any active replay. Mixed real/demo batches and later demo writes fail with
HTTP 409 (`MIXED_DATA_MODES` or `DEMO_DATA_DISABLED`). The current mode and
activation timestamp are exposed under `IntegrationStatus.mock`.
Clients must not assume demo mode while that status is unavailable. The bundled
web client keeps telemetry empty until the API positively confirms demo mode and
therefore does not fall back to synthetic values when a real installation is
temporarily unreachable.

While the API confirms demo mode, the browser keeps a persistent DEMO banner
and a visually distinct shell; reconnecting does not make the environment look
live. Scenario controls remain available only in the confirmed demo state. The
one-way database latch prevents synthetic telemetry from crossing back into a
real local installation, but it is not a reusable production/demo separation
boundary. Use a separate database or deployment, device registry, credentials,
recipients, and storage namespace for demonstrations that must coexist with a
live installation.

Map surfaces and forecasts follow the definition flags. When
`spatialInterpolation` is false, clients should render positioned markers and
history without a continuous surface. When `forecastSupported` is false, clients
should omit forecast bands and handle the API's `FORECAST_UNSUPPORTED` response.

## REST API v1 details

### House map placement, location discovery, and weather

`House.location` is the optional weather lookup reference: a WGS84 object with
finite `latitude` and `longitude` decimal degrees plus an optional display
`label`, `countryCode`, and discovery provenance (`source`, `confidence`,
`discoveredAt`, and `userOverridden`). `House.timezone` is an IANA timezone and
controls local display independently for each home. `House.mapPlacement`
independently gives the precise WGS84
centre used to draw the house, the positive `metersPerPlanUnit` conversion from
local floor-plan units to real-world metres, and an optional
`footprintFloorId`. When supplied, that floor provides the map footprint.
`House.orientationDegrees` remains independently optional and is the clockwise
true-north bearing of the floor plan's top edge, in the range `[0, 360)`.
Set or replace these properties with `PATCH /api/v1/houses/{id}`:

```json
{
  "location": {
    "latitude": 60.2055,
    "longitude": 24.6559,
    "label": "Espoo",
    "countryCode": "FI",
    "source": "place-search",
    "confidence": "high",
    "discoveredAt": "2026-07-14T08:00:00.000Z",
    "userOverridden": false
  },
  "timezone": "Europe/Helsinki",
  "mapPlacement": {
    "latitude": 60.2056,
    "longitude": 24.6561,
    "metersPerPlanUnit": 0.05,
    "footprintFloorId": "floor-ground"
  },
  "orientationDegrees": 0
}
```

Set any property to `null` to clear only that property. Unknown orientation must
remain absent/null rather than defaulting to `0`; otherwise downstream clients
would falsely label the top plan edge as north-facing. Moving or clearing
`mapPlacement` does not change `location`, invalidate its weather cache, or
purge retained weather history. A change to `location` retains its existing
weather cache/history invalidation semantics.

`GET /api/v1/locations/search?q=Espoo&language=en` performs an explicit
Open-Meteo place search and returns sanitized suggestions with coordinates,
country/region, confidence, and IANA timezone. It does not mutate a home.
`GET /api/v1/locations/defaults?latitude=60.2055&longitude=24.6559` resolves a
timezone for explicitly supplied coordinates. The web client invokes the latter
after the user approves device geolocation and persists a result only through a
separate house patch. Manual fields remain a supported fallback.

The Property map can show the selected Property's Homes that have either
`mapPlacement` or the legacy `location`. Precisely placed Homes render as true
geographic footprints that scale with map zoom; location-only legacy Homes
fall back to pins. Surveyed parcel boundaries are not imported, so drawn areas
remain user-supplied context rather than authoritative cadastral geometry.

Weather wind bearing is a wind-from direction. A client maps it to the plan with
`normalize(windFromDegrees - orientationDegrees)` and should omit directional
geometry whenever either bearing is unavailable.

Request outdoor context with
`GET /api/v1/houses/{id}/weather?hours=48`; the horizon defaults to 48 and is
bounded to 1–240 hours (the Open-Meteo adapter currently caps returned forecast
hours at 168). Automatic routing selects FMI for Finnish locations and
Open-Meteo elsewhere. FMI responses combine a recent station observation,
edited/HARMONIE point forecasts, and active CAP warnings that geometrically
cover the house. Open-Meteo responses contain modelled current and `best_match`
hourly forecast values; official warnings are not available through that
adapter. Neither provider requires a weather API key or environment variable.

Consumers must preserve `provider`, `attribution`, `fetchedAt`,
`forecastIssuedAt`, `observationStation`, `stale`, and `unavailable`. Upstream
parts settle independently, so a 200 response can be partial; a failed refresh
can return an older in-memory result with `stale: true`. A missing house location
returns `HOUSE_LOCATION_REQUIRED`, and no usable upstream or cached result
returns `WEATHER_UNAVAILABLE`.

New clients must also inspect `componentStatus`. In particular, an empty warning
array is authoritative only when the warnings component is available, covered,
fresh, and sets `emptyResultIsAuthoritative: true`. Open-Meteo marks warnings
`not-applicable` and `outside-coverage`; stale FMI warning state is likewise not
authoritative.

With background services enabled, a non-overlapping monitor refreshes every
located home for 48 hours. Concurrency is bounded to two, scheduled cycles use
jitter, and failures back off independently per home. A revision/location fence
prevents an old in-flight response from being persisted after a home is moved.
Only fresh current temperature is retained as an outdoor boundary; forecasts
and stale fallbacks are not stored as observations.

Accepted scheduled and on-demand results pass through a provider-neutral event
broker after that fence. The broker projects the durable boundary first, then
emits a named `weather` event on `/api/v1/stream` and `/api/v1/events`. Its
payload is a `WeatherUpdateEvent` containing a stable `id`, `publishedAt`,
`trigger`, and the complete `HouseWeather` snapshot. Identical cached responses
coalesce, so an API cache hit does not masquerade as a provider update.

See [Outdoor weather and home location](weather.md) for requested fields,
station/model caveats, caching, background refresh, CC BY 4.0 attribution,
provider limits, warning authority, discovery consent, and OpenStreetMap
privacy/usage requirements.

### Spatial coordinates for multi-floor views

Each floor defines its local horizontal extent with `width` and `height`.
Sensor `x` and `y` values are positions inside that floor coordinate system;
`floorId` assigns the sensor to a plane. `Floor.elevation` and sensor `z` are
absolute metres in one vertical coordinate system per house. For example, a
ground floor at elevation `0` can contain a sensor at `z: 1.2`, while an upper
floor at elevation `3` can contain one at `z: 4.2`.

The whole-building view normalizes horizontal floor dimensions so raster- or
metre-based plans remain usable and visually exaggerates vertical separation for
legibility. It never guesses or converts vertical units from coordinate
magnitudes. Keep horizontal plan units consistent within each floor and migrate
existing positions if those units change.

### Ingest a reading

Set a strong `INGEST_API_KEY` whenever another process can reach the ingestion
route. Send it as `X-API-Key` or a bearer token:

```sh
curl --request POST http://localhost:8080/api/v1/readings \
  --header "Content-Type: application/json" \
  --header "X-API-Key: $CLIMATE_TWIN_INGEST_KEY" \
  --data '{
    "sensorId": "sensor-01",
    "timestamp": "2026-07-14T08:00:00Z",
    "temperature": 21.4,
    "humidity": 47.2,
    "battery": 96,
    "quality": "good"
  }'
```

The server records source `api`. It accepts one reading, an array, or an object
with a `readings` array, up to 1,000 readings per request. Temperature is °C,
relative humidity and battery are percentages, and timestamps should include a
UTC offset. The sensor must already exist and be enabled.

When `INGEST_API_KEY` is empty, the route is unauthenticated. This is convenient
for loopback development, not a safe network-facing default. The key does not
protect read/configuration routes; see [Security and privacy](security-privacy.md).

### Query history and forecasts

```text
GET /api/v1/history?sensorId=sensor-01,sensor-02&from=2026-07-13T00:00:00Z&to=2026-07-14T00:00:00Z&limit=20000&forecastHours=12
GET /api/v1/forecast?sensorId=sensor-01&hours=12
```

History defaults to the prior 24 hours, allows repeated or comma-separated
`sensorId`, caps `limit` at 50,000, and sets `truncated` when the cap was reached.
Forecast horizons are 1–168 hours. The current `linear-v1` output is a baseline,
not a validated maintenance diagnosis.

### Live stream

```js
const events = new EventSource("/api/v1/stream?sensorId=sensor-01,sensor-02");

for (const type of ["reading", "alert", "integration", "weather", "heartbeat"]) {
  events.addEventListener(type, (event) => {
    const data = JSON.parse(event.data);
    console.log(type, data);
  });
}
```

The stream sends an integration snapshot immediately and a heartbeat every 15
seconds. A `sensorId` filter affects reading/alert events; weather remains
house-scoped inside its payload. Weather events include a stable SSE `id`, but
the in-memory stream has no durable resume cursor. After reconnect, fetch
`/sensors/snapshots` or the required history range for telemetry and
`/houses/{id}/weather` for outdoor context before resuming live events.

### Manual and static data

Use `POST /api/v1/observations` for time-bound evidence:

```json
{
  "houseId": "house-main",
  "floorId": "floor-ground",
  "sensorId": "sensor-04",
  "kind": "leak",
  "severity": "warning",
  "note": "Small leak observed below utility sink; valve closed.",
  "x": 11.2,
  "y": 7.4,
  "occurredAt": "2026-07-14T07:45:00+03:00",
  "timePrecision": "approximate",
  "source": "caretaker",
  "sourceDetail": "Departure inspection",
  "confidence": "probable"
}
```

Kinds are `leak`, `condensation`, `mould`, `ventilation`, `maintenance`, and
`note`. Current responses keep immutable `createdAt`, editable observed-time
semantics, `status`, server-managed `resolvedAt`, `resolutionNote`, `revision`,
and `updatedAt`. Resolve with `status: "resolved"` plus a non-empty
`resolutionNote`; reopen with `status: "open"`, which clears the current
resolution fields while retaining them in revision history. Change evidence with an optimistic
`PATCH /api/v1/observations/{id}` containing `baseRevision`; inspect its ordered
snapshots with `GET /api/v1/observations/{id}/revisions`. See
[Manual observations and evidence time](observations.md) for precision rules,
provenance, resolution, conflicts, and actor attribution.

Use `POST /api/v1/parameters` for slower-changing context such as room
volume, wall material, insulation note, ventilation type, or sensor calibration.
External consumers should preserve the IDs and time-precision metadata rather
than parse display labels or assume every observation is an exact UTC instant.

Use `POST /api/v1/maintenance-tasks` to turn evidence into explicitly planned
work. A task has a controlled `basis`, `priority`, separate house-local
`plannedFor` and `dueBy` dates, and optional same-house `observationIds`.
`PATCH /api/v1/maintenance-tasks/{id}` requires `baseRevision`. Setting
`status: "completed"` requires `completionNote` and records `completedAt` on
the server; a later `status: "verified"` requires `verificationNote` and
records `verifiedAt`. Neither transition resolves linked observations. Inspect
actor-attributed snapshots with
`GET /api/v1/maintenance-tasks/{id}/revisions`. See
[Activity and maintenance work](maintenance.md) for lifecycle and trust-basis
rules.

### Floor-plan and 3D assets

`POST /api/v1/assets` accepts JSON with `houseId`, `name`, `mimeType`, `kind`, and
base64 `data`. Kinds are `floor-plan`, `model-3d`, and `other`; decoded data is
limited to 10 MiB and stored with the SQLite-backed digital twin. This endpoint
allows PNG, JPEG, WebP, glTF, and GLB; model responses are forced to download and
asset responses receive a sandbox policy. It is still not a complete
untrusted-upload security boundary: use trusted assets until signature/content
verification, dimension/complexity limits, and application authentication are
added.

## MCP stdio server

Install dependencies and build, then configure a trusted MCP host to launch:

```sh
node apps/api/dist/mcp-server.js
```

Set its working directory to the repository and provide `DATABASE_PATH` pointing
to the same Stuga database.

Generic client configuration (replace the absolute paths):

```json
{
  "mcpServers": {
    "climate-twin": {
      "command": "node",
      "args": ["apps/api/dist/mcp-server.js"],
      "cwd": "/absolute/path/to/climate-twin",
      "env": {
        "DATABASE_PATH": "/absolute/path/to/climate-twin/data/climate-twin.sqlite"
      }
    }
  }
}
```

For the running Compose API, the compiled server can share its mounted database:

```sh
docker compose exec -T api node apps/api/dist/mcp-server.js
```

An MCP client's executable can similarly be `docker` with arguments `compose`,
`exec`, `-T`, `api`, `node`, `apps/api/dist/mcp-server.js` and the repository as
its working directory.

The trusted local stdio server currently exposes 58 tools. They operate on
the configured local SQLite database; they do not expose raw credentials,
binary asset downloads, SSE streams, or browser account/session administration.

### Homes, location, weather, and modelling

| Tool | Behaviour |
| --- | --- |
| <code>list_houses</code> | Privacy-safe compact house and floor summaries |
| <code>get_house</code> | One selected house with location, map placement, orientation, and floor layout |
| <code>create_house</code> | Create a house with a validated floor layout |
| <code>update_house</code> | Update house metadata, location, placement, orientation, or floors |
| <code>replace_house_layout</code> | Replace all validated floors for one house |
| <code>replace_house_floor</code> | Replace one existing floor |
| <code>delete_house</code> | Permanently delete a house and dependent local data; requires <code>confirm=true</code> |
| <code>search_locations</code> | Search Open-Meteo place and timezone suggestions on explicit request |
| <code>resolve_coordinate_defaults</code> | Resolve an IANA timezone for explicit WGS84 coordinates |
| <code>get_house_weather</code> | Fetch provider-neutral conditions, forecasts, and warning coverage; optional persistence has an explicit real-data confirmation gate |
| <code>run_thermal_simulation</code> | Fit and run the experimental first-order room thermal model |

### Sensors and measurement data

| Tool | Behaviour |
| --- | --- |
| <code>list_sensors</code> | List configured sensors, optionally for one house |
| <code>create_sensor</code> | Create and place a sensor with optional integration bindings |
| <code>update_sensor</code> | Atomically update sensor metadata, placement, state, or bindings |
| <code>delete_sensor</code> | Permanently delete a sensor and dependent data; requires <code>confirm=true</code> |
| <code>list_measurement_definitions</code> | List built-in and custom metric definitions and capabilities |
| <code>create_measurement_definition</code> | Create a custom numeric metric definition |
| <code>update_measurement_definition</code> | Update mutable fields of a metric definition |
| <code>disable_measurement_definition</code> | Disable a metric without deleting history or alert rules |
| <code>ingest_measurements</code> | Validate and ingest registry samples with normal live events and alert evaluation |
| <code>import_measurements</code> | Duplicate-safe historical import without live events or alert evaluation |
| <code>ingest_readings</code> | Ingest v1 temperature/humidity tuples and optional registry projections |
| <code>get_measurement_snapshot</code> | Latest independently timestamped sample for every metric and sensor |
| <code>query_measurement_history</code> | Bounded history for any registered sensor metric |
| <code>forecast_measurement</code> | Forecast a metric whose definition enables forecasting |
| <code>get_sensor_snapshot</code> | One sensor, its placement, and latest v1 reading |
| <code>query_history</code> | Bounded durable v1 sensor history |
| <code>forecast_sensor</code> | Bounded v1 temperature/humidity baseline forecast |

### Alerts, observations, and static context

| Tool | Behaviour |
| --- | --- |
| <code>list_active_alerts</code> | List unresolved alert events |
| <code>list_alert_rules</code> | List configured alert rules |
| <code>create_alert_rule</code> | Create a metric threshold rule |
| <code>update_alert_rule</code> | Update mutable rule fields |
| <code>delete_alert_rule</code> | Permanently delete a rule; requires <code>confirm=true</code> |
| <code>list_alert_events</code> | List recent alert events, optionally unresolved only |
| <code>acknowledge_alert</code> | Acknowledge an alert at the current server time |
| <code>list_observations</code> | List manual incident, maintenance, ventilation, and note observations |
| <code>create_observation</code> | Record a manual observation |
| <code>update_observation</code> | Update an observation with an optimistic base revision |
| <code>list_observation_revisions</code> | List its immutable revision snapshots and local actor provenance |
| <code>delete_observation</code> | Permanently delete an observation; requires <code>confirm=true</code> |
| <code>list_maintenance_tasks</code> | List Property-owned maintenance work, optionally filtered by Home, floor, area, or equipment |
| <code>create_maintenance_task</code> | Plan classified work and optionally link observations |
| <code>update_maintenance_task</code> | Edit, start, complete, verify, or cancel work with an optimistic base revision |
| <code>list_maintenance_task_revisions</code> | List immutable task snapshots and actor provenance |
| <code>delete_maintenance_task</code> | Permanently delete a task; requires <code>confirm=true</code> |
| <code>list_static_parameters</code> | List house, floor, room, and sensor context |
| <code>upsert_static_parameter</code> | Create or update static context |
| <code>delete_static_parameter</code> | Permanently delete static context; requires <code>confirm=true</code> |

### Trusted assets

| Tool | Behaviour |
| --- | --- |
| <code>list_assets</code> | List floor-plan and 3D asset metadata without binary content |
| <code>get_asset_metadata</code> | Get metadata for one asset without binary content |
| <code>upload_asset</code> | Upload a trusted PNG, JPEG, WebP, glTF, or GLB asset up to 10 MiB decoded |
| <code>delete_asset</code> | Permanently delete an asset; requires <code>confirm=true</code> |

### Local integrations and devices

| Tool | Behaviour |
| --- | --- |
| <code>get_integration_status</code> | Get redacted integration and data-mode status for this MCP process |
| <code>discover_integrations</code> | Run best-effort LAN discovery for Home Assistant and TP-Link hubs |
| <code>get_home_assistant_setup</code> | Get Home Assistant setup guidance without credentials |
| <code>test_home_assistant_connection</code> | Report redacted Home Assistant state visible to this process |
| <code>get_tp_link_setup</code> | Get direct H100/H200 setup and mapping guidance without credentials |
| <code>list_tp_link_devices</code> | List sanitized TP-Link child devices cached in this process |
| <code>test_tp_link_connection</code> | Report redacted TP-Link state visible to this process |

### Demo data and replay

| Tool | Behaviour |
| --- | --- |
| <code>list_mock_scenarios</code> | List bundled scenarios and the current demo/real-data state |
| <code>select_mock_scenario</code> | Select a scenario unless the database has entered real-data mode |
| <code>generate_mock_tick</code> | Persist one mock tick unless the database has entered real-data mode |
| <code>get_replay_status</code> | Get replay state for this process's in-memory event bus |
| <code>start_replay</code> | Start bounded replay on this process's event bus |
| <code>stop_replay</code> | Stop replay on this process's event bus |

Every tool returns the same result in structured content and as JSON text.
Mutating tools carry MCP annotations so clients can distinguish read-only,
idempotent, destructive, and open-world operations. Permanent deletes require
<code>confirm=true</code>. Persisting a weather observation requires
<code>persistObservation=true</code> together with
<code>confirmRealDataPersistence=true</code> because the one-way real-data latch
can purge demo telemetry.

The stdio process itself is the authorization boundary, so only a trusted host
should launch it. Agent policies should require user confirmation for writes
appropriate to their risk. Credentials cannot be configured through MCP, and
connection and replay status are process-local: the MCP process cannot inspect
a separately running API process's WebSocket, TP-Link poller, or event bus.

## Send alerts to Home Assistant

Create a Home Assistant automation with a random, secret webhook ID. The current
[Home Assistant webhook guidance](https://www.home-assistant.io/docs/automation/trigger/#webhook-trigger)
recommends keeping it local-only and treating the ID like a password. One YAML
shape is:

```yaml
alias: Stuga alert notification
triggers:
  - trigger: webhook
    webhook_id: !secret climate_twin_webhook_id
    allowed_methods:
      - POST
    local_only: true
conditions:
  - condition: template
    value_template: "{{ trigger.json.type == 'climate-twin.alert' }}"
actions:
  - action: persistent_notification.create
    data:
      title: "Stuga: {{ trigger.json.event.severity }}"
      message: >-
        {{ trigger.json.rule.name }} at {{ trigger.json.event.sensorId }}:
        {{ trigger.json.event.value }} (threshold
        {{ trigger.json.event.threshold }}).
mode: queued
max: 10
```

Set the Stuga environment to the corresponding local URL:

```dotenv
ALERT_WEBHOOK_URL=http://homeassistant.local:8123/api/webhook/replace-with-secret-id
ALERT_WEBHOOK_BEARER_TOKEN=
```

Home Assistant webhook triggers authenticate by possession of the unguessable
ID, so leave the bearer token empty for this route. Enable `webhookEnabled` on
the desired Stuga alert rules.

The MVP posts once when a rule creates an alert, with a 10-second timeout:

```json
{
  "apiVersion": "v1",
  "type": "climate-twin.alert",
  "event": {
    "id": "alert-event-id",
    "ruleId": "rule-id",
    "sensorId": "sensor-09",
    "metric": "humidity",
    "value": 78.4,
    "threshold": 70,
    "severity": "warning",
    "startedAt": "2026-07-14T08:00:00Z",
    "acknowledgedAt": null,
    "resolvedAt": null
  },
  "rule": {
    "id": "rule-id",
    "name": "Bathroom humidity sustained",
    "sensorId": "sensor-09",
    "metric": "humidity",
    "operator": "gte",
    "threshold": 70,
    "durationSeconds": 1200,
    "severity": "warning",
    "enabled": true,
    "webhookEnabled": true,
    "telegramEnabled": false
  }
}
```

New webhook notifications are committed to a SQLite outbox with an immutable
rendered payload and a one-way reference to the complete destination credential
tuple. Rule edits and retirement therefore cannot rewrite or remove queued work,
and a credential/destination rotation abandons an older row instead of rerouting
it. Credentials themselves remain outside SQLite. Each request carries a stable
`Idempotency-Key`, which receivers should persist and deduplicate because the
delivery contract is at-least-once. Transient failures use bounded exponential
backoff. There is no maximum-attempt/dead-letter policy, signature, destination
allowlist, or fan-out yet. The integration status reports the last success/error.
Keep important safety alerts in Home Assistant/certified devices as well; do not
use this as the only notification.

## Send alerts to Telegram

Telegram is a native channel rather than a generic-webhook target because its
Bot API requires a destination-specific `chat_id` and `text` payload. Use
**Set up → Automations** to validate a BotFather token, discover a private chat
after `/start`, save the write-only credentials, and send an end-to-end test.
Then set `telegramEnabled: true` only on the desired alert rules.

Real alert messages contain a minimal house/sensor/rule summary and use
Telegram's protected-content option; informational events are silent. Mock and
replay values are never delivered. Telegram cloud bot chats are not
end-to-end-encrypted Secret Chats, and Bot API acceptance is not proof that a
person read the alert. Telegram notifications use the same immutable durable
retry envelope and destination binding, but Telegram does not provide an
idempotency key: a crash after remote acceptance can duplicate a message, and
there is no maximum-attempt/dead-letter policy yet. Retain a suitable safety
channel. Full setup and troubleshooting are in [Apple Notes bridge and Telegram
alerts](apple-notes-telegram.md).

Alert `durationSeconds` is currently **sample-driven with durable SQLite
state**. Pending duration survives API restarts and is protected from
out-of-order readings, but a rule fires only when another violating reading
arrives after the duration. A flat value with no new event can therefore wait
indefinitely. Use Home Assistant/certified alerting for time-critical thresholds
until wall-clock timer evaluation is implemented.

## DayOps and OpenWearable

No DayOps/OpenWearable-specific identity or schema is assumed in the core. Keep
that contract in a versioned adapter so either project can evolve independently.

Recommended patterns:

1. **Read-only consumer:** query v2 measurement snapshot/history/forecast plus
   v1 alert events and observations; subscribe to the v2 measurement stream
   while online. Keep v1 reading routes only for existing clients.
2. **Alert relay:** set the single Stuga webhook to a local relay. Validate
   its bearer token, persist/deduplicate by `event.id`, then transform and fan out
   to Home Assistant, DayOps, and OpenWearable with destination-specific auth.
3. **Context writer:** record a verified maintenance/leak outcome through
   `/observations` or a durable building fact through `/parameters`.
4. **Combined analysis:** correlate by explicit pseudonymous house/room/sensor
   IDs and UTC windows in a consented analysis service; do not copy full floor
   plans or wearable streams into each system by default.

An adapter envelope should add, rather than reinterpret, the core payload:

```json
{
  "schema": "dayops.climate-alert/v1",
  "idempotencyKey": "alert-event-id",
  "occurredAt": "2026-07-14T08:00:00Z",
  "subject": {
    "houseId": "house-main",
    "sensorId": "sensor-09"
  },
  "climateTwin": {
    "apiVersion": "v1",
    "eventId": "alert-event-id"
  }
}
```

Before production integration, agree on schema ownership, authentication,
idempotency, retry/dead-letter behaviour, consent, retention/deletion, clock
semantics, units, and whether acknowledgement/resolution flows back. Add contract
fixtures and consumer-driven tests; do not infer a person's state from room
measurements without an explicitly validated model and consent.

## API evolution

`/api/v1` is the original compatibility boundary and keeps the required
temperature/humidity reading tuple. `/api/v2` is the sparse, registry-driven
measurement boundary. Additive changes may extend either version, but breaking
renames/removals or semantic/unit changes require a later major path plus a
documented migration and overlap period. MCP, webhook, import/export, and
DayOps/OpenWearable schemas should be versioned independently even when they
carry API objects.
