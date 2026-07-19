# Install and run Stuga

Stuga's normal first run guides you through creating a property and its first
home. An optional mock mode can instead seed a sample home and sensors so the
visualisation, history, alerts, and replay workflow can be evaluated before the
physical sensors arrive. Temperature, relative humidity, and CO2 are built in;
additional finite numeric scalar measurements can be registered later.

## Choose a run mode

| Mode | Best for | Public URL |
| --- | --- | --- |
| Docker Compose | normal home installation and evaluation | `http://localhost:8080` |
| Local Node.js | development and contributing | `http://localhost:5173` |

The API listens on port `8787` in both modes. In Docker it is private to the
Compose network; the web container exposes the complete versioned API by
reverse-proxying `/api/*` on port `8080`.

## Docker Compose

Prerequisites: a current Docker Engine with Compose v2.

1. Create a private environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

   On macOS/Linux use `cp .env.example .env`.

2. Leave `MOCK_ENABLED=false` for a real workspace and use the guided
   property/home setup. Set it to `true` before the first start only for an
   isolated demo. Do not put real tokens in `.env.example`; add them only to
   `.env`.
3. Build and start:

   ```sh
   docker compose up --build -d
   ```

4. Open <http://localhost:8080> and check API health at
   <http://localhost:8080/api/v1/health>.
5. Follow logs when diagnosing startup:

   ```sh
   docker compose logs -f api web
   ```

6. Stop without deleting history:

   ```sh
   docker compose down
   ```

History is stored in the named `climate-twin-data` volume. Compose also keeps a
generated API-to-proxy credential in the dedicated `climate-twin-runtime`
volume; it is never exposed to the browser. `docker compose down -v` deletes
both volumes and all retained readings; use it only when an explicit reset is
intended.

Compose binds the web port to loopback by default. To use the UI from another
device on the private LAN, set `BIND_ADDRESS` in `.env` to the host's specific
LAN address (preferred) or `0.0.0.0`, allow only the intended subnet in the host
firewall, and review the security guide first. Built-in accounts protect the
web application and API with a server-managed HttpOnly session; complete owner
setup and sign in before using `/api/v1` or `/api/v2`. Authentication does not
make plain HTTP safe outside a trusted network.

To update an installation, back up the data volume/database, fetch the desired
release, then run `docker compose up --build -d` again. Pin a release tag in a
long-lived deployment instead of running an arbitrary moving branch.

## Local Node.js development

Prerequisites: Node.js 22.13 or newer and npm.

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

On macOS/Linux, replace the first line with `cp .env.example .env`.

The Vite app runs on <http://localhost:5173> and proxies `/api` to the API at
`127.0.0.1:8787`. Keep `VITE_API_BASE_URL` empty for this same-origin/proxy
setup.

Useful checks:

```sh
npm run typecheck
npm test
npm run build
```

Run only one workspace when iterating:

```sh
npm run dev --workspace @climate-twin/api
npm run dev --workspace @climate-twin/web
```

## Optional first-run mock workflow

Before starting a fresh demo database, set `MOCK_ENABLED=true`. The opt-in seed
creates one Property with one Home, two floors, ten placed sensors, and registry
definitions for temperature (°C), relative humidity (%), and CO2 (ppm). With
`MOCK_ENABLED=true`, the API generates synthetic samples at `MOCK_INTERVAL_MS`
intervals.

1. Verify all ten sensor tiles change and the connection indicator is live.
2. Switch between temperature, humidity, and CO2; verify the legend, precision,
   unit, and available-sensor state follow the selected definition.
3. In the 2D plan, verify the selected spatial metric shows soft hotspot clouds
   and dashed high-to-low gradient arrows. Switch to the 3D building view and
   verify the field becomes an XYZ cloud with all ten sensors visible. Orbit and
   zoom the camera, confirm diagonal/vertical vectors remain anchored in the
   volume, then inspect a sensor's floor and mounting height.
4. Select a sensor and inspect history for each available metric. Its timestamp,
   source, quality, and stale state should be metric-specific.
5. Exercise a mock scenario such as shower, leak, cold front, or heating failure
   from the UI/API when available.
6. Use replay to inspect a historical window across the building. Replay events
   remain labeled and should not deliver real-world alerts.
7. Optionally create a custom definition such as `voc_index` through
   `/api/v2/measurement-definitions`, ingest a v2 sample, and verify it appears as
   a marker/history series. If spatial/forecast capability flags are false, the
   correct result is no interpolated surface and no forecast.

