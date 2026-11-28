import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { runDryMigration } from "../migrate-telemetry-to-timescale.mjs";
import { SOURCE_TABLES } from "../migrate-telemetry-to-timescale/configuration.mjs";
import { provisionDestination } from "../migrate-telemetry-to-timescale/destination-schema.mjs";
import { inventoryTelemetrySource } from "../migrate-telemetry-to-timescale/source-state.mjs";
import { mapRows, migrateTables, upsertBatch, verifyBatch } from "../migrate-telemetry-to-timescale/transfer.mjs";
import { createTelemetryFixture, temporaryDirectory } from "./data-safety-test-support.mjs";

function lineageFixture(t) {
  let database;
  t.after(() => database?.close());
  const directory = temporaryDirectory(t);
  const source = join(directory, "source.sqlite");
  database = createTelemetryFixture(source);
  database.exec(`
    ALTER TABLE measurement_samples ADD COLUMN data_mode TEXT;
    ALTER TABLE measurement_samples ADD COLUMN recorded_at TEXT;
    ALTER TABLE readings ADD COLUMN data_mode TEXT;
    ALTER TABLE outdoor_temperature_samples ADD COLUMN data_mode TEXT;
    UPDATE measurement_samples SET data_mode = 'live', recorded_at = '2026-07-18T10:00:01.123456Z';
    UPDATE readings SET data_mode = 'live';
    UPDATE outdoor_temperature_samples SET data_mode = 'demo', source = 'mock';
    INSERT INTO measurement_samples (sensor_id, metric, value, canonical_unit, timestamp, source, quality, data_mode)
      VALUES ('sensor-1', 'temperature', 30, 'degC', '2026-07-18T10:00:00.000Z', 'replay', 'good', 'demo'),
        ('sensor-1', 'temperature', 40, 'degC', '2026-07-18T11:00:00.000Z', 'api', 'good', NULL);
  `);
  return { database, source, checkpoint: join(directory, "migration.json") };
}

test("bulk migration preflight rejects contradictory mode tags and ambiguous recording times", async (t) => {
  const { database, source } = lineageFixture(t);
  const inventory = inventoryTelemetrySource(database);
  assert.deepEqual(inventory.measurement_samples.lineage, {
    demoRows: 1, liveRows: 1, unclassifiedRows: 1, invalidModes: 0, recordedRows: 1, invalidRecordingTimes: 0,
  });
  database.exec("UPDATE measurement_samples SET data_mode = 'live' WHERE source = 'replay'");
  database.exec("UPDATE measurement_samples SET recorded_at = '2026-07-18T10:00:01' WHERE recorded_at IS NOT NULL");
  await assert.rejects(runDryMigration({ source }), /invalid data mode[\s\S]*invalid recording timestamp/u);
  assert.throws(() => mapRows("measurement_samples", database.prepare("SELECT * FROM measurement_samples WHERE source = 'replay'").all()),
    /invalid data mode/u);
});

test("resuming an older bulk import fills matching lineage and keeps unknown or conflicting rows isolated", async (t) => {
  const { database, checkpoint } = lineageFixture(t);
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec("CREATE SCHEMA telemetry");
  // Execute production schema SQL and bulk transfer against PostgreSQL. The
  // embedded fixture provides no Timescale extension or hypertable catalog.
  const client = {
    async query(text, values = []) {
      if (text.includes("FROM pg_extension")) return { rows: [{ timescale_version: "2.28.3" }], rowCount: 1 };
      if (text.includes("timescaledb_information.hypertables")) return { rows: [{ configured: true }], rowCount: 1 };
      if (/CREATE EXTENSION|create_hypertable\(|set_chunk_time_interval\(/u.test(text)) return { rows: [], rowCount: 0 };
      if (text.includes("CREATE TABLE")) return pg.exec(text);
      return pg.query(text, values);
    },
  };
  await provisionDestination(client, "telemetry", 30_000);
  const tables = ["measurement_samples", "readings", "outdoor_temperature_samples"];
  const payloads = tables.map((table) => [table, mapRows(table, database.prepare(`SELECT * FROM ${table}`).all())]);
  for (const [table, payload] of payloads) {
    await upsertBatch(client, "telemetry", table, payload.map((row) => ({ ...row, data_mode: null, recorded_at: null })));
  }
  const inventory = inventoryTelemetrySource(database);
  const manifest = {
    state: "complete", verification: { status: "passed" }, inventory,
    progress: Object.fromEntries(Object.entries(SOURCE_TABLES).map(([table]) =>
      [table, { cursor: null, rowsProcessed: inventory[table].rows, batches: 1, complete: true }])),
  };
  const options = { schema: "telemetry", checkpoint, batchSize: 2 };
  await migrateTables(client, database, options, manifest, { requested: false });
  const resumed = JSON.parse(readFileSync(checkpoint, "utf8"));
  assert.equal(resumed.verification, undefined);
  assert.equal(resumed.progress.measurement_samples.rowsProcessed, 3);
  assert.equal(resumed.progress.measurement_samples.batches, 2);
  for (const [table, payload] of payloads) {
    assert.equal((await verifyBatch(client, "telemetry", table, payload)).matchingRows, payload.length);
  }
  await migrateTables(client, database, options, resumed, { requested: false });
  assert.equal(resumed.progress.measurement_samples.batches, 2);
  const live = payloads[0][1].find((row) => row.data_mode === "live");
  await upsertBatch(client, "telemetry", "measurement_samples", [{ ...live, data_mode: null, recorded_at: null }]);
  const conflicting = { ...live, value: 59, recorded_at: "2026-07-18T10:00:02.123456Z" };
  await upsertBatch(client, "telemetry", "measurement_samples", [conflicting]);
  assert.equal((await verifyBatch(client, "telemetry", "measurement_samples", [conflicting])).matchingRows, 0);
  assert.equal((await verifyBatch(client, "telemetry", "measurement_samples", [live])).matchingRows, 1);
  assert.deepEqual((await pg.query("SELECT value, data_mode FROM telemetry.measurement_samples ORDER BY value")).rows, [
    { value: 19.5, data_mode: "live" }, { value: 30, data_mode: "demo" }, { value: 40, data_mode: null },
  ]);
});
