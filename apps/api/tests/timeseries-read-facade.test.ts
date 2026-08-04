import type {
  MeasurementSample,
  OpeningStateObservation,
  OutdoorTemperatureSample,
  PropertyElectricityPricePoint,
  Reading,
} from "@climate-twin/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  HybridTelemetryReader,
  IncompleteTelemetryHistoryError,
  isLocalTelemetryHistoryComplete,
  type ArchiveTelemetryReader,
  type LocalTelemetryReader,
} from "../src/timeseries/read-facade.js";

const FROM = "2026-07-18T00:00:00.000Z";
const TO = "2026-07-18T01:00:00.000Z";

describe("local telemetry history completeness", () => {
  it("treats zero retention as a complete duplicate and bounds positive retention", () => {
    const now = Date.parse("2026-08-04T12:00:00.000Z");

    expect(isLocalTelemetryHistoryComplete({
      timeseriesEnabled: true,
      retentionDays: 0,
      now,
    })).toBe(true);
    expect(isLocalTelemetryHistoryComplete({
      timeseriesEnabled: true,
      retentionDays: 30,
      from: "2026-08-03T12:00:00.000Z",
      now,
    })).toBe(true);
    expect(isLocalTelemetryHistoryComplete({
      timeseriesEnabled: true,
      retentionDays: 30,
      from: "2026-07-01T12:00:00.000Z",
      now,
    })).toBe(false);
    expect(isLocalTelemetryHistoryComplete({
      timeseriesEnabled: false,
      retentionDays: 30,
      now,
    })).toBe(true);
  });
});

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

function price(startAt: string, raw: number, margin: number): PropertyElectricityPricePoint {
  const effective = raw + margin;
  return {
    propertyId: "property-a",
    startAt,
    endAt: new Date(Date.parse(startAt) + 15 * 60_000).toISOString(),
    rawPriceCentsPerKwh: raw,
    effectivePriceCentsPerKwh: effective,
    effectivePriceEurPerKwh: effective / 100,
    fetchedAt: startAt,
  };
}

function opening(
  id: string,
  observedAt: string,
  state: OpeningStateObservation["state"],
): OpeningStateObservation {
  return {
    id,
    houseId: "house-a",
    floorId: "floor-a",
    elementId: "door-a",
    state,
    source: "api",
    observedAt,
  };
}

function localReader(overrides: Partial<LocalTelemetryReader> = {}): LocalTelemetryReader {
  return {
    isRealDataMode: vi.fn(() => false),
    measurementCoverage: vi.fn(() => []),
    measurementHistory: vi.fn(() => []),
    measurementWindow: vi.fn(() => []),
    history: vi.fn(() => []),
    outdoorTemperatureHistory: vi.fn(() => []),
    listPropertyElectricityPrices: vi.fn(() => []),
    listOpeningStateObservations: vi.fn(() => []),
    listOpeningStateObservationHistory: vi.fn(() => []),
    ...overrides,
  };
}

function archiveReader(overrides: Partial<ArchiveTelemetryReader> = {}): ArchiveTelemetryReader {
  return {
    measurementHistory: vi.fn(async () => []),
    legacyReadingHistory: vi.fn(async () => []),
    outdoorTemperatureHistory: vi.fn(async () => []),
    electricityPriceHistory: vi.fn(async () => []),
    openingStateHistory: vi.fn(async () => []),
    openingStateSnapshot: vi.fn(async () => []),
    ...overrides,
  };
}

