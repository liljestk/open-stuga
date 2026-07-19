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
} from "./schema.js";
import type {
  AggregateRefreshQuery,
  ArchiveCheckpoint,
  ArchiveTableName,
  BatchWriteResult,
  ColdStorageMode,
  ElectricityPriceHistoryQuery,
  ElectricityPriceRecord,
  LegacyReadingHistoryQuery,
  LegacyReadingRecord,
  MeasurementBucketQuery,
  MeasurementBucketRecord,
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
} from "./types.js";

const DEFAULT_SCHEMA = "telemetry";
const DEFAULT_POOL_SIZE = 4;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_BATCH_SIZE = 1_000;
const MAX_HISTORY_LIMIT = 100_000;
const MAX_MEASUREMENT_WINDOW_LIMIT = 250_000;
const QUERY_TAG_PREFIX = "stuga-telemetry-query:";

type SqlValue = string | number | boolean | null | readonly string[] | Readonly<Record<string, unknown>>;

interface ExtensionRow extends QueryResultRow {
  timescale_version: string | null;
}

interface ProcedureFeatureRow extends QueryResultRow {
  columnstore_available: boolean;
  compression_available: boolean;
  continuous_policy_available: boolean;
}

interface RelationKindRow extends QueryResultRow {
  relkind: string;
}

interface ContinuousAggregateRow extends QueryResultRow {
  configured: boolean;
}

interface MeasurementRow extends QueryResultRow {
  sensor_id: string;
  metric: string;
  value: number;
  canonical_unit: string;
  observed_at: string | Date;
  source: string;
  quality: string;
  metadata: Readonly<Record<string, unknown>>;
}

interface LegacyReadingRow extends QueryResultRow {
  sensor_id: string;
  observed_at: string | Date;
  temperature_c: number;
  relative_humidity_pct: number;
  battery_pct: number | null;
  source: string;
  quality: string;
  metadata: Readonly<Record<string, unknown>>;
}

interface OutdoorTemperatureRow extends QueryResultRow {
  house_id: string;
  location_key: string;
  observed_at: string | Date;
  temperature_c: number;
  source: string;
  fetched_at: string | Date;
  station_id: string | null;
  station_name: string | null;
  metadata: Readonly<Record<string, unknown>>;
}

interface ElectricityPriceRow extends QueryResultRow {
  property_id: string;
  starts_at: string | Date;
  ends_at: string | Date;
  raw_price_cents_per_kwh: number;
  source: string;
  fetched_at: string | Date;
  metadata: Readonly<Record<string, unknown>>;
}

interface MeasurementBucketRow extends QueryResultRow {
  sensor_id: string;
  metric: string;
  bucket_start: string | Date;
  sample_count: string | number;
  average: number;
  minimum: number;
  maximum: number;
  canonical_unit: string;
}

interface HealthRow extends QueryResultRow {
  database_name: string;
  database_size_bytes: string | number;
  timescale_version: string | null;
}

interface StorageRow extends QueryResultRow {
  table_name: string;
  estimated_rows: string | number;
  total_bytes: string | number;
  table_bytes: string | number;
  index_bytes: string | number;
}

interface TimescaleStorageRow extends QueryResultRow {
  table_name: string;
  total_bytes: string | number;
  table_bytes: string | number;
  index_bytes: string | number;
}

interface ArchiveCheckpointRow extends QueryResultRow {
  source_id: string;
  table_name: ArchiveTableName;
  last_row_id: string | number;
  updated_at: string | Date;
}

interface LatestMeasurementFilter extends QueryControl {
  sensorIds?: readonly string[];
  metric?: string;
}

interface LatestLegacyReadingFilter extends QueryControl {
  sensorIds?: readonly string[];
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new RangeError("Expected a positive integer");
  return Math.min(value, maximum);
}

function timeoutValue(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new RangeError("timeoutMs must be a non-negative integer");
  return value;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("The telemetry query was aborted", "AbortError");
}

function measurementFromRow(row: MeasurementRow): MeasurementSampleRecord {
  return {
    sensorId: row.sensor_id,
    metric: row.metric,
    value: Number(row.value),
    canonicalUnit: row.canonical_unit,
    timestamp: timestamp(row.observed_at),
    source: row.source,
    quality: row.quality,
    metadata: row.metadata,
  };
}

function legacyReadingFromRow(row: LegacyReadingRow): LegacyReadingRecord {
  return {
    sensorId: row.sensor_id,
    timestamp: timestamp(row.observed_at),
    temperature: Number(row.temperature_c),
    humidity: Number(row.relative_humidity_pct),
    battery: row.battery_pct === null ? null : Number(row.battery_pct),
    source: row.source,
    quality: row.quality,
    metadata: row.metadata,
  };
}

function outdoorTemperatureFromRow(row: OutdoorTemperatureRow): OutdoorTemperatureRecord {
  return {
    houseId: row.house_id,
    locationKey: row.location_key,
    timestamp: timestamp(row.observed_at),
    temperatureC: Number(row.temperature_c),
    source: row.source,
    fetchedAt: timestamp(row.fetched_at),
    stationId: row.station_id,
    stationName: row.station_name,
    metadata: row.metadata,
  };
}

