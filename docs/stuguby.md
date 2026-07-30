# Stuguby federation

Stuguby connects independently administered Stugu installations around a shared
property without turning them into one account, database, or control system.
Each Stugu normally remains authoritative for its own Homes. The UI calls the
coordinator the **Host** and every participant a **Client**. The Host maintains
the participant roster, distributes signed events, and owns the shared Property
aggregate. One explicitly designated successor may also keep a complete,
sanitized recovery copy of a Home for a planned Host decommissioning.

This supports both common ownership patterns:

- several households on one property, each running and administering its own
  Stugu; and
- one owner with several Homes in one Stugu, where each Home can have a separate
  grant and audience.

Stuguby is available but inert on every Stugu. Merely running Stugu or creating
a Stuguby shares no Home data. Joining never publishes the Client's local Homes,
though it may receive Homes already shared by the Host or other Clients. The
Host explicitly connects the common Property; each Client explicitly chooses
**Use Host Property** while its other local Properties remain separate. Shared
Property editing is collaborative by default, while shared Homes are read-only
by default. Local owners and administrators configure additional access in
**Workspace > Stugubys**.

## Create the secure coordinator

Open Stugu on the coordinator computer through its loopback URL, then go to
**Stugubys**:

- On a new local installation, choose **Set up secure sharing** before creating
  the Stuguby.
- On an existing Cloudflare remote-UI installation, the same panel appears
  automatically because the machine protocol path still needs provisioning.

The panel collects the hostname, zone, Cloudflare recovery identity, and—when
Stugu has not registered one yet—one API token with **OAuth Client Write** for
the account. Stugu uses that token once to create a private OAuth client and
does not save it. Cloudflare consent supplies the temporary Access, Tunnel,
DNS, and optional Zone Read grant. A new installation also needs the separate
narrow runtime token used to synchronize the managed Access group; an existing
installation reuses it.

The API keeps the temporary grant in memory. Its operation marker contains no
Cloudflare provider token. The trusted host agent claims the grant once, calls
the idempotent provisioner, restarts only `api`, `web`, and `cloudflared`,
verifies public and protected paths, and revokes the temporary OAuth grant.
Failure stops public ingress and leaves the loopback URL available. The public
Stugu URL may show progress but cannot start or alter this operation.

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
materialized in the normal Property workspace with Stuguby ownership metadata;
unrelated local Properties stay separate. Equipment carries its nullable area,
optional map pin, and an opaque Home publication reference. A Home assignment
is restored only when that Home is also available to the recipient; otherwise
the equipment stays safely unassigned until the Home projection arrives.

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

