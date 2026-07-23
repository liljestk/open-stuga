# Stuga 0.5.0

Stuga is a local-first digital twin for understanding how environmental conditions change and move through one or more homes. Temperature and relative humidity are the starting point; a measurement registry also supports CO2 and other finite numeric scalar measurements without coupling ingestion, history, alerts, or visualisation to one sensor model. It is designed around TP-Link Tapo H100/H200 hubs with T310/T315 sensors, while keeping ingestion vendor-neutral through a direct local bridge, Home Assistant, and versioned APIs. Internal package names retain the original `climate-twin` identifier for compatibility.

The opt-in demo starts with a two-floor home, ten virtual sensors, temperature, humidity and CO2 telemetry, historical data, forecasts, alert rules, and replay. Set `MOCK_ENABLED=true` before the first start; no hardware or cloud account is needed to evaluate it. Normal installs use the guided Property-and-Home setup instead.

## What is included

- Live 2D authoring and an orbitable whole-building 3D view with every floor,
  sensor height, soft XYZ hotspot clouds, and a shared sensor-constrained
  temperature/water-vapour buoyancy flow estimate with an honestly labelled
  scalar-gradient fallback
- Floor-plan upload, wall drawing, and drag-to-place sensors
- Registry-defined measurements with built-in temperature (°C), humidity (%),
  and CO2 (ppm), plus independently timestamped custom numeric samples
- A transactional SQLite control plane and crash-safe hot telemetry buffer,
  with TimescaleDB for durable multi-year history, rollups, and efficient trend
  queries
- Resumable live system-to-system migration over authenticated SSH, with an
  online seed, content-addressed chunk reuse, verified final snapshot, isolated
  TimescaleDB candidate restore, portable settings transfer, health-gated
  cutover, rollback, and split-brain protection
- A decision layer with Home Pulse, prioritized room comfort, a moisture and
  ventilation coach, indoor/outdoor comparison, an activity timeline, and
  explainable monitoring blockers that distinguish current coverage from
  missing or stale data
- Data & analytics with coverage-aware evidence, CSV/JSON export, and
  house-local day/week/month/year/decade comparisons across the selected
  single, multiple, or aggregated sensor series
- Persisted daily notable comparisons for indoor sensors, observed outdoor
  temperature, electricity power/energy, and available door/window opening
  activity, with like-for-like month-to-date evidence and no causal claims
- Guided Excel/CSV history import with automatic column matching, preview,
  timezone/unit checks, and duplicate-safe retries
- Experimental effective room thermal calibration plus room, floor, and
  whole-home 24-hour thermal-isolation comparison with durable outdoor
  boundary observations, fitted reconstructions, untouched holdout metrics,
  empirical bands, residuals, and a bounded
  weather scenario; observed and simulated values remain separate
- Direct local H100/H200 polling, Home Assistant WebSocket ingestion, and a mock scenario generator
- Durable TP-Link gap recovery: local retained history first, an optional
  operator-maintained private adapter second, then a disabled-by-default,
  canary-gated Tapo Android/Appium export with Gmail CSV correlation
- Manual leak/condensation/mould/maintenance observations with observed versus
  recorded time, explicit precision, source, confidence, open/resolved state,
  resolution outcomes, and revision history, plus static metadata
- Home-scoped Activity plus Property-scoped Maintenance, with fast observation
  capture, dated and classified work planning, linked evidence, completion
  outcomes, explicit verification, and revision history
- A Property-scoped multi-Home map with calibrated, zoom-scaled geographic
  floor-plan footprints and pin fallback for legacy weather locations
- Property management with Homes grouped into Properties, user-drawn outdoor
  areas, area equipment, contextual notes, and area/equipment-linked maintenance
- Built-in local owner, administrator, and Guest accounts in one workspace;
  Guests are always read-only and can be restricted to selected properties,
  Homes, and mapped areas
- Independent per-Home FMI weather locations and true-north plan-top
  orientation, plus observations, directional wind context, point forecasts,
  official CAP warnings, provenance, partial/stale-data state, and a
  provider-neutral event broker that turns scheduled pulls into live SSE weather
  snapshots
