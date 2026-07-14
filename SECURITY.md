# Security

## Deployment assumptions

Stuga's default edition is local-first and binds to a configurable port. Do not expose its local API directly to the public internet. Put authentication and TLS at a trusted reverse proxy or private access layer before allowing remote access. The optional Cloudflare hosted edition has a separate tenant-aware API and Access boundary; see the [hosting guide](docs/cloudflare-hosting.md).

## Secrets

- Keep `.env` out of source control.
- Store credentials used by GitHub Actions in GitHub repository or environment secrets, never in workflow files.
- Keep only empty or clearly fake values in `.env.example` and other committed examples.
- Use a least-privilege Home Assistant user and rotate its long-lived token periodically.
- Set `INGEST_API_KEY` before accepting telemetry outside a trusted network.
- Treat outbound webhook URLs and bearer tokens as secrets.
- The application must never persist Home Assistant or webhook tokens in SQLite.

## Data

Environmental readings and floor plans can reveal occupancy patterns and building details. Back up and share the `data/` volume only as deliberately as other household data. Configure retention to match the actual purpose, and remove uploaded plans before sharing demo databases.

## Reporting

Do not open a public issue containing tokens, entity IDs, addresses, floor plans, or telemetry exports. Revoke exposed credentials first, then use the repository's **Security** tab to submit a private vulnerability report with the minimum reproducible details.