describe("HybridTelemetryReader", () => {
  it("merges local and archive coverage for each selected series", async () => {
    const localCoverage = vi.fn(() => [{
      sensorId: "sensor-a", metric: "temperature",
      start: "2026-01-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z",
    }]);
    const archiveCoverage = vi.fn(async () => [{
      sensorId: "sensor-a", metric: "temperature",
      start: "2020-01-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z",
    }]);
    const reader = new HybridTelemetryReader({
      local: localReader({ isRealDataMode: vi.fn(() => true), measurementCoverage: localCoverage }),
      archive: { ...archiveReader(), measurementCoverage: archiveCoverage },
      archivePhase: () => "ready",
    });

    const result = await reader.measurementCoverage({
      sensorIds: ["sensor-a", "sensor-a"], metrics: ["temperature", "temperature"],
    });

    expect(localCoverage).toHaveBeenCalledWith(["sensor-a"], ["temperature"]);
    expect(archiveCoverage).toHaveBeenCalledWith(expect.objectContaining({
      sensorIds: ["sensor-a"], metrics: ["temperature"], excludeSynthetic: true,
    }));
    expect(result).toEqual({
      records: [{
        sensorId: "sensor-a", metric: "temperature",
        start: "2020-01-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z",
      }],
      archiveState: "merged",
      complete: true,
    });
  });

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

  it("uses the bounded archive gap search as the historical source of truth", async () => {
    const localHistory = vi.fn(() => []);
    const archiveHistory = vi.fn(async () => []);
    const localGaps = vi.fn(() => [{
      startedAt: "2026-07-18T00:20:00.000Z",
      endedAt: "2026-07-18T00:35:00.000Z",
      durationMs: 900_000,
    }]);
    const archiveGaps = vi.fn(async () => [{
      startedAt: "2026-07-18T00:10:00.000Z",
      endedAt: "2026-07-18T00:40:00.000Z",
      durationMs: 1_800_000,
    }, {
      startedAt: "2026-07-18T00:45:00.000Z",
      endedAt: TO,
      durationMs: 900_000,
    }]);
    const reader = new HybridTelemetryReader({
      local: localReader({
        measurementHistory: localHistory,
        measurementSampleGaps: localGaps,
      }),
      archive: archiveReader({
        measurementHistory: archiveHistory,
        measurementSampleGaps: archiveGaps,
      }),
      archivePhase: () => "ready",
      localHistoryComplete: false,
    });

    await expect(reader.measurementSampleGaps({
      sensorId: "sensor-a",
      metric: "temperature",
      source: "tp-link",
      from: FROM,
      to: TO,
      minimumGapMs: 15 * 60_000,
      limit: 25,
    })).resolves.toEqual([
      {
        startedAt: "2026-07-18T00:10:00.000Z",
        endedAt: "2026-07-18T00:40:00.000Z",
        durationMs: 1_800_000,
      },
      {
        startedAt: "2026-07-18T00:45:00.000Z",
        endedAt: TO,
        durationMs: 900_000,
      },
    ]);
    expect(localGaps).not.toHaveBeenCalled();
    expect(archiveGaps).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
    expect(localHistory).not.toHaveBeenCalled();
    expect(archiveHistory).not.toHaveBeenCalled();
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

  it("catches up the archive before serving a non-mergeable analytics rollup", async () => {
    let phase = "syncing";
    const reconcile = vi.fn(async () => { phase = "ready"; });
    const measurementAnalyticsRollup = vi.fn(async () => ({ series: [] }));
    const reader = new HybridTelemetryReader({
      local: localReader({ isRealDataMode: vi.fn(() => true) }),
      archive: { ...archiveReader(), measurementAnalyticsRollup },
      archivePhase: () => phase,
      reconcile,
      localHistoryComplete: false,
    });

    const result = await reader.measurementAnalyticsRollup({
      series: [{ sensorId: "sensor-a", metric: "power", aggregation: "time_weighted_mean" }],
      from: FROM,
      to: TO,
      resolution: "1h",
      qualities: ["good", "estimated"],
    });

    expect(reconcile).toHaveBeenCalledOnce();
    expect(measurementAnalyticsRollup).toHaveBeenCalledWith(expect.objectContaining({
      excludeSynthetic: true,
    }));
    expect(result).toEqual({ result: { series: [] }, archiveState: "merged" });
  });

  it("uses raw archive samples when thermal rollups briefly lag live ingestion", async () => {
    const reconcile = vi.fn(async () => undefined);
    const thermalMeasurementHistory = vi.fn(async () => {
      throw new Error("rollup coverage is behind the raw archive");
    });
    const measurementWindow = vi.fn(async () => [
      measurement("2026-07-18T00:01:00.000Z", 20),
      { ...measurement("2026-07-18T00:02:00.000Z", 24), quality: "estimated" as const },
    ]);
    const reader = new HybridTelemetryReader({
      local: localReader({ isRealDataMode: vi.fn(() => true) }),
      archive: { ...archiveReader(), thermalMeasurementHistory, measurementWindow },
      archivePhase: () => "ready",
      reconcile,
      localHistoryComplete: false,
    });

    const result = await reader.thermalMeasurementHistory({
      sensorId: "sensor-a",
      metrics: ["temperature"],
      from: FROM,
      to: TO,
      bucketMinutes: 15,
      limitPerMetric: 100,
    });

    expect(thermalMeasurementHistory).toHaveBeenCalledOnce();
    expect(measurementWindow).toHaveBeenCalledWith(expect.objectContaining({
      sensorIds: ["sensor-a"], metrics: ["temperature"], limit: 250_000,
    }));
    expect(reconcile).toHaveBeenCalledOnce();
    expect(result.records).toEqual([expect.objectContaining({
      timestamp: "2026-07-18T00:00:00.000Z",
      value: 20.8,
      quality: "good",
    })]);
    expect(result.provenance.archiveState).toBe("merged");
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

  it("merges archived electricity prices with the SQLite hot copy and preserves historical margins", async () => {
    const overlapAt = "2026-07-18T00:15:00.000Z";
    const reader = new HybridTelemetryReader({
      local: localReader({
        listPropertyElectricityPrices: vi.fn(() => [price(overlapAt, 20, 2)]),
      }),
      archive: archiveReader({
        electricityPriceHistory: vi.fn(async () => [
          {
            propertyId: "property-a",
            startAt: FROM,
            endAt: overlapAt,
            rawPriceCentsPerKwh: 10,
            marginCentsPerKwh: 1,
            source: "sqlite",
            fetchedAt: FROM,
          },
          {
            propertyId: "property-a",
            startAt: overlapAt,
            endAt: "2026-07-18T00:30:00.000Z",
            rawPriceCentsPerKwh: -99,
            marginCentsPerKwh: 0,
            source: "sqlite",
            fetchedAt: FROM,
          },
        ]),
      }),
      archivePhase: () => "ready",
    });

    const result = await reader.electricityPriceHistory({
      propertyId: "property-a",
      from: FROM,
      to: TO,
    });

    expect(result.records).toEqual([
      expect.objectContaining({ startAt: FROM, effectivePriceCentsPerKwh: 11, effectivePriceEurPerKwh: 0.11 }),
      expect.objectContaining({ startAt: overlapAt, effectivePriceCentsPerKwh: 22, effectivePriceEurPerKwh: 0.22 }),
    ]);
    expect(result.provenance).toMatchObject({
      archiveState: "merged",
      duplicateRecordCount: 1,
    });
  });

  it("merges opening-event history and keeps the newest state in cross-store snapshots", async () => {
    const localAt = "2026-07-18T00:15:00.000Z";
    const archivedAt = "2026-07-18T00:30:00.000Z";
    const reader = new HybridTelemetryReader({
      local: localReader({
        listOpeningStateObservationHistory: vi.fn(() => [
          opening("event-overlap", localAt, "open"),
        ]),
        listOpeningStateObservations: vi.fn(() => [
          opening("local-snapshot", localAt, "open"),
        ]),
      }),
      archive: archiveReader({
        openingStateHistory: vi.fn(async () => [{
          observationId: "event-archived",
          houseId: "house-a",
          floorId: "floor-a",
          elementId: "door-a",
          state: "closed",
          openFraction: null,
          source: "api",
          observedAt: FROM,
          validUntil: null,
          externalId: null,
          connectionId: null,
          recordedAt: FROM,
          metadata: {},
        }, {
          observationId: "event-overlap",
          houseId: "house-a",
          floorId: "floor-a",
          elementId: "door-a",
          state: "closed",
          openFraction: null,
          source: "api",
          observedAt: localAt,
          validUntil: null,
          externalId: null,
          connectionId: null,
          recordedAt: localAt,
          metadata: {},
        }]),
        openingStateSnapshot: vi.fn(async () => [{
          observationId: "archived-snapshot",
          houseId: "house-a",
          floorId: "floor-a",
          elementId: "door-a",
          state: "closed",
          openFraction: null,
          source: "api",
          observedAt: archivedAt,
          validUntil: null,
          externalId: null,
          connectionId: null,
          recordedAt: archivedAt,
          metadata: {},
        }]),
      }),
      archivePhase: () => "ready",
    });

    const history = await reader.openingStateHistory({ houseId: "house-a", from: FROM, to: TO });
    const snapshot = await reader.openingStateSnapshot({ houseId: "house-a", at: TO });

    expect(history.records).toEqual([
      expect.objectContaining({ id: "event-archived", state: "closed" }),
      expect.objectContaining({ id: "event-overlap", state: "open" }),
    ]);
    expect(history.provenance.duplicateRecordCount).toBe(1);
    expect(snapshot.records).toEqual([
      expect.objectContaining({ id: "archived-snapshot", state: "closed", observedAt: archivedAt }),
    ]);
    expect(snapshot.provenance.duplicateRecordCount).toBe(1);
  });

  it("uses the acknowledged archive as the sole source for cumulative energy-cost aggregates", async () => {
    const localAggregate = vi.fn(() => ({
      deltaCount: 1, consumptionKwh: 1, pricedConsumptionKwh: 1, costEur: 0.1,
      totalDurationMs: 1_000, pricedDurationMs: 1_000, coverageFrom: FROM, coverageUntil: TO,
    }));
    const archiveAggregate = vi.fn(async () => ({
      deltaCount: 2, consumptionKwh: 2, pricedConsumptionKwh: 2, costEur: 0.2,
      totalDurationMs: 2_000, pricedDurationMs: 2_000, coverageFrom: FROM, coverageUntil: TO,
    }));
    const localPowerAggregate = vi.fn(() => ({
      deltaCount: 3, consumptionKwh: 3, pricedConsumptionKwh: 3, costEur: 0.3,
      totalDurationMs: 3_000, pricedDurationMs: 3_000, coverageFrom: FROM, coverageUntil: TO,
    }));
    const archivePowerAggregate = vi.fn(async () => ({
      deltaCount: 4, consumptionKwh: 4, pricedConsumptionKwh: 4, costEur: 0.4,
      totalDurationMs: 4_000, pricedDurationMs: 4_000, coverageFrom: FROM, coverageUntil: TO,
    }));
    const reader = new HybridTelemetryReader({
      local: localReader({
        energyCostAggregate: localAggregate,
        powerCostAggregate: localPowerAggregate,
      }),
      archive: archiveReader({
        energyCostAggregate: archiveAggregate,
        powerCostAggregate: archivePowerAggregate,
      }),
      archivePhase: () => "ready",
      localHistoryComplete: ({ from }) => from >= FROM,
    });
    const query = { sensorId: "meter-1", propertyId: "property-1", from: FROM, to: TO };
    await expect(reader.energyCostAggregate(query)).resolves.toMatchObject({
      costEur: 0.2,
      archiveState: "archived",
    });
    expect(localAggregate).not.toHaveBeenCalled();
    expect(archiveAggregate).toHaveBeenCalledOnce();

    await expect(reader.energyCostAggregate({ ...query, from: "2026-07-17T23:00:00.000Z" }))
      .resolves.toMatchObject({ costEur: 0.2 });
    expect(archiveAggregate).toHaveBeenCalledTimes(2);
    expect(localAggregate).not.toHaveBeenCalled();

    await expect(reader.powerCostAggregate(query)).resolves.toMatchObject({ costEur: 0.4 });
    await expect(reader.powerCostAggregate({ ...query, from: "2026-07-17T23:00:00.000Z" }))
      .resolves.toMatchObject({ costEur: 0.4 });
    expect(localPowerAggregate).not.toHaveBeenCalled();
    expect(archivePowerAggregate).toHaveBeenCalledTimes(2);
  });

  it("uses archive cost aggregates while synchronization is in progress", async () => {
    const localAggregate = vi.fn(() => ({
      deltaCount: 1, consumptionKwh: 1, pricedConsumptionKwh: 0, costEur: 0,
      totalDurationMs: 1_000, pricedDurationMs: 0, coverageFrom: FROM, coverageUntil: TO,
    }));
    const archiveAggregate = vi.fn(async () => ({
      deltaCount: 2, consumptionKwh: 2, pricedConsumptionKwh: 2, costEur: 0.2,
      totalDurationMs: 2_000, pricedDurationMs: 2_000, coverageFrom: FROM, coverageUntil: TO,
    }));
    const reader = new HybridTelemetryReader({
      local: localReader({
        energyCostAggregate: localAggregate,
        powerCostAggregate: localAggregate,
      }),
      archive: archiveReader({
        energyCostAggregate: archiveAggregate,
        powerCostAggregate: archiveAggregate,
      }),
      archivePhase: () => "syncing",
      localHistoryComplete: false,
    });
    const query = { sensorId: "meter-1", propertyId: "property-1", from: FROM, to: TO };

    await expect(reader.energyCostAggregate(query)).resolves.toMatchObject({
      costEur: 0.2,
      archiveState: "pending",
    });
    await expect(reader.powerCostAggregate(query)).resolves.toMatchObject({
      costEur: 0.2,
      archiveState: "pending",
    });
    expect(archiveAggregate).toHaveBeenCalledTimes(2);
    expect(localAggregate).not.toHaveBeenCalled();
  });
});
