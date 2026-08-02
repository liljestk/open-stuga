import type { MeasurementBucket } from "./types.js";

export const TELEMETRY_TABLES = [
  "measurement_samples",
  "legacy_readings",
  "outdoor_temperature_samples",
  "electricity_price_samples",
  "opening_state_samples",
  "heat_pump_state_samples",
] as const;

export type TelemetryTableName = (typeof TELEMETRY_TABLES)[number];

/** Raw tables whose provenance can be removed at the one-way demo-to-real boundary. */
export const SOURCE_TAGGED_TELEMETRY_TABLES = [
  "measurement_samples",
  "legacy_readings",
  "outdoor_temperature_samples",
  "electricity_price_samples",
  "opening_state_samples",
] as const satisfies readonly TelemetryTableName[];

export interface HypertableDefinition {
  table: TelemetryTableName | "measurement_ordered_rollups";
  timeColumn: "observed_at" | "starts_at" | "bucket_start";
  chunkInterval: string;
  segmentBy: string;
  orderBy: string;
  coldAfter: string;
}

export const HYPERTABLE_DEFINITIONS: readonly HypertableDefinition[] = [
  {
    table: "measurement_samples",
    timeColumn: "observed_at",
    chunkInterval: "1 day",
    segmentBy: "sensor_id,metric",
    orderBy: "observed_at DESC",
    coldAfter: "7 days",
  },
  {
    table: "measurement_ordered_rollups",
    timeColumn: "bucket_start",
    chunkInterval: "7 days",
    segmentBy: "sensor_id,metric,bucket_seconds,quality_mask,source_scope",
    orderBy: "bucket_start DESC",
    coldAfter: "7 days",
  },
  {
    table: "legacy_readings",
    timeColumn: "observed_at",
    chunkInterval: "1 day",
    segmentBy: "sensor_id",
    orderBy: "observed_at DESC",
    coldAfter: "7 days",
  },
  {
    table: "outdoor_temperature_samples",
    timeColumn: "observed_at",
    chunkInterval: "30 days",
    segmentBy: "house_id,location_key",
    orderBy: "observed_at DESC",
    coldAfter: "90 days",
  },
  {
    table: "electricity_price_samples",
    timeColumn: "starts_at",
    chunkInterval: "90 days",
    segmentBy: "property_id",
    orderBy: "starts_at DESC",
    coldAfter: "180 days",
  },
  {
    table: "opening_state_samples",
    timeColumn: "observed_at",
    chunkInterval: "30 days",
    segmentBy: "house_id,element_id",
    orderBy: "observed_at DESC",
    coldAfter: "90 days",
  },
  {
    table: "heat_pump_state_samples",
    timeColumn: "observed_at",
    chunkInterval: "30 days",
    segmentBy: "connection_id",
    orderBy: "observed_at DESC",
    coldAfter: "90 days",
  },
] as const;

export const MEASUREMENT_BUCKETS: Readonly<Record<MeasurementBucket, { interval: string; suffix: string }>> = {
  "5m": { interval: "5 minutes", suffix: "5m" },
  "1h": { interval: "1 hour", suffix: "1h" },
  "1d": { interval: "1 day", suffix: "1d" },
};

export function validateSchemaName(schema: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(schema)) {
    throw new Error(`Invalid PostgreSQL schema name: ${schema}`);
  }
  return schema;
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function qualifiedName(schema: string, relation: string): string {
  return `${quoteIdentifier(validateSchemaName(schema))}.${quoteIdentifier(relation)}`;
}

export function measurementAggregateName(bucket: MeasurementBucket): string {
  return `measurement_samples_${MEASUREMENT_BUCKETS[bucket].suffix}`;
}

export const MEASUREMENT_ANALYTICS_BUCKETS = {
  "1m": { interval: "1 minute", suffix: "1m" },
  "5m": { interval: "5 minutes", suffix: "5m" },
  "1h": { interval: "1 hour", suffix: "1h" },
  "1d": { interval: "1 day", suffix: "1d" },
} as const;

export type MeasurementAnalyticsBaseBucket = keyof typeof MEASUREMENT_ANALYTICS_BUCKETS;

export function measurementAnalyticsAggregateName(bucket: MeasurementAnalyticsBaseBucket): string {
  return `measurement_analytics_v2_${MEASUREMENT_ANALYTICS_BUCKETS[bucket].suffix}`;
}

