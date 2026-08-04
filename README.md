# Stugu 0.32.3

Stugu is a local-first digital twin for understanding how environmental conditions change and move through one or more homes. Temperature and relative humidity are the starting point; a measurement registry also supports CO2 and other finite numeric scalar measurements without coupling ingestion, history, alerts, or visualisation to one sensor model. It is designed around TP-Link Tapo H100/H200 hubs and locally exposed H500 children with T310/T315 sensors, while keeping ingestion vendor-neutral through a direct local bridge, Home Assistant, and versioned APIs. Internal package names retain the original `climate-twin` identifier for compatibility.

The opt-in demo starts with a two-floor home, ten virtual sensors, temperature, humidity and CO2 telemetry, historical data, forecasts, alert rules, and replay. Set `MOCK_ENABLED=true` before the first start; no hardware or cloud account is needed to evaluate it. Normal installs use the guided Property-and-Home setup instead.

## What is included

- Live 2D authoring and an orbitable whole-building 3D view with every floor,
  sensor height, soft XYZ hotspot clouds, and a shared sensor-constrained
  temperature/water-vapour buoyancy flow estimate with an honestly labelled
  scalar-gradient fallback
- Floor-plan upload, wall drawing, and drag-to-place sensors
- Registry-defined measurements with built-in temperature (°C), humidity (%),
  and CO2 (ppm), plus independently timestamped custom numeric samples
- A transactional SQLite control plane with a crash-safe telemetry outbox and
  current projections, plus TimescaleDB as the permanent store for sensor,
  weather, electricity-price, opening-event, and direct heat-pump history
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
- Direct local H100/H200/H500 and supported Tuya Wi-Fi device polling, Home
  Assistant WebSocket ingestion, and a mock scenario generator
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
- Inert-until-granted Stuguby federation between independently administered
  Stugu systems, with Server Property adoption, offline collaborative Property
  edits, read-only-by-default shared Homes, designated sanitized recovery, and
  signed HTTPS synchronization; only the coordinator needs an inbound endpoint
- Built-in local owner, administrator, and Guest accounts in one workspace;
  Guests are always read-only and can be restricted to selected properties,
  Homes, and mapped areas
- Property-default FMI weather locations with optional advanced per-Home
  overrides and true-north plan-top orientation, plus observations, directional wind context, point forecasts,
  official CAP warnings, provenance, partial/stale-data state, and a
  provider-neutral event broker that turns scheduled pulls into live SSE weather
  snapshots
- Threshold alerts with independent Telegram and multi-destination generic
  webhook delivery; Telegram includes guided bot/chat discovery, a delivery
  test, per-rule Home alert opt-in, and automatic deduplicated host-health and
  storage-forecast alerts with recovery notices
- Owner/Admin host diagnostics with persisted storage-growth forecasts,
  SQLite and optional Timescale metrics in the Prometheus feed, and a bounded,
  redacted error-log export
- A Home-scoped Apple Notes bridge for iOS Shortcuts: use revocable Shortcut
  grants, capture selected note text as maintenance work, and create dated Stugu
  snapshots without sharing an Apple Account credential or pretending Notes
  supports live server sync; operator device labels are informational, and the
  setup warns that iCloud may copy a Shortcut bearer to other devices
- A lightweight native iPhone companion for direct monitoring and field work,
  plus complete iPad and Mac Catalyst clients that present the same
  server-hosted product as the web app; Apple-only capture, notifications,
  shortcuts, offline state, and Watch support remain native
- Versioned REST API, OpenAPI description, and local stdio plus authenticated network MCP servers
- English, Finnish, and Swedish UI foundations, metric/imperial display,
  responsive layout, and accessible controls

## Quick start

With Node.js available, run the guided setup:

```sh
npm run setup
```

It asks whether to use local Node.js, Docker, Podman, or the Raspberry Pi
appliance flow; whether this is a real home or a disposable demo; and, for
containers, which local port to use. Docker users can explicitly install the
trusted host agent as a per-user startup service. The host port stays on
loopback.

For the normal Stuguby path, start locally, create the Owner, then open
**Stugubys → Set up secure sharing** on the Stugu computer. Stugu registers its
private Cloudflare OAuth client from one API token with **OAuth Client Write**,
opens Cloudflare consent, provisions Tunnel, DNS, and Access through the host
agent, verifies the boundary, and revokes the temporary OAuth grant. The
bootstrap token is used once and never saved. Existing online installations
reuse their retained narrow Access-group token; a new installation asks for
that separate runtime token once in the UI. The CLI provisioner remains an
advanced fallback.

The wizard changes only basic `.env` values and preserves existing secrets and
advanced settings. Cloudflare runtime credentials go into the ignored,
protected `secrets/cloudflare/` directory, never `.env`.

For a non-interactive local development setup:

```sh
npm run setup -- --mode local --real --yes
npm run dev
```

