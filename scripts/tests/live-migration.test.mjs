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
} from "../stuga-migration-bundle.mjs";
import {
  compareReleaseVersions,
  mergePortableEnvironment,
  portableEnvironment,
} from "../stuga-migration-common.mjs";
import {
  assertRunningSourceVersion,
  assertTargetCapacity,
  effectiveSettingsFile,
  parseLiveMigrationArgs,
  safeSshTarget,
  stopSourceWriters,
  uploadMissingChunks,
} from "../stuga-live-migrate.mjs";
import {
  applyDeploymentSettings,
  commitMigration,
  completeBackupManifest,
  createApplyIntent,
  rollbackMigration,
  swapData,
  targetForDeploymentPath,
} from "../stuga-migration-target.mjs";

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "stuga-live-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function backupFixture(root) {
  const directory = join(root, "backup");
  mkdirSync(join(directory, "databases"), { recursive: true });
  const payload = Buffer.alloc(150_000, 0x61);
  writeFileSync(join(directory, "databases", "climate-twin.sqlite"), payload);
  const manifest = {
    format: "stuga-backup",
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

test("portable settings exclude target-specific networking and storage", () => {
  const migrated = portableEnvironment([
    "BIND_ADDRESS=0.0.0.0",
    "APP_PORT=9000",
    "DATABASE_PATH=C:/private/source.sqlite",
    "MOCK_ENABLED=false",
    "TP_LINK_HOST=192.0.2.5",
    "TP_LINK_PASSWORD='value with spaces'",
    "",
  ].join("\n"));
  assert.doesNotMatch(migrated, /BIND_ADDRESS|APP_PORT|DATABASE_PATH/u);
  assert.match(migrated, /^MOCK_ENABLED=false$/mu);
  assert.match(migrated, /^TP_LINK_HOST=192\.0\.2\.5$/mu);
  assert.match(migrated, /^TP_LINK_PASSWORD='value with spaces'$/mu);

  const merged = mergePortableEnvironment("BIND_ADDRESS=127.0.0.1\nMOCK_ENABLED=true\n", migrated);
  assert.match(merged, /^BIND_ADDRESS=127\.0\.0\.1$/mu);
  assert.match(merged, /^MOCK_ENABLED=false$/mu);
  assert.match(merged, /^TP_LINK_HOST=192\.0\.2\.5$/mu);

  const authoritative = mergePortableEnvironment(
    "BIND_ADDRESS=127.0.0.1\nMOCK_ENABLED=true\nTELEGRAM_BOT_TOKEN=stale\n",
    "MOCK_ENABLED=false\n",
    undefined,
    { authoritative: true },
  );
  assert.match(authoritative, /^BIND_ADDRESS=127\.0\.0\.1$/mu);
  assert.match(authoritative, /^MOCK_ENABLED=false$/mu);
  assert.doesNotMatch(authoritative, /TELEGRAM_BOT_TOKEN/u);
  assert.throws(
    () => portableEnvironment("TP_LINK_PASSWORD='line one\nline two'\n"),
    /Multiline environment values are not supported/u,
  );
});

test("version comparison rejects a newer source and permits patch differences", () => {
  assert.equal(compareReleaseVersions("0.5.0", "0.5.1"), -1);
  assert.equal(compareReleaseVersions("0.5.1", "0.5.0"), 1);
  assert.equal(compareReleaseVersions("0.5.0", "0.5.0"), 0);
});

test("a newer controller accepts the live 0.4 source but rejects a newer running source", async () => {
  const olderSource = {
    sourceVersion: "0.5.0",
    projectDirectory: "C:\\source",
    composeFile: "docker-compose.yml",
  };
  assert.equal(await assertRunningSourceVersion(olderSource, {
    runCommand: async () => ({ stdout: "0.4.1\n" }),
  }), "0.4.1");
  assert.equal(olderSource.controllerVersion, "0.5.0");
  assert.equal(olderSource.sourceVersion, "0.4.1");

  await assert.rejects(
    assertRunningSourceVersion({
      sourceVersion: "0.5.0",
      projectDirectory: "C:\\source",
      composeFile: "docker-compose.yml",
    }, {
      runCommand: async () => ({ stdout: "0.6.0\n" }),
    }),
    /newer than controller 0\.5\.0/u,
  );
});

test("source CLI validates SSH identity, target syntax, and cutover freshness", (t) => {
  const root = temporaryDirectory(t);
  const identity = join(root, "id_ed25519");
  writeFileSync(identity, "test-only-private-key\n");
  writeFileSync(join(root, "package.json"), '{"version":"0.5.0"}\n');
  writeFileSync(join(root, "docker-compose.yml"), "services: {}\n");
  assert.equal(safeSshTarget("stuga@stuga.local"), "stuga@stuga.local");
  assert.throws(() => safeSshTarget("-oProxyCommand=bad"), /safe SSH/u);
  const seed = parseLiveMigrationArgs([
    "seed", "--target", "stuga@stuga.local", "--identity-file", identity,
    "--accept-new-host-key", "--project-directory", root,
  ], {}, root);
  assert.equal(seed.sourceVersion, "0.5.0");
  assert.equal(seed.acceptNewHostKey, true);
  assert.throws(() => parseLiveMigrationArgs([
    "cutover", "--target", "stuga@stuga.local", "--identity-file", identity,
    "--project-directory", root, "--backup", "old-backup",
  ], {}, root), /fresh snapshot/u);
  assert.throws(() => parseLiveMigrationArgs([
    "status", "--target", "stuga@stuga.local", "--identity-file", identity,
    "--project-directory", root, "--migration-id", "bad;touch-pwned",
  ], {}, root), /UUID/u);
});

test("source runtime profiles migrate even when they were enabled outside .env", (t) => {
  const root = temporaryDirectory(t);
  const workspace = join(root, "workspace");
  const settingsFile = join(root, ".env");
  mkdirSync(workspace);
  writeFileSync(settingsFile, "MOCK_ENABLED=false\nCOMPOSE_PROFILES=tapo-history\n");
  const generated = effectiveSettingsFile({ deploymentSettings: true, settingsFile, workspace }, ["cloudflared"]);
  assert.match(readFileSync(generated, "utf8"), /^COMPOSE_PROFILES=cloudflare,tapo-history$/mu);
  assert.throws(
    () => effectiveSettingsFile({
      deploymentSettings: true,
      settingsFile: join(root, "missing.env"),
      workspace,
    }, []),
    /Authoritative settings path is missing/u,
  );
});

test("partial source quiescence failure restarts every service that was stopped", async () => {
  const options = { projectDirectory: "C:\\test-project", composeFile: "docker-compose.yml" };
  const snapshots = [
    ["cloudflared", "web", "api", "stuga-backup-scheduler"],
    ["api"],
  ];
  const stopCalls = [];
  let restarted;
  await assert.rejects(
    stopSourceWriters(options, {
      listRunning: async () => snapshots.shift() ?? [],
      runCommand: async (_command, arguments_) => {
        stopCalls.push(arguments_);
        if (stopCalls.length === 2) throw new Error("simulated partial stop");
        return { stdout: "" };
      },
      restart: async (_options, services) => {
        restarted = services;
      },
    }),
    /simulated partial stop/u,
  );
  assert.equal(stopCalls.length, 2);
  assert.deepEqual(restarted, ["cloudflared", "web", "stuga-backup-scheduler"]);
});

test("target deployment overlay preserves target networking and limits secret roots", (t) => {
  const root = temporaryDirectory(t);
  const staged = join(root, "staged");
  const target = join(root, "target");
  const rollback = join(root, "rollback");
  mkdirSync(join(staged, "deployment", "config"), { recursive: true });
  mkdirSync(join(staged, "deployment", "secrets", "cloudflare"), { recursive: true });
  mkdirSync(join(target, "config"), { recursive: true });
  mkdirSync(join(target, "secrets", "cloudflare"), { recursive: true });
  const envPath = join(target, "stuga.env");
  writeFileSync(envPath, "BIND_ADDRESS=127.0.0.1\nMOCK_ENABLED=true\nTELEGRAM_BOT_TOKEN=stale\n");
  writeFileSync(join(target, "config", "stale.json"), "{\"stale\":true}\n");
  writeFileSync(join(target, "secrets", "cloudflare", "stale-token"), "stale\n");
  writeFileSync(join(staged, "deployment", "settings.env"), portableEnvironment("BIND_ADDRESS=0.0.0.0\nMOCK_ENABLED=false\n"));
  writeFileSync(join(staged, "deployment", "config", "devices.json"), "{\"migrated\":true}\n");
  writeFileSync(join(staged, "deployment", "secrets", "cloudflare", "tunnel-token"), "secret-test-value\n");
  const previous = {
    env: process.env.STUGA_TARGET_ENV_FILE,
    config: process.env.STUGA_TARGET_CONFIG_DIRECTORY,
    secrets: process.env.STUGA_TARGET_SECRETS_DIRECTORY,
  };
  process.env.STUGA_TARGET_ENV_FILE = envPath;
  process.env.STUGA_TARGET_CONFIG_DIRECTORY = join(target, "config");
  process.env.STUGA_TARGET_SECRETS_DIRECTORY = join(target, "secrets");
  t.after(() => {
    if (previous.env === undefined) delete process.env.STUGA_TARGET_ENV_FILE; else process.env.STUGA_TARGET_ENV_FILE = previous.env;
    if (previous.config === undefined) delete process.env.STUGA_TARGET_CONFIG_DIRECTORY; else process.env.STUGA_TARGET_CONFIG_DIRECTORY = previous.config;
    if (previous.secrets === undefined) delete process.env.STUGA_TARGET_SECRETS_DIRECTORY; else process.env.STUGA_TARGET_SECRETS_DIRECTORY = previous.secrets;
  });
  const paths = { staged, settingsRollback: rollback, receipt: join(root, "receipt.json") };
  const receipt = {};
  applyDeploymentSettings(paths, {
    files: [
      { path: "deployment/settings.env" },
      { path: "deployment/config/devices.json" },
      { path: "deployment/secrets/cloudflare/tunnel-token" },
    ],
    deployment: {
      authoritativeEnvironment: true,
      exactConfig: true,
      exactSecretRoots: ["cloudflare"],
    },
  }, receipt);
  assert.match(readFileSync(envPath, "utf8"), /^BIND_ADDRESS=127\.0\.0\.1$/mu);
  assert.match(readFileSync(envPath, "utf8"), /^MOCK_ENABLED=false$/mu);
  assert.doesNotMatch(readFileSync(envPath, "utf8"), /TELEGRAM_BOT_TOKEN/u);
  assert.equal(readFileSync(join(target, "config", "devices.json"), "utf8"), "{\"migrated\":true}\n");
  assert.equal(existsSync(join(target, "config", "stale.json")), false);
  assert.equal(readFileSync(join(target, "secrets", "cloudflare", "tunnel-token"), "utf8"), "secret-test-value\n");
  assert.equal(existsSync(join(target, "secrets", "cloudflare", "stale-token")), false);
  assert.throws(() => targetForDeploymentPath("deployment/secrets/cloudflare-bootstrap/token"), /Unsupported/u);
});

test("backup validation requires a declared Stugby identity artifact", (t) => {
  const root = temporaryDirectory(t);
  const manifest = {
    files: [
      { category: "core-sqlite" },
      { category: "integration-secrets" },
      { category: "timescale-pgdump" },
    ],
    sources: {
      stugbyIdentity: { status: "missing" },
      timescale: { scope: "full-database" },
    },
  };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  assert.throws(() => completeBackupManifest(root), /Stugby node identity/u);

  mkdirSync(join(root, "secrets"));
  manifest.sources.stugbyIdentity.status = "included";
  manifest.files.push({ category: "stugby-identity", path: "secrets/stugby-identity.json" });
  writeFileSync(join(root, "secrets", "stugby-identity.json"), "{invalid", { mode: 0o600 });
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  assert.throws(() => completeBackupManifest(root), /not valid JSON/u);

  const keys = generateKeyPairSync("ed25519");
  writeFileSync(join(root, "secrets", "stugby-identity.json"), JSON.stringify({
    version: 1,
    nodeId: "619f8ada-fdc9-78e0-93e8-b63126fb1257",
    displayName: "Home",
    publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    createdAt: "2026-07-23T00:00:00.000Z",
  }), { mode: 0o600 });
  assert.equal(completeBackupManifest(root).sources.stugbyIdentity.status, "included");
});

test("data swap rollback is crash-safe and idempotent at each rename boundary", async (t) => {
  const root = temporaryDirectory(t);
  const previousRoot = process.env.STUGA_MIGRATION_ROOT;
  process.env.STUGA_MIGRATION_ROOT = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.STUGA_MIGRATION_ROOT;
    else process.env.STUGA_MIGRATION_ROOT = previousRoot;
  });

  const cases = [
    { id: "219f8ada-fdc9-78e0-93e8-b63126fb1257", point: "old-moved" },
    { id: "319f8ada-fdc9-78e0-93e8-b63126fb1257", point: "new-installed" },
  ];
  for (const scenario of cases) {
    const data = join(root, `data-${scenario.point}`);
    const stage = join(root, `stage-${scenario.point}`);
    const rollback = join(root, `rollback-${scenario.point}`);
    const receiptPath = join(root, "receipts", `${scenario.id}.json`);
    mkdirSync(data, { recursive: true });
    mkdirSync(stage, { recursive: true });
    mkdirSync(rollback, { recursive: true });
    mkdirSync(join(root, "receipts"), { recursive: true });
    writeFileSync(join(data, "climate-twin.sqlite"), "old-core");
    writeFileSync(join(data, "climate-twin.sqlite-wal"), "old-wal");
    writeFileSync(join(data, "stugby-identity.json"), "old-identity");
    writeFileSync(join(stage, "climate-twin.sqlite"), "new-core");
    writeFileSync(join(stage, "stugby-identity.json"), "new-identity");
    const receipt = {
      status: "applying",
      settings: [],
      data: {
        data,
        stage,
        rollback,
        targets: ["climate-twin.sqlite", "climate-twin.sqlite-wal", "stugby-identity.json"],
        items: {},
      },
    };
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
    assert.throws(
      () => swapData({ receipt: receiptPath }, receipt, {
        afterMutation(point, name) {
          if (point === scenario.point && name === "stugby-identity.json") {
            throw new Error(`simulated crash after ${point}`);
          }
        },
      }),
      /simulated crash/u,
    );

    await rollbackMigration(scenario.id);
    assert.equal(readFileSync(join(data, "climate-twin.sqlite"), "utf8"), "old-core");
    assert.equal(readFileSync(join(data, "climate-twin.sqlite-wal"), "utf8"), "old-wal");
    assert.equal(readFileSync(join(data, "stugby-identity.json"), "utf8"), "old-identity");
    await rollbackMigration(scenario.id);
    assert.equal(readFileSync(join(data, "stugby-identity.json"), "utf8"), "old-identity");
  }
});