export function buildBaseSchemaSql(schemaName: string): string[] {
  const schema = quoteIdentifier(validateSchemaName(schemaName));
  const relation = (name: string) => `${schema}.${quoteIdentifier(name)}`;

  return [
    `CREATE SCHEMA IF NOT EXISTS ${schema}`,
    `CREATE TABLE IF NOT EXISTS ${relation("schema_migrations")} (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )`,
    `CREATE TABLE IF NOT EXISTS ${relation("archive_checkpoints")} (
      source_id TEXT NOT NULL CHECK (length(source_id) > 0),
      table_name TEXT NOT NULL CHECK (table_name IN (
        'measurement_samples', 'legacy_readings', 'outdoor_temperature_samples', 'electricity_price_samples',
        'opening_state_samples', 'heat_pump_state_samples'
      )),
      last_row_id BIGINT NOT NULL CHECK (last_row_id >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (source_id, table_name)
    )`,
    `ALTER TABLE ${relation("archive_checkpoints")}
      DROP CONSTRAINT IF EXISTS ${quoteIdentifier("archive_checkpoints_table_name_check")}`,
    `ALTER TABLE ${relation("archive_checkpoints")}
      DROP CONSTRAINT IF EXISTS ${quoteIdentifier("telemetry_archive_table_name_check")}`,
    `ALTER TABLE ${relation("archive_checkpoints")}
      ADD CONSTRAINT ${quoteIdentifier("telemetry_archive_table_name_check")}
      CHECK (table_name IN (
        'measurement_samples', 'legacy_readings', 'outdoor_temperature_samples', 'electricity_price_samples',
        'opening_state_samples', 'heat_pump_state_samples'
      ))`,
    `CREATE TABLE IF NOT EXISTS ${relation("archive_source_state")} (
      source_id TEXT PRIMARY KEY CHECK (length(source_id) > 0),
      real_data_activated_at TIMESTAMPTZ NOT NULL,
      enforced_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )`,
    `CREATE TABLE IF NOT EXISTS ${relation("measurement_samples")} (
      sensor_id TEXT NOT NULL CHECK (length(sensor_id) > 0),
      metric TEXT NOT NULL CHECK (length(metric) > 0),
      observed_at TIMESTAMPTZ NOT NULL CHECK (isfinite(observed_at)),
      source TEXT NOT NULL CHECK (length(source) > 0),
      value DOUBLE PRECISION NOT NULL CHECK (
        value > '-Infinity'::DOUBLE PRECISION AND value < 'Infinity'::DOUBLE PRECISION
      ),
      canonical_unit TEXT NOT NULL,
      quality TEXT NOT NULL CHECK (length(quality) > 0),
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (sensor_id, metric, observed_at, source)
    )`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("measurement_samples_observed_at_brin")}
      ON ${relation("measurement_samples")} USING BRIN (observed_at)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("measurement_samples_latest_idx")}
      ON ${relation("measurement_samples")} (sensor_id, metric, observed_at DESC)
      INCLUDE (value, canonical_unit, source, quality)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("measurement_samples_good_gap_idx")}
      ON ${relation("measurement_samples")} (sensor_id, metric, source, observed_at)
      WHERE quality = 'good'`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("measurement_samples_synthetic_source_idx")}
      ON ${relation("measurement_samples")} (source)
      WHERE source IN ('mock', 'replay')`,
    `CREATE TABLE IF NOT EXISTS ${relation("measurement_ordered_rollup_generations")} (
      sensor_id TEXT NOT NULL CHECK (length(sensor_id) > 0),
      metric TEXT NOT NULL CHECK (length(metric) > 0),
      day_start TIMESTAMPTZ NOT NULL CHECK (day_start = date_bin(
        INTERVAL '1 day', day_start, TIMESTAMPTZ '1970-01-01 00:00:00+00'
      )),
      current_seq BIGINT NOT NULL DEFAULT 1 CHECK (current_seq > 0),
      synced_seq BIGINT NOT NULL DEFAULT 0 CHECK (synced_seq >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (sensor_id, metric, day_start)
    )`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("measurement_ordered_rollup_generations_pending_idx")}
      ON ${relation("measurement_ordered_rollup_generations")} (updated_at, day_start)
      WHERE current_seq <> synced_seq`,
    `CREATE TABLE IF NOT EXISTS ${relation("measurement_ordered_rollup_dirty")} (
      sensor_id TEXT NOT NULL CHECK (length(sensor_id) > 0),
      metric TEXT NOT NULL CHECK (length(metric) > 0),
      day_start TIMESTAMPTZ NOT NULL CHECK (day_start = date_bin(
        INTERVAL '1 day', day_start, TIMESTAMPTZ '1970-01-01 00:00:00+00'
      )),
      bucket_seconds INTEGER NOT NULL CHECK (bucket_seconds IN (60, 900, 3600, 86400)),
      quality_mask SMALLINT NOT NULL CHECK (quality_mask BETWEEN 1 AND 7),
      source_scope TEXT NOT NULL CHECK (source_scope IN ('all', 'real')),
      current_seq BIGINT NOT NULL DEFAULT 1 CHECK (current_seq > 0),
      clean_seq BIGINT NOT NULL DEFAULT 0 CHECK (clean_seq >= 0),
      lease_token TEXT,
      lease_until TIMESTAMPTZ,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (sensor_id, metric, day_start, bucket_seconds, quality_mask, source_scope)
    )`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("measurement_ordered_rollup_dirty_pending_idx")}
      ON ${relation("measurement_ordered_rollup_dirty")} (updated_at, day_start)
      WHERE current_seq <> clean_seq`,
    `INSERT INTO ${relation("measurement_ordered_rollup_generations")} AS generation
        (sensor_id, metric, day_start, current_seq, synced_seq, updated_at)
      SELECT sensor_id, metric, day_start, max(current_seq), max(current_seq), max(updated_at)
      FROM ${relation("measurement_ordered_rollup_dirty")}
      WHERE NOT EXISTS (
        SELECT 1 FROM ${relation("schema_migrations")} WHERE version = 6
      )
      GROUP BY sensor_id, metric, day_start
      ON CONFLICT (sensor_id, metric, day_start) DO UPDATE SET
        current_seq = GREATEST(generation.current_seq, EXCLUDED.current_seq),
        synced_seq = GREATEST(generation.synced_seq, EXCLUDED.synced_seq),
        updated_at = GREATEST(generation.updated_at, EXCLUDED.updated_at)`,
    `CREATE TABLE IF NOT EXISTS ${relation("measurement_ordered_rollups")} (
      algorithm_version INTEGER NOT NULL CHECK (algorithm_version > 0),
      sensor_id TEXT NOT NULL CHECK (length(sensor_id) > 0),
      metric TEXT NOT NULL CHECK (length(metric) > 0),
      day_start TIMESTAMPTZ NOT NULL CHECK (day_start = date_bin(
        INTERVAL '1 day', day_start, TIMESTAMPTZ '1970-01-01 00:00:00+00'
      )),
      bucket_start TIMESTAMPTZ NOT NULL CHECK (bucket_start = date_trunc('minute', bucket_start)),
      bucket_seconds INTEGER NOT NULL CHECK (bucket_seconds IN (60, 900, 3600, 86400)),
      quality_mask SMALLINT NOT NULL CHECK (quality_mask BETWEEN 1 AND 7),
      source_scope TEXT NOT NULL CHECK (source_scope IN ('all', 'real')),
      generation BIGINT NOT NULL CHECK (generation > 0),
      sample_count BIGINT NOT NULL CHECK (sample_count > 0),
      sum_value DOUBLE PRECISION NOT NULL,
      minimum DOUBLE PRECISION NOT NULL,
      maximum DOUBLE PRECISION NOT NULL,
      first_at TIMESTAMPTZ NOT NULL,
      first_source TEXT NOT NULL,
      first_value DOUBLE PRECISION NOT NULL,
      last_at TIMESTAMPTZ NOT NULL,
      last_source TEXT NOT NULL,
      last_value DOUBLE PRECISION NOT NULL,
      internal_positive_delta DOUBLE PRECISION NOT NULL DEFAULT 0,
      internal_counter_consumption DOUBLE PRECISION NOT NULL DEFAULT 0,
      counter_reset_count BIGINT NOT NULL DEFAULT 0 CHECK (counter_reset_count >= 0),
      weighted_value_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
      weighted_seconds DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (weighted_seconds >= 0),
      maximum_internal_interval_seconds DOUBLE PRECISION NOT NULL DEFAULT 0
        CHECK (maximum_internal_interval_seconds >= 0),
      estimated_sample_count BIGINT NOT NULL DEFAULT 0 CHECK (estimated_sample_count >= 0),
      stale_sample_count BIGINT NOT NULL DEFAULT 0 CHECK (stale_sample_count >= 0),
      canonical_unit_min TEXT NOT NULL,
      canonical_unit_max TEXT NOT NULL,
      PRIMARY KEY (
        algorithm_version, sensor_id, metric, bucket_start, bucket_seconds, quality_mask, source_scope
      )
    )`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("measurement_ordered_rollups_lookup_idx")}
      ON ${relation("measurement_ordered_rollups")}
      (sensor_id, metric, bucket_seconds, quality_mask, source_scope, bucket_start)`,
    `CREATE TABLE IF NOT EXISTS ${relation("legacy_readings")} (
      sensor_id TEXT NOT NULL CHECK (length(sensor_id) > 0),
      observed_at TIMESTAMPTZ NOT NULL CHECK (isfinite(observed_at)),
      source TEXT NOT NULL CHECK (length(source) > 0),
      temperature_c DOUBLE PRECISION NOT NULL CHECK (
        temperature_c > '-Infinity'::DOUBLE PRECISION AND temperature_c < 'Infinity'::DOUBLE PRECISION
      ),
      relative_humidity_pct DOUBLE PRECISION NOT NULL CHECK (
        relative_humidity_pct > '-Infinity'::DOUBLE PRECISION AND relative_humidity_pct < 'Infinity'::DOUBLE PRECISION
      ),
      battery_pct DOUBLE PRECISION CHECK (
        battery_pct IS NULL OR (battery_pct > '-Infinity'::DOUBLE PRECISION AND battery_pct < 'Infinity'::DOUBLE PRECISION)
      ),
      quality TEXT NOT NULL CHECK (length(quality) > 0),
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (sensor_id, observed_at, source)
    )`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("legacy_readings_observed_at_brin")}
      ON ${relation("legacy_readings")} USING BRIN (observed_at)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("legacy_readings_latest_idx")}
      ON ${relation("legacy_readings")} (sensor_id, observed_at DESC)
      INCLUDE (temperature_c, relative_humidity_pct, battery_pct, source, quality)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("legacy_readings_synthetic_source_idx")}
      ON ${relation("legacy_readings")} (source)
      WHERE source IN ('mock', 'replay')`,
    `CREATE TABLE IF NOT EXISTS ${relation("outdoor_temperature_samples")} (
      house_id TEXT NOT NULL CHECK (length(house_id) > 0),
      location_key TEXT NOT NULL CHECK (length(location_key) > 0),
      observed_at TIMESTAMPTZ NOT NULL CHECK (isfinite(observed_at)),
      source TEXT NOT NULL CHECK (length(source) > 0),
      temperature_c DOUBLE PRECISION NOT NULL CHECK (
        temperature_c > '-Infinity'::DOUBLE PRECISION AND temperature_c < 'Infinity'::DOUBLE PRECISION
      ),
      fetched_at TIMESTAMPTZ NOT NULL CHECK (isfinite(fetched_at)),
      station_id TEXT,
      station_name TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (house_id, location_key, observed_at, source)
    )`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("outdoor_temperature_observed_at_brin")}
      ON ${relation("outdoor_temperature_samples")} USING BRIN (observed_at)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("outdoor_temperature_latest_idx")}
      ON ${relation("outdoor_temperature_samples")} (house_id, location_key, observed_at DESC)
      INCLUDE (temperature_c, source, fetched_at, station_id, station_name)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("outdoor_temperature_synthetic_source_idx")}
      ON ${relation("outdoor_temperature_samples")} (source)
      WHERE source IN ('mock', 'replay')`,
    `CREATE TABLE IF NOT EXISTS ${relation("electricity_price_samples")} (
      property_id TEXT NOT NULL CHECK (length(property_id) > 0),
      starts_at TIMESTAMPTZ NOT NULL CHECK (isfinite(starts_at)),
      source TEXT NOT NULL CHECK (length(source) > 0),
      ends_at TIMESTAMPTZ NOT NULL CHECK (isfinite(ends_at) AND ends_at > starts_at),
      raw_price_cents_per_kwh DOUBLE PRECISION NOT NULL CHECK (
        raw_price_cents_per_kwh > '-Infinity'::DOUBLE PRECISION
        AND raw_price_cents_per_kwh < 'Infinity'::DOUBLE PRECISION
      ),
      margin_cents_per_kwh DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (
        margin_cents_per_kwh > '-Infinity'::DOUBLE PRECISION
        AND margin_cents_per_kwh < 'Infinity'::DOUBLE PRECISION
      ),
      fetched_at TIMESTAMPTZ NOT NULL CHECK (isfinite(fetched_at)),
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (property_id, starts_at, source)
    )`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("electricity_price_starts_at_brin")}
      ON ${relation("electricity_price_samples")} USING BRIN (starts_at)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("electricity_price_latest_idx")}
      ON ${relation("electricity_price_samples")} (property_id, starts_at DESC)
      INCLUDE (ends_at, raw_price_cents_per_kwh, source, fetched_at)`,
    `CREATE TABLE IF NOT EXISTS ${relation("opening_state_samples")} (
      observation_id TEXT NOT NULL CHECK (length(observation_id) > 0),
      house_id TEXT NOT NULL CHECK (length(house_id) > 0),
      floor_id TEXT NOT NULL CHECK (length(floor_id) > 0),
      element_id TEXT NOT NULL CHECK (length(element_id) > 0),
      observed_at TIMESTAMPTZ NOT NULL CHECK (isfinite(observed_at)),
      source TEXT NOT NULL CHECK (length(source) > 0),
      state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'unknown')),
      open_fraction DOUBLE PRECISION CHECK (
        open_fraction IS NULL OR (open_fraction >= 0 AND open_fraction <= 1)
      ),
      valid_until TIMESTAMPTZ CHECK (valid_until IS NULL OR valid_until > observed_at),
      external_id TEXT,
      connection_id TEXT,
      recorded_at TIMESTAMPTZ NOT NULL CHECK (isfinite(recorded_at)),
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (observation_id, observed_at)
    )`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("opening_state_observed_at_brin")}
      ON ${relation("opening_state_samples")} USING BRIN (observed_at)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("opening_state_history_idx")}
      ON ${relation("opening_state_samples")} (house_id, observed_at DESC)
      INCLUDE (floor_id, element_id, state, open_fraction, source)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("opening_state_identity_idx")}
      ON ${relation("opening_state_samples")} (
        house_id, floor_id, element_id, source, external_id, connection_id, observed_at DESC
      )`,
    `CREATE TABLE IF NOT EXISTS ${relation("heat_pump_state_samples")} (
      connection_id TEXT NOT NULL CHECK (length(connection_id) > 0),
      house_id TEXT NOT NULL CHECK (length(house_id) > 0),
      equipment_id TEXT,
      device_id TEXT NOT NULL CHECK (length(device_id) > 0),
      name TEXT,
      brand TEXT,
      model TEXT,
      observed_at TIMESTAMPTZ NOT NULL CHECK (isfinite(observed_at)),
      received_at TIMESTAMPTZ NOT NULL CHECK (isfinite(received_at)),
      available BOOLEAN NOT NULL,
      power BOOLEAN,
      selected_mode TEXT CHECK (
        selected_mode IS NULL OR selected_mode IN ('auto', 'cool', 'dry', 'fan', 'heat')
      ),
      target_temperature_c DOUBLE PRECISION CHECK (
        target_temperature_c IS NULL OR (
          target_temperature_c > '-Infinity'::DOUBLE PRECISION
          AND target_temperature_c < 'Infinity'::DOUBLE PRECISION
        )
      ),
      current_temperature_c DOUBLE PRECISION CHECK (
        current_temperature_c IS NULL OR (
          current_temperature_c > '-Infinity'::DOUBLE PRECISION
          AND current_temperature_c < 'Infinity'::DOUBLE PRECISION
        )
      ),
      current_temperature_source TEXT NOT NULL CHECK (
        current_temperature_source IN ('reported', 'unavailable')
      ),
      fan_speed TEXT,
      horizontal_swing TEXT,
      vertical_swing TEXT,
      quiet BOOLEAN,
      turbo BOOLEAN,
      xfan BOOLEAN,
      activity TEXT NOT NULL CHECK (activity IN ('off', 'unknown')),
      activity_evidence TEXT NOT NULL CHECK (activity_evidence IN ('protocol', 'unavailable')),
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (connection_id, observed_at)
    )`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("heat_pump_state_observed_at_brin")}
      ON ${relation("heat_pump_state_samples")} USING BRIN (observed_at)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("heat_pump_state_history_idx")}
      ON ${relation("heat_pump_state_samples")} (house_id, connection_id, observed_at DESC)
      INCLUDE (available, power, selected_mode, target_temperature_c, current_temperature_c)`,
    `INSERT INTO ${relation("schema_migrations")} (version, description)
      VALUES (1, 'Initial append-only telemetry schema')
      ON CONFLICT (version) DO NOTHING`,
    `INSERT INTO ${relation("schema_migrations")} (version, description)
      VALUES (2, 'Checkpointed SQLite archive reconciliation and real-data boundary state')
      ON CONFLICT (version) DO NOTHING`,
    `ALTER TABLE ${relation("electricity_price_samples")}
      ADD COLUMN IF NOT EXISTS margin_cents_per_kwh DOUBLE PRECISION NOT NULL DEFAULT 0`,
    `INSERT INTO ${relation("schema_migrations")} (version, description)
      VALUES (3, 'Snapshot contract margin with every electricity price interval')
      ON CONFLICT (version) DO NOTHING`,
    `INSERT INTO ${relation("schema_migrations")} (version, description)
      VALUES (4, 'Archive door, window, and vent state observations')
      ON CONFLICT (version) DO NOTHING`,
    `INSERT INTO ${relation("schema_migrations")} (version, description)
      VALUES (5, 'Archive every direct heat-pump state observation')
      ON CONFLICT (version) DO NOTHING`,
    `INSERT INTO ${relation("schema_migrations")} (version, description)
      VALUES (6, 'Race-safe demand-created ordered telemetry states')
      ON CONFLICT (version) DO NOTHING`,
  ];
}

