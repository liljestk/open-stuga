import { createHash, randomUUID } from "node:crypto";

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { hostname } from "node:os";

import { dirname, resolve } from "node:path";

import { pathToFileURL } from "node:url";

import {
  assertSqliteCheck,
  createVerifiedSqliteSnapshot,
  describeFile,
  hardenPrivateFile,
  openReadOnlySqlite,
  quoteSqliteIdentifier,
} from ".././sqlite-snapshot-utils.mjs";

import { MIGRATION_AGGREGATES, MIGRATION_HYPERTABLES, TARGET_PRIMARY_KEYS, TARGET_TABLES, q } from "./configuration.mjs";

import { requireTimescaleExtension } from "./source-state.mjs";
import {
  HEAT_PUMP_DESTINATION_COLUMNS,
  heatPumpDestinationSql,
} from "./heat-pump-destination-schema.mjs";

export async function validateExpectedHypertables(client, schema) {
  const configured = [];
  const invalid = [];
  for (const definition of MIGRATION_HYPERTABLES) {
    const result = await client.query(`SELECT EXISTS (
      SELECT 1
      FROM timescaledb_information.hypertables hypertable
      JOIN timescaledb_information.dimensions dimension
        ON dimension.hypertable_schema = hypertable.hypertable_schema
       AND dimension.hypertable_name = hypertable.hypertable_name
      WHERE hypertable.hypertable_schema = $1
        AND hypertable.hypertable_name = $2
        AND dimension.column_name = $3
        AND dimension.time_interval = $4::interval
    ) AS configured`, [schema, definition.table, definition.timeColumn, definition.chunkInterval]);
    if (result.rows[0]?.configured === true) configured.push(definition.table);
    else invalid.push(`${definition.table}(${definition.timeColumn}, ${definition.chunkInterval})`);
  }
  if (invalid.length > 0) {
    throw new Error(`Required Timescale hypertables are missing or misconfigured: ${invalid.join(", ")}`);
  }
  return configured;
}

export async function requireTimescaleDestination(client, schema) {
  const version = await requireTimescaleExtension(client);
  const hypertables = await validateExpectedHypertables(client, schema);
  return { version, hypertables };
}

export function continuousAggregateSql(schema, aggregate) {
  const relation = `${q(schema)}.${q(aggregate.name)}`;
  const measurements = `${q(schema)}.${q("measurement_samples")}`;
  if (aggregate.analytics) {
    return `CREATE MATERIALIZED VIEW ${relation}
      WITH (timescaledb.continuous, timescaledb.materialized_only = true)
      AS SELECT sensor_id, metric, source, quality, canonical_unit,
        time_bucket(INTERVAL '${aggregate.interval}', observed_at) AS bucket_start,
        count(*)::bigint AS sample_count, sum(value)::double precision AS sum_value,
        min(value)::double precision AS minimum, max(value)::double precision AS maximum,
        first(value, observed_at)::double precision AS first_value, min(observed_at) AS first_at,
        last(value, observed_at)::double precision AS last_value, max(observed_at) AS last_at
      FROM ${measurements}
      GROUP BY sensor_id, metric, source, quality, canonical_unit,
        time_bucket(INTERVAL '${aggregate.interval}', observed_at)
      WITH NO DATA`;
  }
  return `CREATE MATERIALIZED VIEW ${relation}
    WITH (timescaledb.continuous, timescaledb.materialized_only = false)
    AS SELECT
      sensor_id,
      metric,
      time_bucket(INTERVAL '${aggregate.interval}', observed_at) AS bucket_start,
      count(*)::bigint AS sample_count,
      avg(value)::double precision AS average,
      min(value)::double precision AS minimum,
      max(value)::double precision AS maximum,
      min(canonical_unit) AS canonical_unit
    FROM ${measurements}
    GROUP BY sensor_id, metric, time_bucket(INTERVAL '${aggregate.interval}', observed_at)
    WITH NO DATA`;
}