function electricityPriceFromRow(row: ElectricityPriceRow): ElectricityPriceRecord {
  return {
    propertyId: row.property_id,
    startAt: timestamp(row.starts_at),
    endAt: timestamp(row.ends_at),
    rawPriceCentsPerKwh: Number(row.raw_price_cents_per_kwh),
    source: row.source,
    fetchedAt: timestamp(row.fetched_at),
    metadata: row.metadata,
  };
}

function measurementBucketFromRow(row: MeasurementBucketRow): MeasurementBucketRecord {
  return {
    sensorId: row.sensor_id,
    metric: row.metric,
    bucketStart: timestamp(row.bucket_start),
    sampleCount: Number(row.sample_count),
    average: Number(row.average),
    minimum: Number(row.minimum),
    maximum: Number(row.maximum),
    canonicalUnit: row.canonical_unit,
  };
}

/**
 * Durable time-series storage with a small node-postgres pool. All raw rows are
 * retained; TimescaleDB only adds partitioning, incremental rollups, and cold
 * chunk compression. The base schema and query API also work on PostgreSQL.
 */
export class TimeseriesStore {
  readonly schema: string;
  readonly pool: Pool;

  readonly #ownsPool: boolean;
  readonly #closeInjectedPool: boolean;
  readonly #batchSize: number;
  readonly #defaultTimeoutMs: number;
  readonly #poolErrorListener: (error: Error) => void;
  #closed = false;
  #lastPoolError: Error | null = null;
  #initializePromise: Promise<TelemetrySchemaInitResult> | null = null;

  constructor(options: TelemetryStoreOptions = {}) {
    this.schema = validateSchemaName(options.schema ?? DEFAULT_SCHEMA);
    this.#batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE, 5_000);
    this.#defaultTimeoutMs = timeoutValue(options.statementTimeoutMs, DEFAULT_STATEMENT_TIMEOUT_MS);
    this.#ownsPool = options.pool === undefined;
    this.#closeInjectedPool = options.closeInjectedPool ?? false;

    const max = positiveInteger(
      options.maxConnections ?? options.poolConfig?.max,
      DEFAULT_POOL_SIZE,
      100,
    );
    const connectionTimeoutMillis = timeoutValue(
      options.connectionTimeoutMs ?? (
        typeof options.poolConfig?.connectionTimeoutMillis === "number"
          ? options.poolConfig.connectionTimeoutMillis
          : undefined
      ),
      DEFAULT_CONNECTION_TIMEOUT_MS,
    );
    const idleTimeoutMillis = timeoutValue(
      options.idleTimeoutMs ?? (
        typeof options.poolConfig?.idleTimeoutMillis === "number" ? options.poolConfig.idleTimeoutMillis : undefined
      ),
      DEFAULT_IDLE_TIMEOUT_MS,
    );
    const statementTimeout = timeoutValue(
      options.statementTimeoutMs ?? (
        typeof options.poolConfig?.statement_timeout === "number" ? options.poolConfig.statement_timeout : undefined
      ),
      DEFAULT_STATEMENT_TIMEOUT_MS,
    );

    this.pool = options.pool ?? new Pool({
      ...options.poolConfig,
      ...(options.connectionString === undefined ? {} : { connectionString: options.connectionString }),
      max,
      connectionTimeoutMillis,
      idleTimeoutMillis,
      statement_timeout: statementTimeout,
      application_name: options.applicationName ?? "stuga-telemetry",
      allowExitOnIdle: options.poolConfig?.allowExitOnIdle ?? true,
      keepAlive: options.poolConfig?.keepAlive ?? true,
    });

    this.#poolErrorListener = (error) => {
      this.#lastPoolError = error;
      options.onPoolError?.(error);
    };
    this.pool.on("error", this.#poolErrorListener);
  }

