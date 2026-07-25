# Stugby federation

Stugby connects independently administered Stuga installations around a shared
property without turning them into one account, database, or control system.
Each Stuga normally remains authoritative for its own Homes. A coordinator
maintains the participant roster, distributes signed events, and owns the
shared Property aggregate. One explicitly designated successor may also keep a
complete, sanitized recovery copy of a Home for a planned Server
decommissioning.

This supports both common ownership patterns:

- several households on one property, each running and administering its own
  Stuga; and
- one owner with several Homes in one Stuga, where each Home can have a separate
  grant and audience.

Stugby is available but inert on every Stuga. Merely running Stuga, creating a
Stugby, or joining one shares no Home data. A Client explicitly adopts the
Server Property while its other local Properties remain separate. Shared
Property editing is collaborative by default; shared Homes are read-only by
default and become editable only when their owner enables it. Local owners and
administrators configure this in **Workspace > Stugbys**.

## Create the secure coordinator

Open Stuga on the coordinator computer through its loopback URL, then go to
**Stugbys**:

- On a new local installation, choose **Set up secure sharing** before creating
  the Stugby.
- On an existing Cloudflare remote-UI installation, the same panel appears
  automatically because the machine protocol path still needs provisioning.

The panel collects the hostname, zone, Cloudflare recovery identity, and—when
Stuga has not registered one yet—one API token with **OAuth Client Write** for
the account. Stuga uses that token once to create a private OAuth client and
does not save it. Cloudflare consent supplies the temporary Access, Tunnel,
DNS, and optional Zone Read grant. A new installation also needs the separate
narrow runtime token used to synchronize the managed Access group; an existing
installation reuses it.

The API keeps the temporary grant in memory. Its operation marker contains no
Cloudflare provider token. The trusted host agent claims the grant once, calls
the idempotent provisioner, restarts only `api`, `web`, and `cloudflared`,
verifies public and protected paths, and revokes the temporary OAuth grant.
Failure stops public ingress and leaves the loopback URL available. The public
Stuga URL may show progress but cannot start or alter this operation.

## Hard boundary

The protocol can share only these versioned datasets:

| Dataset | Contents | Important controls |
| --- | --- | --- |
| `home.directory.v1` | Published Home name and timezone | Local Home ID is optional |
| `home.location.v1` | Precise coordinates, label, orientation, and map placement | Separate explicit switch and warning |
| `home.structure.v1` | Floors, rooms, walls, and plan elements | Local IDs are optional; bindings are stripped |
| `home.floorplan.v1` | Content-addressed PNG/JPEG/WebP plan images | 10 MiB limit, digest and file-signature checks |
| `home.sensor-catalog.v1` | Sensor names, models, tags, enabled state, positions, metrics, and optional local IDs | No provider, entity, or connection binding |
| `home.telemetry.v1` | Selected raw samples | Sensor/metric selection, history start, live switch, rate cap, cache and retention |
| `home.notes.v1` | Selected Home notes | Explicit grant required |
| `home.observations.v1` | Selected observations and their placement | Explicit grant required |
| `home.recovery.v1` | Sanitized inventory, operational records, full telemetry history, and Home assets | Only for one designated full-recovery successor; durable caching required |

The shared-property aggregate can contain common areas, equipment, notes,
maintenance items, and an optional common location. An adopted copy is
materialized in the normal Property workspace with Stugby ownership metadata;
unrelated local Properties stay separate.

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

Property changes are queued durably while a node is offline. The coordinator
applies non-conflicting field changes and is authoritative when both sides
change the same field; the Client retains a visible conflict record. Home
changes use the same durable command pattern only when the Home owner has
enabled synchronized edits. A temporary outage marks projections offline but
never changes ownership.

Editable shared Homes synchronize structural and manual inventory changes.
Integration setup, device discovery, provider/entity bindings, historical
provider imports, controls, and binary floor-plan authoring remain available
only on the authoritative Stuga.

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
   and maximum samples per hour; and
6. whether the Home remains read-only or accepts synchronized edits, plus
   whether one named Client receives a full recovery copy.

Read-only is the default Home policy. Full recovery is intended for a planned
change of Server, not routine offline use. It retains the complete Home
inventory, supported operational records, assets, and recorded history.
While that grant remains active, the designated recovery replica is not
age-pruned; its configured retention value does not discard older transfer
material before decommission.
Integration connections, provider/entity bindings, endpoints, credentials,
secrets, controls, automations, and account identities are stripped. The new
owner must configure integrations again.

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

Protocol v2 uses `application/vnd.stugby.v2+json` over HTTPS. Plain HTTP is
accepted only for loopback development. Each node has a persistent Ed25519 key
pair and UUID. Requests include the node ID, timestamp, unique request ID,
protocol version, and a signature over the exact method, path, and body digest.
The coordinator verifies active membership, a five-minute clock window, and
request-ID replay protection.

Events have an authority, stream, monotonic sequence, stable event ID, schema,
resource revision, grant epoch, SHA-256 payload digest, and Ed25519 signature.
Receivers validate the complete envelope and payload before applying it,
deduplicate event IDs, reject non-monotonic events, and apply revisions
idempotently. Participant events and Property/Home commands are accepted only
for active grants, roles, and edit policies. Durable per-recipient cursor logs
and retrying command/outbox queues provide at-least-once delivery. The
receiver's next signed
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

