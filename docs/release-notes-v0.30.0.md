# Stugu 0.30.0

Stugu 0.30.0 makes everyday Property navigation and storage changes clearer,
safer, and more predictable. It also includes the UI and reliability fixes
found during a complete browser audit.

## Highlights

- Choose a default Home for each Property. Stugu uses it when opening the
  Property and automatically keeps the choice valid when Homes move or hide.
- Review telemetry and backup storage changes before applying them, with
  allowed-path validation, overlap prevention, visible migration progress, and
  an easy reset to the current configuration.
- Open Home layout editing directly, keep meaningful Home view modes in the
  URL, and use improved centring, spacing, status explanations, and responsive
  layouts throughout the web application.
- Configure the optional private bug-report relay on Compose and Raspberry Pi
  installations through a protected, upgrade-safe token mount.

## Reliability

- Cancelled analytics work is reported separately from failures and no longer
  distorts execution-duration metrics.
- Property visibility and default-Home selection remain bounded to the Homes a
  signed-in person can access.
- New regression coverage protects storage validation, default-Home behavior,
  layout centring, setup spacing, and Raspberry Pi relay configuration.

## Upgrade notes

Install the update normally. Startup adds the Property default-Home reference
and initializes it to the first active Home where one exists. Existing Homes,
telemetry, and storage configuration are preserved. The bug-report relay stays
disabled unless both its HTTPS URL and protected token file are configured.
