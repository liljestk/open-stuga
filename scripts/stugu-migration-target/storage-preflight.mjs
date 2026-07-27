import { spawn } from "node:child_process";

import { createPrivateKey, createPublicKey } from "node:crypto";

import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";

import { dirname, join, relative, resolve, sep } from "node:path";

import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assembleMigrationBundle,
  missingMigrationChunks,
  validateMigrationPlan,
  verifyAssembledMigrationBundle,
} from ".././stugu-migration-bundle.mjs";

import {
  assertMigrationId,
  assertReleaseVersion,
  assertSafeRelativePath,
  compareReleaseVersions,
  isSha256,
  mergePortableEnvironment,
  pathWithin,
  sha256Text,
} from ".././stugu-migration-common.mjs";

import {
  timescaleOwnershipValidationSql,
  timescalePreRestoreSql,
  verifyBackup,
} from ".././stugu-backup.mjs";

import { hardenPrivateDirectory, hardenPrivateFile } from ".././sqlite-snapshot-utils.mjs";

export const TARGET_SCRIPT_VERSION = 1;

export const REQUIRED_FREE_HEADROOM = 512 * 1024 * 1024;

export function environmentPath(name, fallback) {
  return resolve(process.env[name] ?? fallback);
}

export function migrationPaths(id) {
  const migrationId = assertMigrationId(id);
  const root = environmentPath("STUGA_MIGRATION_ROOT", "/app/migrations");
  return {
    id: migrationId,
    root,
    plan: join(root, "incoming", `${migrationId}.json`),
    chunks: join(root, "chunks"),
    staged: join(root, "staged", migrationId),
    receipt: join(root, "receipts", `${migrationId}.json`),
    settingsRollback: join(root, "rollback", migrationId, "settings"),
  };
}

export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", flush: true, mode: 0o600 });
  hardenPrivateFile(temporary);
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}

export function fsyncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function durableRename(source, destination) {
  renameSync(source, destination);
  fsyncDirectory(dirname(source));
  if (dirname(destination) !== dirname(source)) fsyncDirectory(dirname(destination));
}

export function durableRemove(path, options = {}) {
  if (!existsSync(path)) return;
  rmSync(path, options);
  fsyncDirectory(dirname(path));
}

export function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function loadPlan(id, expectedSha256) {
  if (!isSha256(expectedSha256)) throw new Error("Expected plan SHA-256 is invalid");
  const paths = migrationPaths(id);
  if (!existsSync(paths.plan) || !lstatSync(paths.plan).isFile() || lstatSync(paths.plan).isSymbolicLink()) {
    throw new Error("Migration plan is missing or not a regular file");
  }
  const text = readFileSync(paths.plan, "utf8");
  if (sha256Text(text) !== expectedSha256) throw new Error("Migration plan SHA-256 mismatch");
  const plan = validateMigrationPlan(JSON.parse(text));
  if (plan.id !== paths.id) throw new Error("Migration plan id does not match its filename");
  return { paths, plan, planSha256: expectedSha256 };
}

export function installedVersion() {
  const configured = process.env.STUGA_TARGET_VERSION;
  if (configured) return assertReleaseVersion(configured, "Target version");
  const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  return assertReleaseVersion(readJson(packagePath, "package version").version, "Target version");
}

export function freeBytes(path) {
  const stats = statfsSync(path, { bigint: true });
  return Number(stats.bavail * stats.bsize);
}

export function storageStats(path, label) {
  if (!existsSync(path)) throw new Error(`${label} storage path is missing`);
  const details = lstatSync(path);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${label} storage path is not a real directory`);
  return {
    device: String(statSync(path).dev),
    freeBytes: freeBytes(path),
  };
}

export function assertRestoreCapacity(plan) {
  const data = environmentPath("STUGA_TARGET_DATA_DIRECTORY", "/app/data");
  const timeseries = environmentPath("STUGA_TARGET_TIMESERIES_DIRECTORY", "/app/timeseries-data");
  const requirements = new Map();
  const add = (stats, bytes) => {
    const current = requirements.get(stats.device) ?? { freeBytes: stats.freeBytes, requiredBytes: 0 };
    current.freeBytes = Math.min(current.freeBytes, stats.freeBytes);
    current.requiredBytes += bytes;
    requirements.set(stats.device, current);
  };
  add(storageStats(data, "Application data"), plan.estimatedDataBytes);
  add(storageStats(timeseries, "TimescaleDB"), plan.estimatedDatabaseBytes);
  for (const capacity of requirements.values()) {
    if (capacity.freeBytes < capacity.requiredBytes + REQUIRED_FREE_HEADROOM) {
      throw new Error("Target does not have enough free space for migration staging and rollback");
    }
  }
}

export function directoryBytes(root) {
  if (!existsSync(root)) return 0;
  let total = 0;
  const visit = (path) => {
    const details = lstatSync(path);
    if (details.isSymbolicLink()) throw new Error(`Cannot size a symbolic link: ${path}`);
    if (details.isFile()) total += details.size;
    else if (details.isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry));
  };
  visit(root);
  return total;
}

export function ensureDirectories() {
  const root = environmentPath("STUGA_MIGRATION_ROOT", "/app/migrations");
  const data = environmentPath("STUGA_TARGET_DATA_DIRECTORY", "/app/data");
  for (const directory of [root, data, join(root, "incoming"), join(root, "chunks"), join(root, "staged"), join(root, "receipts"), join(root, "rollback")]) {
    hardenPrivateDirectory(directory);
  }
  return { root, data };
}

export function safeIdentifier(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/u.test(value)) throw new Error(`${label} is not a safe PostgreSQL identifier`);
  return value;
}

export function sqlIdentifier(value) {
  return `"${safeIdentifier(value, "PostgreSQL identifier").replaceAll('"', '""')}"`;
}

