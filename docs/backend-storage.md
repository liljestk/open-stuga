# Backend storage and operations

Stuga uses a hybrid local-first backend. Core SQLite keeps the transactional control plane and a hot local telemetry buffer; PostgreSQL with TimescaleDB keeps the durable, query-optimized telemetry archive. Together those two stores are one logical telemetry source. A separate SQLite database contains optional experimental spatial state, and a bounded process-local cache accelerates repeatable reads. Neither is a source of core facts.

## Responsibilities

| Layer | Owns | Does not own |
| --- | --- | --- |
| Core SQLite (`DATABASE_PATH`) | Authentication and access state, canonical properties/houses/areas/floor plans and sensors, alerts and automation state, local ingestion, and the hot safety copy | Long-term analytical scaling or experimental model state |
| TimescaleDB (`telemetry` schema) | Raw measurement, legacy reading, outdoor-temperature, and electricity-price history; time bucketing; cold-chunk optimization | Identity, authorization, configuration, or secrets |
| Spatial SQLite (`SPATIAL_LAYERS_DATABASE_PATH`) | Experimental overlays/configuration, bindings, calibrations, context, jobs/checkpoints, model runs, ground truth, and derived snapshot revisions | Property/sensor masters or raw telemetry samples |
| In-process cache | Small, bounded, reconstructible response DTOs and snapshots | Writes, sessions, credentials, queues, or durable state |

This split keeps local writes and the control API simple while allowing years of telemetry to be partitioned and aggregated efficiently. SQLite remains useful during an optional archive outage; losing the cache only causes cache misses.

## SQLite control plane

All authoritative non-time-series application state is durable in SQLite. The core database contains:

- local accounts, password and session hashes, workspace membership, invitations, and scoped Guest grants;
- Properties, Homes, complete floor-plan aggregates, map placement and orientation, areas, fixed assets, equipment, notes, electricity contracts, and binary floor-plan assets;
- sensors, measurement definitions, Home Assistant entity bindings, TP-Link device bindings, alert rules, alert history, alert evaluation state, and the notification outbox;
- observations and revision history, maintenance tasks and revision/evidence links, static parameters, weather-outage recovery state, operational latches, and selected demo state;
- non-secret integration identity, ownership, endpoint metadata, lifecycle state, and revision history.

Property creation and other multi-row aggregate changes use SQLite transactions. Foreign keys are enabled on every connection, WAL mode permits concurrent readers during writes, and the configured busy timeout handles short writer overlap without a heavyweight database service. Complete floor plans intentionally remain one JSON aggregate inside SQLite: ownership and lookup fields are relational and indexed, while one edit commits the internally consistent plan as a unit instead of exposing half-written rooms or walls.

Experimental spatial configuration, assignments, sensor-zone overlays, calibration/ground-truth data, job state, model runs, snapshots, and checkpoints use a second WAL SQLite file beside the core database. It refers to canonical Property, Home, floor-plan, and sensor records by ID and reads them from core SQLite; it does not duplicate those masters or raw telemetry samples. Keeping this optional/research subsystem physically separate prevents its high-churn derived state from expanding or locking the core control plane. It is still durable and included in normal backups.

Spatial rows are partitioned by the core database's persisted, non-sensitive archive-source UUID and active demo/real mode. The UUID travels with a moved or restored core database, unlike a file-path hash. An upgraded runtime transactionally re-keys an unambiguous legacy path-derived partition and refuses a collision instead of merging two histories.

Legacy Home Assistant and TP-Link mapping files are bootstrap/update inputs, not the only durable copy. Each integration manager imports a valid configured file on start even when credentials are absent or every live connection is Home-scoped. It canonicalizes known fields with locale-independent key/member ordering and atomically stores the complete non-secret JSON aggregate in core SQLite with its integration kind, verified SHA-256 content hash, monotonic revision, and creation/update timestamps. Semantic key/member reordering is a no-op. A valid file also repairs malformed, non-canonical, or hash-mismatched stored content; without a file, verification fails closed instead of trusting a damaged row. If the configured file is later absent, the compatibility bridge revalidates and uses the last SQLite revision. Home Assistant `unit`, `scale`, and `offset` options are retained; unknown fields, credentials, and the source file path are not. Duplicate Home Assistant claims for one sensor/metric are rejected. Stale sensor references are retained in the audited aggregate but filtered before active ingestion and reported as a diagnostic. This compatibility state is global only to the single legacy environment-backed connection and is never applied to Home-scoped UI connections. Historical precedence is unchanged: a Home Assistant file mapping wins for the same sensor/metric, while a TP-Link binding saved on a sensor wins over the legacy child map. An explicit empty TP-Link `devices` array clears that compatibility set without removing current sensor bindings.

