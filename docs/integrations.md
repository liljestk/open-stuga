# API, FMI weather, MCP, Home Assistant alerts, DayOps, and OpenWearable

Climate Twin exposes one domain through three transports:

- REST under `/api/v1` for the original temperature/humidity compatibility
  contract and `/api/v2` for registered sparse measurements;
- server-sent events at `/api/v1/stream` for compatibility readings and
  `/api/v2/measurements/events` for per-metric live updates;
- a local stdio MCP server for trusted agent/tool hosts.

Outbound alert webhooks can target Home Assistant or an integration relay. The
MVP has one configured webhook destination, so a relay is required to fan out to
Home Assistant, DayOps, and OpenWearable simultaneously.

House-scoped outdoor context is a v1 resource backed by FMI open data. The API
stores an optional WGS84 house location and performs FMI WFS/CAP requests
server-side; the location picker uses attributed OpenStreetMap tiles.

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
| Digital twin | `/houses`, `/houses/{id}`, `/houses/{id}/layout`, `/sensors`, `/sensors/snapshots` |
| Weather | `GET /houses/{id}/weather` after setting `House.location` |
| Telemetry | `POST /readings`, `GET /readings/latest`, `GET /history`, `GET /forecast` |
| Live | `GET /stream` |
| Alerts | `/alert-rules`, `/alert-events`, `/alert-events/{id}/acknowledge` |
| Context | `/observations`, `/parameters` |
| Assets | `/assets`, `/assets/{id}` |
| Integrations | `/integrations/status`, `/integrations/home-assistant/setup` |
| Testing | `/mock/scenarios`, `/mock/scenario`, `/mock/tick`, `/replay` |

Prefix every route in the table with `/api/v1`.

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
unit. Built-in definitions are `temperature` (°C), `humidity` (%), and `co2`
(ppm). Administrators can register other finite numeric scalar measurements;
categorical/object values are not accepted.

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
must fall within its valid range. A retry of the same
sensor/metric/timestamp/source is idempotent; another metric at the same time is
a separate sample.

| Query | Response envelope |
| --- | --- |
| `GET /api/v2/measurements/snapshot?houseId=house-main` | `{ "snapshot": [{ "sensorId": "...", "measurements": { "co2": sample } }] }` |
| `GET /api/v2/measurements/history?sensorId=sensor-01&metric=co2&from=...&to=...&limit=20000` | `{ "samples": [...] }` |
| `GET /api/v2/measurements/forecast?sensorId=sensor-01&metric=co2&hours=12` | `{ "forecast": [...] }` |

Snapshot entries are maps because sensors need not expose the same metrics and
their latest timestamps can differ. History selects one sensor and one metric.
Forecasts are available only where the definition sets `forecastSupported`;
unsupported metrics return `FORECAST_UNSUPPORTED` rather than invented bands.

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

Map surfaces and forecasts follow the definition flags. When
`spatialInterpolation` is false, clients should render positioned markers and
history without a continuous surface. When `forecastSupported` is false, clients
should omit forecast bands and handle the API's `FORECAST_UNSUPPORTED` response.

## REST API v1 details

### House location and FMI weather

`House.location` is an optional WGS84 object with finite `latitude` and
`longitude` decimal degrees plus an optional display `label`. Set or replace it
with `PATCH /api/v1/houses/{id}`; set `location` to `null` to remove it:

```json
{
  "location": {
    "latitude": 60.2055,
    "longitude": 24.6559,
    "label": "Espoo"
  }
}
```

Request outdoor context with
`GET /api/v1/houses/{id}/weather?hours=48`; the horizon defaults to 48 and is
bounded to 1–240 hours. The response combines a recent station observation,
FMI edited/HARMONIE point forecasts, and active CAP warnings that geometrically
cover the house. No FMI API key or weather environment variable is required.

Consumers must preserve `provider`, `attribution`, `fetchedAt`,
`forecastIssuedAt`, `observationStation`, `stale`, and `unavailable`. Upstream
parts settle independently, so a 200 response can be partial; a failed refresh
can return an older in-memory result with `stale: true`. A missing house location
returns `HOUSE_LOCATION_REQUIRED`, and no usable upstream or cached result
returns `WEATHER_UNAVAILABLE`.

