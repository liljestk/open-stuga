import type { QueryResultRow } from "pg";
import { MEASUREMENT_ANALYTICS_BUCKETS, type MeasurementAnalyticsBaseBucket } from "../../schema.js";
import type {
  MeasurementAnalyticsAggregation,
  MeasurementAnalyticsRollupQuery,
  MeasurementAnalyticsRollupResult,
  MeasurementAnalyticsSeriesQuery,
  MeasurementAnalyticsSeriesRecord,
  MeasurementAnalyticsResolution,
} from "../../types.js";
import { timestamp } from "../support/01-default-schema-to-measurement-bucket-from-row.js";
import { registerTimeseriesStoreMethods, type TimeseriesStoreInternals } from "../core.js";
import { mergeableAnalyticsSql, orderedAnalyticsSql } from "../measurement-analytics-rollup-sql.js";

function analyticsInterval(resolution: MeasurementAnalyticsResolution): string {
  if (resolution === "1h") return "1 hour";
  if (resolution === "1d") return "1 day";
  const minutes = Number(/^(\d{1,4})m$/u.exec(resolution)?.[1]);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1_440) {
    throw new RangeError("invalid analytics rollup resolution");
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function baseBucket(resolution: MeasurementAnalyticsResolution): MeasurementAnalyticsBaseBucket {
  if (resolution === "1d") return "1d";
  if (resolution === "1h") return "1h";
  const minutes = Number(/^(\d{1,4})m$/u.exec(resolution)?.[1]);
  if (minutes === 1_440) return "1d";
  if (minutes >= 60 && minutes % 60 === 0) return "1h";
  if (minutes >= 5 && minutes % 5 === 0) return "5m";
  return "1m";
}

function orderedBucketSeconds(resolution: MeasurementAnalyticsResolution): 60 | 900 | 3600 | 86400 {
  if (resolution === "1d") return 86_400;
  if (resolution === "1h") return 3_600;
  const minutes = Number(/^(\d{1,4})m$/u.exec(resolution)?.[1]);
  if (minutes % 1_440 === 0) return 86_400;
  if (minutes % 60 === 0) return 3_600;
  if (minutes % 15 === 0) return 900;
  return 60;
}

function qualityMask(qualities: readonly string[]): number {
  return qualities.reduce((mask, quality) => (
    mask | (quality === "good" ? 1 : quality === "estimated" ? 2 : quality === "stale" ? 4 : 0)
  ), 0);
}

const ANALYTICS_AGGREGATIONS = new Set<MeasurementAnalyticsAggregation>([
  "mean", "sum", "delta", "last", "time_weighted_mean", "min", "max",
]);

interface MeasurementAnalyticsRow extends QueryResultRow {
  sensor_id: string;
  metric: string;
  canonical_unit: string | null;
  unit_consistent?: boolean;
  coverage_complete?: boolean;
  included_sample_count: string | number;
  excluded_sample_count: string | number;
  cadence_seconds: string | number;
  bucket_start: string | Date | null;
  rollup_value: number | null;
  consumption_kwh?: number | null;
  minimum: number | null;
  maximum: number | null;
  bucket_sample_count: string | number | null;
  estimated_sample_count: string | number | null;
  stale_sample_count: string | number | null;
  counter_reset_count: string | number | null;
}

function finiteNumber(value: string | number | null, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function emptySeries(series: readonly MeasurementAnalyticsSeriesQuery[]): Map<string, MeasurementAnalyticsSeriesRecord> {
  return new Map(series.map((requested) => [JSON.stringify([requested.sensorId, requested.metric]), {
    sensorId: requested.sensorId,
    metric: requested.metric,
    canonicalUnit: "",
    sampleCount: 0,
    excludedSampleCount: 0,
    cadenceSeconds: 60,
    buckets: [],
  }]));
}

async function executeRollup(
  store: TimeseriesStoreInternals,
  query: MeasurementAnalyticsRollupQuery,
  series: readonly MeasurementAnalyticsSeriesQuery[],
  ordered: boolean,
): Promise<MeasurementAnalyticsSeriesRecord[]> {
  if (series.length === 0) return [];
  const mask = qualityMask(query.qualities);
  const sourceScope = query.excludeSynthetic === true ? "real" : "all";
  // Power integration may hold a sample for at most 15 minutes. Keeping the
  // stored state no wider than that makes its internal integral exact even
  // when the requested display buckets span a day.
  const orderedSeconds = series.some((item) => item.metric === "power")
    ? Math.min(900, orderedBucketSeconds(query.resolution)) as 60 | 900
    : orderedBucketSeconds(query.resolution);
  if (ordered) {
    await store.enqueueMeasurementOrderedRollups(
      series,
      query.from,
      query.to,
      mask,
      sourceScope,
      orderedSeconds,
      query,
    );
  }
  const targetInterval = analyticsInterval(query.resolution);
  const base = baseBucket(query.resolution);
  const sql = ordered ? orderedAnalyticsSql(store.schema) : mergeableAnalyticsSql(store.schema, base);
  const seventhParameter = ordered ? mask : MEASUREMENT_ANALYTICS_BUCKETS[base].interval;
  const result = await store.__query<MeasurementAnalyticsRow>(sql, [
    JSON.stringify(series.map((item) => ({
      sensor_id: item.sensorId,
      metric: item.metric,
      aggregation: item.aggregation,
    }))),
    query.from,
    query.to,
    [...query.qualities],
    targetInterval,
    query.excludeSynthetic === true,
    seventhParameter,
    ...(ordered ? [orderedSeconds] : []),
  ], query);

  if (result.rows.some((row) => row.coverage_complete === false)) {
    throw new Error("Telemetry rollups are still materializing the requested history");
  }
  if (result.rows.some((row) => row.unit_consistent === false)) {
    throw new Error("Telemetry analytics found mixed canonical units in one series");
  }
  const bySeries = emptySeries(series);
  for (const row of result.rows) {
    const record = bySeries.get(JSON.stringify([row.sensor_id, row.metric]));
    if (!record) continue;
    record.canonicalUnit = row.canonical_unit ?? "";
    record.sampleCount = finiteNumber(row.included_sample_count);
    record.excludedSampleCount = finiteNumber(row.excluded_sample_count);
    record.cadenceSeconds = Math.max(1, finiteNumber(row.cadence_seconds, 60));
    if (row.bucket_start === null) continue;
    if ((row.minimum === null || row.maximum === null) && row.consumption_kwh === undefined) continue;
    record.buckets.push({
      bucketStart: timestamp(row.bucket_start),
      value: row.rollup_value === null ? null : finiteNumber(row.rollup_value),
      ...(row.consumption_kwh !== undefined ? { consumptionKwh: row.consumption_kwh } : {}),
      minimum: row.minimum === null ? null : finiteNumber(row.minimum),
      maximum: row.maximum === null ? null : finiteNumber(row.maximum),
      sampleCount: finiteNumber(row.bucket_sample_count),
      estimatedSampleCount: finiteNumber(row.estimated_sample_count),
      staleSampleCount: finiteNumber(row.stale_sample_count),
      counterResetCount: finiteNumber(row.counter_reset_count),
    });
  }
  return [...bySeries.values()];
}

registerTimeseriesStoreMethods({
  async measurementAnalyticsRollup(
    this: TimeseriesStoreInternals,
    query: MeasurementAnalyticsRollupQuery,
  ): Promise<MeasurementAnalyticsRollupResult> {
    if (query.series.length === 0) return { series: [] };
    if (query.series.length > 400) throw new RangeError("analytics rollups support at most 400 series");
    if (query.qualities.length === 0 || query.qualities.length > 3 || qualityMask(query.qualities) === 0) {
      throw new RangeError("analytics rollups require between 1 and 3 known quality values");
    }
    const keys = new Set<string>();
    for (const series of query.series) {
      if (!series.sensorId || !series.metric || !ANALYTICS_AGGREGATIONS.has(series.aggregation)) {
        throw new RangeError("invalid analytics rollup series");
      }
      const key = JSON.stringify([series.sensorId, series.metric]);
      if (keys.has(key)) throw new RangeError("analytics rollup series must be unique");
      keys.add(key);
    }
    const ordered = query.series.filter(({ aggregation }) => (
      aggregation === "delta" || aggregation === "time_weighted_mean"
    ));
    const mergeable = query.series.filter((item) => !ordered.includes(item));
    const [mergeableRecords, orderedRecords] = await Promise.all([
      executeRollup(this, query, mergeable, false),
      executeRollup(this, query, ordered, true),
    ]);
    const records = new Map([...mergeableRecords, ...orderedRecords].map((record) => [
      JSON.stringify([record.sensorId, record.metric]), record,
    ]));
    return { series: query.series.map((item) => records.get(JSON.stringify([item.sensorId, item.metric]))!) };
  },
});