Open <http://localhost:5173>. The API exposes the v1 compatibility contract at
<http://localhost:8787/api/v1> and registered measurements at
<http://localhost:8787/api/v2>.

Run the complete local CI gate before pushing:

```powershell
npm run ci:local
```

It runs validation, coverage, builds, Compose checks, production container
builds, and an API smoke test on this computer. See
[local CI and release publishing](docs/local-ci.md).

Non-interactive container examples:

```sh
npm run setup -- --mode docker --real --start --install-update-agent --no-cloudflare --yes
npm run setup -- --mode podman --real --start --no-cloudflare --yes
```

Both default to <http://localhost:8080>. Podman setup enables the core stack
and disables the Docker-socket self-update profile.

See [the complete getting-started guide](docs/getting-started.md) for manual
Docker/Podman setup, direct TP-Link dependencies, demo mode, LAN access, and
the [Raspberry Pi appliance flow](docs/raspberry-pi-appliance.md).

Create and verify a complete online recovery set with:

```powershell
docker compose --profile maintenance run --rm stugu-backup
```

The output under `backups/` contains both SQLite databases, assets, the Stuguby
node identity, the tracking endpoint identity-encryption key when present, protected
integration secrets, and a full
TimescaleDB dump. Treat it as sensitive and copy it to encrypted off-host
storage.

The always-on scheduler keeps its private recovery sets in an engine-managed
volume so Docker and rootless Podman behave consistently on Linux, macOS, and
Windows. `STUGA_SCHEDULED_BACKUP_SOURCE` can instead point at an absolute
mounted NAS directory; keep PostgreSQL itself on local block/SSD storage via
`STUGA_TIMESERIES_DATA_SOURCE`. Export verified named-volume sets to `backups/`
with:

```powershell
docker compose --profile maintenance run --rm stugu-backup-export
```

With the trusted host update agent connected, Owners/Admins can connect the
shared NAS under **Set up → Operations** or use the full controls under
**System → Storage**. Paths must already be mounted below
`STUGA_STORAGE_ALLOWED_ROOTS`. NAS is accepted only as a recovery and derived
export target, never for the live telemetry database. Storage moves are backed
up, restore-tested, journaled, copied, mount-verified, and rolled back without
deleting the old source. Each Home chooses its scheduled CSV exports under
**Data & analytics**.

Use `podman compose` in both commands when Podman is the selected runtime.
See the [lossless telemetry scale plan](docs/telemetry-scale-plan.md) and
[backend storage guide](docs/backend-storage.md) for retention, SSD/NAS, alert,
query-acceleration, and recovery invariants.

Move a running Compose installation to a booted Stugu appliance with an
optional online seed followed by a short, explicit cutover:

```powershell
npm run migrate -- seed --target stugu@stugu.local --identity-file "$HOME/.ssh/stuga_appliance"
npm run migrate -- cutover --target stugu@stugu.local --identity-file "$HOME/.ssh/stuga_appliance"
```

See [live system-to-system migration](docs/live-migration.md) before the first
cutover; it documents host-key verification, included settings, rollback, and
the fail-closed response to an ambiguous network failure.

## Real sensors

Pair an H100 or H200 and its T310/T315 sensors in the Tapo app, then choose either ingestion path:

- **Direct TP-Link:** Stugu polls the hub on the local LAN through
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
concurrently. When both paths expose the same physical child, keep one Stugu
sensor and attach both its direct device ID and Home Assistant entity IDs to
that sensor. Stugu uses the healthy direct path for faster live updates and
fails over to Home Assistant without duplicating live history or alert
evaluation. The Sensors flow can attach a newly discovered direct device to an
existing Home Assistant sensor; aliases are never guessed as identity.

Compatible Gree-protocol Wilfa heat pumps can be found from the selected Home's
**Set up** page and monitored read-only, locally first or through EWPE Smart.
After explicit addition, place the unit once for shared 2D/3D state and
estimated-influence views. See [Gree/Wilfa heat pumps](docs/gree-direct.md).

Supported Tuya-compatible Wi-Fi lamps, outlets, and switches use a separate
local-first path. Pair the device to Wi-Fi in Tuya Smart or Smart Life, then
provide its device ID and write-only local key under the owning Home's **Set
up** page. Tuya discovery is excluded from the normal network scan and starts
only for that supplied device. Stugu verifies the exact datapoint profile before
saving it, controls it directly on the LAN, reconnects after address changes,
and shows the same provider-neutral device in 2D and 3D. Only devices that
actually report measured power enter Energy; lamp consumption is never
guessed. See
[local Tuya Wi-Fi devices](docs/tuya-local.md).

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