Mock data is synthetic. Stuga prevents it from crossing into a real
installation: saving Home Assistant or TP-Link credentials, or accepting the
first non-demo API/import sample or fresh provider outdoor value, permanently latches
the current database into real-data mode. The transition removes persisted mock/replay telemetry,
synthetic outdoor boundaries, and existing alert events, stops mock generation
and active replay, and blocks all future demo ingestion.

## Choose the right scope

The rail follows ownership rather than feature categories:

- **Workspace:** Overview, Properties, and Alerts across everything you may see.
- **Property:** the Property workspace, Maintenance, and Electricity contracts.
- **Home:** indoor status, Sensors, and Set up for one Home.
- **Advanced:** API & MCP compatibility and integration contracts.

Selecting a Home also selects its parent Property. Property-owned work remains
available when a Property has no Home: use
`/properties/{propertyId}/maintenance` for its work plan and
`/properties/{propertyId}/electricity` for its electricity contract and price
source.

## Use the Home's Set up workspace

Select a Property and Home, then open **Set up**. It is split into four sections
so routine monitoring stays out of the configuration flow:

| Section | Purpose |
| --- | --- |
| **Overview** | readiness steps and a compact status summary |
| **Homes** | select a home, load the map deliberately, place/calibrate its footprint, and set plan orientation |
| **Connections** | discover and configure this Home's direct TP-Link or Home Assistant connections |
| **Weather** | select a home, discover its location/timezone, and review automatic weather-provider configuration |

The section is encoded in the canonical
`/properties/{propertyId}/homes/{homeId}/setup/{section}` route, so browser
Back/Forward and direct links retain both scope and context. Opening
**Connections** starts one best-effort LAN
discovery scan; a retry button and manual address fields remain available. If
TP-Link discovery fails or returns no hub, its manual host and credential fields
open automatically. The other credential and manual-network controls remain
progressive disclosures. Home Assistant and direct TP-Link connections belong
to the selected Home. Each Home can use independent credentials and endpoints;
direct TP-Link also supports multiple named connections within one Home.

Location setup is also discover-first. Search for a place, review its suggested
coordinate and IANA timezone, then apply it; or choose **Use this device's
location** and approve the browser permission prompt. Neither device location
nor the OpenStreetMap view is accessed until the corresponding explicit action.
Manual coordinates and timezone overrides remain under **Advanced**.

## Connect a TP-Link hub directly

To connect a real hub (the mock workflow is not a prerequisite):

1. Follow [direct TP-Link H100/H200 setup](tp-link-direct.md).
2. For local development, install
   `apps/api/python/requirements.txt`; the Docker image already includes it.
3. Select the Home that owns the hub, open **Set up > Connections**, choose the
   discovered H100/H200 (or open the manual connection fields), and enter the
   same account used by the Tapo app.
4. Open **Sensors**, choose **Add sensor**, and select a discovered T310/T315.
   Name it, choose its floor and room, and place it on the plan. The binding is
   stored in SQLite and begins ingesting without another restart.
5. If this database is in demo mode, saving the hub credentials automatically
   and permanently disables and purges demo telemetry. No environment change or
   restart is needed.

Home Assistant is not required for this path.

## Connect Home Assistant

To connect a real Home Assistant instance (the mock workflow is not a
prerequisite):

1. Follow [TP-Link H100/H200 and Home Assistant setup](home-assistant.md).
2. Copy `config/home-assistant.entities.example.json` to the untracked
   `config/home-assistant.entities.json` and replace all entity IDs.
3. Select the Home served by that Home Assistant instance, open
   **Set up > Connections**, choose the discovered instance (or open the manual
   connection fields), and paste a long-lived access token.
4. If this database is in demo mode, saving the Home Assistant credentials
   automatically and permanently disables and purges demo telemetry. No
   environment change is needed.
5. Restart only when changing environment-based entity maps or overrides.

Keep demonstrations in a separate database or deployment. The real-data latch
is intentionally one-way and `MOCK_ENABLED=true` cannot re-enable mock data in
an installation that has accepted real telemetry.

## Import existing measurement history

Open **Sensors** and choose **Import history**. The guided flow accepts modern
Excel workbooks (`.xlsx`), CSV, and TSV files up to 25 MB. It reads the file in
the browser, guesses the header, date, sensor, and measurement columns, and lets
you correct every match before saving anything. An example CSV is available on
the first step.