Credential bytes are the deliberate exception. Home Assistant tokens, TP-Link and Telegram credentials, complete webhook URLs/bearers/signing keys, and Apple Notes grant-token hashes remain in the owner-protected integration secrets file; putting credentials or capability-bearing URL query strings in the broad core database would weaken recovery and access boundaries. SQLite stores typed non-secret references, Home ownership, sanitized Home Assistant endpoints, TP-Link hosts, safe display labels, active/retired lifecycle state, and an append-only revision snapshot for each change. Existing version-1 secret files are reconciled on startup without rewriting live credentials. A validated file can soft-retire references that are no longer present; a missing, unreadable, or explicitly partial file never prunes last-known metadata. Records are not hard-deleted, including after a Home is removed.

Environment variables remain valid deployment overrides. An environment webhook destination set takes precedence and is mirrored atomically into the protected secrets file so a complete backup can restore it after the override is removed; SQLite receives only safe per-destination references and revisions. The legacy `primary` destination retains its `singleton` metadata reference for upgrade compatibility. If protected-file mirroring is unavailable, the environment configuration continues to operate but the backup must retain the deployment secrets separately. In-process caches, connection status, discovery results, SSE listeners, in-flight work, and replay position are reconstructible runtime state; browser storage contains presentation preferences, not authoritative Property data.

Ingestion commits to SQLite first. A reconciliation worker pages all four telemetry families from that crash-safe buffer and UPSERTs them into TimescaleDB. Each table has both a remote Timescale cursor and a local cursor stored inside SQLite. Reconciliation starts from the lower of the two; after a remote batch succeeds, it advances the remote cursor and only then the local cursor. A crash between those steps causes an idempotent replay rather than a gap, and a restored or rewound SQLite backup safely replays from its older local cursor even if TimescaleDB remembers a later position. A live wake-up path reduces normal archive latency, but checkpointed reconciliation remains the source of truth. This is lossless across API or TimescaleDB restarts only while the SQLite file/volume is retained until the archive has caught up.

Regular raw-history APIs and experimental spatial inference share `HybridTelemetryReader` rather than copying data between subsystems. It always reads the SQLite buffer and, while the archive is ready or synchronizing, merges the matching Timescale rows by their natural keys. SQLite wins an overlapping key, results are deterministically ordered and tail-limited, and real-data mode filters synthetic `mock`/`replay` rows. While the unpruned local buffer is complete, an archive read failure degrades to SQLite and requests reconciliation; returned provenance contains only safe source state and counts. This shared facade currently covers measurement history/windows, legacy readings, and outdoor temperature.

The time-series schema uses seven-day chunks for indoor measurements/readings, 30-day chunks for outdoor temperature, and 90-day chunks for electricity prices. Where supported, TimescaleDB configures columnstore or compression after 30, 90, and 180 days respectively. Measurement rollups are available at 5-minute, 1-hour, and 1-day resolutions. These policies change representation, not retention: they do not delete raw rows.

The base tables and query API also work on ordinary PostgreSQL. When the TimescaleDB extension is unavailable, Stuga uses ordinary aggregate views and forgoes hypertables, continuous refresh, and cold-chunk optimization; initialization reports those capabilities instead of silently claiming them.

## Retention and idempotency

`RETENTION_DAYS=0` keeps a complete redundant SQLite telemetry copy and is the safest/default development setting. A value of 30 or more bounds only the SQLite hot copy and requires `TIMESERIES_ENABLED=true`. The Timescale schema installs no raw-data retention policy, so archived raw samples remain permanent.

Before each pruning cycle the retention worker requires a healthy, caught-up archive, runs a fresh reconciliation, verifies that no mutable archive rows are dirty, and takes per-table archived watermarks. It preserves the latest local row for every sensor/metric, sensor tuple, and outdoor location. If an older query needs pruned history while Timescale is unavailable, the API fails closed instead of silently returning an incomplete series. Operational prerequisites remain:

1. The archive backfill has completed.
2. Verification against the source snapshot succeeds.
3. Both SQLite and PostgreSQL backups have been restored in a test environment.
4. Monitoring shows sufficient archive capacity.

