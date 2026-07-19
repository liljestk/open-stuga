#!/usr/bin/env node

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
} from "./sqlite-snapshot-utils.mjs";

const MANIFEST_VERSION = 2;
const DEFAULT_BATCH_SIZE = 1_000;
const MAX_BATCH_SIZE = 10_000;
const DEFAULT_SCHEMA = "telemetry";
const DEFAULT_MAINTENANCE_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_MAINTENANCE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const DESTINATION_TIMESTAMP_KEY_FUNCTION = "stuga_destination_timestamptz_key";
const PREFLIGHT_SEMANTICS_VERSION = 3;
const DESTINATION_FINGERPRINT_VERSION = 2;

const SOURCE_TABLES = Object.freeze({
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
    dateColumns: ["start_at", "end_at", "fetched_at"],
    timeColumn: "start_at",
  },
});

const TARGET_PRIMARY_KEYS = Object.freeze({
  measurement_samples: ["sensor_id", "metric", "observed_at", "source"],
  readings: ["sensor_id", "observed_at", "source"],
  outdoor_temperature_samples: ["house_id", "location_key", "observed_at", "source"],
  electricity_price_points: ["property_id", "starts_at", "source"],
});

const TARGET_TABLES = Object.freeze({
  measurement_samples: "measurement_samples",
  readings: "legacy_readings",
  outdoor_temperature_samples: "outdoor_temperature_samples",
  electricity_price_points: "electricity_price_samples",
});

export const MIGRATION_HYPERTABLES = Object.freeze([
  { table: "measurement_samples", timeColumn: "observed_at", chunkInterval: "7 days" },
  { table: "legacy_readings", timeColumn: "observed_at", chunkInterval: "7 days" },
  { table: "outdoor_temperature_samples", timeColumn: "observed_at", chunkInterval: "30 days" },
  { table: "electricity_price_samples", timeColumn: "starts_at", chunkInterval: "90 days" },
]);

export const MIGRATION_AGGREGATES = Object.freeze([
  { name: "measurement_samples_5m", interval: "5 minutes" },
  { name: "measurement_samples_1h", interval: "1 hour" },
  { name: "measurement_samples_1d", interval: "1 day" },
]);

