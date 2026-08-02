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
  assembleCommand,
  applyDeploymentSettings,
  commitMigration,
  completeBackupManifest,
  createApplyIntent,
  createTimescaleActivationBaseline,
  ensureTimescaleScheduler,
  ensurePendingTimescaleRecovery,
  evaluateTimescaleRecovery,
  finishTimescaleRestore,
  parseTimescaleRecoveryStatus,
  restartTimescaleBackgroundWorkers,
  rollbackMigration,
  prepareDataSwap,
  swapData,
  targetForDeploymentPath,
  telemetryArchiveRecoveryIsHealthy,
  TIMESCALE_RECOVERY_STATUS_SQL,
  timescaleRecoveryIsHealthy,
  waitForTelemetryArchiveRecovery,
  waitForTimescaleScheduler,
  waitForTimescaleRecovery,
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

test("assembly validates a complete v0.24 backup with the plan source version", async (t) => {
  const root = temporaryDirectory(t);
  const backup = backupFixture(root);
  const manifestPath = join(backup, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const keys = generateKeyPairSync("ed25519");
  const artifacts = [
    ["secrets/integration-secrets.json", "integration-secrets", '{"version":1}\n'],
    ["databases/telemetry.pgdump", "timescale-pgdump", "test-only-pgdump"],
    ["secrets/stuguby-identity.json", "stuguby-identity", JSON.stringify({
      version: 1,
      nodeId: "619f8ada-fdc9-78e0-93e8-b63126fb1257",
      displayName: "Home",
      publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      privateKey: keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      createdAt: "2026-07-31T00:00:00.000Z",
    })],
  ];
  mkdirSync(join(backup, "secrets"), { recursive: true });
  for (const [path, category, contents] of artifacts) {
    writeFileSync(join(backup, path), contents);
    const payload = Buffer.from(contents);
    manifest.files.push({
      path,
      category,
      size: payload.length,
      sha256: sha256(payload),
      sensitive: true,
    });
  }
  manifest.sourceVersion = "0.24.0";
  manifest.sources = {
    stugubyIdentity: { status: "included" },
    timescale: { scope: "full-database", logicalBytes: 1_000 },
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, manifestText);
  writeFileSync(join(backup, "manifest.sha256"), `${sha256(manifestText)}  manifest.json\n`);

  const id = "819f8ada-fdc9-78e0-93e8-b63126fb1257";
  const bundle = await createMigrationBundle({
    backupDirectory: backup,
    workspaceDirectory: join(root, "workspace"),
    phase: "cutover",
    sourceVersion: "0.24.0",
    chunkSize: 65_536,
    id,
  });
  const migrationRoot = join(root, "migrations");
  mkdirSync(join(migrationRoot, "incoming"), { recursive: true });
  mkdirSync(join(migrationRoot, "chunks"), { recursive: true });
  copyFileSync(bundle.planPath, join(migrationRoot, "incoming", `${id}.json`));
  for (const digest of readdirSync(bundle.chunkDirectory)) {
    copyFileSync(join(bundle.chunkDirectory, digest), join(migrationRoot, "chunks", digest));
  }
  const previousRoot = process.env.STUGA_MIGRATION_ROOT;
  process.env.STUGA_MIGRATION_ROOT = migrationRoot;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.STUGA_MIGRATION_ROOT;
    else process.env.STUGA_MIGRATION_ROOT = previousRoot;
  });
  let backupVerifications = 0;
  const options = {
    verifyBackupArtifact: async () => { backupVerifications += 1; },
  };
  assert.equal((await assembleCommand(id, bundle.planSha256, options)).reused, false);
  assert.equal((await assembleCommand(id, bundle.planSha256, options)).reused, true);
  assert.equal(backupVerifications, 2);
});