The bounded-delete primitive is invoked only by the guarded retention worker.
The shared archive-plus-hot-tail reader keeps regular raw history, bucketed
history, replay, and spatial derivation on the same sources. MCP cold-history
queries fail closed and direct forecast/thermal consumers remain inside the
minimum 30-day hot window. Old ranges explicitly fail when they depend on an
unavailable archive. Keep retention at zero when MCP needs direct cold-history
access or when a single-file raw JSON telemetry export is required; verified
backups cover both databases regardless of this setting.

Archive writes use natural keys and UPSERTs, so retrying a batch is safe. The keys are:

| Series | Natural key |
| --- | --- |
| Measurement | `sensor_id, metric, observed_at, source` |
| Legacy reading | `sensor_id, observed_at, source` |
| Outdoor temperature | `house_id, location_key, observed_at, source` |
| Electricity price | `property_id, starts_at, source` |

Changing a source identifier changes the identity of a sample. Do not rewrite source names during import unless the duplication is deliberate.

## Historical ownership lineage

The current raw indoor schema identifies a series by sensor ID, while access control resolves that sensor through its current Home and Property. Until immutable historical ownership context is stored, Stuga therefore fails closed when a Home with real telemetry is moved to another Property, when a sensor with real telemetry is moved to another Home, or when a telemetry-owning sensor, Home, or Property is hard-deleted. Archiving the samples first does not make those mutations safe: it would retain values while losing or changing the names, placement, ownership, and authorization context needed to interpret them. Sensors can be disabled instead. Resources containing only `mock` or `replay` telemetry may still be removed.

The planned lineage migration will capture immutable `property_id` and `house_id` context on indoor samples (and `property_id` on outdoor samples) at ingestion time, without changing those fields during an idempotent replay. A small tombstone catalog will preserve retired resource names, parent IDs, placement metadata, and retirement time. Historical queries will authorize against captured context rather than only the current sensor row. Existing rows can be backfilled once from their current ownership before reparenting is enabled; move/delete and Guest-scope regression tests are required before lifting the fail-closed guards.

## Configuration

