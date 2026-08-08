import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import {
  SENSOR_SOURCE_METRICS_RECENT_ROWID_WINDOW,
  SENSOR_SOURCE_METRICS_RECENT_ROWS_SQL,
} from "../src/db/methods/02-migrate-core-and-resource-schema.js";
import { SENSOR_SOURCE_METRICS_SQL } from "../src/db/methods/16-resolve-weather-outages-to-expedite-sensor-data-gap-.js";
import { PENDING_ALERT_EVALUATION_SAMPLES_SQL } from "../src/db/methods/22-create-alert-event-to-dead-letter-notification-outbo.js";
import { TelemetryBus } from "../src/events.js";
import { AlertEngine } from "../src/services.js";

function queryPlan(database: ClimateDatabase, sql: string, ...parameters: Array<string | number>): string[] {
  return (database.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as Array<{ detail: string }>)
    .map(({ detail }) => detail);
}

const floor = {
  id: "ground",
  name: "Ground",
  type: "ground" as const,
  width: 8,
  height: 6,
  elevation: 0,
  walls: [],
  rooms: [],
};

describe("live ingestion query plans", () => {
  let directory: string | null = null;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  it("drives pending alert evaluation from the bounded queue and skips a hidden Home without starving active work", () => {
    const database = new ClimateDatabase(":memory:", true);
    try {
      const plan = queryPlan(database, PENDING_ALERT_EVALUATION_SAMPLES_SQL, 500);
      const queueScan = plan.findIndex((step) => step.includes("SCAN queue"));
      const sampleLookup = plan.findIndex((step) => step.includes("SEARCH sample USING INTEGER PRIMARY KEY"));
      expect(queueScan).toBeGreaterThanOrEqual(0);
      expect(sampleLookup).toBeGreaterThan(queueScan);
      expect(plan.some((step) => step.includes("SCAN sample"))).toBe(false);

      database.createHouse({
        id: "hidden-home",
        name: "Hidden Home",
        timezone: "UTC",
        floors: [floor],
      });
      database.createSensor({
        id: "hidden-sensor",
        houseId: "hidden-home",
        floorId: floor.id,
        room: "Utility",
        name: "Hidden sensor",
        model: "Test",
        x: 1,
        y: 1,
        z: 1,
        tags: [],
        enabled: true,
      });
      database.insertMeasurementSamples([{
        sensorId: "hidden-sensor",
        metric: "temperature",
        value: 19,
        canonicalUnit: "°C",
        timestamp: "2026-08-08T06:59:00.000Z",
        source: "api",
        quality: "good",
      }], { enqueueAlertEvaluation: true });
      expect(database.deleteHouse("hidden-home")).toBe(true);

      database.insertMeasurementSamples([{
        sensorId: "sensor-01",
        metric: "temperature",
        value: 21,
        canonicalUnit: "°C",
        timestamp: "2026-08-08T07:00:00.000Z",
        source: "api",
        quality: "good",
      }], { enqueueAlertEvaluation: true });

      expect(database.listPendingAlertEvaluationSamples(1)).toEqual([expect.objectContaining({
        sample: expect.objectContaining({ sensorId: "sensor-01" }),
      })]);
      expect(new AlertEngine(database, new TelemetryBus()).evaluatePendingSamples()).toEqual([]);
      expect(database.db.prepare(`SELECT sample.sensor_id
        FROM alert_evaluation_queue queue
        JOIN measurement_samples sample ON sample.id = queue.measurement_sample_id`).all())
        .toEqual([{ sensor_id: "hidden-sensor" }]);
    } finally {
      database.close();
    }
  });

  it("looks up source metrics from the bounded durable catalogue", () => {
    const database = new ClimateDatabase(":memory:", true);
    try {
      database.insertMeasurementSamples([
        {
          sensorId: "sensor-01", metric: "temperature", value: 21, canonicalUnit: "°C",
          timestamp: "2026-08-08T07:00:00.000Z", source: "tp-link", quality: "good",
        },
        {
          sensorId: "sensor-01", metric: "humidity", value: 45, canonicalUnit: "%",
          timestamp: "2026-08-08T07:00:00.000Z", source: "tp-link", quality: "good",
        },
        {
          sensorId: "sensor-01", metric: "temperature", value: 20, canonicalUnit: "°C",
          timestamp: "2026-08-08T07:01:00.000Z", source: "home-assistant", quality: "good",
        },
      ]);

      expect(database.sensorSourceMetrics("sensor-01", "tp-link")).toEqual(["humidity", "temperature"]);
      expect(database.sensorSourceMetrics("sensor-01", "home-assistant")).toEqual(["temperature"]);
      const plan = queryPlan(database, SENSOR_SOURCE_METRICS_SQL, "sensor-01", "tp-link");
      expect(plan.some((step) => step.includes("SEARCH sensor_source_metrics USING PRIMARY KEY"))).toBe(true);
      expect(plan.some((step) => step.includes("measurement_samples"))).toBe(false);
    } finally {
      database.close();
    }
  });

  it("seeds only the recent measurement rowid window on upgrade", () => {
    directory = mkdtempSync(join(tmpdir(), "stugu-live-ingestion-recent-seed-"));
    const databasePath = join(directory, "climate.sqlite");
    new ClimateDatabase(databasePath, true).close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TRIGGER sensor_source_metrics_from_gap_insert;
      DROP TRIGGER sensor_source_metrics_from_measurement_insert;
      DROP TABLE sensor_source_metrics;
      DELETE FROM measurement_samples;
      DELETE FROM sensor_data_gaps;
      DELETE FROM metadata WHERE key = 'sensor_source_metrics_recent_samples_v1';
      INSERT INTO measurement_samples
        (id, sensor_id, metric, value, canonical_unit, timestamp, source, quality)
      VALUES
        (1, 'sensor-01', 'co2', 700, 'ppm', '2026-08-08T05:00:00.000Z', 'tp-link', 'good'),
        (20000, 'sensor-01', 'humidity', 45, '%', '2026-08-08T06:00:00.000Z', 'tp-link', 'good'),
        (20001, 'sensor-01', 'temperature', 20, 'C', '2026-08-08T06:01:00.000Z', 'home-assistant', 'good');
    `);
    legacy.close();

    const migrated = new ClimateDatabase(databasePath, false);
    try {
      expect(migrated.sensorSourceMetrics("sensor-01", "tp-link")).toEqual(["humidity"]);
      expect(migrated.sensorSourceMetrics("sensor-01", "home-assistant")).toEqual(["temperature"]);
      expect(migrated.db.prepare(`SELECT value FROM metadata
        WHERE key = 'sensor_source_metrics_recent_samples_v1'`).get()).toEqual({ value: "20001" });
      expect(migrated.db.prepare(`SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_measurement_samples_sensor_source_metric'`).get())
        .toBeUndefined();

      const afterId = 20_001 - SENSOR_SOURCE_METRICS_RECENT_ROWID_WINDOW;
      const plan = queryPlan(migrated, SENSOR_SOURCE_METRICS_RECENT_ROWS_SQL, afterId);
      expect(plan.some((step) => step.includes("SEARCH measurement_samples USING INTEGER PRIMARY KEY")
        && step.includes("rowid>?"))).toBe(true);
      expect(plan.some((step) => step.includes("SCAN measurement_samples"))).toBe(false);
    } finally {
      migrated.close();
    }
  });

  it("adds and seeds the bounded catalogue idempotently without a history index", () => {
    directory = mkdtempSync(join(tmpdir(), "stugu-live-ingestion-catalogue-"));
    const databasePath = join(directory, "climate.sqlite");
    const initial = new ClimateDatabase(databasePath, true);
    initial.noteSensorDataGap(
      "sensor-01",
      "temperature",
      "tp-link",
      "2026-08-08T06:00:00.000Z",
      "2026-08-08T07:00:00.000Z",
    );
    initial.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TRIGGER sensor_source_metrics_from_gap_insert;
      DROP TRIGGER sensor_source_metrics_from_measurement_insert;
      DROP TABLE sensor_source_metrics;
    `);
    legacy.close();

    for (let reopen = 0; reopen < 2; reopen += 1) {
      const migrated = new ClimateDatabase(databasePath, false);
      try {
        expect(migrated.sensorSourceMetrics("sensor-01", "tp-link"))
          .toEqual(reopen === 0 ? ["temperature"] : ["humidity", "temperature"]);
        expect(migrated.db.prepare(`SELECT name FROM sqlite_master
          WHERE type = 'index' AND name = 'idx_measurement_samples_sensor_source_metric'`).get())
          .toBeUndefined();
        const maximumGapId = String((migrated.db.prepare(
          "SELECT COALESCE(MAX(id), 0) AS maximum FROM sensor_data_gaps",
        ).get() as { maximum: number }).maximum);
        expect(migrated.db.prepare(`SELECT value FROM metadata
          WHERE key = 'sensor_source_metrics_gap_rowid_v1'`).get())
          .toEqual({ value: maximumGapId });
        if (reopen === 0) {
          // Simulate a rollback binary writing while the persistent trigger is
          // absent. The next upgrade must repair only IDs beyond the checkpoint.
          migrated.db.exec("DROP TRIGGER sensor_source_metrics_from_gap_insert");
          migrated.noteSensorDataGap(
            "sensor-01",
            "humidity",
            "tp-link",
            "2026-08-08T06:30:00.000Z",
            "2026-08-08T07:30:00.000Z",
          );
          expect(migrated.sensorSourceMetrics("sensor-01", "tp-link")).toEqual(["temperature"]);
        }
      } finally {
        migrated.close();
      }
    }
  });
});
