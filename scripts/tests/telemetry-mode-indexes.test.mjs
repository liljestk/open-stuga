import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { parseMigrationArgs } from "../migrate-telemetry-to-timescale.mjs";
import { maintainTelemetryModeIndexes } from "../migrate-telemetry-to-timescale/mode-indexes.mjs";

const options = { schema: "telemetry", maintenanceTimeoutMs: 30_000 };

async function stores(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(`
    CREATE TABLE measurement_samples (id INTEGER PRIMARY KEY, sensor_id TEXT, metric TEXT, timestamp TEXT, data_mode TEXT);
    CREATE TABLE readings (sensor_id TEXT, timestamp TEXT, data_mode TEXT);
    CREATE TABLE outdoor_temperature_samples (house_id TEXT, location_key TEXT, timestamp TEXT, data_mode TEXT);
    CREATE INDEX local_time ON measurement_samples(sensor_id,metric,timestamp);
    WITH RECURSIVE samples(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM samples WHERE i < 40000)
    INSERT INTO measurement_samples SELECT i,'sensor-1','temperature',strftime('%Y-%m-%dT%H:%M:%fZ','2026-01-01', i || ' minutes'),
      CASE WHEN i BETWEEN 20001 AND 20100 THEN 'live' WHEN i = 1 THEN 'demo' END FROM samples;
    ANALYZE measurement_samples;
  `);
  const archive = new PGlite();
  t.after(() => archive.close());
  await archive.exec(`
    SET TIME ZONE 'UTC';
    CREATE SCHEMA telemetry;
    CREATE TABLE telemetry.measurement_samples (sensor_id TEXT, metric TEXT, observed_at TIMESTAMPTZ, data_mode TEXT);
    CREATE TABLE telemetry.legacy_readings (sensor_id TEXT, observed_at TIMESTAMPTZ, data_mode TEXT);
    CREATE TABLE telemetry.outdoor_temperature_samples (house_id TEXT, location_key TEXT, observed_at TIMESTAMPTZ, data_mode TEXT);
    CREATE INDEX archive_time ON telemetry.measurement_samples(sensor_id,metric,observed_at);
    INSERT INTO telemetry.measurement_samples SELECT 'sensor-1','temperature',TIMESTAMPTZ '2026-01-01' + i*INTERVAL '1 minute',
      CASE WHEN i BETWEEN 20001 AND 20100 THEN 'live' WHEN i = 1 THEN 'demo' END FROM generate_series(1,40000) AS i;
    ANALYZE telemetry.measurement_samples;
  `);
  return { sqlite, archive };
}

test("mode index preparation is explicit and keeps separate read-only verification", () => {
  assert.equal(parseMigrationArgs(["--prepare-mode-indexes", "--verify-only"], { PGHOST: "example.test" }).prepareModeIndexes, true);
  assert.equal(parseMigrationArgs(["--dry-run"], {}).prepareModeIndexes, false);
  assert.throws(() => parseMigrationArgs(["--prepare-mode-indexes", "--dry-run"], {}), /does not accept --dry-run/u);
});

test("prepares verified mode indexes on both existing stores without changing boundaries or tags", async (t) => {
  const { sqlite, archive } = await stores(t);
  const values = ["sensor-1", "temperature", "live"];
  const localSql = "SELECT MIN(timestamp) AS boundary FROM measurement_samples WHERE sensor_id=? AND metric=? AND data_mode=?";
  const archiveSql = `SELECT observed_at AS boundary FROM telemetry.measurement_samples
    WHERE sensor_id=$1 AND metric=$2 AND data_mode=$3 ORDER BY observed_at LIMIT 1`;
  const boundary = sqlite.prepare(localSql).get(...values).boundary;
  assert.equal((await archive.query(archiveSql, values)).rows[0].boundary.toISOString(), boundary);
  await assert.rejects(maintainTelemetryModeIndexes(sqlite, archive, { ...options, verifyOnly: true }), /missing mode indexes/u);
  const prepared = await maintainTelemetryModeIndexes(sqlite, archive, options);
  assert.deepEqual(Object.values(prepared).map((indexes) => indexes.map(({ result }) => result)),
    [["created", "created", "created"], ["created", "created", "created"]]);
  assert.match(sqlite.prepare(`EXPLAIN QUERY PLAN ${localSql}`).get(...values).detail,
    /COVERING INDEX measurement_samples_verified_mode_time_idx/u);
  const plan = (await archive.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${archiveSql}`, values)).rows[0]["QUERY PLAN"][0].Plan;
  assert.equal(plan.Plans[0]["Index Name"], "measurement_samples_verified_mode_time_idx");
  assert.equal(plan.Plans[0]["Rows Removed by Filter"] ?? 0, 0);
  assert.equal(sqlite.prepare(localSql).get(...values).boundary, boundary);
  assert.equal((await archive.query(archiveSql, values)).rows[0].boundary.toISOString(), boundary);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM measurement_samples WHERE data_mode IS NULL").get().count, 39899);
  assert.equal(Number((await archive.query("SELECT count(*) AS count FROM telemetry.measurement_samples WHERE data_mode IS NULL")).rows[0].count), 39899);
  const retried = await maintainTelemetryModeIndexes(sqlite, archive, options);
  sqlite.exec("PRAGMA query_only = TRUE");
  await archive.exec("SET default_transaction_read_only = on");
  assert.deepEqual(await maintainTelemetryModeIndexes(sqlite, archive, { ...options, verifyOnly: true }), retried);
  assert.ok(Object.values(retried).flat().every(({ result }) => result === "present"));
});

test("preflight rejects incompatible archive index names before changing SQLite", async (t) => {
  const { sqlite, archive } = await stores(t);
  await archive.exec(`CREATE INDEX measurement_samples_verified_mode_time_idx
    ON telemetry.measurement_samples(sensor_id,metric,data_mode,observed_at)`);
  await assert.rejects(maintainTelemetryModeIndexes(sqlite, archive, options), /PostgreSQL index .* incompatible definition/u);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name LIKE '%verified_mode_time_idx'").get().count, 0);
});

test("a retry builds only SQLite indexes if SQLite was read-only after the archive commit", async (t) => {
  const { sqlite, archive } = await stores(t);
  sqlite.exec("PRAGMA query_only = TRUE");
  await assert.rejects(maintainTelemetryModeIndexes(sqlite, archive, options), /readonly/u);
  sqlite.exec("PRAGMA query_only = FALSE");
  const report = await maintainTelemetryModeIndexes(sqlite, archive, options);
  assert.deepEqual(Object.values(report).map((indexes) => indexes.map(({ result }) => result)),
    [["created", "created", "created"], ["present", "present", "present"]]);
});
