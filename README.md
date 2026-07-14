# Stuga 0.2.0

Stuga is a local-first digital twin for understanding how environmental conditions change and move through one or more homes. Temperature and relative humidity are the starting point; a measurement registry also supports CO2 and other finite numeric scalar measurements without coupling ingestion, history, alerts, or visualisation to one sensor model. It is designed around TP-Link Tapo H100/H200 hubs with T310/T315 sensors, while keeping ingestion vendor-neutral through a direct local bridge, Home Assistant, and versioned APIs. Internal package names retain the original `climate-twin` identifier for compatibility.

The included demo starts with a two-floor house, ten virtual sensors, temperature, humidity and CO2 telemetry, historical data, forecasts, alert rules, and replay. No hardware or cloud account is needed to evaluate it.

## What is included

- Live 2D authoring and an orbitable whole-building 3D view with every floor,
  sensor height, soft XYZ hotspot clouds, and a shared sensor-constrained
  temperature/water-vapour buoyancy flow estimate with an honestly labelled
  scalar-gradient fallback
- Floor-plan upload, wall drawing, and drag-to-place sensors
- Registry-defined measurements with built-in temperature (°C), humidity (%),
  and CO2 (ppm), plus independently timestamped custom numeric samples
- Durable SQLite history, timeline replay, trend charts, and capability-aware
  lightweight forecasts
- A decision layer with Home Pulse, prioritized room comfort, a moisture and
  ventilation coach, indoor/outdoor comparison, and a unified activity timeline
- Guided Excel/CSV history import with automatic column matching, preview,
  timezone/unit checks, and duplicate-safe retries
- Experimental effective room thermal calibration with durable outdoor
  boundary observations, fitted reconstructions, untouched holdout metrics,
  empirical bands, residuals, and a bounded
  weather scenario; observed and simulated values remain separate
- Direct local H100/H200 polling, Home Assistant WebSocket ingestion, and a mock scenario generator
- Manual leak/condensation/mould/maintenance observations and static metadata
- A shared multi-house map with calibrated, zoom-scaled geographic floor-plan
  footprints and pin fallback for legacy weather locations
- Independent per-house FMI weather locations and true-north plan-top
  orientation, plus observations, directional wind context, point forecasts,
  official CAP warnings, provenance, and partial/stale-data state
- Threshold alerts and configurable outbound webhooks for Home Assistant, OpenWearable, DayOps, or another receiver
- Versioned REST API, OpenAPI description, and a local stdio MCP server
- An optional tenant-isolated Cloudflare hosted edition using Workers, D1, R2,
  and Access, with a local bridge for LAN-only sensor integrations
- English and Finnish UI foundations, metric/imperial display, responsive layout, and accessible controls

## Quick start

Requires Node.js 22.13 or newer.

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Open <http://localhost:5173>. The API exposes the v1 compatibility contract at
<http://localhost:8787/api/v1> and registered measurements at
<http://localhost:8787/api/v2>; SQLite lives under `data/` by default.

Run all checks with:

```powershell
npm run typecheck
npm test
npm run build
```

For a container install:

```powershell
Copy-Item .env.example .env
docker compose up --build
```

Then open <http://localhost:8080>.

## Real sensors

Pair an H100 or H200 and its T310/T315 sensors in the Tapo app, then choose either ingestion path:

- **Direct TP-Link:** Stuga polls the hub on the local LAN through
  `python-kasa`; Home Assistant is not required. Open **Set up**, find the hub,
  and enter the TP-Link account credentials. Then name and place child sensors
  from the **Sensors** workspace. A legacy mapping file remains optional.
- **Home Assistant:** keep the official **TP-Link Smart Home** integration and
  use **Set up** to find Home Assistant and save its URL and long-lived token.
  The entity map remains the advanced data-binding step for this adapter.

Both adapters can run concurrently for different sensors. Do not map the same
physical child through both paths, or it will produce duplicate observations.
Credentials saved in the web flow are write-only to the browser and live in a
server-side secrets file outside SQLite. Environment variables remain available
as administrator overrides.

