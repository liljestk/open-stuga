import { describe, expect, it, vi } from "vitest";
import { TelemetryBus } from "../src/events.js";
import { TelemetryArchiveWorker } from "../src/timeseries/archive-worker.js";
import type { ClimateDatabase } from "../src/db.js";
import type { TelemetryTableName } from "../src/timeseries/schema.js";
import type { TimeseriesStore } from "../src/timeseries/store.js";

function fixtures(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    telemetryArchiveSourceId: () => "sqlite-source",
    telemetryArchiveCheckpoint: () => 0,
    saveTelemetryArchiveCheckpoint: () => undefined,
    telemetryArchiveStateToken: () => "stable",
    isRealDataMode: () => false,
    realDataModeActivatedAt: () => null,
    measurementArchivePage: (cursor: number) => cursor === 0 ? [{
      rowId: 1,
      record: {
        sensorId: "sensor-1", metric: "temperature", value: 20, canonicalUnit: "°C",
        timestamp: "2026-07-18T00:00:00.000Z", source: "api", quality: "good",
      },
    }] : [],
    readingArchivePage: () => [],
    outdoorTemperatureArchivePage: () => [],
    electricityPriceArchivePage: () => [],
    readingArchiveDirtyPage: () => [],
    outdoorTemperatureArchiveDirtyPage: () => [],
    electricityPriceArchiveDirtyPage: () => [],
    acknowledgeTelemetryArchiveDirtyRows: () => 0,
    ...overrides,
  } as unknown as ClimateDatabase;
}

