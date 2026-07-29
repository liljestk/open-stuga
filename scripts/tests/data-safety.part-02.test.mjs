import assert from "node:assert/strict";

import { execFileSync } from "node:child_process";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { fileURLToPath } from "node:url";

import { DatabaseSync } from "node:sqlite";

import test from "node:test";

import {
  MIGRATION_AGGREGATES,
  MIGRATION_HYPERTABLES,
  acquireCheckpointLock,
  destinationFingerprint,
  ensureAndRefreshMeasurementAggregates,
  inventoryTelemetrySource,
  mapRows,
  parseMigrationArgs,
  provisionDestination,
  runDryMigration,
  upsertBatch,
  validateExpectedHypertables,
  verifyBatch,
} from "../migrate-telemetry-to-timescale.mjs";

import {
  createBackup,
  parseBackupArgs,
  timescaleDumpArguments,
  timescaleOwnershipValidationSql,
  timescalePreRestoreSql,
  timescaleRestorePlan,
  verifyBackup,
} from "../stugu-backup.mjs";

import { backupArguments } from "../stugu-backup-scheduler.mjs";

import { openReadOnlySqlite, sha256File } from "../sqlite-snapshot-utils.mjs";

import { createTelemetryFixture, temporaryDirectory } from "./data-safety-test-support.mjs";

test("backup creates and re-verifies snapshots, assets, manifest, and opt-in fake secrets", async (t) => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "source.sqlite");
  const writer = createTelemetryFixture(source);
  writer.exec("CREATE TABLE tracking_endpoints (id TEXT PRIMARY KEY); INSERT INTO tracking_endpoints VALUES ('endpoint-1')");

  const spatial = join(directory, "spatial.sqlite");
  const spatialWriter = new DatabaseSync(spatial);
  spatialWriter.exec("CREATE TABLE layers (id TEXT PRIMARY KEY); INSERT INTO layers VALUES ('layer-1')");
  spatialWriter.close();

  const assets = join(directory, "assets");
  mkdirSync(join(assets, "floorplans"), { recursive: true });
  writeFileSync(join(assets, "floorplans", "ground.txt"), "fixture floor plan\n");
  const secrets = join(directory, "integration-secrets.json");
  writeFileSync(secrets, '{"version":1,"fakeToken":"test-only"}\n');
  const stugubyIdentity = join(directory, "stuguby-identity.json");
  writeFileSync(stugubyIdentity, '{"version":1,"nodeId":"test-node","displayName":"Test","publicKey":"fake","privateKey":"fake","createdAt":"2026-07-22T00:00:00.000Z"}\n');
  const trackingSecretKey = join(directory, "tracking-secret.key");
  writeFileSync(trackingSecretKey, `${Buffer.alloc(32, 7).toString("base64url")}\n`);
  const output = join(directory, "backup");
  try {
    const options = parseBackupArgs([
      "--database", source,
      "--output", output,
      "--assets", assets,
      "--spatial-db", spatial,
      "--stuguby-identity", stugubyIdentity,
      "--tracking-secret-key", trackingSecretKey,
      "--include-secrets",
      "--secrets-file", secrets,
    ], {});
    const manifest = await createBackup(options);
    assert.equal(manifest.verification.status, "passed");
    assert.equal(manifest.sources.integrationSecrets.status, "included");
    assert.equal(manifest.sources.timescale.status, "excluded");
    assert.ok(manifest.files.some(({ category }) => category === "core-sqlite"));
    assert.ok(manifest.files.some(({ category }) => category === "spatial-sqlite"));
    assert.ok(manifest.files.some(({ category }) => category === "asset"));
    assert.ok(manifest.files.some(({ category }) => category === "integration-secrets"));
    assert.ok(manifest.files.some(({ category }) => category === "stuguby-identity"));
    assert.ok(manifest.files.some(({ category }) => category === "tracking-secret-key"));
    assert.equal(manifest.sources.stugubyIdentity.status, "included");
    assert.equal(manifest.sources.trackingSecretKey.encryptedEndpointRecords, 1);
    assert.equal(manifest.files.every(({ sensitive }) => sensitive === true), true);
    assert.equal(existsSync(join(output, "manifest.sha256")), true);
    assert.equal(existsSync(join(output, "INCOMPLETE.json")), false);
    assert.match(readFileSync(join(output, "manifest.sha256"), "utf8"), /^[a-f0-9]{64}  manifest\.json\n$/u);
    const verification = await verifyBackup(output);
    assert.equal(verification.status, "passed");
    if (process.platform !== "win32") {
      assert.equal(statSync(output).mode & 0o777, 0o700);
      for (const record of manifest.files) {
        assert.equal(statSync(join(output, record.path)).mode & 0o777, 0o600, record.path);
      }
      assert.equal(statSync(join(output, "manifest.json")).mode & 0o777, 0o600);
    }
  } finally {
    writer.close();
  }
});