- Threshold alerts with independent Telegram and multi-destination generic
  webhook delivery; Telegram includes guided bot/chat discovery, a delivery
  test, and per-rule opt-in
- A Home-scoped Apple Notes bridge for iOS Shortcuts: use revocable Shortcut
  grants, capture selected note text as maintenance work, and create dated Stuga
  snapshots without sharing an Apple Account credential or pretending Notes
  supports live server sync; operator device labels are informational, and the
  setup warns that iCloud may copy a Shortcut bearer to other devices
- Versioned REST API, OpenAPI description, and a local stdio MCP server
- English, Finnish, and Swedish UI foundations, metric/imperial display,
  responsive layout, and accessible controls

## Quick start

Requires Node.js 22.13 or newer.

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Open <http://localhost:5173>. The API exposes the v1 compatibility contract at
<http://localhost:8787/api/v1> and registered measurements at
<http://localhost:8787/api/v2>; local development keeps SQLite under `data/`
by default, while the Compose stack also maintains the Timescale archive.

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

Create and verify a complete online recovery set with:

```powershell
docker compose --profile maintenance run --rm stuga-backup
```

The output under `backups/` contains both SQLite databases, assets, protected
integration secrets, and a full TimescaleDB dump. Treat it as sensitive and
copy it to encrypted off-host storage.

Move a running Compose installation to a booted Stuga appliance with an
optional online seed followed by a short, explicit cutover:

```powershell
npm run migrate -- seed --target stuga@stuga.local --identity-file "$HOME/.ssh/stuga_appliance"
npm run migrate -- cutover --target stuga@stuga.local --identity-file "$HOME/.ssh/stuga_appliance"
```

See [live system-to-system migration](docs/live-migration.md) before the first
cutover; it documents host-key verification, included settings, rollback, and
the fail-closed response to an ambiguous network failure.

## Real sensors

Pair an H100 or H200 and its T310/T315 sensors in the Tapo app, then choose either ingestion path:

- **Direct TP-Link:** Stuga polls the hub on the local LAN through
  `python-kasa`; Home Assistant is not required. Select the owning Home, open
  **Set up**, find the hub, and enter the TP-Link account credentials. Then name
  and place child sensors from that Home's **Sensors** workspace. A legacy
  mapping file remains optional.
- **Home Assistant:** keep the official **TP-Link Smart Home** integration and
  use the owning Home's **Set up** page to find Home Assistant and save its URL
  and long-lived token. The entity map remains the advanced data-binding step
  for this adapter.

Home Assistant and direct TP-Link connections are owned by one Home. Different
Homes can use independent credentials and endpoints, and both adapters can run
concurrently for different sensors. Do not map the same physical child through
both paths, or it will produce duplicate observations.
Credentials saved in the web flow are write-only to the browser and live in a
server-side protected secrets file outside SQLite. Safe integration ownership,
endpoint identity, lifecycle state, and revisions live in SQLite; environment
variables remain available as administrator overrides.

Older direct TP-Link climate gaps can use the optional automated Tapo history
service. It segments requests within Tapo's two-year window, permits only one
outstanding mobile/email generation by default, and fails closed on identity,
unit, range, cadence, schema, mailbox, or selector drift. The Android runner is
inert until explicitly enabled and ordinary work remains locked behind a recent
live canary for the exact target, APK/Appium/driver/locale/account/flow, API
build, and CSV schema. The checked-in flow contains placeholders, not usable
selectors. See [automated Tapo history recovery](docs/tapo-history-automation.md)
before supplying credentials or enabling the Compose profile.

Mock telemetry can be enabled explicitly for a new demo database so the product
can be evaluated before hardware is connected. Saving Home Assistant or TP-Link credentials—or accepting
the first non-demo API/import sample or fresh FMI observation—atomically switches
that SQLite database to permanent real-data mode. The switch stops mock generation and active replay,
purges mock/replay readings, generic samples, synthetic outdoor boundaries, and
mock-derived alert events, and rejects every future attempt to store demo data.
The browser also waits for the API to confirm demo mode before showing or
generating mock telemetry, so an unavailable API fails closed instead of
displaying demo values for a real installation. Confirmed demo mode retains a
persistent banner and visually distinct shell while navigating the product.
Use a separate database or deployment for later demonstrations; setting
`MOCK_ENABLED=true` cannot undo the real-data latch.

