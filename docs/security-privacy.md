# Security, privacy, and retention

Stuga is local-first, not automatically trusted-by-LAN. Environmental
traces such as temperature, humidity, and CO2 can reveal occupancy,
shower/sleep patterns, ventilation habits, room use, incidents, and building
weaknesses. Floor plans and manually recorded leaks add more sensitive household
context. A precise Home latitude/longitude is also sensitive: it can identify
the Property and is sent to the selected weather provider when Home weather is
requested.

## Default security boundary

The default Docker deployment is intended for a trusted host on a private home
network. It does not make a safe public internet service by itself. Keep ports
behind the host firewall; for remote use, add an authenticated VPN or a mature
reverse proxy with TLS and access control.

The optional [Cloudflare Tunnel and Access deployment](cloudflare-access.md)
adds an outer exact-email gate without replacing local authorization. Its
runtime group token and Tunnel token are deployment secrets. At least one
verified static Cloudflare operator must remain independent of the local owner
login so first-owner setup, invitation cleanup, or a private local email cannot
remove the recovery identity.

The local Node API has built-in owner, administrator, and Guest accounts in one
workspace. Browser sign-in creates a server-managed HttpOnly session; browser
JavaScript cannot read its credential. The API resolves the account role and
resource grants on every request. Guests are always read-only, receive explicit
Property, Home, and/or area grants, and see ungranted identifiers as not found.
Client-side hidden controls are a usability measure, not authorization. Guest
audit-history endpoints fail closed because a current grant cannot establish
the visibility of every historical snapshot. See [Properties and Guest
access](property-management.md).

The optional `INGEST_API_KEY` is a separate machine-ingestion credential. It
does not create a browser session or grant interactive account access.

## Secrets

- The guided setup sends Home Assistant, TP-Link, and Telegram credentials to
  the local API and stores them outside SQLite in
  `INTEGRATION_SECRETS_FILE`. Saved credentials are never returned. The file is
  written atomically with owner-only mode where the platform supports it, but
  it is not application-level encrypted. Protect the host account, disk,
  backups, and Docker data volume.
- SQLite contains only typed integration references and safe lifecycle/display
  metadata. It never contains Home Assistant tokens, TP-Link account names or
  passwords, Telegram bot tokens or numeric chat IDs, Apple Notes token hashes,
  webhook bearers, or complete webhook URLs. Home Assistant endpoint query
  strings and fragments are stripped from its SQLite metadata copy.
- Use strong, unique owner and administrator passwords. Sign out or revoke
  sessions after a device or account is lost. Protect the SQLite database and
  backups because they contain account records, grants, password verifiers, and
  session state alongside household data.
- A revocable, Home-scoped Apple Notes Shortcut bearer is returned exactly
  once at grant creation. Only its SHA-256 hash is retained in the integration
  secrets file, so Stuga cannot reveal the original token later. Its operator
  device label is informational and does not bind or authenticate a device.
- Home Assistant and direct TP-Link credentials and connections belong to one
  Home. The **Set up** Home selector controls that persisted ownership; API
  authorization still enforces it server-side. Telegram credentials belong to
  the Workspace, and electricity contract/source configuration belongs to a
  Property. Apple Notes Shortcut bearers are restricted to one Home and the two
  bridge routes.
- Environment variables remain advanced overrides. Put `HA_TOKEN`,
  `TP_LINK_USERNAME`, `TP_LINK_PASSWORD`, `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_CHAT_ID`, `INGEST_API_KEY`, `ALERT_WEBHOOK_BEARER_TOKEN`,
  `ALERT_WEBHOOK_SIGNING_SECRET`, and credential-bearing
  `ALERT_WEBHOOK_DESTINATIONS_JSON` only in the private `.env`, the protected
  integration secrets file, or a container/orchestrator secret store.
  Environment webhook values take precedence and are mirrored into the
  protected secrets file for complete-backup recovery when that file is
  writable; include the deployment secret separately if mirroring is blocked.
- Compose authenticates the immediate Nginx proxy with a random credential in
  the dedicated `climate-twin-runtime` volume. The proxy mounts that volume
  read-only, overwrites client-supplied forwarding headers, and never sends the
  credential to browser code. Custom reverse proxies must use their own
  `LOCAL_AUTH_PROXY_SECRET` or `LOCAL_AUTH_PROXY_SECRET_FILE` value.
- Never put a token in entity maps, floor-plan files, browser environment
  variables prefixed `VITE_`, URLs, source control, screenshots, or support
  bundles.
- Use a dedicated non-admin Home Assistant user where possible. Delete its token
  when the integration is removed and rotate it after suspected exposure.
- Prefer a dedicated least-privilege TP-Link account if the platform supports
  the required hub access. Rotate its password after suspected exposure.