export function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function postgresConfiguration() {
  const passwordFile = environmentPath("TIMESERIES_ADMIN_PASSWORD_FILE", "/app/runtime/admin/password");
  if (!existsSync(passwordFile) || !statSync(passwordFile).isFile()) throw new Error("TimescaleDB admin password file is missing");
  const password = readFileSync(passwordFile, "utf8").trim();
  if (!password) throw new Error("TimescaleDB admin password file is empty");
  return {
    host: process.env.TIMESERIES_HOST ?? "timescaledb",
    port: String(Number(process.env.TIMESERIES_PORT ?? 5432)),
    database: safeIdentifier(process.env.TIMESERIES_DATABASE ?? "stuga", "TimescaleDB database"),
    adminUser: safeIdentifier(process.env.TIMESERIES_ADMIN_USER ?? "stuga_admin", "TimescaleDB admin user"),
    environment: { ...process.env, PGPASSWORD: password },
  };
}

export function run(executable, arguments_, environment = process.env) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, arguments_, {
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) accept(stdout);
      else reject(new Error(`${executable} exited with ${code}: ${stderr.trim().slice(0, 2_000)}`));
    });
  });
}

export function postgresConnection(configuration, database) {
  return ["-h", configuration.host, "-p", configuration.port, "-U", configuration.adminUser, "-d", database];
}

export async function psql(configuration, database, sql) {
  return run("psql", [...postgresConnection(configuration, database), "-X", "-v", "ON_ERROR_STOP=1", "-c", sql], configuration.environment);
}

export async function currentDatabaseBytes(configuration) {
  const output = await run("psql", [
    ...postgresConnection(configuration, configuration.database),
    "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1",
    "-c", "SELECT pg_database_size(current_database())::bigint;",
  ], configuration.environment);
  const bytes = Number(output.trim());
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Target returned an invalid database size");
  return bytes;
}

export async function databaseExists(configuration, database) {
  const output = await psql(configuration, "postgres", `SELECT 1 FROM pg_database WHERE datname = ${sqlLiteral(database)};`);
  return /\b1\b/u.test(output);
}

export async function dropDatabase(configuration, database) {
  if (!await databaseExists(configuration, database)) return;
  await run("dropdb", [
    "-h", configuration.host, "-p", configuration.port, "-U", configuration.adminUser,
    "--force", database,
  ], configuration.environment);
}

export function validateStugubyIdentity(backupDirectory, record) {
  const identityPath = resolve(backupDirectory, assertSafeRelativePath(record?.path, "Stuguby identity path"));
  if (!pathWithin(backupDirectory, identityPath) || !existsSync(identityPath)) {
    throw new Error("Live migration Stuguby identity artifact is missing");
  }
  const details = lstatSync(identityPath);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error("Live migration Stuguby identity artifact is not a private regular file");
  }
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new Error("Live migration Stuguby identity artifact permissions are not private");
  }
  let identity;
  try {
    identity = JSON.parse(readFileSync(identityPath, "utf8"));
  } catch {
    throw new Error("Live migration Stuguby identity artifact is not valid JSON");
  }
  if (identity?.version !== 1
    || typeof identity.nodeId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(identity.nodeId)
    || typeof identity.displayName !== "string"
    || !identity.displayName.trim()
    || typeof identity.publicKey !== "string"
    || typeof identity.privateKey !== "string"
    || typeof identity.createdAt !== "string"
    || !Number.isFinite(Date.parse(identity.createdAt))) {
    throw new Error("Live migration Stuguby identity artifact has invalid fields");
  }
  try {
    const privateBytes = Buffer.from(identity.privateKey, "base64");
    const publicBytes = Buffer.from(identity.publicKey, "base64");
    if (privateBytes.toString("base64") !== identity.privateKey || publicBytes.toString("base64") !== identity.publicKey) {
      throw new Error("non-canonical key encoding");
    }
    const privateKey = createPrivateKey({ key: privateBytes, format: "der", type: "pkcs8" });
    const publicKey = createPublicKey({ key: publicBytes, format: "der", type: "spki" });
    if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("unsupported key type");
    }
    const derivedPublic = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
    if (derivedPublic !== identity.publicKey) throw new Error("key pair mismatch");
  } catch {
    throw new Error("Live migration Stuguby identity key pair is invalid");
  }
  return identity;
}