test("a committed migration cannot be rolled back", async (t) => {
  const root = temporaryDirectory(t);
  const id = "719f8ada-fdc9-78e0-93e8-b63126fb1257";
  const previousRoot = process.env.STUGA_MIGRATION_ROOT;
  process.env.STUGA_MIGRATION_ROOT = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.STUGA_MIGRATION_ROOT;
    else process.env.STUGA_MIGRATION_ROOT = previousRoot;
  });
  mkdirSync(join(root, "receipts"), { recursive: true });
  writeFileSync(join(root, "receipts", `${id}.json`), '{"status":"committed"}\n');
  await assert.rejects(rollbackMigration(id), /committed migration cannot be rolled back/u);
  assert.equal(
    JSON.parse(readFileSync(join(root, "receipts", `${id}.json`), "utf8")).status,
    "committed",
  );
});

test("pending migration commit requires fresh exact-release health evidence", (t) => {
  const root = temporaryDirectory(t);
  const id = "a19f8ada-fdc9-78e0-93e8-b63126fb1257";
  const previousRoot = process.env.STUGA_MIGRATION_ROOT;
  process.env.STUGA_MIGRATION_ROOT = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.STUGA_MIGRATION_ROOT;
    else process.env.STUGA_MIGRATION_ROOT = previousRoot;
  });
  mkdirSync(join(root, "receipts"), { recursive: true });
  const receiptPath = join(root, "receipts", `${id}.json`);
  writeFileSync(receiptPath, JSON.stringify({
    status: "applied-pending-health-check",
    targetVersion: "0.5.0",
    appliedAt: "2026-07-23T01:00:00.000Z",
  }));
  assert.throws(
    () => commitMigration(id, "0.4.9", "2026-07-23T01:01:00.000Z"),
    /health proof does not match/u,
  );
  assert.throws(
    () => commitMigration(id, "0.5.0", "2026-07-23T00:59:59.000Z"),
    /health proof does not match/u,
  );
  assert.equal(
    commitMigration(id, "0.5.0", "2026-07-23T01:01:00.000Z").status,
    "committed",
  );
});

