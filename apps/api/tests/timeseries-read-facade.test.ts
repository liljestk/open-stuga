import type { MeasurementSample, OutdoorTemperatureSample, Reading } from "@climate-twin/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  HybridTelemetryReader,
  IncompleteTelemetryHistoryError,
  type ArchiveTelemetryReader,
  type LocalTelemetryReader,
} from "../src/timeseries/read-facade.js";

const FROM = "2026-07-18T00:00:00.000Z";
const TO = "2026-07-18T01:00:00.000Z";

function measurement(
  timestamp: string,
  value: number,
  source: MeasurementSample["source"] = "api",
  sensorId = "sensor-a",
  metric = "temperature",
): MeasurementSample {
  return { sensorId, metric, value, canonicalUnit: "C", timestamp, source, quality: "good" };
}

function reading(timestamp: string, temperature: number, source: Reading["source"] = "api"): Reading {
  return {
    sensorId: "sensor-a",
    timestamp,
    temperature,
    humidity: 50,
    battery: 90,
    source,
    quality: "good",
  };
}

function outdoor(timestamp: string, temperatureC: number): OutdoorTemperatureSample {
  return {
    houseId: "house-a",
    locationKey: "location-a",
    timestamp,
    temperatureC,
    source: "api",
    fetchedAt: timestamp,
    stationId: null,
    stationName: null,
  };
}

function localReader(overrides: Partial<LocalTelemetryReader> = {}): LocalTelemetryReader {
  return {
    isRealDataMode: vi.fn(() => false),
    measurementHistory: vi.fn(() => []),
    measurementWindow: vi.fn(() => []),
    history: vi.fn(() => []),
    outdoorTemperatureHistory: vi.fn(() => []),
    ...overrides,
  };
}

function archiveReader(overrides: Partial<ArchiveTelemetryReader> = {}): ArchiveTelemetryReader {
  return {
    measurementHistory: vi.fn(async () => []),
    legacyReadingHistory: vi.fn(async () => []),
    outdoorTemperatureHistory: vi.fn(async () => []),
    ...overrides,
  };
}