- Give outbound webhook credentials access only to the receiving endpoint.
- A Telegram bot token grants control of that bot. Use a dedicated bot, pair a
  private numeric chat through the guided flow, and rotate the token through
  BotFather after disclosure. Telegram bot chats are cloud chats, not
  end-to-end encrypted Secret Chats. Alert messages include Home, sensor, and
  rule names, so do not put sensitive personal facts in those names.
- Apple Notes Shortcut grants are shown once, restricted to one Home, and
  individually revocable. Store a bearer only inside its Shortcut, never in a
  note. iCloud Shortcuts sync may copy that Shortcut and bearer to other
  devices, although Personal Automations remain device-specific. Treat every
  receiving device as authorized, or disable Shortcuts sync/use a non-synced
  Shortcut. Revoke the grant if any recipient device is untrusted. Stuga does
  not request an Apple Account or iCloud credential.
- Prevent secrets from being emitted in normal or debug logs; redact headers and
  WebSocket authentication messages.

The FMI and Open-Meteo endpoints used by the weather/location adapters do not
require an API key. Do not add a weather credential to browser code or expose
unrelated commercial-service credentials. Home coordinates and place-search
text are data, not credentials, but logs and support bundles should still redact
or coarsen them.
Outdoor-boundary rows use an opaque location digest, are deleted when Home
coordinates change or are cleared, and follow normal sample retention. The
digest is pseudonymisation, not encryption; protect the SQLite database and its
backups as location-sensitive data.

## Security audit trail

Owners and Administrators can inspect the newest append-only security events at
`GET /api/v1/security/audit-events?limit=100&offset=0`. Guests and ordinary
Members cannot read this Workspace-wide ledger. It records successful owner
setup, invitation acceptance, login/logout, membership invitation/grant/removal
changes, integration credential configuration/rotation/revocation, and Apple
Notes grant issue/revocation. Rejected credential logins are recorded with a
bounded reason code and no actor identity.

Each event contains a random event ID, event type, outcome, actor user ID and
role when authenticated, typed target, bounded scalar details, and API-clock
timestamp. Account and membership targets use their normalized email; integration
targets use non-secret local IDs. The ledger deliberately excludes passwords,
session/CSRF/invitation tokens, integration tokens, integration account names,
URLs, hosts, chat IDs, request headers, and network addresses. It is stored in
core SQLite and therefore follows that database's backup and retention boundary;
there is no mutation or deletion API for individual audit rows.

`apps/api/tests/security-audit.test.ts` performs file-backed credential drills:
it configures, rotates, and revokes Home Assistant and TP-Link credentials,
issues and revokes an Apple Notes grant, verifies superseded/revoked bytes are
absent from the protected secrets file, restarts the API, and verifies only
secret-free lifecycle evidence remains in SQLite.

`.dockerignore` excludes local `.env` files and runtime data from image build
context. That is defense in depth, not a substitute for checking commits and
built image layers.

## Network controls

Recommended flows are narrowly scoped:

| Source | Destination | Purpose |
| --- | --- | --- |
| Stuga API | Home Assistant `8123/tcp` | authenticated WebSocket state events |
| Stuga API | H100/H200 local address | authenticated direct local polling |
| User browser | Stuga web/API port | authenticated UI, `/api/v1`, and `/api/v2` |
| User browser | `tile.openstreetmap.org:443` | attributed location-picker tiles only |
| Stuga API | `opendata.fmi.fi:443` | WFS observation and point-forecast requests |
| Stuga API | `alerts.fmi.fi:443` | official CAP warning feed |
| Stuga API | `api.open-meteo.com:443` | worldwide weather and coordinate-to-timezone defaults |
| Stuga API | `geocoding-api.open-meteo.com:443` | user-initiated place search |
| Stuga API | configured webhook hosts | alert delivery only |
| Stuga API | `api.telegram.org:443` | bot validation, private-chat discovery, test, and opted-in alert delivery |
| User iPhone/iPad | authenticated Stuga bridge URL | user-run maintenance capture and generated Notes snapshots |
| Home Assistant | H200 local address | official TP-Link local polling |

Block unsolicited inbound traffic to the API from guest/IoT networks. Do not
expose H200 or Home Assistant device ports to the internet. Webhook destinations
are fixed administrator configuration, checked against an exact host allowlist,
and never accepted from an alert request. Set `ALERT_WEBHOOK_ALLOWED_HOSTS`
explicitly in a more hostile deployment so a mistyped or injected configuration
fails startup rather than widening outbound access.