test("migration stages the tracking key atomically beside its encrypted SQLite records", async (t) => {
  const root = temporaryDirectory(t);
  const id = "919f8ada-fdc9-78e0-93e8-b63126fb1257";
  const migrationRoot = join(root, "migrations");
  const staged = join(migrationRoot, "staged", id);
  const data = join(root, "data");
  const receiptPath = join(migrationRoot, "receipts", `${id}.json`);
  mkdirSync(join(staged, "backup", "secrets"), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(staged, "backup", "secrets", "tracking-secret.key"), "new-tracking-key\n");
  writeFileSync(join(data, "tracking-secret.key"), "old-tracking-key\n");
  const previous = {
    migrationRoot: process.env.STUGA_MIGRATION_ROOT,
    data: process.env.STUGA_TARGET_DATA_DIRECTORY,
  };
  process.env.STUGA_MIGRATION_ROOT = migrationRoot;
  process.env.STUGA_TARGET_DATA_DIRECTORY = data;
  t.after(() => {
    if (previous.migrationRoot === undefined) delete process.env.STUGA_MIGRATION_ROOT;
    else process.env.STUGA_MIGRATION_ROOT = previous.migrationRoot;
    if (previous.data === undefined) delete process.env.STUGA_TARGET_DATA_DIRECTORY;
    else process.env.STUGA_TARGET_DATA_DIRECTORY = previous.data;
  });
  const paths = { id, staged, receipt: receiptPath };
  const receipt = { status: "applying", settings: [] };
  prepareDataSwap(paths, {
    files: [{
      category: "tracking-secret-key",
      path: "secrets/tracking-secret.key",
    }],
  }, receipt);
  assert.equal(
    readFileSync(join(receipt.data.stage, "tracking-secret.key"), "utf8"),
    "new-tracking-key\n",
  );
  assert.ok(receipt.data.targets.includes("tracking-secret.key"));
  swapData(paths, receipt);
  assert.equal(readFileSync(join(data, "tracking-secret.key"), "utf8"), "new-tracking-key\n");
  await rollbackMigration(id);
  assert.equal(readFileSync(join(data, "tracking-secret.key"), "utf8"), "old-tracking-key\n");

  const noKeyId = "a29f8ada-fdc9-78e0-93e8-b63126fb1257";
  const noKeyStaged = join(migrationRoot, "staged", noKeyId);
  mkdirSync(join(noKeyStaged, "backup", "databases"), { recursive: true });
  writeFileSync(join(noKeyStaged, "backup", "databases", "climate-twin.sqlite"), "source-without-key");
  const noKeyPaths = {
    id: noKeyId,
    staged: noKeyStaged,
    receipt: join(migrationRoot, "receipts", `${noKeyId}.json`),
  };
  const noKeyReceipt = { status: "applying", settings: [] };
  prepareDataSwap(noKeyPaths, {
    files: [{
      category: "core-sqlite",
      path: "databases/climate-twin.sqlite",
    }],
  }, noKeyReceipt);
  swapData(noKeyPaths, noKeyReceipt);
  assert.equal(existsSync(join(data, "tracking-secret.key")), false);
  await rollbackMigration(noKeyId);
  assert.equal(readFileSync(join(data, "tracking-secret.key"), "utf8"), "old-tracking-key\n");
});

