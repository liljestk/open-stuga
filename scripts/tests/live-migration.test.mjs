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
  symlinkSync,
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
  composeBackupArguments,
  effectiveSettingsFile,
  migrationBundlePhase,
  parseLiveMigrationArgs,
  runLiveMigration,
  safeSshTarget,
  stopSourceWriters,
  uploadMissingChunks,
  validatedExistingBackupManifest,
} from "../stugu-live-migrate.mjs";

import {
  MAX_IN_PLACE_REPLACEMENT_BYTES,
  applyDeploymentSettings,
  commitMigration,
  completeBackupManifest,
  createApplyIntent,
  replaceFileContents,
  rollbackMigration,
  swapData,
  targetForDeploymentPath,
} from "../stugu-migration-target.mjs";

import { backupFixture, sha256, temporaryDirectory } from "./live-migration-test-support.mjs";

test("portable settings exclude target-specific networking and storage", () => {
  const migrated = portableEnvironment([
    "BIND_ADDRESS=0.0.0.0",
    "APP_PORT=9000",
    "DATABASE_PATH=C:/private/source.sqlite",
    "MOCK_ENABLED=false",
    "STUGU_R2_BUCKET=stugu-backups",
    "STUGU_R2_ENDPOINT=https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com",
    "TP_LINK_HOST=192.0.2.5",
    "TP_LINK_PASSWORD='value with spaces'",
    "",
  ].join("\n"));
  assert.doesNotMatch(migrated, /BIND_ADDRESS|APP_PORT|DATABASE_PATH/u);
  assert.match(migrated, /^MOCK_ENABLED=false$/mu);
  assert.match(migrated, /^STUGU_R2_BUCKET=stugu-backups$/mu);
  assert.match(migrated, /^STUGU_R2_ENDPOINT=https:\/\/0123456789abcdef0123456789abcdef\.eu\.r2\.cloudflarestorage\.com$/mu);
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

test("cloudflared reads migrated mode-0600 secrets as the host bind user", () => {
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
  const service = compose.match(/^  cloudflared:\r?\n(?<body>[\s\S]*?)(?=^networks:)/mu)?.groups?.body ?? "";
  assert.match(service, /user: \$\{STUGA_HOST_BIND_USER:-1000:1000\}/u);
  assert.match(service, /\/run\/secrets\/cloudflare\/tunnel-token/u);
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
  mkdirSync(join(root, "old-backup"));
  assert.equal(safeSshTarget("stugu@stugu.local"), "stugu@stugu.local");
  assert.throws(() => safeSshTarget("-oProxyCommand=bad"), /safe SSH/u);
  const seed = parseLiveMigrationArgs([
    "seed", "--target", "stugu@stugu.local", "--identity-file", identity,
    "--accept-new-host-key", "--project-directory", root,
  ], {}, root);
  assert.equal(seed.sourceVersion, "0.5.0");
  assert.equal(seed.acceptNewHostKey, true);
  assert.throws(() => parseLiveMigrationArgs([
    "cutover", "--target", "stugu@stugu.local", "--identity-file", identity,
    "--project-directory", root, "--backup", "old-backup",
  ], {}, root), /fresh snapshot/u);
  assert.throws(() => parseLiveMigrationArgs([
    "status", "--target", "stugu@stugu.local", "--identity-file", identity,
    "--project-directory", root, "--migration-id", "bad;touch-pwned",
  ], {}, root), /UUID/u);
});

test("backup recovery requires recorded source provenance and preserves target host settings", async (t) => {
  const root = temporaryDirectory(t);
  const identity = join(root, "id_ed25519");
  const backup = backupFixture(root);
  writeFileSync(identity, "test-only-private-key\n");
  writeFileSync(join(root, "package.json"), '{"version":"0.5.0"}\n');

  const recovery = parseLiveMigrationArgs([
    "recover", "--target", "stugu@stugu.local", "--identity-file", identity,
    "--project-directory", root, "--backup", backup, "--source-version", "0.4.1",
    "--allow-legacy-unverified-source-version",
  ], {}, root);
  assert.equal(recovery.sourceVersion, "0.4.1");
  assert.equal(recovery.controllerVersion, "0.5.0");
  assert.equal(recovery.deploymentSettings, false);
  assert.equal(migrationBundlePhase(recovery.phase), "cutover");

  const bundle = await createMigrationBundle({
    backupDirectory: recovery.backup,
    workspaceDirectory: join(root, "recovery-workspace"),
    phase: migrationBundlePhase(recovery.phase),
    sourceVersion: recovery.sourceVersion,
    id: "d19f8ada-fdc9-78e0-93e8-b63126fb1257",
  });
  assert.equal(bundle.plan.phase, "cutover");
  assert.deepEqual(bundle.plan.deployment, {
    authoritativeEnvironment: false,
    exactConfig: false,
    exactSecretRoots: [],
  });
  assert.ok(bundle.plan.files.every((file) => !file.path.startsWith("deployment/")));

  assert.throws(() => parseLiveMigrationArgs([
    "recover", "--target", "stugu@stugu.local", "--identity-file", identity,
    "--project-directory", root, "--source-version", "0.4.1",
    "--allow-legacy-unverified-source-version",
  ], {}, root), /requires --backup/u);
  assert.throws(() => parseLiveMigrationArgs([
    "recover", "--target", "stugu@stugu.local", "--identity-file", identity,
    "--project-directory", root, "--backup", backup,
    "--allow-legacy-unverified-source-version",
  ], {}, root), /requires --source-version/u);
  assert.throws(() => parseLiveMigrationArgs([
    "recover", "--target", "stugu@stugu.local", "--identity-file", identity,
    "--project-directory", root, "--backup", backup, "--source-version", "0.4.1",
  ], {}, root), /does not record its source version/u);
  assert.throws(() => parseLiveMigrationArgs([
    "recover", "--target", "stugu@stugu.local", "--identity-file", identity,
    "--project-directory", root, "--backup", backup, "--source-version", "0.6.0",
    "--allow-legacy-unverified-source-version",
  ], {}, root), /newer than controller/u);
  assert.throws(() => parseLiveMigrationArgs([
    "recover", "--target", "stugu@stugu.local", "--identity-file", identity,
    "--project-directory", root, "--backup", backup, "--source-version", "0.4.1",
    "--allow-legacy-unverified-source-version",
    "--settings-file", join(root, ".env"),
  ], {}, root), /always preserves target host settings/u);
  assert.throws(() => parseLiveMigrationArgs([
    "seed", "--target", "stugu@stugu.local", "--identity-file", identity,
    "--project-directory", root, "--source-version", "0.4.1",
  ], {}, root), /only valid with recover/u);

  const declaredRoot = join(root, "declared-source");
  mkdirSync(declaredRoot);
  const declaredBackup = backupFixture(declaredRoot);
  const declaredManifestPath = join(declaredBackup, "manifest.json");
  const declaredManifest = JSON.parse(readFileSync(declaredManifestPath, "utf8"));
  declaredManifest.sourceVersion = "0.4.2";
  const declaredText = `${JSON.stringify(declaredManifest, null, 2)}\n`;
  writeFileSync(declaredManifestPath, declaredText);
  writeFileSync(join(declaredBackup, "manifest.sha256"), `${sha256(declaredText)}  manifest.json\n`);
  const declaredRecovery = parseLiveMigrationArgs([
    "recover", "--target", "stugu@stugu.local", "--identity-file", identity,
    "--project-directory", root, "--backup", declaredBackup,
  ], {}, root);
  assert.equal(declaredRecovery.sourceVersion, "0.4.2");
  assert.equal(declaredRecovery.sourceVersionProvenance, "backup-manifest");
  assert.throws(() => parseLiveMigrationArgs([
    "recover", "--target", "stugu@stugu.local", "--identity-file", identity,
    "--project-directory", root, "--backup", declaredBackup, "--source-version", "0.4.1",
  ], {}, root), /does not match/u);
  await assert.rejects(createMigrationBundle({
    backupDirectory: declaredBackup,
    workspaceDirectory: join(root, "mismatched-source-workspace"),
    phase: "cutover",
    sourceVersion: "0.4.1",
  }), /does not match migration source/u);
});

test("backup recovery rejects symlinked artifact parents", (t) => {
  const root = temporaryDirectory(t);
  const backup = join(root, "backup");
  const external = join(root, "external");
  mkdirSync(backup);
  mkdirSync(external);
  writeFileSync(join(external, "payload.sqlite"), "outside-backup");
  try {
    symlinkSync(external, join(backup, "linked"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating a test symlink is not permitted");
      return;
    }
    throw error;
  }
  const manifest = {
    format: "stugu-backup",
    version: 2,
    verification: { status: "passed" },
    files: [{ path: "linked/payload.sqlite", category: "core-sqlite" }],
  };
  const text = `${JSON.stringify(manifest)}\n`;
  writeFileSync(join(backup, "manifest.json"), text);
  writeFileSync(join(backup, "manifest.sha256"), `${sha256(text)}  manifest.json\n`);
  assert.throws(
    () => validatedExistingBackupManifest(backup),
    /symbolic link/u,
  );
});

test("recover orchestration avoids local Compose and submits an applicable rollback-guarded plan", async (t) => {
  const root = temporaryDirectory(t);
  const identity = join(root, "id_ed25519");
  const backup = backupFixture(root);
  writeFileSync(identity, "test-only-private-key\n");
  writeFileSync(join(root, "package.json"), '{"version":"0.5.0"}\n');
  const forbiddenSourceCall = async () => {
    throw new Error("recover touched the local Compose source");
  };
  const remoteCalls = [];
  let stagedPlan;
  let restartCalls = 0;
  await assert.rejects(
    runLiveMigration([
      "recover", "--target", "stugu@stugu.local", "--identity-file", identity,
      "--project-directory", root, "--backup", backup, "--source-version", "0.4.1",
      "--allow-legacy-unverified-source-version",
    ], {
      resolveComposeDeploymentInputs: forbiddenSourceCall,
      assertRunningSourceVersion: forbiddenSourceCall,
      stopSourceWriters: forbiddenSourceCall,
      runningComposeServices: forbiddenSourceCall,
      createComposeBackup: forbiddenSourceCall,
      restartSource: async () => { restartCalls += 1; },
      stageBundle: async (_options, _target, bundle) => { stagedPlan = bundle.plan; },
      remoteJson: async (_options, command) => {
        remoteCalls.push(command);
        if (command[2] === "init") {
          return { format: "stugu-migration-preflight", version: 1, targetVersion: "0.5.0" };
        }
        if (command[2] === "apply") throw new Error("simulated target apply failure");
        if (command[2] === "status") return { receipt: { status: "rolled-back" } };
        throw new Error(`Unexpected remote command: ${command.join(" ")}`);
      },
      writeOutput: () => {},
    }),
    /recovery failed and rolled back safely/u,
  );
  assert.equal(stagedPlan.phase, "cutover");
  assert.ok(stagedPlan.files.every((file) => !file.path.startsWith("deployment/")));
  assert.deepEqual(remoteCalls.map((command) => command[2]), ["init", "apply", "status"]);
  assert.equal(restartCalls, 0);
});

test("source runtime profiles migrate even when they were enabled outside .env", (t) => {
  const root = temporaryDirectory(t);
  const workspace = join(root, "workspace");
  const settingsFile = join(root, ".env");
  mkdirSync(workspace);
  writeFileSync(settingsFile, "MOCK_ENABLED=false\nCOMPOSE_PROFILES=tapo-history\n");
  const generated = effectiveSettingsFile(
    { deploymentSettings: true, settingsFile, workspace },
    ["cloudflared", "stugu-r2-backup"],
  );
  assert.match(readFileSync(generated, "utf8"), /^COMPOSE_PROFILES=cloudflare,r2-backup,tapo-history$/mu);
  assert.throws(
    () => effectiveSettingsFile({
      deploymentSettings: true,
      settingsFile: join(root, "missing.env"),
      workspace,
    }, []),
    /Authoritative settings path is missing/u,
  );
});

test("cutover backups use quiesced immutable SQLite reads", () => {
  const base = {
    projectDirectory: "C:\\source",
    composeFile: "docker-compose.yml",
  };
  const cutover = composeBackupArguments({ ...base, phase: "cutover" });
  const seed = composeBackupArguments({ ...base, phase: "seed" });
  assert.ok(cutover.includes("STUGU_BACKUP_QUIESCED_SQLITE=true"));
  assert.equal(seed.includes("STUGU_BACKUP_QUIESCED_SQLITE=true"), false);
});

test("partial source quiescence failure restarts every service that was stopped", async () => {
  const options = { projectDirectory: "C:\\test-project", composeFile: "docker-compose.yml" };
  const snapshots = [
    ["cloudflared", "web", "api", "stugu-backup-scheduler"],
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
  assert.deepEqual(restarted, ["cloudflared", "web", "stugu-backup-scheduler"]);
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
  const envPath = join(target, "stugu.env");
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
  assert.equal(
    targetForDeploymentPath("deployment/secrets/r2/access-key-id").relativePath,
    "r2/access-key-id",
  );
  assert.throws(() => targetForDeploymentPath("deployment/secrets/cloudflare-bootstrap/token"), /Unsupported/u);
});

test("settings replacement supports an existing immutable-parent bind mount", (t) => {
  const root = temporaryDirectory(t);
  const destination = join(root, "stugu.env");
  writeFileSync(destination, "old=true\n");
  const readOnlyParentError = Object.assign(new Error("simulated read-only parent"), { code: "EROFS" });
  replaceFileContents(destination, "new=true\n", 0o600, {
    atomicInstaller: () => { throw readOnlyParentError; },
  });
  assert.equal(readFileSync(destination, "utf8"), "new=true\n");

  assert.throws(
    () => replaceFileContents(destination, Buffer.alloc(MAX_IN_PLACE_REPLACEMENT_BYTES + 1), 0o600, {
      atomicInstaller: () => { throw readOnlyParentError; },
    }),
    /Refusing non-atomic replacement/u,
  );
  assert.equal(readFileSync(destination, "utf8"), "new=true\n");
});

test("backup validation requires a declared Stuguby identity artifact", (t) => {
  const root = temporaryDirectory(t);
  const manifest = {
    files: [
      { category: "core-sqlite" },
      { category: "integration-secrets" },
      { category: "timescale-pgdump" },
    ],
    sources: {
      stugubyIdentity: { status: "missing" },
      timescale: { scope: "full-database" },
    },
  };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  assert.throws(() => completeBackupManifest(root), /Stuguby node identity/u);

  mkdirSync(join(root, "secrets"));
  manifest.sources.stugubyIdentity.status = "included";
  manifest.files.push({ category: "stuguby-identity", path: "secrets/stuguby-identity.json" });
  writeFileSync(join(root, "secrets", "stuguby-identity.json"), "{invalid", { mode: 0o600 });
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  assert.throws(() => completeBackupManifest(root), /not valid JSON/u);

  const keys = generateKeyPairSync("ed25519");
  writeFileSync(join(root, "secrets", "stuguby-identity.json"), JSON.stringify({
    version: 1,
    nodeId: "619f8ada-fdc9-78e0-93e8-b63126fb1257",
    displayName: "Home",
    publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    createdAt: "2026-07-23T00:00:00.000Z",
  }), { mode: 0o600 });
  assert.equal(completeBackupManifest(root).sources.stugubyIdentity.status, "included");

  const trackingKeyPath = join(root, "secrets", "tracking-secret.key");
  manifest.files.push({
    category: "tracking-secret-key",
    path: "secrets/tracking-secret.key",
  });
  writeFileSync(trackingKeyPath, "not a tracking key\n", { mode: 0o600 });
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  assert.throws(() => completeBackupManifest(root), /tracking secret key is invalid/u);
  writeFileSync(trackingKeyPath, `${Buffer.alloc(32, 9).toString("base64url")}\n`);
  assert.equal(
    completeBackupManifest(root).files
      .filter(({ category }) => category === "tracking-secret-key").length,
    1,
  );
  manifest.files.push({
    category: "tracking-secret-key",
    path: "secrets/duplicate-tracking-secret.key",
  });
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  assert.throws(() => completeBackupManifest(root), /multiple tracking-secret-key artifacts/u);
  manifest.files.pop();

  manifest.sourceVersion = "0.4.9";
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  assert.throws(
    () => completeBackupManifest(root, "0.5.0"),
    /does not match migration source/u,
  );
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
    {
      id: "519f8ada-fdc9-78e0-93e8-b63126fb1257",
      point: "new-installed",
      targetHadTrackingKey: false,
    },
  ];
  for (const scenario of cases) {
    const data = join(root, `data-${scenario.id}`);
    const stage = join(root, `stage-${scenario.id}`);
    const rollback = join(root, `rollback-${scenario.id}`);
    const receiptPath = join(root, "receipts", `${scenario.id}.json`);
    mkdirSync(data, { recursive: true });
    mkdirSync(stage, { recursive: true });
    mkdirSync(rollback, { recursive: true });
    mkdirSync(join(root, "receipts"), { recursive: true });
    writeFileSync(join(data, "climate-twin.sqlite"), "old-core");
    writeFileSync(join(data, "climate-twin.sqlite-wal"), "old-wal");
    writeFileSync(join(data, "stuguby-identity.json"), "old-identity");
    if (scenario.targetHadTrackingKey !== false) {
      writeFileSync(join(data, "tracking-secret.key"), "old-tracking-key");
    }
    writeFileSync(join(stage, "climate-twin.sqlite"), "new-core");
    writeFileSync(join(stage, "stuguby-identity.json"), "new-identity");
    writeFileSync(join(stage, "tracking-secret.key"), "new-tracking-key");
    const receipt = {
      status: "applying",
      settings: [],
      data: {
        data,
        stage,
        rollback,
        targets: [
          "climate-twin.sqlite",
          "climate-twin.sqlite-wal",
          "stuguby-identity.json",
          "tracking-secret.key",
        ],
        items: {},
      },
    };
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
    assert.throws(
      () => swapData({ receipt: receiptPath }, receipt, {
        afterMutation(point, name) {
          if (point === scenario.point && name === "tracking-secret.key") {
            throw new Error(`simulated crash after ${point}`);
          }
        },
      }),
      /simulated crash/u,
    );

    await rollbackMigration(scenario.id);
    assert.equal(readFileSync(join(data, "climate-twin.sqlite"), "utf8"), "old-core");
    assert.equal(readFileSync(join(data, "climate-twin.sqlite-wal"), "utf8"), "old-wal");
    assert.equal(readFileSync(join(data, "stuguby-identity.json"), "utf8"), "old-identity");
    if (scenario.targetHadTrackingKey === false) {
      assert.equal(existsSync(join(data, "tracking-secret.key")), false);
    } else {
      assert.equal(readFileSync(join(data, "tracking-secret.key"), "utf8"), "old-tracking-key");
    }
    await rollbackMigration(scenario.id);
    assert.equal(readFileSync(join(data, "stuguby-identity.json"), "utf8"), "old-identity");
    if (scenario.targetHadTrackingKey === false) {
      assert.equal(existsSync(join(data, "tracking-secret.key")), false);
    } else {
      assert.equal(readFileSync(join(data, "tracking-secret.key"), "utf8"), "old-tracking-key");
    }
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

test("pending migration commit requires fresh release and Timescale health evidence", async (t) => {
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
  let timescaleChecks = 0;
  const verifyTimescale = async () => {
    timescaleChecks += 1;
    return {
      schedulerRunning: true,
      restoringOff: true,
      workerBudgetHealthy: true,
      scheduledJobCount: 8,
      dueJobIds: [],
      pendingDueJobIds: [],
      failedJobIds: [],
      runningJobIds: [],
      verifiedAt: "2026-07-23T01:00:30.000Z",
      telemetryArchive: {
        apiStatus: "ok",
        databaseReady: true,
        enabled: true,
        phase: "ready",
        caughtUp: true,
        timescaleAvailable: true,
        dirtyRows: 0,
        queuedSamples: 0,
      },
    };
  };
  await assert.rejects(
    commitMigration(id, "0.4.9", "2026-07-23T01:01:00.000Z", { verifyTimescale }),
    /health proof does not match/u,
  );
  await assert.rejects(
    commitMigration(id, "0.5.0", "2026-07-23T00:59:59.000Z", { verifyTimescale }),
    /health proof does not match/u,
  );
  assert.equal(timescaleChecks, 0);
  await assert.rejects(
    commitMigration(id, "0.5.0", "2026-07-23T01:01:00.000Z", {
      verifyTimescale: async () => { throw new Error("scheduler missing"); },
    }),
    /scheduler missing/u,
  );
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).status, "applied-pending-health-check");
  const committed = await commitMigration(
    id,
    "0.5.0",
    "2026-07-23T01:01:00.000Z",
    { verifyTimescale },
  );
  assert.equal(committed.status, "committed");
  assert.equal(committed.timescaleRecovery.mode, "pre-commit");
  assert.equal(timescaleChecks, 1);
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
  mkdirSync(join(secrets, "r2"), { recursive: true });
  mkdirSync(join(secrets, "tapo-history-api"), { recursive: true });
  mkdirSync(join(secrets, "tapo-history-runner"), { recursive: true });
  writeFileSync(settings, "BIND_ADDRESS=0.0.0.0\nMOCK_ENABLED=false\n");
  writeFileSync(join(config, "sensor-map.json"), "{\"sensor\":1}\n");
  writeFileSync(join(secrets, "cloudflare", "tunnel-token"), "test-only-token\n");
  writeFileSync(join(secrets, "r2", "age-recipient"), `age1${"q".repeat(58)}\n`);
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
  assert.ok(bundle.plan.files.some((file) => file.path === "deployment/secrets/r2/age-recipient"));
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
    { chunkDirectory: "/persistent/stugu/migrations/chunks" },
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
      { chunkDirectory: "/persistent/stugu/migrations/chunks" },
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