export async function ensureAndRefreshMeasurementAggregates(
  client,
  schema,
  measurementInventory,
  maintenanceTimeoutMs,
) {
  const reports = [];
  const created = new Set();
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('statement_timeout', $1, TRUE)", [`${maintenanceTimeoutMs}ms`]);
    for (const aggregate of MIGRATION_AGGREGATES) {
      const relation = `${q(schema)}.${q(aggregate.name)}`;
      // Timescale 2.28 exposes the user-facing continuous aggregate as an
      // ordinary pg_class view (relkind = 'v'). Its own catalog is therefore
      // the source of truth; relkind cannot distinguish it from our fallback
      // PostgreSQL view.
      let continuous = await client.query(`SELECT EXISTS (
        SELECT 1 FROM timescaledb_information.continuous_aggregates
        WHERE view_schema = $1 AND view_name = $2
      ) AS configured`, [schema, aggregate.name]);
      if (continuous.rows[0]?.configured !== true) {
        const kindResult = await client.query(`SELECT relation.relkind
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = $1 AND relation.relname = $2`, [schema, aggregate.name]);
        let kind = kindResult.rows[0]?.relkind ?? null;
        if (kind === "v") {
          await client.query(`DROP VIEW ${relation}`);
          kind = null;
        }
        if (kind !== null) {
          throw new Error(`Cannot create required continuous aggregate ${schema}.${aggregate.name}: relation kind ${kind}`);
        }
        await client.query(continuousAggregateSql(schema, aggregate));
        created.add(aggregate.name);
        continuous = await client.query(`SELECT EXISTS (
          SELECT 1 FROM timescaledb_information.continuous_aggregates
          WHERE view_schema = $1 AND view_name = $2
        ) AS configured`, [schema, aggregate.name]);
      }
      if (continuous.rows[0]?.configured !== true) {
        throw new Error(`Required Timescale continuous aggregate is unavailable: ${schema}.${aggregate.name}`);
      }

    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  // Timescale refresh procedures must execute outside an explicit transaction.
  // The views are already committed WITH NO DATA, so a failed refresh is safe
  // to retry and cannot roll back or duplicate the verified raw import.
  await client.query("SELECT set_config('statement_timeout', $1, FALSE)", [`${maintenanceTimeoutMs}ms`]);
  try {
    for (const aggregate of MIGRATION_AGGREGATES) {
      const relation = `${q(schema)}.${q(aggregate.name)}`;
      let range = null;
      if ((measurementInventory?.rows ?? 0) > 0) {
        const bounds = await client.query(`SELECT
          time_bucket($1::interval, $2::timestamptz) AS range_start,
          time_bucket($1::interval, $3::timestamptz) + $1::interval AS range_end`, [
          aggregate.interval,
          measurementInventory.minimumTime,
          measurementInventory.maximumTime,
        ]);
        range = bounds.rows[0];
        if (!range?.range_start || !range?.range_end) {
          throw new Error(`Could not calculate refresh bounds for ${schema}.${aggregate.name}`);
        }
        await client.query(
          "CALL refresh_continuous_aggregate($1::regclass, $2::timestamptz, $3::timestamptz)",
          [relation, range.range_start, range.range_end],
        );
        const counts = await client.query(`SELECT
          (SELECT count(*)::bigint FROM ${q(schema)}.${q("measurement_samples")}
            WHERE observed_at >= $1::timestamptz AND observed_at < $2::timestamptz) AS raw_samples,
          (SELECT COALESCE(sum(sample_count), 0)::bigint FROM ${relation}
            WHERE bucket_start >= $1::timestamptz AND bucket_start < $2::timestamptz) AS aggregate_samples`, [
          range.range_start,
          range.range_end,
        ]);
        const rawSamples = String(counts.rows[0]?.raw_samples ?? "0");
        const aggregateSamples = String(counts.rows[0]?.aggregate_samples ?? "0");
        if (BigInt(rawSamples) !== BigInt(aggregateSamples)) {
          throw new Error(
            `Continuous aggregate verification failed for ${aggregate.name}: `
            + `${aggregateSamples} aggregate samples for ${rawSamples} raw rows`,
          );
        }
        reports.push({
          name: aggregate.name,
          interval: aggregate.interval,
          created: created.has(aggregate.name),
          createdWithData: false,
          refreshed: true,
          rangeStart: new Date(range.range_start).toISOString(),
          rangeEnd: new Date(range.range_end).toISOString(),
          rawSamples,
          aggregateSamples,
        });
      } else {
        reports.push({
          name: aggregate.name,
          interval: aggregate.interval,
          created: created.has(aggregate.name),
          createdWithData: false,
          refreshed: false,
          rangeStart: null,
          rangeEnd: null,
          rawSamples: "0",
          aggregateSamples: "0",
        });
      }
    }
    return reports;
  } finally {
    await client.query("SELECT set_config('statement_timeout', '0', FALSE)");
  }
}

export async function provisionDestination(client, schema, maintenanceTimeoutMs) {
  const s = q(schema);
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('statement_timeout', $1, TRUE)", [`${maintenanceTimeoutMs}ms`]);
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS timescaledb");
    } catch (error) {
      throw new Error(
        "TimescaleDB is required for historical migration; enabling the extension failed",
        { cause: error },
      );
    }
    const timescaleVersion = await requireTimescaleExtension(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${s}.schema_migrations (
        version integer PRIMARY KEY,
        description text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE IF NOT EXISTS ${s}.archive_checkpoints (
        source_id text NOT NULL CHECK (length(source_id) > 0),
        table_name text NOT NULL CHECK (table_name IN (
          'measurement_samples', 'legacy_readings', 'outdoor_temperature_samples', 'electricity_price_samples',
          'opening_state_samples', 'heat_pump_state_samples'
        )),
        last_row_id bigint NOT NULL CHECK (last_row_id >= 0),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (source_id, table_name)
      );
      CREATE TABLE IF NOT EXISTS ${s}.archive_source_state (
        source_id text PRIMARY KEY CHECK (length(source_id) > 0),
        real_data_activated_at timestamptz NOT NULL,
        enforced_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE IF NOT EXISTS ${s}.measurement_samples (
        sensor_id text NOT NULL CHECK (length(sensor_id) > 0),
        metric text NOT NULL CHECK (length(metric) > 0),
        observed_at timestamptz NOT NULL CHECK (isfinite(observed_at)),
        source text NOT NULL CHECK (length(source) > 0),
        value double precision NOT NULL CHECK (
          value > '-Infinity'::double precision AND value < 'Infinity'::double precision
        ),
        canonical_unit text NOT NULL,
        quality text NOT NULL CHECK (length(quality) > 0),
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        ingested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (sensor_id, metric, observed_at, source)
      );
      CREATE TABLE IF NOT EXISTS ${s}.legacy_readings (
        sensor_id text NOT NULL CHECK (length(sensor_id) > 0),
        observed_at timestamptz NOT NULL CHECK (isfinite(observed_at)),
        source text NOT NULL CHECK (length(source) > 0),
        temperature_c double precision NOT NULL CHECK (
          temperature_c > '-Infinity'::double precision AND temperature_c < 'Infinity'::double precision
        ),
        relative_humidity_pct double precision NOT NULL CHECK (
          relative_humidity_pct > '-Infinity'::double precision AND relative_humidity_pct < 'Infinity'::double precision
        ),
        battery_pct double precision CHECK (
          battery_pct IS NULL OR (battery_pct > '-Infinity'::double precision AND battery_pct < 'Infinity'::double precision)
        ),
        quality text NOT NULL CHECK (length(quality) > 0),
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        ingested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (sensor_id, observed_at, source)
      );
      CREATE TABLE IF NOT EXISTS ${s}.outdoor_temperature_samples (
        house_id text NOT NULL CHECK (length(house_id) > 0),
        location_key text NOT NULL CHECK (length(location_key) > 0),
        observed_at timestamptz NOT NULL CHECK (isfinite(observed_at)),
        source text NOT NULL CHECK (length(source) > 0),
        temperature_c double precision NOT NULL CHECK (
          temperature_c > '-Infinity'::double precision AND temperature_c < 'Infinity'::double precision
        ),
        fetched_at timestamptz NOT NULL CHECK (isfinite(fetched_at)),
        station_id text,
        station_name text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        ingested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (house_id, location_key, observed_at, source)
      );
      CREATE TABLE IF NOT EXISTS ${s}.electricity_price_samples (
        property_id text NOT NULL CHECK (length(property_id) > 0),
        starts_at timestamptz NOT NULL CHECK (isfinite(starts_at)),
        source text NOT NULL CHECK (length(source) > 0),
        ends_at timestamptz NOT NULL CHECK (isfinite(ends_at) AND ends_at > starts_at),
        raw_price_cents_per_kwh double precision NOT NULL CHECK (
          raw_price_cents_per_kwh > '-Infinity'::double precision
          AND raw_price_cents_per_kwh < 'Infinity'::double precision
        ),
        margin_cents_per_kwh double precision NOT NULL DEFAULT 0 CHECK (
          margin_cents_per_kwh > '-Infinity'::double precision
          AND margin_cents_per_kwh < 'Infinity'::double precision
        ),
        fetched_at timestamptz NOT NULL CHECK (isfinite(fetched_at)),
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        ingested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (property_id, starts_at, source)
      );
      CREATE TABLE IF NOT EXISTS ${s}.opening_state_samples (
        observation_id text NOT NULL CHECK (length(observation_id) > 0),
        house_id text NOT NULL CHECK (length(house_id) > 0),
        floor_id text NOT NULL CHECK (length(floor_id) > 0),
        element_id text NOT NULL CHECK (length(element_id) > 0),
        observed_at timestamptz NOT NULL CHECK (isfinite(observed_at)),
        source text NOT NULL CHECK (length(source) > 0),
        state text NOT NULL CHECK (state IN ('open', 'closed', 'unknown')),
        open_fraction double precision CHECK (
          open_fraction IS NULL OR (open_fraction >= 0 AND open_fraction <= 1)
        ),
        valid_until timestamptz CHECK (valid_until IS NULL OR valid_until > observed_at),
        external_id text,
        connection_id text,
        recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at)),
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        ingested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (observation_id, observed_at)
      );
      ${heatPumpDestinationSql(s, q)}
      ALTER TABLE ${s}.electricity_price_samples
        ADD COLUMN IF NOT EXISTS margin_cents_per_kwh double precision NOT NULL DEFAULT 0;
      ALTER TABLE ${s}.archive_checkpoints
        DROP CONSTRAINT IF EXISTS archive_checkpoints_table_name_check;
      ALTER TABLE ${s}.archive_checkpoints
        DROP CONSTRAINT IF EXISTS telemetry_archive_table_name_check;
      ALTER TABLE ${s}.archive_checkpoints
        ADD CONSTRAINT telemetry_archive_table_name_check
        CHECK (table_name IN (
          'measurement_samples', 'legacy_readings', 'outdoor_temperature_samples',
          'electricity_price_samples', 'opening_state_samples', 'heat_pump_state_samples'
        ));
      CREATE INDEX IF NOT EXISTS ${q("measurement_samples_observed_at_brin")}
        ON ${s}.measurement_samples USING BRIN (observed_at);
      CREATE INDEX IF NOT EXISTS ${q("measurement_samples_latest_idx")}
        ON ${s}.measurement_samples (sensor_id, metric, observed_at DESC)
        INCLUDE (value, canonical_unit, source, quality);
      CREATE INDEX IF NOT EXISTS ${q("measurement_samples_synthetic_source_idx")}
        ON ${s}.measurement_samples (source)
        WHERE source IN ('mock', 'replay');
      CREATE INDEX IF NOT EXISTS ${q("legacy_readings_observed_at_brin")}
        ON ${s}.legacy_readings USING BRIN (observed_at);
      CREATE INDEX IF NOT EXISTS ${q("legacy_readings_latest_idx")}
        ON ${s}.legacy_readings (sensor_id, observed_at DESC)
        INCLUDE (temperature_c, relative_humidity_pct, battery_pct, source, quality);
      CREATE INDEX IF NOT EXISTS ${q("legacy_readings_synthetic_source_idx")}
        ON ${s}.legacy_readings (source)
        WHERE source IN ('mock', 'replay');
      CREATE INDEX IF NOT EXISTS ${q("outdoor_temperature_observed_at_brin")}
        ON ${s}.outdoor_temperature_samples USING BRIN (observed_at);
      CREATE INDEX IF NOT EXISTS ${q("outdoor_temperature_latest_idx")}
        ON ${s}.outdoor_temperature_samples (house_id, location_key, observed_at DESC)
        INCLUDE (temperature_c, source, fetched_at, station_id, station_name);
      CREATE INDEX IF NOT EXISTS ${q("outdoor_temperature_synthetic_source_idx")}
        ON ${s}.outdoor_temperature_samples (source)
        WHERE source IN ('mock', 'replay');
      CREATE INDEX IF NOT EXISTS ${q("electricity_price_starts_at_brin")}
        ON ${s}.electricity_price_samples USING BRIN (starts_at);
      CREATE INDEX IF NOT EXISTS ${q("electricity_price_latest_idx")}
        ON ${s}.electricity_price_samples (property_id, starts_at DESC)
        INCLUDE (ends_at, raw_price_cents_per_kwh, source, fetched_at);
      CREATE INDEX IF NOT EXISTS ${q("opening_state_observed_at_brin")}
        ON ${s}.opening_state_samples USING BRIN (observed_at);
      CREATE INDEX IF NOT EXISTS ${q("opening_state_history_idx")}
        ON ${s}.opening_state_samples (house_id, observed_at DESC)
        INCLUDE (floor_id, element_id, state, open_fraction, source);
      CREATE INDEX IF NOT EXISTS ${q("opening_state_identity_idx")}
        ON ${s}.opening_state_samples (
          house_id, floor_id, element_id, source, external_id, connection_id, observed_at DESC
        );
      INSERT INTO ${s}.schema_migrations (version, description)
        VALUES (1, 'Initial append-only telemetry schema')
        ON CONFLICT (version) DO NOTHING;
      INSERT INTO ${s}.schema_migrations (version, description)
        VALUES (2, 'Checkpointed SQLite archive reconciliation and real-data boundary state')
        ON CONFLICT (version) DO NOTHING;
      INSERT INTO ${s}.schema_migrations (version, description)
        VALUES (3, 'Snapshot contract margin with every electricity price interval')
        ON CONFLICT (version) DO NOTHING;
      INSERT INTO ${s}.schema_migrations (version, description)
        VALUES (4, 'Opening-state event telemetry')
        ON CONFLICT (version) DO NOTHING;
      INSERT INTO ${s}.schema_migrations (version, description)
        VALUES (5, 'Direct heat-pump state telemetry')
        ON CONFLICT (version) DO NOTHING;
    `);
    for (const definition of MIGRATION_HYPERTABLES) {
      const relation = `${s}.${q(definition.table)}`;
      await client.query(`SELECT create_hypertable(
        $1::regclass,
        $2,
        chunk_time_interval => $3::interval,
        if_not_exists => TRUE,
        migrate_data => TRUE,
        create_default_indexes => FALSE
      )`, [relation, definition.timeColumn, definition.chunkInterval]);
      // create_hypertable(if_not_exists) preserves an older interval. Set it
      // explicitly so resumed/imported installations converge on the contract.
      await client.query("SELECT set_chunk_time_interval($1::regclass, $2::interval)", [
        relation,
        definition.chunkInterval,
      ]);
    }
    const hypertables = await validateExpectedHypertables(client, schema);
    await client.query("COMMIT");
    return { version: timescaleVersion, hypertables };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function validateDestinationSchema(client, schema) {
  for (const [sourceTable, expectedKey] of Object.entries(TARGET_PRIMARY_KEYS)) {
    const table = TARGET_TABLES[sourceTable];
    const columns = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
    `, [schema, table]);
    if (columns.rowCount === 0) throw new Error(`Destination table ${schema}.${table} does not exist`);
    const columnNames = new Set(columns.rows.map(({ column_name }) => column_name));
    const expectedColumns = {
      measurement_samples: [
        "sensor_id", "metric", "observed_at", "source", "value", "canonical_unit", "quality", "metadata", "ingested_at",
      ],
      readings: [
        "sensor_id", "observed_at", "source", "temperature_c", "relative_humidity_pct", "battery_pct", "quality", "metadata", "ingested_at",
      ],
      outdoor_temperature_samples: [
        "house_id", "location_key", "observed_at", "source", "temperature_c", "fetched_at", "station_id", "station_name", "metadata", "ingested_at",
      ],
      electricity_price_points: [
        "property_id", "starts_at", "source", "ends_at", "raw_price_cents_per_kwh",
        "margin_cents_per_kwh", "fetched_at", "metadata", "ingested_at",
      ],
      opening_state_observations: [
        "observation_id", "house_id", "floor_id", "element_id", "observed_at", "source", "state",
        "open_fraction", "valid_until", "external_id", "connection_id", "recorded_at", "metadata", "ingested_at",
      ],
      heat_pump_state_history: HEAT_PUMP_DESTINATION_COLUMNS,
    }[sourceTable];
    const missing = expectedColumns.filter((column) => !columnNames.has(column));
    if (missing.length > 0) throw new Error(`Destination ${schema}.${table} is missing columns: ${missing.join(", ")}`);

    const primary = await client.query(`
      SELECT attribute.attname AS column_name
      FROM pg_catalog.pg_index index_definition
      JOIN pg_catalog.pg_class relation ON relation.oid = index_definition.indrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      JOIN LATERAL unnest(index_definition.indkey) WITH ORDINALITY key(attnum, position) ON true
      JOIN pg_catalog.pg_attribute attribute
        ON attribute.attrelid = relation.oid AND attribute.attnum = key.attnum
      WHERE namespace.nspname = $1 AND relation.relname = $2 AND index_definition.indisprimary
      ORDER BY key.position
    `, [schema, table]);
    const actualKey = primary.rows.map(({ column_name }) => column_name);
    if (actualKey.join("\0") !== expectedKey.join("\0")) {
      throw new Error(`Destination ${schema}.${table} has an incompatible primary key`);
    }
  }
  const checkpointColumns = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = 'archive_checkpoints'
  `, [schema]);
  const checkpointColumnNames = new Set(checkpointColumns.rows.map(({ column_name }) => column_name));
  const missingCheckpointColumns = ["source_id", "table_name", "last_row_id", "updated_at"]
    .filter((column) => !checkpointColumnNames.has(column));
  if (missingCheckpointColumns.length > 0) {
    throw new Error(
      `Destination ${schema}.archive_checkpoints is missing columns: ${missingCheckpointColumns.join(", ")}`,
    );
  }
  const checkpointPrimary = await client.query(`
    SELECT attribute.attname AS column_name
    FROM pg_catalog.pg_index index_definition
    JOIN pg_catalog.pg_class relation ON relation.oid = index_definition.indrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN LATERAL unnest(index_definition.indkey) WITH ORDINALITY key(attnum, position) ON true
    JOIN pg_catalog.pg_attribute attribute
      ON attribute.attrelid = relation.oid AND attribute.attnum = key.attnum
    WHERE namespace.nspname = $1
      AND relation.relname = 'archive_checkpoints'
      AND index_definition.indisprimary
    ORDER BY key.position
  `, [schema]);
  if (checkpointPrimary.rows.map(({ column_name }) => column_name).join("\0") !== "source_id\0table_name") {
    throw new Error(`Destination ${schema}.archive_checkpoints has an incompatible primary key`);
  }
  const sourceStateColumns = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = 'archive_source_state'
  `, [schema]);
  const sourceStateColumnNames = new Set(sourceStateColumns.rows.map(({ column_name }) => column_name));
  const missingSourceStateColumns = ["source_id", "real_data_activated_at", "enforced_at"]
    .filter((column) => !sourceStateColumnNames.has(column));
  if (missingSourceStateColumns.length > 0) {
    throw new Error(
      `Destination ${schema}.archive_source_state is missing columns: ${missingSourceStateColumns.join(", ")}`,
    );
  }
  const sourceStatePrimary = await client.query(`
    SELECT attribute.attname AS column_name
    FROM pg_catalog.pg_index index_definition
    JOIN pg_catalog.pg_class relation ON relation.oid = index_definition.indrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN LATERAL unnest(index_definition.indkey) WITH ORDINALITY key(attnum, position) ON true
    JOIN pg_catalog.pg_attribute attribute
      ON attribute.attrelid = relation.oid AND attribute.attnum = key.attnum
    WHERE namespace.nspname = $1
      AND relation.relname = 'archive_source_state'
      AND index_definition.indisprimary
    ORDER BY key.position
  `, [schema]);
  if (sourceStatePrimary.rows.map(({ column_name }) => column_name).join("\0") !== "source_id") {
    throw new Error(`Destination ${schema}.archive_source_state has an incompatible primary key`);
  }
  const migrations = await client.query(`SELECT version
    FROM ${q(schema)}.schema_migrations WHERE version IN (1, 2, 3, 4) ORDER BY version`);
  if (migrations.rows.map(({ version }) => Number(version)).join(",") !== "1,2,3,4") {
    throw new Error(`Destination ${schema}.schema_migrations is missing required versions 1 through 4`);
  }
}

export function finiteNumber(value, label, nullable = false) {
  if (nullable && value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Source row contains an invalid ${label}`);
  return number;
}