Local `npm run dev` remains SQLite-only unless `TIMESERIES_ENABLED=true` is set. Docker Compose enables TimescaleDB and starts the API after the database container has started; it deliberately does not wait for database health. The API can therefore begin serving from SQLite while the archive worker retries initialization and reconciliation. PostgreSQL is exposed only to the Compose network; it is not published on a host port.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TIMESERIES_ENABLED` | `false` locally; `true` in Compose | Enable archive initialization and use |
| `TIMESERIES_REQUIRED` | `false` locally and in Compose | Opt in to failing API startup when the archive cannot initialize |
| `TIMESERIES_HOST`, `TIMESERIES_PORT` | `127.0.0.1`, `5432` | PostgreSQL endpoint |
| `TIMESERIES_DATABASE`, `TIMESERIES_USER` | `stuga`, `stuga_app` | Database and least-privilege application role |
| `TIMESERIES_PASSWORD` | empty locally; generated password file in Compose | Write-only database credential |
| `TIMESERIES_POOL_MAX` | `6` | API connection-pool ceiling |
| `TIMESERIES_CONNECT_TIMEOUT_MS` | `5000` | Connection timeout |
| `TIMESERIES_STATEMENT_TIMEOUT_MS` | `15000` | Per-statement server timeout |
| `TIMESERIES_BATCH_SIZE` | `1000` | Maximum archive write batch |
| `RETENTION_DAYS` | `0` | SQLite hot-copy retention; `0` keeps a full redundant copy, or use at least `30` with Timescale enabled |

Compose generates persistent random database-admin, application-database, and local-proxy secrets on first start and mounts them as files; it does not ship fixed database passwords. PostgreSQL is restricted to the internal Compose backend network, where the supplied API connection disables TLS. For a non-local or externally hosted database, provide the application credential through a protected secret file or secret manager, require TLS, restrict network ingress, and retain the dedicated least-privilege application role. Never log the resolved configuration or put a credential-bearing URL in source control.

The database administrator must create the configured telemetry schema and make the application role its owner before the API or migrator starts. The supplied Compose bootstrap does this automatically. The application role intentionally has no database-level `CREATE` grant, so normal runtime code cannot create arbitrary schemas.

The PostgreSQL data and both database-credential volumes form one recovery unit. Back them up and restore them together. If either credential volume is accidentally lost while the PostgreSQL data volume survives, stop the API, let `runtime-secrets` create replacement secrets, and run `docker compose --profile maintenance run --rm timeseries-credential-reconcile`. This maintenance job has no network interface; it reaches PostgreSQL only through the private Unix-socket volume and reconciles the administrator and least-privilege application roles with the generated files. Start the API only after the job succeeds.

The Compose image is pinned through `TIMESCALE_IMAGE`. Do not change PostgreSQL major versions against an existing data directory. Back up, create a fresh volume on the new major version, then migrate with `pg_dump`/`pg_restore` or the vendor-supported upgrade procedure.

## Cache boundaries

The cache is a dependency-free, bounded LRU with TTL, optional stale-while-revalidate, request coalescing, explicit invalidation, and no background timers. Cache only data that can be reconstructed from SQLite or TimescaleDB. The API uses a small two-second cache for raw latest measurement/legacy-reading snapshot assembly and invalidates it after relevant telemetry mutations.

Cache keys must include every representation boundary: house or property ID where the cached value is scoped, query range, resolution, units, and schema/API version. Authorization-scoped representations must also include their tenant/user visibility scope. A scope-neutral raw snapshot may be shared only when authorization filtering is applied after the cache read and before any response; that is the pattern used for latest snapshots. Invalidate affected namespaces after mutations.

Good candidates are short-lived assembled latest-state snapshots and expensive historical aggregates. Do not cache authentication or bootstrap responses, integration credentials, mutations, ingestion acknowledgements, action/notification state, SSE streams, or unbounded raw history. A cache outage or process restart must not affect correctness.

## Failure and degraded operation

`TIMESERIES_REQUIRED=false` is the local and Compose default. The API remains available on its SQLite control plane and durable local buffer while the archive starts or recovers, and the worker retries initialization and checkpointed reconciliation. Set `TIMESERIES_REQUIRED=true` only when strict fail-closed startup is operationally preferable; in that mode the API fails startup if the archive cannot initialize.

During an archive interruption, do not manually purge, replace, or discard SQLite. The API continues committing locally when degraded operation is allowed; after PostgreSQL recovers, reconciliation resumes from the minimum of the local and remote cursor for each table. Use the migration tool for a one-off database move or manual recovery, then verify it. When positive SQLite retention is configured, the maintenance worker pauses all pruning until the archive is healthy, caught up, freshly reconciled, and free of mutable dirty rows. Long-range archive queries may be unavailable or slower while degraded, but control-plane and hot local operations remain independent of cached data.

Use short connection and statement timeouts so an archive fault does not exhaust API workers. Keep the pool small relative to PostgreSQL `max_connections`; the supplied Compose defaults use a pool of 6 and a server ceiling of 30. Investigate repeated pool errors, growing PostgreSQL waiters, migration checkpoints that stop advancing, or divergence between source and destination counts.

## Migration

The migration tool reads SQLite in read-only mode, checks its integrity and schema, creates a committed-WAL-aware snapshot for a real run, and migrates in transactional batches. Before the first batch it requires/enables TimescaleDB, converts all four destination tables to validated hypertables with the canonical time columns and chunk intervals, and uses a dedicated maintenance timeout rather than the API's 15-second statement timeout. Optional outdoor `conditions_json` is syntax-validated and preserved under Timescale metadata's `conditions` key; older SQLite schemas without that column remain supported. It writes a checkpoint after each committed batch. Inserts use natural keys with `ON CONFLICT DO NOTHING`: an older snapshot can never overwrite an existing destination row, and exact post-import verification includes the resulting metadata and fails if a colliding destination payload differs. It never deletes source or destination rows.

Run migration as single-writer maintenance: stop the API, archive worker, and every other process that can write the target schema for the full import and verification window. The tool acquires the destination/schema PostgreSQL advisory lock before its checkpoint-file lock, for both migration and verify-only runs. A lock records a random owner token and the durable database fingerprint. If a one-off container is killed, a replacement may remove its foreign-host lock only after acquiring the same database advisory lock and matching that fingerprint; delayed cleanup from the old owner cannot remove the replacement lock. This prevents concurrent CLI writers while allowing automatic recovery across changing container hostnames. The advisory lock cannot prevent ordinary application writes. After raw-table verification succeeds, the tool creates or validates the fixed measurement continuous aggregates and refreshes the imported historical range at 5-minute, 1-hour, and 1-day resolutions under the same maintenance timeout.

First inspect the source without creating files or connecting to PostgreSQL:

```powershell
node scripts/migrate-telemetry-to-timescale.mjs --source ./data/climate-twin.sqlite --dry-run
```

For the standard Compose deployment, use the dedicated maintenance service. It reads the existing SQLite volume and the application-role password file on the private backend network, so PostgreSQL does not need a host port and the password is not placed in shell history. Stop both serving containers before taking the snapshot, keep them stopped through the independent verification pass, and restart them only after both commands succeed:

```powershell
docker compose stop web api
docker compose up -d runtime-secrets timescaledb
docker compose --profile maintenance run --rm telemetry-migrate
docker compose --profile maintenance run --rm telemetry-migrate `
  node /app/scripts/migrate-telemetry-to-timescale.mjs `
  --source /app/data/climate-twin.sqlite --verify-only
