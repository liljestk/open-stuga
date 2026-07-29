import type { QueryResultRow } from "pg";
import type {
  MeasurementAnalyticsAggregation,
  MeasurementAnalyticsRollupQuery,
  MeasurementAnalyticsRollupResult,
  MeasurementAnalyticsSeriesRecord,
  MeasurementAnalyticsResolution,
} from "../../types.js";
import { qualifiedName } from "../../schema.js";
import { timestamp } from "../support/01-default-schema-to-measurement-bucket-from-row.js";
import { registerTimeseriesStoreMethods, type TimeseriesStoreInternals } from "../core.js";

const ANALYTICS_INTERVALS: Readonly<Record<MeasurementAnalyticsResolution, string>> = {
  "1m": "1 minute",
  "5m": "5 minutes",
  "15m": "15 minutes",
  "1h": "1 hour",
  "1d": "1 day",
};

const ANALYTICS_AGGREGATIONS = new Set<MeasurementAnalyticsAggregation>([
  "mean",
  "sum",
  "delta",
  "last",
  "time_weighted_mean",
  "min",
  "max",
]);

interface MeasurementAnalyticsRow extends QueryResultRow {
  sensor_id: string;
  metric: string;
  canonical_unit: string | null;
  included_sample_count: string | number;
  excluded_sample_count: string | number;
  cadence_seconds: string | number;
  bucket_start: string | Date | null;
  rollup_value: number | null;
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

registerTimeseriesStoreMethods({
  async measurementAnalyticsRollup(
    this: TimeseriesStoreInternals,
    query: MeasurementAnalyticsRollupQuery,
  ): Promise<MeasurementAnalyticsRollupResult> {
    if (query.series.length === 0) return { series: [] };
    if (query.series.length > 400) throw new RangeError("analytics rollups support at most 400 series");
    if (query.qualities.length === 0 || query.qualities.length > 3) {
      throw new RangeError("analytics rollups require between 1 and 3 quality values");
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
    const interval = ANALYTICS_INTERVALS[query.resolution];
    const measurements = qualifiedName(this.schema, "measurement_samples");
    const result = await this.__query<MeasurementAnalyticsRow>(`WITH requested_series AS (
        SELECT DISTINCT sensor_id, metric, aggregation
        FROM jsonb_to_recordset($1::JSONB)
          AS requested(sensor_id TEXT, metric TEXT, aggregation TEXT)
      ), scoped AS (
        SELECT sample.sensor_id, sample.metric, sample.observed_at, sample.value,
          sample.canonical_unit, sample.source, sample.quality, sample.ingested_at,
          requested.aggregation
        FROM ${measurements} AS sample
        JOIN requested_series AS requested
          ON requested.sensor_id = sample.sensor_id AND requested.metric = sample.metric
        WHERE sample.observed_at >= $2::TIMESTAMPTZ
          AND sample.observed_at < $3::TIMESTAMPTZ
          AND (NOT $6::BOOLEAN OR sample.source NOT IN ('mock', 'replay'))
      ), series_counts AS (
        SELECT requested.sensor_id, requested.metric, requested.aggregation,
          COALESCE(MIN(scoped.canonical_unit) FILTER (
            WHERE scoped.quality = ANY($4::TEXT[])
          ), '') AS canonical_unit,
          COUNT(scoped.observed_at) FILTER (
            WHERE scoped.quality = ANY($4::TEXT[])
          )::BIGINT AS included_sample_count,
          COUNT(scoped.observed_at) FILTER (
            WHERE scoped.observed_at IS NOT NULL
              AND NOT (scoped.quality = ANY($4::TEXT[]))
          )::BIGINT AS excluded_sample_count
        FROM requested_series AS requested
        LEFT JOIN scoped
          ON scoped.sensor_id = requested.sensor_id AND scoped.metric = requested.metric
        GROUP BY requested.sensor_id, requested.metric, requested.aggregation
      ), included AS (
        SELECT * FROM scoped WHERE quality = ANY($4::TEXT[])
      ), distinct_times AS (
        SELECT DISTINCT sensor_id, metric, observed_at FROM included
      ), cadence_steps AS (
        SELECT sensor_id, metric,
          EXTRACT(EPOCH FROM observed_at - LAG(observed_at) OVER (
            PARTITION BY sensor_id, metric ORDER BY observed_at
          ))::DOUBLE PRECISION AS step_seconds
        FROM distinct_times
      ), cadences AS (
        SELECT counts.sensor_id, counts.metric, counts.aggregation,
          counts.canonical_unit, counts.included_sample_count, counts.excluded_sample_count,
          GREATEST(1.0, COALESCE(
            percentile_cont(0.5) WITHIN GROUP (ORDER BY steps.step_seconds)
              FILTER (WHERE steps.step_seconds > 0 AND steps.step_seconds <= 86400),
            GREATEST(
              60.0,
              EXTRACT(EPOCH FROM ($3::TIMESTAMPTZ - $2::TIMESTAMPTZ))
                / GREATEST(1, counts.included_sample_count)
            )
          ))::DOUBLE PRECISION AS cadence_seconds
        FROM series_counts AS counts
        LEFT JOIN cadence_steps AS steps
          ON steps.sensor_id = counts.sensor_id AND steps.metric = counts.metric
        GROUP BY counts.sensor_id, counts.metric, counts.aggregation,
          counts.canonical_unit, counts.included_sample_count, counts.excluded_sample_count
      ), bucketed AS (
        SELECT included.*,
          date_bin($5::INTERVAL, observed_at, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS bucket_start
        FROM included
      ), ordered AS (
        SELECT bucketed.*,
          LAG(value) OVER (
            PARTITION BY sensor_id, metric
            ORDER BY observed_at, source, ingested_at
          ) AS previous_value,
          LEAD(observed_at) OVER (
            PARTITION BY sensor_id, metric, bucket_start
            ORDER BY observed_at, source, ingested_at
          ) AS next_bucket_at
        FROM bucketed
      ), bucket_aggregates AS (
        SELECT ordered.sensor_id, ordered.metric, ordered.bucket_start,
          COUNT(*)::BIGINT AS bucket_sample_count,
          AVG(ordered.value)::DOUBLE PRECISION AS mean_value,
          SUM(ordered.value)::DOUBLE PRECISION AS sum_value,
          MIN(ordered.value)::DOUBLE PRECISION AS minimum,
          MAX(ordered.value)::DOUBLE PRECISION AS maximum,
          (array_agg(
            ordered.value ORDER BY ordered.observed_at DESC, ordered.source DESC, ordered.ingested_at DESC
          ))[1]::DOUBLE PRECISION AS last_value,
          SUM(CASE
            WHEN ordered.previous_value IS NULL THEN NULL
            WHEN ordered.value >= ordered.previous_value THEN ordered.value - ordered.previous_value
            ELSE 0
          END)::DOUBLE PRECISION AS delta_value,
          COUNT(*) FILTER (
            WHERE ordered.previous_value IS NOT NULL AND ordered.value < ordered.previous_value
          )::BIGINT AS counter_reset_count,
          COUNT(*) FILTER (WHERE ordered.quality = 'estimated')::BIGINT AS estimated_sample_count,
          COUNT(*) FILTER (WHERE ordered.quality = 'stale')::BIGINT AS stale_sample_count,
          (
            SUM(ordered.value * LEAST(
              GREATEST(EXTRACT(EPOCH FROM (
                COALESCE(ordered.next_bucket_at, ordered.bucket_start + $5::INTERVAL) - ordered.observed_at
              )), 0.0),
              cadences.cadence_seconds * 1.5
            ))
            / NULLIF(SUM(LEAST(
              GREATEST(EXTRACT(EPOCH FROM (
                COALESCE(ordered.next_bucket_at, ordered.bucket_start + $5::INTERVAL) - ordered.observed_at
              )), 0.0),
              cadences.cadence_seconds * 1.5
            )), 0)
          )::DOUBLE PRECISION AS time_weighted_value
        FROM ordered
        JOIN cadences
          ON cadences.sensor_id = ordered.sensor_id AND cadences.metric = ordered.metric
        GROUP BY ordered.sensor_id, ordered.metric, ordered.bucket_start
      )
      SELECT cadences.sensor_id, cadences.metric, cadences.canonical_unit,
        cadences.included_sample_count, cadences.excluded_sample_count, cadences.cadence_seconds,
        buckets.bucket_start,
        CASE cadences.aggregation
          WHEN 'mean' THEN buckets.mean_value
          WHEN 'sum' THEN buckets.sum_value
          WHEN 'delta' THEN buckets.delta_value
          WHEN 'last' THEN buckets.last_value
          WHEN 'time_weighted_mean' THEN COALESCE(buckets.time_weighted_value, buckets.last_value)
          WHEN 'min' THEN buckets.minimum
          WHEN 'max' THEN buckets.maximum
        END::DOUBLE PRECISION AS rollup_value,
        buckets.minimum, buckets.maximum, buckets.bucket_sample_count,
        buckets.estimated_sample_count, buckets.stale_sample_count, buckets.counter_reset_count
      FROM cadences
      LEFT JOIN bucket_aggregates AS buckets
        ON buckets.sensor_id = cadences.sensor_id AND buckets.metric = cadences.metric
      ORDER BY cadences.sensor_id, cadences.metric, buckets.bucket_start`, [
      JSON.stringify(query.series.map((series) => ({
        sensor_id: series.sensorId,
        metric: series.metric,
        aggregation: series.aggregation,
      }))),
      query.from,
      query.to,
      [...query.qualities],
      interval,
      query.excludeSynthetic === true,
    ], query);

    const bySeries = new Map<string, MeasurementAnalyticsSeriesRecord>();
    for (const requested of query.series) {
      bySeries.set(JSON.stringify([requested.sensorId, requested.metric]), {
        sensorId: requested.sensorId,
        metric: requested.metric,
        canonicalUnit: "",
        sampleCount: 0,
        excludedSampleCount: 0,
        cadenceSeconds: 60,
        buckets: [],
      });
    }
    for (const row of result.rows) {
      const record = bySeries.get(JSON.stringify([row.sensor_id, row.metric]));
      if (!record) continue;
      record.canonicalUnit = row.canonical_unit ?? "";
      record.sampleCount = finiteNumber(row.included_sample_count);
      record.excludedSampleCount = finiteNumber(row.excluded_sample_count);
      record.cadenceSeconds = Math.max(1, finiteNumber(row.cadence_seconds, 60));
      if (row.bucket_start === null || row.minimum === null || row.maximum === null) continue;
      record.buckets.push({
        bucketStart: timestamp(row.bucket_start),
        value: row.rollup_value === null ? null : finiteNumber(row.rollup_value),
        minimum: finiteNumber(row.minimum),
        maximum: finiteNumber(row.maximum),
        sampleCount: finiteNumber(row.bucket_sample_count),
        estimatedSampleCount: finiteNumber(row.estimated_sample_count),
        staleSampleCount: finiteNumber(row.stale_sample_count),
        counterResetCount: finiteNumber(row.counter_reset_count),
      });
    }
    return { series: [...bySeries.values()] };
  },
});
