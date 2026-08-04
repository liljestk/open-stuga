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
  backupCapacity,
  backupMinFreeBytes,
  createBackup,
  parseBackupArgs,
  timescaleDumpArguments,
  timescaleOwnershipValidationSql,
  timescalePreRestoreSql,
  timescaleRestorePlan,
  verifyBackup,
} from "../stugu-backup.mjs";

import {
  backupArguments,
  boundedSchedulerInteger,
  schedulerTimestampDue,
} from "../stugu-backup-scheduler.mjs";

import { openReadOnlySqlite, sha256File } from "../sqlite-snapshot-utils.mjs";

import { createTelemetryFixture, temporaryDirectory } from "./data-safety-test-support.mjs";

test("scheduled backups include protected integration data only when its file exists", () => {
  const withoutSecrets = backupArguments("/app/backups/without-secrets", false);
  assert.equal(withoutSecrets.includes("--include-timescale"), true);
  assert.equal(withoutSecrets.includes("--include-secrets"), false);
  assert.deepEqual(withoutSecrets.slice(-2), ["--output", "/app/backups/without-secrets"]);

  const withSecrets = backupArguments("/app/backups/with-secrets", true);
  assert.deepEqual(
    withSecrets.slice(-5),
    ["--include-secrets", "--secrets-file", "/app/data/integration-secrets.json", "--output", "/app/backups/with-secrets"],
  );
});

test("backup capacity reserve is exact and fails closed for invalid configuration", () => {
  assert.equal(backupMinFreeBytes(undefined), 1024 ** 3);
  assert.equal(backupMinFreeBytes(" 2147483648 "), 2 * 1024 ** 3);
  for (const value of ["-1", "1.5", "Infinity", "not-a-size"]) {
    assert.throws(() => backupMinFreeBytes(value), /BACKUP_MIN_FREE_BYTES/u);
  }

  assert.deepEqual(backupCapacity(3_000_000_000n, 1_500_000_000, 1_000_000_000), {
    availableBytes: "3000000000",
    requiredBytes: "2500000000",
    minimumFreeBytes: "1000000000",
    sufficient: true,
  });
  assert.equal(
    backupCapacity(2_499_999_999n, 1_500_000_000, 1_000_000_000).sufficient,
    false,
  );
  assert.equal(
    backupCapacity(18_446_744_073_709_551_615n, 1, 0).availableBytes,
    "18446744073709551615",
  );
});

test("scheduled backup retention fails closed for malformed or unsafe values", () => {
  assert.equal(boundedSchedulerInteger(undefined, 30, 2, 10_000, "BACKUP_RETENTION_COUNT"), 30);
  assert.equal(boundedSchedulerInteger(" 45 ", 30, 2, 10_000, "BACKUP_RETENTION_COUNT"), 45);
  for (const value of ["garbage", "NaN", "Infinity", "1.5", "1", "10001"]) {
    assert.throws(
      () => boundedSchedulerInteger(value, 30, 2, 10_000, "BACKUP_RETENTION_COUNT"),
      /BACKUP_RETENTION_COUNT must be a whole number from 2 to 10000/u,
    );
  }
});

test("scheduled backups and restore drills fail safe when status timestamps are corrupt", () => {
  const now = Date.parse("2026-08-01T12:00:00.000Z");
  const interval = 24 * 60 * 60_000;
  assert.equal(schedulerTimestampDue(null, interval, now), true);
  assert.equal(schedulerTimestampDue("not-a-date", interval, now), true);
  assert.equal(schedulerTimestampDue("2026-08-02T12:00:00.000Z", interval, now), true);
  assert.equal(schedulerTimestampDue("2026-08-01T00:00:00.000Z", interval, now), false);
  assert.equal(schedulerTimestampDue("2026-07-31T12:00:00.000Z", interval, now), true);
});

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
    assert.equal(inventory.opening_state_observations.rows, 1);
    assert.equal(inventory.heat_pump_state_history.rows, 1);
    assert.equal(await sha256File(source), before);
    assert.equal(existsSync(options.snapshot), false);
    assert.equal(existsSync(options.checkpoint), false);
  } finally {
    writer.close();
  }
});

