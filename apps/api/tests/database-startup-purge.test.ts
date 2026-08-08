import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ClimateDatabase } from "../src/db.js";

describe("real-data startup cleanup", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("purges externally introduced demo rows once using partial indexes", () => {
    const directory = mkdtempSync(join(tmpdir(), "stugu-startup-purge-"));
    directories.push(directory);
    const databasePath = join(directory, "climate.sqlite");
    const initial = new ClimateDatabase(databasePath);
    initial.activateRealDataMode();
    initial.close();

    // Simulate an out-of-process database edit while Stugu is stopped. The
    // persisted real-data latch must remain authoritative on the next start.
    const external = new DatabaseSync(databasePath);
    external.exec("PRAGMA foreign_keys = ON");
    external.prepare("UPDATE metadata SET value = 'demo' WHERE key = 'data_mode'").run();
    external.prepare(`INSERT INTO measurement_samples
      (sensor_id, metric, value, canonical_unit, timestamp, source, quality)
      VALUES ('sensor-01', 'humidity', 48, '%', '2026-08-08T00:00:00.000Z', 'mock', 'good')`).run();
    external.prepare(`INSERT INTO measurement_samples
      (sensor_id, metric, value, canonical_unit, timestamp, source, quality)
      VALUES ('sensor-01', 'temperature', 20, '°C', '2026-08-08T00:00:00.000Z', 'tp-link', 'good')`).run();
    external.prepare(`INSERT INTO readings
      (sensor_id, timestamp, temperature, humidity, battery, source, quality)
      VALUES ('sensor-01', '2026-08-08T00:00:00.000Z', 20, 48, 90, 'mock', 'good')`).run();
    external.prepare(`INSERT INTO outdoor_temperature_samples
      (house_id, location_key, timestamp, temperature_c, source, fetched_at, station_id, station_name)
      VALUES ('house-main', 'unlocated', '2026-08-08T00:00:00.000Z', 15, 'mock',
        '2026-08-08T00:00:00.000Z', NULL, NULL)`).run();
    external.prepare(`INSERT OR IGNORE INTO sensor_recorded_measurements(sensor_id, metric)
      VALUES ('sensor-01', 'humidity')`).run();
    external.prepare("UPDATE metadata SET value = 'real' WHERE key = 'data_mode'").run();
    external.close();

    let purgeCalls = 0;
    class CountingClimateDatabase extends ClimateDatabase {
      override purgeSourceLabelledDemoTelemetry(): void {
        purgeCalls += 1;
        super.purgeSourceLabelledDemoTelemetry();
      }
    }

    const restarted = new CountingClimateDatabase(databasePath, false);
    try {
      expect(purgeCalls).toBe(1);
      expect(restarted.db.prepare(`SELECT COUNT(*) AS count FROM measurement_samples
        WHERE source IN ('mock', 'replay')`).get()).toEqual({ count: 0 });
      expect(restarted.db.prepare(`SELECT COUNT(*) AS count FROM readings
        WHERE source IN ('mock', 'replay')`).get()).toEqual({ count: 0 });
      expect(restarted.db.prepare(`SELECT COUNT(*) AS count FROM outdoor_temperature_samples
        WHERE source = 'mock'`).get()).toEqual({ count: 0 });
      expect(restarted.db.prepare(`SELECT COUNT(*) AS count FROM measurement_samples
        WHERE source = 'tp-link'`).get()).toEqual({ count: 1 });
      expect(restarted.db.prepare(`SELECT COUNT(*) AS count FROM sensor_recorded_measurements
        WHERE sensor_id = 'sensor-01' AND metric = 'humidity'`).get()).toEqual({ count: 0 });

      const plans = [
        [
          "DELETE FROM measurement_samples WHERE source IN ('mock', 'replay')",
          "idx_measurement_samples_demo_source",
        ],
        [
          "DELETE FROM readings WHERE source IN ('mock', 'replay')",
          "idx_readings_demo_source",
        ],
        [
          "DELETE FROM outdoor_temperature_samples WHERE source = 'mock'",
          "idx_outdoor_temperature_demo_source",
        ],
      ] as const;
      for (const [statement, expectedIndex] of plans) {
        const details = restarted.db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all() as unknown as Array<{
          detail: string;
        }>;
        expect(details.some(({ detail }) => detail.includes(expectedIndex))).toBe(true);
      }
    } finally {
      restarted.close();
    }
  });
});