function store(overrides: Partial<Record<string, unknown>> = {}) {
  const checkpoints = new Map<string, number>();
  const implementation = {
    initialize: vi.fn(async () => ({
      schema: "telemetry", timescaleAvailable: true, timescaleVersion: "2.test", hypertables: [],
      aggregateMode: "continuous", coldStorageMode: "columnstore", warnings: [],
    })),
    archiveCheckpoint: vi.fn(async (sourceId: string, table: TelemetryTableName) => checkpoints.get(`${sourceId}:${table}`) ?? 0),
    saveArchiveCheckpoint: vi.fn(async (sourceId: string, table: TelemetryTableName, rowId: number) => {
      checkpoints.set(`${sourceId}:${table}`, rowId);
    }),
    upsertMeasurementSamples: vi.fn(async (rows: unknown[]) => ({ attempted: rows.length, affected: rows.length })),
    upsertLegacyReadings: vi.fn(async (rows: unknown[]) => ({ attempted: rows.length, affected: rows.length })),
    upsertOutdoorTemperatureSamples: vi.fn(async (rows: unknown[]) => ({ attempted: rows.length, affected: rows.length })),
    upsertElectricityPriceSamples: vi.fn(async (rows: unknown[]) => ({ attempted: rows.length, affected: rows.length })),
    enforceRealDataBoundary: vi.fn(async () => 0),
    invalidateInitialization: vi.fn(() => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
  return implementation as unknown as TimeseriesStore & {
    archiveCheckpoint(sourceId: string, table: TelemetryTableName): Promise<number>;
    saveArchiveCheckpoint(sourceId: string, table: TelemetryTableName, rowId: number): Promise<void>;
  };
}

describe("TelemetryArchiveWorker", () => {
  it("advances a durable checkpoint only after an idempotent page write", async () => {
    const archiveStore = store();
    const worker = new TelemetryArchiveWorker(fixtures(), new TelemetryBus(), archiveStore, {
      batchSize: 10,
      reconcileIntervalMs: 60_000,
    });

    await worker.start();
    await worker.reconcileNow();

    expect(archiveStore.upsertMeasurementSamples).toHaveBeenCalledOnce();
    expect(archiveStore.saveArchiveCheckpoint).toHaveBeenCalledWith("sqlite-source", "measurement_samples", 1);
    expect(worker.status()).toMatchObject({ phase: "ready", caughtUp: true, timescaleAvailable: true });
    await worker.stop();
  });

  it("does not advance the checkpoint when a page write fails", async () => {
    const archiveStore = store({
      upsertMeasurementSamples: vi.fn(async () => { throw new Error("offline"); }),
    });
    const worker = new TelemetryArchiveWorker(fixtures(), new TelemetryBus(), archiveStore, {
      batchSize: 10,
      retryIntervalMs: 60_000,
    });

    await worker.start();
    await expect(worker.reconcileNow()).rejects.toThrow("offline");

    expect(archiveStore.saveArchiveCheckpoint).not.toHaveBeenCalled();
    expect(worker.status()).toMatchObject({ phase: "degraded", caughtUp: false, lastError: "reconciliation-failed" });
    await worker.stop();
  });

  it("fails closed when required Timescale hypertables are unavailable", async () => {
    const archiveStore = store({
      initialize: vi.fn(async () => ({
        schema: "telemetry", timescaleAvailable: true, timescaleVersion: "2.test",
        hypertables: ["measurement_samples"], aggregateMode: "continuous",
        coldStorageMode: "columnstore", warnings: ["missing hypertables"],
      })),
    });
    const worker = new TelemetryArchiveWorker(fixtures(), new TelemetryBus(), archiveStore, {
      batchSize: 10,
      requireTimescale: true,
      retryIntervalMs: 60_000,
    });

    await expect(worker.start()).rejects.toThrow("Required TimescaleDB telemetry hypertables are unavailable");
    expect(archiveStore.invalidateInitialization).toHaveBeenCalledOnce();
    expect(worker.status()).toMatchObject({ phase: "degraded", caughtUp: false, lastError: "initialization-failed" });
    await worker.stop();
  });

  it("uses the live queue as a low-latency path without relying on it for checkpoints", async () => {
    const archiveStore = store();
    const bus = new TelemetryBus();
    const worker = new TelemetryArchiveWorker(fixtures(), bus, archiveStore, { batchSize: 10 });
    await worker.start();
    await worker.reconcileNow();
    vi.mocked(archiveStore.upsertMeasurementSamples).mockClear();

    bus.publishMeasurement({
      sensorId: "sensor-1", metric: "humidity", value: 45, canonicalUnit: "%",
      timestamp: "2026-07-18T00:01:00.000Z", source: "api", quality: "good",
    });
    await worker.reconcileNow();

    expect(archiveStore.upsertMeasurementSamples).toHaveBeenCalledWith([
      expect.objectContaining({ metric: "humidity", value: 45 }),
    ]);
    await worker.stop();
  });

  it("retains exact outdoor conditions metadata for initial and dirty-row writes", async () => {
    const timestamp = "2026-07-18T00:04:00.000Z";
    const initialConditions = {
      timestamp,
      temperatureC: 4.2,
      relativeHumidityPercent: 76,
      windSpeedMps: 2.1,
      precipitation1hMm: 0,
    };
    const dirtyConditions = {
      timestamp,
      temperatureC: 4.8,
      dewPointC: 1.3,
      relativeHumidityPercent: 79,
      pressureHpa: 1_011.2,
      windDirectionDegrees: 185,
      windSpeedMps: 3.4,
      windGustMps: 5.9,
      precipitation1hMm: 0.2,
      cloudCoverPercent: 88,
      visibilityMeters: 9_500,
      presentWeatherCode: 51,
    };
    let dirtyPending = true;
    const database = fixtures({
      outdoorTemperatureArchivePage: (cursor: number) => cursor === 0 ? [{
        rowId: 1,
        record: {
          houseId: "house-main",
          locationKey: "metadata-location",
          timestamp,
          temperatureC: 4.2,
          source: "api",
          fetchedAt: "2026-07-18T00:04:30.000Z",
          stationId: "station-1",
          stationName: "Metadata station",
          conditions: initialConditions,
        },
      }] : [],
      outdoorTemperatureArchiveDirtyPage: () => dirtyPending ? [{
        dirtyId: 1,
        version: 2,
        record: {
          houseId: "house-main",
          locationKey: "metadata-location",
          timestamp,
          temperatureC: 4.8,
          source: "api",
          fetchedAt: "2026-07-18T00:05:30.000Z",
          stationId: "station-1",
          stationName: "Metadata station",
          conditions: dirtyConditions,
        },
      }] : [],
      acknowledgeTelemetryArchiveDirtyRows: (table: string) => {
        if (table === "outdoor_temperature_samples") dirtyPending = false;
        return 1;
      },
    });
    const archiveStore = store();
    const worker = new TelemetryArchiveWorker(database, new TelemetryBus(), archiveStore, { batchSize: 10 });

    await worker.start();
    await worker.reconcileNow();

    expect(archiveStore.upsertOutdoorTemperatureSamples).toHaveBeenNthCalledWith(1, [
      expect.objectContaining({ metadata: { conditions: initialConditions } }),
    ]);
    expect(archiveStore.upsertOutdoorTemperatureSamples).toHaveBeenNthCalledWith(2, [
      expect.objectContaining({ metadata: { conditions: dirtyConditions } }),
    ]);
    await worker.stop();
  });

  it("persists the real-data boundary after reconciliation and never re-inserts queued demo samples", async () => {
    const archiveStore = store();
    const bus = new TelemetryBus();
    const worker = new TelemetryArchiveWorker(fixtures({
      isRealDataMode: () => true,
      realDataModeActivatedAt: () => "2026-07-18T00:02:00.000Z",
    }), bus, archiveStore, { batchSize: 10 });

    await worker.start();
    bus.publishMeasurement({
      sensorId: "sensor-demo", metric: "temperature", value: 19, canonicalUnit: "Â°C",
      timestamp: "2026-07-18T00:01:00.000Z", source: "mock", quality: "good",
    });
    await worker.reconcileNow();

    expect(archiveStore.enforceRealDataBoundary).toHaveBeenCalledWith(
      "sqlite-source",
      "2026-07-18T00:02:00.000Z",
    );
    expect(archiveStore.upsertMeasurementSamples).not.toHaveBeenCalledWith([
      expect.objectContaining({ source: "mock" }),
    ]);
    expect(worker.status()).toMatchObject({ caughtUp: true, queuedSamples: 0 });
    await worker.stop();
  });

  it("drains a follow-up pass when telemetry arrives during an active reconciliation", async () => {
    const bus = new TelemetryBus();
    let injected = false;
    const archiveStore = store({
      upsertMeasurementSamples: vi.fn(async (rows: Array<{ metric: string }>) => {
        if (!injected) {
          injected = true;
          bus.publishMeasurement({
            sensorId: "sensor-1", metric: "humidity", value: 46, canonicalUnit: "%",
            timestamp: "2026-07-18T00:03:00.000Z", source: "api", quality: "good",
          });
          await Promise.resolve();
        }
        return { attempted: rows.length, affected: rows.length };
      }),
    });
    const worker = new TelemetryArchiveWorker(fixtures(), bus, archiveStore, { batchSize: 10 });

    await worker.start();
    await worker.reconcileNow();

    expect(archiveStore.upsertMeasurementSamples).toHaveBeenCalledWith([
      expect.objectContaining({ metric: "humidity", value: 46 }),
    ]);
    expect(worker.status()).toMatchObject({ phase: "ready", caughtUp: true, queuedSamples: 0 });
    await worker.stop();
  });
});