describe("HybridTelemetryReader", () => {
  it("merges archive history with the SQLite hot tail, gives SQLite conflict precedence, and applies one global limit", async () => {
    const calls: string[] = [];
    const overlapAt = "2026-07-18T00:20:00.000Z";
    const local = localReader({
      measurementHistory: vi.fn(() => {
        calls.push("local");
        return [measurement(overlapAt, 22), measurement("2026-07-18T00:30:00.000Z", 23)];
      }),
    });
    const archive = archiveReader({
      measurementHistory: vi.fn(async () => {
        calls.push("archive");
        return [
          measurement("2026-07-18T00:10:00.000Z", 20),
          measurement(overlapAt, -99),
        ];
      }),
    });
    const reader = new HybridTelemetryReader({ local, archive, archivePhase: () => "syncing" });

    const result = await reader.measurementHistory({
      sensorId: "sensor-a",
      metric: "temperature",
      from: FROM,
      to: TO,
      limit: 2,
    });

    expect(calls).toEqual(["local", "archive"]);
    expect(result.records.map(({ timestamp, value }) => ({ timestamp, value }))).toEqual([
      { timestamp: overlapAt, value: 22 },
      { timestamp: "2026-07-18T00:30:00.000Z", value: 23 },
    ]);
    expect(result.provenance).toEqual({
      localSource: "sqlite",
      archiveSource: "timescale",
      archiveState: "merged",
      localHistoryComplete: true,
      localRecordCount: 2,
      archiveRecordCount: 2,
      duplicateRecordCount: 1,
      filteredSyntheticRecordCount: 0,
      returnedRecordCount: 2,
    });
  });

  it("always reads SQLite, skips an archive that is not ready, and reports local provenance", async () => {
    const local = localReader({ measurementHistory: vi.fn(() => [measurement(FROM, 10)]) });
    const archive = archiveReader({ measurementHistory: vi.fn(async () => [measurement(TO, 99)]) });
    const reader = new HybridTelemetryReader({ local, archive, archivePhase: () => "initializing" });

    const result = await reader.measurementHistory({ sensorId: "sensor-a", metric: "temperature", from: FROM, to: TO });

    expect(local.measurementHistory).toHaveBeenCalledOnce();
    expect(archive.measurementHistory).not.toHaveBeenCalled();
    expect(result.records.map((item) => item.value)).toEqual([10]);
    expect(result.provenance).toMatchObject({
      archiveSource: "timescale",
      archiveState: "not-ready",
      localHistoryComplete: true,
    });
  });

  it("falls back to complete local history on archive failure, wakes reconciliation, and never exposes the error", async () => {
    const reconcile = vi.fn(() => Promise.reject(new Error("secondary wake-up failure")));
    const archive = archiveReader({
      measurementHistory: vi.fn(async () => { throw new Error("postgres://user:secret@archive"); }),
    });
    const reader = new HybridTelemetryReader({
      local: localReader({ measurementHistory: vi.fn(() => [measurement(FROM, 12)]) }),
      archive,
      archivePhase: () => "ready",
      reconcile,
      localHistoryComplete: true,
    });

    const result = await reader.measurementHistory({ sensorId: "sensor-a", metric: "temperature", from: FROM, to: TO });

    expect(result.records.map((item) => item.value)).toEqual([12]);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(result.provenance.archiveState).toBe("failed");
    expect(JSON.stringify(result.provenance)).not.toContain("secret");
  });

  it("fails closed when the archive is unavailable after the SQLite history becomes incomplete", async () => {
    const reconcile = vi.fn();
    const reader = new HybridTelemetryReader({
      local: localReader({ measurementHistory: vi.fn(() => [measurement(TO, 12)]) }),
      archive: archiveReader({ measurementHistory: vi.fn(async () => { throw new Error("offline"); }) }),
      archivePhase: () => "ready",
      reconcile,
      localHistoryComplete: ({ from }) => from >= "2026-07-18T00:30:00.000Z",
    });

    await expect(reader.measurementHistory({ sensorId: "sensor-a", metric: "temperature", from: FROM, to: TO }))
      .rejects.toMatchObject<Partial<IncompleteTelemetryHistoryError>>({
        code: "TELEMETRY_ARCHIVE_REQUIRED",
        archiveState: "failed",
      });
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("filters mock and replay rows from both stores after the real-data latch", async () => {
    const reader = new HybridTelemetryReader({
      local: localReader({
        isRealDataMode: vi.fn(() => true),
        measurementHistory: vi.fn(() => [
          measurement("2026-07-18T00:10:00.000Z", 1, "mock"),
          measurement("2026-07-18T00:20:00.000Z", 2, "api"),
        ]),
      }),
      archive: archiveReader({
        measurementHistory: vi.fn(async () => [
          measurement("2026-07-18T00:05:00.000Z", 3, "replay"),
          measurement("2026-07-18T00:15:00.000Z", 4, "home-assistant"),
        ]),
      }),
      archivePhase: () => "ready",
    });

    const result = await reader.measurementHistory({ sensorId: "sensor-a", metric: "temperature", from: FROM, to: TO });

    expect(result.records.map((item) => item.source)).toEqual(["home-assistant", "api"]);
    expect(result.provenance.filteredSyntheticRecordCount).toBe(2);
  });

  it("uses a batch archive window when available and de-duplicates query dimensions and records", async () => {
    const batch = vi.fn(async () => [
      measurement("2026-07-18T00:10:00.000Z", 10, "api", "sensor-a", "temperature"),
      measurement("2026-07-18T00:20:00.000Z", 40, "api", "sensor-b", "humidity"),
    ]);
    const local = localReader({
      measurementWindow: vi.fn(() => [
        measurement("2026-07-18T00:20:00.000Z", 45, "api", "sensor-b", "humidity"),
        measurement("2026-07-18T00:30:00.000Z", 12, "api", "sensor-a", "temperature"),
      ]),
    });
    const reader = new HybridTelemetryReader({
      local,
      archive: { ...archiveReader(), measurementWindow: batch },
      archivePhase: () => "ready",
    });

    const result = await reader.measurementWindow({
      sensorIds: ["sensor-a", "sensor-a", "sensor-b"],
      metrics: ["temperature", "humidity", "humidity"],
      from: FROM,
      to: TO,
      limit: 2,
    });

    expect(local.measurementWindow).toHaveBeenCalledWith(
      ["sensor-a", "sensor-b"],
      ["temperature", "humidity"],
      FROM,
      TO,
      2,
    );
    expect(batch).toHaveBeenCalledWith(expect.objectContaining({
      sensorIds: ["sensor-a", "sensor-b"],
      metrics: ["temperature", "humidity"],
      limit: 2,
    }));
    expect(result.records.map(({ sensorId, metric, value }) => ({ sensorId, metric, value }))).toEqual([
      { sensorId: "sensor-b", metric: "humidity", value: 45 },
      { sensorId: "sensor-a", metric: "temperature", value: 12 },
    ]);
    expect(result.provenance.duplicateRecordCount).toBe(1);
  });

  it("supports legacy and outdoor families with the same conflict policy and restores archived conditions", async () => {
    const overlapAt = "2026-07-18T00:20:00.000Z";
    const local = localReader({
      history: vi.fn(() => [reading(overlapAt, 22)]),
      outdoorTemperatureHistory: vi.fn(() => [outdoor(overlapAt, 8)]),
    });
    const archive = archiveReader({
      legacyReadingHistory: vi.fn(async () => [reading(FROM, 19), reading(overlapAt, -99)]),
      outdoorTemperatureHistory: vi.fn(async () => [{
        houseId: "house-a",
        locationKey: "location-a",
        timestamp: FROM,
        temperatureC: 7,
        source: "api",
        fetchedAt: FROM,
        stationId: "station-a",
        stationName: "Station A",
        metadata: { conditions: { timestamp: FROM, pressureHpa: 1002 } },
      }]),
    });
    const reader = new HybridTelemetryReader({ local, archive, archivePhase: () => "ready" });

    const legacy = await reader.legacyReadingHistory({ sensorIds: ["sensor-a"], from: FROM, to: TO });
    const weather = await reader.outdoorTemperatureHistory({
      houseId: "house-a",
      locationKey: "location-a",
      from: FROM,
      to: TO,
    });

    expect(legacy.records.map((item) => item.temperature)).toEqual([19, 22]);
    expect(legacy.provenance.duplicateRecordCount).toBe(1);
    expect(weather.records).toEqual([
      expect.objectContaining({ temperatureC: 7, conditions: { timestamp: FROM, pressureHpa: 1002 } }),
      expect.objectContaining({ temperatureC: 8 }),
    ]);
    expect(weather.provenance.archiveState).toBe("merged");
  });

  it("uses exactly one complete source for cumulative energy-cost aggregates", async () => {
    const localAggregate = vi.fn(() => ({
      deltaCount: 1, consumptionKwh: 1, pricedConsumptionKwh: 1, costEur: 0.1,
      totalDurationMs: 1_000, pricedDurationMs: 1_000, coverageFrom: FROM, coverageUntil: TO,
    }));
    const archiveAggregate = vi.fn(async () => ({
      deltaCount: 2, consumptionKwh: 2, pricedConsumptionKwh: 2, costEur: 0.2,
      totalDurationMs: 2_000, pricedDurationMs: 2_000, coverageFrom: FROM, coverageUntil: TO,
    }));
    const reader = new HybridTelemetryReader({
      local: localReader({ energyCostAggregate: localAggregate }),
      archive: archiveReader({ energyCostAggregate: archiveAggregate }),
      archivePhase: () => "ready",
      localHistoryComplete: ({ from }) => from >= FROM,
    });
    const query = { sensorId: "meter-1", propertyId: "property-1", from: FROM, to: TO };
    await expect(reader.energyCostAggregate(query)).resolves.toMatchObject({ costEur: 0.1 });
    expect(localAggregate).toHaveBeenCalledOnce();
    expect(archiveAggregate).not.toHaveBeenCalled();

    await expect(reader.energyCostAggregate({ ...query, from: "2026-07-17T23:00:00.000Z" }))
      .resolves.toMatchObject({ costEur: 0.2 });
    expect(archiveAggregate).toHaveBeenCalledOnce();
    expect(localAggregate).toHaveBeenCalledOnce();
  });
});