test("migration bundles are chunked, resumable, reassembled, and verified", async (t) => {
  const root = temporaryDirectory(t);
  const backup = backupFixture(root);
  const workspace = join(root, "workspace");
  const settings = join(root, ".env");
  const config = join(root, "config");
  const secrets = join(root, "secrets");
  mkdirSync(config);
  mkdirSync(join(secrets, "cloudflare"), { recursive: true });
  mkdirSync(join(secrets, "cloudflare-bootstrap"), { recursive: true });
  mkdirSync(join(secrets, "tapo-history-api"), { recursive: true });
  mkdirSync(join(secrets, "tapo-history-runner"), { recursive: true });
  writeFileSync(settings, "BIND_ADDRESS=0.0.0.0\nMOCK_ENABLED=false\n");
  writeFileSync(join(config, "sensor-map.json"), "{\"sensor\":1}\n");
  writeFileSync(join(secrets, "cloudflare", "tunnel-token"), "test-only-token\n");
  writeFileSync(join(secrets, "cloudflare-bootstrap", "provision-token.txt"), "must-not-migrate\n");

  const bundle = await createMigrationBundle({
    backupDirectory: backup,
    workspaceDirectory: workspace,
    phase: "seed",
    sourceVersion: "0.5.0",
    settingsFile: settings,
    configDirectory: config,
    secretsDirectory: secrets,
    chunkSize: 65_536,
    id: "019f8ada-fdc9-78e0-93e8-b63126fb1257",
    now: new Date("2026-07-22T20:00:00.000Z"),
  });
  assert.equal(bundle.plan.phase, "seed");
  assert.ok(bundle.plan.files.some((file) => file.path === "deployment/settings.env"));
  assert.ok(bundle.plan.files.some((file) => file.path === "deployment/config/sensor-map.json"));
  assert.ok(bundle.plan.files.some((file) => file.path === "deployment/secrets/cloudflare/tunnel-token"));
  assert.ok(bundle.plan.files.every((file) => !file.path.includes("cloudflare-bootstrap")));
  assert.equal(bundle.plan.files.find((file) => file.path.endsWith("climate-twin.sqlite")).chunks.length, 3);

  const targetChunks = join(root, "target-chunks");
  mkdirSync(targetChunks);
  const allMissing = await missingMigrationChunks(bundle.plan, targetChunks);
  assert.ok(allMissing.length >= 3);
  for (const digest of allMissing) copyFileSync(join(bundle.chunkDirectory, digest), join(targetChunks, digest));
  assert.deepEqual(await missingMigrationChunks(bundle.plan, targetChunks), []);

  const assembled = join(root, "assembled");
  const result = await assembleMigrationBundle({ plan: bundle.plan, chunkDirectory: targetChunks, outputDirectory: assembled });
  assert.equal(result.totalBytes, bundle.plan.totalBytes);
  assert.deepEqual(
    readFileSync(join(assembled, "backup", "databases", "climate-twin.sqlite")),
    readFileSync(join(backup, "databases", "climate-twin.sqlite")),
  );
  assert.doesNotMatch(readFileSync(join(assembled, "deployment", "settings.env"), "utf8"), /BIND_ADDRESS/u);
  assert.equal(existsSync(join(assembled, "deployment", "secrets", "cloudflare-bootstrap")), false);
  writeFileSync(join(assembled, "deployment", "settings.env"), "MOCK_ENABLED=true\n");
  await assert.rejects(
    verifyAssembledMigrationBundle({ plan: bundle.plan, outputDirectory: assembled }),
    /invalid|checksum mismatch/u,
  );
});