test("migration maps electricity margin, opening events, and typed heat-pump observations", (t) => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "event-history.sqlite");
  const writer = createTelemetryFixture(source);
  writer.close();
  const database = openReadOnlySqlite(source);
  try {
    const price = mapRows("electricity_price_points", [
      database.prepare("SELECT * FROM electricity_price_points").get(),
    ])[0];
    assert.equal(price.margin_cents_per_kwh, 0.45);
    const opening = mapRows("opening_state_observations", [
      database.prepare("SELECT * FROM opening_state_observations").get(),
    ])[0];
    assert.deepEqual(opening, {
      observation_id: "opening-1",
      house_id: "house-1",
      floor_id: "floor-1",
      element_id: "door-1",
      observed_at: "2026-07-18T10:00:00.000Z",
      source: "api",
      state: "open",
      open_fraction: 1,
      valid_until: null,
      external_id: "binary_sensor.door",
      connection_id: "ha-1",
      recorded_at: "2026-07-18T10:00:01.000Z",
      metadata: {},
    });
    const heatPumpSource = database.prepare("SELECT * FROM heat_pump_state_history").get();
    const heatPump = mapRows("heat_pump_state_history", [heatPumpSource])[0];
    assert.deepEqual(heatPump, {
      connection_id: "gree-aabbccddeeff",
      house_id: "house-1",
      equipment_id: null,
      device_id: "AABBCCDDEEFF",
      name: "Nordkapp",
      brand: "Wilfa",
      model: "Nordkapp 30",
      transport: "local",
      floor_id: null,
      room_id: null,
      x: null,
      y: null,
      z: null,
      observed_at: "2026-07-18T10:00:00.000Z",
      received_at: "2026-07-18T10:00:01.000Z",
      available: true,
      power: true,
      selected_mode: "cool",
      target_temperature_c: 22,
      current_temperature_c: 25.5,
      current_temperature_source: "reported",
      fan_speed: "Auto",
      horizontal_swing: null,
      vertical_swing: "FullSwing",
      quiet: false,
      turbo: false,
      xfan: true,
      compressor_frequency_hz: null,
      diagnostics: {},
      activity: "unknown",
      activity_evidence: "unavailable",
    });
    const cloudState = {
      ...JSON.parse(heatPumpSource.state_json),
      transport: "ewpe-cloud",
      floorId: "floor-1",
      roomId: "living",
      x: 2.5,
      y: 1.2,
      z: 2.3,
      compressorFrequencyHz: 12,
      diagnostics: { wifiStatus: 1, faultCode: 0 },
    };
    const cloudHeatPump = mapRows("heat_pump_state_history", [{
      ...heatPumpSource,
      state_json: JSON.stringify(cloudState),
    }])[0];
    assert.deepEqual({
      transport: cloudHeatPump.transport,
      floor_id: cloudHeatPump.floor_id,
      room_id: cloudHeatPump.room_id,
      x: cloudHeatPump.x,
      y: cloudHeatPump.y,
      z: cloudHeatPump.z,
      compressor_frequency_hz: cloudHeatPump.compressor_frequency_hz,
      diagnostics: cloudHeatPump.diagnostics,
    }, {
      transport: "ewpe-cloud",
      floor_id: "floor-1",
      room_id: "living",
      x: 2.5,
      y: 1.2,
      z: 2.3,
      compressor_frequency_hz: 12,
      diagnostics: { wifiStatus: 1, faultCode: 0 },
    });
  } finally {
    database.close();
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

test("preflight rejects malformed required heat-pump state JSON", async (t) => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "invalid-heat-pump-state.sqlite");
  const writer = createTelemetryFixture(source);
  writer.prepare("UPDATE heat_pump_state_history SET state_json = ?").run("{not-json");
  writer.close();
  const database = openReadOnlySqlite(source);
  try {
    const inventory = inventoryTelemetrySource(database);
    assert.equal(inventory.heat_pump_state_history.invalidJsonValues, 1);
  } finally {
    database.close();
  }
  await assert.rejects(
    runDryMigration(parseMigrationArgs(["--source", source, "--dry-run"], {})),
    /heat_pump_state_history has 1 invalid JSON value/u,
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
        rows: [{ database: "stugu", username: "stuga_app", database_oid: databaseOid }],
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
  assert.doesNotMatch(sql, /^\\/mu);
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
  assert.equal(queries.filter(({ text }) => text.includes("create_hypertable(")).length, 6);
  assert.equal(queries.filter(({ text }) => text.includes("set_chunk_time_interval(")).length, 6);
  const schemaSql = queries.find(({ text }) => text.includes("CREATE TABLE IF NOT EXISTS \"telemetry\".measurement_samples"))?.text;
  assert.match(schemaSql, /archive_source_state/u);
  assert.match(schemaSql, /opening_state_samples/u);
  assert.match(schemaSql, /heat_pump_state_samples/u);
  assert.match(schemaSql, /margin_cents_per_kwh/u);
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

  assert.equal(reports.length, MIGRATION_AGGREGATES.length);
  assert.deepEqual(reports.map(({ name }) => name), MIGRATION_AGGREGATES.map(({ name }) => name));
  assert.equal(reports.every(({ refreshed }) => refreshed), true);
  assert.equal(reports.every(({ rawSamples }) => rawSamples === "2"), true);
  assert.equal(reports.every(({ aggregateSamples }) => aggregateSamples === "2"), true);
  assert.equal(
    queries.filter(({ text }) => text.includes("CALL refresh_continuous_aggregate")).length,
    MIGRATION_AGGREGATES.length,
  );
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
  assert.equal(createIndexes.length, MIGRATION_AGGREGATES.length);
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

  assert.equal(reports.length, MIGRATION_AGGREGATES.length);
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
    "tapo-history-worker-token": join(directory, "tapo", "worker-token"),
  };
  const environment = {
    ...process.env,
    STUGA_TIMESERIES_ADMIN_SECRET_PATH: paths["timeseries-admin-password"],
    STUGA_TIMESERIES_APP_SECRET_PATH: paths["timeseries-password"],
    STUGA_PROXY_SECRET_PATH: paths["local-auth-proxy-secret"],
    STUGA_TAPO_WORKER_SECRET_PATH: paths["tapo-history-worker-token"],
  };
  execFileSync(process.execPath, [script], { env: environment, stdio: "pipe" });
  const first = Object.fromEntries([
    "timeseries-admin-password", "timeseries-password", "local-auth-proxy-secret", "tapo-history-worker-token",
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
