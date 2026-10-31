import { hourlyUsageFromRows } from "../../../electricity/hourly-usage.js";
import type { QueryResultRow } from "pg";
import { MEASUREMENT_ANALYTICS_BUCKETS, MEASUREMENT_BUCKETS, measurementAnalyticsAggregateName, measurementAggregateName, qualifiedName } from "../../schema.js";
import type { AggregateRefreshQuery, EnergyCostAggregateQuery, EnergyCostAggregateRecord, MeasurementAnalyticsSeriesQuery, PowerCostAggregateQuery } from "../../types.js";
import { RollupsMaterializingError } from "../../read-support.js";
import { EnergyCostAggregateRow, ExtensionRow } from "../support/row-types.js";
import { abortError, timestamp } from "../support/query-values.js";
import { registerTimeseriesStoreMethods, timeseriesStoreState, type TimeseriesStoreInternals } from "../core.js";
import { measurementCostRollupRequirementsSql, measurementCostRollupSql } from "../measurement-cost-rollup-sql.js";
import { postgresErrorCode } from "./connection.js";

const DAY_MS = 86_400_000;

interface CostRollupRequirementRow extends QueryResultRow {
  day_start: string | Date;
  bucket_seconds: string | number;
  ready: boolean;
}

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

/**
 * The active day's sealed quarter states only shorten the raw tail, so a
 * reader asks for them to be kept current but never waits for them.
 */
async function enqueueActiveDayStates(
  store: TimeseriesStoreInternals,
  series: readonly MeasurementAnalyticsSeriesQuery[],
  query: EnergyCostAggregateQuery,
): Promise<void> {
  const activeDayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  if (Date.parse(query.to) <= activeDayStart) return;
  await store.enqueueMeasurementOrderedRollups(
    series,
    new Date(Math.max(Date.parse(query.from), activeDayStart)).toISOString(),
    query.to,
    3,
    query.excludeSynthetic === true ? "real" : "all",
    900,
    query,
  );
}

async function orderedCostAggregate(
  store: TimeseriesStoreInternals,
  query: EnergyCostAggregateQuery,
  metric: "energy" | "power",
): Promise<EnergyCostAggregateRecord> {
  const series = [{
    sensorId: query.sensorId,
    metric,
    aggregation: metric === "energy" ? "delta" as const : "time_weighted_mean" as const,
  }];
  const parameters = [
    query.sensorId, query.from, query.to, query.propertyId, Boolean(query.excludeSynthetic),
  ];
  const requirements = await store.__query<CostRollupRequirementRow>(
    measurementCostRollupRequirementsSql(store.schema),
    [...parameters, metric],
    query,
  );
  const byBucket = new Map<60 | 900 | 3600, string[]>();
  for (const row of requirements.rows) {
    const bucketSeconds = Number(row.bucket_seconds);
    if (bucketSeconds !== 60 && bucketSeconds !== 900 && bucketSeconds !== 3600) {
      throw new Error("Telemetry cost planner returned an invalid ordered-state resolution");
    }
    const days = byBucket.get(bucketSeconds) ?? [];
    days.push(new Date(row.day_start).toISOString());
    byBucket.set(bucketSeconds, days);
  }
  for (const bucketSeconds of [3600, 900, 60] as const) {
    const days = byBucket.get(bucketSeconds);
    if (!days?.length) continue;
    await store.enqueueMeasurementOrderedRollups(
      series,
      query.from,
      query.to,
      3,
      query.excludeSynthetic === true ? "real" : "all",
      bucketSeconds,
      query,
      days,
    );
  }
  await enqueueActiveDayStates(store, series, query);
  // Do not run the full pricing join just to discover known unfinished work.
  if (requirements.rows.some((row) => row.ready === false)) throw new RollupsMaterializingError();
  const result = await store.__query<EnergyCostAggregateRow>(
    measurementCostRollupSql(store.schema, metric),
    [...parameters, metric],
    query,
  );
  const row = result.rows[0];
  if (!row || row.coverage_complete !== true) {
    throw new RollupsMaterializingError();
  }
  return {
    deltaCount: Number(row.delta_count ?? 0),
    consumptionKwh: Number(row.consumption_kwh ?? 0),
    pricedConsumptionKwh: Number(row.priced_consumption_kwh ?? 0),
    spotCostEur: Number(row.cost_eur ?? 0),
    hourly: hourlyUsageFromRows(row.hourly),
    totalDurationMs: Number(row.total_duration_ms ?? 0),
    pricedDurationMs: Number(row.priced_duration_ms ?? 0),
    maximumIntervalDurationMs: Number(row.maximum_interval_duration_ms ?? 0),
    coverageFrom: row.coverage_from === null ? null : timestamp(row.coverage_from),
    coverageUntil: row.coverage_until === null ? null : timestamp(row.coverage_until),
  };
}

declare module "../core.js" {
  interface TimeseriesStoreInternals {
    energyCostAggregate(query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord>;
    powerCostAggregate(query: PowerCostAggregateQuery): Promise<EnergyCostAggregateRecord>;
    refreshMeasurementAggregates(query?: AggregateRefreshQuery): Promise<number>;
  }

  interface TimeseriesStoreCore {
    energyCostAggregate(query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord>;
    powerCostAggregate(query: PowerCostAggregateQuery): Promise<EnergyCostAggregateRecord>;
    refreshMeasurementAggregates(query?: AggregateRefreshQuery): Promise<number>;
  }
}

registerTimeseriesStoreMethods({
  async energyCostAggregate(
    this: TimeseriesStoreInternals,
    query: EnergyCostAggregateQuery,
  ): Promise<EnergyCostAggregateRecord> {
      return this[timeseriesStoreState].costWorkLimiter.run(
        "energy-cost-rollup",
        () => orderedCostAggregate(this, query, "energy"),
        query.signal,
      );
    },
  async powerCostAggregate(
    this: TimeseriesStoreInternals,
    query: PowerCostAggregateQuery,
  ): Promise<EnergyCostAggregateRecord> {
      return this[timeseriesStoreState].costWorkLimiter.run(
        "power-cost-rollup",
        () => orderedCostAggregate(this, query, "power"),
        query.signal,
      );
    },
  /** Refreshes mergeable Timescale rollups after a historical import. */
  async refreshMeasurementAggregates(this: TimeseriesStoreInternals, query: AggregateRefreshQuery = {}): Promise<number> {
      const extension = await this.__query<ExtensionRow>(`SELECT (
        SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'
      ) AS timescale_version`, [], query);
      if (!extension.rows[0]?.timescale_version) return 0;

      let refreshed = 0;
      for (const bucket of Object.keys(MEASUREMENT_BUCKETS) as Array<keyof typeof MEASUREMENT_BUCKETS>) {
        const aggregate = measurementAggregateName(bucket);
        if (!await this.__isContinuousAggregate(aggregate, query)) continue;
        await refreshContinuousAggregate(this, aggregate, query);
        refreshed += 1;
      }
      for (const bucket of Object.keys(MEASUREMENT_ANALYTICS_BUCKETS) as Array<keyof typeof MEASUREMENT_ANALYTICS_BUCKETS>) {
        const aggregate = measurementAnalyticsAggregateName(bucket);
        if (!await this.__isContinuousAggregate(aggregate, query)) continue;
        await refreshContinuousAggregate(this, aggregate, query);
        refreshed += 1;
      }
      return refreshed;
    },
});
