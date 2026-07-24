# Cloudflare Tunnel and Access

Stuga can publish the Compose web service through a remotely managed
Cloudflare Tunnel and protect it with Cloudflare Access one-time PIN login.
This is optional. The default loopback-only install remains the smaller trust
boundary when remote access is not required.

Cloudflare Access is an outer gate, not a replacement for Stuga accounts. An
edge identity first passes the managed Access policy, then signs in to a local
Stuga owner, administrator, member, or Guest account. Local roles and resource
grants remain authoritative for every API request.

For a Stugby, only the coordinator needs an inbound hostname. Every participant
opens outbound HTTPS/SSE connections to that coordinator, so participant-only
Stuga systems need neither a Tunnel nor an inbound firewall rule.

## What the provisioner owns

`scripts/cloudflare-stuga.mjs` creates or reuses a narrowly named set of
resources for one hostname:

- a one-time PIN identity provider;
- an exact-email Access group and an Allow policy that references it;
- a self-hosted Access application plus a public bypass limited to the static
  invitation bootstrap assets;
- a remotely managed Tunnel whose only application ingress is the Compose web
  service, followed by a catch-all 404; and
- one proxied CNAME pointing the chosen hostname to that Tunnel.

`provision-coordinator` adds exactly one more Access application:
`<hostname>/api/v1/stugby-protocol/*`. Its more-specific path policy bypasses
the human identity prompt so independently administered nodes can reach
Stuga's Ed25519 verifier without receiving Cloudflare credentials. The
owner/admin `/api/v1/stugbys*` API and all other paths remain covered by the
root Access application. The generated runtime also pins
`STUGBY_PUBLIC_ORIGIN`; the browser cannot choose or change it.

Cloudflare does not authenticate or create Access logs for a Bypass policy.
This narrow exception is intentional: the Stugby protocol itself authenticates
the exact method, path, body digest, node, timestamp, and replay ID, and checks
active membership and grants. The bundled proxy rate-limits join and signed
protocol requests before request-body parsing. Do not widen the exception or
use it for owner/admin routes.

The script refuses ambiguous names, conflicting DNS, unexpected application
destinations, and group/policy rules it does not own. It does not delete
Cloudflare resources.

The generated runtime keeps two identity sources deliberately separate:

- `CLOUDFLARE_ACCESS_STATIC_EMAILS` contains the Cloudflare operator/recovery
  identities that must always retain the outer Access gate; and
- Stuga adds all active non-owner accounts and unexpired invitations from its
  local directory.

The local Stuga owner's login may be a private name such as `owner@stuga` and
does not have to match the email that receives Cloudflare PINs. This separation
prevents first-owner setup from replacing the only working edge identity.

## Prerequisites and token scope

Use a hostname in an active DNS zone already managed by the intended Cloudflare
account. New accounts must open the Zero Trust dashboard and complete its
initial organization setup once. Keep the host port on its default loopback
binding; `cloudflared` reaches the web container over the private Compose
network.

Create two API tokens and store each value in a protected file outside source
control, or paste them only into the setup wizard's hidden prompts:

1. A short-lived provisioning token, scoped to the one account and zone, with
   **Access: Apps and Policies Write**, **Cloudflare Tunnel Write**, and
   **DNS Write**. Add zone-read permission when using automatic zone discovery;
   pass `--account-id` and `--zone-id` to avoid discovery when practical.
2. A different runtime token scoped to the one account with only **Access:
   Organizations, Identity Providers, and Groups Write**. Stuga uses it only to
   read and replace the exact-email rules in its managed group.

On macOS/Linux, token files must be regular files with mode `0600`; the
provisioner rejects group/world-readable files. On Windows, store them under
the installing user's private profile and do not grant other users access.

