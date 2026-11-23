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

type VerifiedRefresh = Extract<AggregateRefreshQuery, { scope: "verified" }>;

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

async function refreshVerifiedAggregates(store: TimeseriesStoreInternals, query: VerifiedRefresh): Promise<number> {
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
