# Stugby federation

Stugby connects independently administered Stuga installations around a shared
property without turning them into one account, database, or control system.
Each Stuga remains authoritative for its own Homes. A coordinator maintains the
participant roster, distributes signed events, and owns the common-property
aggregate; it does not become the owner of participant Homes.

This supports both common ownership patterns:

- several households on one property, each running and administering its own
  Stuga; and
- one owner with several Homes in one Stuga, where each Home can have a separate
  grant and audience.

Stugby is available but inert on every Stuga and is a read-only federation data
plane. Merely running Stuga, creating a Stugby, or joining one shares no Home
data. Local owners and administrators configure explicit grants in
**Workspace > Stugbys**.

## Hard boundary

The protocol can share only these versioned datasets:

| Dataset | Contents | Important controls |
| --- | --- | --- |
| `home.directory.v1` | Published Home name and timezone | Local Home ID is optional |
| `home.location.v1` | Precise coordinates, label, orientation, and map placement | Separate explicit switch and warning |
| `home.structure.v1` | Floors, rooms, walls, and plan elements | Local IDs are optional; bindings are stripped |
| `home.floorplan.v1` | Content-addressed PNG/JPEG/WebP plan images | 10 MiB limit, digest and file-signature checks |
| `home.sensor-catalog.v1` | Sensor names, positions, metrics, and optional local IDs | No provider, entity, or connection binding |
| `home.telemetry.v1` | Selected raw samples | Sensor/metric selection, history start, live switch, rate cap, cache and retention |
| `home.notes.v1` | Selected Home notes | Explicit grant required |
| `home.observations.v1` | Selected observations and their placement | Explicit grant required |

The shared-property aggregate can contain common areas, equipment, notes,
maintenance items, and an optional common location. It is separate from every
participant's local Property tables.

The following are outside the protocol and cannot be enabled by a grant:

- integration configuration, discovery state, endpoints, connection IDs, or
  provider/entity bindings;
- passwords, API keys, tokens, cookies, sessions, credentials, private keys, or
  other secrets;
- local account identities, account records, or account/session management;
- remote control, device commands, actuation, automations, scripts, callbacks,
  or webhooks.

These exclusions are recursive checks backed by exact field allowlists for
every protocol object in the shared protocol package and are enforced again at
event admission. Projection code also selects only documented structural
fields before signing. They are not merely hidden in the web interface. Node
public keys and one-time invitation material are
protocol admission mechanisms, not shared account or integration data. The
coordinator stores only an invitation-secret hash; the plaintext join secret is
shown once.

## Topology and authority

Every Stugby has one coordinator node and any number of participant nodes. The
coordinator is an event relay and the authority for membership and the common
property. A Home dataset event always retains the originating Stuga node as its
authority; the coordinator cannot rewrite or impersonate it.

Events are signed but not end-to-end encrypted. The coordinator necessarily
processes and durably queues the plaintext events it relays, even when only a
different participant is named in the grant audience. Operate the coordinator
as a trusted member of the Stugby and do not use an untrusted third-party relay.

Roles are:

- **steward**: coordinator membership and common-property authority;
- **property-manager**: may edit common-property records through the
  coordinator;
- **participant**: may receive grants and publish grants for its own Homes; and
- **viewer**: read-only participant.

Local Stuga owner/administrator authorization is required for every browser API
operation. Stugby roles govern node-to-node common-property writes; they do not
create or manage local Stuga accounts.

## Consent and grants

Joining shares no Home data. The authoritative Stuga must create a grant for one
local Home and choose:

1. all active members or an explicit node list;
2. each enabled dataset;
3. whether correlatable local IDs are included for that dataset;
4. whether recipients may durably cache replicas and for how many days; and
5. for telemetry, the sensor IDs, metric IDs, history boundary, live switch,
   and maximum samples per hour.

Home, floor, room, wall, plan-element, sensor, note, and observation publication
IDs are stable random federation IDs rather than local database IDs. The local
ID is added only when the dataset grant enables it.

A grant has a monotonically increasing revision and epoch. Updating a grant
first publishes a tombstone for the old epoch to its old audience, then creates
a new epoch and sends fresh snapshots to the new audience. Revocation publishes
only the tombstone. Recipients purge the matching structured replicas and raw
telemetry, then return a deletion receipt. A coordinator will not deactivate a
member while an active grant involves it or a required deletion receipt is
outstanding. Revocation is a best-effort distributed deletion mechanism, not a
claim that a malicious recipient cannot have copied previously received data.

An expired grant no longer authorizes new events. While the authority is
running, expiration automatically advances the grant epoch and sends the same
purge tombstone as an explicit revocation. Old unsent dataset events are
discarded before any restriction, revocation, or expiry tombstone is queued, so
data cannot be published after consent is withdrawn. Retention maintenance
deletes expired cached resources. A dataset with replica caching disabled or
retention set to zero is validated in transit but is not written to the durable
remote projection.

## Protocol and transport

Protocol v1 uses `application/vnd.stugby.v1+json` over HTTPS. Plain HTTP is
accepted only for loopback development. Each node has a persistent Ed25519 key
pair and UUID. Requests include the node ID, timestamp, unique request ID,
protocol version, and a signature over the exact method, path, and body digest.
The coordinator verifies active membership, a five-minute clock window, and
request-ID replay protection.

