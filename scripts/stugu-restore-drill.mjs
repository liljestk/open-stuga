#!/usr/bin/env node
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import {
  assertSqliteCheck,
  hardenPrivateDirectory,
  hardenPrivateFile,
  inventorySqliteTables,
  openReadOnlySqlite,
  sha256File,
} from "./sqlite-snapshot-utils.mjs";
import { timescalePreRestoreSql } from "./stugu-backup/commands-timescale.mjs";
import { verifyBackup } from "./stugu-backup/operations.mjs";

const TELEMETRY_TABLES = [
  ["measurement_samples", "observed_at"],
  ["legacy_readings", "observed_at"],
  ["outdoor_temperature_samples", "observed_at"],
  ["electricity_price_samples", "starts_at"],
  ["opening_state_samples", "observed_at"],
  ["heat_pump_state_samples", "observed_at"],
];

function requiredPath(value, label) {
  const path = resolve(value ?? "");
  if (!value || !existsSync(path)) throw new Error(`${label} does not exist`);
  return path;
}

function safeIdentifier(value, label) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function postgresIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function postgresLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function safePort(value) {
  const port = Number(value ?? 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("TimescaleDB port is invalid");
  }
  return String(port);
}

function run(command, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${basename(command)} failed with exit code ${code}: ${stderr.trim().slice(0, 2_000)}`));
    });
  });
}

function requiredRecord(manifest, category) {
  const records = manifest.files.filter((record) => record.category === category);
  if (records.length !== 1) throw new Error(`Backup must include exactly one ${category} artifact`);
  return records[0];
}

function safeRecordPath(directory, record) {
  if (typeof record?.path !== "string" || isAbsolute(record.path)) {
    throw new Error("Backup manifest contains an unsafe artifact path");
  }
  const artifact = resolve(directory, record.path);
  const fromRoot = relative(directory, artifact);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Backup manifest contains an artifact outside the backup directory");
  }
  return artifact;
}

function recoveryRelativePath(record) {
  if (record.category === "core-sqlite") return join("data", "climate-twin.sqlite");
  if (record.category === "spatial-sqlite") {
    return join("data", "experimental-spatial-layers.sqlite");
  }
  if (record.category === "stuguby-identity") return join("data", "stuguby-identity.json");
  if (record.category === "tracking-secret-key") return join("data", "tracking-secret.key");
  if (record.category === "integration-secrets") return join("data", "integration-secrets.json");
  if (record.category === "timescale-ownership-validation") {
    return join("restore", "validate-timescale-ownership.sql");
  }
  if (record.category !== "asset") return null;
  const portable = record.path.replaceAll("\\", "/");
  if (!portable.startsWith("assets/") || portable.length === "assets/".length) {
    throw new Error("Backup manifest contains an invalid asset path");
  }
  return join("data", "assets", ...portable.slice("assets/".length).split("/"));
}

function jsonObject(path, label) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value;
}

function validateIntegrationSecrets(path) {
  const value = jsonObject(path, "Restored integration secrets");
  if (value.version !== 1) throw new Error("Restored integration secrets have an unsupported version");
}

function validateTrackingKey(path) {
  const value = readFileSync(path, "utf8").trim();
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Restored tracking key is invalid");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) {
    throw new Error("Restored tracking key must contain exactly 32 base64url bytes");
  }
}

function validateStugubyIdentity(path) {
  const value = jsonObject(path, "Restored Stuguby identity");
  if (value.version !== 1 || typeof value.nodeId !== "string" || !value.nodeId
    || typeof value.displayName !== "string" || !value.displayName
    || typeof value.publicKey !== "string" || typeof value.privateKey !== "string"
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error("Restored Stuguby identity is invalid");
  }
  try {
    const privateBytes = Buffer.from(value.privateKey, "base64");
    const publicBytes = Buffer.from(value.publicKey, "base64");
    if (privateBytes.toString("base64") !== value.privateKey
      || publicBytes.toString("base64") !== value.publicKey) {
      throw new Error("non-canonical key");
    }
    const privateKey = createPrivateKey({ key: privateBytes, format: "der", type: "pkcs8" });
    const publicKey = createPublicKey({ key: publicBytes, format: "der", type: "spki" });
    const derivedPublic = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
    if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519"
      || derivedPublic !== value.publicKey) throw new Error("invalid key pair");
  } catch {
    throw new Error("Restored Stuguby identity key pair is invalid");
  }
}

function databaseInventory(path) {
  const database = openReadOnlySqlite(path);
  try {
    assertSqliteCheck(database, "integrity_check");
    return inventorySqliteTables(database);
  } finally {
    database.close();
  }
}

function expectedInventory(manifest, sourceName) {
  const tables = manifest.sources?.[sourceName]?.inventory?.tables;
  if (!Array.isArray(tables)) throw new Error(`Backup has no ${sourceName} SQLite inventory`);
  return tables;
}

function assertMatchingInventory(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Restored ${label} SQLite inventory does not match the backup manifest`);
  }
}

