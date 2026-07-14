# Climate Twin

Climate Twin is a local-first digital twin for exploring how environmental measurements change and move through one or more homes. Temperature and relative humidity are the starting point; a measurement registry also supports CO2 and other finite numeric scalar measurements without coupling ingestion, history, alerts, or visualisation to one sensor model. It is designed around TP-Link Tapo H200 hubs with T310/T315 sensors, while keeping ingestion vendor-neutral through Home Assistant and versioned APIs.

The included demo starts with a two-floor house, ten virtual sensors, temperature, humidity and CO2 telemetry, historical data, forecasts, alert rules, and replay. No hardware or cloud account is needed to evaluate it.

## What is included

- Live 2D authoring and an orbitable whole-building 3D view with every floor,
  sensor height, soft XYZ hotspot clouds, and 2D/3D high-to-low estimated
  gradient cues for every measurement that opts into spatial interpolation
- Floor-plan upload, wall drawing, and drag-to-place sensors
- Registry-defined measurements with built-in temperature (°C), humidity (%),
  and CO2 (ppm), plus independently timestamped custom numeric samples
- Durable SQLite history, timeline replay, trend charts, and capability-aware
  lightweight forecasts
- Home Assistant WebSocket ingestion plus a mock scenario generator
- Manual leak/condensation/mould/maintenance observations and static metadata
- Per-house map location plus FMI observations, point forecasts, official CAP
  warnings, provenance, and partial/stale-data state
- Threshold alerts and configurable outbound webhooks for Home Assistant, OpenWearable, DayOps, or another receiver
- Versioned REST API, OpenAPI description, and a local stdio MCP server
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

The recommended path is:

1. Pair the H200 and T310/T315 sensors in the Tapo app.
2. Add the **TP-Link Smart Home** integration in Home Assistant.
3. Confirm each sensor exposes temperature, humidity, and optionally battery entities. Add CO2 or other supported entities from separate devices as needed.
4. Copy `config/home-assistant.entities.example.json` to `config/home-assistant.entities.json` and replace its entity IDs.
5. Set `HA_URL`, `HA_TOKEN`, and `HA_ENTITY_MAP_FILE` in `.env`, then restart Climate Twin.

The Home Assistant bridge subscribes to state changes and forwards each mapped metric with its own source timestamp, quality, and canonical unit to the same pipeline used by mocks and the ingestion API. Legacy temperature/humidity keys remain supported. Credentials remain in environment configuration and are not written to SQLite.

See [Home Assistant setup](docs/home-assistant.md), [architecture](docs/architecture.md), and [API/MCP integration](docs/integrations.md) for details.

## Outdoor weather

Open **Integrations**, select the house on the map (or enter WGS84 coordinates),
and save it. Climate Twin then retrieves house-scoped observations, forecasts,
and official warnings from the Finnish Meteorological Institute through
`GET /api/v1/houses/{id}/weather?hours=48`. FMI's selected public endpoints do
not require an API key. The API caches results and exposes station/product
provenance, partial failures, and stale fallback explicitly.

The map loads attributed tiles directly from OpenStreetMap, which is an external
browser request; FMI requests are server-side. See [FMI weather and house
location](docs/weather.md) for fields, licence/request limits, station caveats,
failure semantics, and map privacy.

## MCP

Build once, then configure a local MCP host to spawn:

```json
{
  "mcpServers": {
    "climate-twin": {
      "command": "node",
      "args": ["apps/api/dist/mcp-server.js"],
      "cwd": "/absolute/path/to/climate-twin"
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
config/               Integration mapping examples
docs/                 Setup, architecture, security, and roadmap
```

## Scope

This is an installable engineering MVP, not a certified building-safety system. Spatial surfaces are interpolation estimates, not measured airflow. Forecasts are intentionally explainable trend projections; alerts and leak observations must not replace calibrated detectors, CO alarms, inspections, or professional advice. The modular prediction boundary is ready for a separately validated model when enough real data has been collected.

## License

Climate Twin is open-source software licensed under the [MIT License](LICENSE).
Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
