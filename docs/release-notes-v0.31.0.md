# Stugu 0.31.0

Stugu 0.31.0 adds scheduled NAS exports and a securely controlled network MCP
server, while making analytics results and appliance identity more reliable.

## Highlights

- Configure the shared NAS under **Set up → Operations**, then let each Home
  schedule CSV exports from **Data & analytics**. Daily, weekly, and monthly
  schedules use the Home's local timezone and support bounded retention.
- Export files are checksummed before an isolated storage worker copies them to
  NAS, records a receipt, and prunes only that schedule's older outputs.
- Owners and Admins can explicitly start a read-only Streamable HTTP MCP server
  from **Advanced → API & MCP**, copy its one-time bearer token, and stop it to
  revoke access. The existing local stdio MCP server remains available.
- Setup connection cards now keep a compact, stable layout on desktop while
  preserving a simple single-column flow on narrow screens.

## Reliability

- File export and thermal comparison can use complete raw archive samples while
  optimized telemetry rollups catch up with ingestion.
- Temporary review databases can no longer silently take over the primary API
  port, and thermal comparison distinguishes missing evidence from unavailable
  history and explicitly simulated demo values.
- Raspberry Pi factory images generate unique SSH server host keys on first
  boot and preserve them across A/B and application updates.

## Upgrade notes

Install the application update normally. Startup adds the scheduled-export
records and queue state without moving existing telemetry or changing current
storage settings. Schedules remain inactive until a NAS is configured and a
schedule is enabled.

When adopting the first OS image with per-appliance SSH host keys, an existing
appliance's SSH fingerprint rotates once. Verify the new fingerprint through a
trusted local or Raspberry Pi Connect console before updating `known_hosts`.