export async function stageRecoveryFiles(backupDirectory, manifest, recoveryRoot) {
  const directory = resolve(backupDirectory);
  const targetRoot = resolve(recoveryRoot);
  hardenPrivateDirectory(targetRoot);
  const seenTargets = new Set();
  const staged = [];
  for (const record of manifest.files) {
    const targetRelative = recoveryRelativePath(record);
    if (!targetRelative) continue;
    const source = safeRecordPath(directory, record);
    const target = resolve(targetRoot, targetRelative);
    const targetFromRoot = relative(targetRoot, target);
    if (targetFromRoot === ".." || targetFromRoot.startsWith(`..${sep}`) || isAbsolute(targetFromRoot)) {
      throw new Error("A recovery artifact escaped the isolated staging directory");
    }
    const normalizedTarget = process.platform === "win32" ? target.toLowerCase() : target;
    if (seenTargets.has(normalizedTarget)) throw new Error(`Backup artifacts collide at ${targetRelative}`);
    seenTargets.add(normalizedTarget);
    hardenPrivateDirectory(dirname(target));
    copyFileSync(source, target);
    hardenPrivateFile(target);
    if (statSync(target).size !== record.size || await sha256File(target) !== record.sha256) {
      throw new Error(`Staged recovery artifact does not match its manifest: ${record.path}`);
    }
    staged.push({ category: record.category, path: target, size: record.size });
  }

  const core = staged.filter(({ category }) => category === "core-sqlite");
  if (core.length !== 1) throw new Error("Recovery staging requires exactly one core SQLite snapshot");
  const coreTables = databaseInventory(core[0].path);
  assertMatchingInventory(coreTables, expectedInventory(manifest, "coreDatabase"), "core");

  const spatial = staged.filter(({ category }) => category === "spatial-sqlite");
  if (spatial.length > 1) throw new Error("Recovery staging found multiple spatial SQLite snapshots");
  if (manifest.sources?.spatialDatabase?.status === "included" && spatial.length !== 1) {
    throw new Error("Recovery staging is missing the recorded spatial SQLite snapshot");
  }
  if (spatial.length === 1) {
    assertMatchingInventory(
      databaseInventory(spatial[0].path),
      expectedInventory(manifest, "spatialDatabase"),
      "spatial",
    );
  }

  const validateOptionalControl = (category, sourceName, validate) => {
    const matches = staged.filter((record) => record.category === category);
    if (matches.length > 1) throw new Error(`Recovery staging found multiple ${category} files`);
    if (manifest.sources?.[sourceName]?.status === "included" && matches.length !== 1) {
      throw new Error(`Recovery staging is missing the recorded ${category} file`);
    }
    if (matches.length === 1) validate(matches[0].path);
  };
  validateOptionalControl("integration-secrets", "integrationSecrets", validateIntegrationSecrets);
  validateOptionalControl("tracking-secret-key", "trackingSecretKey", validateTrackingKey);
  validateOptionalControl("stuguby-identity", "stugubyIdentity", validateStugubyIdentity);

  const assets = staged.filter(({ category }) => category === "asset");
  const assetBytes = assets.reduce((total, record) => total + record.size, 0);
  if (manifest.sources?.assets?.status === "included"
    && (assets.length !== manifest.sources.assets.files || assetBytes !== manifest.sources.assets.bytes)) {
    throw new Error("Restored asset inventory does not match the backup manifest");
  }
  return {
    files: staged.length,
    bytes: staged.reduce((total, record) => total + record.size, 0),
    assets: assets.length,
    assetBytes,
    coreTables: coreTables.length,
    spatialTables: spatial.length === 1 ? expectedInventory(manifest, "spatialDatabase").length : 0,
    controls: staged.filter(({ category }) => [
      "integration-secrets", "tracking-secret-key", "stuguby-identity",
    ].includes(category)).map(({ category }) => category).sort(),
  };
}

