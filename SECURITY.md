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

## Reporting

Do not open a public issue containing tokens, entity IDs, addresses, floor plans, or telemetry exports. Revoke exposed credentials first, then use the repository's **Security** tab to submit a private vulnerability report with the minimum reproducible details.
