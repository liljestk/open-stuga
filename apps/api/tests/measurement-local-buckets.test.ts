import type { MeasurementSample } from "@climate-twin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ClimateDatabase } from "../src/db.js";

describe("local bucket means and provenance", () => {
  let database: ClimateDatabase | undefined;
  afterEach(() => database?.close());

  const samples: MeasurementSample[] = [
    { sensorId: "sensor-01", metric: "power", value: 10, canonicalUnit: "W", timestamp: "2026-09-01T10:00:02.000Z", source: "api", quality: "good" },
    { sensorId: "sensor-01", metric: "power", value: 30, canonicalUnit: "W", timestamp: "2026-09-01T10:00:50.000Z", source: "home-assistant", quality: "stale" },
    { sensorId: "sensor-01", metric: "power", value: 20, canonicalUnit: "W", timestamp: "2026-09-01T10:00:50.000Z", source: "api", quality: "good" },
    { sensorId: "sensor-01", metric: "power", value: 40, canonicalUnit: "kW", timestamp: "2026-09-01T10:00:50.000Z", source: "replay", quality: "good" },
    { sensorId: "sensor-01", metric: "power", value: 50, canonicalUnit: "W", timestamp: "2026-09-01T10:01:00.000Z", source: "api", quality: "stale" },
    { sensorId: "sensor-01", metric: "power", value: 60, canonicalUnit: "W", timestamp: "2026-09-01T10:02:00.000Z", source: "api", quality: "good" },
    { sensorId: "sensor-02", metric: "power", value: 999, canonicalUnit: "W", timestamp: "2026-09-01T10:00:50.000Z", source: "home-assistant", quality: "good" },
    { sensorId: "sensor-01", metric: "energy", value: 888, canonicalUnit: "kWh", timestamp: "2026-09-01T10:00:50.000Z", source: "home-assistant", quality: "good" },
  ];

  it.each([
    ["2026-09-01T10:00:00.000Z", "2026-09-01T10:02:00.000Z", 60, 20, false, false],
    ["2026-09-01T10:00:07.000Z", "2026-09-01T10:02:00.000Z", 60, 20, true, true],
    ["2026-09-01T10:00:00.000Z", "2026-09-01T10:02:00.000Z", 60, 1, true, false],
    ["2026-09-01T10:00:50.000Z", "2026-09-01T10:00:50.000Z", 900, 20, true, false],
    ["2026-09-01T10:01:00.000Z", "2026-09-01T10:01:00.000Z", 60, 20, true, false],
  ] as const)("retains the exact range, latest source, units and quality for %s to %s", (from, to, seconds, limit, real, exclusive) => {
    database = new ClimateDatabase(":memory:");
    database.db.exec("DELETE FROM measurement_samples");
    const insert = database.db.prepare(`INSERT INTO measurement_samples
      (sensor_id,metric,value,canonical_unit,timestamp,source,quality) VALUES (?,?,?,?,?,?,?)`);
    for (const sample of samples) insert.run(sample.sensorId, sample.metric, sample.value,
      sample.canonicalUnit, sample.timestamp, sample.source, sample.quality);

    const grouped = new Map<string, MeasurementSample[]>();
    for (const sample of samples) {
      if (sample.sensorId !== "sensor-01" || sample.metric !== "power" || sample.timestamp < from
        || (exclusive ? sample.timestamp >= to : sample.timestamp > to)
        || (real && (sample.source === "mock" || sample.source === "replay"))) continue;
      const timestamp = new Date(Math.floor(Date.parse(sample.timestamp) / (seconds * 1000)) * seconds * 1000).toISOString();
      grouped.set(timestamp, [...(grouped.get(timestamp) ?? []), sample]);
    }
    const expected = [...grouped].sort(([a], [b]) => a < b ? -1 : 1).slice(-limit).map(([timestamp, rows]) => {
      const latest = [...rows].sort((a, b) => a.timestamp === b.timestamp
        ? a.source < b.source ? 1 : -1 : a.timestamp < b.timestamp ? 1 : -1)[0]!;
      return { ...latest, timestamp, value: rows.reduce((sum, row) => sum + row.value, 0) / rows.length,
        quality: rows.length > 1 ? "estimated" : latest.quality };
    });
    expect(database.measurementHistoryBucketed({ sensorId: "sensor-01", metric: "power", from, to, bucketSeconds: seconds, limit, excludeSynthetic: real, toExclusive: exclusive })).toEqual(expected);
    expect(database.measurementHistoryBucketed({ sensorId: "unknown", metric: "power", from, to, bucketSeconds: seconds })).toEqual([]);
  });
});