docker compose up -d api web
```

If either migration command fails, leave the API stopped, preserve the generated snapshot and checkpoint, inspect `docker compose logs timescaledb`, and rerun the same command after correcting the cause. The migration is resumable and idempotent. Do not start the API merely to test a partial import, and do not delete or replace SQLite. A non-Compose migration can instead use `TIMESCALE_DATABASE_URL`, but any temporary PostgreSQL publication must be loopback-only and removed immediately afterward; never publish PostgreSQL to a LAN for an import.

By default the tool places a consistent `*.timescale-migration.snapshot.sqlite` and resumable `*.timescale-migration.json` checkpoint beside the source. Both contain sensitive household or database metadata. The tool requests owner-only file permissions and a private Windows ACL, but they must still live on a protected, preferably encrypted destination. Keep both until verification and a restore drill succeed. Re-run the same command with the same source, snapshot, checkpoint, destination, and schema to resume. The destination fingerprint uses the durable PostgreSQL database OID, database/user names, and schema, not a container IP or port, so recreating a container around the same database volume does not invalidate recovery. Legacy checkpoints whose transport-based fingerprint no longer matches may be rebound only by a successful `--verify-only` pass over an already complete import; an incomplete legacy checkpoint fails closed. Use `--snapshot` and `--checkpoint` to place these files in a protected backup directory, `--batch-size` to tune batches, and `--schema` only when intentionally isolating an import.

`--verify-only` compares the existing destination with the consistent snapshot; it does not update PostgreSQL. If the live SQLite database has changed since migration, verify against the migration snapshot rather than assuming live row counts must be identical. Preflight normalizes timestamp keys to PostgreSQL `timestamptz` semantics, so two textual offsets that identify the same instant are rejected as a collision before import.

Treat one target schema as one logical deployment. Import multiple historical SQLite databases into the same schema only after confirming that their natural keys and identities belong together: a collision retains the existing destination row, and verification rejects the import if the payloads differ. Preserve unrelated development databases as verified backups or migrate them to deliberately separate schemas.

## Backup and restore

Back up both authoritative stores. A PostgreSQL dump alone omits control-plane data and integration configuration; a SQLite snapshot alone omits the durable archive. Every backup is sensitive: core SQLite contains authentication/session hashes and household state, assets may reveal the home, and Timescale contains occupancy-adjacent telemetry. Keep sets outside Docker volumes on a protected, encrypted destination and encrypt every off-host copy, whether or not integration secrets are included.

The repository backup CLI produces a transparent directory with consistent SQLite snapshots, copied assets, an optional full-database custom-format PostgreSQL dump, and a checksummed manifest. It creates the root as `0700` and files as `0600` where POSIX permissions apply; on Windows it removes inherited access and grants the current account a private ACL, failing closed if that cannot be done. These controls do not replace disk encryption. The full database is required to preserve TimescaleDB hypertable chunks and catalog relationships; a schema-filtered dump is not a safe substitute. By default the CLI backs up the core database, the spatial database when present, and the assets directory. Secrets and TimescaleDB are explicit opt-ins. It never overwrites an existing output directory; an interrupted or failed run remains marked `INCOMPLETE`.

For Compose, the preferred complete backup path is the maintenance-only image. It contains matching PostgreSQL 17 client tools without adding them to the production API image, reads the databases through private volumes/networking, and writes to `./backups` (or `STUGA_BACKUP_DIRECTORY`):

```powershell
docker compose --profile maintenance run --rm stuga-backup
docker compose --profile maintenance run --rm --no-deps stuga-backup `
  --verify /app/backups/<backup-directory>
```

This command deliberately includes both SQLite databases, assets, integration secrets, and a full TimescaleDB dump. Its output therefore contains the complete sensitive household recovery set; move the verified directory to encrypted off-host storage. The service does not publish PostgreSQL or require `pg_dump` on the host.

Create and verify a complete recovery set before a risky migration or upgrade:

