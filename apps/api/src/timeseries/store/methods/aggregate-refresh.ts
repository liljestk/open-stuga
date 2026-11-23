import type { PoolClient } from "pg";
import {
  buildMeasurementAnalyticsAggregateSql,
  MEASUREMENT_ANALYTICS_BUCKETS,
  MEASUREMENT_BUCKETS,
  measurementAnalyticsAggregateName,
  measurementAggregateName,
  qualifiedName,
  quoteIdentifier,
  type MeasurementAnalyticsBaseBucket,
} from "../../schema.js";
import type { AggregateRefreshQuery } from "../../types.js";
import type { ExtensionRow } from "../support/row-types.js";
import { abortError, timestamp } from "../support/query-values.js";
import { registerTimeseriesStoreMethods, type TimeseriesStoreInternals } from "../core.js";
import { postgresErrorCode } from "./connection.js";
import { freshnessReady, requestedFullUtcDaysSql, verifiedAggregateFreshnessSql } from "../verified-aggregate-freshness.js";

type VerifiedRefresh = Extract<AggregateRefreshQuery, { scope: "verified" }>;
type VerifiedRefreshSession = VerifiedRefresh & { client: PoolClient };

interface FreshnessSnapshotRow {
  day_start: string;
  revision: string;
  generation: string;
  delete_epoch: string;
}

const analyticsBuckets = Object.keys(MEASUREMENT_ANALYTICS_BUCKETS) as MeasurementAnalyticsBaseBucket[];

async function refreshContinuousAggregate(
  store: TimeseriesStoreInternals,
  aggregate: string,
  query: AggregateRefreshQuery,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await store.__query(
        "CALL refresh_continuous_aggregate($1::REGCLASS, $2::TIMESTAMPTZ, $3::TIMESTAMPTZ)",
        [qualifiedName(store.schema, aggregate), query.from ?? null, query.to ?? null],
        query,
      );
      return;
    } catch (error) {
      if (postgresErrorCode(error) !== "55P03" || attempt >= 6) throw error;
      await new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          query.signal?.removeEventListener("abort", cancel);
          resolve();
        };
        const cancel = (): void => {
          clearTimeout(timer);
          reject(abortError(query.signal!));
        };
        const timer = setTimeout(finish, Math.min(2_000, 100 * 2 ** attempt));
        timer.unref();
        query.signal?.addEventListener("abort", cancel, { once: true });
      });
    }
  }
}

async function prepareFreshness(store: TimeseriesStoreInternals, query: VerifiedRefreshSession): Promise<FreshnessSnapshotRow[]> {
  const days = qualifiedName(store.schema, "verified_measurement_aggregate_days");
  const generation = qualifiedName(store.schema, "stugu_archive_generation");
  const epoch = qualifiedName(store.schema, "verified_measurement_aggregate_epoch");
  if (!await freshnessReady(store, query)) {
    await store.__query(verifiedAggregateFreshnessSql(store.schema), [], query);
  }

  // The conflict write waits for any earlier mutation of a covered day.
  // Separate statements make its committed revision visible to the snapshot.
  await store.__query(`INSERT INTO ${days} (day_start) ${requestedFullUtcDaysSql}
    ORDER BY day_start ON CONFLICT (day_start) DO UPDATE SET archive_generation = NULL`, [query.from, query.to], query);
  return (await store.__query<FreshnessSnapshotRow>(`WITH requested_days AS (${requestedFullUtcDaysSql})
    SELECT to_char(day_start, 'YYYY-MM-DD') AS day_start, day.revision, archive.generation, epoch.revision AS delete_epoch
    FROM ${days} day JOIN requested_days USING (day_start)
    JOIN ${generation} archive ON archive.id = 1 JOIN ${epoch} epoch ON epoch.id = 1`,
  [query.from, query.to], query)).rows;
}

async function publishFreshness(store: TimeseriesStoreInternals, input: {
  query: VerifiedRefreshSession; snapshot: FreshnessSnapshotRow[];
}): Promise<void> {
  if (input.snapshot.length === 0) return;
  const days = qualifiedName(store.schema, "verified_measurement_aggregate_days");
  const generation = qualifiedName(store.schema, "stugu_archive_generation");
  const epoch = qualifiedName(store.schema, "verified_measurement_aggregate_epoch");
  await store.__query(`UPDATE ${days} AS day SET archive_generation = snapshot.generation, delete_epoch = snapshot.delete_epoch
    FROM jsonb_to_recordset($1::JSONB) AS snapshot(day_start DATE, revision UUID, generation UUID, delete_epoch UUID)
    JOIN ${generation} AS current ON current.id = 1 AND current.generation = snapshot.generation
    JOIN ${epoch} AS epoch ON epoch.id = 1 AND epoch.revision = snapshot.delete_epoch
    WHERE day.day_start = snapshot.day_start AND day.revision = snapshot.revision`,
  [JSON.stringify(input.snapshot)], input.query);
}

