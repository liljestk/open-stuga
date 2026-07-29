#!/usr/bin/env node

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
} from "./stugu-migration-bundle.mjs";

import {
  assertMigrationId,
  assertReleaseVersion,
  assertSafeRelativePath,
  compareReleaseVersions,
  isSha256,
  mergePortableEnvironment,
  pathWithin,
  sha256Text,
} from "./stugu-migration-common.mjs";

import {
  timescaleOwnershipValidationSql,
  timescalePreRestoreSql,
  verifyBackup,
} from "./stugu-backup.mjs";

import { hardenPrivateDirectory, hardenPrivateFile } from "./sqlite-snapshot-utils.mjs";

import { main } from "./stugu-migration-target/commands.mjs";

export { applyDeploymentSettings } from "./stugu-migration-target/data-deployment.mjs";

export { MAX_IN_PLACE_REPLACEMENT_BYTES } from "./stugu-migration-target/data-deployment.mjs";

export { replaceFileContents } from "./stugu-migration-target/data-deployment.mjs";

export { completeBackupManifest } from "./stugu-migration-target/storage-preflight.mjs";

export { commitMigration } from "./stugu-migration-target/migration-lifecycle.mjs";

export { createApplyIntent } from "./stugu-migration-target/migration-lifecycle.mjs";

export { garbageCollectMigrations } from "./stugu-migration-target/migration-lifecycle.mjs";

export { installedVersion } from "./stugu-migration-target/storage-preflight.mjs";

export { main as runMigrationTarget } from "./stugu-migration-target/commands.mjs";

export { rollbackMigration } from "./stugu-migration-target/migration-lifecycle.mjs";

export { safeIdentifier } from "./stugu-migration-target/storage-preflight.mjs";

export { swapData } from "./stugu-migration-target/data-deployment.mjs";

export { targetForDeploymentPath } from "./stugu-migration-target/data-deployment.mjs";

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;

if (invokedPath === import.meta.url) {
  main().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`Migration target failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