See [direct TP-Link setup](docs/tp-link-direct.md), [local Tuya Wi-Fi devices](docs/tuya-local.md), [automated Tapo history recovery](docs/tapo-history-automation.md), [electricity prices and contracts](docs/electricity-prices.md), [Home Assistant setup](docs/home-assistant.md), [property management and Guest access](docs/property-management.md), [Stuguby federation](docs/stuguby.md), [private bug reports](docs/bug-reports.md), [ChatGPT and voice](docs/chatgpt.md), [Cloudflare Tunnel and Access](docs/cloudflare-access.md), [system updates](docs/system-updates.md), [live system migration](docs/live-migration.md), [manual observation semantics](docs/observations.md), [activity and maintenance work](docs/maintenance.md), [Apple Notes and Telegram setup](docs/apple-notes-telegram.md), [architecture](docs/architecture.md), and [API/MCP integration](docs/integrations.md) for details.

The thermal model is documented in [effective room thermal
simulation](docs/thermal-simulation.md), and the 2D/3D dynamics layer in
[sensor-constrained indoor flow](docs/airflow-simulation.md). Stugu is pre-1.0; see the
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

Weather lookup uses the Property's WGS84 location by default. The separate
`House.location` field stores the operational copy and may instead hold an
advanced per-Home override. When neither is available, Stugu can infer an
automatic fallback from `House.mapPlacement`; later Property or placement
changes update only automatic values, never a manual override. Set the
true-north bearing of the top of each floor plan separately. Stugu then retrieves Home-scoped
observations, forecasts, and official warnings from the Finnish Meteorological
Institute through
`GET /api/v1/houses/{id}/weather?hours=48`. FMI's selected public endpoints do
not require an API key. The API caches results and exposes station/product
provenance, partial failures, and stale fallback explicitly.

The live Twin view shows the current outside temperature, humidity, and wind.
When orientation is known, it also maps wind direction to a windward plan edge
in 2D and 3D. The 2D view can animate a directional sketch approaching and
splitting around the plan; its bearing and density come from the observation,
but the exterior paths are not CFD. Indoor paths remain the separate,
sensor-constrained Air movement estimate.

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
loopback binding, or put Stugu behind TLS and a trusted VPN or reverse proxy
before allowing access from another network. The optional
[Cloudflare Tunnel and Access recipe](docs/cloudflare-access.md) keeps a
permanent edge-recovery identity separate from the local Stugu owner and
reconciles invited members without exposing the host port. Its coordinator
mode also automates and verifies the one narrow signed-machine path required by
a Stuguby; participant nodes remain outbound-only.

## MCP

Stugu is the MCP server; Codex, another local service, or an RPi application is
the MCP client. An Owner or Admin can open **Advanced → API & MCP**, select
**Start network MCP server**, and copy the displayed Streamable HTTP endpoint
and one-time bearer token. A generic client shape is:

```json
{
  "mcpServers": {
    "stugu": {
      "type": "streamable-http",
      "url": "https://stugu.example/api/v1/mcp",
      "headers": { "Authorization": "Bearer stugu_mcp_..." }
    }
  }
}
```

Use the exact schema required by the client. Stop the server in the Web UI to
revoke the token. Put remote access behind TLS or a trusted VPN; a bearer token
must not travel over an untrusted plain-HTTP connection.

For a client on the same machine, build once and configure it to spawn the
stdio server directly:

```json
{
  "mcpServers": {
    "stugu": {
      "command": "node",
      "args": ["apps/api/dist/mcp-server.js"],
      "cwd": "/absolute/path/to/open-stuga"
    }
  }
}
```

Both MCP transports use the same `DATABASE_PATH` and TimeDB settings as the API,
so clients can discover Properties, Homes, Stugubys, measurement definitions,
metric history/forecasts, current conditions, electricity/energy analysis,
alerts, actions, maintenance, integrations, backups, and setup readiness without
copying telemetry into an AI provider. Each MCP process opens SQLite read-only
and queries TimeDB only for telemetry history; neither exposes create, update,
delete, import, sharing, synchronization, or control tools.
Start the API once after an upgrade so migrations are current, and run
`npm run build` before launching the compiled server.

For a smaller tool set tuned for ChatGPT selection and voice answers, run
`npm run mcp:chatgpt` or
`node --env-file-if-exists=.env apps/api/dist/chatgpt-mcp-server.js`. The
private tunnel and ChatGPT setup is documented in
[ChatGPT and voice](docs/chatgpt.md).

## Project layout

```text
apps/web/             React/Vite digital-twin UI
apps/api/             API, SQLite store, live ingestion, alerts, MCP
apps/ios/             iPhone companion and full iPad/Mac client
packages/contracts/   Shared domain and API types
config/               Integration mapping examples
docs/                 Setup, architecture, security, and roadmap
```

## Scope

This is an installable engineering MVP, not a certified building-safety system. Spatial surfaces are interpolation estimates; animated paths are a normalized sensor-constrained model, not measured airflow, physical speed, or calibrated CFD. Forecasts are intentionally explainable trend projections; alerts and leak observations must not replace calibrated detectors, CO alarms, inspections, or professional advice. The modular prediction boundary is ready for a separately validated model when enough real data and boundary-state inputs have been collected.

## License

Stugu is open-source software licensed under the [MIT License](LICENSE).
Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
