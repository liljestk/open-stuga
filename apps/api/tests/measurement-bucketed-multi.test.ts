import { afterEach, describe, expect, it } from "vitest";
import { ClimateDatabase } from "../src/db.js";

describe("multi-series measurement buckets", () => {
  let database: ClimateDatabase | null = null;

  afterEach(() => {
    database?.close();
    database = null;
  });

  it("retains a per-series limit and latest provenance in one grouped read", () => {
    database = new ClimateDatabase(":memory:");
    database.insertMeasurementSamples([
      {
        sensorId: "sensor-01",
        metric: "co2",
        value: 500,
        canonicalUnit: "ppm",
        timestamp: "2026-07-14T09:59:50.000Z",
        source: "api",
        quality: "good",
      },
      {
        sensorId: "sensor-01",
        metric: "co2",
        value: 900,
        canonicalUnit: "ppm",
        timestamp: "2026-07-14T10:00:50.000Z",
        source: "home-assistant",
        quality: "good",
      },
      {
        sensorId: "sensor-01",
        metric: "co2",
        value: 600,
        canonicalUnit: "ppm",
        timestamp: "2026-07-14T10:00:10.000Z",
        source: "api",
        quality: "good",
      },
      {
        sensorId: "sensor-02",
        metric: "temperature",
        value: 22,
        canonicalUnit: "°C",
        timestamp: "2026-07-14T10:00:50.000Z",
        source: "home-assistant",
        quality: "good",
      },
      {
        sensorId: "sensor-02",
        metric: "temperature",
        value: 20,
        canonicalUnit: "°C",
        timestamp: "2026-07-14T10:00:10.000Z",
        source: "api",
        quality: "good",
      },
    ]);

    const result = database.measurementHistoryBucketedMulti(
      ["sensor-01", "sensor-02"],
      ["co2", "temperature"],
      "2026-07-14T09:59:00.000Z",
      "2026-07-14T10:01:00.000Z",
      60,
      1,
    );
    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sensorId: "sensor-01",
        metric: "co2",
        value: 750,
        source: "home-assistant",
        quality: "estimated",
      }),
      expect.objectContaining({
        sensorId: "sensor-02",
        metric: "temperature",
        value: 21,
        source: "home-assistant",
        quality: "estimated",
      }),
    ]));
  });
});