Files can use either of these familiar layouts:

| One column per measurement | One measurement per row |
| --- | --- |
| `Date, Sensor, Temperature, Humidity` | `Date, Sensor, Measurement, Value, Unit` |

Sensor values can be stable sensor IDs or unique sensor names. Dates with an
explicit offset are preserved; dates without one use the selected Home's time
zone. Celsius, Fahrenheit, and kelvin temperature columns can be converted to
the registry's canonical Celsius unit. Decimal commas and common Finnish or
ISO-style dates are supported.

The check step lists invalid rows before import and imports only the valid
measurements you approve. Repeating an import is safe: an existing measurement
for the same sensor, metric, and timestamp is skipped even if it originally
came from another source. Historical imports do not emit live measurement
events, evaluate alert rules, or deliver webhooks. Archived sensors can receive
history without being restored.

Imported history is real telemetry. The first accepted import permanently
switches that database out of demo mode and removes bundled mock/replay data, as
described in the first-run workflow above. If `INGEST_API_KEY` protects the
ingestion routes, the same reverse-proxy/API-key policy must permit the browser
request to `/api/v2/measurements/import`.

## Configure outdoor weather

No weather API key or environment variable is required.

1. Open **Set up > Weather** and select a home.
2. Search for a place and review the suggested coordinate/timezone, or
   explicitly choose **Use this device's location**. Apply the suggestion only
   after confirming it represents the home. Use **Advanced** only when manual
   coordinate or timezone correction is necessary.
3. If the home already has a precise placement from **Set up > Homes**, it can
   be reused as the weather reference. Set the true-north bearing of the top
   floor-plan edge there when it is known; leave it unknown rather than guessing.
4. Open the Home-scoped **Outdoor** page for current conditions, warning status,
   and the 48-hour forecast. Forecast navigation uses four 12-hour windows and
   displays timestamps in that home's saved IANA timezone.

Automatic routing uses FMI observations, forecasts, and official warnings for
Finnish homes, and Open-Meteo modelled current conditions/hourly forecasts for
other homes. Provider and attribution remain visible. Outside FMI's covered
warning path, an empty warning list is not presented as proof that no warning
exists.

Each home stores its own location and timezone, so homes in different parts of
the world can coexist. The background service refreshes located homes with
bounded concurrency, jitter, and per-home failure backoff. Persisting the first
fresh provider current-temperature value is a real-system connection and
therefore permanently switches this database out of demo mode. Use a separate
database if you only want to preview weather alongside mock indoor conditions.

Place/timezone discovery and provider requests are made by the API through
Open-Meteo or FMI. The map is a direct browser connection to OpenStreetMap and
is not loaded until requested; browser geolocation likewise starts only from
the explicit device-location action. Read
[Outdoor weather and home location](weather.md) before use for provider
semantics, service limits, attribution, partial/stale/coverage state, and the
privacy implications of search text, coordinates, browser permission, and map
tiles.

## Configuration reference

The guided setup stores integration credentials in a server-side, write-only
secrets file. Environment variables remain available as advanced overrides and
take precedence after restart.

