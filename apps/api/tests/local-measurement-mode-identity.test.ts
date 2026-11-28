import { describe, expect, it } from "vitest";
import type { MeasurementSample } from "@climate-twin/contracts";
import { ClimateDatabase } from "../src/db.js";
import { MEASUREMENT_MODE_IDENTITY_MARKER, prepareMeasurementModeIdentity } from "../src/db/migrations/measurement-mode-identity.js";

function samples(database: ClimateDatabase): { sample: MeasurementSample; oldId: number } {
  const sample = {
    sensorId: database.listSensors()[0]!.id, metric: "temperature", timestamp: "2026-01-20T08:00:00.000Z",
    source: "api", value: 21, canonicalUnit: "°C", quality: "good",
  } satisfies MeasurementSample;
  database.activateRealDataMode();
  const { lastInsertRowid } = database.db.prepare(`INSERT INTO measurement_samples
    (sensor_id,metric,timestamp,source,value,canonical_unit,quality) VALUES (?, ?, ?, ?, 19, ?, ?)`)
    .run(sample.sensorId, sample.metric, sample.timestamp, sample.source, sample.canonicalUnit, sample.quality);
  return { sample, oldId: Number(lastInsertRowid) };
}

describe("staged SQLite measurement mode identity", () => {
  it("keeps old IDs, references, indexes and the sequence while accepting the colliding live measurement", () => {
    const database = new ClimateDatabase(":memory:");
    try {
      const { sample, oldId } = samples(database);
      expect(database.insertMeasurementSamples([sample])).toEqual([]);
      database.db.prepare("INSERT INTO alert_evaluation_queue VALUES (?)").run(oldId);
      const watermark = oldId + 100;
      database.db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'measurement_samples'").run(watermark);
      database.saveTelemetryArchiveCheckpoint("measurement_samples", watermark);
      database.db.exec(`CREATE INDEX measurement_fixture_index ON measurement_samples(data_mode, timestamp);
        CREATE TRIGGER measurement_fixture_reference AFTER UPDATE ON metadata
        WHEN NEW.key = 'measurement_fixture_reference'
        BEGIN SELECT id FROM measurement_samples LIMIT 1; END;`);
      prepareMeasurementModeIdentity(database.db);
      expect(database.db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(database.db.prepare("PRAGMA legacy_alter_table").get()).toEqual({ legacy_alter_table: 0 });
      expect(database.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.db.prepare("SELECT measurement_sample_id FROM alert_evaluation_queue").all())
        .toEqual([{ measurement_sample_id: oldId }]);
      expect(database.db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'measurement_fixture_%' ORDER BY name").all())
        .toEqual([{ name: "measurement_fixture_index" }, { name: "measurement_fixture_reference" }]);
      expect(database.insertMeasurementSamples([sample], { deduplicateAcrossSources: true, enqueueAlertEvaluation: true }))
        .toEqual([sample]);
      expect(database.insertMeasurementSamples([sample])).toEqual([]);
      expect(database.insertMeasurementSamples([{ ...sample, source: "tp-link" }], { deduplicateAcrossSources: true }))
        .toEqual([]);
      const records = database.db.prepare("SELECT id, value, data_mode FROM measurement_samples WHERE sensor_id = ? AND timestamp = ? ORDER BY id")
        .all(sample.sensorId, sample.timestamp);
      expect(records).toEqual([
        { id: oldId, value: 19, data_mode: null }, { id: watermark + 1, value: 21, data_mode: "live" },
      ]);
      expect(database.measurementWindow({
        sensorIds: [sample.sensorId], metrics: [sample.metric], from: sample.timestamp, to: sample.timestamp, dataMode: "live",
      })).toEqual([sample]);
      expect(database.measurementArchivePage(watermark, 10)).toMatchObject([
        { rowId: watermark + 1, record: { dataMode: "live", value: 21 } },
      ]);
      expect(() => database.db.prepare("UPDATE measurement_samples SET data_mode = 'demo' WHERE id = ?").run(watermark + 1))
        .toThrow("Local telemetry data mode is immutable");

      const later = { ...sample, timestamp: "2026-01-20T09:00:00.000Z" };
      const insertUnknown = database.db.prepare(`INSERT OR IGNORE INTO measurement_samples
        (sensor_id,metric,timestamp,source,value,canonical_unit,quality) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const values = [later.sensorId, later.metric, later.timestamp, later.source, later.value, later.canonicalUnit, later.quality] as const;
      expect(Number(insertUnknown.run(...values).changes)).toBe(1);
      expect(Number(insertUnknown.run(...values).changes)).toBe(0);
      expect(database.insertMeasurementSamples([later])).toEqual([later]);
      expect(database.measurementArchiveRecording(later)).toMatchObject({ dataMode: "live", recordedAt: expect.any(String) });
      prepareMeasurementModeIdentity(database.db);
      expect(database.db.prepare("SELECT id, value, data_mode FROM measurement_samples WHERE sensor_id = ? AND timestamp = ? ORDER BY id")
        .all(sample.sensorId, sample.timestamp)).toEqual(records);
    } finally {
      database.close();
    }
  });

  it("rolls the rebuild back if an existing measurement reference is broken", () => {
    const database = new ClimateDatabase(":memory:");
    try {
      const { sample, oldId } = samples(database);
      database.db.exec("PRAGMA foreign_keys = OFF");
      database.db.prepare("INSERT INTO alert_evaluation_queue VALUES (?)").run(oldId + 10);
      database.db.exec("PRAGMA foreign_keys = ON");
      expect(() => prepareMeasurementModeIdentity(database.db)).toThrow("foreign-key violation in alert_evaluation_queue");
      expect(database.db.prepare("SELECT value FROM metadata WHERE key = ?").get(MEASUREMENT_MODE_IDENTITY_MARKER)).toBeUndefined();
      expect(database.db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(database.insertMeasurementSamples([sample])).toEqual([]);
      expect(database.db.prepare("SELECT id, value, data_mode FROM measurement_samples WHERE id = ?").get(oldId))
        .toEqual({ id: oldId, value: 19, data_mode: null });
    } finally {
      database.close();
    }
  });
});