Floor-plan images and recovery assets use separate content-addressed HTTPS
transfer. The coordinator authorizes downloads against the recipient, grant
ID, and epoch. PNG, JPEG, WebP, glTF, and GLB assets are accepted only when the
declared MIME type, file signature/structure, size, and SHA-256 digest agree.
Replica files are reference-counted and deleted when their grant is
purged and no other grant uses the same digest. Unreferenced uploads are capped
at 256 MiB and garbage-collected after 24 hours; this staging allowance exists
only to let an image arrive immediately before its signed event.

## Lifecycle

1. Run `npm run setup` on the coordinator and choose **Create a shared Stugby
   for several homes**. Setup reuses an existing Stuga address when available,
   provisions the required secure connection, and verifies it automatically.
   Participants remain outbound-only and need no Tunnel or inbound port.
2. Create the Stugby after setup reports that the connection is ready. With a
   custom reverse proxy, the Owner/Admin form suggests the current secure
   address and verifies it automatically before saving.
3. Create a time-limited, one-use invitation with the intended role. Transfer
   the invitation link through a trusted channel.
4. On the joining Stuga, paste the invitation link into **Workspace > Stugbys**.
   The joining node proves possession of its private key and receives the roster
   and common-property snapshot. No Home data is shared.
5. On a Client, choose **Adopt Server Property**. It appears beside local
   Properties in Property management. Optionally use **Merge and delete
   source** to move every Home and Property item from a local Property into the
   adopted Property; this destructive action deletes the source Property.
   Moving a Home into or out of an adopted Property requires this reviewed
   migration flow rather than the ordinary Home selector.
6. On each authoritative Stuga, create separate Home grants and review the
   audience, datasets, retention, edit policy, and optional designated recovery
   successor.
7. Edit the shared Property in the normal Property workspace. Offline changes
   queue; same-field conflicts keep the Server value and are explained in the
   UI.
8. Before removing a participant, revoke or narrow every grant involving it,
   let the node synchronize, verify deletion receipts, and then suspend, mark
   left, or revoke the membership. The coordinator queues one final signed
   membership event; after pulling it, the departing node removes its remote
   Home, telemetry, shared-property, and replica-asset projections. A suspended
   node keeps a read-only event pull so it can receive a later reactivation and
   fresh snapshots, but it cannot publish or edit shared Property data.

Use **Permanent disconnect** only for an intentional departure or Server
decommission. It promotes the inherited Property to local, retains
Client-owned Homes, and promotes only complete recovery Homes for which this
Client is the designated successor. An internet outage never triggers this
transition.

Delete a closed Stugby from **Workspace > Stugbys > Advanced**. A participant
must first be left or revoked; a coordinator must first mark every other member
left or revoked. Every Home grant must also be revoked and all replica deletion
acknowledgements must have arrived. Deletion removes federation records and
cached federation assets from this Stuga; canonical local Home, Sensor, and
telemetry data is unchanged.

Use **Republish** after correcting a failed or incomplete snapshot. The manual
**Sync now** action flushes the outbox and pulls all available cursor pages;
normal operation uses SSE wake-ups and the configured safety interval.

## Configuration and deployment

| Variable | Default | Meaning |
| --- | --- | --- |
| `STUGBY_IDENTITY_FILE` | beside the core SQLite database | Persistent node ID and Ed25519 key pair |
| `STUGBY_NODE_NAME` | `Stuga` | Human-readable node name shown to participants |
| `STUGBY_PUBLIC_ORIGIN` | empty | Optional explicit server-owned HTTPS coordinator origin; setup suggests a valid browser/edge origin and the coordinator provisioner writes it automatically |
| `STUGBY_SYNC_INTERVAL_MS` | `15000` | Durable pull/outbox safety interval, 2–300 seconds |

An explicit `STUGBY_PUBLIC_ORIGIN` is authoritative. Otherwise Stuga suggests
a valid HTTPS `CORS_ORIGIN`, Cloudflare public origin, or current browser
origin. For a custom reverse proxy, the Owner/Admin creation form checks and
persists that suggestion in the core SQLite database without a restart.
When Cloudflare is configured for the human UI only, Stuga keeps creation
unavailable and gives plain guidance to reopen setup. Setup detects the
existing address, reuses the retained runtime approval, and asks only for one
temporary Cloudflare approval before provisioning and verification. Deployment
configuration cannot be replaced through the UI.

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
Saving an origin in the UI cannot create this Cloudflare path policy; run and
verify the provisioner before creating invitations.

If an unjoined Stugby was first created through loopback, configuring the public
origin and restarting Stuga repins that local-only coordinator automatically.
Any still-active invitations are revoked because their copied links contain the
old origin; create new invitations after the restart. Once another node has
joined, the coordinator origin is stable and a mismatched configuration fails
closed instead of silently moving the federation.

## Failure behavior and operations

Network failures leave local Homes fully operational. Property and enabled Home
edits remain in durable queues with bounded exponential retry, senders retain
events in their outbox, and receivers keep their last durable cursor. Adopted
Properties and shared Homes remain visible but are marked offline until a
successful sync.

Adoption materializes sanitized Property/Home projections in canonical tables
so the normal UI and APIs can display them. Stugby metadata keeps inherited,
Client-owned, authoritative, editable, offline, pending, conflict, recovery,
and detached states explicit. Integration bindings and secrets are never
materialized. Remote raw telemetry remains separately indexed until an
explicit, eligible recovery promotion imports it as historical local data.

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