```powershell
$env:TIMESCALE_DATABASE_URL = "postgresql://<database-user>:<password>@127.0.0.1:5432/stuga"
node scripts/stuga-backup.mjs --database ./data/climate-twin.sqlite `
  --output ./backups/pre-upgrade `
  --include-timescale `
  --include-secrets --secrets-file ./data/integration-secrets.json
Remove-Item Env:TIMESCALE_DATABASE_URL
node scripts/stuga-backup.mjs --verify ./backups/pre-upgrade
```

This example again assumes a loopback-reachable database. `--include-timescale` accepts connection details through `TIMESCALE_DATABASE_URL`, `DATABASE_URL`, standard libpq `PG*` variables, or the corresponding Stuga `TIMESERIES_*` variables. It requires `pg_dump` plus `pg_restore` on `PATH` unless their paths are supplied explicitly. The verify command checks every manifest size and SHA-256, runs SQLite integrity checks, and inspects the PostgreSQL dump catalog. It does not perform a restore.

Before treating the set as recoverable:

1. Confirm `node scripts/stuga-backup.mjs --verify <backup-directory>` passes.
2. Encrypt the complete set and copy it to a protected off-host location.
3. Restore the SQLite snapshots as new files and the custom-format dump into a fresh PostgreSQL/TimescaleDB database.
4. Start an isolated API against the restored stores and check representative recent and historical queries.
5. Run migration `--verify-only` against the restored archive and its matching SQLite snapshot.

The SQLite snapshot includes its local archive cursors and stable archive source identity. It can therefore be paired with a later copy of the same Timescale archive: the worker starts from the lower local/remote cursor and safely replays rows through natural-key UPSERTs. This protects against checkpoint gaps; it cannot recreate telemetry absent from both restored stores, so backup frequency still defines the recovery point.

The manifest includes the restore sequence, but restoration is intentionally not automatic. Dumps preserve owner metadata: first bootstrap a separate empty target with matching PostgreSQL/TimescaleDB versions and the same recorded `stuga_admin`/`stuga_app` roles. Run the manifest's guarded `preRestoreSql`; it refuses a non-empty telemetry schema, removes only the empty bootstrap schema, and then calls `timescaledb_pre_restore()`. Restore serially with the recorded command. Do not add `--no-owner` and do not use parallel `-j` jobs. After `timescaledb_post_restore()` and `ANALYZE`, run the included fail-closed ownership validator; it checks the telemetry schema and relations, raw chunks, continuous-aggregate views, materialization hypertables, and their chunks are still owned by the least-privilege application role. Only then perform API/history checks and allow reconciliation. The backup CLI itself performs catalog inspection, not a live restore. The initial 2026-07-18 local cutover dump was additionally restored into a fresh network-isolated TimescaleDB 2.28.3/PostgreSQL 17 volume; row counts/ranges, rollups, ownership, and application-role reads passed before the temporary target was removed. Every later recovery point still needs its own scheduled restore drill. Never test by overwriting the only live volume, and never use `docker compose down -v` when the volumes contain the only copy of data.

## Capacity and routine operations

Estimate ingestion before choosing disk capacity:

```text
rows/day = sensors × metrics per sensor × (86,400 / sampling interval in seconds)
```

For example, 20 sensors reporting 3 metrics every 5 minutes produce 17,280 measurement rows/day, or about 6.3 million/year, before legacy readings, weather, prices, metadata, indexes, and WAL. Measure actual bytes per day after a representative month; row width and index overhead vary too much for a reliable universal byte estimate. Provision headroom for indexes, active chunks, WAL, maintenance, upgrades, and at least one local restore—not just raw values.

Useful checks include:

```powershell
docker compose ps
docker compose logs --tail 100 timescaledb api
docker compose exec timescaledb pg_isready -U stuga_admin -d stuga
docker compose exec timescaledb psql -U stuga_admin -d stuga -c "SELECT pg_size_pretty(pg_database_size(current_database()));"
```

Track database and per-table size, ingest lag, oldest/newest timestamp per series, failed archive batches, pool saturation, backup age, and restore-test age. Alert on disk growth rate rather than only a fixed free-space threshold. Run `ANALYZE` normally through PostgreSQL autovacuum, refresh historical rollups after large imports, and investigate query plans before adding indexes; every extra index increases ingest cost.

Backups are complete only after a successful restore. Keep at least one recent off-host copy and one older recovery point, and test the documented restore process on a schedule appropriate to the importance of the data.
