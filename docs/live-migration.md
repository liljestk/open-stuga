# Live system-to-system migration and backup recovery

Stugu can move a running Compose installation to a Stugu appliance over
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

Every cutover requires the complete verified Stugu backup set:

- the online-consistent core and spatial SQLite snapshots;
- the full TimescaleDB custom-format dump and ownership contract;
- assets and the protected integration-secrets file;
- the persistent Stuguby node identity and private signing key;
- portable application settings from the source environment file;
- files under the configured Stugu config directory; and
- the known runtime secret directories for Cloudflare Tunnel, encrypted R2
  backups, and Tapo history.

Target-specific bind addresses, browser ports, filesystem paths, and internal
TimescaleDB credentials are not copied. The target keeps those values from its
own appliance configuration. The migration environment allowlist is defined in
`scripts/stugu-migration-common.mjs`; unknown settings fail closed instead of
being injected into the target.

The transfer plan, chunks, staged backup, settings, and rollback state are all
sensitive household and authentication data. SSH encrypts them in transit, but
it does not encrypt either disk. Use protected accounts and encrypted disks,
keep the recovery private key off the appliance, and remove retained migration
state only after a separate verified backup and an operator-approved retention
period.

## Preconditions

1. Run the controller from the same or a newer checkout than the live source,
   and run the same or a newer Stugu release on the target. The 0.5 controller
   can migrate the live 0.4.1 source without upgrading it first. A source newer
   than the controller, or a target older than the running source, is rejected
   before transfer; target compatibility is checked again before apply.
2. Boot the target appliance, connect it to the network, and confirm
   `stuguctl status` is healthy.
3. Confirm the target SSH host-key fingerprint through a trusted channel. The
   controller uses strict host-key checking by default. For a brand-new device,
   `--accept-new-host-key` is an explicit trust-on-first-use choice; inspect the
   key shown by SSH before continuing.
4. Keep the source recovery set on a protected disk and ensure the target has
   generous free space. Preflight budgets three times the logical migration
   size plus 1 GiB for chunks, assembly, candidate data, and rollback.
5. For `seed` or `cutover`, run the controller from the source Compose project
   with Node.js 22.13+, Docker Compose, OpenSSH `ssh`, and OpenSSH `sftp`
   available. For `recover`, the source and local Docker Compose are not
   required; run from a same-or-newer controller checkout with Node.js,
   OpenSSH `ssh`, and OpenSSH `sftp`.

## Recover when the source no longer runs

Use `recover` only when the live source is unavailable but a complete verified
Stugu backup remains. New backup manifests may supply the source version
directly. Legacy manifests do not; recover them only after confirming the
running version from independent release or system records. This is the source
version, not the destination or controller version, and the explicit legacy
acknowledgement prevents an unverified guess from silently weakening
compatibility checks.

```powershell
npm run migrate -- recover `
  --backup "C:\protected\stugu-backup-<timestamp>" `
  --source-version 0.21.0 `
  --allow-legacy-unverified-source-version `
  --target stugu@stugu.local `
  --identity-file "$HOME/.ssh/stuga_appliance"
