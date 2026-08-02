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

export const MANIFEST_VERSION = 4;

export const DEFAULT_BATCH_SIZE = 1_000;

export const MAX_BATCH_SIZE = 10_000;

export const DEFAULT_SCHEMA = "telemetry";

export const DEFAULT_MAINTENANCE_TIMEOUT_MS = 30 * 60 * 1_000;

export const MAX_MAINTENANCE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

export const DESTINATION_TIMESTAMP_KEY_FUNCTION = "stuga_destination_timestamptz_key";

export const PREFLIGHT_SEMANTICS_VERSION = 5;

export const DESTINATION_FINGERPRINT_VERSION = 3;

export const SOURCE_TABLES = Object.freeze({
  measurement_samples: {
    requiredColumns: ["id", "sensor_id", "metric", "value", "canonical_unit", "timestamp", "source", "quality"],
    keyColumns: ["sensor_id", "metric", "timestamp", "source"],
    nonEmptyColumns: ["sensor_id", "metric", "source", "quality"],
    numericColumns: [{ name: "value", nullable: false }],
    dateColumns: ["timestamp"],
    timeColumn: "timestamp",
  },
  readings: {
    requiredColumns: ["id", "sensor_id", "timestamp", "temperature", "humidity", "battery", "source", "quality"],
    keyColumns: ["sensor_id", "timestamp", "source"],
    nonEmptyColumns: ["sensor_id", "source", "quality"],
    numericColumns: [
      { name: "temperature", nullable: false },
      { name: "humidity", nullable: false },
      { name: "battery", nullable: true },
    ],
    dateColumns: ["timestamp"],
    timeColumn: "timestamp",
  },
  outdoor_temperature_samples: {
    requiredColumns: [
      "house_id", "location_key", "timestamp", "temperature_c", "source", "fetched_at", "station_id", "station_name",
    ],
    keyColumns: ["house_id", "location_key", "timestamp", "source"],
    nonEmptyColumns: ["house_id", "location_key", "source"],
    numericColumns: [{ name: "temperature_c", nullable: false }],
    dateColumns: ["timestamp", "fetched_at"],
    optionalJsonColumns: ["conditions_json"],
    timeColumn: "timestamp",
  },
  electricity_price_points: {
    requiredColumns: ["property_id", "start_at", "end_at", "raw_price_cents_per_kwh", "fetched_at"],
    keyColumns: ["property_id", "start_at"],
    nonEmptyColumns: ["property_id"],
    numericColumns: [{ name: "raw_price_cents_per_kwh", nullable: false }],
    optionalNumericColumns: [{ name: "margin_cents_per_kwh", nullable: false }],
    dateColumns: ["start_at", "end_at", "fetched_at"],
    timeColumn: "start_at",
  },
  opening_state_observations: {
    requiredColumns: [
      "id", "house_id", "floor_id", "element_id", "state", "open_fraction", "source",
      "observed_at", "valid_until", "external_id", "connection_id", "created_at",
    ],
    keyColumns: ["id", "observed_at"],
    nonEmptyColumns: ["id", "house_id", "floor_id", "element_id", "state", "source"],
    numericColumns: [{ name: "open_fraction", nullable: true }],
    dateColumns: ["observed_at", "created_at"],
    nullableDateColumns: ["valid_until"],
    timeColumn: "observed_at",
  },
  heat_pump_state_history: {
    requiredColumns: [
      "id", "connection_id", "house_id", "observed_at", "received_at", "state_json",
    ],
    keyColumns: ["connection_id", "observed_at"],
    nonEmptyColumns: ["connection_id", "house_id", "state_json"],
    numericColumns: [],
    dateColumns: ["observed_at", "received_at"],
    requiredJsonColumns: ["state_json"],
    timeColumn: "observed_at",
  },
});

export const TARGET_PRIMARY_KEYS = Object.freeze({
  measurement_samples: ["sensor_id", "metric", "observed_at", "source"],
  readings: ["sensor_id", "observed_at", "source"],
  outdoor_temperature_samples: ["house_id", "location_key", "observed_at", "source"],
  electricity_price_points: ["property_id", "starts_at", "source"],
  opening_state_observations: ["observation_id", "observed_at"],
  heat_pump_state_history: ["connection_id", "observed_at"],
});

