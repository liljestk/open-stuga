import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import { HybridTelemetryReader, type ArchiveTelemetryReader } from "../src/timeseries/read-facade.js";

const FROM = "2026-07-18T00:00:00.000Z";
const TO = "2026-07-18T01:00:00.000Z";
const metric = "temperature";

function archiveFor(measurementCoverage: NonNullable<ArchiveTelemetryReader["measurementCoverage"]>): ArchiveTelemetryReader {
  return {
    measurementCoverage,
    measurementHistory: async () => [],
    legacyReadingHistory: async () => [],
    outdoorTemperatureHistory: async () => [],
  };
}

describe("verified measurement coverage", () => {
  let database: ClimateDatabase;
  let sensorId: string;

  beforeEach(() => {
    database = new ClimateDatabase(":memory:");
    sensorId = database.listSensors()[0]!.id;
  });

  afterEach(() => database.close());

  it("merges verified boundaries and rejects an unscoped archive response", async () => {
    database.insertMeasurementSamples([{
      sensorId, metric, timestamp: TO, value: 22, canonicalUnit: "°C", source: "api", quality: "good",
    }]);
    const localRecord = { sensorId, metric, start: TO, end: TO };
    const archiveRecord = { ...localRecord, start: FROM, end: FROM };
    const measurementCoverage = vi.fn()
      .mockResolvedValueOnce([archiveRecord])
      .mockResolvedValueOnce([{ ...archiveRecord, dataMode: "live" }]);
    const reader = new HybridTelemetryReader({ local: database, archive: archiveFor(measurementCoverage) });
    const query = { sensorIds: [sensorId], metrics: [metric], dataMode: "live" } as const;

    await expect(reader.measurementCoverage(query)).resolves.toEqual({
      records: [localRecord], archiveState: "failed", complete: true,
    });
    await expect(reader.measurementCoverage(query)).resolves.toEqual({
      records: [{ ...localRecord, start: FROM }], archiveState: "merged", complete: true,
    });
    expect(measurementCoverage).toHaveBeenCalledWith({ ...query, excludeSynthetic: true });
  });

  it("rejects verified coverage when live activation happens during an archive read", async () => {
    const archive = archiveFor(async () => {
      database.activateRealDataMode();
      throw new Error("Archive unavailable");
    });
    const reader = new HybridTelemetryReader({ local: database, archive });
    const query = { sensorIds: [sensorId], metrics: [metric], dataMode: "demo" } as const;
    await expect(reader.measurementCoverage(query)).rejects.toMatchObject({ code: "ANALYTICS_DATA_MODE_MISMATCH" });
  });
});
