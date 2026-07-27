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

import { MANIFEST_VERSION, SOURCE_TABLES, duplicateKeyRows, normalizedTimestampExpression, registerDestinationTimestampKey, tableExists } from "./configuration.mjs";

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

export function sourceBlockers(inventory) {
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

export function printInventory(inventory) {
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

export function writeManifest(path, manifest) {
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

export function readManifest(path) {
  hardenPrivateFile(path);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read migration checkpoint ${path}: ${error.message}`);
  }
  if (parsed?.format !== "stugu-telemetry-migration" || ![1, MANIFEST_VERSION].includes(parsed?.version)) {
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

export function processExists(pid) {
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

export function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function redactConnectionText(value, secrets = []) {
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

export async function legacyDestinationFingerprint(client, schema) {
  const result = await client.query(`
    SELECT current_database() AS database,
           current_user AS username,
           COALESCE(inet_server_addr()::text, 'local-socket') AS server,
           COALESCE(inet_server_port(), 0) AS port
  `);
  return hashJson({ ...result.rows[0], schema });
}

export async function loadPgClient(clientConfig) {
  let module;
  try {
    module = await import("pg");
  } catch {
    throw new Error("The pg package is required for migration; install project dependencies first");
  }
  const Client = module.Client ?? module.default?.Client;
  if (!Client) throw new Error("The installed pg package does not export Client");
  const client = new Client({ ...clientConfig, application_name: "stugu-telemetry-migration" });
  await client.connect();
  return client;
}

export async function requireTimescaleExtension(client) {
  const extension = await client.query(`SELECT extversion AS timescale_version
    FROM pg_extension WHERE extname = 'timescaledb'`);
  const version = extension.rows[0]?.timescale_version;
  if (!version) throw new Error("TimescaleDB extension is required but is not enabled in the destination database");
  return String(version);
}
