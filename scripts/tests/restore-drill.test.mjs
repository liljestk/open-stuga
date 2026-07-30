import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { sha256File } from "../sqlite-snapshot-utils.mjs";
import {
  restoreDrill,
  stageRecoveryFiles,
  timescaleUsabilitySql,
} from "../stugu-restore-drill.mjs";

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "stugu-restore-drill-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function sqlite(path, table, rows) {
  const database = new DatabaseSync(path);
  database.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
  const insert = database.prepare(`INSERT INTO ${table} (id) VALUES (?)`);
  for (const value of rows) insert.run(value);
  database.close();
}

function stugubyIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    version: 1,
    nodeId: "restore-test-node",
    displayName: "Restore test",
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    createdAt: "2026-07-30T12:00:00.000Z",
  };
}

async function record(root, relativePath, category) {
  const path = join(root, ...relativePath.split("/"));
  return {
    path: relativePath,
    category,
    size: statSync(path).size,
    sha256: await sha256File(path),
    sensitive: true,
  };
}

async function recoveryFixture(t) {
  const directory = temporaryDirectory(t);
  const backup = join(directory, "backup");
  mkdirSync(join(backup, "databases"), { recursive: true });
  mkdirSync(join(backup, "assets", "floorplans"), { recursive: true });
  mkdirSync(join(backup, "secrets"), { recursive: true });
  mkdirSync(join(backup, "restore"), { recursive: true });

  sqlite(join(backup, "databases", "climate-twin.sqlite"), "homes", ["home-1", "home-2"]);
  sqlite(join(backup, "databases", "experimental-spatial-layers.sqlite"), "layers", ["layer-1"]);
  writeFileSync(join(backup, "assets", "floorplans", "ground.txt"), "floor plan");
  writeFileSync(join(backup, "secrets", "integration-secrets.json"), '{"version":1}\n');
  writeFileSync(join(backup, "secrets", "tracking-secret.key"),
    `${Buffer.alloc(32, 9).toString("base64url")}\n`);
  writeFileSync(join(backup, "secrets", "stuguby-identity.json"),
    `${JSON.stringify(stugubyIdentity())}\n`);
  writeFileSync(join(backup, "databases", "telemetry.pgdump"), "fake custom-format dump");
  writeFileSync(join(backup, "restore", "validate-timescale-ownership.sql"), "SELECT 1;\n");

  const files = await Promise.all([
    record(backup, "databases/climate-twin.sqlite", "core-sqlite"),
    record(backup, "databases/experimental-spatial-layers.sqlite", "spatial-sqlite"),
    record(backup, "assets/floorplans/ground.txt", "asset"),
    record(backup, "secrets/integration-secrets.json", "integration-secrets"),
    record(backup, "secrets/tracking-secret.key", "tracking-secret-key"),
    record(backup, "secrets/stuguby-identity.json", "stuguby-identity"),
    record(backup, "databases/telemetry.pgdump", "timescale-pgdump"),
    record(backup, "restore/validate-timescale-ownership.sql", "timescale-ownership-validation"),
  ]);
  const manifest = {
    format: "stugu-backup",
    version: 2,
    verification: { status: "passed" },
    files,
    sources: {
      coreDatabase: { status: "included", inventory: { tables: [{ name: "homes", rows: 2 }] } },
      spatialDatabase: { status: "included", inventory: { tables: [{ name: "layers", rows: 1 }] } },
      assets: { status: "included", files: 1, bytes: Buffer.byteLength("floor plan") },
      integrationSecrets: { status: "included" },
      trackingSecretKey: { status: "included" },
      stugubyIdentity: { status: "included" },
      timescale: {
        status: "included",
        scope: "full-database",
        telemetrySchema: "telemetry",
        restore: {
          applicationRole: "stuga_app",
          ownershipValidation: { file: "restore/validate-timescale-ownership.sql" },
        },
      },
    },
  };
  writeFileSync(join(backup, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { backup, directory, manifest };
}

function telemetrySummary(overrides = {}) {
  return {
    schema: "telemetry",
    relations: 12,
    hypertables: 6,
    continuousAggregates: 4,
    tables: [
      "measurement_samples",
      "legacy_readings",
      "outdoor_temperature_samples",
      "electricity_price_samples",
      "opening_state_samples",
      "heat_pump_state_samples",
    ].map((name) => ({ name, rows: "2", firstAt: "2026-07-30 10:00:00+00", lastAt: "2026-07-30 11:00:00+00" })),
    ...overrides,
  };
}

test("recovery staging reconstructs and validates every backed-up runtime file", async (t) => {
  const { backup, directory, manifest } = await recoveryFixture(t);
  const target = join(directory, "recovered");
  const result = await stageRecoveryFiles(backup, manifest, target);

  assert.deepEqual(result.controls, [
    "integration-secrets",
    "stuguby-identity",
    "tracking-secret-key",
  ]);
  assert.equal(result.assets, 1);
  assert.equal(result.coreTables, 1);
  assert.equal(result.spatialTables, 1);
  assert.equal(readFileSync(join(target, "data", "assets", "floorplans", "ground.txt"), "utf8"), "floor plan");
  const recoveredDatabase = new DatabaseSync(join(target, "data", "climate-twin.sqlite"), { readOnly: true });
  assert.equal(recoveredDatabase.prepare("SELECT COUNT(*) AS count FROM homes").get().count, 2);
  recoveredDatabase.close();
  assert.equal(existsSync(join(target, "restore", "validate-timescale-ownership.sql")), true);
});

test("recovery staging rejects a checksummed but unusable control secret", async (t) => {
  const { backup, directory, manifest } = await recoveryFixture(t);
  const keyPath = join(backup, "secrets", "tracking-secret.key");
  writeFileSync(keyPath, "not-a-32-byte-key\n");
  const keyRecord = manifest.files.find(({ category }) => category === "tracking-secret-key");
  keyRecord.size = statSync(keyPath).size;
  keyRecord.sha256 = await sha256File(keyPath);

  await assert.rejects(
    stageRecoveryFiles(backup, manifest, join(directory, "invalid-recovery")),
    /tracking key/u,
  );
});

test("restore drill verifies, stages, restores, validates ownership and reads every telemetry family", async (t) => {
  const { backup, directory } = await recoveryFixture(t);
  const passwordFile = join(directory, "admin-password");
  writeFileSync(passwordFile, "test-only-admin-password\n");
  const calls = [];
  let verified = false;
  const before = new Set(readdirSync(directory));
  const result = await restoreDrill(backup, {
    TIMESERIES_ADMIN_PASSWORD_FILE: passwordFile,
    TIMESERIES_HOST: "timescale.test",
    TIMESERIES_PORT: "5433",
    TIMESERIES_DATABASE: "stugu",
    TIMESERIES_ADMIN_USER: "stuga_admin",
    TIMESERIES_SSL_MODE: "disable",
  }, {
    randomSuffix: () => "0123456789abcdef",
    now: () => new Date("2026-07-30T12:30:00.000Z"),
    async verifyBackup(path) {
      assert.equal(path, backup);
      verified = true;
    },
    async runCommand(command, args, environment) {
      calls.push({ command, args });
      assert.equal(environment.PGPASSWORD, "test-only-admin-password");
      assert.equal(environment.PGSSLMODE, "disable");
      const sql = args[args.indexOf("-c") + 1];
      if (command === "psql" && typeof sql === "string" && sql.includes("$stugu_recovery_read$")) {
        return `${JSON.stringify(telemetrySummary())}\n`;
      }
      return "";
    },
  });

  assert.equal(verified, true);
  assert.equal(result.database, "stuga_drill_0123456789abcdef");
  assert.equal(result.restoredAt, "2026-07-30T12:30:00.000Z");
  assert.equal(result.staged.assets, 1);
  assert.equal(result.telemetry.hypertables, 6);
  assert.deepEqual(calls.map(({ command }) => command), [
    "createdb", "psql", "pg_restore", "psql", "psql", "psql", "dropdb",
  ]);
  assert.ok(calls[0].args.includes("--maintenance-db"));
  assert.ok(calls[2].args.includes("--no-privileges"));
  assert.ok(calls[2].args.includes("--no-tablespaces"));
  assert.equal(calls[2].args.includes("--no-owner"), false);
  assert.match(calls[4].args.at(-1), /\.stugu-restore-drill-.+validate-timescale-ownership\.sql$/u);
  const usabilitySql = calls[5].args.at(-1);
  assert.match(usabilitySql, /SET ROLE "stuga_app"/u);
  for (const table of telemetrySummary().tables) assert.match(usabilitySql, new RegExp(table.name, "u"));
  assert.deepEqual(new Set(readdirSync(directory)), before);
  assert.equal(calls.flatMap(({ args }) => args).includes("test-only-admin-password"), false);
});

test("restore drill fails closed when the restored telemetry inventory is incomplete", async (t) => {
  const { backup, directory } = await recoveryFixture(t);
  const passwordFile = join(directory, "admin-password");
  writeFileSync(passwordFile, "test-only-admin-password\n");
  const commands = [];
  await assert.rejects(restoreDrill(backup, {
    TIMESERIES_ADMIN_PASSWORD_FILE: passwordFile,
  }, {
    randomSuffix: () => "fedcba9876543210",
    verifyBackup: async () => {},
    async runCommand(command, args) {
      commands.push(command);
      const sql = args[args.indexOf("-c") + 1];
      return command === "psql" && typeof sql === "string" && sql.includes("$stugu_recovery_read$")
        ? `${JSON.stringify(telemetrySummary({ hypertables: 5 }))}\n`
        : "";
    },
  }), /invalid inventory/u);
  assert.equal(commands.at(-1), "dropdb");
  assert.equal(readdirSync(directory).some((name) => name.startsWith(".stugu-restore-drill-")), false);
});

test("Timescale usability SQL probes all restored relations as the application role", () => {
  const sql = timescaleUsabilitySql("telemetry", "stuga_app");
  assert.match(sql, /SET ROLE "stuga_app"/u);
  assert.match(sql, /SELECT 1 FROM %I\.%I LIMIT 1/u);
  assert.match(sql, /timescaledb_information\.hypertables/u);
  assert.match(sql, /timescaledb_information\.continuous_aggregates/u);
  for (const table of [
    "measurement_samples",
    "legacy_readings",
    "outdoor_temperature_samples",
    "electricity_price_samples",
    "opening_state_samples",
    "heat_pump_state_samples",
  ]) assert.match(sql, new RegExp(table, "u"));
});