test("Timescale recovery requires every job due at activation to finish successfully", async () => {
  const rawStatus = (overrides = {}) => parseTimescaleRecoveryStatus(JSON.stringify({
    checkedAt: "2026-07-31T05:45:00.000Z",
    schedulerRunning: false,
    restoringOff: false,
    maxWorkerProcesses: 16,
    maxParallelWorkers: 4,
    maxBackgroundWorkers: 12,
    jobs: [{
      jobId: 1004,
      jobStatus: "Scheduled",
      nextStart: "2026-07-31T05:44:00.000Z",
      lastRunStartedAt: null,
      lastSuccessfulFinish: null,
      lastRunStatus: null,
      totalSuccesses: 0,
      totalFailures: 0,
    }],
    ...overrides,
  }));
  const baseline = createTimescaleActivationBaseline(rawStatus());
  assert.deepEqual(baseline.jobs, [{
    jobId: 1004,
    due: true,
    totalSuccesses: 0,
    totalFailures: 0,
  }]);
  const running = rawStatus({
    schedulerRunning: true,
    restoringOff: true,
    jobs: [{
      jobId: 1004,
      jobStatus: "Running",
      nextStart: "infinity",
      lastRunStartedAt: "2026-07-31T05:45:01.000Z",
      lastSuccessfulFinish: null,
      lastRunStatus: null,
      totalSuccesses: 0,
      totalFailures: 0,
    }],
  });
  const succeeded = rawStatus({
    checkedAt: "2026-07-31T05:45:03.000Z",
    schedulerRunning: true,
    restoringOff: true,
    jobs: [{
      jobId: 1004,
      jobStatus: "Scheduled",
      nextStart: "2026-07-31T05:50:02.000Z",
      lastRunStartedAt: "2026-07-31T05:45:01.000Z",
      lastSuccessfulFinish: "2026-07-31T05:45:02.000Z",
      lastRunStatus: "Success",
      totalSuccesses: 1,
      totalFailures: 0,
    }],
  });
  assert.equal(timescaleRecoveryIsHealthy(evaluateTimescaleRecovery(running, baseline)), false);
  assert.equal(timescaleRecoveryIsHealthy(evaluateTimescaleRecovery(succeeded, baseline)), true);
  assert.equal((await waitForTimescaleScheduler({}, "stuga", {
    baseline,
    readStatus: async () => running,
  })).schedulerRunning, true);
  assert.match(TIMESCALE_RECOVERY_STATUS_SQL, /total_failures/u);
  assert.match(TIMESCALE_RECOVERY_STATUS_SQL, /max_worker_processes/u);
  assert.match(TIMESCALE_RECOVERY_STATUS_SQL, /TimescaleDB Background Worker Scheduler/u);

  const statuses = [running, succeeded];
  let now = 0;
  const recovered = await waitForTimescaleRecovery({}, "stuga", {
    baseline,
    timeoutMs: 2_000,
    pollMs: 500,
    readStatus: async () => statuses.shift(),
    sleep: async (milliseconds) => { now += milliseconds; },
    now: () => now,
  });
  assert.deepEqual(recovered.pendingDueJobIds, []);
  assert.equal(recovered.verifiedAt, "1970-01-01T00:00:00.500Z");

  const failedWithFutureRetry = rawStatus({
    schedulerRunning: true,
    restoringOff: true,
    jobs: [{
      jobId: 1004,
      jobStatus: "Scheduled",
      nextStart: "2026-07-31T06:45:00.000Z",
      lastRunStartedAt: "2026-07-31T05:45:01.000Z",
      lastSuccessfulFinish: null,
      lastRunStatus: "Failed",
      totalSuccesses: 0,
      totalFailures: 1,
    }],
  });
  await assert.rejects(waitForTimescaleRecovery({}, "stuga", {
    baseline,
    timeoutMs: 1_000,
    pollMs: 500,
    readStatus: async () => failedWithFutureRetry,
    sleep: async (milliseconds) => { now += milliseconds; },
    now: () => now,
  }), /jobs failed after activation: 1004/u);
});

