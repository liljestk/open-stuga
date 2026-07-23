# Security

## Deployment assumptions

Stuga is local-first and has one local workspace with built-in accounts. Browser
sign-in establishes a server-managed HttpOnly session, and the API enforces
account roles and resource grants on every request. Guests are always read-only
and can see only the properties, houses, and areas granted by an owner or
administrator.

Authentication does not encrypt traffic. Keep the default loopback binding, or
put Stuga behind TLS and a trusted VPN or reverse proxy before allowing remote
access. Do not expose the API directly to the public internet.

## Secrets

- Keep `.env` out of source control.
- Use strong, unique owner and administrator passwords, and revoke sessions
  after a device or account is lost.
- Store credentials used by GitHub Actions in GitHub repository or environment secrets, never in workflow files.
- Keep only empty or clearly fake values in `.env.example` and other committed examples.
- Use a least-privilege Home Assistant user and rotate its long-lived token periodically.
- Set `INGEST_API_KEY` before accepting telemetry outside a trusted network.
- Treat `INGEST_API_KEY` as a separate machine-ingestion credential, not as a
  browser account session.
- Treat outbound webhook URLs and bearer tokens as secrets.
- The application must never persist Home Assistant or webhook tokens in SQLite.

## Data

Environmental readings, account records, access grants, sessions, and floor
plans can reveal occupancy patterns and building details. Back up and share the
`data/` volume only as deliberately as other household data. Configure retention
to match the actual purpose, and remove uploaded plans before sharing demo
databases.

## Stugby federation

Stugby is available but shares nothing until an owner creates an explicit
per-Home grant. Only the coordinator needs inbound HTTPS; participant nodes
connect outbound and should not expose an inbound protocol endpoint merely to
join. A participant remains responsible for the data it explicitly grants:
precise coordinates, plans,
sensor placement, notes, observations, and raw telemetry can reveal building
details and occupancy patterns even though the protocol is read-only.

Joining shares no Home data. Review every grant's audience, dataset switches,
local-ID choice, cache permission, retention, expiry, and telemetry scope.
Revoke grants and wait for deletion receipts before removing a node. Treat a
deletion receipt as cooperative confirmation, not proof that a hostile peer did
not make an external copy.

Federation events are signed in transit but are not end-to-end encrypted. The
coordinator can inspect plaintext data it relays to another participant, so the
coordinator must be operated by a trusted Stugby participant.

Protect and back up `STUGBY_IDENTITY_FILE`; it contains the node's private
Ed25519 key. It is never a federation dataset and must never be sent to another
participant. Transfer one-time invitation links through a trusted channel.
Stugby schemas use exact field allowlists and reject integration configuration, endpoints, credentials,
account identities, sessions, remote-control commands, automations, scripts,
callbacks, and webhooks.

The automated Cloudflare coordinator deployment leaves human and owner/admin
routes behind Access and creates a more-specific Bypass only for
`/api/v1/stugby-protocol/*`. Bypass provides no Cloudflare authentication or
Access logging; Stuga's signed-request verifier, active membership, replay
window, body bounds, and origin rate limits are the security boundary there.
Run `npm run cloudflare:verify-coordinator` after every edge-policy change.

## Reporting

Do not open a public issue containing tokens, entity IDs, addresses, floor plans, or telemetry exports. Revoke exposed credentials first, then use the repository's **Security** tab to submit a private vulnerability report with the minimum reproducible details.
