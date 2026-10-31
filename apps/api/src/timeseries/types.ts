import type { AnalyticsResolution, HeatPumpState } from "@climate-twin/contracts";
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

export type HeatPumpStateRecord = HeatPumpState;

export interface HeatPumpStateHistoryQuery extends QueryControl {
  connectionId: string;
  from: string;
  to: string;
  limit?: number;
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

export interface MeasurementCoverageRecord {
  sensorId: string;
  metric: string;
  start: string;
  end: string;
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

export interface OpeningStateRecord {
  observationId: string;
  houseId: string;
  floorId: string;
  elementId: string;
  state: "open" | "closed" | "unknown";
  openFraction: number | null;
  source: TelemetrySource;
  observedAt: string;
  validUntil: string | null;
  externalId: string | null;
  connectionId: string | null;
  recordedAt: string;
  metadata?: TelemetryMetadata;
}

export interface EnergyCostAggregateQuery extends QueryControl {
  sensorId: string;
  propertyId: string;
  from: string;
  to: string;
  /** Real-data mode excludes archived demo/replay measurements. */
  excludeSynthetic?: boolean;
}

export interface MeasurementBoundaryQuery extends QueryControl {
  sensorId: string;
  metric: "energy" | "power";
  from: string;
  to: string;
  qualities: string[];
  excludeSynthetic?: boolean;
}

export type PowerCostAggregateQuery = EnergyCostAggregateQuery;

/** Usage of one UTC hour and its cost at the raw spot price; contract terms are applied later. */
export interface HourlyEnergyUsage {
  /** Epoch milliseconds of the UTC hour start. */
  hourStart: number;
  kwh: number;
  /** kWh that had a raw spot price. */
  spotPricedKwh: number;
  /** Sum of kWh × raw spot price (c/kWh) over the spot-priced kWh. */
  spotCostCents: number;
}

/**
 * Consumption and its raw-spot-price coverage. Prices carry no margin or
 * other contract terms here: the tariff in force is applied per hour.
 */
export interface EnergyCostAggregateRecord {
  deltaCount: number;
  consumptionKwh: number;
  pricedConsumptionKwh: number;
  spotCostEur: number;
  /** Sorted by hourStart; only hours with usage or priced usage. */
  hourly: HourlyEnergyUsage[];
  totalDurationMs: number;
  pricedDurationMs: number;
  maximumIntervalDurationMs: number;
  coverageFrom: string | null;
  coverageUntil: string | null;
  archiveState?: "local-only" | "pending" | "archived";
}

export interface BatchWriteResult {
  attempted: number;
  affected: number;
}

export type ArchiveTableName =
  | "measurement_samples"
  | "legacy_readings"
  | "outdoor_temperature_samples"
  | "electricity_price_samples"
  | "opening_state_samples"
  | "heat_pump_state_samples";

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

export type MeasurementAnalyticsResolution = Exclude<AnalyticsResolution, "auto" | "raw">;

export type MeasurementAnalyticsAggregation =
  | "mean"
  | "sum"
  | "delta"
  | "last"
  | "time_weighted_mean"
  | "min"
  | "max";

export interface MeasurementAnalyticsSeriesQuery {
  sensorId: string;
  metric: string;
  aggregation: MeasurementAnalyticsAggregation;
}

/** Base buckets that summaries need when the displayed buckets are coarser. */
export interface MeasurementAnalyticsSummaryQuery {
  resolution: MeasurementAnalyticsResolution;
  /** A subset of the rollup query's series, with the same aggregations. */
  series: readonly MeasurementAnalyticsSeriesQuery[];
}

/**
 * A bounded, database-side analytics query. The source window itself is not
 * point-limited; only the requested series and returned bucket count are.
 */
export interface MeasurementAnalyticsRollupQuery extends QueryControl {
  series: readonly MeasurementAnalyticsSeriesQuery[];
  from: string;
  to: string;
  resolution: MeasurementAnalyticsResolution;
  qualities: readonly TelemetryQuality[];
  /** Real-data mode excludes archived demo/replay rows before all calculations. */
  excludeSynthetic?: boolean;
  /**
   * Read alongside the display buckets. Ordered series whose stored variant
   * matches are re-bucketed from the same states in one statement.
   */
  summary?: MeasurementAnalyticsSummaryQuery;
}

export interface MeasurementAnalyticsBucketRecord {
  bucketStart: string;
  value: number | null;
  consumptionKwh?: number | null;
  minimum: number | null;
  maximum: number | null;
  sampleCount: number;
  estimatedSampleCount: number;
  staleSampleCount: number;
  counterResetCount: number;
}

export interface MeasurementAnalyticsSeriesRecord {
  sensorId: string;
  metric: string;
  canonicalUnit: string;
  /** Included source samples across the complete requested range. */
  sampleCount: number;
  /** In-range source samples rejected by the explicit quality filter. */
  excludedSampleCount: number;
  cadenceSeconds: number;
  buckets: MeasurementAnalyticsBucketRecord[];
}

export interface MeasurementAnalyticsSummaryResult {
  resolution: MeasurementAnalyticsResolution;
  series: MeasurementAnalyticsSeriesRecord[];
}

export interface MeasurementAnalyticsRollupResult {
  series: MeasurementAnalyticsSeriesRecord[];
  /**
   * Present when the query asked for summary buckets. Summaries are supporting
   * statistics, so null means that read is still materializing or failed.
   */
  summary?: MeasurementAnalyticsSummaryResult | null;
}

export interface MeasurementHistoryQuery extends QueryControl {
  sensorId: string;
  metric: string;
  from: string;
  to: string;
  limit?: number;
  /** Exclusive descending keyset boundary for lossless bounded pagination. */
  before?: { timestamp: string; source: string };
}

/** Bounded database-side buckets for the generic measurement history route. */
export interface MeasurementHistoryBucketedQuery extends QueryControl {
  sensorId: string;
  metric: string;
  from: string;
  to: string;
  bucketSeconds: number;
  limit?: number;
  /** Real-data mode must remove synthetic rows before calculating bucket values. */
  excludeSynthetic?: boolean;
  /**
   * Internal sample projections can skip decoding metadata, which also lets
   * whole-minute buckets read the continuous aggregates. Full archive reads
   * retain metadata by default.
   */
  includeMetadata?: boolean;
}

/** A bounded database-side search for adjacent good samples separated by a real hole. */
export interface MeasurementGapQuery extends QueryControl {
  sensorId: string;
  metric: string;
  source: TelemetrySource;
  from: string;
  to: string;
  minimumGapMs: number;
  limit?: number;
}

export interface MeasurementGapRecord {
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

/** Quality-weighted, bounded buckets used by thermal and moisture models. */
/** Bucketed history for several sensors and metrics, capped per series. */
export interface MeasurementHistoryBucketedMultiQuery {
  sensorIds: readonly string[];
  metrics: readonly string[];
  from: string;
  to: string;
  bucketSeconds: number;
  limitPerSeries?: number;
}

export interface ThermalMeasurementHistoryQuery extends QueryControl {
  sensorId: string;
  metrics: readonly string[];
  from: string;
  to: string;
  bucketMinutes?: number;
  limitPerMetric?: number;
}

/** One sensor's bucketed thermal history; the local reads take the metric from the method. */
export type ThermalHistoryWindowQuery = Omit<ThermalMeasurementHistoryQuery, "metrics">;

/** Bounded multi-sensor raw window used by shared and derived consumers. */
export interface MeasurementWindowQuery extends QueryControl {
  sensorIds: readonly string[];
  metrics: readonly string[];
  from: string;
  to: string;
  limit?: number;
}

export interface MeasurementCoverageQuery extends QueryControl {
  sensorIds: readonly string[];
  metrics: readonly string[];
  /** Real-data mode must not let archived mock/replay rows widen the visible range. */
  excludeSynthetic?: boolean;
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

export interface OpeningStateHistoryQuery extends QueryControl {
  houseId: string;
  from: string;
  to: string;
  limit?: number;
}

export interface OpeningStateSnapshotQuery extends QueryControl {
  houseId: string;
  at: string;
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
  /** Metrics whose ordered semantics need the exact, asynchronously rebuilt accelerator. */
  orderedMetricIds?: readonly string[];
  /** Overrides the default per-table columnstore age without adding a retention policy. */
  coldStorageAfterDays?: number;
  onPoolError?: (error: Error) => void;
}

export interface MeasurementOrderedRollupWorkResult {
  processed: boolean;
  sensorId?: string;
  metric?: string;
  dayStart?: string;
  bucketSeconds?: number;
  qualityMask?: number;
  sourceScope?: "all" | "real";
  generatedRows?: number;
  stale?: boolean;
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

export interface TimeseriesQueryDiagnostics {
  active: number;
  started: number;
  succeeded: number;
  failed: number;
  averageDurationMs: number;
  maxDurationMs: number;
  averagePoolWaitMs: number;
  maxPoolWaitMs: number;
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
  table: ArchiveTableName;
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