function aggregateProjection(bucketExpression: string, measurementTable: string): string {
  return `SELECT
      sensor_id,
      metric,
      ${bucketExpression} AS bucket_start,
      count(*)::BIGINT AS sample_count,
      avg(value)::DOUBLE PRECISION AS average,
      min(value)::DOUBLE PRECISION AS minimum,
      max(value)::DOUBLE PRECISION AS maximum,
      min(canonical_unit) AS canonical_unit
    FROM ${measurementTable}
    GROUP BY sensor_id, metric, ${bucketExpression}`;
}

export function buildContinuousAggregateSql(schemaName: string, bucket: MeasurementBucket): string {
  const schema = validateSchemaName(schemaName);
  const interval = MEASUREMENT_BUCKETS[bucket].interval;
  const aggregate = qualifiedName(schema, measurementAggregateName(bucket));
  const measurements = qualifiedName(schema, "measurement_samples");
  const projection = aggregateProjection(`time_bucket(INTERVAL '${interval}', observed_at)`, measurements);
  return `CREATE MATERIALIZED VIEW ${aggregate}
    WITH (timescaledb.continuous, timescaledb.materialized_only = false)
    AS ${projection}
    WITH DATA`;
}

export function buildFallbackAggregateSql(schemaName: string, bucket: MeasurementBucket): string {
  const schema = validateSchemaName(schemaName);
  const interval = MEASUREMENT_BUCKETS[bucket].interval;
  const aggregate = qualifiedName(schema, measurementAggregateName(bucket));
  const measurements = qualifiedName(schema, "measurement_samples");
  const projection = aggregateProjection(
    `date_bin(INTERVAL '${interval}', observed_at, TIMESTAMPTZ '2000-01-01 00:00:00+00')`,
    measurements,
  );
  return `CREATE OR REPLACE VIEW ${aggregate} AS ${projection}`;
}

