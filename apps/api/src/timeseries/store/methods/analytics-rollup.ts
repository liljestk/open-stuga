import type { QueryResultRow } from "pg";
import { orderedStateSeconds } from "@climate-twin/analytics-kernel";
import { RollupsMaterializingError } from "../../read-support.js";
import { MEASUREMENT_ANALYTICS_BUCKETS, type MeasurementAnalyticsBaseBucket } from "../../schema.js";
import type {
  MeasurementAnalyticsAggregation,
  MeasurementAnalyticsBucketRecord,
  MeasurementAnalyticsResolution,
  MeasurementAnalyticsRollupQuery,
  MeasurementAnalyticsRollupResult,
  MeasurementAnalyticsSeriesQuery,
  MeasurementAnalyticsSeriesRecord,
  MeasurementAnalyticsSummaryQuery,
  MeasurementAnalyticsSummaryResult,
} from "../../types.js";
import { timestamp } from "../support/query-values.js";
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

function resolutionSeconds(resolution: MeasurementAnalyticsResolution): number {
  if (resolution === "1d") return 86_400;
  if (resolution === "1h") return 3_600;
  return Number(/^(\d{1,4})m$/u.exec(resolution)?.[1]) * 60;
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
  /** Ordered reads only: the row belongs to the summary's base buckets. */
  summary_target?: boolean;
  /** Ordered reads only: the stored variant still has to be enqueued. */
  preparation_required?: boolean;
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

function numberOrDefault(value: string | number | null, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function seriesKey(series: { sensorId: string; metric: string }): string {
  return JSON.stringify([series.sensorId, series.metric]);
}

function isOrdered({ aggregation }: MeasurementAnalyticsSeriesQuery): boolean {
  return aggregation === "delta" || aggregation === "time_weighted_mean";
}

/**
 * Power integration may hold a sample for at most 15 minutes and a
 * time-weighted mean for at most an hour inside one stored state, so those
 * reads use states no wider than that even for day-wide display buckets.
 * The raw path applies the same widths (kernel `orderedStateSeconds`).
 */
function orderedSecondsFor(
  resolution: MeasurementAnalyticsResolution,
  series: readonly MeasurementAnalyticsSeriesQuery[],
): 60 | 900 | 3600 | 86400 {
  return orderedStateSeconds(resolutionSeconds(resolution), {
    power: series.some((item) => item.metric === "power"),
    timeWeighted: series.some((item) => item.aggregation === "time_weighted_mean"),
  });
}

function emptySeries(series: readonly MeasurementAnalyticsSeriesQuery[]): Map<string, MeasurementAnalyticsSeriesRecord> {
  return new Map(series.map((requested) => [seriesKey(requested), {
    sensorId: requested.sensorId,
    metric: requested.metric,
    canonicalUnit: "",
    sampleCount: 0,
    excludedSampleCount: 0,
    cadenceSeconds: 60,
    buckets: [],
  }]));
}

function bucketRecord(row: MeasurementAnalyticsRow & { bucket_start: string | Date }): MeasurementAnalyticsBucketRecord {
  return {
    bucketStart: timestamp(row.bucket_start),
    value: row.rollup_value === null ? null : numberOrDefault(row.rollup_value),
    ...(row.consumption_kwh !== undefined ? { consumptionKwh: row.consumption_kwh } : {}),
    minimum: row.minimum === null ? null : numberOrDefault(row.minimum),
    maximum: row.maximum === null ? null : numberOrDefault(row.maximum),
    sampleCount: numberOrDefault(row.bucket_sample_count),
    estimatedSampleCount: numberOrDefault(row.estimated_sample_count),
    staleSampleCount: numberOrDefault(row.stale_sample_count),
    counterResetCount: numberOrDefault(row.counter_reset_count),
  };
}

/** One record per series from the display rows, or from the summary rows. */
function seriesRecords(
  rows: readonly MeasurementAnalyticsRow[],
  series: readonly MeasurementAnalyticsSeriesQuery[],
  summaryTarget: boolean,
): MeasurementAnalyticsSeriesRecord[] {
  const bySeries = emptySeries(series);
  for (const row of rows) {
    const record = (row.summary_target === true) === summaryTarget
      ? bySeries.get(JSON.stringify([row.sensor_id, row.metric]))
      : undefined;
    if (!record) continue;
    record.canonicalUnit = row.canonical_unit ?? "";
    record.sampleCount = numberOrDefault(row.included_sample_count);
    record.excludedSampleCount = numberOrDefault(row.excluded_sample_count);
    record.cadenceSeconds = Math.max(1, numberOrDefault(row.cadence_seconds, 60));
    if (row.bucket_start === null) continue;
    if ((row.minimum === null || row.maximum === null) && row.consumption_kwh === undefined) continue;
    record.buckets.push(bucketRecord({ ...row, bucket_start: row.bucket_start }));
  }
  return [...bySeries.values()];
}

function assertReadableRows(rows: readonly MeasurementAnalyticsRow[], ordered: boolean): void {
  if (rows.some((row) => row.coverage_complete === false)) {
    if (ordered) throw new RollupsMaterializingError();
    throw new Error("Telemetry rollups are still materializing the requested history");
  }
  if (rows.some((row) => row.unit_consistent === false)) {
    throw new Error("Telemetry analytics found mixed canonical units in one series");
  }
}

function requestRows(
  series: readonly MeasurementAnalyticsSeriesQuery[],
  summary?: MeasurementAnalyticsSummaryQuery,
): string {
  const summaryKeys = new Set(summary?.series.map(seriesKey));
  return JSON.stringify(series.map((item) => ({
    sensor_id: item.sensorId,
    metric: item.metric,
    aggregation: item.aggregation,
    ...(summary && summaryKeys.has(seriesKey(item)) ? { summary_width: analyticsInterval(summary.resolution) } : {}),
  })));
}

async function executeMergeableRollup(
  store: TimeseriesStoreInternals,
  query: MeasurementAnalyticsRollupQuery,
  series: readonly MeasurementAnalyticsSeriesQuery[],
): Promise<MeasurementAnalyticsSeriesRecord[]> {
  if (series.length === 0) return [];
  const base = baseBucket(query.resolution);
  const result = await store.__query<MeasurementAnalyticsRow>(mergeableAnalyticsSql(store.schema, base), [
    requestRows(series),
    query.from,
    query.to,
    [...query.qualities],
    analyticsInterval(query.resolution),
    query.excludeSynthetic === true,
    MEASUREMENT_ANALYTICS_BUCKETS[base].interval,
  ], query);
  assertReadableRows(result.rows, false);
  return seriesRecords(result.rows, series, false);
}

interface OrderedRollupRead {
  query: MeasurementAnalyticsRollupQuery;
  series: readonly MeasurementAnalyticsSeriesQuery[];
  /** Summary series re-bucketed from the same stored variant in the same statement. */
  summary?: MeasurementAnalyticsSummaryQuery;
}

interface OrderedRollupRecords {
  series: MeasurementAnalyticsSeriesRecord[];
  summary: MeasurementAnalyticsSeriesRecord[];
}

async function executeOrderedRollup(
  store: TimeseriesStoreInternals,
  { query, series, summary }: OrderedRollupRead,
): Promise<OrderedRollupRecords> {
  if (series.length === 0) return { series: [], summary: [] };
  const mask = qualityMask(query.qualities);
  const sourceScope = query.excludeSynthetic === true ? "real" : "all";
  const orderedSeconds = orderedSecondsFor(query.resolution, series);
  const enqueue = (pending: readonly MeasurementAnalyticsSeriesQuery[]) => store.enqueueMeasurementOrderedRollups(
    pending,
    query.from,
    query.to,
    mask,
    sourceScope,
    orderedSeconds,
    query,
  );
  const result = await store.__query<MeasurementAnalyticsRow>(orderedAnalyticsSql(store.schema), [
    requestRows(series, summary),
    query.from,
    query.to,
    [...query.qualities],
    analyticsInterval(query.resolution),
    query.excludeSynthetic === true,
    mask,
    orderedSeconds,
  ], query).catch(async (error: unknown) => {
    // Without the read's plan, prepare the variants anyway so a read that
    // keeps failing still lets the worker materialize them.
    if (!query.signal?.aborted) await enqueue(series).catch(() => undefined);
    throw error;
  });
  // Reads write only when their stored variants are missing or not clean.
  const unprepared = new Set(result.rows.filter((row) => row.preparation_required === true)
    .map((row) => JSON.stringify([row.sensor_id, row.metric])));
  if (unprepared.size > 0) await enqueue(series.filter((item) => unprepared.has(seriesKey(item))));
  assertReadableRows(result.rows, true);
  return {
    series: seriesRecords(result.rows, series, false),
    summary: summary ? seriesRecords(result.rows, summary.series, true) : [],
  };
}

/**
 * Summary series the display statement could not serve: mergeable series use
 * a different continuous aggregate, and an ordered series whose base buckets
 * need a narrower stored variant cannot reuse the display states.
 */
async function readRemainingSummary(
  store: TimeseriesStoreInternals,
  query: MeasurementAnalyticsRollupQuery & { summary: MeasurementAnalyticsSummaryQuery },
  shared: readonly MeasurementAnalyticsSeriesRecord[],
): Promise<MeasurementAnalyticsSummaryResult | null> {
  const { summary } = query;
  const sharedKeys = new Set(shared.map(seriesKey));
  const remaining = {
    ...query,
    series: summary.series.filter((item) => !sharedKeys.has(seriesKey(item))),
    resolution: summary.resolution,
  };
  try {
    const [mergeable, ordered] = await Promise.all([
      executeMergeableRollup(store, remaining, remaining.series.filter((item) => !isOrdered(item))),
      executeOrderedRollup(store, { query: remaining, series: remaining.series.filter(isOrdered) }),
    ]);
    const records = new Map([...shared, ...mergeable, ...ordered.series].map((record) => [seriesKey(record), record]));
    return { resolution: summary.resolution, series: summary.series.map((item) => records.get(seriesKey(item))!) };
  } catch (error) {
    // Summaries are supporting statistics: a base read that is still
    // materializing or fails leaves them on the displayed points.
    if (query.signal?.aborted) throw error;
    return null;
  }
}

function assertSummarySubset(query: MeasurementAnalyticsRollupQuery): void {
  if (!query.summary) return;
  // Rejects an unsupported resolution before the read, which would otherwise
  // turn it into a silently missing summary.
  analyticsInterval(query.summary.resolution);
  const aggregations = new Map(query.series.map((item) => [seriesKey(item), item.aggregation]));
  if (query.summary.series.some((item) => aggregations.get(seriesKey(item)) !== item.aggregation)) {
    throw new RangeError("analytics summary series must be a subset of the rollup series");
  }
}

declare module "../core.js" {
  interface TimeseriesStoreInternals {
    measurementAnalyticsRollup(query: MeasurementAnalyticsRollupQuery): Promise<MeasurementAnalyticsRollupResult>;
  }

  interface TimeseriesStoreCore {
    measurementAnalyticsRollup(query: MeasurementAnalyticsRollupQuery): Promise<MeasurementAnalyticsRollupResult>;
  }
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
      const key = seriesKey(series);
      if (keys.has(key)) throw new RangeError("analytics rollup series must be unique");
      keys.add(key);
    }
    assertSummarySubset(query);
    const ordered = query.series.filter(isOrdered);
    const orderedSummary = query.summary?.series.filter(isOrdered) ?? [];
    // Display and summary buckets share one ordered pass when both read the
    // same stored variant; only the re-bucketing width differs.
    const sharedSummary = query.summary && orderedSummary.length > 0
      && orderedSecondsFor(query.summary.resolution, orderedSummary) === orderedSecondsFor(query.resolution, ordered)
      ? { resolution: query.summary.resolution, series: orderedSummary }
      : undefined;
    const [mergeableRecords, orderedRecords] = await Promise.all([
      executeMergeableRollup(this, query, query.series.filter((item) => !isOrdered(item))),
      executeOrderedRollup(this, { query, series: ordered, ...(sharedSummary ? { summary: sharedSummary } : {}) }),
    ]);
    const records = new Map([...mergeableRecords, ...orderedRecords.series].map((record) => [seriesKey(record), record]));
    const series = query.series.map((item) => records.get(seriesKey(item))!);
    if (!query.summary) return { series };
    return { series, summary: await readRemainingSummary(this, { ...query, summary: query.summary }, orderedRecords.summary) };
  },
});