test("Timescale activation finishes restore on the final name before using the restart fallback", async () => {
  const calls = [];
  await finishTimescaleRestore({}, "stuga", {
    execute: async (_configuration, database, sql) => calls.push({ database, sql }),
  });
  assert.deepEqual(calls, [
    { database: "stuga", sql: "SELECT timescaledb_post_restore();" },
  ]);
  calls.length = 0;
  await restartTimescaleBackgroundWorkers({}, "stuga", {
    execute: async (_configuration, database, sql) => calls.push({ database, sql }),
    readStatus: async () => ({
      schedulerRunning: false,
      restoringOff: true,
      maxWorkerProcesses: 16,
      maxParallelWorkers: 4,
      maxBackgroundWorkers: 12,
      jobs: [],
    }),
  });
  assert.deepEqual(calls, [
    { database: "stuga", sql: "SELECT timescaledb_pre_restore();" },
    { database: "stuga", sql: "SELECT timescaledb_post_restore();" },
  ]);
  await assert.rejects(restartTimescaleBackgroundWorkers({}, "stuga", {
    execute: async (_configuration, database, sql) => calls.push({ database, sql }),
    readStatus: async () => ({
      schedulerRunning: false,
      restoringOff: false,
      maxWorkerProcesses: 16,
      maxParallelWorkers: 4,
      maxBackgroundWorkers: 12,
      jobs: [],
    }),
  }), /restore mode is enabled/u);
  assert.equal(calls.length, 2);

  let schedulerChecks = 0;
  let waits = 0;
  let restarts = 0;
  let now = 0;
  const activationBaseline = {
    activatedAt: "2026-07-31T05:45:00.000Z",
    jobs: [],
  };
  const schedulerMissing = {
    checkedAt: "2026-07-31T05:45:00.000Z",
    schedulerRunning: false,
    restoringOff: true,
    maxWorkerProcesses: 16,
    maxParallelWorkers: 4,
    maxBackgroundWorkers: 12,
    jobs: [],
  };
  const schedulerRunning = { ...schedulerMissing, schedulerRunning: true };
  const schedulerRecovery = await ensureTimescaleScheduler({}, "stuga", {
    baseline: activationBaseline,
    timeoutMs: 1_000,
    pollMs: 500,
    readStatus: async () => restarts === 0 ? schedulerMissing : schedulerRunning,
    restart: async () => { restarts += 1; return { restarted: true }; },
    sleep: async (milliseconds) => { now += milliseconds; },
    now: () => now,
  });
  assert.equal(schedulerRecovery.schedulerRestarted, true);
  assert.equal(restarts, 1);

  const healthy = await ensurePendingTimescaleRecovery({
    targetDatabase: "stuga",
    timescaleRecovery: { activationBaseline },
  }, {
    configuration: {},
    ensureScheduler: async () => { schedulerChecks += 1; },
    wait: async () => {
      waits += 1;
      return {
        schedulerRunning: true,
        restoringOff: true,
        workerBudgetHealthy: true,
        scheduledJobCount: 8,
        dueJobIds: [],
        pendingDueJobIds: [],
        failedJobIds: [],
        runningJobIds: [],
      };
    },
    waitForArchive: async () => ({
      apiStatus: "ok",
      databaseReady: true,
      enabled: true,
      phase: "ready",
      caughtUp: true,
      timescaleAvailable: true,
      dirtyRows: 0,
      queuedSamples: 0,
    }),
  });
  assert.equal(restarts, 1);
  assert.equal(schedulerChecks, 1);
  assert.equal(waits, 1);
  assert.equal(timescaleRecoveryIsHealthy(healthy), true);
  assert.equal(telemetryArchiveRecoveryIsHealthy(healthy.telemetryArchive), true);
});

test("migration archive recovery waits for ready, caught-up, clean state", async () => {
  let now = 0;
  const statuses = [{
    apiStatus: "ok",
    databaseReady: true,
    enabled: true,
    phase: "syncing",
    caughtUp: false,
    timescaleAvailable: true,
    dirtyRows: 3,
    queuedSamples: 0,
  }, {
    apiStatus: "ok",
    databaseReady: true,
    enabled: true,
    phase: "ready",
    caughtUp: true,
    timescaleAvailable: true,
    dirtyRows: 0,
    queuedSamples: 0,
  }];
  const recovered = await waitForTelemetryArchiveRecovery({
    timeoutMs: 2_000,
    pollMs: 500,
    readStatus: async () => statuses.shift(),
    sleep: async (milliseconds) => { now += milliseconds; },
    now: () => now,
  });
  assert.equal(telemetryArchiveRecoveryIsHealthy(recovered), true);
  assert.equal(recovered.verifiedAt, "1970-01-01T00:00:00.500Z");
});

test("Compose reserves a consistent Timescale and PostgreSQL worker budget", () => {
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
  const setting = (name) => Number(compose.match(new RegExp(`- ${name}=(\\d+)`, "u"))?.[1]);
  assert.equal(setting("max_worker_processes"), 8);
  assert.equal(setting("max_parallel_workers"), 4);
  assert.equal(setting("timescaledb.max_background_workers"), 4);
  assert.equal(
    setting("max_worker_processes"),
    setting("max_parallel_workers") + setting("timescaledb.max_background_workers"),
  );
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
