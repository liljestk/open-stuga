import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  HYPERTABLE_DEFINITIONS,
  MEASUREMENT_BUCKETS,
  TELEMETRY_TABLES,
  buildBaseSchemaSql,
  buildContinuousAggregateSql,
  buildFallbackAggregateSql,
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
  LegacyReadingHistoryQuery,
  LegacyReadingRecord,
  MeasurementBucketQuery,
  MeasurementBucketRecord,
  MeasurementCoverageQuery,
  MeasurementCoverageRecord,
  MeasurementHistoryQuery,
  MeasurementSampleRecord,
  MeasurementWindowQuery,
  OutdoorTemperatureHistoryQuery,
  OutdoorTemperatureRecord,
  QueryControl,
  TelemetryHealth,
  TelemetrySchemaInitResult,
  TelemetryStorageStats,
  TelemetryStoreOptions,
  TelemetryTableStorage,
} from "../../types.js";
import { ArchiveCheckpointRow, ElectricityPriceRow, LatestLegacyReadingFilter, LatestMeasurementFilter, LegacyReadingRow, MAX_HISTORY_LIMIT, MAX_MEASUREMENT_WINDOW_LIMIT, MeasurementBucketRow, MeasurementCoverageRow, MeasurementRow, OutdoorTemperatureRow, SqlValue, electricityPriceFromRow, legacyReadingFromRow, measurementBucketFromRow, measurementFromRow, outdoorTemperatureFromRow, positiveInteger, timestamp } from "../support/01-default-schema-to-measurement-bucket-from-row.js";
import { registerTimeseriesStoreMethods, timeseriesStoreState, type TimeseriesStoreInternals } from "../core.js";

registerTimeseriesStoreMethods({
  async __writeBatches<T>(this: TimeseriesStoreInternals,
      table: (typeof TELEMETRY_TABLES)[number],
      columns: readonly string[],
      conflictColumns: readonly string[],
      updateColumns: readonly string[],
      records: readonly T[],
      valuesFor: (record: T) => readonly SqlValue[],
      control: QueryControl,
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
        const sql = `INSERT INTO ${qualifiedName(this.schema, table)} AS current_row
          (${columns.map(quoteIdentifier).join(", ")})
          VALUES ${tuples.join(", ")}
          ON CONFLICT (${conflictColumns.map(quoteIdentifier).join(", ")}) DO UPDATE SET
            ${assignments.join(", ")}
          WHERE ROW(${distinctCurrent}) IS DISTINCT FROM ROW(${distinctIncoming})`;
        const result = await this.__query(sql, values, control);
        affected += result.rowCount ?? 0;
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
      for (const table of TELEMETRY_TABLES) {
        const result = await this.__query(
          `DELETE FROM ${qualifiedName(this.schema, table)} WHERE source = ANY($1::TEXT[])`,
          [[...sources]],
          control,
        );
        deleted += result.rowCount ?? 0;
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
      const result = await this.__query<MeasurementRow>(`SELECT sensor_id, metric, value, canonical_unit,
          observed_at, source, quality, metadata
        FROM (
          SELECT sensor_id, metric, value, canonical_unit, observed_at, source, quality, metadata, ingested_at
          FROM ${qualifiedName(this.schema, "measurement_samples")}
          WHERE sensor_id = $1 AND metric = $2 AND observed_at >= $3::TIMESTAMPTZ AND observed_at <= $4::TIMESTAMPTZ
          ORDER BY observed_at DESC, ingested_at DESC, source DESC
          LIMIT $5
        ) recent
        ORDER BY observed_at ASC, source ASC`, [query.sensorId, query.metric, query.from, query.to, limit], query);
      return result.rows.map(measurementFromRow);
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
});