test("bundle creation refuses a missing authoritative deployment root", async (t) => {
  const root = temporaryDirectory(t);
  const settings = join(root, ".env");
  const config = join(root, "config");
  writeFileSync(settings, "MOCK_ENABLED=false\n");
  mkdirSync(config);
  await assert.rejects(
    createMigrationBundle({
      backupDirectory: backupFixture(root),
      workspaceDirectory: join(root, "workspace"),
      phase: "seed",
      sourceVersion: "0.5.0",
      settingsFile: settings,
      configDirectory: config,
      secretDirectories: {
        cloudflare: join(root, "missing-cloudflare"),
      },
      id: "519f8ada-fdc9-78e0-93e8-b63126fb1257",
    }),
    /Authoritative cloudflare secret path is missing/u,
  );
});

test("corrupt target chunks are replaced atomically after local verification", async (t) => {
  const root = temporaryDirectory(t);
  const bundle = await createMigrationBundle({
    backupDirectory: backupFixture(root),
    workspaceDirectory: join(root, "workspace"),
    phase: "seed",
    sourceVersion: "0.5.0",
    chunkSize: 65_536,
    id: "819f8ada-fdc9-78e0-93e8-b63126fb1257",
  });
  const digest = bundle.plan.files[0].chunks[0].sha256;
  let commands;
  await uploadMissingChunks(
    { workspace: join(root, "transfer") },
    { chunkDirectory: "/persistent/stuga/migrations/chunks" },
    bundle,
    [digest],
    { transfer: async (_options, batch) => { commands = batch; } },
  );
  assert.match(commands[0], /^put /u);
  assert.match(commands[1], /^-rm /u);
  assert.match(commands[2], /^rename /u);
  writeFileSync(join(bundle.chunkDirectory, digest), "corrupt");
  await assert.rejects(
    uploadMissingChunks(
      { workspace: join(root, "transfer") },
      { chunkDirectory: "/persistent/stuga/migrations/chunks" },
      bundle,
      [digest],
      { transfer: async () => {} },
    ),
    /failed verification before upload/u,
  );
});

