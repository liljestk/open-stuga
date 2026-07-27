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

import { TARGET_SCRIPT_VERSION, currentDatabaseBytes, directoryBytes, ensureDirectories, environmentPath, freeBytes, installedVersion, loadPlan, migrationPaths, postgresConfiguration, readJson, storageStats } from "./storage-preflight.mjs";

import { applyMigration, assembleCommand, commitMigration, createApplyIntent, garbageCollectMigrations, rollbackMigration } from "./migration-lifecycle.mjs";

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  ensureDirectories();
  if (command === "preflight") {
    const cleanup = garbageCollectMigrations();
    const root = environmentPath("STUGA_MIGRATION_ROOT", "/app/migrations");
    const data = environmentPath("STUGA_TARGET_DATA_DIRECTORY", "/app/data");
    const timeseries = environmentPath("STUGA_TARGET_TIMESERIES_DIRECTORY", "/app/timeseries-data");
    const hostRoot = process.env.STUGA_MIGRATION_HOST_ROOT ?? "/persistent/stugu/migrations";
    if (!/^\/[A-Za-z0-9._/-]+$/u.test(hostRoot) || hostRoot.split("/").some((part) => part === "..")) {
      throw new Error("STUGA_MIGRATION_HOST_ROOT must be a safe absolute target path");
    }
    const configuration = postgresConfiguration();
    const migrationStorage = storageStats(root, "Migration");
    const dataStorage = storageStats(data, "Application data");
    const timeseriesStorage = storageStats(timeseries, "TimescaleDB");
    return {
      format: "stugu-migration-preflight",
      version: TARGET_SCRIPT_VERSION,
      targetVersion: installedVersion(),
      migrationFreeBytes: migrationStorage.freeBytes,
      dataFreeBytes: dataStorage.freeBytes,
      timeseriesFreeBytes: timeseriesStorage.freeBytes,
      migrationDevice: migrationStorage.device,
      dataDevice: dataStorage.device,
      timeseriesDevice: timeseriesStorage.device,
      currentDataBytes: directoryBytes(data),
      currentDatabaseBytes: await currentDatabaseBytes(configuration),
      incomingDirectory: `${hostRoot.replace(/\/$/u, "")}/incoming`,
      chunkDirectory: `${hostRoot.replace(/\/$/u, "")}/chunks`,
      cleanup,
    };
  }
  if (command === "gc") return garbageCollectMigrations();
  const id = assertMigrationId(argv[1]);
  if (command === "status") {
    const paths = migrationPaths(id);
    const receipt = existsSync(paths.receipt) ? readJson(paths.receipt, "migration receipt") : null;
    return {
      migrationId: id,
      receipt,
      planPresent: existsSync(paths.plan),
      staged: existsSync(join(paths.staged, ".stugu-assembled.json")),
    };
  }
  if (command === "missing") {
    const { paths, plan } = loadPlan(id, argv[2]);
    const missing = await missingMigrationChunks(plan, paths.chunks);
    return { migrationId: id, missing, missingBytes: [...new Map(plan.files.flatMap((file) => file.chunks.map((chunk) => [chunk.sha256, chunk.size])))]
      .filter(([digest]) => missing.includes(digest)).reduce((total, [, size]) => total + size, 0) };
  }
  if (command === "assemble") return assembleCommand(id, argv[2]);
  if (command === "intent") return createApplyIntent(id, argv[2]);
  if (command === "apply") return applyMigration(id, argv[2]);
  if (command === "rollback") return rollbackMigration(id);
  if (command === "commit") return commitMigration(id, argv[2], argv[3]);
  throw new Error("Usage: stugu-migration-target.mjs <preflight|gc|status|missing|assemble|intent|apply|rollback|commit> [migration-id] [plan-sha256]");
}
