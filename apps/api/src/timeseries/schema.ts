import type { MeasurementBucket } from "./types.js";

export const TELEMETRY_TABLES = [
  "measurement_samples",
  "legacy_readings",
  "outdoor_temperature_samples",
  "electricity_price_samples",
] as const;

export type TelemetryTableName = (typeof TELEMETRY_TABLES)[number];

export interface HypertableDefinition {
  table: TelemetryTableName;
  timeColumn: "observed_at" | "starts_at";
  chunkInterval: string;
  segmentBy: string;
  orderBy: string;
  coldAfter: string;
}

export const HYPERTABLE_DEFINITIONS: readonly HypertableDefinition[] = [
  {
    table: "measurement_samples",
    timeColumn: "observed_at",
    chunkInterval: "7 days",
    segmentBy: "sensor_id,metric",
    orderBy: "observed_at DESC",
    coldAfter: "30 days",
  },
  {
    table: "legacy_readings",
    timeColumn: "observed_at",
    chunkInterval: "7 days",
    segmentBy: "sensor_id",
    orderBy: "observed_at DESC",
    coldAfter: "30 days",
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

export function buildBaseSchemaSql(schemaName: string): string[] {
  const schema = quoteIdentifier(validateSchemaName(schemaName));
  const relation = (name: string) => `${schema}.${quoteIdentifier(name)}`;

  return [
    `CREATE TABLE IF NOT EXISTS ${relation("schema_migrations")} (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )`,
    `CREATE TABLE IF NOT EXISTS ${relation("archive_checkpoints")} (
      source_id TEXT NOT NULL CHECK (length(source_id) > 0),
      table_name TEXT NOT NULL CHECK (table_name IN (
        'measurement_samples', 'legacy_readings', 'outdoor_temperature_samples', 'electricity_price_samples'
      )),
      last_row_id BIGINT NOT NULL CHECK (last_row_id >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (source_id, table_name)
    )`,
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
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier("measurement_samples_synthetic_source_idx")}
      ON ${relation("measurement_samples")} (source)
      WHERE source IN ('mock', 'replay')`,
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
    `INSERT INTO ${relation("schema_migrations")} (version, description)
      VALUES (1, 'Initial append-only telemetry schema')
      ON CONFLICT (version) DO NOTHING`,
    `INSERT INTO ${relation("schema_migrations")} (version, description)
      VALUES (2, 'Checkpointed SQLite archive reconciliation and real-data boundary state')
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
