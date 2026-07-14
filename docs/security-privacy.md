# Security, privacy, and retention

Climate Twin is local-first, not automatically trusted-by-LAN. Environmental
traces such as temperature, humidity, and CO2 can reveal occupancy,
shower/sleep patterns, ventilation habits, room use, incidents, and building
weaknesses. Floor plans and manually recorded leaks add more sensitive household
context. A precise house latitude/longitude is also sensitive: it can identify
the property and is sent to FMI when house weather is requested.

## Default security boundary

The default Docker deployment is intended for a trusted host on a private home
network. It does not make a safe public internet service by itself. Keep ports
behind the host firewall; for remote use, add an authenticated VPN or a mature
reverse proxy with TLS and access control.

Until application-level user authentication and authorization are implemented
and independently reviewed, assume anyone who can reach the read API can see all
houses, floor plans, readings, observations, forecasts, and alerts. The optional
ingestion API key protects ingestion routes only; it is not general UI/API
authentication.

## Secrets

- Put `HA_TOKEN`, `INGEST_API_KEY`, and `ALERT_WEBHOOK_BEARER_TOKEN` only in the
  private `.env` or a container/orchestrator secret store.
- Never put a token in entity maps, floor-plan files, browser environment
  variables prefixed `VITE_`, URLs, source control, screenshots, or support
  bundles.
- Use a dedicated non-admin Home Assistant user where possible. Delete its token
  when the integration is removed and rotate it after suspected exposure.
- Give outbound webhook credentials access only to the receiving endpoint.
- Prevent secrets from being emitted in normal or debug logs; redact headers and
  WebSocket authentication messages.

The FMI WFS and CAP endpoints used by the weather adapter do not require an API
key. Do not add a weather credential to browser code or expose unrelated FMI
commercial-service credentials. House coordinates are data, not credentials,
but logs and support bundles should still redact or coarsen them.

`.dockerignore` excludes local `.env` files and runtime data from image build
context. That is defense in depth, not a substitute for checking commits and
built image layers.

## Network controls

Recommended flows are narrowly scoped:

| Source | Destination | Purpose |
| --- | --- | --- |
| Climate Twin API | Home Assistant `8123/tcp` | authenticated WebSocket state events |
| User browser | Climate Twin web/API port | UI, `/api/v1`, and `/api/v2` |
| User browser | `tile.openstreetmap.org:443` | attributed location-picker tiles only |
| Climate Twin API | `opendata.fmi.fi:443` | WFS observation and point-forecast requests |
| Climate Twin API | `alerts.fmi.fi:443` | official CAP warning feed |
| Climate Twin API | configured webhook host | alert delivery only |
| Home Assistant | H200 local address | official TP-Link local polling |

Block unsolicited inbound traffic to the API from guest/IoT networks. Do not
expose H200 or Home Assistant device ports to the internet. Restrict outbound
webhook destinations in a more hostile deployment to reduce server-side request
forgery and data-exfiltration risk.

The production CSP permits map images only from the exact HTTPS
`tile.openstreetmap.org` origin; FMI is server-to-server and is not allowed in
browser `connect-src`. Browser geolocation stays disabled. OSM tile requests
nevertheless reveal the browser IP address, the Climate Twin origin in the
policy-required `Referer`, and tile coordinates that identify the viewed area.
Use API-entered coordinates and do not open the map-enabled page when that
third-party request is unacceptable, or replace the tile layer with an approved
self-hosted/private service. Keep visible OSM attribution and follow its tile
usage and privacy policies.

The Compose services run with `no-new-privileges`; the API uses a non-root user,
and only its data volume is writable. Keep Docker, Node.js, Nginx, Home Assistant,
and TP-Link firmware on supported security releases, testing upgrades before
production rollout.

## API and integration safety

- Version public routes under `/api/v1` and `/api/v2`; reject unknown
  sensor/metric IDs, mismatched canonical units, non-finite values, and invalid
  numeric ranges at the trust boundary.
- Compare API keys in constant time and return generic authentication errors.
- Apply body-size, rate, time-range, and result-size limits before accepting an
  internet-adjacent deployment.
