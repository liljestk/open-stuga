# Install and run Climate Twin

Climate Twin runs with mock sensors out of the box. Home Assistant is optional,
so the visualisation, history, alerts, and replay workflow can be evaluated
before the physical sensors arrive. Temperature, relative humidity, and CO2 are
built in; additional finite numeric scalar measurements can be registered later.

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

2. Leave `MOCK_ENABLED=true` for the first run. Do not put real tokens in
   `.env.example`; add them only to `.env`.
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

History is stored in the named `climate-twin-data` volume. `docker compose down
-v` deletes that volume and all retained readings; use it only when an explicit
reset is intended.

Compose binds the web port to loopback by default. To use the UI from another
device on the private LAN, set `BIND_ADDRESS` in `.env` to the host's specific
LAN address (preferred) or `0.0.0.0`, allow only the intended subnet in the host
firewall, and review the security guide first. The MVP has no general API login;
the same web port also exposes `/api/v1` and `/api/v2`.

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

## First-run mock workflow

The default seed creates one house, two floors, ten placed sensors, and registry
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

Mock data is synthetic and must never be mixed into an analysis as if it came
from a calibrated physical device. Keep the source/quality indicator visible in
exports and predictive experiments.

## Connect Home Assistant

After the mock workflow works:

1. Follow [TP-Link H200 and Home Assistant setup](home-assistant.md).
2. Copy `config/home-assistant.entities.example.json` to the untracked
   `config/home-assistant.entities.json` and replace all entity IDs.
3. Set `HA_URL` and `HA_TOKEN` in `.env`.
4. Set `MOCK_ENABLED=false` when physical-only operation is desired.
5. Restart: `docker compose up -d` or restart the local API.

It is safe to keep mock mode available in a separate test deployment. Avoid
enabling test scenarios in the instance used for real alerts.

## Configure outdoor weather

No weather API key or environment variable is required. In **Integrations**,
select a house, choose its WGS84 point on the map (or enter latitude/longitude),
add an optional non-address label, and save. The page then loads FMI
observations, point forecasts, and official warnings for that location.

The map is a direct browser connection to OpenStreetMap; the FMI requests are
made by the API. Read [FMI weather and house location](weather.md) before use for
station/forecast semantics, service limits, attribution, partial/stale failure
state, and the privacy implications of storing coordinates and loading tiles.

## Configuration reference

Configuration is environment-based so images do not contain site-specific
values.

| Variable | Default/example | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | API listen port; Compose fixes the container port to 8787 |
| `API_HOST` | `127.0.0.1` | local API bind; Compose overrides this to its private container interface |
| `DATABASE_PATH` | `./data/climate-twin.sqlite` | SQLite file; Compose uses `/app/data/climate-twin.sqlite` |
| `MOCK_ENABLED` | `true` | start synthetic telemetry |
| `MOCK_INTERVAL_MS` | `2000` | synthetic event interval |
| `RETENTION_DAYS` | `730` | raw measurement/readings history retention target |
| `INGEST_API_KEY` | empty | optional secret for external ingestion routes |
| `HA_URL` | `http://homeassistant.local:8123` | Home Assistant base URL |
| `HA_TOKEN` | empty | private Home Assistant access token |
| `HA_ENTITY_MAP_FILE` | `./config/home-assistant.entities.json` | mapping file path |
| `ALERT_WEBHOOK_URL` | empty | optional outbound alert destination |
| `ALERT_WEBHOOK_BEARER_TOKEN` | empty | optional destination bearer token |
| `CORS_ORIGIN` | empty | explicit browser origin for a split-origin deployment |
| `VITE_API_BASE_URL` | empty | compile-time web API base; empty uses same-origin `/api/v1` and `/api/v2` |
| `APP_PORT` | `8080` | host port for the Compose web service |
| `BIND_ADDRESS` | `127.0.0.1` | host address for Compose; use a deliberate LAN address only after access controls are reviewed |

Empty optional integration values disable that integration. Use the documented
boolean/numeric forms and confirm the effective integration status after every
configuration change; unknown values may fall back to safe defaults.

### Split-origin deployments

The supplied Compose setup is same-origin and needs no CORS. If the web app is
hosted at a different origin, build it with an absolute `VITE_API_BASE_URL` and
set `CORS_ORIGIN` to the exact trusted origin. Do not use `*` with credentials or
on a network-exposed deployment.

### Language, timezone, and units

Store samples in their registry-defined canonical units and UTC. The house
timezone and user locale control display. Temperature can be displayed as °C or
°F without changing stored values; other metrics retain their canonical unit
(for example CO2 remains ppm). Sensor/room names, measurement labels, alert
text, thresholds, and building parameters are data, not environment constants.
Do not duplicate a sensor to change display units.

## Backup and restore

For a quiet single-host installation:

1. Stop the API container to guarantee a consistent simple file copy.
2. Copy `climate-twin.sqlite` from the named volume to encrypted backup storage.
3. Start the API again.

For no-downtime production backups, use SQLite's online backup API/command with
the database running; do not copy only the main file while WAL writes are active.
Test restoration periodically into an isolated instance with alerts and outbound
webhooks disabled.

Floor-plan images and configuration must be included separately if they are not
embedded in the database. Never include `.env` or tokens in a broadly shared
backup.

## Uninstall

Stop the stack with `docker compose down`. Preserve or export the named volume
if history is needed. Delete `.env` and revoke its Home Assistant token when the
bridge is retired.
