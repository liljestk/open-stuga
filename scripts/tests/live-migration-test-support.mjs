import assert from "node:assert/strict";

import { createHash, generateKeyPairSync } from "node:crypto";

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import test from "node:test";

import {
  assembleMigrationBundle,
  createMigrationBundle,
  missingMigrationChunks,
  validateMigrationPlan,
  verifyAssembledMigrationBundle,
} from "../stugu-migration-bundle.mjs";

import {
  compareReleaseVersions,
  mergePortableEnvironment,
  portableEnvironment,
} from "../stugu-migration-common.mjs";

import {
  assertRunningSourceVersion,
  assertTargetCapacity,
  effectiveSettingsFile,
  parseLiveMigrationArgs,
  safeSshTarget,
  stopSourceWriters,
  uploadMissingChunks,
} from "../stugu-live-migrate.mjs";

import {
  applyDeploymentSettings,
  commitMigration,
  completeBackupManifest,
  createApplyIntent,
  rollbackMigration,
  swapData,
  targetForDeploymentPath,
} from "../stugu-migration-target.mjs";

export function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "stugu-live-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function backupFixture(root) {
  const directory = join(root, "backup");
  mkdirSync(join(directory, "databases"), { recursive: true });
  const payload = Buffer.alloc(150_000, 0x61);
  writeFileSync(join(directory, "databases", "climate-twin.sqlite"), payload);
  const manifest = {
    format: "stugu-backup",
    version: 2,
    verification: { status: "passed" },
    files: [{
      path: "databases/climate-twin.sqlite",
      category: "core-sqlite",
      size: payload.length,
      sha256: sha256(payload),
      sensitive: true,
    }],
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(directory, "manifest.json"), manifestText);
  writeFileSync(join(directory, "manifest.sha256"), `${sha256(manifestText)}  manifest.json\n`);
  return directory;
}