See [direct TP-Link setup](docs/tp-link-direct.md), [automated Tapo history recovery](docs/tapo-history-automation.md), [electricity prices and contracts](docs/electricity-prices.md), [Home Assistant setup](docs/home-assistant.md), [property management and Guest access](docs/property-management.md), [Cloudflare Tunnel and Access](docs/cloudflare-access.md), [live system migration](docs/live-migration.md), [manual observation semantics](docs/observations.md), [activity and maintenance work](docs/maintenance.md), [Apple Notes and Telegram setup](docs/apple-notes-telegram.md), [architecture](docs/architecture.md), and [API/MCP integration](docs/integrations.md) for details.

The thermal model is documented in [effective room thermal
simulation](docs/thermal-simulation.md), and the 2D/3D dynamics layer in
[sensor-constrained indoor flow](docs/airflow-simulation.md). Stuga is pre-1.0; see the
[versioning policy](docs/versioning.md) before changing public contracts or
persisted schemas.

## Navigation and scope

The permanent navigation follows the ownership model: Workspace contains
**Overview**, **Properties**, and **Alerts**; a selected Property contains
**Property**, **Maintenance**, and **Electricity**; and a selected Home contains
**Home**, **Sensors**, and **Set up**. **API & MCP** remains under Advanced.
Property and Home selections are encoded in canonical URLs, including
`/properties/{propertyId}/maintenance`,
`/properties/{propertyId}/electricity`, and
`/properties/{propertyId}/homes/{homeId}/setup/{section}`.

## Home map and outdoor weather

Select a Property and open a Home's **Set up > Homes** section to see the Homes
in that Property that have a precise map placement or legacy weather location.
Select a Home, place the centre of its plan, optionally choose the footprint
floor, and calibrate how many
real-world metres one plan unit represents in `House.mapPlacement`. The
resulting footprint keeps its true geographic size as the map zoom changes.
Homes that have only the legacy weather location remain visible as pins.
The **Properties** workspace groups Homes by Property and supports
user-drawn operational areas. These polygons are planning context rather than
surveyed or legally authoritative parcel boundaries.

Weather lookup in `House.location` remains independent. Set the selected
Home's WGS84 weather reference and the true-north bearing of the top of its
floor plan. Moving its precise map placement does not change that reference or
purge retained weather history. Stuga then retrieves Home-scoped
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
browser request; FMI requests are server-side. See [outdoor weather and home
location](docs/weather.md) for fields, licence/request limits, station caveats,
failure semantics, and map privacy.

## Local accounts and Guest access

Every installation has one local workspace with built-in owner, administrator,
and Guest accounts. Browser sign-in establishes a server-managed HttpOnly
session. The API enforces permissions on every request: Guests cannot make
changes and can see only the Properties, Homes, and mapped areas granted by an
owner or administrator. A grant to a child resource reveals only the minimum
parent context needed to identify it, never sibling resources.

The sign-in boundary does not encrypt network traffic. Keep the default
loopback binding, or put Stuga behind TLS and a trusted VPN or reverse proxy
before allowing access from another network. The optional
[Cloudflare Tunnel and Access recipe](docs/cloudflare-access.md) keeps a
permanent edge-recovery identity separate from the local Stuga owner and
reconciles invited members without exposing the host port.

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
config/               Integration mapping examples
docs/                 Setup, architecture, security, and roadmap
```

## Scope

This is an installable engineering MVP, not a certified building-safety system. Spatial surfaces are interpolation estimates; animated paths are a normalized sensor-constrained model, not measured airflow, physical speed, or calibrated CFD. Forecasts are intentionally explainable trend projections; alerts and leak observations must not replace calibrated detectors, CO alarms, inspections, or professional advice. The modular prediction boundary is ready for a separately validated model when enough real data and boundary-state inputs have been collected.

## License

Stuga is open-source software licensed under the [MIT License](LICENSE).
Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
