import { afterEach, describe, expect, it, vi } from "vitest";
import { loadHomeMonitoringHistory } from "../src/analytics/home-monitoring/service.js";
import { ClimateDatabase } from "../src/db.js";
import {
  HybridTelemetryReader,
  type ArchiveTelemetryReader,
} from "../src/timeseries/read-facade.js";

describe("home monitoring history", () => {
  let database: ClimateDatabase | null = null;

  afterEach(() => {
    database?.close();
    database = null;
  });

  it("reads the complete archive in one rollup when SQLite keeps only projections", async () => {
    database = new ClimateDatabase(":memory:");
    database.activateRealDataMode();
    const house = database.createHouse({
      id: "history-home",
      name: "History home",
      timezone: "UTC",
      floors: [{
        id: "ground",
        name: "Ground",
        width: 10,
        height: 10,
        elevation: 0,
        walls: [],
        rooms: [],
      }],
    });
    const sensor = database.createSensor({
      id: "history-sensor",
      houseId: house.id,
      floorId: "ground",
      room: "Utility",
      name: "History sensor",
      model: "test",
      x: 1,
      y: 1,
      z: 1,
      tags: [],
      enabled: true,
    });
    const measurementAnalyticsRollup = vi.fn(async () => ({
      series: [{
        sensorId: sensor.id,
        metric: "humidity",
        canonicalUnit: "%",
        sampleCount: 2,
        excludedSampleCount: 0,
        cadenceSeconds: 300,
        buckets: [{
          bucketStart: "2026-07-30T08:00:00.000Z",
          value: 68,
          minimum: 66,
          maximum: 70,
          sampleCount: 2,
          estimatedSampleCount: 0,
          staleSampleCount: 0,
          counterResetCount: 0,
        }],
      }],
    }));
    const reader = new HybridTelemetryReader({
      local: database,
      archive: { measurementAnalyticsRollup } as unknown as ArchiveTelemetryReader,
      archivePhase: () => "ready",
      localHistoryComplete: false,
    });

    const history = await loadHomeMonitoringHistory({
      database,
      telemetryReader: reader,
      scope: { house, sensors: [sensor] },
      evaluatedAt: "2026-07-30T09:00:00.000Z",
    });

    expect(measurementAnalyticsRollup).toHaveBeenCalledOnce();
    expect(measurementAnalyticsRollup).toHaveBeenCalledWith(expect.objectContaining({
      series: expect.arrayContaining([
        expect.objectContaining({ sensorId: sensor.id, metric: "temperature" }),
        expect.objectContaining({ sensorId: sensor.id, metric: "humidity" }),
        expect.objectContaining({ sensorId: sensor.id, metric: "co2" }),
      ]),
      resolution: "5m",
      excludeSynthetic: true,
    }));
    expect(history[sensor.id]?.humidity).toEqual([
      expect.objectContaining({ value: 68, timestamp: "2026-07-30T08:00:00.000Z" }),
    ]);
  });
});