```

Recovery requires the backup explicitly and requires either manifest-recorded
source provenance or the legacy version plus acknowledgement shown above. It
does not inspect or stop a local Compose source and always preserves the target
appliance's environment, config, and host-bound runtime secret directories. It
transfers the recovery set as a cutover bundle so the target still creates a
safety backup, restores TimescaleDB into an isolated candidate, validates
ownership, atomically swaps application data, and activates TimescaleDB only
after the candidate has its final database name. Before commit it waits up to
ten minutes for every policy that was due at activation to finish successfully,
the scheduler to remain present, and the API archive to report `ready`,
`caughtUp`, no dirty rows, and no queued samples. A post-activation policy
failure fails closed even when TimescaleDB has moved its retry into the future.
If the scheduler is absent, recovery gives it a separate startup grace period
and cycles the documented pre/post-restore pair only after proving restore mode
is off and no policy is running, so a slow healthy policy is not interrupted.
The restored integration-secrets file and Stuguby identity come from the
backup; host-specific Cloudflare, R2, Tapo-history, and network settings must
already exist on the target or be provisioned afterward.

An existing immutable appliance whose running Compose file still uses the
PostgreSQL/TimescaleDB worker defaults needs this one-time persistent bridge
before cutover:

```sql
ALTER SYSTEM SET max_worker_processes = '16';
ALTER SYSTEM SET max_parallel_workers = '4';
ALTER SYSTEM SET timescaledb.max_background_workers = '12';
```

Run the statements as `stuga_admin`, restart only the TimescaleDB container,
then verify all three values with `SHOW`. Do not change or restart the database
during an active migration. New and recreated containers receive the same
values from Compose; the required invariant is
`max_worker_processes >= max_parallel_workers +
timescaledb.max_background_workers`.

## Seed while the source stays online

Seeding is optional but reduces final transfer time. It creates a verified
online snapshot, splits every file into content-addressed 4 MiB chunks, asks
the target which hashes it already has, transfers only missing hashes, then
reassembles and re-verifies the complete backup on the target. It does not
modify target application data.

```powershell
npm run migrate -- seed `
  --target stugu@stugu.local `
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
  --target stugu@stugu.local `
  --identity-file "$HOME/.ssh/stuga_appliance"
```

The controller performs these guarded steps:

1. proves target reachability, receiver version, and free space;
2. records the source services that are running, stops ingress, then gracefully
   stops the API, backup scheduler, R2 replicator, telemetry migration,
   credential reconcile, and optional Tapo writer;
3. creates and verifies a final complete backup with TimescaleDB still online;
4. transfers only content hashes absent from the target and verifies the
   reassembled backup there;
5. creates a target safety backup;
6. restores the dump into a new candidate database, keeps it in TimescaleDB
   restore mode while ownership is validated, and stages SQLite/settings files;
7. atomically switches database names and application files while retaining
   the prior target state, then runs post-restore on a fresh connection to the
   final database name;
8. verifies the TimescaleDB worker budget and waits for the scheduler and every
   policy due at activation to complete without a new failure;
9. restarts the appliance and waits for the telemetry archive to reconcile
   completely; and
10. rechecks scheduler, policy, archive, and exact-release health immediately
    before committing the migration receipt.

If apply or target health checks fail, the receiver restores its prior database,
files, and settings. The source controller restarts the original source writers
only after the reachable target proves that it rolled back. If SSH becomes
unreachable at the ambiguous moment, the source stays stopped to prevent
split-brain.

Query the durable target receipt before deciding what to run:

```powershell
npm run migrate -- status `
  --target stugu@stugu.local `
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
stuguctl migration status <migration-id>
stuguctl migration resume <migration-id>
stuguctl migration rollback <migration-id>
```

The appliance refuses ordinary startup while a receipt is
`applied-pending-health-check`. If power is lost after the target passed its
health check but before the receipt was committed, `resume` verifies that the
persisted health timestamp is newer than the apply and belongs to the exact
target release. It also repeats the TimescaleDB scheduler/policy check and the
bounded archive reconciliation check before committing and restarting. If that
evidence is absent or reconciliation does not complete, it leaves the target
interlocked for inspection or rollback.

Rollback stops target writers, restores the pre-migration database/files and
overwritten settings, and restarts the previous target. Rollback is refused
after commit so newer target writes cannot be discarded. A committed migration
is retained deliberately; take and export a new verified backup before removing
its rollback state. Never use `docker compose down -v` as cleanup because it
deletes Stugu's named data and credential volumes.

## Operational validation

After cutover, confirm:

- `stuguctl status` reports healthy containers and the expected release;
- recent and historical sensor queries cover representative dates;
- Properties, Homes, floor plans, users, and local permissions are present;
- Home Assistant/TP-Link, Cloudflare, R2 replication, alerts, and notification
  destinations have the intended connection state; and
- a fresh `stuguctl backup` completes and is copied off the appliance.

Only then retire the old system or its credentials. Keep it powered off until
the rollback window has passed.
