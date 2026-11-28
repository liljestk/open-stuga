import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import { migrateLocalTelemetryMode } from "../src/db/migrations/local-telemetry-mode.js";

describe("local telemetry provenance", () => {
  it("adds the mode to old tables without inferring lineage on upgrade or restart", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO metadata VALUES ('data_mode', 'real');`);
      const tables = ["readings", "measurement_samples", "outdoor_temperature_samples"];
      for (const table of tables) {
        database.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, source TEXT);
          INSERT INTO ${table} (id, source) VALUES (1, 'api'), (2, 'mock');`);
      }
      migrateLocalTelemetryMode(database);
      migrateLocalTelemetryMode(database);

      for (const table of tables) {
        const rows = database.prepare(`SELECT id, source, data_mode FROM ${table} ORDER BY id`).all();
        expect(rows).toEqual([
          { id: 1, source: "api", data_mode: null },
          { id: 2, source: "mock", data_mode: null },
        ]);
        expect(() => database.exec(`INSERT INTO ${table} (source, data_mode) VALUES ('mock', 'live')`))
          .toThrow("Invalid local telemetry data mode");
        expect(() => database.exec(`UPDATE ${table} SET data_mode = 'live' WHERE id = 1`))
          .toThrow("Local telemetry data mode is immutable");
      }
    } finally {
      database.close();
    }
  });

  it("records demo and live modes for accepted writes and preserves unknown legacy tags on correction", () => {
    const database = new ClimateDatabase(":memory:");
    try {
      const timestamp = "2026-11-09T10:00:00.000Z";
      const reading = {
        sensorId: "sensor-01", timestamp, temperature: 22, humidity: 43,
        battery: 80, quality: "good" as const, source: "api" as const,
      };
      const weather = {
        houseId: "house-main", locationKey: "fixture-location", timestamp, temperatureC: 4,
        fetchedAt: timestamp, stationId: null, stationName: null,
      };
      const modes = (table: string) => database.db.prepare(
        `SELECT DISTINCT data_mode FROM ${table} ORDER BY data_mode`,
      ).all().map((row) => row.data_mode);

      database.insertReadings([{ ...reading, source: "replay" }]);
      database.upsertOutdoorTemperatureSample({ ...weather, source: "mock" });
      for (const table of ["readings", "measurement_samples", "outdoor_temperature_samples"]) {
        expect(modes(table)).toEqual(["demo"]);
      }

      const legacyTimestamp = "2026-11-09T09:00:00.000Z";
      database.db.prepare(`INSERT INTO readings (sensor_id, timestamp, temperature, humidity, battery, source, quality)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run("sensor-01", legacyTimestamp, 20, 40, 70, "api", "good");
      database.upsertLegacyReading({ ...reading, timestamp: legacyTimestamp });
      expect(database.isRealDataMode()).toBe(true);

      database.insertReadings([reading]);
      database.insertMeasurementSamples([{
        sensorId: reading.sensorId, timestamp, source: "api", quality: "good",
        metric: "co2", value: 620, canonicalUnit: "ppm",
      }]);
      database.upsertOutdoorTemperatureSample({ ...weather, source: "api" });

      expect(modes("readings")).toEqual([null, "live"]);
      expect(modes("measurement_samples")).toEqual(["live"]);
      expect(modes("outdoor_temperature_samples")).toEqual(["live"]);
      expect(database.db.prepare("SELECT temperature, data_mode FROM readings WHERE timestamp = ?").get(legacyTimestamp))
        .toEqual({ temperature: 22, data_mode: null });
      expect(() => database.db.exec("UPDATE measurement_samples SET source = 'import' WHERE data_mode = 'live'"))
        .toThrow("Local telemetry data mode is immutable");
    } finally {
      database.close();
    }
  });
});
