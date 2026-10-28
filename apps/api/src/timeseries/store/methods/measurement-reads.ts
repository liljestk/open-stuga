import type { QueryResultRow } from "pg";
import { MEASUREMENT_ANALYTICS_BUCKETS, measurementAnalyticsAggregateName, measurementAggregateName, qualifiedName } from "../../schema.js";
import type { MeasurementBucketQuery, MeasurementBucketRecord, MeasurementCoverageQuery, MeasurementCoverageRecord, MeasurementGapQuery, MeasurementGapRecord, MeasurementHistoryBucketedQuery, MeasurementHistoryQuery, MeasurementSampleRecord, MeasurementWindowQuery, ThermalMeasurementHistoryQuery, QueryControl } from "../../types.js";
import { LatestMeasurementFilter, MeasurementBucketRow, MeasurementCoverageRow, MeasurementRow, SqlValue } from "../support/row-types.js";
import { MAX_HISTORY_LIMIT, MAX_MEASUREMENT_WINDOW_LIMIT } from "../support/store-limits.js";
import { measurementBucketFromRow, measurementFromRow } from "../support/row-mappers.js";
import { positiveInteger, timestamp } from "../support/query-values.js";
import { registerTimeseriesStoreMethods, type TimeseriesStoreInternals } from "../core.js";

interface MeasurementGapRow {
  started_at: string | Date;
  ended_at: string | Date;
  duration_ms: string | number;
}

interface ThermalMeasurementRow extends QueryResultRow {
  sensor_id: string;
  metric: string;
  value: number | null;
  canonical_unit: string | null;
  observed_at: string | Date | null;
  source: string | null;
  quality: string | null;
  metadata: Readonly<Record<string, unknown>> | null;
  coverage_complete: boolean;
}

declare module "../core.js" {
  interface TimeseriesStoreInternals {
    latestMeasurementSample(sensorId: string, metric: string, control?: QueryControl): Promise<MeasurementSampleRecord | null>;
    latestMeasurementSamples(filter?: LatestMeasurementFilter): Promise<MeasurementSampleRecord[]>;
    measurementHistory(query: MeasurementHistoryQuery): Promise<MeasurementSampleRecord[]>;
    measurementHistoryBucketed(query: MeasurementHistoryBucketedQuery): Promise<MeasurementSampleRecord[]>;
    measurementSampleGaps(query: MeasurementGapQuery): Promise<MeasurementGapRecord[]>;
    thermalMeasurementHistory(query: ThermalMeasurementHistoryQuery): Promise<MeasurementSampleRecord[]>;
    measurementWindow(query: MeasurementWindowQuery): Promise<MeasurementSampleRecord[]>;
    measurementCoverage(query: MeasurementCoverageQuery): Promise<MeasurementCoverageRecord[]>;
    measurementBuckets(query: MeasurementBucketQuery): Promise<MeasurementBucketRecord[]>;
  }

  interface TimeseriesStoreCore {
    latestMeasurementSample(sensorId: string, metric: string, control?: QueryControl): Promise<MeasurementSampleRecord | null>;
    latestMeasurementSamples(filter?: LatestMeasurementFilter): Promise<MeasurementSampleRecord[]>;
    measurementHistory(query: MeasurementHistoryQuery): Promise<MeasurementSampleRecord[]>;
    measurementHistoryBucketed(query: MeasurementHistoryBucketedQuery): Promise<MeasurementSampleRecord[]>;
    measurementSampleGaps(query: MeasurementGapQuery): Promise<MeasurementGapRecord[]>;
    thermalMeasurementHistory(query: ThermalMeasurementHistoryQuery): Promise<MeasurementSampleRecord[]>;
    measurementWindow(query: MeasurementWindowQuery): Promise<MeasurementSampleRecord[]>;
    measurementCoverage(query: MeasurementCoverageQuery): Promise<MeasurementCoverageRecord[]>;
    measurementBuckets(query: MeasurementBucketQuery): Promise<MeasurementBucketRecord[]>;
  }
}