test("quiesced backups safely read clean WAL-mode databases from a read-only mount", async (t) => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "source.sqlite");
  const writer = createTelemetryFixture(source);
  writer.exec("PRAGMA journal_mode = WAL");
  writer.close();

  const spatial = join(directory, "spatial.sqlite");
  const spatialWriter = new DatabaseSync(spatial);
  spatialWriter.exec("PRAGMA journal_mode = WAL; CREATE TABLE layers (id TEXT PRIMARY KEY); INSERT INTO layers VALUES ('layer-1')");
  spatialWriter.close();
  assert.equal(existsSync(`${source}-wal`), false);
  assert.equal(existsSync(`${spatial}-wal`), false);

  const options = parseBackupArgs([
    "--database", source,
    "--output", join(directory, "backup"),
    "--assets", join(directory, "missing-assets"),
    "--spatial-db", spatial,
  ], { STUGU_BACKUP_QUIESCED_SQLITE: "true" });
  const manifest = await createBackup(options);
  assert.equal(manifest.verification.status, "passed");
  assert.ok(manifest.files.some(({ category }) => category === "spatial-sqlite"));

  writeFileSync(`${spatial}-wal`, "unsafe pending WAL");
  const unsafe = parseBackupArgs([
    "--database", source,
    "--output", join(directory, "unsafe-backup"),
    "--assets", join(directory, "missing-assets"),
    "--spatial-db", spatial,
  ], { STUGU_BACKUP_QUIESCED_SQLITE: "true" });
  await assert.rejects(createBackup(unsafe), /still has a -wal sidecar/u);
  assert.throws(
    () => parseBackupArgs([], { STUGU_BACKUP_QUIESCED_SQLITE: "1" }),
    /must be exactly 'true'/u,
  );
});

test("optional integration secrets are included only when present", (t) => {
  const directory = temporaryDirectory(t);
  const secret = join(directory, "integration-secrets.json");
  const arguments_ = [
    "--database", join(directory, "source.sqlite"),
    "--include-secrets-if-present",
    "--secrets-file", secret,
  ];
  assert.equal(parseBackupArgs(arguments_, {}).includeSecrets, false);
  writeFileSync(secret, '{"version":1}\n');
  assert.equal(parseBackupArgs(arguments_, {}).includeSecrets, true);
  assert.throws(
    () => parseBackupArgs([...arguments_, "--include-secrets"], {}),
    /only one of --include-secrets/u,
  );
});

test("backup refuses encrypted tracking endpoint identities without their restore key", async (t) => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "source.sqlite");
  const writer = createTelemetryFixture(source);
  try {
    writer.exec("CREATE TABLE tracking_endpoints (id TEXT PRIMARY KEY); INSERT INTO tracking_endpoints VALUES ('endpoint-1')");
    const options = parseBackupArgs([
      "--database", source,
      "--output", join(directory, "backup"),
      "--assets", join(directory, "missing-assets"),
      "--spatial-db", join(directory, "missing-spatial.sqlite"),
      "--stuguby-identity", join(directory, "missing-identity.json"),
      "--tracking-secret-key", join(directory, "missing-tracking-secret.key"),
    ], {});
    await assert.rejects(
      createBackup(options),
      /encrypted tracking endpoint identities but TRACKING_SECRET_KEY_FILE is missing/u,
    );
  } finally {
    writer.close();
  }
});

test("backup preserves every snapshotted Stuguby blob across a concurrent live deletion and verifies the cross-reference", async (t) => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "source.sqlite");
  const writer = createTelemetryFixture(source);
  try {
  const assets = join(directory, "assets");
  const stugubyAssets = join(assets, "stuguby");
  mkdirSync(stugubyAssets, { recursive: true });
  const content = Buffer.from("snapshotted Stuguby floor plan");
  const temporaryAsset = join(stugubyAssets, "blob");
  writeFileSync(temporaryAsset, content);
  const digest = await sha256File(temporaryAsset);
  const asset = join(stugubyAssets, digest);
  writeFileSync(asset, content);
  unlinkSync(temporaryAsset);
  writer.exec(`
    CREATE TABLE stugby_blob_metadata (
      digest TEXT PRIMARY KEY,
      byte_length INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE stugby_blob_references (
      stugby_id TEXT NOT NULL,
      digest TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      grant_epoch INTEGER NOT NULL,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  writer.prepare(`INSERT INTO stugby_blob_metadata
    (digest,byte_length,media_type,relative_path,created_at) VALUES (?,?,?,?,?)`)
    .run(digest, content.byteLength, "image/png", digest, "2026-07-23T00:00:00.000Z");
  writer.prepare(`INSERT INTO stugby_blob_references
    (stugby_id,digest,grant_id,grant_epoch,kind,created_at) VALUES (?,?,?,?,?,?)`)
    .run("stuguby-1", digest, "grant-1", 1, "local", "2026-07-23T00:00:00.000Z");

  const output = join(directory, "backup");
  const options = parseBackupArgs([
    "--database", source,
    "--output", output,
    "--assets", assets,
    "--spatial-db", join(directory, "missing-spatial.sqlite"),
    "--stuguby-identity", join(directory, "missing-identity.json"),
  ], {});
  const manifest = await createBackup(options, {
    afterCoreSnapshot() {
      writer.prepare("DELETE FROM stugby_blob_references WHERE digest=?").run(digest);
      writer.prepare("DELETE FROM stugby_blob_metadata WHERE digest=?").run(digest);
      unlinkSync(asset);
    },
  });
  assert.equal(manifest.sources.assets.requiredStugubyBlobs, 1);
  assert.equal(existsSync(join(output, "assets", "stuguby", digest)), true);
  assert.equal(await sha256File(join(output, "assets", "stuguby", digest)), digest);
  assert.equal((await verifyBackup(output)).status, "passed");

  const manifestPath = join(output, "manifest.json");
  const withoutBlobRecord = JSON.parse(readFileSync(manifestPath, "utf8"));
  withoutBlobRecord.files = withoutBlobRecord.files.filter((record) => record.path !== `assets/stuguby/${digest}`);
  writeFileSync(manifestPath, `${JSON.stringify(withoutBlobRecord, null, 2)}\n`);
  writeFileSync(join(output, "manifest.sha256"), `${await sha256File(manifestPath)}  manifest.json\n`);
  await assert.rejects(
    verifyBackup(output),
    /missing the checksummed Stuguby asset required by its core snapshot/u,
  );
  } finally {
    writer.close();
  }
});
