# Stugu 0.29.1

Stugu 0.29.1 makes the v0.29 restore path self-healing after a live migration
or disk replacement. It preserves every raw sample and changes only startup
permission checks, recovery bookkeeping, and refresh-policy reconciliation.

## Fixes

- Existing telemetry schemas start without granting the API database-wide
  schema creation privilege.
- A disabled built-in TimescaleDB telemetry reporter no longer blocks recovery;
  user and aggregate jobs remain subject to the same success checks.
- Legacy bounded measurement refresh policies are replaced automatically with
  the v0.29 lossless full-history policies.

## Upgrade notes

Install the update normally. Startup performs the policy repair in place and
does not delete, downsample, or rewrite raw telemetry.