Every Stuguby has one Host (the protocol's coordinator node) and any number of
Clients (participant nodes). The Host is an event relay and the authority for
membership and the common Property. A Home dataset event always retains the
originating Stugu node as its authority; the Host cannot rewrite or impersonate
it.

Property changes are queued durably while a node is offline. The coordinator
applies non-conflicting field changes and is authoritative when both sides
change the same field; the Client retains a visible conflict record. Home
changes use the same durable command pattern only when the Home owner has
enabled synchronized edits. A temporary outage marks projections offline but
never changes ownership.

Editable shared Homes synchronize structural and manual inventory changes.
Integration setup, device discovery, provider/entity bindings, historical
provider imports, controls, and binary floor-plan authoring remain available
only on the authoritative Stugu.

Events are signed but not end-to-end encrypted. The coordinator necessarily
processes and durably queues the plaintext events it relays, even when only a
different participant is named in the grant audience. Operate the coordinator
as a trusted member of the Stuguby and do not use an untrusted third-party relay.

Protocol role IDs remain stable; the UI presents them as:

- **steward**: Host membership and common-Property authority;
- **property-manager**: Client that may edit common-Property records through
  the Host;
- **participant**: Client that may receive grants and publish grants for its
  own Homes; and
- **viewer**: read-only Client.

Local Stugu owner/administrator authorization is required for every browser API
operation. Stuguby roles govern node-to-node common-property writes; they do not
create or manage local Stugu accounts.

## Consent and grants

Joining never publishes the joining Client's Home data. The authoritative Stugu
creates at most one active grant for each local Home in a Stuguby and chooses:

1. all active members or an explicit node list;
2. each enabled dataset;
3. whether correlatable local IDs are included for that dataset;
4. whether recipients may durably cache replicas and for how many days; and
5. for telemetry, the sensor IDs, metric IDs, history boundary, live switch,
   and maximum samples per hour; and
6. whether the Home remains read-only or accepts synchronized edits, plus
   whether one named Client receives a full recovery copy.

Two explicit Property actions create the recommended grant automatically:
connecting the Host Property publishes an overview of each Host Home, and
moving a Client Property into the Host Property publishes an overview of each
moved Client Home. A new Home created directly in that connected Property gets
the same overview. The overview contains the Home name and timezone, room
structure, and sensor labels. It is available to all active members, is
read-only, and excludes precise location, floor-plan images, notes, readings,
integration details, and secrets. The Home remains authoritative and fully
editable on its owning Stugu. Any broader sharing still requires an explicit
grant change by that owner. On upgrade, the next sync adds this overview to an
already-linked local Home only when that Home has never had a grant; an expired
or explicitly revoked grant is never recreated.

Read-only is the default Home policy. Full recovery is intended for a planned
change of Host, not routine offline use. It retains the complete Home
inventory, supported operational records, assets, and recorded history.
While that grant remains active, the designated recovery replica is not
age-pruned; its configured retention value does not discard older transfer
material before decommission.
Available SQLite history is emitted in bounded UTC-hour chunks without a
whole-range row cap. Data chunks are nonterminal; a separate terminal marker is
published only after the entire requested range has been enumerated, including
an empty range. Recipients durably stage those chunks by Home publication and
grant epoch. Queries and recovery promotion continue to use the former complete
same-epoch snapshot, or no snapshot for a new epoch, until the terminal marker
atomically replaces it. Early live chunks wait behind the same boundary.
Advancing a grant epoch atomically purges the former visible, staged, and
completion state, so a narrowed grant cannot retain an old metric.
The publishing Stugu must still have a complete local SQLite cache for the
requested initial history. Once TimeDB compaction owns older rows, creation or
republication of a historical/full-recovery grant fails closed with
`ARCHIVED_TELEMETRY_EXPORT_UNAVAILABLE`; archive-aware federation streaming is
not implemented yet.
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
To change audience or dataset scope, update the existing grant; revoke or let it
expire before creating a replacement for the same Home.

An expired grant no longer authorizes new events. While the authority is
running, expiration automatically advances the grant epoch and sends the same
purge tombstone as an explicit revocation. Old unsent dataset events are
discarded before any restriction, revocation, or expiry tombstone is queued, so
data cannot be published after consent is withdrawn. Retention maintenance
deletes expired cached resources. A dataset with replica caching disabled or
retention set to zero is validated in transit but is not written to the durable
remote projection.

### Read-only MCP inspection

The local MCP exposes `list_stugubys` and `get_stuguby`. They report Host/Client
roles, adopted Property state, owned versus shared Homes, edit policy, sync
state, sanitized grant policy, and pending command counts. `list_properties`,
`list_houses`, and `get_house` also include their Stuguby links. MCP cannot join,
adopt, migrate, share, revoke, synchronize, edit, or disconnect a Stuguby.
Invitation material, member keys, signed events, remote resource payloads, and
audit records are omitted.

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

Stuguby deliberately uses SSE instead of WebSockets:

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

1. Run `npm run setup` on the Host and choose **Create a shared Stuguby
   for several homes**. Setup reuses an existing Stugu address when available,
   provisions the required secure connection, and verifies it automatically.
   Clients remain outbound-only and need no Tunnel or inbound port.
2. Create the Stuguby after setup reports that the connection is ready. With a
   custom reverse proxy, the Owner/Admin form suggests the current secure
   address and verifies it automatically before saving.
3. On the Host, connect the common Property. The Host never receives a
   Client-style Property migration action. Existing Homes stay owned by the
   Host and receive the recommended read-only overview grant.
4. Create a time-limited, one-use invitation with the intended role. Transfer
   the invitation link through a trusted channel.
5. On the joining Stugu, paste the invitation link into **Workspace > Stugubys**.
   The joining node proves possession of its private key and receives the roster
   and common-Property snapshot. Joining does not publish any Client Home.
6. On a Client, choose **Use Host Property**. It appears beside local Properties
   in Property management. Optionally use **Move my Homes into the Host
   Property** to move every Home and Property item from a local Property into
   the adopted Property. The empty source Property is deleted, but Home IDs,
   history, local authority, and full local editing remain unchanged. Each moved
   Home receives the recommended read-only overview grant so it appears on the
   Host and other Clients with the Stuguby mark.
7. On each authoritative Stugu, review or create separate Home grants and set the
   audience, datasets, retention, edit policy, and optional designated recovery
   successor.
8. Edit the shared Property in the normal Property workspace. Offline changes
   queue; same-field conflicts keep the Host value and are explained in the
   UI.
9. Before removing a Client, revoke or narrow every grant involving it,
   let the node synchronize, verify deletion receipts, and then suspend, mark
   left, or revoke the membership. The coordinator queues one final signed
   membership event; after pulling it, the departing node removes its remote
   Home, telemetry, shared-property, and replica-asset projections. A suspended
   node keeps a read-only event pull so it can receive a later reactivation and
   fresh snapshots, but it cannot publish or edit shared Property data.

Use **Permanent disconnect** only for an intentional departure or Host
decommission. It promotes the inherited Property to local, retains
Client-owned Homes, and promotes only complete recovery Homes for which this
Client is the designated successor. An internet outage never triggers this
transition.

Delete a closed Stuguby from **Workspace > Stugubys > Advanced**. A participant
must first be left or revoked; a coordinator must first mark every other member
left or revoked. Every Home grant must also be revoked and all replica deletion
acknowledgements must have arrived. Deletion removes federation records and
cached federation assets from this Stugu; canonical local Home, Sensor, and
telemetry data is unchanged.

If malformed legacy grant data makes that UI unavailable and the Stuguby is
already orphaned, use the guarded maintenance command from the installation
directory:

```sh
npm run stuguby:remove -- \
  --id <stuguby-uuid> \
  --name "<exact Stuguby name>" \
  --confirm <same-stuguby-uuid> \
  --detach-links
```

Omit `--detach-links` when the inspection reports no linked records. The
command takes and verifies a complete backup before stopping the API, refuses
an adopted Property, preserves Home and Property rows, and restores the
services it stopped. This bypasses the distributed revocation handshake and is
not a shortcut for removing a healthy Stuguby.

Use **Republish** after correcting a failed or incomplete snapshot. The manual
**Sync now** action flushes the outbox and pulls all available cursor pages;
normal operation uses SSE wake-ups and the configured safety interval.

## Configuration and deployment

| Variable | Default | Meaning |
| --- | --- | --- |
| `STUGBY_IDENTITY_FILE` | beside the core SQLite database | Persistent node ID and Ed25519 key pair |
| `STUGBY_NODE_NAME` | `Stugu` | Human-readable node name shown to participants |
| `STUGBY_PUBLIC_ORIGIN` | empty | Optional explicit server-owned HTTPS coordinator origin; setup suggests a valid browser/edge origin and the coordinator provisioner writes it automatically |
| `STUGBY_SYNC_INTERVAL_MS` | `15000` | Durable pull/outbox safety interval, 2–300 seconds |

An explicit `STUGBY_PUBLIC_ORIGIN` is authoritative. Otherwise Stugu suggests
a valid HTTPS `CORS_ORIGIN`, Cloudflare public origin, or current browser
origin. For a custom reverse proxy, the Owner/Admin creation form checks and
persists that suggestion in the core SQLite database without a restart.
When Cloudflare is configured for the human UI only, Stugu keeps creation
unavailable and gives plain guidance to reopen setup. Setup detects the
existing address, reuses the retained runtime approval, and asks only for one
temporary Cloudflare approval before provisioning and verification. Deployment
configuration cannot be replaced through the UI.

The Compose setup stores `stuguby-identity.json` and federation SQLite rows in
the existing `/app/data` volume. Keep the identity file owner-readable and back
it up with the SQLite database and Stuguby assets. Restoring SQLite without the
matching node identity prevents the node from proving its existing membership;
restoring an old identity plus an old database may replay already-seen requests,
which peers reject safely.

Every externally reachable coordinator URL must use HTTPS. Configure reverse
proxies to preserve the complete request path, pass request bodies unchanged,
disable buffering for `text/event-stream`, and allow long-lived SSE reads. Do
not expose Stuguby as a substitute for local authentication. The bundled Nginx
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

If an unjoined Stuguby was first created through loopback, configuring the public
origin and restarting Stugu repins that local-only coordinator automatically.
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
so the normal UI and APIs can display them. Stuguby metadata keeps inherited,
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
`packages/stuguby-protocol`.