See [FMI weather and house location](weather.md) for every requested product and
field, station-distance caveats, caching, CC BY 4.0 attribution, FMI request
limits, CAP semantics, and OpenStreetMap privacy/usage requirements.

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

for (const type of ["reading", "alert", "integration", "heartbeat"]) {
  events.addEventListener(type, (event) => {
    const data = JSON.parse(event.data);
    console.log(type, data);
  });
}
```

The stream sends an integration snapshot immediately and a heartbeat every 15
seconds. A `sensorId` filter affects reading/alert events. Events currently have
no durable SSE ID/resume cursor: after reconnect, fetch `/sensors/snapshots` or
the required history range to reconcile state.

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
  "occurredAt": "2026-07-14T07:45:00Z"
}
```

Kinds are `leak`, `condensation`, `mould`, `ventilation`, `maintenance`, and
`note`. Use `POST /api/v1/parameters` for slower-changing context such as room
volume, wall material, insulation note, ventilation type, or sensor calibration.
External consumers should preserve the IDs and UTC timestamps rather than parse
display labels.

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
to the same Climate Twin database.

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

Available compatibility and measurement tools are:

| Tool | Behaviour |
| --- | --- |
| `list_houses` | house and floor layouts |
| `list_sensors` | sensor discovery, optionally scoped to a house |
| `get_sensor_snapshot` | placement plus latest reading |
| `query_history` | one sensor and bounded ISO date range |
| `forecast_sensor` | 1–168 hour linear baseline |
| `list_active_alerts` | unresolved alert events |
| `list_observations` | manual incident and maintenance context |
| `list_static_parameters` | house/floor/room/sensor context |
| `create_observation` | writes a manual observation |
| `list_measurement_definitions` | registered metrics, units, ranges, and spatial/forecast capabilities |
| `query_measurement_history` | one sensor and registered metric over a bounded ISO date range |
| `forecast_measurement` | forecast for a sensor/metric when its definition supports forecasting |

`create_observation` mutates household data. MCP process access is the authorization
boundary in this MVP, so only a trusted host should launch it. Agent policies
should require user confirmation before adding critical incidents or notes.

## Send alerts to Home Assistant

Create a Home Assistant automation with a random, secret webhook ID. The current
[Home Assistant webhook guidance](https://www.home-assistant.io/docs/automation/trigger/#webhook-trigger)
recommends keeping it local-only and treating the ID like a password. One YAML
shape is:

```yaml
alias: Climate Twin alert notification
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
      title: "Climate Twin: {{ trigger.json.event.severity }}"
      message: >-
        {{ trigger.json.rule.name }} at {{ trigger.json.event.sensorId }}:
        {{ trigger.json.event.value }} (threshold
        {{ trigger.json.event.threshold }}).
mode: queued
max: 10
```

Set the Climate Twin environment to the corresponding local URL:

```dotenv
ALERT_WEBHOOK_URL=http://homeassistant.local:8123/api/webhook/replace-with-secret-id
ALERT_WEBHOOK_BEARER_TOKEN=
```

Home Assistant webhook triggers authenticate by possession of the unguessable
ID, so leave the bearer token empty for this route. Enable `webhookEnabled` on
the desired Climate Twin alert rules.

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
    "webhookEnabled": true
  }
}
```

There is no durable retry/dead-letter queue or signature in the MVP. The
integration status reports the last success/error. Keep important safety alerts
in Home Assistant/certified devices as well; do not rely on this best-effort path
as the only notification.

Alert `durationSeconds` is currently **sample-driven and held in process
memory**. A rule is created only when another violating reading arrives after
the duration; a flat value with no new event can wait indefinitely, and an API
restart resets the pending duration. Use Home Assistant/certified alerting for
time-critical thresholds until durable timer evaluation is implemented.

## DayOps and OpenWearable

No DayOps/OpenWearable-specific identity or schema is assumed in the core. Keep
that contract in a versioned adapter so either project can evolve independently.

Recommended patterns:

1. **Read-only consumer:** query v2 measurement snapshot/history/forecast plus
   v1 alert events and observations; subscribe to the v2 measurement stream
   while online. Keep v1 reading routes only for existing clients.
2. **Alert relay:** set the single Climate Twin webhook to a local relay. Validate
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