function help() {
  return `Stuga SQLite to PostgreSQL/Timescale telemetry migration

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
  * TimescaleDB is required. All four target tables are converted and validated
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
  $env:TIMESCALE_DATABASE_URL='postgresql://user:password@localhost:5432/stuga'
  node scripts/migrate-telemetry-to-timescale.mjs --source ./data/climate-twin.sqlite
  node scripts/migrate-telemetry-to-timescale.mjs --source ./data/climate-twin.sqlite --verify-only
`;
}

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function optionalPort(value, label) {
  if (value === undefined || value === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${label} must be an integer from 1 to 65535`);
  return port;
}

function timeseriesPasswordFromEnvironment(env) {
  if (env.TIMESERIES_PASSWORD !== undefined && env.TIMESERIES_PASSWORD_FILE) {
    throw new Error("Configure only one of TIMESERIES_PASSWORD or TIMESERIES_PASSWORD_FILE");
  }
  if (!env.TIMESERIES_PASSWORD_FILE) return env.TIMESERIES_PASSWORD ?? "";
  const password = readFileSync(resolve(env.TIMESERIES_PASSWORD_FILE), "utf8").trim();
  if (!password) throw new Error("TIMESERIES_PASSWORD_FILE must not be empty");
  return password;
}

function compactObject(value) {
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

function q(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function tableExists(database, table) {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function destinationTimestampKey(value) {
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

function registerDestinationTimestampKey(database) {
  database.function(DESTINATION_TIMESTAMP_KEY_FUNCTION, {
    deterministic: true,
    directOnly: true,
  }, destinationTimestampKey);
}

function normalizedTimestampExpression(column) {
  return `${DESTINATION_TIMESTAMP_KEY_FUNCTION}(${quoteSqliteIdentifier(column)})`;
}

function duplicateKeyRows(database, table, keyColumns, timeColumn) {
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

export function inventoryTelemetrySource(database) {
  registerDestinationTimestampKey(database);
  const result = {};
  for (const [table, specification] of Object.entries(SOURCE_TABLES)) {
    if (!tableExists(database, table)) {
      result[table] = { exists: false, rows: 0, status: "absent" };
      continue;
    }
    const columns = database.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(table)})`).all()
      .map(({ name }) => String(name));
    const missingColumns = specification.requiredColumns.filter((column) => !columns.includes(column));
    if (missingColumns.length > 0) {
      result[table] = { exists: true, status: "incompatible", columns, missingColumns };
      continue;
    }
    const invalidDateTerms = specification.dateColumns.map((column) => {
      const field = quoteSqliteIdentifier(column);
      return `CASE WHEN ${normalizedTimestampExpression(column)} IS NULL THEN 1 ELSE 0 END`;
    });
    const invalidTextTerms = specification.nonEmptyColumns.map((column) => {
      const field = quoteSqliteIdentifier(column);
      return `CASE WHEN ${field} IS NULL OR length(${field}) = 0 THEN 1 ELSE 0 END`;
    });
    const invalidNumericTerms = specification.numericColumns.map(({ name, nullable }) => {
      const field = quoteSqliteIdentifier(name);
      const conditions = [`${field} >= 1e999`, `${field} <= -1e999`];
      if (!nullable) conditions.unshift(`${field} IS NULL`);
      return `CASE WHEN ${conditions.join(" OR ")} THEN 1 ELSE 0 END`;
    });
    const optionalJsonColumns = specification.optionalJsonColumns ?? [];
    const presentJsonColumns = optionalJsonColumns.filter((column) => columns.includes(column));
    const invalidJsonTerms = presentJsonColumns.map((column) => {
      const field = quoteSqliteIdentifier(column);
      return `CASE WHEN ${field} IS NOT NULL
        AND (typeof(${field}) <> 'text' OR json_valid(${field}) <> 1) THEN 1 ELSE 0 END`;
    });
    const populatedJsonTerms = presentJsonColumns.map((column) => (
      `CASE WHEN ${quoteSqliteIdentifier(column)} IS NOT NULL THEN 1 ELSE 0 END`
    ));
    const invalidInterval = table === "electricity_price_points"
      ? `SUM(CASE WHEN ${normalizedTimestampExpression("end_at")} <= ${normalizedTimestampExpression("start_at")}
        THEN 1 ELSE 0 END)`
      : "0";
    const summary = database.prepare(`
      SELECT COUNT(*) AS row_count,
             MIN(${normalizedTimestampExpression(specification.timeColumn)}) AS minimum_time,
             MAX(${normalizedTimestampExpression(specification.timeColumn)}) AS maximum_time,
             SUM(${invalidDateTerms.join(" + ")}) AS invalid_date_values,
             SUM(${invalidTextTerms.join(" + ")}) AS invalid_text_values,
             SUM(${invalidNumericTerms.join(" + ")}) AS invalid_numeric_values,
             ${invalidJsonTerms.length === 0 ? "0" : `SUM(${invalidJsonTerms.join(" + ")})`} AS invalid_json_values,
             ${populatedJsonTerms.length === 0 ? "0" : `SUM(${populatedJsonTerms.join(" + ")})`} AS populated_json_values,
             ${invalidInterval} AS invalid_intervals
      FROM ${quoteSqliteIdentifier(table)}
    `).get();
    result[table] = {
      exists: true,
      status: "ready",
      columns,
      rows: Number(summary.row_count),
      minimumTime: summary.minimum_time === null ? null : String(summary.minimum_time),
      maximumTime: summary.maximum_time === null ? null : String(summary.maximum_time),
      invalidDateValues: Number(summary.invalid_date_values ?? 0),
      invalidTextValues: Number(summary.invalid_text_values ?? 0),
      invalidNumericValues: Number(summary.invalid_numeric_values ?? 0),
      invalidJsonValues: Number(summary.invalid_json_values ?? 0),
      invalidIntervals: Number(summary.invalid_intervals ?? 0),
      duplicateKeyRows: duplicateKeyRows(database, table, specification.keyColumns, specification.timeColumn),
      sourceKey: specification.keyColumns,
      ...(optionalJsonColumns.length === 0 ? {} : {
        optionalJsonColumns: Object.fromEntries(optionalJsonColumns.map((column) => [
          column,
          {
            present: columns.includes(column),
            populatedRows: columns.includes(column) ? Number(summary.populated_json_values ?? 0) : 0,
            invalidValues: columns.includes(column) ? Number(summary.invalid_json_values ?? 0) : 0,
          },
        ])),
      }),
    };
  }
  return result;
}

function sourceBlockers(inventory) {
  const blockers = [];
  for (const [table, details] of Object.entries(inventory)) {
    if (details.status === "incompatible") {
      blockers.push(`${table} is missing columns: ${details.missingColumns.join(", ")}`);
    }
    if ((details.invalidDateValues ?? 0) > 0) {
      blockers.push(`${table} has ${details.invalidDateValues} invalid date value(s)`);
    }
    if ((details.invalidTextValues ?? 0) > 0) {
      blockers.push(`${table} has ${details.invalidTextValues} empty required text value(s)`);
    }
    if ((details.invalidNumericValues ?? 0) > 0) {
      blockers.push(`${table} has ${details.invalidNumericValues} non-finite required numeric value(s)`);
    }
    if ((details.invalidJsonValues ?? 0) > 0) {
      blockers.push(`${table} has ${details.invalidJsonValues} invalid optional JSON value(s)`);
    }
    if ((details.invalidIntervals ?? 0) > 0) {
      blockers.push(`${table} has ${details.invalidIntervals} interval(s) whose end is not after its start`);
    }
    if ((details.duplicateKeyRows ?? 0) > 0) {
      blockers.push(`${table} has ${details.duplicateKeyRows} row(s) that duplicate the destination natural key`);
    }
  }
  return blockers;
}