test("capacity preflight reserves the actual TimescaleDB device and aggregates shared devices", async (t) => {
  const root = temporaryDirectory(t);
  const bundle = await createMigrationBundle({
    backupDirectory: backupFixture(root),
    workspaceDirectory: join(root, "workspace"),
    phase: "seed",
    sourceVersion: "0.5.0",
    id: "919f8ada-fdc9-78e0-93e8-b63126fb1257",
  });
  const plan = structuredClone(bundle.plan);
  plan.estimatedDatabaseBytes = 200_000_000;
  plan.estimatedRestoreBytes = plan.estimatedDataBytes + plan.estimatedDatabaseBytes;
  const split = {
    currentDataBytes: 100_000_000,
    currentDatabaseBytes: 100_000_000,
    migrationDevice: "migration-device",
    migrationFreeBytes: 2_000_000_000,
    dataDevice: "data-device",
    dataFreeBytes: 2_000_000_000,
    timeseriesDevice: "database-device",
    timeseriesFreeBytes: 2_000_000_000,
  };
  assert.doesNotThrow(() => assertTargetCapacity(split, plan));
  assert.throws(
    () => assertTargetCapacity({ ...split, timeseriesFreeBytes: 1_000_000_000 }, plan),
    /insufficient TimescaleDB free space/u,
  );
  assert.throws(
    () => assertTargetCapacity({
      ...split,
      migrationDevice: "shared",
      dataDevice: "shared",
      timeseriesDevice: "shared",
      migrationFreeBytes: 1_350_000_000,
      dataFreeBytes: 1_350_000_000,
      timeseriesFreeBytes: 1_350_000_000,
    }, plan),
    /insufficient migration\/application data\/TimescaleDB free space/u,
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
  writeFileSync(join(staged, ".stuga-assembled.json"), `${JSON.stringify({
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
