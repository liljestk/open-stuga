# Lossless telemetry scale plan

Implementation status: complete locally for v0.28.0; not deployed to
`192.168.100.17`.

## Evidence and target

- Live v0.25.1 has about 563k raw measurement rows (about 204 MB); one power
  series has about 310k rows in 13 days.
- Six concurrent full-history ordered aggregates exhausted the six-connection
  API pool and timed out. This was a query-path failure, not a failed build.
- Design for at least 1,000 times today's total sample count on Pi-class
  hardware while retaining every original sample and its timestamp, source,
  quality, unit, and metadata.

## Non-negotiable invariants

1. Timescale raw rows are the permanent, lossless source of truth. Startup fails
   if a raw retention job exists.
2. Interactive work is bounded by requested series, time buckets, and response
   limits; it never silently falls back to a full historical raw scan.
3. Derived states, continuous aggregates, and response caches are versioned and
   rebuildable. A stale accelerator produces a retryable unavailable response.
4. SQLite outbox history is removed only after durable TimeDB acknowledgement.
5. PostgreSQL live data stays on local block storage. NAS and encrypted R2 are
   recovery tiers, not live PGDATA or transparent query tiers.

## Storage and query architecture

- Use one-day chunks for high-rate raw indoor measurements/readings and move
  closed chunks to Timescale columnstore after seven days. Other telemetry uses
  30- or 90-day chunks appropriate to its rate. This changes representation,
  never granularity or retention.
- Maintain quality/source/unit-aware continuous aggregates at 1m, 5m, 1h, and
  1d, with mandatory refresh and optional columnstore policies. Initialization
  fails and retries if every refresh policy is not installed. Mean, sum, min,
  max, and last read these states plus only partial raw edges.
- Maintain exact ordered states for counter delta/reset semantics and
  time-weighted values. States are keyed by series, UTC day, resolution,
  quality mask, source scope, generation, and algorithm version.
- Writes increment a per-day generation ledger. A single low-priority worker
  claims dirty variants with leases, rebuilds outside the publication lock, and
  publishes only if the generation is still current. Late data cannot race a
  stale state into visibility.
- Cost planning adapts to the tariff timeline: price-stable hours use 1h states,
  affected hours use 15m states, and affected quarters use 1m states. Partial
  minutes, off-minute price edges, and the active UTC day remain bounded raw.
  Internal and cross-state energy are priced through a set-based hourly slice
  relation; query cost is proportional to time buckets, not raw samples.
- Limit expensive analytics to a dedicated two-query lane below the database
  pool size. Limit Timescale policy execution to three concurrent jobs plus its
  scheduler. Coalesce/cache safe reads with entry, byte, and TTL limits.
- Raw history uses an opaque `(observed_at, source)` keyset cursor. Browser
  exports stop at 50,000 rows; complete recovery uses backups.

## Capacity, backup, and alerts

- `STUGA_TIMESERIES_DATA_SOURCE` accepts a named volume or absolute local SSD
  path. Do not put PostgreSQL on ordinary SMB/NFS storage.
- `STUGA_SCHEDULED_BACKUP_SOURCE` accepts a named volume or mounted NAS path for
  verified recovery sets. The existing R2 path encrypts verified sets with age
  before upload and remains independently restorable.
- Owners/Admins can configure both through System → Storage and the trusted
  host-agent queue. Host paths are restricted by `STUGA_STORAGE_ALLOWED_ROOTS`;
  NAS is recovery-only and protected by a live-mount sentinel. Primary moves
  are backup/restore-drill/copy/verify transactions with durable crash recovery,
  never direct remounts.
- Before `pg_dump`, require destination free space of at least the logical
  database size plus `BACKUP_MIN_FREE_BYTES` (default 1 GiB).
- Persist filesystem samples and forecast exhaustion. Warn at 85% used, 5 GiB
  free, or a credible 30-day forecast; go critical at 95%, 1 GiB, or seven days.
  Emit recovery transitions through the normal durable notification/Telegram
  path.
- Full dumps are the current recovery mechanism. When dump duration or staging
  capacity no longer meets the recovery objective, add tested incremental/WAL
  backup; do not solve that by deleting raw telemetry.

## Other growth controls

- Fresh generated configuration compacts acknowledged SQLite telemetry to a
  30-day hot duplicate. An existing unset setting remains backwards-compatible;
  `RETENTION_DAYS=0` deliberately retains the complete duplicate.
- Bound caches, error logs, notification/command outboxes, replay receipts,
  temporary files, and completed job history by age and/or count while retaining
  authoritative audit/revision records.
- Notification delivery payloads are retained for 180 days after delivery;
  retryable dead-letter/abandoned records are retained for 365 days. Pending
  deliveries and authoritative alert/audit history are never pruned by this job.
- Report database/component sizes, pool waits, query duration, filesystem free
  space, growth history, and forecast through authenticated health/system views.

## Rollout gates

1. Back up and restore-test SQLite, assets/secrets, and Timescale before upgrade.
2. Upgrade in maintenance mode and let idempotent initialization install and
   validate hypertables, policies, CAGGs, and ordered-state tables.
3. Verify that no raw retention job exists and that refresh/columnstore jobs are
   scheduled.
4. Backfill/refresh accelerators with low concurrency; raw ingestion continues
   independently and ordered queries fail boundedly while materializing.
5. Compare representative exact raw and accelerated results, then monitor pool
   waits, ingest lag, dirty-state backlog, storage forecast, and backup age.

## Acceptance evidence

- Fresh TimescaleDB 2.28.3/PostgreSQL 17 schema: seven hypertables, seven CAGGs,
  21 policies, and zero raw retention jobs.
- Exact integration covers 22,601 raw samples, counter reset, off-minute tariff
  boundary, aligned endpoints, and a Europe/Helsinki database timezone.
- A one-year flat-price query reads 8,760 hourly states instead of 525,600
  minute states; it remains bounded with deliberately absent table statistics.
- Full API/web/tooling tests, type checks, architecture checks, and backup tests
  must pass before deployment.
