import type { QueryResultRow } from "pg";
import type { ArchiveTableName, HeatPumpStateRecord, OpeningStateRecord, QueryControl } from "../../types.js";

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