| Variable | Default/example | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | API listen port; Compose fixes the container port to 8787 |
| `API_HOST` | `127.0.0.1` | local API bind; Compose overrides this to its private container interface |
| `DATABASE_PATH` | `./data/climate-twin.sqlite` | SQLite file; Compose uses `/app/data/climate-twin.sqlite` |
| `INTEGRATION_SECRETS_FILE` | next to `DATABASE_PATH` | protected JSON file for credentials saved through the setup page; Compose uses `/app/data/integration-secrets.json` |
| `MOCK_ENABLED` | `false` | opt in to sample inventory and synthetic telemetry before a database's first start |
| `MOCK_INTERVAL_MS` | `2000` | synthetic event interval |
| `RETENTION_DAYS` | `0` | SQLite hot-copy retention; `0` keeps all local rows, or use at least `30` with Timescale enabled |
| `INGEST_API_KEY` | empty | optional secret for external ingestion routes |
| `HA_URL` | `http://homeassistant.local:8123` | Home Assistant base URL |
| `HA_TOKEN` | empty | private Home Assistant access token |
| `HA_ENTITY_MAP_FILE` | `./config/home-assistant.entities.json` | mapping file path |
| `TP_LINK_HOST` | empty | reserved LAN address or hostname of an H100/H200 hub |
| `TP_LINK_USERNAME` | empty | TP-Link account email used for local hub authentication |
| `TP_LINK_PASSWORD` | empty | TP-Link account password used for local hub authentication |
| `TP_LINK_DEVICE_MAP_FILE` | `./config/tp-link.devices.json` | optional legacy child-device-to-sensor bootstrap map; in-app mappings are stored in SQLite |
| `TP_LINK_POLL_INTERVAL_MS` | `10000` | direct local hub polling interval; minimum effective value is one second |
| `TP_LINK_PYTHON` | `python` on Windows, `python3` elsewhere | Python 3.11+ executable for the direct bridge |
| `ALERT_WEBHOOK_URL` | empty | optional outbound alert destination |
| `ALERT_WEBHOOK_BEARER_TOKEN` | empty | optional destination bearer token |
| `CORS_ORIGIN` | empty | exact trusted browser origin for a split-origin or non-loopback deployment |
| `LOCAL_AUTH_BOOTSTRAP_SECRET` | empty | optional high-entropy secret for an explicitly authorized first-owner setup outside loopback |
| `LOCAL_AUTH_PROXY_SECRET` | empty | advanced non-Compose shared secret authenticating one immediate reverse proxy; minimum 32 bytes |
| `LOCAL_AUTH_PROXY_SECRET_FILE` | empty | advanced alternative path containing the proxy secret; creates a random credential when the file does not exist |
| `VITE_API_BASE_URL` | empty | compile-time web API base; empty uses same-origin `/api/v1` and `/api/v2` |
| `VITE_SPATIAL_MAX_SAMPLE_AGE_MS` | `900000` | live sample age limit for 2D/3D clouds and gradient vectors |
| `VITE_SPATIAL_REPLAY_MAX_SAMPLE_AGE_MS` | `5400000` | wider replay age limit for downsampled stored history |
| `APP_PORT` | `8080` | host port for the Compose web service |
| `BIND_ADDRESS` | `127.0.0.1` | host address for Compose; use a deliberate LAN address only after access controls are reviewed |

Empty optional integration values disable that integration. Use the documented
boolean/numeric forms and confirm the effective integration status after every
configuration change; unknown values may fall back to safe defaults.

### Split-origin deployments

The supplied loopback Compose setup is same-origin and needs no CORS override.
If the web app is hosted at a different origin, build it with an absolute
`VITE_API_BASE_URL` and set `CORS_ORIGIN` to the exact trusted origin. Also set
`CORS_ORIGIN` when a same-origin proxy is deliberately exposed through a LAN IP
or custom hostname; the API does not trust an arbitrary `Host` header as proof
of browser origin because that would permit DNS-rebinding requests. Do not use
`*` with credentials or on a network-exposed deployment.

### Language, timezone, and units

Store samples in their registry-defined canonical units and UTC. Each Home's
IANA timezone and the user locale control display, so one installation can
render homes on different local calendars correctly. Place/device discovery
suggests a timezone; a manual valid-IANA override remains available.
Temperature can be displayed as °C or
°F without changing stored values; other metrics retain their canonical unit
(for example CO2 remains ppm). Sensor/room names, measurement labels, alert
text, thresholds, and building parameters are data, not environment constants.
Do not duplicate a sensor to change display units.

## Backup and restore

Create a complete, online Compose backup without publishing PostgreSQL:

```powershell
docker compose --profile maintenance run --rm stuga-backup
```

The maintenance image snapshots the core and spatial SQLite databases safely
while WAL is active, copies assets and the protected integration file, creates a
full TimescaleDB custom-format dump, and verifies a checksummed manifest. It
writes under `./backups`; set `STUGA_BACKUP_DIRECTORY` to use another protected
host directory. Verify an existing set with:

```powershell
docker compose --profile maintenance run --rm --no-deps stuga-backup `
  --verify /app/backups/<backup-directory>
```

Every complete set contains credentials and household history. Keep it encrypted,
copy it off-host, and periodically restore it into an isolated stack with alerts
and outbound integrations disabled. A copied SQLite main file alone is not a
backup while WAL writes may be active, and a SQLite-only copy omits the durable
Timescale archive. See [Backend storage and operations](backend-storage.md) for
the full restore sequence and ownership checks.

## Uninstall

Stop the stack with `docker compose down`. Preserve or export the named volume
if history is needed. Delete `.env`, revoke its Home Assistant token, and rotate
TP-Link credentials if the corresponding bridge is retired or exposed.