  async initialize(control: QueryControl = {}): Promise<TelemetrySchemaInitResult> {
    if (this.#initializePromise) return this.#initializePromise;
    const pending = this.#initialize(control);
    this.#initializePromise = pending;
    try {
      return await pending;
    } catch (error) {
      if (this.#initializePromise === pending) this.#initializePromise = null;
      throw error;
    }
  }

  /**
   * Allows a supervising worker to retry capability provisioning after a
   * resolved-but-incomplete initialization (for example, a transient DDL
   * timeout). In-flight queries are not cancelled.
   */
  invalidateInitialization(): void {
    this.#initializePromise = null;
  }

  async #initialize(control: QueryControl): Promise<TelemetrySchemaInitResult> {
    for (const sql of buildBaseSchemaSql(this.schema)) await this.#query(sql, [], control);

    const warnings: string[] = [];
    try {
      await this.#query("CREATE EXTENSION IF NOT EXISTS timescaledb", [], control);
    } catch (error) {
      if (control.signal?.aborted) throw abortError(control.signal);
      warnings.push(`TimescaleDB extension could not be enabled: ${describeError(error)}`);
    }

    const extension = await this.#query<ExtensionRow>(`SELECT (
        SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'
      ) AS timescale_version`, [], control);
    const timescaleVersion = extension.rows[0]?.timescale_version ?? null;
    const hypertables: string[] = [];

    if (timescaleVersion) {
      for (const definition of HYPERTABLE_DEFINITIONS) {
        try {
          await this.#query(
            `SELECT create_hypertable(
              $1::REGCLASS,
              $2,
              chunk_time_interval => $3::INTERVAL,
              if_not_exists => TRUE,
              migrate_data => TRUE,
              create_default_indexes => FALSE
            )`,
            [qualifiedName(this.schema, definition.table), definition.timeColumn, definition.chunkInterval],
            control,
          );
        } catch (error) {
          if (control.signal?.aborted) throw abortError(control.signal);
          warnings.push(`Could not convert ${definition.table} to a hypertable: ${describeError(error)}`);
        }
      }
      for (const definition of HYPERTABLE_DEFINITIONS) {
        try {
          const validation = await this.#query<{ configured: boolean }>(`SELECT EXISTS (
              SELECT 1
              FROM timescaledb_information.hypertables hypertable
              JOIN timescaledb_information.dimensions dimension
                ON dimension.hypertable_schema = hypertable.hypertable_schema
               AND dimension.hypertable_name = hypertable.hypertable_name
              WHERE hypertable.hypertable_schema = $1
                AND hypertable.hypertable_name = $2
                AND dimension.column_name = $3
                AND dimension.time_interval = $4::INTERVAL
            ) AS configured`, [this.schema, definition.table, definition.timeColumn, definition.chunkInterval], control);
          if (validation.rows[0]?.configured === true) hypertables.push(definition.table);
          else warnings.push(`Hypertable validation failed for ${definition.table}`);
        } catch (error) {
          if (control.signal?.aborted) throw abortError(control.signal);
          warnings.push(`Could not validate ${definition.table} hypertable: ${describeError(error)}`);
        }
      }
    }

    const features = timescaleVersion
      ? await this.#detectTimescaleFeatures(control)
      : { columnstore_available: false, compression_available: false, continuous_policy_available: false };
    const coldStorageMode = await this.#configureColdStorage(hypertables, features, warnings, control);
    const aggregateMode = hypertables.includes("measurement_samples")
      ? await this.#configureContinuousAggregates(features.continuous_policy_available, warnings, control)
      : await this.#configureFallbackAggregates(warnings, control);

    return {
      schema: this.schema,
      timescaleAvailable: timescaleVersion !== null,
      timescaleVersion,
      hypertables,
      aggregateMode,
      coldStorageMode,
      warnings,
    };
  }

  async #detectTimescaleFeatures(control: QueryControl): Promise<ProcedureFeatureRow> {
    const result = await this.#query<ProcedureFeatureRow>(`SELECT
      EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'add_columnstore_policy') AS columnstore_available,
      EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'add_compression_policy') AS compression_available,
      EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'add_continuous_aggregate_policy') AS continuous_policy_available`, [], control);
    return result.rows[0] ?? {
      columnstore_available: false,
      compression_available: false,
      continuous_policy_available: false,
    };
  }

  async #configureColdStorage(
    hypertables: readonly string[],
    features: ProcedureFeatureRow,
    warnings: string[],
    control: QueryControl,
  ): Promise<ColdStorageMode> {
    if (hypertables.length === 0) return "none";
    const definitions = HYPERTABLE_DEFINITIONS.filter(({ table }) => hypertables.includes(table));

    if (features.columnstore_available) {
      let configured = 0;
      for (const definition of definitions) {
        try {
          await this.#query(`ALTER TABLE ${qualifiedName(this.schema, definition.table)} SET (
            timescaledb.enable_columnstore = true,
            timescaledb.segmentby = '${definition.segmentBy}',
            timescaledb.orderby = '${definition.orderBy}'
          )`, [], control);
          await this.#query(
            "CALL add_columnstore_policy($1::REGCLASS, after => $2::INTERVAL, if_not_exists => TRUE)",
            [qualifiedName(this.schema, definition.table), definition.coldAfter],
            control,
          );
          configured += 1;
        } catch (error) {
          if (control.signal?.aborted) throw abortError(control.signal);
          warnings.push(`Columnstore setup failed for ${definition.table}: ${describeError(error)}`);
        }
      }
      if (configured > 0) return "columnstore";
    }

    if (features.compression_available) {
      let configured = 0;
      for (const definition of definitions) {
        try {
          await this.#query(`ALTER TABLE ${qualifiedName(this.schema, definition.table)} SET (
            timescaledb.compress = true,
            timescaledb.compress_segmentby = '${definition.segmentBy}',
            timescaledb.compress_orderby = '${definition.orderBy}'
          )`, [], control);
          await this.#query(
            "SELECT add_compression_policy($1::REGCLASS, $2::INTERVAL, if_not_exists => TRUE)",
            [qualifiedName(this.schema, definition.table), definition.coldAfter],
            control,
          );
          configured += 1;
        } catch (error) {
          if (control.signal?.aborted) throw abortError(control.signal);
          warnings.push(`Compression setup failed for ${definition.table}: ${describeError(error)}`);
        }
      }
      if (configured > 0) return "compression";
    }
    return "none";
  }

  async #configureContinuousAggregates(
    policyAvailable: boolean,
    warnings: string[],
    control: QueryControl,
  ): Promise<"continuous" | "view" | "unavailable"> {
    try {
      for (const bucket of Object.keys(MEASUREMENT_BUCKETS) as Array<keyof typeof MEASUREMENT_BUCKETS>) {
        const name = measurementAggregateName(bucket);
        // Timescale 2.28 exposes a continuous aggregate as relkind = 'v', the
        // same pg_class kind as our plain-PostgreSQL fallback. Only the
        // Timescale catalog can distinguish the two safely.
        if (await this.#isContinuousAggregate(name, control)) continue;
        const kind = await this.#relationKind(name, control);
        if (kind === "v") await this.#query(`DROP VIEW ${qualifiedName(this.schema, name)}`, [], control);
        else if (kind !== null) {
          throw new Error(`Cannot replace ${name}: unexpected relation kind ${kind}`);
        }
        await this.#query(buildContinuousAggregateSql(this.schema, bucket), [], control);
      }
    } catch (error) {
      if (control.signal?.aborted) throw abortError(control.signal);
      warnings.push(`Continuous aggregate setup failed: ${describeError(error)}`);
      return this.#configureFallbackAggregates(warnings, control, true);
    }

    if (policyAvailable) {
      const policies = [
        ["5m", "30 days", "5 minutes", "5 minutes"],
        ["1h", "1 year", "1 hour", "1 hour"],
        ["1d", "10 years", "1 day", "1 day"],
      ] as const;
      for (const [bucket, startOffset, endOffset, scheduleInterval] of policies) {
        try {
          await this.#query(`SELECT add_continuous_aggregate_policy(
              $1::REGCLASS,
              start_offset => $2::INTERVAL,
              end_offset => $3::INTERVAL,
              schedule_interval => $4::INTERVAL,
              if_not_exists => TRUE
            )`, [
            qualifiedName(this.schema, measurementAggregateName(bucket)),
            startOffset,
            endOffset,
            scheduleInterval,
          ], control);
        } catch (error) {
          if (control.signal?.aborted) throw abortError(control.signal);
          warnings.push(`Refresh policy setup failed for ${bucket} aggregates: ${describeError(error)}`);
        }
      }
    }
    return "continuous";
  }

  async #configureFallbackAggregates(
    warnings: string[],
    control: QueryControl,
    preserveContinuousAggregates = false,
  ): Promise<"continuous" | "view" | "unavailable"> {
    try {
      let retainedContinuousAggregate = false;
      for (const bucket of Object.keys(MEASUREMENT_BUCKETS) as Array<keyof typeof MEASUREMENT_BUCKETS>) {
        const name = measurementAggregateName(bucket);
        if (preserveContinuousAggregates && await this.#isContinuousAggregate(name, control)) {
          retainedContinuousAggregate = true;
          continue;
        }
        const kind = await this.#relationKind(name, control);
        if (kind !== null && kind !== "v") {
          throw new Error(`Cannot replace ${name}: unexpected relation kind ${kind}`);
        }
        await this.#query(buildFallbackAggregateSql(this.schema, bucket), [], control);
      }
      return retainedContinuousAggregate ? "continuous" : "view";
    } catch (error) {
      if (control.signal?.aborted) throw abortError(control.signal);
      warnings.push(`PostgreSQL aggregate view setup failed: ${describeError(error)}`);
      return "unavailable";
    }
  }

  async #relationKind(relation: string, control: QueryControl): Promise<string | null> {
    const result = await this.#query<RelationKindRow>(`SELECT c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2`, [this.schema, relation], control);
    return result.rows[0]?.relkind ?? null;
  }

  async #isContinuousAggregate(relation: string, control: QueryControl): Promise<boolean> {
    const result = await this.#query<ContinuousAggregateRow>(`SELECT EXISTS (
        SELECT 1
        FROM timescaledb_information.continuous_aggregates
        WHERE view_schema = $1 AND view_name = $2
      ) AS configured`, [this.schema, relation], control);
    return result.rows[0]?.configured === true;
  }

  async upsertMeasurementSamples(
    samples: readonly MeasurementSampleRecord[],
    control: QueryControl = {},
  ): Promise<BatchWriteResult> {
    return this.#writeBatches(
      "measurement_samples",
      ["sensor_id", "metric", "observed_at", "source", "value", "canonical_unit", "quality", "metadata"],
      ["sensor_id", "metric", "observed_at", "source"],
      ["value", "canonical_unit", "quality", "metadata"],
      samples,
      (sample) => [
        sample.sensorId, sample.metric, sample.timestamp, sample.source, sample.value,
        sample.canonicalUnit, sample.quality, sample.metadata ?? {},
      ],
      control,
    );
  }

  async upsertLegacyReadings(
    readings: readonly LegacyReadingRecord[],
    control: QueryControl = {},
  ): Promise<BatchWriteResult> {
    return this.#writeBatches(
      "legacy_readings",
      [
        "sensor_id", "observed_at", "source", "temperature_c", "relative_humidity_pct",
        "battery_pct", "quality", "metadata",
      ],
      ["sensor_id", "observed_at", "source"],
      ["temperature_c", "relative_humidity_pct", "battery_pct", "quality", "metadata"],
      readings,
      (reading) => [
        reading.sensorId, reading.timestamp, reading.source, reading.temperature, reading.humidity,
        reading.battery, reading.quality, reading.metadata ?? {},
      ],
      control,
    );
  }

  async upsertOutdoorTemperatureSamples(
    samples: readonly OutdoorTemperatureRecord[],
    control: QueryControl = {},
  ): Promise<BatchWriteResult> {
    return this.#writeBatches(
      "outdoor_temperature_samples",
      [
        "house_id", "location_key", "observed_at", "source", "temperature_c", "fetched_at",
        "station_id", "station_name", "metadata",
      ],
      ["house_id", "location_key", "observed_at", "source"],
      ["temperature_c", "fetched_at", "station_id", "station_name", "metadata"],
      samples,
      (sample) => [
        sample.houseId, sample.locationKey, sample.timestamp, sample.source, sample.temperatureC,
        sample.fetchedAt, sample.stationId, sample.stationName, sample.metadata ?? {},
      ],
      control,
    );
  }

  async upsertElectricityPriceSamples(
    samples: readonly ElectricityPriceRecord[],
    control: QueryControl = {},
  ): Promise<BatchWriteResult> {
    return this.#writeBatches(
      "electricity_price_samples",
      ["property_id", "starts_at", "source", "ends_at", "raw_price_cents_per_kwh", "fetched_at", "metadata"],
      ["property_id", "starts_at", "source"],
      ["ends_at", "raw_price_cents_per_kwh", "fetched_at", "metadata"],
      samples,
      (sample) => [
        sample.propertyId, sample.startAt, sample.source, sample.endAt,
        sample.rawPriceCentsPerKwh, sample.fetchedAt, sample.metadata ?? {},
      ],
      control,
    );
  }

  async #writeBatches<T>(
    table: (typeof TELEMETRY_TABLES)[number],
    columns: readonly string[],
    conflictColumns: readonly string[],
    updateColumns: readonly string[],
    records: readonly T[],
    valuesFor: (record: T) => readonly SqlValue[],
    control: QueryControl,
  ): Promise<BatchWriteResult> {
    if (records.length === 0) return { attempted: 0, affected: 0 };
    const parameterSafeBatchSize = Math.min(this.#batchSize, Math.floor(60_000 / columns.length));
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
      const result = await this.#query(sql, values, control);
      affected += result.rowCount ?? 0;
    }
    return { attempted: records.length, affected };
  }

  async getArchiveCheckpoint(
    sourceId: string,
    tableName: ArchiveTableName,
    control: QueryControl = {},
  ): Promise<ArchiveCheckpoint | null> {
    const result = await this.#query<ArchiveCheckpointRow>(`SELECT source_id, table_name, last_row_id, updated_at
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
  }

  /** Returns zero for a source/table pair that has never been archived. */
  async archiveCheckpoint(
    sourceId: string,
    tableName: ArchiveTableName,
    control: QueryControl = {},
  ): Promise<number> {
    return (await this.getArchiveCheckpoint(sourceId, tableName, control))?.lastRowId ?? 0;
  }

  /** Atomically advances a cursor and never lets overlapping workers move it backwards. */
  async setArchiveCheckpoint(
    sourceId: string,
    tableName: ArchiveTableName,
    lastRowId: number,
    control: QueryControl = {},
  ): Promise<ArchiveCheckpoint> {
    if (!Number.isSafeInteger(lastRowId) || lastRowId < 0) {
      throw new RangeError("lastRowId must be a non-negative safe integer");
    }
    const result = await this.#query<ArchiveCheckpointRow>(`INSERT INTO ${qualifiedName(this.schema, "archive_checkpoints")} AS checkpoint
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
  }

  async saveArchiveCheckpoint(
    sourceId: string,
    tableName: ArchiveTableName,
    lastRowId: number,
    control: QueryControl = {},
  ): Promise<void> {
    await this.setArchiveCheckpoint(sourceId, tableName, lastRowId, control);
  }

  /** Mirrors SQLite's one-way real-data latch by removing synthetic sources. */
  async deleteTelemetrySources(sources: readonly string[], control: QueryControl = {}): Promise<number> {
    if (sources.length === 0) return 0;
    let deleted = 0;
    for (const table of TELEMETRY_TABLES) {
      const result = await this.#query(
        `DELETE FROM ${qualifiedName(this.schema, table)} WHERE source = ANY($1::TEXT[])`,
        [[...sources]],
        control,
      );
      deleted += result.rowCount ?? 0;
    }
    return deleted;
  }

  /** Persistently applies SQLite's one-way transition from demo to real data. */
  async enforceRealDataBoundary(
    sourceId: string,
    activatedAt: string,
    control: QueryControl = {},
  ): Promise<number> {
    const current = await this.#query<{ real_data_activated_at: string | Date }>(`SELECT real_data_activated_at
      FROM ${qualifiedName(this.schema, "archive_source_state")} WHERE source_id = $1`, [sourceId], control);
    if (current.rows[0] && timestamp(current.rows[0].real_data_activated_at) === new Date(activatedAt).toISOString()) return 0;
    const deleted = await this.deleteTelemetrySources(["mock", "replay"], control);
    await this.#query(`INSERT INTO ${qualifiedName(this.schema, "archive_source_state")}
        (source_id, real_data_activated_at, enforced_at)
      VALUES ($1, $2::TIMESTAMPTZ, clock_timestamp())
      ON CONFLICT (source_id) DO UPDATE SET
        real_data_activated_at = EXCLUDED.real_data_activated_at,
        enforced_at = EXCLUDED.enforced_at`, [sourceId, activatedAt], control);
    return deleted;
  }

  async latestMeasurementSample(
    sensorId: string,
    metric: string,
    control: QueryControl = {},
  ): Promise<MeasurementSampleRecord | null> {
    const result = await this.#query<MeasurementRow>(`SELECT sensor_id, metric, value, canonical_unit,
        observed_at, source, quality, metadata
      FROM ${qualifiedName(this.schema, "measurement_samples")}
      WHERE sensor_id = $1 AND metric = $2
      ORDER BY observed_at DESC, ingested_at DESC, source DESC
      LIMIT 1`, [sensorId, metric], control);
    return result.rows[0] ? measurementFromRow(result.rows[0]) : null;
  }

  async latestMeasurementSamples(filter: LatestMeasurementFilter = {}): Promise<MeasurementSampleRecord[]> {
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
    const result = await this.#query<MeasurementRow>(`SELECT DISTINCT ON (sensor_id, metric)
        sensor_id, metric, value, canonical_unit, observed_at, source, quality, metadata
      FROM ${qualifiedName(this.schema, "measurement_samples")}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY sensor_id, metric, observed_at DESC, ingested_at DESC, source DESC`, values, filter);
    return result.rows.map(measurementFromRow);
  }

  async measurementHistory(query: MeasurementHistoryQuery): Promise<MeasurementSampleRecord[]> {
    const limit = positiveInteger(query.limit, 20_000, MAX_HISTORY_LIMIT);
    const result = await this.#query<MeasurementRow>(`SELECT sensor_id, metric, value, canonical_unit,
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
  }

  async measurementWindow(query: MeasurementWindowQuery): Promise<MeasurementSampleRecord[]> {
    if (query.sensorIds.length === 0 || query.metrics.length === 0) return [];
    const limit = positiveInteger(query.limit, 100_000, MAX_MEASUREMENT_WINDOW_LIMIT);
    const result = await this.#query<MeasurementRow>(`SELECT sensor_id, metric, value, canonical_unit,
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
  }

  async measurementBuckets(query: MeasurementBucketQuery): Promise<MeasurementBucketRecord[]> {
    const limit = positiveInteger(query.limit, 20_000, MAX_HISTORY_LIMIT);
    const aggregate = measurementAggregateName(query.bucket);
    const result = await this.#query<MeasurementBucketRow>(`SELECT sensor_id, metric, bucket_start,
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
  }

  async latestLegacyReadings(filter: LatestLegacyReadingFilter = {}): Promise<LegacyReadingRecord[]> {
    if (filter.sensorIds?.length === 0) return [];
    const values: SqlValue[] = [];
    const where = filter.sensorIds
      ? (() => {
        values.push([...filter.sensorIds]);
        return "WHERE sensor_id = ANY($1::TEXT[])";
      })()
      : "";
    const result = await this.#query<LegacyReadingRow>(`SELECT DISTINCT ON (sensor_id)
        sensor_id, observed_at, temperature_c, relative_humidity_pct, battery_pct, source, quality, metadata
      FROM ${qualifiedName(this.schema, "legacy_readings")}
      ${where}
      ORDER BY sensor_id, observed_at DESC, ingested_at DESC, source DESC`, values, filter);
    return result.rows.map(legacyReadingFromRow);
  }

  async legacyReadingHistory(query: LegacyReadingHistoryQuery): Promise<LegacyReadingRecord[]> {
    if (query.sensorIds.length === 0) return [];
    const limit = positiveInteger(query.limit, 20_000, MAX_HISTORY_LIMIT);
    const result = await this.#query<LegacyReadingRow>(`SELECT sensor_id, observed_at, temperature_c,
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
  }

  async outdoorTemperatureHistory(query: OutdoorTemperatureHistoryQuery): Promise<OutdoorTemperatureRecord[]> {
    const limit = positiveInteger(query.limit, 20_000, MAX_HISTORY_LIMIT);
    const result = await this.#query<OutdoorTemperatureRow>(`SELECT house_id, location_key, observed_at,
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
  }

  async electricityPriceHistory(query: ElectricityPriceHistoryQuery): Promise<ElectricityPriceRecord[]> {
    const limit = positiveInteger(query.limit, 20_000, MAX_HISTORY_LIMIT);
    const result = await this.#query<ElectricityPriceRow>(`SELECT property_id, starts_at, ends_at,
        raw_price_cents_per_kwh, source, fetched_at, metadata
      FROM (
        SELECT property_id, starts_at, ends_at, raw_price_cents_per_kwh, source, fetched_at, metadata, ingested_at
        FROM ${qualifiedName(this.schema, "electricity_price_samples")}
        WHERE property_id = $1 AND starts_at >= $2::TIMESTAMPTZ AND starts_at <= $3::TIMESTAMPTZ
        ORDER BY starts_at DESC, ingested_at DESC, source DESC
        LIMIT $4
      ) recent
      ORDER BY starts_at ASC, source ASC`, [query.propertyId, query.from, query.to, limit], query);
    return result.rows.map(electricityPriceFromRow);
  }

  /** Refreshes all three Timescale rollups after a historical import. */
  async refreshMeasurementAggregates(query: AggregateRefreshQuery = {}): Promise<number> {
    const extension = await this.#query<ExtensionRow>(`SELECT (
      SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'
    ) AS timescale_version`, [], query);
    if (!extension.rows[0]?.timescale_version) return 0;

    let refreshed = 0;
    for (const bucket of Object.keys(MEASUREMENT_BUCKETS) as Array<keyof typeof MEASUREMENT_BUCKETS>) {
      const aggregate = measurementAggregateName(bucket);
      if (!await this.#isContinuousAggregate(aggregate, query)) continue;
      await this.#query(
        "CALL refresh_continuous_aggregate($1::REGCLASS, $2::TIMESTAMPTZ, $3::TIMESTAMPTZ)",
        [qualifiedName(this.schema, aggregate), query.from ?? null, query.to ?? null],
        query,
      );
      refreshed += 1;
    }
    return refreshed;
  }

  async health(control: QueryControl = {}): Promise<TelemetryHealth> {
    const startedAt = performance.now();
    try {
      const result = await this.#query<HealthRow>(`SELECT
        current_database() AS database_name,
        pg_database_size(current_database())::BIGINT AS database_size_bytes,
        (SELECT extversion FROM pg_extension WHERE extname = 'timescaledb') AS timescale_version`, [], control);
      const row = result.rows[0];
      return {
        ok: row !== undefined,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.max(0, performance.now() - startedAt),
        database: row?.database_name ?? null,
        databaseSizeBytes: row ? Number(row.database_size_bytes) : null,
        timescaleAvailable: row?.timescale_version != null,
        timescaleVersion: row?.timescale_version ?? null,
        pool: this.#poolHealth(),
        lastPoolError: this.#lastPoolError ? describeError(this.#lastPoolError) : null,
      };
    } catch (error) {
      if (control.signal?.aborted) throw abortError(control.signal);
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.max(0, performance.now() - startedAt),
        database: null,
        databaseSizeBytes: null,
        timescaleAvailable: false,
        timescaleVersion: null,
        pool: this.#poolHealth(),
        lastPoolError: this.#lastPoolError ? describeError(this.#lastPoolError) : null,
        error: describeError(error),
      };
    }
  }

  async storageStats(control: QueryControl = {}): Promise<TelemetryStorageStats> {
    const result = await this.#query<StorageRow>(`SELECT
        c.relname AS table_name,
        COALESCE(s.n_live_tup, 0)::BIGINT AS estimated_rows,
        pg_total_relation_size(c.oid)::BIGINT AS total_bytes,
        pg_relation_size(c.oid)::BIGINT AS table_bytes,
        pg_indexes_size(c.oid)::BIGINT AS index_bytes
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE n.nspname = $1 AND c.relname = ANY($2::TEXT[])
      ORDER BY c.relname`, [this.schema, TELEMETRY_TABLES], control);
    const byTable = new Map<string, TelemetryTableStorage>();
    for (const row of result.rows) {
      if (!TELEMETRY_TABLES.includes(row.table_name as (typeof TELEMETRY_TABLES)[number])) continue;
      byTable.set(row.table_name, {
        table: row.table_name as TelemetryTableStorage["table"],
        estimatedRows: Number(row.estimated_rows),
        totalBytes: Number(row.total_bytes),
        tableBytes: Number(row.table_bytes),
        indexBytes: Number(row.index_bytes),
      });
    }

    try {
      const timescale = await this.#query<TimescaleStorageRow>(`SELECT
          h.hypertable_name AS table_name,
          size.total_bytes::BIGINT AS total_bytes,
          size.table_bytes::BIGINT AS table_bytes,
          size.index_bytes::BIGINT AS index_bytes
        FROM timescaledb_information.hypertables h
        CROSS JOIN LATERAL hypertable_detailed_size(
          format('%I.%I', h.hypertable_schema, h.hypertable_name)::REGCLASS
        ) size
        WHERE h.hypertable_schema = $1 AND h.hypertable_name = ANY($2::TEXT[])`, [this.schema, TELEMETRY_TABLES], control);
      for (const row of timescale.rows) {
        const current = byTable.get(row.table_name);
        if (!current) continue;
        current.totalBytes = Number(row.total_bytes);
        current.tableBytes = Number(row.table_bytes);
        current.indexBytes = Number(row.index_bytes);
      }
    } catch (error) {
      if (control.signal?.aborted) throw abortError(control.signal);
      // Plain PostgreSQL has no Timescale information schema; base sizes remain valid.
    }

    const database = await this.#query<{ database_size_bytes: string | number }>(
      "SELECT pg_database_size(current_database())::BIGINT AS database_size_bytes",
      [],
      control,
    );
    return {
      capturedAt: new Date().toISOString(),
      databaseSizeBytes: Number(database.rows[0]?.database_size_bytes ?? 0),
      tables: TELEMETRY_TABLES.map((table) => byTable.get(table) ?? {
        table,
        estimatedRows: 0,
        totalBytes: 0,
        tableBytes: 0,
        indexBytes: 0,
      }),
    };
  }

  #poolHealth(): { total: number; idle: number; waiting: number } {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.pool.off("error", this.#poolErrorListener);
    if (this.#ownsPool || this.#closeInjectedPool) await this.pool.end();
  }

  async #query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: readonly SqlValue[] = [],
    control: QueryControl = {},
  ): Promise<QueryResult<Row>> {
    if (this.#closed) throw new Error("TimeseriesStore is closed");
    const timeoutMs = timeoutValue(control.timeoutMs, this.#defaultTimeoutMs);
    const timeoutController = timeoutMs > 0 ? new AbortController() : null;
    const timeout = timeoutController
      ? setTimeout(() => timeoutController.abort(new DOMException(
        `Telemetry query timed out after ${timeoutMs}ms`,
        "TimeoutError",
      )), timeoutMs)
      : null;
    timeout?.unref();
    const signal = control.signal && timeoutController
      ? AbortSignal.any([control.signal, timeoutController.signal])
      : control.signal ?? timeoutController?.signal;

    try {
      return await this.#runQuery<Row>(sql, values, signal);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async #runQuery<Row extends QueryResultRow>(
    sql: string,
    values: readonly SqlValue[],
    signal: AbortSignal | undefined,
  ): Promise<QueryResult<Row>> {
    if (signal?.aborted) throw abortError(signal);
    const client = await this.#connect(signal);
    if (signal?.aborted) {
      client.release();
      throw abortError(signal);
    }

    const token = randomUUID();
    const taggedSql = `${sql}\n/* ${QUERY_TAG_PREFIX}${token} */`;
    let settled = false;
    let releaseDeferred = false;
    let abortListener: (() => void) | null = null;
    const rawQuery = client.query<Row>({ text: taggedSql, values: [...values] });
    const query = rawQuery.then(
      (result) => {
        settled = true;
        return result;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );

    const raced = signal
      ? Promise.race([
        query,
        new Promise<never>((_resolve, reject) => {
          abortListener = () => {
            void this.#cancelBackendQuery(client, token);
            reject(abortError(signal));
          };
          signal.addEventListener("abort", abortListener, { once: true });
        }),
      ])
      : query;

    try {
      return await raced;
    } catch (error) {
      if (signal?.aborted && !settled) {
        releaseDeferred = true;
        void query.then(
          () => client.release(),
          () => client.release(),
        );
        throw abortError(signal);
      }
      throw error;
    } finally {
      if (abortListener && signal) signal.removeEventListener("abort", abortListener);
      if (!releaseDeferred) client.release();
    }
  }

  async #connect(signal: AbortSignal | undefined): Promise<PoolClient> {
    const connecting = this.pool.connect();
    if (!signal) return connecting;
    if (signal.aborted) {
      void connecting.then((client) => client.release(), () => undefined);
      throw abortError(signal);
    }

    return new Promise<PoolClient>((resolve, reject) => {
      let completed = false;
      const onAbort = () => {
        if (completed) return;
        completed = true;
        reject(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void connecting.then(
        (client) => {
          signal.removeEventListener("abort", onAbort);
          if (completed || signal.aborted) {
            client.release();
            if (!completed) reject(abortError(signal));
            return;
          }
          completed = true;
          resolve(client);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          if (completed) return;
          completed = true;
          reject(error);
        },
      );
    });
  }

  async #cancelBackendQuery(client: PoolClient, token: string): Promise<void> {
    const processId = (client as PoolClient & { processID?: number }).processID;
    if (!Number.isInteger(processId)) return;
    try {
      await this.pool.query({
        text: `SELECT pg_cancel_backend($1)
          FROM pg_stat_activity
          WHERE pid = $1 AND query LIKE $2`,
        values: [processId, `%${QUERY_TAG_PREFIX}${token}%`],
      });
    } catch {
      // The caller has already been released from waiting. The store-level
      // server statement timeout remains the final safety net.
    }
  }
}
