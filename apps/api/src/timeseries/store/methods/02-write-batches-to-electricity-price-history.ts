import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  HYPERTABLE_DEFINITIONS,
  MEASUREMENT_ANALYTICS_BUCKETS,
  MEASUREMENT_BUCKETS,
  SOURCE_TAGGED_TELEMETRY_TABLES,
  TELEMETRY_TABLES,
  buildBaseSchemaSql,
  buildContinuousAggregateSql,
  buildFallbackAggregateSql,
  measurementAnalyticsAggregateName,
  measurementAggregateName,
  qualifiedName,
  quoteIdentifier,
  validateSchemaName,
} from "../../schema.js";
import type {
  AggregateRefreshQuery,
  ArchiveCheckpoint,
  ArchiveTableName,
  BatchWriteResult,
  ColdStorageMode,
  EnergyCostAggregateQuery,
  EnergyCostAggregateRecord,
  ElectricityPriceHistoryQuery,
  ElectricityPriceRecord,
  HeatPumpStateHistoryQuery,
  HeatPumpStateRecord,
  LegacyReadingHistoryQuery,
  LegacyReadingRecord,
  MeasurementBucketQuery,
  MeasurementBucketRecord,
  MeasurementCoverageQuery,
  MeasurementCoverageRecord,
  MeasurementGapQuery,
  MeasurementGapRecord,
  MeasurementHistoryQuery,
  MeasurementSampleRecord,
  MeasurementWindowQuery,
  ThermalMeasurementHistoryQuery,
  OpeningStateHistoryQuery,
  OpeningStateRecord,
  OpeningStateSnapshotQuery,
  OutdoorTemperatureHistoryQuery,
  OutdoorTemperatureRecord,
  QueryControl,
  TelemetryHealth,
  TelemetrySchemaInitResult,
  TelemetryStorageStats,
  TelemetryStoreOptions,
  TelemetryTableStorage,
} from "../../types.js";
import { ArchiveCheckpointRow, ElectricityPriceRow, HeatPumpStateRow, LatestLegacyReadingFilter, LatestMeasurementFilter, LegacyReadingRow, MAX_HISTORY_LIMIT, MAX_MEASUREMENT_WINDOW_LIMIT, MeasurementBucketRow, MeasurementCoverageRow, MeasurementRow, OpeningStateRow, OutdoorTemperatureRow, SqlValue, electricityPriceFromRow, heatPumpStateFromRow, legacyReadingFromRow, measurementBucketFromRow, measurementFromRow, openingStateFromRow, outdoorTemperatureFromRow, positiveInteger, timestamp } from "../support/01-default-schema-to-measurement-bucket-from-row.js";
import { registerTimeseriesStoreMethods, timeseriesStoreState, type TimeseriesStoreInternals } from "../core.js";

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

