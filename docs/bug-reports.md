# Private bug reports

Every signed-in page includes **Report a bug**. The browser asks one required question and, by default, adds a reviewable diagnostic block containing the app version, route template, page, locale, browser identifier, and up to five redacted recent errors. Screenshots, request bodies, form contents, cookies, and tokens are not collected. Contact permission is optional and can only use the signed-in account email.

The browser posts to the local Stugu API, which enforces session authentication, same-origin CSRF protection, strict size and field limits, and a per-account rate limit. It forwards to the isolated Cloudflare Worker using a shared secret. Only that Worker holds the GitHub App private key. The browser receives a random report ID, never the private repository or GitHub issue URL.

## GitHub App

Create a GitHub App owned by the account or organization that owns the private repository:

1. Disable the webhook; no events are required.
2. Set **Repository permissions → Issues** to **Read and write**. Leave other permissions unset (GitHub adds metadata read access automatically).
3. Install the app for **Only select repositories** and select the target private repository.
4. Record the App ID and installation ID, then generate a private key.

In `apps/bug-report-relay/wrangler.jsonc`, replace `GITHUB_OWNER` and `GITHUB_REPOSITORY`. The relay requests an installation token scoped again to that single repository and `issues: write` before each issue creation.

## Deploy the relay

Create one random secret containing at least 32 bytes and keep it in a password manager. Use the same value for `RELAY_AUTH_TOKEN` and the local API's `BUG_REPORT_RELAY_TOKEN`; do not commit it.

Set Worker secrets interactively:

```powershell
npx wrangler secret put RELAY_AUTH_TOKEN --config apps/bug-report-relay/wrangler.jsonc
npx wrangler secret put GITHUB_APP_ID --config apps/bug-report-relay/wrangler.jsonc
npx wrangler secret put GITHUB_INSTALLATION_ID --config apps/bug-report-relay/wrangler.jsonc
npx wrangler secret put GITHUB_PRIVATE_KEY --config apps/bug-report-relay/wrangler.jsonc
```

Then verify and deploy:

```powershell
npm run typecheck -w @climate-twin/bug-report-relay
npm test -w @climate-twin/bug-report-relay
npm run deploy -w @climate-twin/bug-report-relay
```

## Enable reporting from the app

The quickest path needs no redeploy of Stugu itself. Sign in as an Owner or
Admin, open **System**, and use **Bug report relay**: paste the deployed HTTPS
relay URL (including `/reports`) and the shared token, then save. The token is
written to the protected integration secrets file (`0600`, never returned by
the API and never sent to a browser again), and **Report a bug** starts
delivering immediately — no restart. **Remove relay** clears it again.

Deployment environment variables stay authoritative: when `BUG_REPORT_RELAY_URL`
is set, the panel shows the relay read-only and the API refuses to overwrite it
with `409 BUG_REPORT_RELAY_ENVIRONMENT_OWNED`.

For Compose, put the shared secret in the dedicated ignored directory and set
the deployed HTTPS URL, including `/reports`, in `.env`:

```dotenv
BUG_REPORT_RELAY_URL=https://stugu-bug-report-relay.example.workers.dev/reports
STUGA_BUG_REPORT_SECRET_DIR=./secrets/bug-report
```

The token must be the only line in `secrets/bug-report/relay-token`. Compose
mounts that file read-only and never places its value in the container
environment. For a Raspberry Pi appliance, place it at
`/persistent/stugu/secrets/bug-report/relay-token`, set
`BUG_REPORT_RELAY_URL` with `stuguctl config`, and run `stuguctl restart`.

For a non-Compose API process, configure either `BUG_REPORT_RELAY_TOKEN` or an
absolute `BUG_REPORT_RELAY_TOKEN_FILE` path alongside the URL.

The relay validates the payload independently, uses constant-time authentication, applies a Cloudflare rate-limit binding, escapes issue content to prevent mentions/HTML injection, and logs only the report ID, outcome, and GitHub issue number.

## Alternatives

The private repository is not a limitation: GitHub App installation tokens can create issues in it without giving users GitHub access. If Cloudflare Workers is unsuitable, deploy the same `/reports` contract to another serverless backend and keep the GitHub App key there. For richer telemetry and deduplication, Sentry or self-hosted GlitchTip can replace the issue relay; for the smallest operational footprint, forward the reviewed JSON to a private support mailbox or an internal Linear project instead.