The Apple Notes bearer is Home- and route-scoped and is separate from browser
account sessions. Its operator device label is not a device binding. Changing
`BIND_ADDRESS` from loopback exposes the web service and API to every client
allowed by the host network. Prefer TLS with a VPN or reverse proxy/firewall
policy that exposes only the snapshot and capture routes to the phone and keeps
**Set up** and grant administration private.

The production CSP permits map images only from the exact HTTPS
`tile.openstreetmap.org` origin; FMI and Open-Meteo are server-to-server and are
not allowed in browser `connect-src`. The map is not loaded until an explicit
user action. OSM tile requests then reveal the browser IP address, the Climate
Twin origin in the policy-required `Referer`, and tile coordinates that identify
the viewed area. Use manual/API-entered coordinates and do not load the map when
that third-party request is unacceptable, or replace the tile layer with an
approved self-hosted/private service. Keep visible OSM attribution and follow
its tile usage and privacy policies.

**Use this device's location** is also explicit. Only that click invokes the
browser geolocation permission prompt; approval sends the selected coordinates
to the local API for persistence and server-side timezone/weather lookup.
Stuga does not retain device movement history. A place search sends its
text and UI language to the local API and Open-Meteo geocoding, but saves no
result until the user reviews and applies one. Manual fields remain available
under **Advanced** when neither disclosure is acceptable.

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
- Webhooks include a stable destination-scoped idempotency key. Configure a
  unique signing secret per receiver when body integrity/authenticity is needed;
  verify `X-Stuga-Signature` against the raw body in constant time and enforce
  an `X-Stuga-Timestamp` replay window. HMAC alone does not prevent replay, and
  bearer tokens alone do not provide body-level integrity.
- MCP is a privileged local automation interface. Run the stdio process only for
  a trusted MCP host, expose the minimum tools, validate every argument, and
  require confirmation for destructive or notification-producing actions.

## Data minimisation

Collect the least data needed for the stated use case:

- Use room labels rather than occupant names.
- Store only the Home-location precision needed for useful weather. Prefer a
  town/area search and label over a street address. Search text is sent to
  Open-Meteo geocoding, while a later display-label edit is stored locally.
- Avoid putting medical, personal, or security-system facts in free-form notes.
- Telegram receives the Home and sensor labels and triggered rule for opted-in
  alerts. Avoid occupant names or sensitive facts in those labels. Generated
  Notes snapshots remain in the Apple account/folder selected by the user.
- Store only mapped Home Assistant entities or TP-Link children, not an entire
  device/event inventory.
- Keep raw high-frequency metric samples only for a justified window; retain
  aggregates longer if that meets the analytical purpose.
- Exclude token values, Home Assistant event context, IP addresses, and device
  account identifiers from telemetry unless specifically needed.
- Make exports explicit and show their time range, included Homes, and whether
  floor plans/manual observations are present.

DayOps and OpenWearable can make combined data substantially more identifying.
Default to sending alert/event summaries, not full environmental history or
floor plans. Keep identifiers pseudonymous and document the lawful/user-consent
basis before correlating environment and wearable data.

## Retention policy

The current implementation deliberately accepts only `RETENTION_DAYS=0`: raw
telemetry is retained in TimescaleDB and the SQLite safety copy is not yet
pruned. Positive values fail closed until every historical and degraded-mode
read is archive-aware. This matches an explicit keep-all policy, but operators
must still budget disk, protect backups, and periodically confirm that indefinite
retention remains justified. A future configurable policy must also define:

- which tables/artifacts it applies to;
- whether alert events, manual observations, forecasts, audit logs, exports, and
  backups have different periods;
- cleanup frequency and failure monitoring;
- how a user deletes a Home/sensor and its dependent data;
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
2. Revoke/rotate Home Assistant, ingestion, webhook, Telegram, and Apple Notes
   bridge credentials.
3. Preserve minimal logs needed to determine scope, without spreading secrets.
4. Inspect access, exports, MCP clients, and outbound deliveries.
5. Patch the cause, notify affected users where required, and restore from a
   known-good state.

## Privacy checklist before enabling external integrations

- [ ] The user can see exactly which entities and Homes are included.
- [ ] The destination and purpose are documented.
- [ ] The user understands that FMI or Open-Meteo receives the saved coordinate
      during weather requests, place-search text goes to Open-Meteo geocoding,
      and OSM receives browser tile requests only when the map is loaded.
- [ ] Device geolocation was explicitly requested and approved, or manual/place
      search was used instead; unnecessary browser permission has been revoked.
- [ ] Only the minimum event fields leave the host.
- [ ] Transport is authenticated and encrypted outside the loopback/LAN trust
      boundary.
- [ ] Retention/deletion behaviour at both ends is known.
- [ ] Mock/replay data cannot trigger a real escalation unintentionally.
- [ ] Revocation and failure behaviour have been tested.