/**
 * Mergeable, quality/source-aware summaries used by interactive analytics.
 * `WITH NO DATA` keeps upgrades bounded; the background policy backfills raw
 * history while reads fail closed until the requested range is materialized.
 */
export function buildMeasurementAnalyticsAggregateSql(
  schemaName: string,
  bucket: MeasurementAnalyticsBaseBucket,
): string {
  const schema = validateSchemaName(schemaName);
  const interval = MEASUREMENT_ANALYTICS_BUCKETS[bucket].interval;
  const aggregate = qualifiedName(schema, measurementAnalyticsAggregateName(bucket));
  const measurements = qualifiedName(schema, "measurement_samples");
  return `CREATE MATERIALIZED VIEW ${aggregate}
    WITH (timescaledb.continuous, timescaledb.materialized_only = true)
    AS SELECT
      sensor_id,
      metric,
      source,
      quality,
      canonical_unit,
      time_bucket(INTERVAL '${interval}', observed_at) AS bucket_start,
      count(*)::BIGINT AS sample_count,
      sum(value)::DOUBLE PRECISION AS sum_value,
      min(value)::DOUBLE PRECISION AS minimum,
      max(value)::DOUBLE PRECISION AS maximum,
      first(value, observed_at)::DOUBLE PRECISION AS first_value,
      min(observed_at) AS first_at,
      last(value, observed_at)::DOUBLE PRECISION AS last_value,
      max(observed_at) AS last_at
    FROM ${measurements}
    GROUP BY sensor_id, metric, source, quality, canonical_unit,
      time_bucket(INTERVAL '${interval}', observed_at)
    WITH NO DATA`;
}