export function completeBackupManifest(backupDirectory, sourceVersion = "0.5.0") {
  const manifest = readJson(join(backupDirectory, "manifest.json"), "staged backup manifest");
  const category = (name) => manifest.files?.find((file) => file.category === name);
  if (!category("core-sqlite")) throw new Error("Live migration backup has no core SQLite snapshot");
  if (!category("integration-secrets")) throw new Error("Live migration backup has no integration secrets");
  if (!category("timescale-pgdump")) throw new Error("Live migration backup has no TimescaleDB dump");
  const identityRecord = category("stuguby-identity");
  if (compareReleaseVersions(sourceVersion, "0.5.0") >= 0 && !identityRecord) {
    throw new Error("Live migration backup has no Stuguby node identity");
  }
  if (identityRecord) validateStugubyIdentity(backupDirectory, identityRecord);
  if (manifest.sources?.timescale?.scope !== "full-database") throw new Error("Live migration requires a full-database TimescaleDB dump");
  return manifest;
}

export async function createCandidateDatabase(paths, plan, manifest, receipt) {
  const configuration = postgresConfiguration();
  const compactId = paths.id.replaceAll("-", "").slice(0, 16);
  const candidate = safeIdentifier(`stuga_incoming_${compactId}`, "Candidate database");
  const rollback = safeIdentifier(`stuga_before_${compactId}`, "Rollback database");
  if (await databaseExists(configuration, candidate) || await databaseExists(configuration, rollback)) {
    throw new Error("A database from this migration already exists; roll back or inspect it before retrying");
  }
  const restore = manifest.sources.timescale.restore;
  const schema = safeIdentifier(manifest.sources.timescale.telemetrySchema ?? "telemetry", "Telemetry schema");
  const applicationRole = safeIdentifier(restore.applicationRole ?? "stuga_app", "Application role");
  const adminRole = safeIdentifier(restore.adminRole ?? "stuga_admin", "Admin role");
  const missingRoles = await psql(configuration, "postgres", `
    SELECT role_name FROM (VALUES (${sqlLiteral(applicationRole)}), (${sqlLiteral(adminRole)})) AS required(role_name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = required.role_name);
  `);
  if (missingRoles.trim().split(/\r?\n/u).some((line) => line.trim() === applicationRole || line.trim() === adminRole)) {
    throw new Error("Target is missing an owner role required by the backup");
  }
  await run("createdb", [
    "-h", configuration.host, "-p", configuration.port, "-U", configuration.adminUser,
    "-T", "template0", "-O", configuration.adminUser, candidate,
  ], configuration.environment);
  receipt.candidateDatabase = candidate;
  receipt.rollbackDatabase = rollback;
  receipt.targetDatabase = configuration.database;
  atomicJson(paths.receipt, receipt);
  const dumpRecord = manifest.files.find((file) => file.category === "timescale-pgdump");
  const dump = resolve(paths.staged, "backup", assertSafeRelativePath(dumpRecord.path));
  try {
    await psql(configuration, candidate, `CREATE EXTENSION IF NOT EXISTS timescaledb; ${timescalePreRestoreSql(schema)}`);
    await run("pg_restore", [
      "-h", configuration.host, "-p", configuration.port, "-U", configuration.adminUser,
      "--exit-on-error", "--no-privileges", "--no-tablespaces", "--dbname", candidate, dump,
    ], configuration.environment);
    await psql(configuration, candidate, "SELECT timescaledb_post_restore(); ANALYZE;");
    await psql(configuration, candidate, timescaleOwnershipValidationSql(schema, applicationRole));
    receipt.candidateReady = true;
    atomicJson(paths.receipt, receipt);
  } catch (error) {
    await dropDatabase(configuration, candidate).catch(() => {});
    throw error;
  }
  return configuration;
}