export const TARGET_TABLES = Object.freeze({
  measurement_samples: "measurement_samples",
  readings: "legacy_readings",
  outdoor_temperature_samples: "outdoor_temperature_samples",
  electricity_price_points: "electricity_price_samples",
  opening_state_observations: "opening_state_samples",
  heat_pump_state_history: "heat_pump_state_samples",
});

export const MIGRATION_HYPERTABLES = Object.freeze([
  { table: "measurement_samples", timeColumn: "observed_at", chunkInterval: "1 day" },
  { table: "legacy_readings", timeColumn: "observed_at", chunkInterval: "1 day" },
  { table: "outdoor_temperature_samples", timeColumn: "observed_at", chunkInterval: "30 days" },
  { table: "electricity_price_samples", timeColumn: "starts_at", chunkInterval: "90 days" },
  { table: "opening_state_samples", timeColumn: "observed_at", chunkInterval: "30 days" },
  { table: "heat_pump_state_samples", timeColumn: "observed_at", chunkInterval: "30 days" },
]);

export const MIGRATION_AGGREGATES = Object.freeze([
  { name: "measurement_samples_5m", interval: "5 minutes" },
  { name: "measurement_samples_1h", interval: "1 hour" },
  { name: "measurement_samples_1d", interval: "1 day" },
  { name: "measurement_analytics_v2_1m", interval: "1 minute", analytics: true },
  { name: "measurement_analytics_v2_5m", interval: "5 minutes", analytics: true },
  { name: "measurement_analytics_v2_1h", interval: "1 hour", analytics: true },
  { name: "measurement_analytics_v2_1d", interval: "1 day", analytics: true },
]);

export function help() {
  return `Stugu SQLite to PostgreSQL/Timescale telemetry migration

Usage:
  node scripts/migrate-telemetry-to-timescale.mjs [options]

Options:
  --source <file>          SQLite source (default: DATABASE_PATH or ./data/climate-twin.sqlite)
  --postgres-url <url>     PostgreSQL URL; environment-based credentials are safer
  --schema <name>          Destination schema (default: telemetry)
  --batch-size <rows>      Rows committed per batch, 1-${MAX_BATCH_SIZE} (default: ${DEFAULT_BATCH_SIZE})
  --maintenance-timeout-ms <ms>
                           Timescale extension/schema/hypertable timeout
                           (default: ${DEFAULT_MAINTENANCE_TIMEOUT_MS}; max: ${MAX_MAINTENANCE_TIMEOUT_MS})
  --checkpoint <file>      Resumable JSON manifest (default: <source>.timescale-migration.json)
  --snapshot <file>        Consistent SQLite snapshot (default: <source>.timescale-migration.snapshot.sqlite)
  --dry-run                Read-only source checks and inventory; no files or destination writes
  --verify-only            Compare an existing destination with the consistent source snapshot; no destination writes
  -h, --help               Show this help

Safety and recovery:
  * The source is always opened read-only. A committed-WAL-aware VACUUM INTO
    snapshot is used for real migrations, then checked with PRAGMA integrity_check.
  * Batches insert by natural key and use ON CONFLICT DO NOTHING. Existing rows
    are never overwritten; exact verification rejects any payload mismatch.
  * The checkpoint is written after every committed batch. Re-running the same
    command resumes safely; replaying a committed batch is idempotent.
  * A PostgreSQL advisory lock is acquired before the checkpoint file lock.
    This lets a crashed one-off container's stale lock be reclaimed safely
    without permitting two migration/verification writers on one destination.
  * Duplicate source natural keys are rejected instead of silently collapsing data.
    Timestamp spellings are normalized to PostgreSQL timestamptz instants first.
  * TimescaleDB is required. All six target tables are converted and validated
    as hypertables before the first bulk batch is written.
  * Credentials are never stored in the checkpoint or printed. Supplying the URL
    through TIMESCALE_DATABASE_URL is safer than placing it in shell history.
  * Snapshots and checkpoints are sensitive. Owner-only permissions/a private
    Windows ACL are enforced, but use a protected and preferably encrypted path.
  * Connection preference is TIMESCALE_DATABASE_URL, DATABASE_URL, standard PG*
    variables, then TIMESERIES_HOST/PORT/DATABASE/USER/PASSWORD.
  * Run this as a maintenance operation with the API/archive worker and every
    other Timescale writer stopped. Advisory locking coordinates this CLI only.

Examples:
  node scripts/migrate-telemetry-to-timescale.mjs --source ./data/climate-twin.sqlite --dry-run
  $env:TIMESCALE_DATABASE_URL='postgresql://user:password@localhost:5432/stugu'
  node scripts/migrate-telemetry-to-timescale.mjs --source ./data/climate-twin.sqlite
  node scripts/migrate-telemetry-to-timescale.mjs --source ./data/climate-twin.sqlite --verify-only
`;
}

