import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
} from "../stuga-backup.mjs";
import { openReadOnlySqlite, sha256File } from "../sqlite-snapshot-utils.mjs";

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "stuga-data-safety-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function createTelemetryFixture(path, {
  duplicateReading = false,
  equivalentInstantKeys = false,
  outdoorConditionsJson = undefined,
} = {}) {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE measurement_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sensor_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      canonical_unit TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      source TEXT NOT NULL,
      quality TEXT NOT NULL,
      UNIQUE(sensor_id, metric, timestamp, source)
    );
    CREATE TABLE readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sensor_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      temperature REAL NOT NULL,
      humidity REAL NOT NULL,
      battery REAL,
      source TEXT NOT NULL,
      quality TEXT NOT NULL
    );
    CREATE TABLE outdoor_temperature_samples (
      house_id TEXT NOT NULL,
      location_key TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      temperature_c REAL NOT NULL,
      source TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      station_id TEXT,
      station_name TEXT,
      PRIMARY KEY(house_id, location_key, timestamp, source)
    );
    CREATE TABLE electricity_price_points (
      property_id TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      raw_price_cents_per_kwh REAL NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY(property_id, start_at)
    );
    INSERT INTO measurement_samples
      (sensor_id, metric, value, canonical_unit, timestamp, source, quality)
      VALUES ('sensor-1', 'temperature', 19.5, 'degC', '2026-07-18T10:00:00.000Z', 'api', 'good');
    INSERT INTO readings
      (sensor_id, timestamp, temperature, humidity, battery, source, quality)
      VALUES ('sensor-1', '2026-07-18T10:00:00.000Z', 19.5, 52, 88, 'api', 'good');
    INSERT INTO outdoor_temperature_samples
      (house_id, location_key, timestamp, temperature_c, source, fetched_at, station_id, station_name)
      VALUES ('house-1', 'yard', '2026-07-18T10:00:00.000Z', 17.2, 'fmi-observation',
        '2026-07-18T10:01:00.000Z', 'station-1', 'Test station');
    INSERT INTO electricity_price_points
      (property_id, start_at, end_at, raw_price_cents_per_kwh, fetched_at)
      VALUES ('property-1', '2026-07-18T10:00:00.000Z', '2026-07-18T11:00:00.000Z', 6.4,
        '2026-07-18T09:00:00.000Z');
  `);
  if (duplicateReading) {
    database.exec(`INSERT INTO readings
      (sensor_id, timestamp, temperature, humidity, battery, source, quality)
      VALUES ('sensor-1', '2026-07-18T10:00:00.000Z', 20, 53, 87, 'api', 'estimated')`);
  }
  if (equivalentInstantKeys) {
    database.exec(`
      INSERT INTO measurement_samples
        (sensor_id, metric, value, canonical_unit, timestamp, source, quality)
        VALUES ('sensor-1', 'temperature', 20, 'degC', '2026-07-18T12:00:00.000+02:00', 'api', 'good');
      INSERT INTO readings
        (sensor_id, timestamp, temperature, humidity, battery, source, quality)
        VALUES ('sensor-1', '2026-07-18T12:00:00.000+02:00', 20, 53, 87, 'api', 'estimated');
      INSERT INTO outdoor_temperature_samples
        (house_id, location_key, timestamp, temperature_c, source, fetched_at, station_id, station_name)
        VALUES ('house-1', 'yard', '2026-07-18T12:00:00.000+02:00', 17.3, 'fmi-observation',
          '2026-07-18T12:01:00.000+02:00', 'station-1', 'Test station');
      INSERT INTO electricity_price_points
        (property_id, start_at, end_at, raw_price_cents_per_kwh, fetched_at)
        VALUES ('property-1', '2026-07-18T12:00:00.000+02:00', '2026-07-18T13:00:00.000+02:00', 6.5,
          '2026-07-18T11:00:00.000+02:00');
    `);
  }
  if (outdoorConditionsJson !== undefined) {
    database.exec("ALTER TABLE outdoor_temperature_samples ADD COLUMN conditions_json TEXT");
    database.prepare("UPDATE outdoor_temperature_samples SET conditions_json = ?").run(outdoorConditionsJson);
  }
  return database;
}

test("dry-run inventories all telemetry without changing the SQLite source", async (t) => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "source.sqlite");
  const writer = createTelemetryFixture(source);
  const before = await sha256File(source);
  try {
    const options = parseMigrationArgs(["--source", source, "--dry-run"], {});
    const inventory = await runDryMigration(options);
    assert.equal(inventory.measurement_samples.rows, 1);
    assert.equal(inventory.readings.rows, 1);
    assert.equal(inventory.outdoor_temperature_samples.rows, 1);
    assert.equal(inventory.outdoor_temperature_samples.optionalJsonColumns.conditions_json.present, false);
    assert.equal(inventory.outdoor_temperature_samples.optionalJsonColumns.conditions_json.populatedRows, 0);
    assert.equal(inventory.electricity_price_points.rows, 1);
    assert.equal(await sha256File(source), before);
    assert.equal(existsSync(options.snapshot), false);
    assert.equal(existsSync(options.checkpoint), false);
  } finally {
    writer.close();
  }
});

test("duplicate legacy reading keys are reported before an import can collapse them", (t) => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "duplicates.sqlite");
  const writer = createTelemetryFixture(source, { duplicateReading: true });
  writer.close();
  const database = openReadOnlySqlite(source);
  try {
    const inventory = inventoryTelemetrySource(database);
    assert.equal(inventory.readings.duplicateKeyRows, 1);
  } finally {
    database.close();
  }
});

test("preflight rejects equivalent timestamp instants across every destination natural key", async (t) => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "equivalent-instants.sqlite");
  const writer = createTelemetryFixture(source, { equivalentInstantKeys: true });
  writer.close();
  const database = openReadOnlySqlite(source);
  try {
    const inventory = inventoryTelemetrySource(database);
    for (const table of [
      "measurement_samples",
      "readings",
      "outdoor_temperature_samples",
      "electricity_price_points",
    ]) {
      assert.equal(inventory[table].duplicateKeyRows, 1, table);
      assert.equal(inventory[table].minimumTime, "2026-07-18T10:00:00.000000Z", table);
    }
  } finally {
    database.close();
  }

  const options = parseMigrationArgs(["--source", source, "--dry-run"], {});
  await assert.rejects(
    runDryMigration(options),
    /Migration preflight blocked:[\s\S]*measurement_samples[\s\S]*readings[\s\S]*outdoor_temperature_samples[\s\S]*electricity_price_points/u,
  );
});

test("outdoor condition JSON is inventoried and preserved losslessly in Timescale metadata", async (t) => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "outdoor-conditions.sqlite");
  const conditionsJson = "{\"timestamp\":\"2026-07-18T10:00:00.000Z\",\"precipitation1hMm\":0.1234567890123456789}";
  const writer = createTelemetryFixture(source, { outdoorConditionsJson: conditionsJson });
  writer.close();
  const database = openReadOnlySqlite(source);
  let payload;
  try {
    const inventory = inventoryTelemetrySource(database);
    assert.equal(inventory.outdoor_temperature_samples.invalidJsonValues, 0);
    assert.equal(inventory.outdoor_temperature_samples.optionalJsonColumns.conditions_json.present, true);
    assert.equal(inventory.outdoor_temperature_samples.optionalJsonColumns.conditions_json.populatedRows, 1);
    payload = mapRows("outdoor_temperature_samples", [
      database.prepare("SELECT * FROM outdoor_temperature_samples").get(),
    ]);
  } finally {
    database.close();
  }
  assert.equal(payload[0].conditions_json, conditionsJson);
  assert.equal("metadata" in payload[0], false);

  const queries = [];
  const client = {
    async query(text, values = []) {
      const sql = String(text);
      queries.push({ text: sql, values });
      if (sql.includes("AS expected_rows")) {
        return {
          rows: [{
            expected_rows: "1",
            found_rows: "1",
            matching_rows: "1",
            minimum_time: "2026-07-18T10:00:00.000Z",
            maximum_time: "2026-07-18T10:00:00.000Z",
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  await upsertBatch(client, "telemetry", "outdoor_temperature_samples", payload);
  const verification = await verifyBatch(client, "telemetry", "outdoor_temperature_samples", payload);
  assert.equal(verification.matchingRows, 1);
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.match(query.text, /jsonb_build_object\('conditions',[\s\S]+"conditions_json"::jsonb\)/u);
    assert.equal(JSON.parse(query.values[0])[0].conditions_json, conditionsJson);
  }
  assert.match(queries[1].text, /actual\."metadata" IS NOT DISTINCT FROM expected\."metadata"/u);
});

test("preflight rejects malformed optional outdoor condition JSON", async (t) => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "invalid-outdoor-conditions.sqlite");
  const writer = createTelemetryFixture(source, { outdoorConditionsJson: "{not-json" });
  writer.close();
  const database = openReadOnlySqlite(source);
  try {
    const inventory = inventoryTelemetrySource(database);
    assert.equal(inventory.outdoor_temperature_samples.invalidJsonValues, 1);
    assert.equal(inventory.outdoor_temperature_samples.optionalJsonColumns.conditions_json.present, true);
    assert.equal(inventory.outdoor_temperature_samples.optionalJsonColumns.conditions_json.populatedRows, 1);
  } finally {
    database.close();
  }
  await assert.rejects(
    runDryMigration(parseMigrationArgs(["--source", source, "--dry-run"], {})),
    /outdoor_temperature_samples has 1 invalid optional JSON value/u,
  );
});

test("database tools accept app TIMESERIES_* settings without constructing credential URLs", () => {
  const environment = {
    TIMESERIES_HOST: "timescaledb.internal",
    TIMESERIES_PORT: "5544",
    TIMESERIES_DATABASE: "stuga_test",
    TIMESERIES_USER: "stuga_user",
    TIMESERIES_PASSWORD: "fixture-password-never-log",
  };
  const migration = parseMigrationArgs(["--source", "fixture.sqlite"], environment);
  assert.deepEqual(migration.pgClientConfig, {
    host: "timescaledb.internal",
    port: 5544,
    database: "stuga_test",
    user: "stuga_user",
    password: "fixture-password-never-log",
  });
  assert.equal("connectionString" in migration.pgClientConfig, false);
  assert.equal(migration.maintenanceTimeoutMs, 30 * 60 * 1_000);

  const backup = parseBackupArgs(["--include-timescale"], environment);
  assert.deepEqual(backup.pgConnectionEnvironment, {
    PGHOST: "timescaledb.internal",
    PGPORT: "5544",
    PGDATABASE: "stuga_test",
    PGUSER: "stuga_user",
    PGPASSWORD: "fixture-password-never-log",
  });
  assert.equal(backup.applicationRole, "stuga_user");
  assert.equal(backup.adminRole, "stuga_admin");
});

test("migration destination identity survives transport changes but distinguishes database volumes", async () => {
  const sql = [];
  const clientFor = (databaseOid) => ({
    async query(text) {
      sql.push(String(text));
      return {
        rows: [{ database: "stuga", username: "stuga_app", database_oid: databaseOid }],
        rowCount: 1,
      };
    },
  });

  const beforeRestart = await destinationFingerprint(clientFor("16384"), "telemetry");
  const afterRestart = await destinationFingerprint(clientFor("16384"), "telemetry");
  const otherDatabase = await destinationFingerprint(clientFor("24576"), "telemetry");

  assert.equal(beforeRestart, afterRestart);
  assert.notEqual(beforeRestart, otherDatabase);
  assert.equal(sql.every((statement) => !/inet_server_(?:addr|port)/u.test(statement)), true);
  assert.equal(sql.every((statement) => /pg_database/u.test(statement)), true);
});

test("checkpoint locks recover across one-off container hostnames only under the database advisory lock", (t) => {
  const directory = temporaryDirectory(t);
  const checkpoint = join(directory, "migration.json");
  const lockPath = `${checkpoint}.lock`;
  const releaseFirst = acquireCheckpointLock(checkpoint, {
    destinationFingerprint: "durable-database-a",
    host: "one-off-container-a",
    pid: 101,
    processExistsFn: () => true,
  });
  assert.equal(existsSync(lockPath), true);

  assert.throws(() => acquireCheckpointLock(checkpoint, {
    destinationFingerprint: "durable-database-a",
    advisoryLockHeld: false,
    host: "one-off-container-b",
    pid: 202,
  }), /Another migration appears/u);

  const releaseReplacement = acquireCheckpointLock(checkpoint, {
    destinationFingerprint: "durable-database-a",
    advisoryLockHeld: true,
    host: "one-off-container-b",
    pid: 202,
  });
  const replacement = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(replacement.host, "one-off-container-b");

  // A delayed cleanup from the dead owner cannot remove its successor's lock.
  releaseFirst();
  assert.equal(existsSync(lockPath), true);
  assert.throws(() => acquireCheckpointLock(checkpoint, {
    destinationFingerprint: "different-database",
    advisoryLockHeld: true,
    host: "one-off-container-c",
    pid: 303,
  }), /Another migration appears/u);

  releaseReplacement();
  assert.equal(existsSync(lockPath), false);
});

test("Timescale recovery preserves roles and records fail-closed ownership validation", (t) => {
  const output = temporaryDirectory(t);
  const options = parseBackupArgs([], {
    TIMESERIES_USER: "stuga_app",
    TIMESERIES_ADMIN_USER: "stuga_admin",
  });
  options.output = output;
  const dump = join(output, "databases", "telemetry.pgdump");
  const validator = join(output, "restore", "validate-timescale-ownership.sql");
  const dumpArguments = timescaleDumpArguments(dump);
  assert.equal(dumpArguments.includes("--no-owner"), false);
  assert.equal(dumpArguments.includes("--no-privileges"), true);

  const plan = timescaleRestorePlan(options, dump, validator);
  assert.equal(plan.ownershipMode, "preserve-source-roles");
  assert.deepEqual(plan.requiredRoles, ["stuga_admin", "stuga_app"]);
  assert.doesNotMatch(plan.command, /--no-owner/u);
  assert.match(plan.command, /--no-privileges/u);
  assert.match(plan.preRestoreSql, /Refusing to restore over non-empty schema/u);
  assert.match(plan.preRestoreSql, /DROP SCHEMA/u);
  assert.match(plan.preRestoreSql, /timescaledb_pre_restore/u);
  assert.equal(plan.restoreDrill.status, "not-performed");
  assert.match(plan.ownershipValidation.command, /validate-timescale-ownership\.sql/u);

  const sql = timescaleOwnershipValidationSql("telemetry", "stuga_app");
  assert.match(sql, /timescaledb_information\.chunks/u);
  assert.match(sql, /timescaledb_information\.continuous_aggregates/u);
  assert.match(sql, /materialization_hypertable_schema/u);
  assert.match(sql, /Continuous aggregate chunks have unexpected owners/u);

  const preRestore = timescalePreRestoreSql("telemetry");
  assert.match(preRestore, /namespace\.nspname = 'telemetry'/u);
  assert.match(preRestore, /existing_relations > 0/u);
});

test("migration requires and validates canonical hypertables under a dedicated maintenance timeout", async () => {
  const queries = [];
  const client = {
    async query(text, values = []) {
      queries.push({ text: String(text), values });
      if (String(text).includes("FROM pg_extension")) {
        return { rows: [{ timescale_version: "2.28.3" }], rowCount: 1 };
      }
      if (String(text).includes("timescaledb_information.hypertables")) {
        return { rows: [{ configured: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const result = await provisionDestination(client, "telemetry", 123_456);
  assert.equal(result.version, "2.28.3");
  assert.deepEqual(result.hypertables, MIGRATION_HYPERTABLES.map(({ table }) => table));
  assert.ok(queries.some(({ text }) => text === "CREATE EXTENSION IF NOT EXISTS timescaledb"));
  assert.ok(queries.some(({ text, values }) => (
    text.includes("set_config('statement_timeout'") && values[0] === "123456ms"
  )));
  assert.equal(queries.filter(({ text }) => text.includes("create_hypertable(")).length, 4);
  assert.equal(queries.filter(({ text }) => text.includes("set_chunk_time_interval(")).length, 4);
  const schemaSql = queries.find(({ text }) => text.includes("CREATE TABLE IF NOT EXISTS \"telemetry\".measurement_samples"))?.text;
  assert.match(schemaSql, /archive_source_state/u);
  assert.match(schemaSql, /VALUES \(2, 'Checkpointed SQLite archive reconciliation/u);
});

test("hypertable validation fails closed and conflicts never overwrite destination rows", async () => {
  const invalidClient = {
    async query() {
      return { rows: [{ configured: false }], rowCount: 1 };
    },
  };
  await assert.rejects(
    validateExpectedHypertables(invalidClient, "telemetry"),
    /missing or misconfigured/u,
  );

  const writes = [];
  const writeClient = {
    async query(text, values) {
      writes.push({ text: String(text), values });
      return { rows: [], rowCount: 0 };
    },
  };
  await upsertBatch(writeClient, "telemetry", "measurement_samples", [{
    sensor_id: "sensor-1",
    metric: "temperature",
    observed_at: "2026-07-18T10:00:00.000Z",
    source: "api",
    value: 20,
    canonical_unit: "degC",
    quality: "good",
    metadata: {},
  }]);
  assert.match(writes[0].text, /ON CONFLICT[\s\S]+DO NOTHING/u);
  assert.doesNotMatch(writes[0].text, /DO UPDATE/u);
});

test("historical import refreshes and verifies every fixed measurement aggregate", async () => {
  const queries = [];
  const client = {
    async query(text, values = []) {
      const sql = String(text);
      queries.push({ text: sql, values });
      if (sql.includes("FROM pg_class relation")) {
        return { rows: [{ relkind: "m" }], rowCount: 1 };
      }
      if (sql.includes("timescaledb_information.continuous_aggregates")) {
        return { rows: [{ configured: true }], rowCount: 1 };
      }
      if (sql.includes("AS range_start")) {
        return {
          rows: [{
            range_start: new Date("2026-07-18T10:00:00.000Z"),
            range_end: new Date("2026-07-19T00:00:00.000Z"),
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("AS raw_samples")) {
        return { rows: [{ raw_samples: "2", aggregate_samples: "2" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const reports = await ensureAndRefreshMeasurementAggregates(client, "telemetry", {
    rows: 2,
    minimumTime: "2026-07-18T10:01:00.000Z",
    maximumTime: "2026-07-18T10:02:00.000Z",
  }, 654_321);

  assert.equal(reports.length, 3);
  assert.deepEqual(reports.map(({ name }) => name), MIGRATION_AGGREGATES.map(({ name }) => name));
  assert.equal(reports.every(({ refreshed }) => refreshed), true);
  assert.equal(reports.every(({ rawSamples }) => rawSamples === "2"), true);
  assert.equal(reports.every(({ aggregateSamples }) => aggregateSamples === "2"), true);
  assert.equal(queries.filter(({ text }) => text.includes("CALL refresh_continuous_aggregate")).length, 3);
  assert.ok(queries.some(({ text, values }) => (
    text.includes("set_config('statement_timeout'") && values[0] === "654321ms"
  )));
});

test("new continuous aggregates are created empty and refreshed outside the DDL transaction", async () => {
  const queries = [];
  const catalogChecks = new Map();
  const client = {
    async query(text, values = []) {
      const sql = String(text);
      queries.push({ text: sql, values });
      if (sql.includes("FROM pg_class relation")) return { rows: [], rowCount: 0 };
      if (sql.includes("timescaledb_information.continuous_aggregates")) {
        const aggregate = String(values[1]);
        const checks = catalogChecks.get(aggregate) ?? 0;
        catalogChecks.set(aggregate, checks + 1);
        return { rows: [{ configured: checks > 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  await ensureAndRefreshMeasurementAggregates(client, "telemetry", { rows: 0 }, 30_000);

  const createIndexes = queries
    .map(({ text }, index) => ({ text, index }))
    .filter(({ text }) => text.includes("CREATE MATERIALIZED VIEW"));
  const commitIndex = queries.findIndex(({ text }) => text === "COMMIT");
  assert.equal(createIndexes.length, 3);
  assert.equal(createIndexes.every(({ text, index }) => text.includes("WITH NO DATA") && index < commitIndex), true);
  assert.equal(queries.some(({ text }) => text.includes("WITH DATA")), false);
});

test("Timescale 2.28 catalog views are retained as continuous aggregates", async () => {
  const queries = [];
  const client = {
    async query(text, values = []) {
      const sql = String(text);
      queries.push({ text: sql, values });
      if (sql.includes("timescaledb_information.continuous_aggregates")) {
        return { rows: [{ configured: true }], rowCount: 1 };
      }
      // Actual Timescale 2.28 CAGGs are relkind='v'. Reaching this branch
      // would reproduce the unsafe DROP VIEW behavior that this guards.
      if (sql.includes("FROM pg_class relation")) {
        return { rows: [{ relkind: "v" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const reports = await ensureAndRefreshMeasurementAggregates(
    client,
    "telemetry",
    { rows: 0 },
    30_000,
  );

  assert.equal(reports.length, 3);
  assert.equal(reports.every(({ created, refreshed }) => created === false && refreshed === false), true);
  assert.equal(queries.some(({ text }) => text.includes("FROM pg_class relation")), false);
  assert.equal(queries.some(({ text }) => text.startsWith("DROP VIEW")), false);
  assert.equal(queries.some(({ text }) => text.includes("CREATE MATERIALIZED VIEW")), false);
});

test("runtime database and proxy credentials are generated once without fixed defaults", (t) => {
  const directory = temporaryDirectory(t);
  const script = fileURLToPath(new URL("../init-runtime-secrets.mjs", import.meta.url));
  const paths = {
    "timeseries-admin-password": join(directory, "admin", "password"),
    "timeseries-password": join(directory, "app", "password"),
    "local-auth-proxy-secret": join(directory, "proxy", "secret"),
  };
  const environment = {
    ...process.env,
    STUGA_TIMESERIES_ADMIN_SECRET_PATH: paths["timeseries-admin-password"],
    STUGA_TIMESERIES_APP_SECRET_PATH: paths["timeseries-password"],
    STUGA_PROXY_SECRET_PATH: paths["local-auth-proxy-secret"],
  };
  execFileSync(process.execPath, [script], { env: environment, stdio: "pipe" });
  const first = Object.fromEntries([
    "timeseries-admin-password", "timeseries-password", "local-auth-proxy-secret",
  ].map((name) => [
    name,
    readFileSync(paths[name], "utf8").trim(),
  ]));
  execFileSync(process.execPath, [script], { env: environment, stdio: "pipe" });
  for (const [name, value] of Object.entries(first)) {
    assert.ok(Buffer.byteLength(value, "utf8") >= 32);
    assert.equal(readFileSync(paths[name], "utf8").trim(), value);
  }
});

test("backup creates and re-verifies snapshots, assets, manifest, and opt-in fake secrets", async (t) => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "source.sqlite");
  const writer = createTelemetryFixture(source);

  const spatial = join(directory, "spatial.sqlite");
  const spatialWriter = new DatabaseSync(spatial);
  spatialWriter.exec("CREATE TABLE layers (id TEXT PRIMARY KEY); INSERT INTO layers VALUES ('layer-1')");
  spatialWriter.close();

  const assets = join(directory, "assets");
  mkdirSync(join(assets, "floorplans"), { recursive: true });
  writeFileSync(join(assets, "floorplans", "ground.txt"), "fixture floor plan\n");
  const secrets = join(directory, "integration-secrets.json");
  writeFileSync(secrets, '{"version":1,"fakeToken":"test-only"}\n');
  const output = join(directory, "backup");
  try {
    const options = parseBackupArgs([
      "--database", source,
      "--output", output,
      "--assets", assets,
      "--spatial-db", spatial,
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
