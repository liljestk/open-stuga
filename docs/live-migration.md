# Live system-to-system migration

Stuga can move a running Compose installation to a Stuga appliance over
authenticated SSH. The source remains available during the optional seed
phase. The final phase deliberately stops source writers, creates a fresh
verified snapshot, transfers only chunks the target does not already have,
restores into isolated target state, and starts the target. The old target
database and application files remain available for rollback until the
migration is explicitly cleaned up.

This is a cutover, not active/active replication. After a successful cutover,
leave the source API stopped. Running both copies against the same sensors,
automations, tunnel, or notification credentials can duplicate collection and
outbound actions.

## What moves

Every cutover requires the complete verified Stuga backup set:

- the online-consistent core and spatial SQLite snapshots;
- the full TimescaleDB custom-format dump and ownership contract;
- assets and the protected integration-secrets file;
- the persistent Stugby node identity and private signing key;
- portable application settings from the source environment file;
- files under the configured Stuga config directory; and
- the known runtime secret directories for Cloudflare and Tapo history.

Target-specific bind addresses, browser ports, filesystem paths, and internal
TimescaleDB credentials are not copied. The target keeps those values from its
own appliance configuration. The migration environment allowlist is defined in
`scripts/stuga-migration-common.mjs`; unknown settings fail closed instead of
being injected into the target.

The transfer plan, chunks, staged backup, settings, and rollback state are all
sensitive household and authentication data. SSH encrypts them in transit, but
it does not encrypt either disk. Use protected accounts and encrypted disks,
keep the recovery private key off the appliance, and remove retained migration
state only after a separate verified backup and an operator-approved retention
period.

## Preconditions

1. Run the controller from the same or a newer checkout than the live source,
   and run the same or a newer Stuga release on the target. The 0.5 controller
   can migrate the live 0.4.1 source without upgrading it first. A source newer
   than the controller, or a target older than the running source, is rejected
   before transfer; target compatibility is checked again before apply.
2. Boot the target appliance, connect it to the network, and confirm
   `stugactl status` is healthy.
3. Confirm the target SSH host-key fingerprint through a trusted channel. The
   controller uses strict host-key checking by default. For a brand-new device,
   `--accept-new-host-key` is an explicit trust-on-first-use choice; inspect the
   key shown by SSH before continuing.
4. Keep the source recovery set on a protected disk and ensure the target has
   generous free space. Preflight budgets three times the logical migration
   size plus 1 GiB for chunks, assembly, candidate data, and rollback.
5. Run the controller from the source Compose project with Node.js 22.13+,
   Docker Compose, OpenSSH `ssh`, and OpenSSH `sftp` available.

## Seed while the source stays online

Seeding is optional but reduces final transfer time. It creates a verified
online snapshot, splits every file into content-addressed 4 MiB chunks, asks
the target which hashes it already has, transfers only missing hashes, then
reassembles and re-verifies the complete backup on the target. It does not
modify target application data.

```powershell
npm run migrate -- seed `
  --target stuga@stuga.local `
  --identity-file "$HOME/.ssh/stuga_appliance" `
  --accept-new-host-key
```

Re-running the command is safe. Already verified chunks are reused. To seed an
existing complete backup rather than create a new one, add
`--backup ./backups/<verified-backup-directory>`. Existing backups are accepted
for seed only; cutover always creates a fresh snapshot after source writers
stop.

## Cut over

```powershell
npm run migrate -- cutover `
  --target stuga@stuga.local `
  --identity-file "$HOME/.ssh/stuga_appliance"
```

The controller performs these guarded steps:

1. proves target reachability, receiver version, and free space;
2. records the source services that are running, stops ingress, then gracefully
   stops the API, backup scheduler, telemetry migration, credential reconcile,
   and optional Tapo writer;
3. creates and verifies a final complete backup with TimescaleDB still online;
4. transfers only content hashes absent from the target and verifies the
   reassembled backup there;
5. creates a target safety backup;
6. restores the dump into a new candidate database, runs TimescaleDB post-
   restore and ownership validation, and stages SQLite/settings files;
7. atomically switches database names and application files while retaining
   the prior target state;
8. restarts the appliance and waits for Compose health checks; and
9. commits the migration receipt only after the target is healthy.

If apply or target health checks fail, the receiver restores its prior database,
files, and settings. The source controller restarts the original source writers
only after the reachable target proves that it rolled back. If SSH becomes
unreachable at the ambiguous moment, the source stays stopped to prevent
split-brain.

Query the durable target receipt before deciding what to run:

```powershell
npm run migrate -- status `
  --target stuga@stuga.local `
  --identity-file "$HOME/.ssh/stuga_appliance" `
  --migration-id <uuid-printed-by-the-controller>
```

Receipt states include `applying`, `applied-pending-health-check`, `committed`,
and `rolled-back`. Do not manually restart a source when the target reports an
applied or committed state.

## Manual target recovery

The controller normally invokes these receiver operations through SSH. An
operator on the appliance can inspect or roll back a known migration:

```sh
stugactl migration status <migration-id>
stugactl migration resume <migration-id>
stugactl migration rollback <migration-id>
```

The appliance refuses ordinary startup while a receipt is
`applied-pending-health-check`. If power is lost after the target passed its
health check but before the receipt was committed, `resume` verifies that the
persisted health timestamp is newer than the apply and belongs to the exact
target release, commits the receipt, and restarts. If that evidence is absent,
it leaves the target interlocked for inspection or rollback.

Rollback stops target writers, restores the pre-migration database/files and
overwritten settings, and restarts the previous target. Rollback is refused
after commit so newer target writes cannot be discarded. A committed migration
is retained deliberately; take and export a new verified backup before removing
its rollback state. Never use `docker compose down -v` as cleanup because it
deletes Stuga's named data and credential volumes.

## Operational validation

After cutover, confirm:

- `stugactl status` reports healthy containers and the expected release;
- recent and historical sensor queries cover representative dates;
- Properties, Homes, floor plans, users, and local permissions are present;
- Home Assistant/TP-Link, Cloudflare, alerts, and notification destinations
  have the intended connection state; and
- a fresh `stugactl backup` completes and is copied off the appliance.

Only then retire the old system or its credentials. Keep it powered off until
the rollback window has passed.
