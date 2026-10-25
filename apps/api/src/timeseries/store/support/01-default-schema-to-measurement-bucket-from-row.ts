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
  HeatPumpStateRecord,
  LegacyReadingHistoryQuery,
  LegacyReadingRecord,
  MeasurementBucketQuery,
  MeasurementBucketRecord,
  MeasurementCoverageQuery,
  MeasurementCoverageRecord,
  MeasurementHistoryQuery,
  MeasurementSampleRecord,
  MeasurementWindowQuery,
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

export const DEFAULT_SCHEMA = "telemetry";

export const DEFAULT_POOL_SIZE = 4;

export const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

export const DEFAULT_BATCH_SIZE = 1_000;

export const MAX_HISTORY_LIMIT = 100_000;

export const MAX_MEASUREMENT_WINDOW_LIMIT = 250_000;

export const QUERY_TAG_PREFIX = "stugu-telemetry-query:";

export type SqlValue = string | number | boolean | null | readonly string[] | Readonly<Record<string, unknown>>;

export interface ExtensionRow extends QueryResultRow {
  timescale_version: string | null;
}

export interface ProcedureFeatureRow extends QueryResultRow {
  columnstore_available: boolean;
  compression_available: boolean;
  continuous_policy_available: boolean;
}

export interface RelationKindRow extends QueryResultRow {
  relkind: string;
}

export interface ContinuousAggregateRow extends QueryResultRow {
  configured: boolean;
}

export interface MeasurementRow extends QueryResultRow {
  sensor_id: string;
  metric: string;
  value: number;
  canonical_unit: string;
  observed_at: string | Date;
  source: string;
  quality: string;
  metadata: Readonly<Record<string, unknown>>;
}

export interface LegacyReadingRow extends QueryResultRow {
  sensor_id: string;
  observed_at: string | Date;
  temperature_c: number;
  relative_humidity_pct: number;
  battery_pct: number | null;
  source: string;
  quality: string;
  metadata: Readonly<Record<string, unknown>>;
}

export interface OutdoorTemperatureRow extends QueryResultRow {
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

export interface ElectricityPriceRow extends QueryResultRow {
  property_id: string;
  starts_at: string | Date;
  ends_at: string | Date;
  raw_price_cents_per_kwh: number;
  margin_cents_per_kwh: number;
  source: string;
  fetched_at: string | Date;
  metadata: Readonly<Record<string, unknown>>;
}

export interface OpeningStateRow extends QueryResultRow {
  observation_id: string;
  house_id: string;
  floor_id: string;
  element_id: string;
  state: OpeningStateRecord["state"];
  open_fraction: number | null;
  source: string;
  observed_at: string | Date;
  valid_until: string | Date | null;
  external_id: string | null;
  connection_id: string | null;
  recorded_at: string | Date;
  metadata: Readonly<Record<string, unknown>>;
}

export interface HeatPumpStateRow extends QueryResultRow {
  connection_id: string;
  house_id: string;
  equipment_id: string | null;
  device_id: string;
  name: string | null;
  brand: string | null;
  model: string | null;
  transport: HeatPumpStateRecord["transport"];
  floor_id: string | null;
  room_id: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  observed_at: string | Date;
  received_at: string | Date;
  available: boolean;
  power: boolean | null;
  selected_mode: HeatPumpStateRecord["selectedMode"];
  target_temperature_c: number | null;
  current_temperature_c: number | null;
  current_temperature_source: HeatPumpStateRecord["currentTemperatureSource"];
  current_humidity_percent: number | null;
  target_humidity_percent: number | null;
  fan_speed: string | null;
  horizontal_swing: string | null;
  vertical_swing: string | null;
  fresh_air: boolean | null;
  anion: boolean | null;
  sleep: boolean | null;
  light: boolean | null;
  quiet: boolean | null;
  turbo: boolean | null;
  xfan: boolean | null;
  steady_heat: boolean | null;
  power_save: boolean | null;
  clean_filter: boolean | null;
  water_full: boolean | null;
  dehumidifier_mode: string | null;
  compressor_frequency_hz: number | null;
  diagnostics: HeatPumpStateRecord["diagnostics"];
  activity: HeatPumpStateRecord["activity"];
  activity_evidence: HeatPumpStateRecord["activityEvidence"];
}

export interface EnergyCostAggregateRow extends QueryResultRow {
  coverage_complete?: boolean;
  delta_count: string | number;
  consumption_kwh: number | null;
  priced_consumption_kwh: number | null;
  cost_eur: number | null;
  total_duration_ms: number | null;
  priced_duration_ms: number | null;
  maximum_interval_duration_ms: number | null;
  coverage_from: string | Date | null;
  coverage_until: string | Date | null;
  /** `[hourStartMs, kwh, spotPricedKwh, spotCostCents]` rows. */
  hourly?: unknown;
}

export interface MeasurementBucketRow extends QueryResultRow {
  sensor_id: string;
  metric: string;
  bucket_start: string | Date;
  sample_count: string | number;
  average: number;
  minimum: number;
  maximum: number;
  canonical_unit: string;
}

export interface MeasurementCoverageRow extends QueryResultRow {
  sensor_id: string;
  metric: string;
  coverage_start: string | Date;
  coverage_end: string | Date;
}

export interface HealthRow extends QueryResultRow {
  database_name: string;
  database_size_bytes: string | number;
  timescale_version: string | null;
}

export interface StorageRow extends QueryResultRow {
  table_name: string;
  estimated_rows: string | number;
  total_bytes: string | number;
  table_bytes: string | number;
  index_bytes: string | number;
}

export interface TimescaleStorageRow extends QueryResultRow {
  table_name: string;
  total_bytes: string | number;
  table_bytes: string | number;
  index_bytes: string | number;
}

export interface ArchiveCheckpointRow extends QueryResultRow {
  source_id: string;
  table_name: ArchiveTableName;
  last_row_id: string | number;
  updated_at: string | Date;
}

export interface LatestMeasurementFilter extends QueryControl {
  sensorIds?: readonly string[];
  metric?: string;
}

export interface LatestLegacyReadingFilter extends QueryControl {
  sensorIds?: readonly string[];
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new RangeError("Expected a positive integer");
  return Math.min(value, maximum);
}

export function timeoutValue(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new RangeError("timeoutMs must be a non-negative integer");
  return value;
}

export function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("The telemetry query was aborted", "AbortError");
}