async function refreshVerifiedWindows(store: TimeseriesStoreInternals, query: VerifiedRefreshSession): Promise<number> {
  // Timescale refreshes whole buckets. Expand a caller's range to cover both edges.
  for (const bucket of analyticsBuckets) {
    query.signal?.throwIfAborted();
    const name = measurementAnalyticsAggregateName(bucket, "verified");
    if (!await store.__isContinuousAggregate(name, query)) {
      await store.__query(buildMeasurementAnalyticsAggregateSql(store.schema, bucket, "verified"), [], query);
      if (!await store.__isContinuousAggregate(name, query)) {
        throw new Error(`Could not provision verified telemetry aggregate ${name}`);
      }
    }
    await store.__query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${name}_series_mode_idx`)}
      ON ${qualifiedName(store.schema, name)} (sensor_id, metric, data_mode, bucket_start DESC)`, [], query);
    const bounds = await store.__query<{ from: string | Date; to: string | Date }>(`SELECT
      date_bin($3::INTERVAL, $1::TIMESTAMPTZ AT TIME ZONE 'UTC',
        TIMESTAMP '1970-01-01 00:00:00') AT TIME ZONE 'UTC' AS "from",
      (date_bin($3::INTERVAL, ($2::TIMESTAMPTZ AT TIME ZONE 'UTC') - INTERVAL '1 microsecond',
        TIMESTAMP '1970-01-01 00:00:00') + $3::INTERVAL) AT TIME ZONE 'UTC' AS "to"`,
      [query.from, query.to, MEASUREMENT_ANALYTICS_BUCKETS[bucket].interval], query);
    const window = bounds.rows[0]!;
    await refreshContinuousAggregate(store, name, {
      ...query, from: timestamp(window.from), to: timestamp(window.to),
    });
  }
  return analyticsBuckets.length;
}

async function refreshVerifiedAggregates(store: TimeseriesStoreInternals, query: VerifiedRefresh): Promise<number> {
  const client = await store.__connect(query.signal);
  try {
    const session = { ...query, client };
    // A session lock covers the independent Timescale refresh transactions.
    await store.__query("SELECT pg_advisory_lock(hashtextextended($1, 0))",
      [`stugu:verified-aggregate-refresh:${store.schema}`], session);
    const snapshot = await prepareFreshness(store, session);
    const refreshed = await refreshVerifiedWindows(store, session);
    await publishFreshness(store, { query: session, snapshot });
    return refreshed;
  } finally {
    // Closing the session releases the lock even after a cancelled command.
    client.release(true);
  }
}

declare module "../core.js" {
  interface TimeseriesStoreInternals {
    refreshMeasurementAggregates(query?: AggregateRefreshQuery): Promise<number>;
  }

  interface TimeseriesStoreCore {
    refreshMeasurementAggregates(query?: AggregateRefreshQuery): Promise<number>;
  }
}

registerTimeseriesStoreMethods({
  /** Refresh compatibility rollups or explicitly prepare and refresh verified aggregates. */
  async refreshMeasurementAggregates(this: TimeseriesStoreInternals, query: AggregateRefreshQuery = {}): Promise<number> {
    if (query.scope === "verified") {
      const from = Date.parse(query.from);
      const to = Date.parse(query.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
        throw new RangeError("Verified aggregate refresh requires a finite, increasing range");
      }
    }
    const extension = await this.__query<ExtensionRow>(`SELECT (
      SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'
    ) AS timescale_version`, [], query);
    if (!extension.rows[0]?.timescale_version) return 0;
    if (query.scope === "verified") return refreshVerifiedAggregates(this, query);

    const aggregates = [
      ...(Object.keys(MEASUREMENT_BUCKETS) as Array<keyof typeof MEASUREMENT_BUCKETS>).map(measurementAggregateName),
      ...analyticsBuckets.map((bucket) => measurementAnalyticsAggregateName(bucket)),
    ];
    let refreshed = 0;
    for (const name of aggregates) {
      if (!await this.__isContinuousAggregate(name, query)) continue;
      await refreshContinuousAggregate(this, name, query);
      refreshed += 1;
    }
    return refreshed;
  },
});
