import { afterEach, describe, expect, it } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import type { MeasurementSample } from "@climate-twin/contracts";

let database: ClimateDatabase | null = null;

function seededDatabase(): ClimateDatabase {
  database = new ClimateDatabase(":memory:", true);
  database.createProperty({
    id: "property-1",
    name: "Coverage estate",
    location: { latitude: 60.17, longitude: 24.94 },
  });
  database.createHouse({
    id: "house-1",
    propertyId: "property-1",
    name: "Coverage home",
    timezone: "Europe/Helsinki",
    floors: [{
      id: "floor-1",
      name: "Ground",
      width: 10,
      height: 8,
      elevation: 0,
      walls: [],
      rooms: [],
    }],
  });
  for (const id of ["sensor-a", "sensor-b"]) {
    database.createSensor({
      id,
      houseId: "house-1",
      floorId: "floor-1",
      name: id,
      room: "Room",
      model: "T315",
      x: 1,
      y: 1,
      z: 1,
      tags: [],
      enabled: true,
    });
  }
  return database;
}

function sample(
  sensorId: string,
  metric: string,
  timestamp: string,
  source: MeasurementSample["source"] = "api",
): MeasurementSample {
  return {
    sensorId,
    metric,
    value: 20,
    canonicalUnit: metric === "temperature" ? "C" : "%",
    timestamp,
    source,
    quality: "good",
  };
}

afterEach(() => {
  database?.close();
  database = null;
});

describe("measurementCoverage boundary probes", () => {
  it("matches the aggregate scan it replaced, per pair and in order", () => {
    const db = seededDatabase();
    db.insertMeasurementSamples([
      sample("sensor-a", "temperature", "2026-08-01T00:00:00.000Z"),
      sample("sensor-a", "temperature", "2026-08-05T12:00:00.000Z"),
      sample("sensor-a", "temperature", "2026-08-03T06:00:00.000Z"),
      sample("sensor-a", "humidity", "2026-08-02T00:00:00.000Z"),
      sample("sensor-b", "temperature", "2026-08-04T00:00:00.000Z"),
    ]);

    // The rewritten method must be observably identical to the single
    // MIN/MAX GROUP BY statement it replaced.
    const scanned = (db.db.prepare(`SELECT sensor_id, metric,
        MIN(timestamp) AS coverage_start, MAX(timestamp) AS coverage_end
      FROM measurement_samples
      WHERE sensor_id IN (?, ?) AND metric IN (?, ?)
      GROUP BY sensor_id, metric
      ORDER BY sensor_id, metric`)
      .all("sensor-a", "sensor-b", "temperature", "humidity") as Array<{
        sensor_id: string;
        metric: string;
        coverage_start: string;
        coverage_end: string;
      }>).map((row) => ({
        sensorId: row.sensor_id,
        metric: row.metric,
        start: row.coverage_start,
        end: row.coverage_end,
      }));

    const probed = db.measurementCoverage(
      ["sensor-a", "sensor-b"],
      ["temperature", "humidity"],
    );
    expect(probed).toEqual(scanned);
    expect(probed).toEqual([
      { sensorId: "sensor-a", metric: "humidity", start: "2026-08-02T00:00:00.000Z", end: "2026-08-02T00:00:00.000Z" },
      { sensorId: "sensor-a", metric: "temperature", start: "2026-08-01T00:00:00.000Z", end: "2026-08-05T12:00:00.000Z" },
      { sensorId: "sensor-b", metric: "temperature", start: "2026-08-04T00:00:00.000Z", end: "2026-08-04T00:00:00.000Z" },
    ]);
  });

  it("ignores repeated inputs, unknown sensors, and metrics without samples", () => {
    const db = seededDatabase();
    db.insertMeasurementSamples([
      sample("sensor-a", "temperature", "2026-08-01T00:00:00.000Z"),
    ]);
    expect(db.measurementCoverage(
      ["sensor-a", "sensor-a", "sensor-unknown"],
      ["temperature", "temperature", "co2"],
    )).toEqual([
      { sensorId: "sensor-a", metric: "temperature", start: "2026-08-01T00:00:00.000Z", end: "2026-08-01T00:00:00.000Z" },
    ]);
    expect(db.measurementCoverage([], ["temperature"])).toEqual([]);
    expect(db.measurementCoverage(["sensor-a"], [])).toEqual([]);
  });
});

describe("measurementWindowPage", () => {
  it("assembles the one-shot window across pages, keeping the (timestamp, id) order", () => {
    const db = seededDatabase();
    // Two rows share one timestamp (distinct sources), so a page boundary can
    // land inside the tie and must be split by the id cursor, not skipped.
    db.insertMeasurementSamples([
      sample("sensor-a", "temperature", "2026-08-01T00:00:00.000Z"),
      sample("sensor-a", "temperature", "2026-08-01T01:00:00.000Z"),
      sample("sensor-a", "temperature", "2026-08-01T01:00:00.000Z", "tp-link"),
      sample("sensor-a", "temperature", "2026-08-01T02:00:00.000Z"),
      sample("sensor-b", "temperature", "2026-08-01T03:00:00.000Z"),
      sample("sensor-a", "humidity", "2026-08-01T04:00:00.000Z"),
    ]);
    const from = "2026-08-01T00:00:00.000Z";
    const to = "2026-08-01T23:59:59.999Z";
    const oneShot = db.measurementWindow(
      {
        sensorIds: ["sensor-a", "sensor-b"],
        metrics: ["temperature", "humidity"],
        from,
        to,
      },
    );
    expect(oneShot).toHaveLength(6);

    for (const pageSize of [1, 2, 3, 6, 10]) {
      const assembled: MeasurementSample[] = [];
      let cursor: { timestamp: string; id: number } | null = null;
      let pages = 0;
      for (;;) {
        const page = db!.measurementWindowPage(
          ["sensor-a", "sensor-b"],
          ["temperature", "humidity"],
          from,
          to,
          pageSize,
          cursor,
        );
        assembled.push(...page.samples);
        pages += 1;
        cursor = page.next;
        if (!cursor) break;
      }
      expect(assembled.reverse()).toEqual(oneShot);
      expect(pages).toBe(Math.max(1, Math.ceil(6 / pageSize)));
    }
  });

  it("honors the range, sensor visibility, and the limit contract", () => {
    const db = seededDatabase();
    db.insertMeasurementSamples([
      sample("sensor-a", "temperature", "2026-08-01T00:00:00.000Z"),
      sample("sensor-a", "temperature", "2026-08-02T00:00:00.000Z"),
    ]);
    expect(db.measurementWindowPage(
      ["sensor-unknown"],
      ["temperature"],
      "2026-08-01T00:00:00.000Z",
      "2026-08-03T00:00:00.000Z",
      10,
    )).toEqual({ samples: [], next: null });
    const bounded = db.measurementWindowPage(
      ["sensor-a"],
      ["temperature"],
      "2026-08-01T12:00:00.000Z",
      "2026-08-03T00:00:00.000Z",
      10,
    );
    expect(bounded.samples.map((item) => item.timestamp)).toEqual(["2026-08-02T00:00:00.000Z"]);
    expect(bounded.next).toBeNull();
    expect(() => db!.measurementWindowPage(
      ["sensor-a"],
      ["temperature"],
      "2026-08-01T00:00:00.000Z",
      "2026-08-03T00:00:00.000Z",
      0,
    )).toThrowError(/limit/i);
  });
});