export function timescaleUsabilitySql(schema, applicationRole) {
  const schemaLiteral = postgresLiteral(schema);
  const schemaIdentifier = postgresIdentifier(schema);
  const tableSummaries = TELEMETRY_TABLES.map(([table, timestamp]) => {
    const relation = `${schemaIdentifier}.${postgresIdentifier(table)}`;
    return `(SELECT json_build_object(
      'name', ${postgresLiteral(table)},
      'rows', count(*)::text,
      'firstAt', min(${postgresIdentifier(timestamp)})::text,
      'lastAt', max(${postgresIdentifier(timestamp)})::text
    ) FROM ${relation})`;
  }).join(",\n    ");
  return `SET ROLE ${postgresIdentifier(applicationRole)};
DO $stugu_recovery_read$
DECLARE
  relation record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${schemaLiteral}) THEN
    RAISE EXCEPTION 'Restored telemetry schema is missing';
  END IF;
  FOR relation IN
    SELECT namespace.nspname, item.relname
    FROM pg_class item
    JOIN pg_namespace namespace ON namespace.oid = item.relnamespace
    WHERE namespace.nspname = ${schemaLiteral}
      AND item.relkind IN ('r', 'p', 'v', 'm', 'f')
  LOOP
    EXECUTE format('SELECT 1 FROM %I.%I LIMIT 1', relation.nspname, relation.relname);
  END LOOP;
END
$stugu_recovery_read$;
RESET ROLE;
SELECT json_build_object(
  'schema', ${schemaLiteral},
  'relations', (SELECT count(*) FROM pg_class item
    JOIN pg_namespace namespace ON namespace.oid = item.relnamespace
    WHERE namespace.nspname = ${schemaLiteral} AND item.relkind IN ('r', 'p', 'v', 'm', 'f')),
  'hypertables', (SELECT count(*) FROM timescaledb_information.hypertables
    WHERE hypertable_schema = ${schemaLiteral}),
  'continuousAggregates', (SELECT count(*) FROM timescaledb_information.continuous_aggregates
    WHERE view_schema = ${schemaLiteral}),
  'tables', json_build_array(
    ${tableSummaries}
  )
)::text;`;
}

function validatedTimescaleSummary(output, schema) {
  const line = String(output).trim().split(/\r?\n/u).filter(Boolean).at(-1);
  let summary;
  try {
    summary = JSON.parse(line ?? "");
  } catch {
    throw new Error("TimescaleDB restore validation did not return a usable inventory");
  }
  if (summary?.schema !== schema || !Number.isInteger(summary.relations) || summary.relations < TELEMETRY_TABLES.length
    || !Number.isInteger(summary.hypertables) || summary.hypertables < TELEMETRY_TABLES.length
    || !Number.isInteger(summary.continuousAggregates) || summary.continuousAggregates < 0
    || !Array.isArray(summary.tables) || summary.tables.length !== TELEMETRY_TABLES.length) {
    throw new Error("TimescaleDB restore validation returned an invalid inventory");
  }
  for (const [name] of TELEMETRY_TABLES) {
    const table = summary.tables.find((candidate) => candidate?.name === name);
    if (!table || typeof table.rows !== "string" || !/^\d+$/u.test(table.rows)
      || ![table.firstAt, table.lastAt].every((value) => value === null || typeof value === "string")) {
      throw new Error(`TimescaleDB restore validation is incomplete for ${name}`);
    }
  }
  return summary;
}

async function assertArtifact(directory, record, label) {
  const path = requiredPath(safeRecordPath(directory, record), label);
  if (statSync(path).size !== record.size || await sha256File(path) !== record.sha256) {
    throw new Error(`${label} no longer matches the verified backup manifest`);
  }
  return path;
}