export function measurementFromRow(row: MeasurementRow): MeasurementSampleRecord {
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

export function legacyReadingFromRow(row: LegacyReadingRow): LegacyReadingRecord {
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

export function outdoorTemperatureFromRow(row: OutdoorTemperatureRow): OutdoorTemperatureRecord {
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

export function electricityPriceFromRow(row: ElectricityPriceRow): ElectricityPriceRecord {
  return {
    propertyId: row.property_id,
    startAt: timestamp(row.starts_at),
    endAt: timestamp(row.ends_at),
    rawPriceCentsPerKwh: Number(row.raw_price_cents_per_kwh),
    marginCentsPerKwh: Number(row.margin_cents_per_kwh),
    source: row.source,
    fetchedAt: timestamp(row.fetched_at),
    metadata: row.metadata,
  };
}

export function openingStateFromRow(row: OpeningStateRow): OpeningStateRecord {
  return {
    observationId: row.observation_id,
    houseId: row.house_id,
    floorId: row.floor_id,
    elementId: row.element_id,
    state: row.state,
    openFraction: row.open_fraction === null ? null : Number(row.open_fraction),
    source: row.source,
    observedAt: timestamp(row.observed_at),
    validUntil: row.valid_until === null ? null : timestamp(row.valid_until),
    externalId: row.external_id,
    connectionId: row.connection_id,
    recordedAt: timestamp(row.recorded_at),
    metadata: row.metadata,
  };
}

export function heatPumpStateFromRow(row: HeatPumpStateRow): HeatPumpStateRecord {
  return {
    connectionId: row.connection_id,
    houseId: row.house_id,
    equipmentId: row.equipment_id,
    deviceId: row.device_id,
    name: row.name,
    brand: row.brand,
    model: row.model,
    transport: row.transport ?? "local",
    floorId: row.floor_id ?? null,
    roomId: row.room_id ?? null,
    x: row.x == null ? null : Number(row.x),
    y: row.y == null ? null : Number(row.y),
    z: row.z == null ? null : Number(row.z),
    observedAt: timestamp(row.observed_at),
    receivedAt: timestamp(row.received_at),
    available: row.available,
    power: row.power,
    selectedMode: row.selected_mode,
    targetTemperatureC: row.target_temperature_c === null ? null : Number(row.target_temperature_c),
    currentTemperatureC: row.current_temperature_c === null ? null : Number(row.current_temperature_c),
    currentTemperatureSource: row.current_temperature_source,
    currentHumidityPercent: row.current_humidity_percent === null ? null : Number(row.current_humidity_percent),
    targetHumidityPercent: row.target_humidity_percent === null ? null : Number(row.target_humidity_percent),
    fanSpeed: row.fan_speed,
    horizontalSwing: row.horizontal_swing,
    verticalSwing: row.vertical_swing,
    freshAir: row.fresh_air,
    anion: row.anion,
    sleep: row.sleep,
    light: row.light,
    quiet: row.quiet,
    turbo: row.turbo,
    xfan: row.xfan,
    steadyHeat: row.steady_heat,
    powerSave: row.power_save,
    cleanFilter: row.clean_filter,
    waterFull: row.water_full,
    dehumidifierMode: row.dehumidifier_mode,
    compressorFrequencyHz: row.compressor_frequency_hz == null ? null : Number(row.compressor_frequency_hz),
    diagnostics: row.diagnostics ?? {},
    activity: row.activity,
    activityEvidence: row.activity_evidence,
  };
}

export function measurementBucketFromRow(row: MeasurementBucketRow): MeasurementBucketRecord {
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
