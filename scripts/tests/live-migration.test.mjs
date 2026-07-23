import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
} from "../stuga-migration-bundle.mjs";
import {
  compareReleaseVersions,
  mergePortableEnvironment,
  portableEnvironment,
} from "../stuga-migration-common.mjs";
import { effectiveSettingsFile, parseLiveMigrationArgs, safeSshTarget } from "../stuga-live-migrate.mjs";
import { applyDeploymentSettings, targetForDeploymentPath } from "../stuga-migration-target.mjs";

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
});

test("version comparison rejects a newer source and permits patch differences", () => {
  assert.equal(compareReleaseVersions("0.5.0", "0.5.1"), -1);
  assert.equal(compareReleaseVersions("0.5.1", "0.5.0"), 1);
  assert.equal(compareReleaseVersions("0.5.0", "0.5.0"), 0);
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
});

test("source runtime profiles migrate even when they were enabled outside .env", (t) => {
  const root = temporaryDirectory(t);
  const workspace = join(root, "workspace");
  const settingsFile = join(root, ".env");
  mkdirSync(workspace);
  writeFileSync(settingsFile, "MOCK_ENABLED=false\nCOMPOSE_PROFILES=tapo-history\n");
  const generated = effectiveSettingsFile({ deploymentSettings: true, settingsFile, workspace }, ["cloudflared"]);
  assert.match(readFileSync(generated, "utf8"), /^COMPOSE_PROFILES=cloudflare,tapo-history$/mu);
});

test("target deployment overlay preserves target networking and limits secret roots", (t) => {
  const root = temporaryDirectory(t);
  const staged = join(root, "staged");
  const target = join(root, "target");
  const rollback = join(root, "rollback");
  mkdirSync(join(staged, "deployment", "config"), { recursive: true });
  mkdirSync(join(staged, "deployment", "secrets", "cloudflare"), { recursive: true });
  mkdirSync(join(target, "config"), { recursive: true });
  mkdirSync(join(target, "secrets"), { recursive: true });
  const envPath = join(target, "stuga.env");
  writeFileSync(envPath, "BIND_ADDRESS=127.0.0.1\nMOCK_ENABLED=true\n");
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
  applyDeploymentSettings(paths, { files: [
    { path: "deployment/settings.env" },
    { path: "deployment/config/devices.json" },
    { path: "deployment/secrets/cloudflare/tunnel-token" },
  ] }, receipt);
  assert.match(readFileSync(envPath, "utf8"), /^BIND_ADDRESS=127\.0\.0\.1$/mu);
  assert.match(readFileSync(envPath, "utf8"), /^MOCK_ENABLED=false$/mu);
  assert.equal(readFileSync(join(target, "config", "devices.json"), "utf8"), "{\"migrated\":true}\n");
  assert.equal(readFileSync(join(target, "secrets", "cloudflare", "tunnel-token"), "utf8"), "secret-test-value\n");
  assert.throws(() => targetForDeploymentPath("deployment/secrets/cloudflare-bootstrap/token"), /Unsupported/u);
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