export async function restoreDrill(backupDirectory, environment = process.env, dependencies = {}) {
  const directory = requiredPath(backupDirectory, "Backup directory");
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  if (manifest?.format !== "stugu-backup" || manifest?.version !== 2 || !Array.isArray(manifest.files)) {
    throw new Error("Unsupported backup manifest");
  }
  const runCommand = dependencies.runCommand ?? run;
  const verify = dependencies.verifyBackup ?? verifyBackup;
  await verify(directory, "pg_restore", environment);

  const timescale = manifest.sources?.timescale;
  if (timescale?.status !== "included" || timescale.scope !== "full-database") {
    throw new Error("Backup does not include a full-database TimescaleDB dump");
  }
  const restore = timescale.restore;
  const schema = safeIdentifier(timescale.telemetrySchema ?? "", "TimescaleDB telemetry schema");
  const applicationRole = safeIdentifier(restore?.applicationRole ?? "", "TimescaleDB application role");
  const dumpRecord = requiredRecord(manifest, "timescale-pgdump");
  const validatorRecord = requiredRecord(manifest, "timescale-ownership-validation");
  if (restore?.ownershipValidation?.file !== validatorRecord.path) {
    throw new Error("TimescaleDB ownership validator does not match the backup manifest");
  }

  const passwordFile = requiredPath(
    environment.TIMESERIES_ADMIN_PASSWORD_FILE ?? "",
    "TimescaleDB admin password file",
  );
  const password = readFileSync(passwordFile, "utf8").trim();
  if (!password) throw new Error("TimescaleDB admin password file is empty");
  const host = environment.TIMESERIES_HOST ?? "timescaledb";
  const port = safePort(environment.TIMESERIES_PORT);
  const adminDatabase = safeIdentifier(environment.TIMESERIES_DATABASE ?? "stuga", "TimescaleDB database");
  const adminUser = safeIdentifier(environment.TIMESERIES_ADMIN_USER ?? "stuga_admin", "TimescaleDB admin user");
  const suffix = dependencies.randomSuffix?.() ?? randomBytes(8).toString("hex");
  if (!/^[a-f0-9]{16}$/u.test(suffix)) throw new Error("Restore drill database suffix is invalid");
  const drillDatabase = safeIdentifier(`stuga_drill_${suffix}`, "Restore drill database");
  const childEnv = {
    ...environment,
    PGPASSWORD: password,
    ...(environment.PGSSLMODE === undefined && environment.TIMESERIES_SSL_MODE
      ? { PGSSLMODE: environment.TIMESERIES_SSL_MODE }
      : {}),
  };
  const connection = ["-h", host, "-p", port, "-U", adminUser];
  const stagingParent = environment.RESTORE_DRILL_STAGING_DIRECTORY
    ? requiredPath(environment.RESTORE_DRILL_STAGING_DIRECTORY, "Restore drill staging directory")
    : dirname(directory);
  if (!statSync(stagingParent).isDirectory()) throw new Error("Restore drill staging path is not a directory");
  const recoveryRoot = mkdtempSync(join(stagingParent, ".stugu-restore-drill-"));
  hardenPrivateDirectory(recoveryRoot);
  let created = false;
  try {
    const staged = await stageRecoveryFiles(directory, manifest, recoveryRoot);
    const dump = await assertArtifact(directory, dumpRecord, "TimescaleDB dump");
    const validator = requiredPath(
      join(recoveryRoot, "restore", "validate-timescale-ownership.sql"),
      "Staged TimescaleDB ownership validator",
    );
    await runCommand("createdb", [
      ...connection, "--maintenance-db", adminDatabase, "-T", "template0", "-O", adminUser, drillDatabase,
    ], childEnv);
    created = true;
    await runCommand("psql", [
      ...connection, "-X", "-d", drillDatabase, "-v", "ON_ERROR_STOP=1", "-c",
      `CREATE EXTENSION IF NOT EXISTS timescaledb; ${timescalePreRestoreSql(schema)}`,
    ], childEnv);
    await runCommand("pg_restore", [
      ...connection, "--exit-on-error", "--no-privileges", "--no-tablespaces",
      "--dbname", drillDatabase, dump,
    ], childEnv);
    await runCommand("psql", [
      ...connection, "-X", "-d", drillDatabase, "-v", "ON_ERROR_STOP=1", "-c",
      "SELECT timescaledb_post_restore(); ANALYZE;",
    ], childEnv);
    await runCommand("psql", [
      ...connection, "-X", "-d", drillDatabase, "-v", "ON_ERROR_STOP=1", "-f", validator,
    ], childEnv);
    const inventoryOutput = await runCommand("psql", [
      ...connection, "-X", "-q", "-A", "-t", "-d", drillDatabase, "-v", "ON_ERROR_STOP=1", "-c",
      timescaleUsabilitySql(schema, applicationRole),
    ], childEnv);
    const telemetry = validatedTimescaleSummary(inventoryOutput, schema);
    await assertArtifact(directory, dumpRecord, "TimescaleDB dump");
    return {
      database: drillDatabase,
      restoredAt: (dependencies.now?.() ?? new Date()).toISOString(),
      staged,
      telemetry,
    };
  } finally {
    try {
      if (created) {
        await runCommand("dropdb", [
          ...connection, "--maintenance-db", adminDatabase, "--force", drillDatabase,
        ], childEnv).catch((error) => {
          throw new Error(`Restore drill completed but cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    } finally {
      rmSync(recoveryRoot, { recursive: true, force: true });
    }
    // The password is scoped to child processes and is never returned or logged.
    void password;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const backupDirectory = process.argv[2];
  restoreDrill(backupDirectory).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