- The current JSON/base64 asset endpoint limits decoded payloads to 10 MiB and
  allows only PNG, JPEG, WebP, glTF, and GLB. Add file-signature verification
  and image dimension/3D-complexity limits before treating uploads as hardened;
  never inject uploaded markup into the DOM.
- Treat GLTF/GLB and image decoders as untrusted parsers. Store uploads under
  generated IDs outside executable/static source directories.
- Do not accept arbitrary callback URLs on alert requests. Delivery targets are
  administrator configuration.
- Include stable event IDs for idempotency and sign webhook bodies in a future
  hardened integration; bearer tokens provide authorization but not body-level
  integrity or replay protection.
- MCP is a privileged local automation interface. Run the stdio process only for
  a trusted MCP host, expose the minimum tools, validate every argument, and
  require confirmation for destructive or notification-producing actions.

## Data minimisation

Collect the least data needed for the stated use case:

- Use room labels rather than occupant names.
- Store only the house-location precision needed for useful weather. Prefer a
  town/area label over a street address; the label is not sent as a geocoding
  query.
- Avoid putting medical, personal, or security-system facts in free-form notes.
- Store only mapped Home Assistant entities, not the whole event bus.
- Keep raw high-frequency metric samples only for a justified window; retain
  aggregates longer if that meets the analytical purpose.
- Exclude token values, Home Assistant event context, IP addresses, and device
  account identifiers from telemetry unless specifically needed.
- Make exports explicit and show their time range, included houses, and whether
  floor plans/manual observations are present.

DayOps and OpenWearable can make combined data substantially more identifying.
Default to sending alert/event summaries, not full environmental history or
floor plans. Keep identifiers pseudonymous and document the lawful/user-consent
basis before correlating environment and wearable data.

## Retention policy

`RETENTION_DAYS` controls the intended raw sample/readings window (730 days in the
example). A complete policy also defines:

- which tables/artifacts it applies to;
- whether alert events, manual observations, forecasts, audit logs, exports, and
  backups have different periods;
- cleanup frequency and failure monitoring;
- how a user deletes a house/sensor and its dependent data;
- how long backups retain already-deleted data.

Suggested starting points, to be adjusted to user need and local law:

| Data | Suggested treatment |
| --- | --- |
| Raw sensor samples | 30–730 days; choose the shortest useful window and budget per metric |
| Hour/day aggregates | longer if useful and sufficiently minimised |
| Forecasts | short-lived; reproducibility metadata may outlive values |
| Manual incidents/maintenance | explicit user-controlled lifecycle |
| Resolved alerts | bounded operational history |
| Debug logs | days, with no secrets or full event bodies |
| Backups | encrypted, rotating, and expiration-aligned |

Deletion should be visible and auditable without logging the deleted content.
SQLite file size does not immediately shrink after row deletion; secure media
disposal and encrypted storage matter more than assuming `VACUUM` guarantees
forensic erasure.

## Backup and incident response

Encrypt host disks and off-host backups. Restrict backup access because a backup
can contain floor plans plus behavioural history. Test restore with networking
and outbound alerts disabled.

If a token or dataset is exposed:

1. Isolate the service from the network.
2. Revoke/rotate Home Assistant, ingestion, and webhook credentials.
3. Preserve minimal logs needed to determine scope, without spreading secrets.
4. Inspect access, exports, MCP clients, and outbound deliveries.
5. Patch the cause, notify affected users where required, and restore from a
   known-good state.

## Privacy checklist before enabling external integrations

- [ ] The user can see exactly which entities and houses are included.
- [ ] The destination and purpose are documented.
- [ ] The user understands that FMI receives the saved coordinate during
      forecast requests and OSM receives browser tile requests when the map is
      opened.
- [ ] Only the minimum event fields leave the host.
- [ ] Transport is authenticated and encrypted outside the loopback/LAN trust
      boundary.
- [ ] Retention/deletion behaviour at both ends is known.
- [ ] Mock/replay data cannot trigger a real escalation unintentionally.
- [ ] Revocation and failure behaviour have been tested.
