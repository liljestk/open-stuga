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
  existingDiscoveredSecretDirectories,
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

import { backupFixture, sha256, temporaryDirectory } from "./live-migration-test-support.mjs";

test("auto-discovery omits optional secret roots that do not exist", (t) => {
  const root = temporaryDirectory(t);
  const cloudflare = join(root, "cloudflare");
  mkdirSync(cloudflare);
  assert.deepEqual(existingDiscoveredSecretDirectories({
    cloudflare,
    "tapo-history-runner": join(root, "missing-runner"),
  }), { cloudflare });
});

test("apply intent is durable, idempotent, and bound to a fully verified cutover plan", async (t) => {
  const root = temporaryDirectory(t);
  const migrationRoot = join(root, "migrations");
  const id = "419f8ada-fdc9-78e0-93e8-b63126fb1257";
  const previousRoot = process.env.STUGA_MIGRATION_ROOT;
  process.env.STUGA_MIGRATION_ROOT = migrationRoot;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.STUGA_MIGRATION_ROOT;
    else process.env.STUGA_MIGRATION_ROOT = previousRoot;
  });
  const bundle = await createMigrationBundle({
    backupDirectory: backupFixture(root),
    workspaceDirectory: join(root, "workspace"),
    phase: "cutover",
    sourceVersion: "0.5.0",
    chunkSize: 65_536,
    id,
  });
  mkdirSync(join(migrationRoot, "incoming"), { recursive: true });
  copyFileSync(bundle.planPath, join(migrationRoot, "incoming", `${id}.json`));
  const staged = join(migrationRoot, "staged", id);
  await assembleMigrationBundle({
    plan: bundle.plan,
    chunkDirectory: bundle.chunkDirectory,
    outputDirectory: staged,
  });
  writeFileSync(join(staged, ".stugu-assembled.json"), `${JSON.stringify({
    version: 1,
    planSha256: bundle.planSha256,
    backupVerified: true,
  })}\n`);

  const first = await createApplyIntent(id, bundle.planSha256);
  const second = await createApplyIntent(id, bundle.planSha256);
  assert.equal(first.status, "apply-intent");
  assert.equal(second.intentAt, first.intentAt);
  assert.equal(
    JSON.parse(readFileSync(join(migrationRoot, "receipts", `${id}.json`), "utf8")).status,
    "apply-intent",
  );

  writeFileSync(join(staged, "backup", "manifest.json"), "{}\n");
  await assert.rejects(createApplyIntent(id, bundle.planSha256), /checksum mismatch|invalid/u);
});

test("migration plans reject traversal and corrupt cached chunks", async (t) => {
  const root = temporaryDirectory(t);
  const bundle = await createMigrationBundle({
    backupDirectory: backupFixture(root),
    workspaceDirectory: join(root, "workspace"),
    phase: "cutover",
    sourceVersion: "0.5.0",
    chunkSize: 65_536,
    id: "119f8ada-fdc9-78e0-93e8-b63126fb1257",
  });
  const unsafe = structuredClone(bundle.plan);
  unsafe.files[0].path = "../escape";
  assert.throws(() => validateMigrationPlan(unsafe), /unsafe|relative/u);

  const digest = readdirSync(bundle.chunkDirectory)[0];
  writeFileSync(join(bundle.chunkDirectory, digest), "corrupt");
  assert.ok((await missingMigrationChunks(bundle.plan, bundle.chunkDirectory)).includes(digest));
});