export function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function optionalPort(value, label) {
  if (value === undefined || value === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${label} must be an integer from 1 to 65535`);
  return port;
}

export function timeseriesPasswordFromEnvironment(env) {
  if (env.TIMESERIES_PASSWORD !== undefined && env.TIMESERIES_PASSWORD_FILE) {
    throw new Error("Configure only one of TIMESERIES_PASSWORD or TIMESERIES_PASSWORD_FILE");
  }
  if (!env.TIMESERIES_PASSWORD_FILE) return env.TIMESERIES_PASSWORD ?? "";
  const password = readFileSync(resolve(env.TIMESERIES_PASSWORD_FILE), "utf8").trim();
  if (!password) throw new Error("TIMESERIES_PASSWORD_FILE must not be empty");
  return password;
}

export function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export function parseMigrationArgs(argv, env = process.env) {
  const parsed = {
    dryRun: false,
    verifyOnly: false,
    help: false,
    sourceProvided: false,
    snapshotProvided: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") parsed.help = true;
    else if (argument === "--dry-run") parsed.dryRun = true;
    else if (argument === "--verify-only") parsed.verifyOnly = true;
    else if (argument === "--source") {
      parsed.source = readValue(argv, index, argument);
      parsed.sourceProvided = true;
      index += 1;
    } else if (argument === "--postgres-url") {
      parsed.postgresUrl = readValue(argv, index, argument);
      index += 1;
    } else if (argument === "--schema") {
      parsed.schema = readValue(argv, index, argument);
      index += 1;
    } else if (argument === "--batch-size") {
      parsed.batchSize = Number(readValue(argv, index, argument));
      index += 1;
    } else if (argument === "--maintenance-timeout-ms") {
      parsed.maintenanceTimeoutMs = Number(readValue(argv, index, argument));
      index += 1;
    } else if (argument === "--checkpoint") {
      parsed.checkpoint = readValue(argv, index, argument);
      index += 1;
    } else if (argument === "--snapshot") {
      parsed.snapshot = readValue(argv, index, argument);
      parsed.snapshotProvided = true;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (parsed.dryRun && parsed.verifyOnly) throw new Error("--dry-run and --verify-only are mutually exclusive");
  const sourceValue = parsed.source ?? env.DATABASE_PATH ?? "./data/climate-twin.sqlite";
  if (sourceValue === ":memory:") throw new Error("An in-memory SQLite database cannot be migrated");
  parsed.source = resolve(sourceValue);
  parsed.schema ??= DEFAULT_SCHEMA;
  if (!/^[a-z_][a-z0-9_]*$/.test(parsed.schema)) {
    throw new Error("--schema must be a lowercase PostgreSQL identifier");
  }
  parsed.batchSize ??= DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(parsed.batchSize) || parsed.batchSize < 1 || parsed.batchSize > MAX_BATCH_SIZE) {
    throw new Error(`--batch-size must be an integer between 1 and ${MAX_BATCH_SIZE}`);
  }
  parsed.maintenanceTimeoutMs ??= DEFAULT_MAINTENANCE_TIMEOUT_MS;
  if (
    !Number.isInteger(parsed.maintenanceTimeoutMs)
    || parsed.maintenanceTimeoutMs < 1_000
    || parsed.maintenanceTimeoutMs > MAX_MAINTENANCE_TIMEOUT_MS
  ) {
    throw new Error(`--maintenance-timeout-ms must be an integer between 1000 and ${MAX_MAINTENANCE_TIMEOUT_MS}`);
  }
  parsed.checkpoint = resolve(parsed.checkpoint ?? `${parsed.source}.timescale-migration.json`);
  parsed.snapshot = resolve(parsed.snapshot ?? `${parsed.source}.timescale-migration.snapshot.sqlite`);
  parsed.postgresUrl ??= env.TIMESCALE_DATABASE_URL ?? env.DATABASE_URL;
  if (parsed.postgresUrl) {
    parsed.pgClientConfig = { connectionString: parsed.postgresUrl };
    parsed.connectionSecrets = [parsed.postgresUrl];
  } else {
    const hasPgEnvironment = [env.PGHOST, env.PGHOSTADDR, env.PGPORT, env.PGDATABASE, env.PGUSER, env.PGPASSWORD]
      .some((value) => value !== undefined && value !== "");
    const hasTimeseriesEnvironment = [
      env.TIMESERIES_HOST,
      env.TIMESERIES_PORT,
      env.TIMESERIES_DATABASE,
      env.TIMESERIES_USER,
      env.TIMESERIES_PASSWORD,
      env.TIMESERIES_PASSWORD_FILE,
    ].some((value) => value !== undefined);
    if (hasPgEnvironment) {
      parsed.pgClientConfig = compactObject({
        host: env.PGHOST ?? env.PGHOSTADDR,
        port: optionalPort(env.PGPORT, "PGPORT"),
        database: env.PGDATABASE,
        user: env.PGUSER,
        password: env.PGPASSWORD,
      });
      parsed.connectionSecrets = [env.PGPASSWORD];
    } else if (hasTimeseriesEnvironment) {
      const password = timeseriesPasswordFromEnvironment(env);
      parsed.pgClientConfig = {
        host: env.TIMESERIES_HOST || "127.0.0.1",
        port: optionalPort(env.TIMESERIES_PORT, "TIMESERIES_PORT") ?? 5432,
        database: env.TIMESERIES_DATABASE || "stuga",
        user: env.TIMESERIES_USER || "stuga_app",
        password,
      };
      parsed.connectionSecrets = [password];
    }
  }
  if (!parsed.help && !parsed.dryRun && !parsed.pgClientConfig) {
    throw new Error(
      "Configure TIMESCALE_DATABASE_URL, DATABASE_URL, PG* variables, TIMESERIES_* variables, or pass --postgres-url",
    );
  }
  return parsed;
}

export function q(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function tableExists(database, table) {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

export function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function destinationTimestampKey(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/iu.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const monthDays = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]
    || hour > 23 || minute > 59 || second > 59
  ) return null;

  let offsetMinutes = 0;
  if (zone.toUpperCase() !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    // PostgreSQL accepts numeric UTC offsets only through 15:59. Restricting
    // the preflight grammar keeps its normalisation identical and explicit.
    if (offsetHour > 15 || offsetMinute > 59) return null;
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (zone[0] === "+" ? 1 : -1);
  }

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  const instant = new Date(local.getTime() - offsetMinutes * 60_000);
  const canonical = instant.toISOString();
  // Four-digit application dates cannot safely cross into an extended or BC
  // year during offset normalisation; reject those edge cases before import.
  if (!/^\d{4}-/u.test(canonical) || canonical.startsWith("0000-")) return null;
  return `${canonical.slice(0, 19)}.${fraction.padEnd(6, "0")}Z`;
}

export function registerDestinationTimestampKey(database) {
  database.function(DESTINATION_TIMESTAMP_KEY_FUNCTION, {
    deterministic: true,
    directOnly: true,
  }, destinationTimestampKey);
}

export function normalizedTimestampExpression(column) {
  return `${DESTINATION_TIMESTAMP_KEY_FUNCTION}(${quoteSqliteIdentifier(column)})`;
}

export function duplicateKeyRows(database, table, keyColumns, timeColumn) {
  const normalizedTime = normalizedTimestampExpression(timeColumn);
  const group = keyColumns.map((column) => (
    column === timeColumn ? normalizedTime : quoteSqliteIdentifier(column)
  )).join(", ");
  const row = database.prepare(`
    SELECT COALESCE(SUM(duplicate_count - 1), 0) AS duplicate_rows
    FROM (
      SELECT COUNT(*) AS duplicate_count
      FROM ${quoteSqliteIdentifier(table)}
      WHERE ${normalizedTime} IS NOT NULL
      GROUP BY ${group}
      HAVING COUNT(*) > 1
    )
  `).get();
  return Number(row.duplicate_rows);
}