registerTimeseriesStoreMethods({
  async latestMeasurementSample(this: TimeseriesStoreInternals,
      sensorId: string,
      metric: string,
      control: QueryControl = {},
    ): Promise<MeasurementSampleRecord | null> {
      const result = await this.__query<MeasurementRow>(`SELECT sensor_id, metric, value, canonical_unit,
          observed_at, source, quality, metadata
        FROM ${qualifiedName(this.schema, "measurement_samples")}
        WHERE sensor_id = $1 AND metric = $2
        ORDER BY observed_at DESC, ingested_at DESC, source DESC
        LIMIT 1`, [sensorId, metric], control);
      return result.rows[0] ? measurementFromRow(result.rows[0]) : null;
    },
  async latestMeasurementSamples(this: TimeseriesStoreInternals, filter: LatestMeasurementFilter = {}): Promise<MeasurementSampleRecord[]> {
      if (filter.sensorIds?.length === 0) return [];
      const where: string[] = [];
      const values: SqlValue[] = [];
      if (filter.sensorIds) {
        values.push([...filter.sensorIds]);
        where.push(`sensor_id = ANY($${values.length}::TEXT[])`);
      }
      if (filter.metric !== undefined) {
        values.push(filter.metric);
        where.push(`metric = $${values.length}`);
      }
      const result = await this.__query<MeasurementRow>(`SELECT DISTINCT ON (sensor_id, metric)
          sensor_id, metric, value, canonical_unit, observed_at, source, quality, metadata
        FROM ${qualifiedName(this.schema, "measurement_samples")}
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY sensor_id, metric, observed_at DESC, ingested_at DESC, source DESC`, values, filter);
      return result.rows.map(measurementFromRow);
    },
  async measurementHistory(this: TimeseriesStoreInternals, query: MeasurementHistoryQuery): Promise<MeasurementSampleRecord[]> {
      const limit = positiveInteger(query.limit, 20_000, MAX_HISTORY_LIMIT);
      const values: SqlValue[] = [query.sensorId, query.metric, query.from, query.to];
      let cursor = "";
      if (query.before) {
        values.push(query.before.timestamp, query.before.source);
        cursor = `AND (observed_at, source) < ($${values.length - 1}::TIMESTAMPTZ, $${values.length}::TEXT)`;
      }
      values.push(limit);
      const result = await this.__query<MeasurementRow>(`SELECT sensor_id, metric, value, canonical_unit,
          observed_at, source, quality, metadata
        FROM (
          SELECT sensor_id, metric, value, canonical_unit, observed_at, source, quality, metadata, ingested_at
          FROM ${qualifiedName(this.schema, "measurement_samples")}
          WHERE sensor_id = $1 AND metric = $2 AND observed_at >= $3::TIMESTAMPTZ AND observed_at <= $4::TIMESTAMPTZ
            ${cursor}
          ORDER BY observed_at DESC, source DESC
          LIMIT $${values.length}
        ) recent
        ORDER BY observed_at ASC, source ASC`, values, query);
      return result.rows.map(measurementFromRow);
    },
  async measurementHistoryBucketed(
    this: TimeseriesStoreInternals,
    query: MeasurementHistoryBucketedQuery,
  ): Promise<MeasurementSampleRecord[]> {
      const limit = positiveInteger(query.limit, 20_000, MAX_HISTORY_LIMIT);
      if (!Number.isInteger(query.bucketSeconds) || query.bucketSeconds < 1 || query.bucketSeconds > 86_400) {
        throw new RangeError("bucketSeconds must be an integer from 1 to 86400");
      }
      const measurements = qualifiedName(this.schema, "measurement_samples");
      const syntheticFilter = query.excludeSynthetic ? "AND source NOT IN ('mock', 'replay')" : "";
      // Chart DTOs do not expose metadata. Avoid decompressing that wide column
      // for every historical row just to discard the returned latest payloads.
      const metadataColumn = query.includeMetadata === false ? "" : ", metadata";
      const metadataResult = query.includeMetadata === false ? "'{}'::JSONB AS metadata" : "latest.metadata";
      const result = await this.__query<MeasurementRow>(`WITH source_rows AS (
          SELECT value, observed_at,
            date_bin(make_interval(secs => $5::INT), observed_at, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS bucket_start
          FROM ${measurements}
          WHERE sensor_id = $1 AND metric = $2
            AND observed_at >= $3::TIMESTAMPTZ AND observed_at <= $4::TIMESTAMPTZ
            ${syntheticFilter}
        ), recent_buckets AS (
          SELECT bucket_start, AVG(value)::DOUBLE PRECISION AS value,
            COUNT(*) AS sample_count,
            MAX(observed_at) AS latest_at
          FROM source_rows
          GROUP BY bucket_start
          ORDER BY bucket_start DESC
          LIMIT $6
        ), latest_rows AS (
          -- Read provenance once for the returned timestamps. Per-bucket
          -- lookups repeatedly decompress the same historical chunks.
          SELECT DISTINCT ON (observed_at) observed_at, canonical_unit,
            source, quality${metadataColumn}
          FROM ${measurements}
          WHERE sensor_id = $1 AND metric = $2
            AND observed_at >= $3::TIMESTAMPTZ AND observed_at <= $4::TIMESTAMPTZ
            AND observed_at IN (SELECT latest_at FROM recent_buckets)
            ${syntheticFilter}
          ORDER BY observed_at DESC, source DESC
        )
        SELECT $1::TEXT AS sensor_id, $2::TEXT AS metric, bucket.value,
          latest.canonical_unit, bucket.bucket_start AS observed_at, latest.source,
          -- Distinct sources already imply multiple samples. Counting them
          -- would force a sort over the dense input instead of bucket hashing.
          CASE WHEN bucket.sample_count > 1
            THEN 'estimated' ELSE latest.quality END AS quality,
          ${metadataResult}
        FROM recent_buckets bucket
        JOIN latest_rows latest ON latest.observed_at = bucket.latest_at
        ORDER BY bucket.bucket_start ASC`, [
        query.sensorId,
        query.metric,
        query.from,
        query.to,
        query.bucketSeconds,
        limit,
      ], query);
      return result.rows.map(measurementFromRow);
    },
  async measurementSampleGaps(this: TimeseriesStoreInternals, query: MeasurementGapQuery): Promise<MeasurementGapRecord[]> {
      const limit = positiveInteger(query.limit, 100, 1_000);
      if (!Number.isFinite(query.minimumGapMs) || query.minimumGapMs <= 0) {
        throw new RangeError("minimumGapMs must be a positive finite number");
      }
      const result = await this.__query<MeasurementGapRow>(`WITH ordered AS (
          SELECT observed_at, LAG(observed_at) OVER (ORDER BY observed_at) AS previous_observed_at
          FROM ${qualifiedName(this.schema, "measurement_samples")}
          WHERE sensor_id = $1 AND metric = $2 AND source = $3 AND quality = 'good'
            AND observed_at >= $4::TIMESTAMPTZ AND observed_at <= $5::TIMESTAMPTZ
        )
        SELECT previous_observed_at AS started_at, observed_at AS ended_at,
          EXTRACT(EPOCH FROM observed_at - previous_observed_at) * 1000.0 AS duration_ms
        FROM ordered
        WHERE previous_observed_at IS NOT NULL
          AND observed_at - previous_observed_at > $6::DOUBLE PRECISION * INTERVAL '1 millisecond'
        ORDER BY previous_observed_at ASC
        LIMIT $7`, [
        query.sensorId,
        query.metric,
        query.source,
        query.from,
        query.to,
        query.minimumGapMs,
        limit,
      ], query);
      return result.rows.map((row) => ({
        startedAt: timestamp(row.started_at),
        endedAt: timestamp(row.ended_at),
        durationMs: Math.max(0, Math.round(Number(row.duration_ms))),
      }));
    },
  async thermalMeasurementHistory(
    this: TimeseriesStoreInternals,
    query: ThermalMeasurementHistoryQuery,
  ): Promise<MeasurementSampleRecord[]> {
      const metrics = [...new Set(query.metrics)];
      if (metrics.length === 0) return [];
      const bucketMinutes = positiveInteger(query.bucketMinutes, 5, 60);
      const limitPerMetric = positiveInteger(query.limitPerMetric, 5_000, 20_000);
      const base = bucketMinutes === 60 ? "1h" : bucketMinutes % 5 === 0 ? "5m" : "1m";
      const baseInterval = MEASUREMENT_ANALYTICS_BUCKETS[base].interval;
      const aggregate = qualifiedName(this.schema, measurementAnalyticsAggregateName(base));
      const measurements = qualifiedName(this.schema, "measurement_samples");
      const result = await this.__query<ThermalMeasurementRow>(`WITH requested_metrics AS (
          SELECT unnest($2::TEXT[]) AS metric
        ), bounds AS (
          SELECT date_bin($7::INTERVAL, $3::TIMESTAMPTZ, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS from_bucket,
            date_bin($7::INTERVAL, $4::TIMESTAMPTZ, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS to_bucket
        ), limits AS (
          SELECT CASE WHEN from_bucket = $3::TIMESTAMPTZ THEN from_bucket
              ELSE from_bucket + $7::INTERVAL END AS full_from,
            to_bucket AS full_to FROM bounds
        ), raw_bounds AS (
          SELECT requested.metric, first_sample.observed_at AS first_at, last_sample.observed_at AS last_at
          FROM requested_metrics requested CROSS JOIN limits
          LEFT JOIN LATERAL (
            SELECT sample.observed_at FROM ${measurements} sample
            WHERE sample.sensor_id = $1 AND sample.metric = requested.metric
              AND sample.observed_at >= limits.full_from AND sample.observed_at < limits.full_to
              AND sample.quality IN ('good', 'estimated') AND sample.source <> 'replay'
            ORDER BY sample.observed_at ASC LIMIT 1
          ) first_sample ON TRUE
          LEFT JOIN LATERAL (
            SELECT sample.observed_at FROM ${measurements} sample
            WHERE sample.sensor_id = $1 AND sample.metric = requested.metric
              AND sample.observed_at >= limits.full_from AND sample.observed_at < limits.full_to
              AND sample.quality IN ('good', 'estimated') AND sample.source <> 'replay'
            ORDER BY sample.observed_at DESC LIMIT 1
          ) last_sample ON TRUE
        ), aggregate_bounds AS (
          SELECT requested.metric, first_bucket.bucket_start AS first_bucket,
            last_bucket.bucket_start AS last_bucket
          FROM requested_metrics requested CROSS JOIN limits
          LEFT JOIN LATERAL (
            SELECT sample.bucket_start FROM ${aggregate} sample
            WHERE sample.sensor_id = $1 AND sample.metric = requested.metric
              AND sample.bucket_start >= limits.full_from AND sample.bucket_start < limits.full_to
              AND sample.quality IN ('good', 'estimated') AND sample.source <> 'replay'
            ORDER BY sample.bucket_start ASC LIMIT 1
          ) first_bucket ON TRUE
          LEFT JOIN LATERAL (
            SELECT sample.bucket_start FROM ${aggregate} sample
            WHERE sample.sensor_id = $1 AND sample.metric = requested.metric
              AND sample.bucket_start >= limits.full_from AND sample.bucket_start < limits.full_to
              AND sample.quality IN ('good', 'estimated') AND sample.source <> 'replay'
            ORDER BY sample.bucket_start DESC LIMIT 1
          ) last_bucket ON TRUE
        ), coverage AS (
          SELECT raw.metric, raw.first_at IS NULL OR (
            aggregate.first_bucket <= date_bin($7::INTERVAL, raw.first_at, TIMESTAMPTZ '1970-01-01 00:00:00+00')
            AND aggregate.last_bucket >= date_bin($7::INTERVAL, raw.last_at, TIMESTAMPTZ '1970-01-01 00:00:00+00')
          ) AS complete
          FROM raw_bounds raw JOIN aggregate_bounds aggregate USING (metric)
        ), source_rows AS (
          SELECT sample.metric, sample.bucket_start AS observed_at,
            sample.sum_value, sample.sample_count, sample.canonical_unit, sample.source, sample.quality
          FROM ${aggregate} sample CROSS JOIN limits
          WHERE sample.sensor_id = $1 AND sample.metric = ANY($2::TEXT[])
            AND sample.bucket_start >= limits.full_from AND sample.bucket_start < limits.full_to
            AND sample.quality IN ('good', 'estimated') AND sample.source <> 'replay'
          UNION ALL
          SELECT sample.metric,
            date_bin($7::INTERVAL, sample.observed_at, TIMESTAMPTZ '1970-01-01 00:00:00+00'),
            sample.value, 1::BIGINT, sample.canonical_unit, sample.source, sample.quality
          FROM ${measurements} sample CROSS JOIN limits
          WHERE sample.sensor_id = $1 AND sample.metric = ANY($2::TEXT[])
            AND sample.observed_at >= $3::TIMESTAMPTZ AND sample.observed_at <= $4::TIMESTAMPTZ
            AND (sample.observed_at < limits.full_from OR sample.observed_at >= limits.full_to)
            AND sample.quality IN ('good', 'estimated') AND sample.source <> 'replay'
        ), aggregated AS (
          SELECT metric,
            date_bin(make_interval(mins => $5::INT), observed_at, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS observed_at,
            (SUM(sum_value * CASE quality WHEN 'estimated' THEN 0.25 ELSE 1.0 END)
              / NULLIF(SUM(sample_count * CASE quality WHEN 'estimated' THEN 0.25 ELSE 1.0 END), 0))::DOUBLE PRECISION AS value,
            MIN(canonical_unit) AS canonical_unit,
            MIN(source) AS source,
            CASE WHEN BOOL_OR(quality = 'good') THEN 'good' ELSE 'estimated' END AS quality,
            '{}'::JSONB AS metadata
          FROM source_rows
          GROUP BY metric, date_bin(make_interval(mins => $5::INT), observed_at, TIMESTAMPTZ '1970-01-01 00:00:00+00')
        ), ranked AS (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY metric ORDER BY observed_at DESC) AS bucket_rank
          FROM aggregated
        )
        SELECT $1::TEXT AS sensor_id, requested.metric, ranked.value, ranked.canonical_unit,
          ranked.observed_at, ranked.source, ranked.quality, ranked.metadata,
          coverage.complete AS coverage_complete
        FROM requested_metrics requested
        JOIN coverage USING (metric)
        LEFT JOIN ranked ON ranked.metric = requested.metric AND ranked.bucket_rank <= $6
        ORDER BY ranked.observed_at ASC NULLS FIRST, requested.metric ASC`,
      [query.sensorId, metrics, query.from, query.to, bucketMinutes, limitPerMetric, baseInterval], query);
      if (result.rows.some((row) => !row.coverage_complete)) {
        throw new Error("Telemetry rollups are still materializing the requested thermal history");
      }
      return result.rows.flatMap((row) => row.observed_at === null ? [] : [measurementFromRow({
        sensor_id: row.sensor_id,
        metric: row.metric,
        value: row.value!,
        canonical_unit: row.canonical_unit!,
        observed_at: row.observed_at,
        source: row.source!,
        quality: row.quality!,
        metadata: row.metadata ?? {},
      })]);
    },
  async measurementWindow(this: TimeseriesStoreInternals, query: MeasurementWindowQuery): Promise<MeasurementSampleRecord[]> {
      if (query.sensorIds.length === 0 || query.metrics.length === 0) return [];
      const limit = positiveInteger(query.limit, 100_000, MAX_MEASUREMENT_WINDOW_LIMIT);
      const result = await this.__query<MeasurementRow>(`SELECT sensor_id, metric, value, canonical_unit,
          observed_at, source, quality, metadata
        FROM (
          SELECT sensor_id, metric, value, canonical_unit, observed_at, source, quality, metadata
          FROM ${qualifiedName(this.schema, "measurement_samples")}
          WHERE sensor_id = ANY($1::TEXT[]) AND metric = ANY($2::TEXT[])
            AND observed_at >= $3::TIMESTAMPTZ AND observed_at <= $4::TIMESTAMPTZ
          ORDER BY observed_at DESC, sensor_id DESC, metric DESC, source DESC
          LIMIT $5
        ) recent
        ORDER BY observed_at ASC, sensor_id ASC, metric ASC, source ASC`, [
        [...query.sensorIds],
        [...query.metrics],
        query.from,
        query.to,
        limit,
      ], query);
      return result.rows.map(measurementFromRow);
    },
  async measurementCoverage(this: TimeseriesStoreInternals, query: MeasurementCoverageQuery): Promise<MeasurementCoverageRecord[]> {
      if (query.sensorIds.length === 0 || query.metrics.length === 0) return [];
      // Energy summaries need the two boundaries, not an aggregate over every
      // retained sample. Separate ordered probes use the existing series/time
      // index and stop at the first qualifying row in each direction.
      const sourceFilter = query.excludeSynthetic ? "AND source NOT IN ('mock', 'replay')" : "";
      const result = await this.__query<MeasurementCoverageRow>(`SELECT sensor_id, metric,
          first_sample.observed_at AS coverage_start, last_sample.observed_at AS coverage_end
        FROM unnest($1::TEXT[]) AS sensors(sensor_id)
        CROSS JOIN unnest($2::TEXT[]) AS metrics(metric)
        CROSS JOIN LATERAL (
          SELECT observed_at FROM ${qualifiedName(this.schema, "measurement_samples")} sample
          WHERE sample.sensor_id = sensors.sensor_id AND sample.metric = metrics.metric
            ${sourceFilter}
          ORDER BY observed_at ASC LIMIT 1
        ) first_sample
        CROSS JOIN LATERAL (
          SELECT observed_at FROM ${qualifiedName(this.schema, "measurement_samples")} sample
          WHERE sample.sensor_id = sensors.sensor_id AND sample.metric = metrics.metric
            ${sourceFilter}
          ORDER BY observed_at DESC LIMIT 1
        ) last_sample
        ORDER BY sensor_id, metric`, [[...new Set(query.sensorIds)], [...new Set(query.metrics)]], query);
      return result.rows.map((row) => ({
        sensorId: row.sensor_id,
        metric: row.metric,
        start: timestamp(row.coverage_start),
        end: timestamp(row.coverage_end),
      }));
    },
  async measurementBuckets(this: TimeseriesStoreInternals, query: MeasurementBucketQuery): Promise<MeasurementBucketRecord[]> {
      const limit = positiveInteger(query.limit, 20_000, MAX_HISTORY_LIMIT);
      const aggregate = measurementAggregateName(query.bucket);
      const result = await this.__query<MeasurementBucketRow>(`SELECT sensor_id, metric, bucket_start,
          sample_count, average, minimum, maximum, canonical_unit
        FROM (
          SELECT sensor_id, metric, bucket_start, sample_count, average, minimum, maximum, canonical_unit
          FROM ${qualifiedName(this.schema, aggregate)}
          WHERE sensor_id = $1 AND metric = $2 AND bucket_start >= $3::TIMESTAMPTZ AND bucket_start <= $4::TIMESTAMPTZ
          ORDER BY bucket_start DESC
          LIMIT $5
        ) recent
        ORDER BY bucket_start ASC`, [query.sensorId, query.metric, query.from, query.to, limit], query);
      return result.rows.map(measurementBucketFromRow);
    },
});
