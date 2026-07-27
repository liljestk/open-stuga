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

import { assertRestoreCapacity, atomicJson, completeBackupManifest, createCandidateDatabase, databaseExists, dropDatabase, durableRemove, durableRename, environmentPath, installedVersion, loadPlan, migrationPaths, postgresConfiguration, psql, readJson, safeIdentifier, sqlIdentifier, sqlLiteral } from "./storage-preflight.mjs";

import { applyDeploymentSettings, copyVerified, deploymentTargetFromReceipt, prepareDataSwap, swapData, swapDatabases } from "./data-deployment.mjs";

export async function rollbackMigration(id, { automatic = false } = {}) {
  const paths = migrationPaths(id);
  if (!existsSync(paths.receipt)) throw new Error("Migration receipt does not exist");
  const receipt = readJson(paths.receipt, "migration receipt");
  if (receipt.status === "rolled-back") return receipt;
  if (receipt.status === "committed") throw new Error("A committed migration cannot be rolled back");
  receipt.status = "rolling-back";
  atomicJson(paths.receipt, receipt);
  if (receipt.candidateDatabase || receipt.databaseSwapStarted) {
    const configuration = postgresConfiguration();
    const target = safeIdentifier(receipt.targetDatabase, "Target database");
    const candidate = safeIdentifier(receipt.candidateDatabase, "Candidate database");
    const rollback = safeIdentifier(receipt.rollbackDatabase, "Rollback database");
    const failed = safeIdentifier(`stuga_failed_${paths.id.replaceAll("-", "").slice(0, 16)}`, "Failed database");
    receipt.databaseRollbackPhase = "inspecting";
    atomicJson(paths.receipt, receipt);
    let targetExists = await databaseExists(configuration, target);
    let candidateExists = await databaseExists(configuration, candidate);
    let rollbackExists = await databaseExists(configuration, rollback);
    if (rollbackExists && targetExists) {
      receipt.databaseRollbackPhase = "removing-migrated-target";
      atomicJson(paths.receipt, receipt);
      await dropDatabase(configuration, failed);
      await psql(configuration, "postgres", `ALTER DATABASE ${sqlIdentifier(target)} WITH ALLOW_CONNECTIONS false;`);
      await psql(configuration, "postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${sqlLiteral(target)} AND pid <> pg_backend_pid();`);
      await psql(configuration, "postgres", `ALTER DATABASE ${sqlIdentifier(target)} RENAME TO ${sqlIdentifier(failed)};`);
      targetExists = false;
    }
    if (candidateExists) {
      receipt.databaseRollbackPhase = "dropping-candidate";
      atomicJson(paths.receipt, receipt);
      await dropDatabase(configuration, candidate);
      candidateExists = false;
    }
    rollbackExists = await databaseExists(configuration, rollback);
    targetExists = await databaseExists(configuration, target);
    receipt.databaseRollbackPhase = "restoring-old";
    atomicJson(paths.receipt, receipt);
    if (!targetExists && rollbackExists) {
      await psql(configuration, "postgres", `ALTER DATABASE ${sqlIdentifier(rollback)} RENAME TO ${sqlIdentifier(target)};`);
      targetExists = true;
    }
    if (targetExists) {
      await psql(configuration, "postgres", `ALTER DATABASE ${sqlIdentifier(target)} WITH ALLOW_CONNECTIONS true;`);
    } else if (receipt.databaseSwapStarted) {
      throw new Error("Migration rollback could not locate the original target database");
    }
    receipt.databaseSwapped = false;
    receipt.databasePhase = "rolled-back";
    receipt.databaseRollbackPhase = "complete";
    atomicJson(paths.receipt, receipt);
  }
  if (receipt.data) {
    const legacyItems = Object.fromEntries((receipt.data.processed ?? []).map((name) => [name, {
      original: receipt.data.originals?.[name] === true,
      staged: true,
      phase: "installed",
    }]));
    receipt.data.items ??= legacyItems;
    for (const name of [...Object.keys(receipt.data.items)].reverse()) {
      const item = receipt.data.items[name];
      if (item.phase === "rolled-back") continue;
      const live = join(receipt.data.data, name);
      const old = join(receipt.data.rollback, name);
      const priorRollbackPhase = item.rollbackPhase;
      item.rollbackPhase = "removing-new";
      atomicJson(paths.receipt, receipt);
      if (existsSync(old) && existsSync(live)) durableRemove(live, { recursive: true, force: true });
      else if (!item.original && existsSync(live)) durableRemove(live, { recursive: true, force: true });
      item.rollbackPhase = "restoring-old";
      atomicJson(paths.receipt, receipt);
      if (item.original && existsSync(old)) {
        if (existsSync(live)) durableRemove(live, { recursive: true, force: true });
        durableRename(old, live);
      } else if (item.original && !existsSync(live)
        && priorRollbackPhase !== "restoring-old" && item.phase !== "prepared") {
        throw new Error(`Migration rollback is missing the original data path: ${name}`);
      }
      item.phase = "rolled-back";
      item.rollbackPhase = "complete";
      atomicJson(paths.receipt, receipt);
    }
    receipt.dataSwapped = false;
  }
  for (const record of [...(receipt.settings ?? [])].reverse()) {
    if (record.phase === "rolled-back") continue;
    const target = deploymentTargetFromReceipt(record);
    const backup = join(paths.settingsRollback, record.rollbackName);
    record.rollbackPhase = "restoring";
    atomicJson(paths.receipt, receipt);
    if (record.existed) {
      if (!existsSync(backup)) throw new Error(`Migration settings rollback is missing: ${record.relativePath}`);
      copyVerified(backup, target);
    } else durableRemove(target, { force: true });
    record.phase = "rolled-back";
    record.rollbackPhase = "complete";
    atomicJson(paths.receipt, receipt);
  }
  receipt.settingsApplied = false;
  receipt.status = "rolled-back";
  receipt.rolledBackAt = new Date().toISOString();
  atomicJson(paths.receipt, receipt);
  return receipt;
}

export async function createApplyIntent(id, expectedSha256) {
  const { paths, plan } = loadPlan(id, expectedSha256);
  if (plan.phase !== "cutover") throw new Error("Only a cutover migration can be applied");
  const targetVersion = installedVersion();
  if (compareReleaseVersions(plan.sourceVersion, targetVersion) > 0) {
    throw new Error(`Source Stugu ${plan.sourceVersion} is newer than target ${targetVersion}`);
  }
  const markerPath = join(paths.staged, ".stugu-assembled.json");
  if (!existsSync(markerPath)) throw new Error("Migration has not been assembled and verified");
  const marker = readJson(markerPath, "assembly marker");
  if (marker.planSha256 !== expectedSha256 || marker.backupVerified !== true) {
    throw new Error("Migration assembly marker does not match the requested plan");
  }
  await verifyAssembledMigrationBundle({ plan, outputDirectory: paths.staged });
  if (existsSync(paths.receipt)) {
    const existing = readJson(paths.receipt, "migration receipt");
    if (existing.planSha256 === expectedSha256 && existing.status === "apply-intent") return existing;
    throw new Error("This migration already has an apply receipt");
  }
  const receipt = {
    format: "stugu-migration-receipt",
    version: 1,
    migrationId: paths.id,
    planSha256: expectedSha256,
    sourceVersion: plan.sourceVersion,
    targetVersion,
    status: "apply-intent",
    intentAt: new Date().toISOString(),
    candidateReady: false,
    databaseSwapStarted: false,
    databaseSwapped: false,
    databasePhase: "not-started",
    dataSwapped: false,
    settingsApplied: false,
  };
  atomicJson(paths.receipt, receipt);
  return receipt;
}

export function commitMigration(id, healthVersion, healthyAt) {
  const paths = migrationPaths(id);
  const receipt = readJson(paths.receipt, "migration receipt");
  if (receipt.status !== "applied-pending-health-check") {
    throw new Error("Only a health-checked pending migration can be committed");
  }
  const version = assertReleaseVersion(healthVersion, "Healthy release version");
  const healthTime = Date.parse(healthyAt);
  const appliedTime = Date.parse(receipt.appliedAt);
  if (version !== receipt.targetVersion
    || !Number.isFinite(healthTime)
    || !Number.isFinite(appliedTime)
    || healthTime < appliedTime) {
    throw new Error("Migration health proof does not match the applied target release");
  }
  receipt.status = "committed";
  receipt.healthConfirmedAt = new Date(healthTime).toISOString();
  receipt.committedAt = new Date().toISOString();
  atomicJson(paths.receipt, receipt);
  return receipt;
}

export async function applyMigration(id, expectedSha256) {
  const loaded = loadPlan(id, expectedSha256);
  const { paths, plan } = loaded;
  if (plan.phase !== "cutover") throw new Error("Only a cutover migration can be applied");
  const targetVersion = installedVersion();
  if (compareReleaseVersions(plan.sourceVersion, targetVersion) > 0) {
    throw new Error(`Source Stugu ${plan.sourceVersion} is newer than target ${targetVersion}`);
  }
  const markerPath = join(paths.staged, ".stugu-assembled.json");
  if (!existsSync(markerPath)) throw new Error("Migration has not been assembled and verified");
  const marker = readJson(markerPath, "assembly marker");
  if (marker.planSha256 !== expectedSha256 || marker.backupVerified !== true) throw new Error("Migration assembly marker does not match the requested plan");
  if (!existsSync(paths.receipt)) throw new Error("Migration apply intent is missing");
  const receipt = readJson(paths.receipt, "migration receipt");
  if (receipt.planSha256 !== expectedSha256 || receipt.status !== "apply-intent") {
    throw new Error("Migration apply intent does not match this request");
  }
  assertRestoreCapacity(plan);
  const backupDirectory = join(paths.staged, "backup");
  await verifyAssembledMigrationBundle({ plan, outputDirectory: paths.staged });
  await verifyBackup(backupDirectory);
  const manifest = completeBackupManifest(backupDirectory, plan.sourceVersion);
  receipt.status = "applying";
  receipt.startedAt = new Date().toISOString();
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

export async function assembleCommand(id, expectedSha256) {
  const { paths, plan, planSha256 } = loadPlan(id, expectedSha256);
  const missing = await missingMigrationChunks(plan, paths.chunks);
  if (missing.length > 0) throw new Error(`Migration is missing ${missing.length} chunk(s)`);
  const markerPath = join(paths.staged, ".stugu-assembled.json");
  if (existsSync(paths.staged)) {
    const marker = existsSync(markerPath) ? readJson(markerPath, "assembly marker") : null;
    if (marker && (marker.planSha256 !== planSha256 || marker.backupVerified !== true)) {
      throw new Error("An unrecognized staging directory already exists for this migration");
    }
    if (marker) {
      await verifyAssembledMigrationBundle({ plan, outputDirectory: paths.staged });
      await verifyBackup(join(paths.staged, "backup"));
      return { reused: true, files: plan.files.length, totalBytes: plan.totalBytes };
    }
    rmSync(paths.staged, { recursive: true, force: true });
  }
  const result = await assembleMigrationBundle({ plan, chunkDirectory: paths.chunks, outputDirectory: paths.staged });
  await verifyAssembledMigrationBundle({ plan, outputDirectory: paths.staged });
  await verifyBackup(join(paths.staged, "backup"));
  completeBackupManifest(join(paths.staged, "backup"));
  atomicJson(markerPath, { version: 1, planSha256, backupVerified: true, verifiedAt: new Date().toISOString() });
  return { ...result, reused: false };
}

export function boundedEnvironmentInteger(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function garbageCollectMigrations() {
  const root = environmentPath("STUGA_MIGRATION_ROOT", "/app/migrations");
  const incoming = join(root, "incoming");
  const chunks = join(root, "chunks");
  const staged = join(root, "staged");
  const receipts = join(root, "receipts");
  const retentionDays = boundedEnvironmentInteger("STUGA_MIGRATION_SEED_RETENTION_DAYS", 14, 1, 365);
  const maxSeeds = boundedEnvironmentInteger("STUGA_MIGRATION_MAX_RETAINED_SEEDS", 4, 1, 32);
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1_000;
  const seeds = [];
  for (const entry of readdirSync(incoming, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/iu.test(entry.name)) continue;
    const path = join(incoming, entry.name);
    try {
      const plan = validateMigrationPlan(readJson(path, "migration plan"));
      if (plan.phase === "seed" && !existsSync(join(receipts, `${plan.id}.json`))) {
        seeds.push({ plan, path, created: Date.parse(plan.createdAt) || statSync(path).mtimeMs });
      }
    } catch {
      // Invalid incoming files are retained for operator inspection and never
      // become an excuse to delete chunks that another valid plan references.
    }
  }
  seeds.sort((left, right) => right.created - left.created);
  const removedPlans = new Set();
  for (const [index, seed] of seeds.entries()) {
    if (index < maxSeeds && seed.created >= cutoff) continue;
    durableRemove(join(staged, seed.plan.id), { recursive: true, force: true });
    durableRemove(seed.path, { force: true });
    removedPlans.add(seed.plan.id);
  }
  const referenced = new Set();
  for (const entry of readdirSync(incoming, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const plan = validateMigrationPlan(readJson(join(incoming, entry.name), "migration plan"));
      for (const file of plan.files) for (const chunk of file.chunks) referenced.add(chunk.sha256);
    } catch {
      // Preserve all chunks when an unrecognized plan remains.
      return { removedPlans: removedPlans.size, removedChunks: 0, skippedChunkGc: true };
    }
  }
  let removedChunks = 0;
  for (const entry of readdirSync(chunks, { withFileTypes: true })) {
    if (!entry.isFile() || !isSha256(entry.name) || referenced.has(entry.name)) continue;
    durableRemove(join(chunks, entry.name), { force: true });
    removedChunks += 1;
  }
  return { removedPlans: removedPlans.size, removedChunks, skippedChunkGc: false };
}
