import type { Pool, PoolConfig } from "pg";

export type TelemetryQuality = "good" | "estimated" | "stale" | (string & {});
export type TelemetrySource = "mock" | "home-assistant" | "tp-link" | "api" | "import" | "replay" | (string & {});
export type TelemetryMetadata = Readonly<Record<string, unknown>>;

export interface QueryControl {
  /** Stops waiting immediately and best-effort cancels the PostgreSQL backend query. */
  signal?: AbortSignal;
  /** Per-operation timeout. Set to 0 to use only the store's server-side default. */
  timeoutMs?: number;
}

export interface MeasurementSampleRecord {
  sensorId: string;
  metric: string;
  value: number;
  canonicalUnit: string;
  timestamp: string;
  source: TelemetrySource;
  quality: TelemetryQuality;
  metadata?: TelemetryMetadata;
}

export interface LegacyReadingRecord {
  sensorId: string;
  timestamp: string;
  temperature: number;
  humidity: number;
  battery: number | null;
  source: TelemetrySource;
  quality: TelemetryQuality;
  metadata?: TelemetryMetadata;
}

export interface OutdoorTemperatureRecord {
  houseId: string;
  locationKey: string;
  timestamp: string;
  temperatureC: number;
  source: TelemetrySource;
  fetchedAt: string;
  stationId: string | null;
  stationName: string | null;
  metadata?: TelemetryMetadata;
}

export interface ElectricityPriceRecord {
  propertyId: string;
  startAt: string;
  endAt: string;
  rawPriceCentsPerKwh: number;
  /** Contract margin captured for this interval so historical effective prices remain stable. */
  marginCentsPerKwh: number;
  source: TelemetrySource;
  fetchedAt: string;
  metadata?: TelemetryMetadata;
}

export interface EnergyCostAggregateQuery extends QueryControl {
  sensorId: string;
  propertyId: string;
  from: string;
  to: string;
}

export interface EnergyCostAggregateRecord {
  deltaCount: number;
  consumptionKwh: number;
  pricedConsumptionKwh: number;
  costEur: number;
  totalDurationMs: number;
  pricedDurationMs: number;
  coverageFrom: string | null;
  coverageUntil: string | null;
}

export interface BatchWriteResult {
  attempted: number;
  affected: number;
}

export type ArchiveTableName =
  | "measurement_samples"
  | "legacy_readings"
  | "outdoor_temperature_samples"
  | "electricity_price_samples";

export interface ArchiveCheckpoint {
  sourceId: string;
  tableName: ArchiveTableName;
  lastRowId: number;
  updatedAt: string;
}

export type MeasurementBucket = "5m" | "1h" | "1d";

export interface MeasurementBucketRecord {
  sensorId: string;
  metric: string;
  bucketStart: string;
  sampleCount: number;
  average: number;
  minimum: number;
  maximum: number;
  canonicalUnit: string;
}

export interface MeasurementHistoryQuery extends QueryControl {
  sensorId: string;
  metric: string;
  from: string;
  to: string;
  limit?: number;
}

/** Bounded multi-sensor raw window used by shared and derived consumers. */
export interface MeasurementWindowQuery extends QueryControl {
  sensorIds: readonly string[];
  metrics: readonly string[];
  from: string;
  to: string;
  limit?: number;
}

export interface MeasurementBucketQuery extends MeasurementHistoryQuery {
  bucket: MeasurementBucket;
}

export interface LegacyReadingHistoryQuery extends QueryControl {
  sensorIds: readonly string[];
  from: string;
  to: string;
  limit?: number;
}

export interface OutdoorTemperatureHistoryQuery extends QueryControl {
  houseId: string;
  locationKey: string;
  from: string;
  to: string;
  limit?: number;
}

export interface ElectricityPriceHistoryQuery extends QueryControl {
  propertyId: string;
  from: string;
  to: string;
  limit?: number;
}

export interface AggregateRefreshQuery extends QueryControl {
  from?: string;
  to?: string;
}

export interface TelemetryStoreOptions {
  connectionString?: string;
  /** An injected pool is useful for a shared process pool or tests. */
  pool?: Pool;
  /** The injected pool remains caller-owned unless this is explicitly true. */
  closeInjectedPool?: boolean;
  poolConfig?: Omit<PoolConfig, "connectionString">;
  schema?: string;
  maxConnections?: number;
  connectionTimeoutMs?: number;
  idleTimeoutMs?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
  batchSize?: number;
  onPoolError?: (error: Error) => void;
}

export type AggregateMode = "continuous" | "view" | "unavailable";
export type ColdStorageMode = "columnstore" | "compression" | "none";

export interface TelemetrySchemaInitResult {
  schema: string;
  timescaleAvailable: boolean;
  timescaleVersion: string | null;
  hypertables: string[];
  aggregateMode: AggregateMode;
  coldStorageMode: ColdStorageMode;
  warnings: string[];
}

export interface PoolHealth {
  total: number;
  idle: number;
  waiting: number;
}

export interface TelemetryHealth {
  ok: boolean;
  checkedAt: string;
  latencyMs: number;
  database: string | null;
  databaseSizeBytes: number | null;
  timescaleAvailable: boolean;
  timescaleVersion: string | null;
  pool: PoolHealth;
  lastPoolError: string | null;
  error?: string;
}

export interface TelemetryTableStorage {
  table: "measurement_samples" | "legacy_readings" | "outdoor_temperature_samples" | "electricity_price_samples";
  estimatedRows: number;
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
}

export interface TelemetryStorageStats {
  capturedAt: string;
  databaseSizeBytes: number;
  tables: TelemetryTableStorage[];
}