The relevant Cloudflare API references are the current documentation for
[Access groups](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/groups/),
[Access applications](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/),
[Cloudflare Tunnel](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/),
and [DNS records](https://developers.cloudflare.com/api/resources/dns/subresources/records/).
Review them when creating tokens because provider permission names can evolve.

The provisioner rejects identical setup/runtime tokens so a broad temporary
credential cannot accidentally become the retained runtime credential. Do not
pass either value on the command line. Command-line arguments are commonly
retained in shell history and process inspection.

## Recommended guided setup

For a new Docker or Podman installation, run:

```powershell
npm run setup
```

Choose the container runtime, then either **Secure remote access with
Cloudflare Tunnel + Access** or **Remote access plus a Stugby coordinator**.
The wizard asks only for the hostname, DNS zone, recovery email, and how to
supply the two tokens. Account and zone IDs are discovered when unambiguous.

The default hidden-paste path keeps both token values out of command arguments,
shell history, logs, and `.env`; the temporary token stays only in process
memory. The wizard provisions Access before public ingress, writes the retained
runtime files under ignored `secrets/cloudflare/`, recreates `api`, `web`, and
`cloudflared`, and retries the external verifier while DNS/Tunnel state
converges. If verification does not pass, it stops `cloudflared` automatically.
It also pins `BIND_ADDRESS=127.0.0.1`; the loopback URL remains available for
recovery.

Preview the complete plan without reading tokens or changing local/provider
state:

```powershell
npm run setup -- --mode docker --real `
  --cloudflare remote-ui `
  --cloudflare-hostname stuga.example.com `
  --cloudflare-zone example.com `
  --cloudflare-owner-email edge-owner@example.com `
  --dry-run --yes
```

For non-interactive automation, remove `--dry-run` and add both
`--cloudflare-provision-token-file` and
`--cloudflare-access-token-file`. Token values themselves are never CLI
options. Use `--cloudflare stugby-coordinator` only on the node that will create
the Stugby.

## Manual provision

From the repository root, run the idempotent provisioner. In PowerShell:

```powershell
node scripts/cloudflare-stuga.mjs provision `
  --hostname stuga.example.com `
  --zone example.com `
  --owner-email edge-owner@example.com `
  --account-id 0123456789abcdef0123456789abcdef `
  --zone-id fedcba9876543210fedcba9876543210 `
  --provision-token-file C:\protected\stuga-provision-token `
  --access-token-file C:\protected\stuga-access-group-token
```

`--owner-email` is the Cloudflare PIN recipient and permanent edge operator,
not necessarily the first local Stuga account. The script validates all input
before changing provider state.

Successful provisioning writes the following ignored, host-sensitive files
under `secrets/cloudflare/`:

- `config.env`, containing non-secret IDs, the public origin, and the static
  operator list;
- `access-group-token`, containing the runtime group token;
- `tunnel-token`, containing the connector credential; and
- `deployment.json`, containing resource IDs for recovery and inspection.

The temporary provisioning token is never copied. Revoke it after validating
the deployment. Protect and back up the generated directory separately in
encrypted off-host storage; the normal Stuga data backup is not a substitute
for these deployment credentials.

Recreate the services that consume the generated runtime:

```powershell
docker compose up -d --build --force-recreate api web cloudflared
docker compose ps
npm run cloudflare:verify
```

### Provision a Stugby coordinator

Use the coordinator command instead when this Stuga will create and coordinate
a Stugby:

```powershell
npm run cloudflare:provision-coordinator -- `
  --hostname stugby.example.com `
  --zone example.com `
  --owner-email edge-owner@example.com `
  --account-id 0123456789abcdef0123456789abcdef `
  --zone-id fedcba9876543210fedcba9876543210 `
  --provision-token-file C:\protected\stuga-provision-token `
  --access-token-file C:\protected\stuga-access-group-token

docker compose up -d --build --force-recreate api web cloudflared
npm run cloudflare:verify-coordinator
```

Both verifier commands make unauthenticated probes and fail unless all five
boundary conditions hold:

1. `/` is challenged by Cloudflare Access;
2. `/api/v1/stugbys` is challenged by Cloudflare Access;
3. `/invite-bootstrap` is publicly reachable;
4. `/invite-bootstrap.js` is publicly reachable; and
5. the machine-protocol path stays behind Access in remote-UI mode, or an
   intentionally invalid join reaches and is rejected by Stuga's application
   verifier in coordinator mode.

Run the matching verifier after every Access, Tunnel, hostname, or reverse-proxy
change. It sends no credential, invitation, Home data, or valid protocol
request.

Visit the HTTPS hostname, authenticate with the edge operator email, and create
or sign in to the local Stuga owner. Verify all of these before considering the
rollout complete:

1. the configured operator receives a PIN and reaches Stuga;
2. an unrelated email does not pass Access;
3. first-owner setup does not change the Access group operator;
4. a newly invited email can pass Access and redeem its shown-once Stuga
   invitation; and
5. removing that account immediately removes local authorization and the next
   group reconciliation removes its edge allowlist entry.

Cloudflare identity selectors are evaluated at authentication time. An existing
Cloudflare session may remain at the outer gate until its Access session ends,
but deleting a Stuga member invalidates the local membership boundary on the
next API request.

## Existing-install migration

Generated Cloudflare configs from before the static-operator field must be
updated **before restarting the API**. Stuga intentionally refuses a partial
configuration instead of guessing and risking an edge lockout.

Inspect the managed Access group in Cloudflare, identify the email that must
retain recovery access, then add it to `secrets/cloudflare/config.env`:

```dotenv
CLOUDFLARE_ACCESS_STATIC_EMAILS="edge-owner@example.com"
```

Comma-separate multiple recovery operators inside the quotes. Use real
Cloudflare login identities, not a private local Stuga name unless that address
can actually receive one-time PINs. Rerunning the provisioner with the original
hostname and the desired `--owner-email` also writes the field safely.

An existing remote-UI deployment becomes a coordinator by rerunning the same
inputs with `provision-coordinator`. The script upgrades `deployment.json`,
adds the exact machine-path application and policy, and writes
`STUGBY_PUBLIC_ORIGIN`; it does not delete or replace unrelated resources.
Recreate `api`, `web`, and `cloudflared`, then run `verify-coordinator` before
creating invitations. When a Stugby was created on loopback and no remote node
has joined, startup safely pins it to the configured origin and revokes its old
origin-bound invitations; create fresh invitations after verification. An
established Stugby is not silently moved to another origin.

## Rotation, recovery, and rollback

- To rotate the runtime token, create a replacement with the same single
  account/group permission, replace the protected token file, recreate the API
  container, verify group synchronization, and only then revoke the old token.
- If synchronization fails, local invitations remain durable and the managed
  group is left unchanged. Inspect redacted API logs and the Cloudflare audit
  logs; do not paste tokens or member addresses into support output.
- If the static operator list is wrong, fix `config.env` from the host's local
  console and restart the API. Keep at least one verified recovery operator in
  the list.
- To withdraw public access without deleting provider state, stop the
  `cloudflared` service. The default loopback URL remains the recovery path:

  ```powershell
  docker compose stop cloudflared
  ```

- A healthy connector proves only that the connector reaches Cloudflare.
  Validate the Access decision, HTTPS hostname, origin health, local sign-in,
  invite flow, and removal flow end to end after every policy or token change.

For provider behavior and troubleshooting, use Cloudflare's current
[Access policy](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/),
[one-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/),
and [Tunnel troubleshooting](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/)
documentation.
