import { describe, expect, it, vi } from "vitest";
import { TelemetryBus } from "../src/events.js";
import { TelemetryArchiveWorker } from "../src/timeseries/archive-worker.js";
import { TelemetryRetentionWorker } from "../src/timeseries/retention-worker.js";
import type { ClimateDatabase } from "../src/db.js";
import { TELEMETRY_TABLES, type TelemetryTableName } from "../src/timeseries/schema.js";
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
    openingStateArchivePage: () => [],
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
    upsertOpeningStateSamples: vi.fn(async (rows: unknown[]) => ({ attempted: rows.length, affected: rows.length })),
    upsertHeatPumpStateSamples: vi.fn(async (rows: unknown[]) => ({ attempted: rows.length, affected: rows.length })),
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

  it("coalesces live samples into a measurement-only flush instead of scanning every archive table", async () => {
    vi.useFakeTimers();
    try {
      const archiveStore = store();
      const bus = new TelemetryBus();
      const watermarks = {};
      const database = fixtures({
        measurementArchivePage: () => [],
        telemetryArchiveDirtyCount: vi.fn(() => 0),
        telemetryArchiveWatermarks: vi.fn(() => watermarks),
        purgeReadingsBefore: vi.fn(() => 2),
      });
      const worker = new TelemetryArchiveWorker(database, bus, archiveStore, {
        batchSize: 10,
        liveFlushIntervalMs: 1_000,
      });
      await worker.start();
      await worker.reconcileNow();
      vi.mocked(archiveStore.archiveCheckpoint).mockClear();
      vi.mocked(archiveStore.upsertMeasurementSamples).mockClear();

      bus.publishMeasurement({
        sensorId: "sensor-1", metric: "temperature", value: 20, canonicalUnit: "C",
        timestamp: "2026-07-18T00:01:00.000Z", source: "api", quality: "good",
      });
      bus.publishMeasurement({
        sensorId: "sensor-1", metric: "humidity", value: 45, canonicalUnit: "%",
        timestamp: "2026-07-18T00:01:00.000Z", source: "api", quality: "good",
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(archiveStore.upsertMeasurementSamples).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(archiveStore.upsertMeasurementSamples).toHaveBeenCalledOnce();
      expect(archiveStore.upsertMeasurementSamples).toHaveBeenCalledWith([
        expect.objectContaining({ metric: "temperature", value: 20 }),
        expect.objectContaining({ metric: "humidity", value: 45 }),
      ]);
      expect(archiveStore.archiveCheckpoint).not.toHaveBeenCalled();
      expect(worker.status()).toMatchObject({ phase: "ready", caughtUp: true, queuedSamples: 0 });

      const retention = new TelemetryRetentionWorker(database, worker, 30);
      await expect(retention.runOnce()).resolves.toBe(2);
      expect(database.purgeReadingsBefore).toHaveBeenCalledWith(expect.any(String), 5_000, watermarks);
      await retention.stop();
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a failed live batch queued for the next authoritative reconciliation", async () => {
    vi.useFakeTimers();
    try {
      const upsertMeasurementSamples = vi.fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue({ attempted: 1, affected: 1 });
      const archiveStore = store({ upsertMeasurementSamples });
      const bus = new TelemetryBus();
      const worker = new TelemetryArchiveWorker(fixtures({
        measurementArchivePage: () => [],
      }), bus, archiveStore, {
        batchSize: 10,
        liveFlushIntervalMs: 1_000,
        retryIntervalMs: 60_000,
      });
      await worker.start();
      await worker.reconcileNow();

      bus.publishMeasurement({
        sensorId: "sensor-1", metric: "temperature", value: 20, canonicalUnit: "C",
        timestamp: "2026-07-18T00:01:00.000Z", source: "api", quality: "good",
      });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(worker.status()).toMatchObject({
        phase: "degraded",
        caughtUp: false,
        queuedSamples: 1,
        lastError: "reconciliation-failed",
      });
      bus.publishMeasurement({
        sensorId: "sensor-1", metric: "humidity", value: 45, canonicalUnit: "%",
        timestamp: "2026-07-18T00:01:00.000Z", source: "api", quality: "good",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(upsertMeasurementSamples).toHaveBeenCalledOnce();

      await worker.reconcileNow();

      expect(upsertMeasurementSamples).toHaveBeenCalledTimes(2);
      expect(worker.status()).toMatchObject({ phase: "ready", caughtUp: true, queuedSamples: 0 });
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("protects a blocked live batch from queue-overflow eviction until it can retry", async () => {
    vi.useFakeTimers();
    try {
      let rejectWrite: ((error: Error) => void) | undefined;
      const blockedWrite = new Promise<{ attempted: number; affected: number }>((_resolve, reject) => {
        rejectWrite = reject;
      });
      const upsertMeasurementSamples = vi.fn()
        .mockImplementationOnce(() => blockedWrite)
        .mockImplementation(async (rows: unknown[]) => ({ attempted: rows.length, affected: rows.length }));
      const archiveStore = store({ upsertMeasurementSamples });
      const bus = new TelemetryBus();
      const worker = new TelemetryArchiveWorker(fixtures({
        measurementArchivePage: () => [],
      }), bus, archiveStore, {
        batchSize: 100,
        liveFlushIntervalMs: 1_000,
        retryIntervalMs: 60_000,
      });
      await worker.start();
      await worker.reconcileNow();

      bus.publishMeasurement({
        sensorId: "sensor-1", metric: "temperature", value: 1, canonicalUnit: "C",
        timestamp: "2026-07-18T00:01:00.000Z", source: "api", quality: "good",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(upsertMeasurementSamples).toHaveBeenCalledOnce();

      for (let value = 2; value <= 1_001; value += 1) {
        bus.publishMeasurement({
          sensorId: "sensor-1", metric: "temperature", value, canonicalUnit: "C",
          timestamp: new Date(Date.parse("2026-07-18T00:01:00.000Z") + value).toISOString(),
          source: "api", quality: "good",
        });
      }
      expect(worker.status()).toMatchObject({ queuedSamples: 1_000, droppedQueueSamples: 1 });

      rejectWrite?.(new Error("offline"));
      await vi.waitFor(() => expect(worker.status().phase).toBe("degraded"));
      await worker.reconcileNow();

      expect(upsertMeasurementSamples.mock.calls[1]?.[0]).toEqual([
        expect.objectContaining({ value: 1 }),
        ...Array.from({ length: 99 }, () => expect.any(Object)),
      ]);
      expect(worker.status()).toMatchObject({ phase: "ready", caughtUp: true, queuedSamples: 0 });
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for an active live flush before closing the archive store", async () => {
    vi.useFakeTimers();
    try {
      let releaseWrite: (() => void) | undefined;
      const writeBlocked = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const archiveStore = store({
        upsertMeasurementSamples: vi.fn(async (rows: unknown[]) => {
          await writeBlocked;
          return { attempted: rows.length, affected: rows.length };
        }),
      });
      const bus = new TelemetryBus();
      const worker = new TelemetryArchiveWorker(fixtures({
        measurementArchivePage: () => [],
      }), bus, archiveStore, {
        batchSize: 10,
        liveFlushIntervalMs: 1_000,
      });
      await worker.start();
      await worker.reconcileNow();

      bus.publishMeasurement({
        sensorId: "sensor-1", metric: "temperature", value: 20, canonicalUnit: "C",
        timestamp: "2026-07-18T00:01:00.000Z", source: "api", quality: "good",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const stop = worker.stop();

      expect(archiveStore.close).not.toHaveBeenCalled();
      releaseWrite?.();
      await stop;
      expect(archiveStore.close).toHaveBeenCalledOnce();
      expect(worker.status()).toMatchObject({ phase: "stopped", caughtUp: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("archives raw TP-Link climate samples and readings to TimescaleDB", async () => {
    const timestamp = "2026-07-18T00:02:00.000Z";
    const archiveStore = store();
    const worker = new TelemetryArchiveWorker(fixtures({
      measurementArchivePage: (cursor: number) => cursor === 0 ? [
        {
          rowId: 1,
          record: {
            sensorId: "t310-1", metric: "temperature", value: 20.5, canonicalUnit: "C",
            timestamp, source: "tp-link", quality: "good",
          },
        },
        {
          rowId: 2,
          record: {
            sensorId: "t310-1", metric: "humidity", value: 48, canonicalUnit: "%",
            timestamp, source: "tp-link", quality: "good",
          },
        },
      ] : [],
      readingArchivePage: (cursor: number) => cursor === 0 ? [{
        rowId: 1,
        record: {
          sensorId: "t310-1", temperature: 20.5, humidity: 48, battery: 91,
          timestamp, source: "tp-link", quality: "good",
        },
      }] : [],
    }), new TelemetryBus(), archiveStore, { batchSize: 10 });

    await worker.start();
    await worker.reconcileNow();

    expect(archiveStore.upsertMeasurementSamples).toHaveBeenCalledWith([
      expect.objectContaining({ sensorId: "t310-1", metric: "temperature", source: "tp-link" }),
      expect.objectContaining({ sensorId: "t310-1", metric: "humidity", source: "tp-link" }),
    ]);
    expect(archiveStore.upsertLegacyReadings).toHaveBeenCalledWith([
      expect.objectContaining({ sensorId: "t310-1", temperature: 20.5, humidity: 48, source: "tp-link" }),
    ]);
    expect(archiveStore.saveArchiveCheckpoint).toHaveBeenCalledWith("sqlite-source", "measurement_samples", 2);
    expect(archiveStore.saveArchiveCheckpoint).toHaveBeenCalledWith("sqlite-source", "legacy_readings", 1);
    await worker.stop();
  });

  it("archives fetched electricity-price intervals with their historical margin", async () => {
    const archiveStore = store();
    const worker = new TelemetryArchiveWorker(fixtures({
      electricityPriceArchivePage: (cursor: number) => cursor === 0 ? [{
        rowId: 7,
        record: {
          propertyId: "property-main",
          startAt: "2026-07-18T00:00:00.000Z",
          endAt: "2026-07-18T00:15:00.000Z",
          rawPriceCentsPerKwh: 8.5,
          marginCentsPerKwh: 0.45,
          source: "sqlite",
          fetchedAt: "2026-07-17T12:00:00.000Z",
        },
      }] : [],
    }), new TelemetryBus(), archiveStore, { batchSize: 10 });

    await worker.start();
    await worker.reconcileNow();

    expect(archiveStore.upsertElectricityPriceSamples).toHaveBeenCalledWith([
      expect.objectContaining({
        propertyId: "property-main",
        rawPriceCentsPerKwh: 8.5,
        marginCentsPerKwh: 0.45,
      }),
    ]);
    expect(archiveStore.saveArchiveCheckpoint).toHaveBeenCalledWith(
      "sqlite-source",
      "electricity_price_samples",
      7,
    );
    await worker.stop();
  });

  it("archives every direct heat-pump poll through a durable checkpoint", async () => {
    const observedAt = "2026-07-18T00:10:00.000Z";
    const archiveStore = store();
    const heatPumpStatePage = (cursor: number) => cursor === 0 ? [{
      rowId: 4,
      record: {
        connectionId: "gree-aabbccddeeff",
        houseId: "house-main",
        equipmentId: "heat-pump-aabbccddeeff",
        deviceId: "AABBCCDDEEFF",
        name: "Nordkapp",
        brand: "Wilfa",
        model: "Nordkapp 30",
        observedAt,
        receivedAt: "2026-07-18T00:10:01.000Z",
        available: true,
        power: true,
        selectedMode: "cool" as const,
        targetTemperatureC: 22,
        currentTemperatureC: 25.5,
        currentTemperatureSource: "reported" as const,
        fanSpeed: "Auto",
        horizontalSwing: "Default",
        verticalSwing: "FullSwing",
        quiet: false,
        turbo: false,
        xfan: true,
        activity: "unknown" as const,
        activityEvidence: "unavailable" as const,
      },
    }] : [];
    const worker = new TelemetryArchiveWorker(fixtures(), new TelemetryBus(), archiveStore, {
      batchSize: 10,
      heatPumpStatePage,
    });

    await worker.start();
    await worker.reconcileNow();

    expect(archiveStore.upsertHeatPumpStateSamples).toHaveBeenCalledWith([
      expect.objectContaining({
        connectionId: "gree-aabbccddeeff",
        observedAt,
        currentTemperatureC: 25.5,
      }),
    ]);
    expect(archiveStore.saveArchiveCheckpoint).toHaveBeenCalledWith(
      "sqlite-source",
      "heat_pump_state_samples",
      4,
    );
    await worker.stop();
  });

  it("archives door and window transitions before compacting acknowledged SQLite history", async () => {
    const calls: string[] = [];
    const watermarks = Object.fromEntries(TELEMETRY_TABLES.map((table) => [table, 9]));
    const database = fixtures({
      openingStateArchivePage: (cursor: number) => cursor === 0 ? [{
        rowId: 9,
        record: {
          observationId: "opening-event-9",
          houseId: "house-main",
          floorId: "ground",
          elementId: "front-door",
          state: "open",
          openFraction: 1,
          source: "tapo",
          observedAt: "2026-07-18T00:15:00.000Z",
          validUntil: null,
          externalId: "contact-1",
          connectionId: "tapo-main",
          recordedAt: "2026-07-18T00:15:01.000Z",
        },
      }] : [],
      telemetryArchiveWatermarks: () => watermarks,
      purgeReadingsBefore: vi.fn(() => {
        calls.push("prune");
        return 3;
      }),
    });
    const archiveStore = store({
      initialize: vi.fn(async () => ({
        schema: "telemetry",
        timescaleAvailable: true,
        timescaleVersion: "2.test",
        hypertables: [...TELEMETRY_TABLES],
        aggregateMode: "continuous",
        coldStorageMode: "columnstore",
        warnings: [],
      })),
      upsertOpeningStateSamples: vi.fn(async (rows: unknown[]) => {
        calls.push("write");
        return { attempted: rows.length, affected: rows.length };
      }),
      saveArchiveCheckpoint: vi.fn(async (_sourceId: string, table: TelemetryTableName) => {
        if (table === "opening_state_samples") calls.push("checkpoint");
      }),
    });
    const worker = new TelemetryArchiveWorker(database, new TelemetryBus(), archiveStore, {
      batchSize: 10,
      localHistoryRetentionDays: 30,
    });

    await worker.start();
    await worker.reconcileNow();

    expect(archiveStore.upsertOpeningStateSamples).toHaveBeenCalledWith([
      expect.objectContaining({
        observationId: "opening-event-9",
        state: "open",
        externalId: "contact-1",
      }),
    ]);
    expect(archiveStore.saveArchiveCheckpoint).toHaveBeenCalledWith(
      "sqlite-source",
      "opening_state_samples",
      9,
    );
    expect(database.purgeReadingsBefore).toHaveBeenCalledWith(
      expect.any(String),
      5_000,
      watermarks,
    );
    expect(calls.indexOf("write")).toBeLessThan(calls.indexOf("checkpoint"));
    expect(calls.indexOf("checkpoint")).toBeLessThan(calls.indexOf("prune"));
    expect(worker.status()).toMatchObject({ caughtUp: true, localRowsPruned: 3 });
    await worker.stop();
  });

  it("keeps the complete SQLite duplicate when retention is unbounded", async () => {
    const purgeReadingsBefore = vi.fn(() => 3);
    const database = fixtures({ purgeReadingsBefore });
    const archiveStore = store({
      initialize: vi.fn(async () => ({
        schema: "telemetry",
        timescaleAvailable: true,
        timescaleVersion: "2.test",
        hypertables: [...TELEMETRY_TABLES],
        aggregateMode: "continuous",
        coldStorageMode: "columnstore",
        warnings: [],
      })),
    });
    const worker = new TelemetryArchiveWorker(database, new TelemetryBus(), archiveStore, {
      batchSize: 10,
      localHistoryRetentionDays: 0,
    });

    await worker.start();
    await worker.reconcileNow();

    expect(purgeReadingsBefore).not.toHaveBeenCalled();
    expect(worker.status()).toMatchObject({ caughtUp: true, localRowsPruned: 0 });
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