Events have an authority, stream, monotonic sequence, stable event ID, schema,
resource revision, grant epoch, SHA-256 payload digest, and Ed25519 signature.
Receivers validate the complete envelope and payload before applying it,
deduplicate event IDs, reject non-monotonic events, and apply revisions
idempotently. Participant events are accepted only for protocol grants and the
approved read-only Home datasets. Durable per-recipient cursor logs and a
retrying outbox provide at-least-once delivery. The receiver's next signed
cursor request acknowledges prior pages, allowing the coordinator to prune
their event bodies. Deletion acknowledgements are durable and retried after a
failed HTTP response.

Stugby deliberately uses SSE instead of WebSockets:

- the authenticated SSE stream contains only `available` cursor notifications;
- the receiver pulls durable event pages over ordinary signed HTTPS;
- reconnecting with the stored cursor cannot lose state;
- a periodic HTTPS pull remains active as the fallback if a proxy or network
  drops SSE; and
- no bidirectional command channel exists.

Floor-plan images use separate content-addressed HTTPS transfer. The coordinator
authorizes downloads against the recipient, grant ID, and epoch. Images are
accepted only when the declared MIME type, magic bytes, size, and SHA-256 digest
agree. Replica files are reference-counted and deleted when their grant is
purged and no other grant uses the same digest. Unreferenced uploads are capped
at 256 MiB and garbage-collected after 24 hours; this staging allowance exists
only to let an image arrive immediately before its signed event.

## Lifecycle

1. Give the coordinator one externally reachable HTTPS origin. With the
   bundled Cloudflare deployment, run `npm run cloudflare:provision-coordinator`
   and start `cloudflared`. Participants remain outbound-only and need no
   Tunnel or inbound port.
2. Verify the coordinator boundary with
   `npm run cloudflare:verify-coordinator`, then create the Stugby. Its origin
   is server-owned and cannot be supplied by the browser.
3. Create a time-limited, one-use invitation with the intended role. Transfer
   the invitation link through a trusted channel.
4. On the joining Stuga, paste the invitation link into **Workspace > Stugbys**.
   The joining node proves possession of its private key and receives the roster
   and common-property snapshot. No Home data is shared.
5. On each authoritative Stuga, create separate Home grants and review precise
   location, local-ID, telemetry, cache, retention, and audience choices.
6. Use the shared-property editor for common grounds, equipment, notes, and
   maintenance. Revision conflicts require reloading rather than overwriting a
   concurrent change.
7. Before removing a participant, revoke or narrow every grant involving it,
   let the node synchronize, verify deletion receipts, and then suspend, mark
   left, or revoke the membership. The coordinator queues one final signed
   membership event; after pulling it, the departing node removes its remote
   Home, telemetry, shared-property, and replica-asset projections. A suspended
   node keeps a read-only event pull so it can receive a later reactivation and
   fresh snapshots, but it cannot publish or edit shared property.

Use **Republish** after correcting a failed or incomplete snapshot. The manual
**Sync now** action flushes the outbox and pulls all available cursor pages;
normal operation uses SSE wake-ups and the configured safety interval.

## Configuration and deployment

| Variable | Default | Meaning |
| --- | --- | --- |
| `STUGBY_IDENTITY_FILE` | beside the core SQLite database | Persistent node ID and Ed25519 key pair |
| `STUGBY_NODE_NAME` | `Stuga` | Human-readable node name shown to participants |
| `STUGBY_PUBLIC_ORIGIN` | empty | Server-owned HTTPS coordinator origin; required only to create a Stugby and written automatically by the coordinator provisioner |
| `STUGBY_SYNC_INTERVAL_MS` | `15000` | Durable pull/outbox safety interval, 2–300 seconds |

The Compose setup stores `stugby-identity.json` and federation SQLite rows in
the existing `/app/data` volume. Keep the identity file owner-readable and back
it up with the SQLite database and Stugby assets. Restoring SQLite without the
matching node identity prevents the node from proving its existing membership;
restoring an old identity plus an old database may replay already-seen requests,
which peers reject safely.

Every externally reachable coordinator URL must use HTTPS. Configure reverse
proxies to preserve the complete request path, pass request bodies unchanged,
disable buffering for `text/event-stream`, and allow long-lived SSE reads. Do
not expose Stugby as a substitute for local authentication. The bundled Nginx
configuration already disables API buffering and permits long SSE reads.

For Cloudflare, use `provision-coordinator`; it creates the narrowly scoped
`/api/v1/stugby-protocol/*` path application and verifies that the owner/admin
`/api/v1/stugbys*` routes remain behind Access. The machine path remains
protected by active membership, Ed25519 signatures, clock bounds, replay
prevention, bounded bodies, and origin-side rate limits; it does not accept
browser sessions or integration credentials. Cloudflare Access Bypass itself
does not authenticate or log the machine request, so never broaden that path.

## Failure behavior and operations

Network failures leave local Homes fully operational. The sender retains events
in its outbox with bounded exponential retry, and receivers keep their last
durable cursor. Remote projections are marked stale after synchronization
errors and return to current after a successful sync. The coordinator does not
write remote data into local canonical Home, sensor, Property, integration, or
account tables; remote telemetry has a separate table and query path.

Audit rows cover creation, invitations, membership, grants, shared-property
changes, expiry, and deletion acknowledgements. Monitor repeated sync errors,
stale resources, a growing outbox, staged-asset quota errors, and pending
deletion receipts. Database and asset
backups are sensitive because granted locations, floor plans, notes, and raw
telemetry may reveal occupancy and building details.

The local owner/admin endpoints and machine endpoints are described in the
generated OpenAPI document at `/api/v1/openapi.json`. The reusable wire types,
validators, canonical JSON, and signing values live in
`packages/stugby-protocol`.
