#!/usr/bin/env node

import { spawn } from "node:child_process";
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
} from "./stuga-migration-bundle.mjs";
import {
  assertMigrationId,
  assertReleaseVersion,
  assertSafeRelativePath,
  compareReleaseVersions,
  isSha256,
  mergePortableEnvironment,
  pathWithin,
  sha256Text,
} from "./stuga-migration-common.mjs";
import {
  timescaleOwnershipValidationSql,
  timescalePreRestoreSql,
  verifyBackup,
} from "./stuga-backup.mjs";
import { hardenPrivateDirectory, hardenPrivateFile } from "./sqlite-snapshot-utils.mjs";

const TARGET_SCRIPT_VERSION = 1;
const REQUIRED_FREE_HEADROOM = 512 * 1024 * 1024;

function environmentPath(name, fallback) {
  return resolve(process.env[name] ?? fallback);
}

function migrationPaths(id) {
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

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", flush: true, mode: 0o600 });
  hardenPrivateFile(temporary);
  renameSync(temporary, path);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function loadPlan(id, expectedSha256) {
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

function installedVersion() {
  const configured = process.env.STUGA_TARGET_VERSION;
  if (configured) return assertReleaseVersion(configured, "Target version");
  const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return assertReleaseVersion(readJson(packagePath, "package version").version, "Target version");
}

function freeBytes(path) {
  const stats = statfsSync(path, { bigint: true });
  return Number(stats.bavail * stats.bsize);
}

function ensureDirectories() {
  const root = environmentPath("STUGA_MIGRATION_ROOT", "/app/migrations");
  const data = environmentPath("STUGA_TARGET_DATA_DIRECTORY", "/app/data");
  for (const directory of [root, data, join(root, "incoming"), join(root, "chunks"), join(root, "staged"), join(root, "receipts"), join(root, "rollback")]) {
    hardenPrivateDirectory(directory);
  }
  return { root, data };
}

function safeIdentifier(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/u.test(value)) throw new Error(`${label} is not a safe PostgreSQL identifier`);
  return value;
}

function sqlIdentifier(value) {
  return `"${safeIdentifier(value, "PostgreSQL identifier").replaceAll('"', '""')}"`;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function postgresConfiguration() {
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

function run(executable, arguments_, environment = process.env) {
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

function postgresConnection(configuration, database) {
  return ["-h", configuration.host, "-p", configuration.port, "-U", configuration.adminUser, "-d", database];
}

async function psql(configuration, database, sql) {
  return run("psql", [...postgresConnection(configuration, database), "-X", "-v", "ON_ERROR_STOP=1", "-c", sql], configuration.environment);
}

async function databaseExists(configuration, database) {
  const output = await psql(configuration, "postgres", `SELECT 1 FROM pg_database WHERE datname = ${sqlLiteral(database)};`);
  return /\b1\b/u.test(output);
}

async function dropDatabase(configuration, database) {
  if (!await databaseExists(configuration, database)) return;
  await run("dropdb", [
    "-h", configuration.host, "-p", configuration.port, "-U", configuration.adminUser,
    "--force", database,
  ], configuration.environment);
}

function completeBackupManifest(backupDirectory) {
  const manifest = readJson(join(backupDirectory, "manifest.json"), "staged backup manifest");
  const category = (name) => manifest.files?.find((file) => file.category === name);
  if (!category("core-sqlite")) throw new Error("Live migration backup has no core SQLite snapshot");
  if (!category("integration-secrets")) throw new Error("Live migration backup has no integration secrets");
  if (!category("timescale-pgdump")) throw new Error("Live migration backup has no TimescaleDB dump");
  if (manifest.sources?.timescale?.scope !== "full-database") throw new Error("Live migration requires a full-database TimescaleDB dump");
  return manifest;
}

async function createCandidateDatabase(paths, plan, manifest, receipt) {
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

function fsyncFile(path) {
  const descriptor = openSync(path, "r+");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function copyVerified(source, destination, mode = 0o600) {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
  chmodSync(destination, mode);
  fsyncFile(destination);
}

function ensureNoSymlinkParents(root, candidate) {
  if (!pathWithin(root, candidate)) throw new Error(`Target path escaped its root: ${candidate}`);
  const pathFromRoot = relative(root, candidate);
  let current = resolve(root);
  for (const segment of pathFromRoot.split(sep).slice(0, -1)) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Target path contains a symbolic link: ${current}`);
  }
}

function prepareDataSwap(paths, manifest, receipt) {
  const data = environmentPath("STUGA_TARGET_DATA_DIRECTORY", "/app/data");
  const stage = join(data, `.stuga-migration-stage-${paths.id}`);
  const rollback = join(data, `.stuga-migration-rollback-${paths.id}`);
  if (existsSync(stage) || existsSync(rollback)) throw new Error("Target data contains state from this migration already");
  mkdirSync(stage, { mode: 0o700 });
  mkdirSync(rollback, { mode: 0o700 });
  const category = (name) => manifest.files.find((file) => file.category === name);
  const copyCategory = (name, targetName) => {
    const record = category(name);
    if (!record) return false;
    copyVerified(resolve(paths.staged, "backup", assertSafeRelativePath(record.path)), join(stage, targetName));
    return true;
  };
  copyCategory("core-sqlite", "climate-twin.sqlite");
  copyCategory("spatial-sqlite", "experimental-spatial-layers.sqlite");
  copyCategory("integration-secrets", "integration-secrets.json");
  const stagedAssets = join(stage, "assets");
  mkdirSync(stagedAssets, { mode: 0o700 });
  for (const record of manifest.files.filter((file) => file.category === "asset")) {
    const sourceRelative = assertSafeRelativePath(record.path);
    if (!sourceRelative.startsWith("assets/")) throw new Error("Backup asset path is outside the assets directory");
    const child = assertSafeRelativePath(sourceRelative.slice("assets/".length));
    copyVerified(resolve(paths.staged, "backup", sourceRelative), resolve(stagedAssets, child));
  }
  receipt.data = {
    data,
    stage,
    rollback,
    targets: [
      "climate-twin.sqlite",
      "climate-twin.sqlite-wal",
      "climate-twin.sqlite-shm",
      "integration-secrets.json",
      "assets",
      "experimental-spatial-layers.sqlite",
      "experimental-spatial-layers.sqlite-wal",
      "experimental-spatial-layers.sqlite-shm",
    ],
    originals: {},
    processed: [],
  };
  atomicJson(paths.receipt, receipt);
  return { data, stage, rollback };
}

function swapData(paths, receipt) {
  const { data, stage, rollback } = receipt.data;
  for (const name of receipt.data.targets) {
    const live = join(data, name);
    const old = join(rollback, name);
    const staged = join(stage, name);
    receipt.data.originals[name] = existsSync(live);
    if (existsSync(live)) renameSync(live, old);
    receipt.data.processed.push(name);
    atomicJson(paths.receipt, receipt);
    if (existsSync(staged)) renameSync(staged, live);
    atomicJson(paths.receipt, receipt);
  }
  receipt.dataSwapped = true;
  atomicJson(paths.receipt, receipt);
}

function targetForDeploymentPath(logicalPath) {
  if (logicalPath === "deployment/settings.env") {
    return { kind: "environment", relativePath: "stuga.env", root: dirname(environmentPath("STUGA_TARGET_ENV_FILE", "/app/target-settings/stuga.env")), path: environmentPath("STUGA_TARGET_ENV_FILE", "/app/target-settings/stuga.env") };
  }
  if (logicalPath.startsWith("deployment/config/")) {
    const child = assertSafeRelativePath(logicalPath.slice("deployment/config/".length));
    const root = environmentPath("STUGA_TARGET_CONFIG_DIRECTORY", "/app/target-settings/config");
    return { kind: "config", relativePath: child, root, path: resolve(root, child) };
  }
  if (logicalPath.startsWith("deployment/secrets/")) {
    const child = assertSafeRelativePath(logicalPath.slice("deployment/secrets/".length));
    const allowed = ["cloudflare/", "tapo-history-api/", "tapo-history-runner/"];
    if (!allowed.some((prefix) => child.startsWith(prefix))) throw new Error(`Unsupported deployment secret path: ${logicalPath}`);
    const root = environmentPath("STUGA_TARGET_SECRETS_DIRECTORY", "/app/target-settings/secrets");
    return { kind: "secret", relativePath: child, root, path: resolve(root, child) };
  }
  throw new Error(`Unsupported deployment path: ${logicalPath}`);
}

function applyDeploymentSettings(paths, plan, receipt) {
  const deploymentFiles = plan.files.filter((file) => file.path.startsWith("deployment/"));
  receipt.settings = [];
  for (const file of deploymentFiles) {
    const target = targetForDeploymentPath(file.path);
    ensureNoSymlinkParents(target.root, target.path);
    const rollbackName = `${receipt.settings.length.toString().padStart(5, "0")}.bin`;
    const rollbackPath = join(paths.settingsRollback, rollbackName);
    const existed = existsSync(target.path);
    if (existed) {
      const details = lstatSync(target.path);
      if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Migration target is not a regular file: ${target.path}`);
      copyVerified(target.path, rollbackPath);
    }
    const settingsRecord = { kind: target.kind, relativePath: target.relativePath, existed, rollbackName };
    receipt.settings.push(settingsRecord);
    atomicJson(paths.receipt, receipt);
    const source = resolve(paths.staged, file.path);
    mkdirSync(dirname(target.path), { recursive: true, mode: 0o700 });
    if (target.kind === "environment") {
      const current = existed ? readFileSync(target.path, "utf8") : "";
      writeFileSync(target.path, mergePortableEnvironment(current, readFileSync(source, "utf8")), { encoding: "utf8", flush: true, mode: 0o600 });
      chmodSync(target.path, 0o600);
    } else {
      copyVerified(source, target.path);
    }
    atomicJson(paths.receipt, receipt);
  }
  receipt.settingsApplied = true;
  atomicJson(paths.receipt, receipt);
}

function deploymentTargetFromReceipt(record) {
  if (record.kind === "environment" && record.relativePath === "stuga.env") return targetForDeploymentPath("deployment/settings.env").path;
  if (record.kind === "config") return targetForDeploymentPath(`deployment/config/${assertSafeRelativePath(record.relativePath)}`).path;
  if (record.kind === "secret") return targetForDeploymentPath(`deployment/secrets/${assertSafeRelativePath(record.relativePath)}`).path;
  throw new Error("Migration receipt has an unsafe settings record");
}

async function swapDatabases(configuration, paths, receipt) {
  const target = safeIdentifier(receipt.targetDatabase, "Target database");
  const candidate = safeIdentifier(receipt.candidateDatabase, "Candidate database");
  const rollback = safeIdentifier(receipt.rollbackDatabase, "Rollback database");
  receipt.databaseSwapStarted = true;
  atomicJson(paths.receipt, receipt);
  await psql(configuration, "postgres", `ALTER DATABASE ${sqlIdentifier(target)} WITH ALLOW_CONNECTIONS false;`);
  await psql(configuration, "postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN (${sqlLiteral(target)}, ${sqlLiteral(candidate)}) AND pid <> pg_backend_pid();`);
  await psql(configuration, "postgres", `ALTER DATABASE ${sqlIdentifier(target)} RENAME TO ${sqlIdentifier(rollback)};`);
  try {
    await psql(configuration, "postgres", `ALTER DATABASE ${sqlIdentifier(candidate)} RENAME TO ${sqlIdentifier(target)};`);
  } catch (error) {
    await psql(configuration, "postgres", `ALTER DATABASE ${sqlIdentifier(rollback)} RENAME TO ${sqlIdentifier(target)};`).catch(() => {});
    await psql(configuration, "postgres", `ALTER DATABASE ${sqlIdentifier(target)} WITH ALLOW_CONNECTIONS true;`).catch(() => {});
    throw error;
  }
  receipt.databaseSwapped = true;
  atomicJson(paths.receipt, receipt);
}

async function rollbackMigration(id, { automatic = false } = {}) {
  const paths = migrationPaths(id);
  if (!existsSync(paths.receipt)) throw new Error("Migration receipt does not exist");
  const receipt = readJson(paths.receipt, "migration receipt");
  if (receipt.status === "committed" && automatic) throw new Error("A committed migration cannot be rolled back automatically");
  const configuration = postgresConfiguration();
  if (receipt.databaseSwapped) {
    const target = safeIdentifier(receipt.targetDatabase, "Target database");
    const rollback = safeIdentifier(receipt.rollbackDatabase, "Rollback database");
    const failed = safeIdentifier(`stuga_failed_${paths.id.replaceAll("-", "").slice(0, 16)}`, "Failed database");
    await dropDatabase(configuration, failed);
    await psql(configuration, "postgres", `ALTER DATABASE ${sqlIdentifier(target)} WITH ALLOW_CONNECTIONS false;`);
    await psql(configuration, "postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN (${sqlLiteral(target)}, ${sqlLiteral(rollback)}) AND pid <> pg_backend_pid();`);
    await psql(configuration, "postgres", `ALTER DATABASE ${sqlIdentifier(target)} RENAME TO ${sqlIdentifier(failed)};`);
    await psql(configuration, "postgres", `ALTER DATABASE ${sqlIdentifier(rollback)} RENAME TO ${sqlIdentifier(target)};`);
    await psql(configuration, "postgres", `ALTER DATABASE ${sqlIdentifier(target)} WITH ALLOW_CONNECTIONS true;`);
    receipt.databaseSwapped = false;
  } else if (receipt.candidateDatabase) {
    await dropDatabase(configuration, safeIdentifier(receipt.candidateDatabase, "Candidate database"));
    if (receipt.databaseSwapStarted) {
      const target = safeIdentifier(receipt.targetDatabase, "Target database");
      const rollback = safeIdentifier(receipt.rollbackDatabase, "Rollback database");
      if (!await databaseExists(configuration, target) && await databaseExists(configuration, rollback)) {
        await psql(configuration, "postgres", `ALTER DATABASE ${sqlIdentifier(rollback)} RENAME TO ${sqlIdentifier(target)};`);
      }
      if (await databaseExists(configuration, target)) {
        await psql(configuration, "postgres", `ALTER DATABASE ${sqlIdentifier(target)} WITH ALLOW_CONNECTIONS true;`);
      }
    }
  }
  if (receipt.data) {
    for (const name of [...(receipt.data.processed ?? [])].reverse()) {
      const live = join(receipt.data.data, name);
      const old = join(receipt.data.rollback, name);
      if (existsSync(live)) rmSync(live, { recursive: true, force: true });
      if (receipt.data.originals[name] && existsSync(old)) renameSync(old, live);
    }
    receipt.dataSwapped = false;
  }
  for (const record of [...(receipt.settings ?? [])].reverse()) {
    const target = deploymentTargetFromReceipt(record);
    const backup = join(paths.settingsRollback, record.rollbackName);
    if (record.existed) copyVerified(backup, target);
    else rmSync(target, { force: true });
  }
  receipt.settingsApplied = false;
  receipt.status = "rolled-back";
  receipt.rolledBackAt = new Date().toISOString();
  atomicJson(paths.receipt, receipt);
  return receipt;
}

async function applyMigration(id, expectedSha256) {
  const loaded = loadPlan(id, expectedSha256);
  const { paths, plan } = loaded;
  if (plan.phase !== "cutover") throw new Error("Only a cutover migration can be applied");
  const targetVersion = installedVersion();
  if (compareReleaseVersions(plan.sourceVersion, targetVersion) > 0) {
    throw new Error(`Source Stuga ${plan.sourceVersion} is newer than target ${targetVersion}`);
  }
  const markerPath = join(paths.staged, ".stuga-assembled.json");
  if (!existsSync(markerPath)) throw new Error("Migration has not been assembled and verified");
  const marker = readJson(markerPath, "assembly marker");
  if (marker.planSha256 !== expectedSha256 || marker.backupVerified !== true) throw new Error("Migration assembly marker does not match the requested plan");
  if (existsSync(paths.receipt)) throw new Error("This migration already has an apply receipt");
  const available = freeBytes(environmentPath("STUGA_TARGET_DATA_DIRECTORY", "/app/data"));
  if (available < plan.totalBytes + REQUIRED_FREE_HEADROOM) throw new Error("Target does not have enough free space for migration staging and rollback");
  const backupDirectory = join(paths.staged, "backup");
  await verifyBackup(backupDirectory);
  const manifest = completeBackupManifest(backupDirectory);
  const receipt = {
    format: "stuga-migration-receipt",
    version: 1,
    migrationId: paths.id,
    planSha256: expectedSha256,
    sourceVersion: plan.sourceVersion,
    targetVersion,
    status: "applying",
    startedAt: new Date().toISOString(),
    candidateReady: false,
    databaseSwapStarted: false,
    databaseSwapped: false,
    dataSwapped: false,
    settingsApplied: false,
  };
  atomicJson(paths.receipt, receipt);
  try {
    const configuration = await createCandidateDatabase(paths, plan, manifest, receipt);
    prepareDataSwap(paths, manifest, receipt);
    swapData(paths, receipt);
    applyDeploymentSettings(paths, plan, receipt);
    await swapDatabases(configuration, paths, receipt);
    receipt.status = "applied-pending-health-check";
    receipt.appliedAt = new Date().toISOString();
    atomicJson(paths.receipt, receipt);
    return receipt;
  } catch (error) {
    const applyMessage = error instanceof Error ? error.message : String(error);
    try {
      await rollbackMigration(paths.id, { automatic: true });
    } catch (rollbackError) {
      throw new Error(`Migration apply failed (${applyMessage}) and automatic rollback also failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`);
    }
    throw new Error(`Migration apply failed and was rolled back: ${applyMessage}`);
  }
}

async function assembleCommand(id, expectedSha256) {
  const { paths, plan, planSha256 } = loadPlan(id, expectedSha256);
  const missing = await missingMigrationChunks(plan, paths.chunks);
  if (missing.length > 0) throw new Error(`Migration is missing ${missing.length} chunk(s)`);
  const markerPath = join(paths.staged, ".stuga-assembled.json");
  if (existsSync(paths.staged)) {
    const marker = existsSync(markerPath) ? readJson(markerPath, "assembly marker") : null;
    if (marker && (marker.planSha256 !== planSha256 || marker.backupVerified !== true)) {
      throw new Error("An unrecognized staging directory already exists for this migration");
    }
    if (marker) {
      await verifyBackup(join(paths.staged, "backup"));
      return { reused: true, files: plan.files.length, totalBytes: plan.totalBytes };
    }
    rmSync(paths.staged, { recursive: true, force: true });
  }
  const result = await assembleMigrationBundle({ plan, chunkDirectory: paths.chunks, outputDirectory: paths.staged });
  await verifyBackup(join(paths.staged, "backup"));
  completeBackupManifest(join(paths.staged, "backup"));
  atomicJson(markerPath, { version: 1, planSha256, backupVerified: true, verifiedAt: new Date().toISOString() });
  return { ...result, reused: false };
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  ensureDirectories();
  if (command === "preflight") {
    const root = environmentPath("STUGA_MIGRATION_ROOT", "/app/migrations");
    const data = environmentPath("STUGA_TARGET_DATA_DIRECTORY", "/app/data");
    const hostRoot = process.env.STUGA_MIGRATION_HOST_ROOT ?? "/persistent/stuga/migrations";
    if (!/^\/[A-Za-z0-9._/-]+$/u.test(hostRoot) || hostRoot.split("/").some((part) => part === "..")) {
      throw new Error("STUGA_MIGRATION_HOST_ROOT must be a safe absolute target path");
    }
    return {
      format: "stuga-migration-preflight",
      version: TARGET_SCRIPT_VERSION,
      targetVersion: installedVersion(),
      migrationFreeBytes: freeBytes(root),
      dataFreeBytes: freeBytes(data),
      incomingDirectory: `${hostRoot.replace(/\/$/u, "")}/incoming`,
      chunkDirectory: `${hostRoot.replace(/\/$/u, "")}/chunks`,
    };
  }
  const id = assertMigrationId(argv[1]);
  if (command === "status") {
    const paths = migrationPaths(id);
    const receipt = existsSync(paths.receipt) ? readJson(paths.receipt, "migration receipt") : null;
    return {
      migrationId: id,
      receipt,
      planPresent: existsSync(paths.plan),
      staged: existsSync(join(paths.staged, ".stuga-assembled.json")),
    };
  }
  if (command === "missing") {
    const { paths, plan } = loadPlan(id, argv[2]);
    const missing = await missingMigrationChunks(plan, paths.chunks);
    return { migrationId: id, missing, missingBytes: [...new Map(plan.files.flatMap((file) => file.chunks.map((chunk) => [chunk.sha256, chunk.size])))]
      .filter(([digest]) => missing.includes(digest)).reduce((total, [, size]) => total + size, 0) };
  }
  if (command === "assemble") return assembleCommand(id, argv[2]);
  if (command === "apply") return applyMigration(id, argv[2]);
  if (command === "rollback") return rollbackMigration(id);
  if (command === "commit") {
    const paths = migrationPaths(id);
    const receipt = readJson(paths.receipt, "migration receipt");
    if (receipt.status !== "applied-pending-health-check") throw new Error("Only a health-checked pending migration can be committed");
    receipt.status = "committed";
    receipt.committedAt = new Date().toISOString();
    atomicJson(paths.receipt, receipt);
    return receipt;
  }
  throw new Error("Usage: stuga-migration-target.mjs <preflight|status|missing|assemble|apply|rollback|commit> [migration-id] [plan-sha256]");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`Migration target failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export {
  applyDeploymentSettings,
  completeBackupManifest,
  installedVersion,
  main as runMigrationTarget,
  safeIdentifier,
  targetForDeploymentPath,
};