registerTimeseriesStoreMethods({
  async __writeBatches<T>(this: TimeseriesStoreInternals,
      table: (typeof TELEMETRY_TABLES)[number],
      columns: readonly string[],
      conflictColumns: readonly string[],
      updateColumns: readonly string[],
      records: readonly T[],
      valuesFor: (record: T) => readonly SqlValue[],
      control: QueryControl,
      markOrderedRollups = false,
    ): Promise<BatchWriteResult> {
      if (records.length === 0) return { attempted: 0, affected: 0 };
      const parameterSafeBatchSize = Math.min(this[timeseriesStoreState].batchSize, Math.floor(60_000 / columns.length));
      let affected = 0;

      for (let offset = 0; offset < records.length; offset += parameterSafeBatchSize) {
        const batch = records.slice(offset, offset + parameterSafeBatchSize);
        const values: SqlValue[] = [];
        const tuples = batch.map((record) => {
          const recordValues = valuesFor(record);
          if (recordValues.length !== columns.length) throw new Error(`Invalid value count for ${table}`);
          const placeholders = recordValues.map((value) => {
            values.push(value);
            return `$${values.length}`;
          });
          return `(${placeholders.join(", ")})`;
        });
        const assignments = updateColumns.map((column) => (
          `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`
        ));
        assignments.push(`${quoteIdentifier("ingested_at")} = clock_timestamp()`);
        const distinctCurrent = updateColumns.map((column) => `current_row.${quoteIdentifier(column)}`).join(", ");
        const distinctIncoming = updateColumns.map((column) => `EXCLUDED.${quoteIdentifier(column)}`).join(", ");
        const insertSql = `INSERT INTO ${qualifiedName(this.schema, table)} AS current_row
          (${columns.map(quoteIdentifier).join(", ")})
          VALUES ${tuples.join(", ")}
          ON CONFLICT (${conflictColumns.map(quoteIdentifier).join(", ")}) DO UPDATE SET
            ${assignments.join(", ")}
          WHERE ROW(${distinctCurrent}) IS DISTINCT FROM ROW(${distinctIncoming})`;
        let sql = insertSql;
        if (markOrderedRollups) {
          values.push([...this[timeseriesStoreState].orderedMetrics]);
          const orderedMetricsParameter = `$${values.length}`;
          sql = `WITH changed AS (
              ${insertSql}
              RETURNING sensor_id, metric, observed_at
            ), changed_days AS MATERIALIZED (
              SELECT DISTINCT sensor_id, metric, date_bin(INTERVAL '1 day', observed_at,
                TIMESTAMPTZ '1970-01-01 00:00:00+00') AS day_start
              FROM changed
            ), ordered_days AS (
              SELECT day.* FROM changed_days day
              WHERE day.metric = ANY(${orderedMetricsParameter}::TEXT[])
                OR EXISTS (
                  SELECT 1 FROM ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")} dirty
                  WHERE dirty.sensor_id = day.sensor_id AND dirty.metric = day.metric
                    AND dirty.day_start = day.day_start
                )
            ), generations AS (
              INSERT INTO ${qualifiedName(this.schema, "measurement_ordered_rollup_generations")} AS generation
                (sensor_id, metric, day_start, current_seq, synced_seq, updated_at)
              SELECT sensor_id, metric, day_start, 1, 1, clock_timestamp() FROM ordered_days
              ON CONFLICT (sensor_id, metric, day_start) DO UPDATE SET
                current_seq = generation.current_seq + 1,
                synced_seq = CASE WHEN generation.current_seq <> generation.synced_seq OR EXISTS (
                  SELECT 1 FROM ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")} dirty
                  WHERE dirty.sensor_id = generation.sensor_id
                    AND dirty.metric = generation.metric
                    AND dirty.day_start = generation.day_start
                ) THEN generation.synced_seq ELSE generation.current_seq + 1 END,
                updated_at = clock_timestamp()
              RETURNING sensor_id, metric, day_start, current_seq
            ), dirtied AS (
              UPDATE ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")} AS dirty SET
                current_seq = GREATEST(dirty.current_seq, generation.current_seq), lease_token = NULL,
                lease_until = NULL, updated_at = clock_timestamp()
              FROM generations generation
              WHERE dirty.sensor_id = generation.sensor_id
                AND dirty.metric = generation.metric
                AND dirty.day_start = generation.day_start
              RETURNING 1
            )
            SELECT count(*)::BIGINT AS affected FROM changed`;
        }
        const result = await this.__query(sql, values, control);
        const reported = markOrderedRollups
          ? Number((result.rows[0] as { affected?: string | number } | undefined)?.affected ?? result.rowCount ?? 0)
          : result.rowCount ?? 0;
        affected += Number.isFinite(reported) ? reported : 0;
      }
      return { attempted: records.length, affected };
    },
  async getArchiveCheckpoint(this: TimeseriesStoreInternals,
      sourceId: string,
      tableName: ArchiveTableName,
      control: QueryControl = {},
    ): Promise<ArchiveCheckpoint | null> {
      const result = await this.__query<ArchiveCheckpointRow>(`SELECT source_id, table_name, last_row_id, updated_at
        FROM ${qualifiedName(this.schema, "archive_checkpoints")}
        WHERE source_id = $1 AND table_name = $2`, [sourceId, tableName], control);
      const row = result.rows[0];
      if (!row) return null;
      const lastRowId = Number(row.last_row_id);
      if (!Number.isSafeInteger(lastRowId)) throw new RangeError("Archive checkpoint exceeds JavaScript's safe integer range");
      return {
        sourceId: row.source_id,
        tableName: row.table_name,
        lastRowId,
        updatedAt: timestamp(row.updated_at),
      };
    },
  /** Returns zero for a source/table pair that has never been archived. */
  async archiveCheckpoint(this: TimeseriesStoreInternals,
      sourceId: string,
      tableName: ArchiveTableName,
      control: QueryControl = {},
    ): Promise<number> {
      return (await this.getArchiveCheckpoint(sourceId, tableName, control))?.lastRowId ?? 0;
    },
  /** Atomically advances a cursor and never lets overlapping workers move it backwards. */
  async setArchiveCheckpoint(this: TimeseriesStoreInternals,
      sourceId: string,
      tableName: ArchiveTableName,
      lastRowId: number,
      control: QueryControl = {},
    ): Promise<ArchiveCheckpoint> {
      if (!Number.isSafeInteger(lastRowId) || lastRowId < 0) {
        throw new RangeError("lastRowId must be a non-negative safe integer");
      }
      const result = await this.__query<ArchiveCheckpointRow>(`INSERT INTO ${qualifiedName(this.schema, "archive_checkpoints")} AS checkpoint
          (source_id, table_name, last_row_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (source_id, table_name) DO UPDATE SET
          last_row_id = GREATEST(checkpoint.last_row_id, EXCLUDED.last_row_id),
          updated_at = CASE
            WHEN EXCLUDED.last_row_id > checkpoint.last_row_id THEN clock_timestamp()
            ELSE checkpoint.updated_at
          END
        RETURNING source_id, table_name, last_row_id, updated_at`, [sourceId, tableName, lastRowId], control);
      const row = result.rows[0];
      if (!row) throw new Error("PostgreSQL did not return the archive checkpoint");
      return {
        sourceId: row.source_id,
        tableName: row.table_name,
        lastRowId: Number(row.last_row_id),
        updatedAt: timestamp(row.updated_at),
      };
    },
  async saveArchiveCheckpoint(this: TimeseriesStoreInternals,
      sourceId: string,
      tableName: ArchiveTableName,
      lastRowId: number,
      control: QueryControl = {},
    ): Promise<void> {
      await this.setArchiveCheckpoint(sourceId, tableName, lastRowId, control);
    },
  /** Mirrors SQLite's one-way real-data latch by removing synthetic sources. */
  async deleteTelemetrySources(this: TimeseriesStoreInternals, sources: readonly string[], control: QueryControl = {}): Promise<number> {
      if (sources.length === 0) return 0;
      let deleted = 0;
      for (const table of SOURCE_TAGGED_TELEMETRY_TABLES) {
        if (table === "measurement_samples") {
          const result = await this.__query<{ affected: string | number }>(`WITH removed AS (
              DELETE FROM ${qualifiedName(this.schema, table)}
              WHERE source = ANY($1::TEXT[])
              RETURNING sensor_id, metric, observed_at
            ), removed_days AS MATERIALIZED (
              SELECT DISTINCT sensor_id, metric, date_bin(INTERVAL '1 day', observed_at,
                TIMESTAMPTZ '1970-01-01 00:00:00+00') AS day_start
              FROM removed
            ), ordered_days AS (
              SELECT day.* FROM removed_days day
              WHERE day.metric = ANY($2::TEXT[])
                OR EXISTS (
                  SELECT 1 FROM ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")} dirty
                  WHERE dirty.sensor_id = day.sensor_id AND dirty.metric = day.metric
                    AND dirty.day_start = day.day_start
                )
            ), generations AS (
              INSERT INTO ${qualifiedName(this.schema, "measurement_ordered_rollup_generations")} AS generation
                (sensor_id, metric, day_start, current_seq, synced_seq, updated_at)
              SELECT sensor_id, metric, day_start, 1, 1, clock_timestamp() FROM ordered_days
              ON CONFLICT (sensor_id, metric, day_start) DO UPDATE SET
                current_seq = generation.current_seq + 1,
                synced_seq = CASE WHEN generation.current_seq <> generation.synced_seq OR EXISTS (
                  SELECT 1 FROM ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")} dirty
                  WHERE dirty.sensor_id = generation.sensor_id
                    AND dirty.metric = generation.metric
                    AND dirty.day_start = generation.day_start
                ) THEN generation.synced_seq ELSE generation.current_seq + 1 END,
                updated_at = clock_timestamp()
              RETURNING sensor_id, metric, day_start, current_seq
            ), dirtied AS (
              UPDATE ${qualifiedName(this.schema, "measurement_ordered_rollup_dirty")} AS dirty SET
                current_seq = GREATEST(dirty.current_seq, generation.current_seq), lease_token = NULL,
                lease_until = NULL, updated_at = clock_timestamp()
              FROM generations generation
              WHERE dirty.sensor_id = generation.sensor_id
                AND dirty.metric = generation.metric
                AND dirty.day_start = generation.day_start
              RETURNING 1
            ) SELECT count(*)::BIGINT AS affected FROM removed`, [
              [...sources],
              [...this[timeseriesStoreState].orderedMetrics],
            ], control);
          deleted += Number(result.rows[0]?.affected ?? 0);
        } else {
          const result = await this.__query(
            `DELETE FROM ${qualifiedName(this.schema, table)} WHERE source = ANY($1::TEXT[])`,
            [[...sources]],
            control,
          );
          deleted += result.rowCount ?? 0;
        }
      }
      return deleted;
    },
  /** Persistently applies SQLite's one-way transition from demo to real data. */
  async enforceRealDataBoundary(this: TimeseriesStoreInternals,
      sourceId: string,
      activatedAt: string,
      control: QueryControl = {},
    ): Promise<number> {
      const current = await this.__query<{ real_data_activated_at: string | Date }>(`SELECT real_data_activated_at
        FROM ${qualifiedName(this.schema, "archive_source_state")} WHERE source_id = $1`, [sourceId], control);
      if (current.rows[0] && timestamp(current.rows[0].real_data_activated_at) === new Date(activatedAt).toISOString()) return 0;
      const deleted = await this.deleteTelemetrySources(["mock", "replay"], control);
      await this.__query(`INSERT INTO ${qualifiedName(this.schema, "archive_source_state")}
          (source_id, real_data_activated_at, enforced_at)
        VALUES ($1, $2::TIMESTAMPTZ, clock_timestamp())
        ON CONFLICT (source_id) DO UPDATE SET
          real_data_activated_at = EXCLUDED.real_data_activated_at,
          enforced_at = EXCLUDED.enforced_at`, [sourceId, activatedAt], control);
      return deleted;
    },
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
      const result = await this.__query<MeasurementCoverageRow>(`SELECT sensor_id, metric,
          MIN(observed_at) AS coverage_start, MAX(observed_at) AS coverage_end
        FROM ${qualifiedName(this.schema, "measurement_samples")}
        WHERE sensor_id = ANY($1::TEXT[]) AND metric = ANY($2::TEXT[])
          ${query.excludeSynthetic ? "AND source NOT IN ('mock', 'replay')" : ""}
        GROUP BY sensor_id, metric
        ORDER BY sensor_id, metric`, [[...query.sensorIds], [...query.metrics]], query);
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
  async latestLegacyReadings(this: TimeseriesStoreInternals, filter: LatestLegacyReadingFilter = {}): Promise<LegacyReadingRecord[]> {
      if (filter.sensorIds?.length === 0) return [];
      const values: SqlValue[] = [];
      const where = filter.sensorIds
        ? (() => {
          values.push([...filter.sensorIds]);
          return "WHERE sensor_id = ANY($1::TEXT[])";
        })()
        : "";
      const result = await this.__query<LegacyReadingRow>(`SELECT DISTINCT ON (sensor_id)
          sensor_id, observed_at, temperature_c, relative_humidity_pct, battery_pct, source, quality, metadata
        FROM ${qualifiedName(this.schema, "legacy_readings")}
        ${where}
        ORDER BY sensor_id, observed_at DESC, ingested_at DESC, source DESC`, values, filter);
      return result.rows.map(legacyReadingFromRow);
    },
  async legacyReadingHistory(this: TimeseriesStoreInternals, query: LegacyReadingHistoryQuery): Promise<LegacyReadingRecord[]> {
      if (query.sensorIds.length === 0) return [];
      const limit = positiveInteger(query.limit, 20_000, MAX_HISTORY_LIMIT);
      const result = await this.__query<LegacyReadingRow>(`SELECT sensor_id, observed_at, temperature_c,
          relative_humidity_pct, battery_pct, source, quality, metadata
        FROM (
          SELECT sensor_id, observed_at, temperature_c, relative_humidity_pct, battery_pct,
            source, quality, metadata, ingested_at
          FROM ${qualifiedName(this.schema, "legacy_readings")}
          WHERE sensor_id = ANY($1::TEXT[]) AND observed_at >= $2::TIMESTAMPTZ AND observed_at <= $3::TIMESTAMPTZ
          ORDER BY observed_at DESC, ingested_at DESC, sensor_id, source DESC
          LIMIT $4
        ) recent
        ORDER BY observed_at ASC, sensor_id, source ASC`, [query.sensorIds, query.from, query.to, limit], query);
      return result.rows.map(legacyReadingFromRow);
    },
  async outdoorTemperatureHistory(this: TimeseriesStoreInternals, query: OutdoorTemperatureHistoryQuery): Promise<OutdoorTemperatureRecord[]> {
      const limit = positiveInteger(query.limit, 20_000, MAX_HISTORY_LIMIT);
      const result = await this.__query<OutdoorTemperatureRow>(`SELECT house_id, location_key, observed_at,
          temperature_c, source, fetched_at, station_id, station_name, metadata
        FROM (
          SELECT house_id, location_key, observed_at, temperature_c, source, fetched_at,
            station_id, station_name, metadata, ingested_at
          FROM ${qualifiedName(this.schema, "outdoor_temperature_samples")}
          WHERE house_id = $1 AND location_key = $2
            AND observed_at >= $3::TIMESTAMPTZ AND observed_at <= $4::TIMESTAMPTZ
          ORDER BY observed_at DESC, ingested_at DESC, source DESC
          LIMIT $5
        ) recent
        ORDER BY observed_at ASC, source ASC`, [query.houseId, query.locationKey, query.from, query.to, limit], query);
      return result.rows.map(outdoorTemperatureFromRow);
    },
  async electricityPriceHistory(this: TimeseriesStoreInternals, query: ElectricityPriceHistoryQuery): Promise<ElectricityPriceRecord[]> {
      const limit = positiveInteger(query.limit, 20_000, MAX_HISTORY_LIMIT);
      const result = await this.__query<ElectricityPriceRow>(`SELECT property_id, starts_at, ends_at,
          raw_price_cents_per_kwh, margin_cents_per_kwh, source, fetched_at, metadata
        FROM (
          SELECT property_id, starts_at, ends_at, raw_price_cents_per_kwh, margin_cents_per_kwh,
            source, fetched_at, metadata, ingested_at
          FROM ${qualifiedName(this.schema, "electricity_price_samples")}
          WHERE property_id = $1 AND starts_at < $3::TIMESTAMPTZ AND ends_at > $2::TIMESTAMPTZ
          ORDER BY starts_at DESC, ingested_at DESC, source DESC
          LIMIT $4
        ) recent
        ORDER BY starts_at ASC, source ASC`, [query.propertyId, query.from, query.to, limit], query);
      return result.rows.map(electricityPriceFromRow);
    },
  async openingStateHistory(this: TimeseriesStoreInternals, query: OpeningStateHistoryQuery): Promise<OpeningStateRecord[]> {
      const limit = positiveInteger(query.limit, 20_000, MAX_HISTORY_LIMIT);
      const result = await this.__query<OpeningStateRow>(`SELECT observation_id, house_id, floor_id, element_id,
          state, open_fraction, source, observed_at, valid_until, external_id, connection_id, recorded_at, metadata
        FROM (
          SELECT observation_id, house_id, floor_id, element_id, state, open_fraction, source, observed_at,
            valid_until, external_id, connection_id, recorded_at, metadata, ingested_at
          FROM ${qualifiedName(this.schema, "opening_state_samples")}
          WHERE house_id = $1 AND observed_at >= $2::TIMESTAMPTZ AND observed_at <= $3::TIMESTAMPTZ
          ORDER BY observed_at DESC, ingested_at DESC, observation_id DESC
          LIMIT $4
        ) recent
        ORDER BY observed_at ASC, observation_id ASC`, [query.houseId, query.from, query.to, limit], query);
      return result.rows.map(openingStateFromRow);
    },
  async openingStateSnapshot(this: TimeseriesStoreInternals, query: OpeningStateSnapshotQuery): Promise<OpeningStateRecord[]> {
      const limit = positiveInteger(query.limit, 10_000, MAX_HISTORY_LIMIT);
      const result = await this.__query<OpeningStateRow>(`SELECT observation_id, house_id, floor_id, element_id,
          state, open_fraction, source, observed_at, valid_until, external_id, connection_id, recorded_at, metadata
        FROM (
          SELECT DISTINCT ON (
              floor_id, element_id, source, COALESCE(external_id, ''), COALESCE(connection_id, '')
            )
            observation_id, house_id, floor_id, element_id, state, open_fraction, source, observed_at,
            valid_until, external_id, connection_id, recorded_at, metadata, ingested_at
          FROM ${qualifiedName(this.schema, "opening_state_samples")}
          WHERE house_id = $1 AND observed_at <= $2::TIMESTAMPTZ
          ORDER BY floor_id, element_id, source, COALESCE(external_id, ''), COALESCE(connection_id, ''),
            observed_at DESC, ingested_at DESC, observation_id DESC
        ) latest
        ORDER BY observed_at DESC, observation_id DESC
        LIMIT $3`, [query.houseId, query.at, limit], query);
      return result.rows.map(openingStateFromRow);
    },
  async heatPumpStateHistory(this: TimeseriesStoreInternals,
      query: HeatPumpStateHistoryQuery,
    ): Promise<HeatPumpStateRecord[]> {
      const limit = positiveInteger(query.limit, 20_000, MAX_HISTORY_LIMIT);
      const result = await this.__query<HeatPumpStateRow>(`SELECT connection_id, house_id, equipment_id,
          device_id, name, brand, model, transport, floor_id, room_id, x, y, z,
          observed_at, received_at, available, power, selected_mode,
          target_temperature_c, current_temperature_c, current_temperature_source,
          current_humidity_percent, target_humidity_percent, fan_speed,
          horizontal_swing, vertical_swing, fresh_air, anion, sleep, light, quiet, turbo, xfan,
          steady_heat, power_save, clean_filter, water_full, dehumidifier_mode, compressor_frequency_hz,
          diagnostics, activity, activity_evidence
        FROM (
          SELECT connection_id, house_id, equipment_id, device_id, name, brand, model, transport,
            floor_id, room_id, x, y, z, observed_at,
            received_at, available, power, selected_mode, target_temperature_c, current_temperature_c,
            current_temperature_source, current_humidity_percent, target_humidity_percent,
            fan_speed, horizontal_swing, vertical_swing, fresh_air, anion, sleep, light, quiet, turbo,
            xfan, steady_heat, power_save, clean_filter, water_full, dehumidifier_mode,
            compressor_frequency_hz, diagnostics, activity, activity_evidence, ingested_at
          FROM ${qualifiedName(this.schema, "heat_pump_state_samples")}
          WHERE connection_id = $1
            AND observed_at >= $2::TIMESTAMPTZ AND observed_at <= $3::TIMESTAMPTZ
          ORDER BY observed_at DESC, ingested_at DESC
          LIMIT $4
        ) recent
        ORDER BY observed_at ASC`, [query.connectionId, query.from, query.to, limit], query);
      return result.rows.map(heatPumpStateFromRow);
    },
});