function printInventory(inventory) {
  console.log("Telemetry source inventory:");
  for (const [table, details] of Object.entries(inventory)) {
    if (!details.exists) console.log(`  ${table}: absent (will be skipped)`);
    else if (details.status !== "ready") console.log(`  ${table}: incompatible`);
    else {
      const range = details.rows === 0 ? "empty" : `${details.minimumTime} .. ${details.maximumTime}`;
      console.log(`  ${table}: ${details.rows} row(s), ${range}`);
    }
  }
}

function writeManifest(path, manifest) {
  manifest.updatedAt = new Date().toISOString();
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8", flush: true, flag: "wx", mode: 0o600,
    });
    hardenPrivateFile(temporary);
    // Same-directory rename is atomic on supported local filesystems. A crash
    // therefore leaves either the previous valid checkpoint or the new one.
    renameSync(temporary, path);
    hardenPrivateFile(path);
    try {
      const directoryDescriptor = openSync(directory, "r");
      try {
        // Best effort: Windows does not expose directory fsync, while POSIX does.
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch {
      // The file itself was flushed before rename; directory fsync is an extra
      // durability barrier where the platform supports it.
    }
  } catch (error) {
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* Preserve the original failure. */ }
    }
    throw error;
  }
}

function readManifest(path) {
  hardenPrivateFile(path);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read migration checkpoint ${path}: ${error.message}`);
  }
  if (parsed?.format !== "stuga-telemetry-migration" || ![1, MANIFEST_VERSION].includes(parsed?.version)) {
    throw new Error(`Unsupported migration checkpoint format: ${path}`);
  }
  if (parsed.version === 1) {
    parsed.version = MANIFEST_VERSION;
    parsed.checkpointUpgrade = {
      fromVersion: 1,
      upgradedAt: new Date().toISOString(),
      reason: "Require and validate Timescale hypertables before resuming bulk import",
    };
  }
  return parsed;
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function acquireCheckpointLock(checkpoint, {
  destinationFingerprint: fingerprint,
  advisoryLockHeld = false,
  host = hostname(),
  pid = process.pid,
  processExistsFn = processExists,
} = {}) {
  if (typeof fingerprint !== "string" || fingerprint.length === 0) {
    throw new Error("A destination fingerprint is required before locking a migration checkpoint");
  }
  const lockPath = `${checkpoint}.lock`;
  const ownerId = randomUUID();
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, `${JSON.stringify({
        version: 2,
        ownerId,
        pid,
        host,
        destinationFingerprint: fingerprint,
        createdAt: new Date().toISOString(),
      })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
      try {
        hardenPrivateFile(lockPath);
      } catch (error) {
        try { unlinkSync(lockPath); } catch { /* Preserve the ACL failure. */ }
        throw error;
      }
      return () => {
        try {
          const current = JSON.parse(readFileSync(lockPath, "utf8"));
          // A delayed finally block from a superseded owner must never remove
          // the replacement process's lock.
          if (current.ownerId === ownerId) unlinkSync(lockPath);
        } catch {
          // A missing or replaced lock is harmless at shutdown.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let lock;
      try {
        lock = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch {
        throw new Error(`Migration lock exists and cannot be inspected: ${lockPath}`);
      }
      const sameHostOwnerExited = lock.host === host && !processExistsFn(Number(lock.pid));
      const abandonedSameDestination = advisoryLockHeld
        && lock.destinationFingerprint === fingerprint;
      // Cross-container PID checks are meaningless. Reclaim a foreign-host
      // lock only after this process owns the PostgreSQL advisory lock for the
      // same durable destination/schema; an active peer cannot satisfy both.
      if (sameHostOwnerExited || abandonedSameDestination) {
        unlinkSync(lockPath);
        continue;
      }
      throw new Error(`Another migration appears to be using checkpoint ${checkpoint}`);
    }
  }
  throw new Error(`Unable to acquire migration lock for ${checkpoint}`);
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function redactConnectionText(value, secrets = []) {
  let result = String(value);
  const sensitive = [...secrets];
  for (const connectionString of secrets) {
    try {
      const parsed = new URL(connectionString);
      if (parsed.password) sensitive.push(parsed.password, decodeURIComponent(parsed.password));
    } catch {
      // A standalone password or non-URL libpq value still gets redacted below.
    }
  }
  for (const secret of sensitive) {
    if (secret) result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
}

export async function destinationFingerprint(client, schema) {
  const result = await client.query(`
    SELECT current_database() AS database,
           current_user AS username,
           (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid
  `);
  return hashJson({ ...result.rows[0], schema });
}

async function legacyDestinationFingerprint(client, schema) {
  const result = await client.query(`
    SELECT current_database() AS database,
           current_user AS username,
           COALESCE(inet_server_addr()::text, 'local-socket') AS server,
           COALESCE(inet_server_port(), 0) AS port
  `);
  return hashJson({ ...result.rows[0], schema });
}

async function loadPgClient(clientConfig) {
  let module;
  try {
    module = await import("pg");
  } catch {
    throw new Error("The pg package is required for migration; install project dependencies first");
  }
  const Client = module.Client ?? module.default?.Client;
  if (!Client) throw new Error("The installed pg package does not export Client");
  const client = new Client({ ...clientConfig, application_name: "stuga-telemetry-migration" });
  await client.connect();
  return client;
}

async function requireTimescaleExtension(client) {
  const extension = await client.query(`SELECT extversion AS timescale_version
    FROM pg_extension WHERE extname = 'timescaledb'`);
  const version = extension.rows[0]?.timescale_version;
  if (!version) throw new Error("TimescaleDB extension is required but is not enabled in the destination database");
  return String(version);
}

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

async function requireTimescaleDestination(client, schema) {
  const version = await requireTimescaleExtension(client);
  const hypertables = await validateExpectedHypertables(client, schema);
  return { version, hypertables };
}

function continuousAggregateSql(schema, aggregate) {
  const relation = `${q(schema)}.${q(aggregate.name)}`;
  const measurements = `${q(schema)}.${q("measurement_samples")}`;
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
          'measurement_samples', 'legacy_readings', 'outdoor_temperature_samples', 'electricity_price_samples'
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
        fetched_at timestamptz NOT NULL CHECK (isfinite(fetched_at)),
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        ingested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (property_id, starts_at, source)
      );
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
      INSERT INTO ${s}.schema_migrations (version, description)
        VALUES (1, 'Initial append-only telemetry schema')
        ON CONFLICT (version) DO NOTHING;
      INSERT INTO ${s}.schema_migrations (version, description)
        VALUES (2, 'Checkpointed SQLite archive reconciliation and real-data boundary state')
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

async function validateDestinationSchema(client, schema) {
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
        "property_id", "starts_at", "source", "ends_at", "raw_price_cents_per_kwh", "fetched_at", "metadata", "ingested_at",
      ],
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
    FROM ${q(schema)}.schema_migrations WHERE version IN (1, 2) ORDER BY version`);
  if (migrations.rows.map(({ version }) => Number(version)).join(",") !== "1,2") {
    throw new Error(`Destination ${schema}.schema_migrations is missing required versions 1 and 2`);
  }
}

function finiteNumber(value, label, nullable = false) {
  if (nullable && value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Source row contains an invalid ${label}`);
  return number;
}

function textValue(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new Error(`Source row contains an invalid ${label}`);
  return value;
}

function timestampValue(value, label) {
  if (destinationTimestampKey(value) === null) {
    throw new Error(`Source row contains an invalid or timezone-ambiguous ${label}`);
  }
  // PostgreSQL parses the original offset and fractional precision. Date.parse
  // is validation only; converting through Date would truncate microseconds.
  return value;
}

export function mapRows(table, rows) {
  if (table === "measurement_samples") return rows.map((row) => ({
    sensor_id: textValue(row.sensor_id, "sensor_id"),
    metric: textValue(row.metric, "metric"),
    observed_at: timestampValue(row.timestamp, "timestamp"),
    source: textValue(row.source, "source"),
    value: finiteNumber(row.value, "value"),
    canonical_unit: textValue(row.canonical_unit, "canonical_unit"),
    quality: textValue(row.quality, "quality"),
    metadata: {},
  }));
  if (table === "readings") return rows.map((row) => ({
    sensor_id: textValue(row.sensor_id, "sensor_id"),
    observed_at: timestampValue(row.timestamp, "timestamp"),
    source: textValue(row.source, "source"),
    temperature_c: finiteNumber(row.temperature, "temperature"),
    relative_humidity_pct: finiteNumber(row.humidity, "humidity"),
    battery_pct: finiteNumber(row.battery, "battery", true),
    quality: textValue(row.quality, "quality"),
    metadata: {},
  }));
  if (table === "outdoor_temperature_samples") return rows.map((row) => ({
    house_id: textValue(row.house_id, "house_id"),
    location_key: textValue(row.location_key, "location_key"),
    observed_at: timestampValue(row.timestamp, "timestamp"),
    source: textValue(row.source, "source"),
    temperature_c: finiteNumber(row.temperature_c, "temperature_c"),
    fetched_at: timestampValue(row.fetched_at, "fetched_at"),
    station_id: textValue(row.station_id, "station_id", true),
    station_name: textValue(row.station_name, "station_name", true),
    // Keep the original JSON text until PostgreSQL casts it to JSONB. Parsing
    // through JavaScript would round high-precision JSON numbers.
    conditions_json: textValue(row.conditions_json ?? null, "conditions_json", true),
  }));
  if (table === "electricity_price_points") return rows.map((row) => ({
    property_id: textValue(row.property_id, "property_id"),
    starts_at: timestampValue(row.start_at, "start_at"),
    source: "sqlite",
    ends_at: timestampValue(row.end_at, "end_at"),
    raw_price_cents_per_kwh: finiteNumber(row.raw_price_cents_per_kwh, "raw_price_cents_per_kwh"),
    fetched_at: timestampValue(row.fetched_at, "fetched_at"),
    metadata: {},
  }));
  throw new Error(`Unsupported source table: ${table}`);
}

function fetchSourceBatch(database, table, cursor, batchSize) {
  if (table === "measurement_samples" || table === "readings") {
    const where = cursor === null ? "" : "WHERE id > ?";
    const statement = database.prepare(`SELECT * FROM ${quoteSqliteIdentifier(table)} ${where} ORDER BY id LIMIT ?`);
    const rows = cursor === null ? statement.all(batchSize) : statement.all(cursor, batchSize);
    return {
      rows,
      cursor: rows.length === 0 ? cursor : Number(rows.at(-1).id),
    };
  }
  if (table === "outdoor_temperature_samples") {
    const columns = "timestamp, house_id, location_key, source";
    const where = cursor === null ? "" : `WHERE (${columns}) > (?, ?, ?, ?)`;
    const statement = database.prepare(`SELECT * FROM ${quoteSqliteIdentifier(table)} ${where} ORDER BY ${columns} LIMIT ?`);
    const parameters = cursor === null
      ? [batchSize]
      : [cursor.timestamp, cursor.houseId, cursor.locationKey, cursor.source, batchSize];
    const rows = statement.all(...parameters);
    const last = rows.at(-1);
    return {
      rows,
      cursor: last === undefined ? cursor : {
        timestamp: last.timestamp,
        houseId: last.house_id,
        locationKey: last.location_key,
        source: last.source,
      },
    };
  }
  if (table === "electricity_price_points") {
    const columns = "start_at, property_id";
    const where = cursor === null ? "" : `WHERE (${columns}) > (?, ?)`;
    const statement = database.prepare(`SELECT * FROM ${quoteSqliteIdentifier(table)} ${where} ORDER BY ${columns} LIMIT ?`);
    const parameters = cursor === null ? [batchSize] : [cursor.startAt, cursor.propertyId, batchSize];
    const rows = statement.all(...parameters);
    const last = rows.at(-1);
    return {
      rows,
      cursor: last === undefined ? cursor : { startAt: last.start_at, propertyId: last.property_id },
    };
  }
  throw new Error(`Unsupported source table: ${table}`);
}

function recordDefinition(table) {
  return {
    measurement_samples: `sensor_id text, metric text, observed_at timestamptz, source text, value double precision,
      canonical_unit text, quality text, metadata jsonb`,
    readings: `sensor_id text, observed_at timestamptz, source text, temperature_c double precision,
      relative_humidity_pct double precision, battery_pct double precision, quality text, metadata jsonb`,
    outdoor_temperature_samples: `house_id text, location_key text, observed_at timestamptz, source text,
      temperature_c double precision, fetched_at timestamptz, station_id text, station_name text, conditions_json text`,
    electricity_price_points: `property_id text, starts_at timestamptz, source text, ends_at timestamptz,
      raw_price_cents_per_kwh double precision, fetched_at timestamptz, metadata jsonb`,
  }[table];
}

function targetColumns(table) {
  return {
    measurement_samples: ["sensor_id", "metric", "observed_at", "source", "value", "canonical_unit", "quality", "metadata"],
    readings: [
      "sensor_id", "observed_at", "source", "temperature_c", "relative_humidity_pct", "battery_pct", "quality", "metadata",
    ],
    outdoor_temperature_samples: [
      "house_id", "location_key", "observed_at", "source", "temperature_c", "fetched_at", "station_id", "station_name", "metadata",
    ],
    electricity_price_points: [
      "property_id", "starts_at", "source", "ends_at", "raw_price_cents_per_kwh", "fetched_at", "metadata",
    ],
  }[table];
}

function mutableColumns(table) {
  const key = new Set(TARGET_PRIMARY_KEYS[table]);
  return targetColumns(table).filter((column) => !key.has(column));
}

function targetProjection(table, alias) {
  return targetColumns(table).map((column) => {
    if (table === "outdoor_temperature_samples" && column === "metadata") {
      return `CASE WHEN ${alias}.${q("conditions_json")} IS NULL THEN '{}'::jsonb
        ELSE jsonb_build_object('conditions', ${alias}.${q("conditions_json")}::jsonb)
      END AS ${q("metadata")}`;
    }
    return `${alias}.${q(column)} AS ${q(column)}`;
  }).join(", ");
}

export async function upsertBatch(client, schema, table, payload) {
  const columns = targetColumns(table);
  const sql = `
    INSERT INTO ${q(schema)}.${q(TARGET_TABLES[table])} (${columns.map(q).join(", ")})
    SELECT ${targetProjection(table, "incoming")}
    FROM jsonb_to_recordset($1::jsonb) AS incoming(${recordDefinition(table)})
    ON CONFLICT (${TARGET_PRIMARY_KEYS[table].map(q).join(", ")})
    DO NOTHING
  `;
  await client.query(sql, [JSON.stringify(payload)]);
}

function payloadComparison(table, actual = "actual", expected = "expected") {
  return mutableColumns(table)
    .map((column) => `${actual}.${q(column)} IS NOT DISTINCT FROM ${expected}.${q(column)}`)
    .join(" AND ");
}

export async function verifyBatch(client, schema, table, payload) {
  if (payload.length === 0) return { expectedRows: 0, foundRows: 0, matchingRows: 0, minimumTime: null, maximumTime: null };
  const keyJoin = TARGET_PRIMARY_KEYS[table]
    .map((column) => `actual.${q(column)} = expected.${q(column)}`)
    .join(" AND ");
  const timeColumn = table === "electricity_price_points" ? "starts_at" : "observed_at";
  const result = await client.query(`
    WITH source_rows AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS incoming(${recordDefinition(table)})
    ), expected AS (
      SELECT ${targetProjection(table, "source_rows")} FROM source_rows
    )
    SELECT COUNT(*)::bigint AS expected_rows,
           COUNT(actual.${q(TARGET_PRIMARY_KEYS[table][0])})::bigint AS found_rows,
           COUNT(*) FILTER (
             WHERE actual.${q(TARGET_PRIMARY_KEYS[table][0])} IS NOT NULL
               AND ${payloadComparison(table)}
           )::bigint AS matching_rows,
           MIN(expected.${q(timeColumn)}) AS minimum_time,
           MAX(expected.${q(timeColumn)}) AS maximum_time
    FROM expected
    LEFT JOIN ${q(schema)}.${q(TARGET_TABLES[table])} actual ON ${keyJoin}
  `, [JSON.stringify(payload)]);
  const row = result.rows[0];
  return {
    expectedRows: Number(row.expected_rows),
    foundRows: Number(row.found_rows),
    matchingRows: Number(row.matching_rows),
    minimumTime: row.minimum_time === null ? null : new Date(row.minimum_time).toISOString(),
    maximumTime: row.maximum_time === null ? null : new Date(row.maximum_time).toISOString(),
  };
}

function assertVerified(table, verification) {
  if (verification.expectedRows !== verification.foundRows || verification.expectedRows !== verification.matchingRows) {
    throw new Error(
      `Destination verification failed for ${TARGET_TABLES[table]}: expected ${verification.expectedRows}, `
      + `found ${verification.foundRows}, payload matches ${verification.matchingRows}`,
    );
  }
}

async function migrateTables(client, database, options, manifest, interrupted) {
  for (const table of Object.keys(SOURCE_TABLES)) {
    const sourceDetails = manifest.inventory[table];
    manifest.progress[table] ??= { cursor: null, rowsProcessed: 0, batches: 0, complete: false };
    const progress = manifest.progress[table];
    if (!sourceDetails.exists) {
      progress.complete = true;
      writeManifest(options.checkpoint, manifest);
      continue;
    }
    if (progress.complete) continue;
    console.log(`Migrating ${table} from row ${progress.rowsProcessed} of ${sourceDetails.rows}...`);
    while (!progress.complete) {
      const batch = fetchSourceBatch(database, table, progress.cursor, options.batchSize);
      if (batch.rows.length === 0) {
        progress.complete = true;
        writeManifest(options.checkpoint, manifest);
        break;
      }
      const payload = mapRows(table, batch.rows);
      await client.query("BEGIN");
      try {
        await upsertBatch(client, options.schema, table, payload);
        const verification = await verifyBatch(client, options.schema, table, payload);
        assertVerified(table, verification);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      progress.cursor = batch.cursor;
      progress.rowsProcessed += batch.rows.length;
      progress.batches += 1;
      manifest.state = "migrating";
      writeManifest(options.checkpoint, manifest);
      if (interrupted.requested) throw new Error("Migration interrupted after saving the latest committed checkpoint");
    }
  }
}

async function verifyAllTables(client, database, options, inventory) {
  const reports = {};
  for (const table of Object.keys(SOURCE_TABLES)) {
    const sourceDetails = inventory[table];
    if (!sourceDetails.exists) {
      reports[table] = {
        status: "absent",
        destinationTable: TARGET_TABLES[table],
        destinationKey: TARGET_PRIMARY_KEYS[table],
        sourceRows: 0,
        matchedRows: 0,
      };
      continue;
    }
    let cursor = null;
    let sourceRows = 0;
    let foundRows = 0;
    let matchedRows = 0;
    let minimumTime = null;
    let maximumTime = null;
    for (;;) {
      const batch = fetchSourceBatch(database, table, cursor, options.batchSize);
      if (batch.rows.length === 0) break;
      cursor = batch.cursor;
      const verification = await verifyBatch(client, options.schema, table, mapRows(table, batch.rows));
      sourceRows += verification.expectedRows;
      foundRows += verification.foundRows;
      matchedRows += verification.matchingRows;
      minimumTime ??= verification.minimumTime;
      maximumTime = verification.maximumTime;
    }
    const report = {
      status: sourceRows === foundRows && sourceRows === matchedRows ? "verified" : "failed",
      sourceRows,
      foundRows,
      matchedRows,
      sourceKey: sourceDetails.sourceKey,
      destinationTable: TARGET_TABLES[table],
      destinationKey: TARGET_PRIMARY_KEYS[table],
      range: { minimumTime, maximumTime },
    };
    reports[table] = report;
    if (report.status !== "verified") assertVerified(table, {
      expectedRows: sourceRows,
      foundRows,
      matchingRows: matchedRows,
    });
    console.log(`Verified ${table}: ${matchedRows}/${sourceRows} exact key-and-payload match(es)`);
  }
  return reports;
}

async function buildOrLoadManifest(options) {
  if (existsSync(options.checkpoint)) {
    const manifest = readManifest(options.checkpoint);
    if (resolve(manifest.source.path) !== options.source && options.sourceProvided) {
      throw new Error("The checkpoint belongs to a different SQLite source");
    }
    if (manifest.schema !== options.schema) throw new Error("The checkpoint belongs to a different destination schema");
    const snapshotPath = resolve(manifest.snapshot.path);
    if (options.snapshotProvided && snapshotPath !== options.snapshot) {
      throw new Error("The checkpoint belongs to a different SQLite snapshot");
    }
    options.snapshot = snapshotPath;
    if (!existsSync(snapshotPath)) throw new Error(`Checkpoint snapshot is missing: ${snapshotPath}`);
    const currentSnapshot = await describeFile(snapshotPath);
    if (currentSnapshot.sha256 !== manifest.snapshot.sha256 || currentSnapshot.size !== manifest.snapshot.size) {
      throw new Error("The checkpoint snapshot has changed; refusing an unsafe resume");
    }
    const database = openReadOnlySqlite(snapshotPath);
    try {
      assertSqliteCheck(database, "integrity_check");
      if (manifest.preflightSemanticsVersion !== PREFLIGHT_SEMANTICS_VERSION) {
        manifest.inventory = inventoryTelemetrySource(database);
        manifest.blockers = sourceBlockers(manifest.inventory);
        manifest.preflightSemanticsVersion = PREFLIGHT_SEMANTICS_VERSION;
        manifest.preflightUpgrade = {
          upgradedAt: new Date().toISOString(),
          reason: "Re-run destination-key normalization and optional source metadata validation",
        };
        writeManifest(options.checkpoint, manifest);
      }
    } finally {
      database.close();
    }
    return manifest;
  }

  if (!existsSync(options.source)) throw new Error(`SQLite source does not exist: ${options.source}`);
  const snapshotDetails = await createVerifiedSqliteSnapshot({
    sourcePath: options.source,
    destinationPath: options.snapshot,
  });
  const database = openReadOnlySqlite(options.snapshot);
  let inventory;
  try {
    inventory = inventoryTelemetrySource(database);
  } finally {
    database.close();
  }
  const blockers = sourceBlockers(inventory);
  const manifest = {
    format: "stuga-telemetry-migration",
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: blockers.length === 0 ? "ready" : "blocked",
    schema: options.schema,
    source: snapshotDetails.source,
    snapshot: snapshotDetails.snapshot,
    sqliteChecks: snapshotDetails.checks,
    preflightSemanticsVersion: PREFLIGHT_SEMANTICS_VERSION,
    inventory,
    progress: Object.fromEntries(Object.keys(SOURCE_TABLES).map((table) => [
      table,
      { cursor: null, rowsProcessed: 0, batches: 0, complete: false },
    ])),
    blockers,
  };
  writeManifest(options.checkpoint, manifest);
  return manifest;
}

export async function runDryMigration(options) {
  if (!existsSync(options.source)) throw new Error(`SQLite source does not exist: ${options.source}`);
  const database = openReadOnlySqlite(options.source);
  try {
    assertSqliteCheck(database, "quick_check");
    assertSqliteCheck(database, "integrity_check");
    const inventory = inventoryTelemetrySource(database);
    printInventory(inventory);
    const blockers = sourceBlockers(inventory);
    if (blockers.length > 0) throw new Error(`Migration preflight blocked:\n  - ${blockers.join("\n  - ")}`);
    console.log("Dry run passed. No snapshot, checkpoint, or destination changes were made.");
    return inventory;
  } finally {
    database.close();
  }
}

export async function runMigration(options) {
  if (options.dryRun) return runDryMigration(options);
  let releaseLock = () => undefined;
  let client;
  let database;
  let advisoryLockHeld = false;
  const interrupted = { requested: false };
  const onInterrupt = () => { interrupted.requested = true; };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  try {
    client = await loadPgClient(options.pgClientConfig);
    const fingerprint = await destinationFingerprint(client, options.schema);
    const advisory = await client.query(
      "SELECT pg_try_advisory_lock(hashtext('stuga-telemetry-migration'), hashtext($1)) AS acquired",
      [options.schema],
    );
    if (!advisory.rows[0]?.acquired) {
      throw new Error("Another telemetry migration or verification is active on this destination schema");
    }
    advisoryLockHeld = true;
    releaseLock = acquireCheckpointLock(options.checkpoint, {
      destinationFingerprint: fingerprint,
      advisoryLockHeld,
    });

    const manifest = await buildOrLoadManifest(options);
    printInventory(manifest.inventory);
    if (manifest.blockers.length > 0) {
      throw new Error(`Migration preflight blocked:\n  - ${manifest.blockers.join("\n  - ")}`);
    }
    database = openReadOnlySqlite(options.snapshot);
    let upgradeFingerprintAfterVerification = false;
    if (manifest.destinationFingerprint) {
      const fingerprintVersion = Number(manifest.destinationFingerprintVersion ?? 1);
      if (fingerprintVersion === DESTINATION_FINGERPRINT_VERSION) {
        if (manifest.destinationFingerprint !== fingerprint) {
          throw new Error("The checkpoint belongs to a different PostgreSQL destination");
        }
      } else if (fingerprintVersion === 1) {
        const legacyFingerprint = await legacyDestinationFingerprint(client, options.schema);
        if (manifest.destinationFingerprint === legacyFingerprint || manifest.destinationFingerprint === fingerprint) {
          manifest.destinationFingerprint = fingerprint;
          manifest.destinationFingerprintVersion = DESTINATION_FINGERPRINT_VERSION;
        } else if (options.verifyOnly && manifest.state === "complete") {
          // A v1 fingerprint included the server's transport address. When a
          // container was recreated, exact read-only verification of a complete
          // import is the safe proof needed to bind it to the durable v2 ID.
          upgradeFingerprintAfterVerification = true;
        } else {
          throw new Error(
            "The legacy checkpoint destination changed; run --verify-only against a complete import before resuming",
          );
        }
      } else {
        throw new Error(`Unsupported destination fingerprint version: ${fingerprintVersion}`);
      }
    } else {
      manifest.destinationFingerprint = fingerprint;
      manifest.destinationFingerprintVersion = DESTINATION_FINGERPRINT_VERSION;
    }
    if (!upgradeFingerprintAfterVerification) writeManifest(options.checkpoint, manifest);

    if (options.verifyOnly) {
      const timescale = await requireTimescaleDestination(client, options.schema);
      await validateDestinationSchema(client, options.schema);
      manifest.destinationTimescale = {
        ...timescale,
        validatedAt: new Date().toISOString(),
      };
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        manifest.verification = {
          status: "passed",
          verifiedAt: new Date().toISOString(),
          tables: await verifyAllTables(client, database, options, manifest.inventory),
        };
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      if (upgradeFingerprintAfterVerification) {
        manifest.destinationFingerprint = fingerprint;
        manifest.destinationFingerprintVersion = DESTINATION_FINGERPRINT_VERSION;
      }
      writeManifest(options.checkpoint, manifest);
      console.log("Destination verification passed; no destination changes were made.");
      return manifest;
    }
    const timescale = await provisionDestination(client, options.schema, options.maintenanceTimeoutMs);
    await validateDestinationSchema(client, options.schema);
    manifest.destinationTimescale = {
      ...timescale,
      maintenanceTimeoutMs: options.maintenanceTimeoutMs,
      validatedAt: new Date().toISOString(),
    };
    writeManifest(options.checkpoint, manifest);
    await migrateTables(client, database, options, manifest, interrupted);
    manifest.verification = {
      status: "passed",
      verifiedAt: new Date().toISOString(),
      tables: await verifyAllTables(client, database, options, manifest.inventory),
    };
    writeManifest(options.checkpoint, manifest);
    manifest.aggregateRefresh = {
      status: "passed",
      refreshedAt: new Date().toISOString(),
      aggregates: await ensureAndRefreshMeasurementAggregates(
        client,
        options.schema,
        manifest.inventory.measurement_samples,
        options.maintenanceTimeoutMs,
      ),
    };
    manifest.state = "complete";
    manifest.completedAt = new Date().toISOString();
    writeManifest(options.checkpoint, manifest);
    console.log(`Migration complete. Checkpoint retained at ${options.checkpoint}`);
    console.log(`Consistent source snapshot retained at ${options.snapshot}`);
    return manifest;
  } catch (error) {
    const message = redactConnectionText(error instanceof Error ? error.message : String(error), options.connectionSecrets);
    throw new Error(message, { cause: error });
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
    try {
      database?.close();
    } catch {
      // Preserve an earlier migration failure.
    }
    releaseLock();
    try {
      if (advisoryLockHeld) {
        await client?.query("SELECT pg_advisory_unlock(hashtext('stuga-telemetry-migration'), hashtext($1))", [options.schema]);
      }
    } catch {
      // The server releases session advisory locks on disconnect.
    }
    try {
      await client?.end();
    } catch {
      // Preserve an earlier migration failure.
    }
  }
}

async function main() {
  let options;
  try {
    options = parseMigrationArgs(process.argv.slice(2));
    if (options.help) {
      console.log(help());
      return;
    }
    await runMigration(options);
  } catch (error) {
    const message = redactConnectionText(
      error instanceof Error ? error.message : String(error),
      options?.connectionSecrets,
    );
    console.error(`Migration failed: ${message}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) await main();