Mock telemetry is enabled for a new database so the product is useful before
hardware is connected. Saving Home Assistant or TP-Link credentials—or accepting
the first non-demo API/import sample or fresh FMI observation—atomically switches
that SQLite database to permanent real-data mode. The switch stops mock generation and active replay,
purges mock/replay readings, generic samples, synthetic outdoor boundaries, and
mock-derived alert events, and rejects every future attempt to store demo data.
The browser also waits for the API to confirm demo mode before showing or
generating mock telemetry, so an unavailable API fails closed instead of
displaying demo values for a real installation.
Use a separate database or deployment for later demonstrations; setting
`MOCK_ENABLED=true` cannot undo the real-data latch.

See [direct TP-Link setup](docs/tp-link-direct.md), [Home Assistant setup](docs/home-assistant.md), [architecture](docs/architecture.md), and [API/MCP integration](docs/integrations.md) for details.

The thermal model is documented in [effective room thermal
simulation](docs/thermal-simulation.md), and the 2D/3D dynamics layer in
[sensor-constrained indoor flow](docs/airflow-simulation.md). Stuga is pre-1.0; see the
[versioning policy](docs/versioning.md) before changing public contracts or
persisted schemas.

## House map and outdoor weather

Open **Integrations** to see every house that has a precise map placement or a
legacy weather location in one shared map. Select a house, place the centre of
its plan, optionally choose the footprint floor, and calibrate how many
real-world metres one plan unit represents in `House.mapPlacement`. The
resulting footprint keeps its true geographic size as the map zoom changes.
Houses that have only the legacy weather location remain visible as pins.
Property/site grouping and surveyed parcel boundaries are not modeled yet, so
this shared view can span multiple properties.

Weather lookup in `House.location` remains independent. Set the selected
house's WGS84 weather reference and the true-north bearing of the top of its
floor plan. Moving its precise map placement does not change that reference or
purge retained weather history. Stuga then retrieves house-scoped
observations, forecasts, and official warnings from the Finnish Meteorological
Institute through
`GET /api/v1/houses/{id}/weather?hours=48`. FMI's selected public endpoints do
not require an API key. The API caches results and exposes station/product
provenance, partial failures, and stale fallback explicitly.

The live Twin view shows the current outside temperature, humidity, and wind.
When orientation is known, it also maps wind direction to a windward plan edge
in 2D and 3D. This is an external boundary cue, not a heat-transfer or airflow
simulation.

The map loads attributed tiles directly from OpenStreetMap, which is an external
browser request; FMI requests are server-side. See [FMI weather and house
location](docs/weather.md) for fields, licence/request limits, station caveats,
failure semantics, and map privacy.

## Hosted edition

The optional `cloudflare/` target serves the web application and a portable,
tenant-scoped API from a Worker. D1 stores compact telemetry buckets, R2 stores
private tenant-prefixed assets, and Cloudflare Access supplies the identity
perimeter. Local TP-Link and Home Assistant polling remain on the home network
and upload through a separately scoped bridge credential. Production resource
IDs, Access policy values, and deployment secrets are intentionally not stored
in this repository. See [Cloudflare hosting and multi-tenant operations](docs/cloudflare-hosting.md)
for the tested route manifest, security model, free-tier assumptions, setup,
deployment, and rollback instructions.

## MCP

Build once, then configure a local MCP host to spawn:

```json
{
  "mcpServers": {
    "stuga": {
      "command": "node",
      "args": ["apps/api/dist/mcp-server.js"],
      "cwd": "/absolute/path/to/open-stuga"
    }
  }
}
```

The MCP process uses the same `DATABASE_PATH` as the API, so it can discover
measurement definitions, query metric history/forecasts and current conditions,
or record an observation without copying telemetry into an AI provider. Run
`npm run build` before launching the compiled server.

## Project layout

```text
apps/web/             React/Vite digital-twin UI
apps/api/             API, SQLite store, live ingestion, alerts, MCP
packages/contracts/   Shared domain and API types
cloudflare/            Tenant-isolated hosted Worker, D1 migration, and tests
config/               Integration mapping examples
docs/                 Setup, architecture, security, and roadmap
```

## Scope

This is an installable engineering MVP, not a certified building-safety system. Spatial surfaces are interpolation estimates; animated paths are a normalized sensor-constrained model, not measured airflow, physical speed, or calibrated CFD. Forecasts are intentionally explainable trend projections; alerts and leak observations must not replace calibrated detectors, CO alarms, inspections, or professional advice. The modular prediction boundary is ready for a separately validated model when enough real data and boundary-state inputs have been collected.

## License

Stuga is open-source software licensed under the [MIT License](LICENSE).
Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
