import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { WebSocketServer, type WebSocket } from "ws";
import { createApi, type ApiRuntime } from "../src/app.js";
import { SensorGapRecoveryCoordinator, type SensorGapRecoveryAdapter } from "../src/sensor-gap-recovery.js";
import { HybridTelemetryReader } from "../src/timeseries/read-facade.js";
import { sensorGapRecoveryConfig as config } from "./sensor-gap-recoveryTestSupport.js";
import { waitFor } from "./waitForTestSupport.js";

describe("sensor data-gap recovery", () => {
  let runtime: ApiRuntime | null = null;
  let server: WebSocketServer | null = null;
  let temporaryDirectory: string | null = null;

  afterEach(async () => {
    vi.unstubAllGlobals();
    await runtime?.close();
    runtime = null;
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  });

  it("closes every live sensor gap and runs recovery when one archive scan fails", async () => {
    runtime = createApi({ config: config(), startBackground: false });
    const from = "2026-07-01T00:00:00.000Z";
    const to = "2026-07-01T01:00:00.000Z";
    for (const metric of ["temperature", "humidity"]) {
      runtime.database.noteSensorDataGap("sensor-01", metric, "tp-link", from, from);
    }
    const recoverHistory = vi.fn(async () => ({ state: "not-supported" as const, samples: [], error: null }));
    const coordinator = new SensorGapRecoveryCoordinator(runtime.database, runtime.measurements, [{
      source: "tp-link",
      availability: () => ["temperature", "humidity"].map((metric) => ({
        sensorId: "sensor-01", metric, source: "tp-link" as const, available: true, observedAt: to,
      })),
      recoverHistory,
    }], {
      telemetryReader: {
        measurementSampleGaps: vi.fn().mockRejectedValueOnce(new Error("archive unavailable")).mockResolvedValue([]),
      } as unknown as HybridTelemetryReader,
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await coordinator.runOnce(new Date(to));
      const gaps = runtime.database.listSensorDataGaps("sensor-01");
      expect(gaps).toHaveLength(2);
      expect(gaps.every((gap) => gap.endedAt === to && gap.recoveryState === "not-supported")).toBe(true);
      expect(recoverHistory).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
    }
  });

  it("applies the selected Home scope before the data-gap limit", async () => {
    runtime = createApi({ config: config(), startBackground: false });
    const mainHouse = runtime.database.getHouse("house-main")!;
    const siblingHouse = runtime.database.createHouse({
      id: "house-sibling",
      propertyId: mainHouse.propertyId,
      name: "Sibling Home",
      timezone: mainHouse.timezone,
      floors: [{
        id: "sibling-floor",
        name: "Ground",
        width: 8,
        height: 6,
        elevation: 0,
        walls: [],
        rooms: [],
      }],
    });
    runtime.database.createSensor({
      id: "sensor-sibling",
      houseId: siblingHouse.id,
      floorId: "sibling-floor",
      name: "Sibling sensor",
      room: "",
      model: "T310",
      x: 1,
      y: 1,
      z: 1,
      tags: [],
      enabled: true,
    });
    for (const day of [1, 2]) {
      const startedAt = `2026-07-0${day}T00:00:00.000Z`;
      runtime.database.noteHistoricalSensorDataGap(
        "sensor-01",
        day === 1 ? "temperature" : "humidity",
        "tp-link",
        startedAt,
        `2026-07-0${day}T01:00:00.000Z`,
        `2026-07-0${day}T01:01:00.000Z`,
      );
    }
    for (const day of [3, 4, 5]) {
      runtime.database.noteHistoricalSensorDataGap(
        "sensor-sibling",
        "temperature",
        "tp-link",
        `2026-07-0${day}T00:00:00.000Z`,
        `2026-07-0${day}T01:00:00.000Z`,
        `2026-07-0${day}T01:01:00.000Z`,
      );
    }

    await request(runtime.app)
      .get("/api/v1/integrations/sensor-data-gaps?houseId=house-main&limit=2")
      .expect(200)
      .expect(({ body }) => {
        expect(body.gaps).toHaveLength(2);
        expect(body.gaps.map((gap: { sensorId: string }) => gap.sensorId)).toEqual(["sensor-01", "sensor-01"]);
        expect(body.gaps.map((gap: { startedAt: string }) => gap.startedAt)).toEqual([
          "2026-07-02T00:00:00.000Z",
          "2026-07-01T00:00:00.000Z",
        ]);
      });
  });

  it("does not recover persisted integration gaps into a shared Home projection", async () => {
    runtime = createApi({ config: config(), startBackground: false });
    const from = "2026-07-01T00:00:00.000Z";
    const to = "2026-07-01T01:00:00.000Z";
    runtime.database.setHouseStugubyLink("house-main", {
      stugubyId: "stuguby-test",
      authorityNodeId: "remote-node",
      publicationId: "remote-publication",
      ownership: "shared",
      editPolicy: "read-only",
      syncState: "current",
      authorityEpoch: 1,
      pendingChangeCount: 0,
      conflictCount: 0,
      recoveryState: "not-enabled",
    });
    runtime.database.noteHistoricalSensorDataGap("sensor-01", "temperature", "tp-link", from, to, from);
    const recoverHistory = vi.fn<NonNullable<SensorGapRecoveryAdapter["recoverHistory"]>>(async () => ({
      state: "complete",
      error: null,
      samples: [{
        sensorId: "sensor-01",
        metric: "temperature",
        value: 99,
        canonicalUnit: "\u00b0C",
        timestamp: "2026-07-01T00:30:00.000Z",
        source: "tp-link",
        quality: "good",
      }],
    }));
    const recovery = new SensorGapRecoveryCoordinator(runtime.database, runtime.measurements, [{
      source: "tp-link",
      availability: () => [],
      recoverHistory,
    }]);

    await recovery.runOnce(new Date("2026-07-02T00:00:00.000Z"));

    expect(recoverHistory).not.toHaveBeenCalled();
    expect(runtime.database.listSensorDataGaps("sensor-01")[0]).toMatchObject({
      recoveryState: "not-supported",
      recoverableUntil: "2026-07-01T23:45:00.000Z",
      recoveryCompleteness: "none",
      recoveredPoints: 0,
    });
    expect(runtime.database.measurementHistory("sensor-01", "temperature", from, to))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ value: 99 })]));
  });

  it("durably detects an unavailable metric and backfills it after recovery", async () => {
    runtime = createApi({ config: config(), startBackground: false });
    const outageDurationMs = 40 * 60_000;
    const base = Date.now() - outageDurationMs;
    const initialTimestamp = new Date(base).toISOString();
    runtime.measurements.ingest({
      sensorId: "sensor-01",
      metric: "temperature",
      value: 20,
      canonicalUnit: "°C",
      timestamp: initialTimestamp,
      source: "home-assistant",
      quality: "good",
    });
    runtime.measurements.ingest({
      sensorId: "sensor-01",
      metric: "humidity",
      value: 45,
      canonicalUnit: "%",
      timestamp: initialTimestamp,
      source: "home-assistant",
      quality: "good",
    });

    let available = false;
    let recoveryCalls = 0;
    const recoveredTimestamp = new Date(base + 20 * 60_000).toISOString();
    const adapter: SensorGapRecoveryAdapter = {
      source: "home-assistant",
      availability: (now = new Date()) => [{
        sensorId: "sensor-01",
        metric: "temperature",
        source: "home-assistant",
        available,
        observedAt: now.toISOString(),
      }],
      recoverHistory: async (sensorId, metric) => {
        recoveryCalls += 1;
        return {
          state: "complete",
          error: null,
          samples: [{
            sensorId,
            metric,
            value: 20.5,
            canonicalUnit: "°C",
            timestamp: recoveredTimestamp,
            source: "home-assistant",
            quality: "good",
          }],
        };
      },
    };
    const recovery = new SensorGapRecoveryCoordinator(runtime.database, runtime.measurements, [adapter], {
      retryBaseMs: 1_000,
    });

    await recovery.runOnce(new Date(base + 35 * 60_000));
    expect(runtime.database.openSensorDataGap("sensor-01", "temperature", "home-assistant")).toMatchObject({
      startedAt: initialTimestamp,
      recoveryState: "open",
      recoverableUntil: null,
      recoveryCompleteness: "unknown",
    });

    available = true;
    await recovery.runOnce(new Date(base + outageDurationMs));
    const [gap] = runtime.database.listSensorDataGaps("sensor-01");
    expect(gap).toMatchObject({
      recoveryState: "complete",
      recoverableUntil: null,
      recoveryCompleteness: "complete",
      recoveredPoints: 1,
      attemptCount: 1,
    });
    expect(recoveryCalls).toBe(1);
    expect(runtime.database.getLatestMeasurementSample("sensor-01", "temperature")).toMatchObject({
      timestamp: recoveredTimestamp,
      value: 20.5,
      source: "home-assistant",
    });
    expect(runtime.database.getLatestReading("sensor-01")).toMatchObject({
      timestamp: recoveredTimestamp,
      temperature: 20.5,
      humidity: 45,
      source: "home-assistant",
      quality: "estimated",
    });
    await request(runtime.app).get("/api/v1/integrations/sensor-data-gaps?sensorId=sensor-01")
      .expect(200)
      .expect(({ body }) => expect(body.gaps).toEqual([
        expect.objectContaining({ sensorId: "sensor-01", metric: "temperature", recoveryState: "complete" }),
      ]));

    await recovery.runOnce(new Date(base + outageDurationMs + 1_000));
    expect(recoveryCalls).toBe(1);
  });

  it("migrates existing recovery rows without losing their durable state", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "stugu-sensor-gap-migration-"));
    const databasePath = join(temporaryDirectory, "climate.sqlite");
    runtime = createApi({ config: config({ databasePath }), startBackground: false });
    const from = "2026-07-20T04:00:00.000Z";
    const gap = runtime.database.noteHistoricalSensorDataGap(
      "sensor-01",
      "temperature",
      "tp-link",
      from,
      "2026-07-20T05:00:00.000Z",
      "2026-07-20T05:01:00.000Z",
    );
    expect(runtime.database.claimSensorDataGapRecovery(
      gap.id,
      "2026-07-20T05:02:00.000Z",
      "2026-07-20T05:03:00.000Z",
    )).not.toBeNull();
    runtime.database.updateSensorDataGapRecovery(
      gap.id,
      "partial",
      2,
      "2026-07-20T05:02:30.000Z",
      "One segment remains unavailable",
      "2026-07-20T05:04:00.000Z",
    );
    await runtime.close();
    runtime = null;

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`ALTER TABLE sensor_data_gaps DROP COLUMN recovery_completeness;
      ALTER TABLE sensor_data_gaps DROP COLUMN recoverable_until;`);
    legacy.close();

    runtime = createApi({ config: config({ databasePath }), startBackground: false });
    expect(runtime.database.sensorDataGap(gap.id)).toMatchObject({
      id: gap.id,
      sensorId: "sensor-01",
      recoveryState: "partial",
      recoverableUntil: "2026-07-21T03:45:00.000Z",
      recoveryCompleteness: "partial",
      recoveredPoints: 2,
      attemptCount: 1,
      lastAttemptAt: "2026-07-20T05:02:30.000Z",
      nextAttemptAt: "2026-07-20T05:04:00.000Z",
      recoveryError: "One segment remains unavailable",
    });
  });

  it("offers even a short explicit outage to its recovery adapter once", async () => {
    runtime = createApi({ config: config(), startBackground: false });
    const from = "2026-07-19T06:00:00.000Z";
    const to = "2026-07-19T06:02:00.000Z";
    runtime.database.noteHistoricalSensorDataGap(
      "sensor-01",
      "temperature",
      "tp-link",
      from,
      to,
      from,
    );
    const recoverHistory = vi.fn(async () => ({
      state: "complete" as const,
      samples: [],
      error: null,
    }));
    const recovery = new SensorGapRecoveryCoordinator(runtime.database, runtime.measurements, [{
      source: "tp-link",
      availability: () => [],
      recoverHistory,
    }]);

    await recovery.runOnce(new Date("2026-07-19T07:00:00.000Z"));

    expect(recoverHistory).toHaveBeenCalledOnce();
    expect(recoverHistory).toHaveBeenCalledWith("sensor-01", "temperature", from, to);
    expect(runtime.database.listSensorDataGaps("sensor-01")[0]).toMatchObject({
      recoveryState: "complete",
      recoveryCompleteness: "none",
      recoveredPoints: 0,
      attemptCount: 1,
      lastAttemptAt: "2026-07-19T07:00:00.000Z",
      nextAttemptAt: null,
      recoveryError: null,
    });
  });

  it("does not classify exact-threshold TP-Link samples as a historical gap", async () => {
    runtime = createApi({ config: config(), startBackground: false });
    const base = Date.parse("2026-07-19T06:00:00.000Z");
    for (const [offset, value] of [[0, 20], [15 * 60_000, 21]] as const) {
      runtime.measurements.ingest({
        sensorId: "sensor-01",
        metric: "temperature",
        value,
        canonicalUnit: "\u00b0C",
        timestamp: new Date(base + offset).toISOString(),
        source: "tp-link",
        quality: "good",
      });
    }
    const recoverHistory = vi.fn(async () => ({
      state: "complete" as const,
      samples: [],
      error: null,
    }));
    const recovery = new SensorGapRecoveryCoordinator(runtime.database, runtime.measurements, [{
      source: "tp-link",
      availability: (now = new Date()) => [{
        sensorId: "sensor-01",
        metric: "temperature",
        source: "tp-link",
        available: true,
        observedAt: now.toISOString(),
      }],
      recoverHistory,
    }]);

    await recovery.runOnce(new Date(base + 16 * 60_000));

    expect(runtime.database.listSensorDataGaps("sensor-01")).toEqual([]);
    expect(recoverHistory).not.toHaveBeenCalled();
  });

  it("discovers a historical hole that happened while the process was not observing availability", async () => {
    runtime = createApi({ config: config(), startBackground: false });
    const base = Date.parse("2026-07-19T06:00:00Z");
    for (const [timestamp, value] of [
      [new Date(base).toISOString(), 20],
      [new Date(base + 2 * 60 * 60_000).toISOString(), 22],
    ] as const) {
      runtime.measurements.ingest({
        sensorId: "sensor-01",
        metric: "temperature",
        value,
        canonicalUnit: "°C",
        timestamp,
        source: "tp-link",
        quality: "good",
      });
    }
    const recoveredTimestamp = new Date(base + 60 * 60_000).toISOString();
    const adapter: SensorGapRecoveryAdapter = {
      source: "tp-link",
      availability: (now = new Date()) => [{
        sensorId: "sensor-01",
        metric: "temperature",
        source: "tp-link",
        available: true,
        observedAt: now.toISOString(),
      }],
      recoverHistory: async (sensorId, metric) => ({
        state: "complete",
        error: null,
        samples: [{
          sensorId,
          metric,
          value: 21,
          canonicalUnit: "°C",
          timestamp: recoveredTimestamp,
          source: "tp-link",
          quality: "good",
        }],
      }),
    };
    const recovery = new SensorGapRecoveryCoordinator(runtime.database, runtime.measurements, [adapter]);

    await recovery.runOnce(new Date(base + 2 * 60 * 60_000 + 60_000));

    expect(runtime.database.listSensorDataGaps("sensor-01")).toEqual([
      expect.objectContaining({
        startedAt: new Date(base).toISOString(),
        endedAt: new Date(base + 2 * 60 * 60_000).toISOString(),
        recoveryState: "complete",
        recoveredPoints: 1,
      }),
    ]);
    expect(runtime.database.measurementHistory(
      "sensor-01",
      "temperature",
      new Date(base).toISOString(),
      new Date(base + 2 * 60 * 60_000).toISOString(),
    ).map((sample) => sample.timestamp)).toEqual([
      new Date(base).toISOString(),
      recoveredTimestamp,
      new Date(base + 2 * 60 * 60_000).toISOString(),
    ]);
  });

  it("advances past known overlapping ranges before applying the historical gap limit", async () => {
    runtime = createApi({ config: config(), startBackground: false });
    const base = Date.parse("2026-07-19T02:00:00Z");
    for (let hour = 0; hour < 5; hour += 1) {
      runtime.measurements.ingest({
        sensorId: "sensor-01",
        metric: "temperature",
        value: 20 + hour,
        canonicalUnit: "\u00b0C",
        timestamp: new Date(base + hour * 60 * 60_000).toISOString(),
        source: "tp-link",
        quality: "good",
      });
    }
    const overlapping = runtime.database.noteHistoricalSensorDataGap(
      "sensor-01",
      "temperature",
      "tp-link",
      new Date(base).toISOString(),
      new Date(base + 60 * 60_000 + 1_000).toISOString(),
      new Date(base + 5 * 60 * 60_000).toISOString(),
    );
    runtime.database.updateSensorDataGapRecovery(
      overlapping.id,
      "complete",
      1,
      new Date(base + 5 * 60 * 60_000).toISOString(),
      null,
    );
    const adapter: SensorGapRecoveryAdapter = {
      source: "tp-link",
      availability: (now = new Date()) => [{
        sensorId: "sensor-01", metric: "temperature", source: "tp-link", available: true,
        observedAt: now.toISOString(),
      }],
      recoverHistory: async () => ({ state: "not-supported", samples: [], error: "fixture" }),
    };
    const recovery = new SensorGapRecoveryCoordinator(runtime.database, runtime.measurements, [adapter], {
      historicalGapLimit: 1,
      historicalScanIntervalMs: 1_000,
    });

    await recovery.runOnce(new Date(base + 5 * 60 * 60_000));
    expect(runtime.database.listSensorDataGaps("sensor-01")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        startedAt: new Date(base + 60 * 60_000).toISOString(),
        endedAt: new Date(base + 2 * 60 * 60_000).toISOString(),
      }),
    ]));
    await recovery.runOnce(new Date(base + 5 * 60 * 60_000 + 1_000));
    expect(runtime.database.listSensorDataGaps("sensor-01")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        startedAt: new Date(base + 2 * 60 * 60_000).toISOString(),
        endedAt: new Date(base + 3 * 60 * 60_000).toISOString(),
      }),
    ]));
  });

  it("advances an archive page past a known gap before applying the discovery limit", async () => {
    runtime = createApi({ config: config(), startBackground: false });
    const base = Date.parse("2026-07-19T02:00:00Z");
    const known = {
      startedAt: new Date(base).toISOString(),
      endedAt: new Date(base + 60 * 60_000).toISOString(),
      durationMs: 60 * 60_000,
    };
    const unseen = {
      startedAt: known.endedAt,
      endedAt: new Date(base + 2 * 60 * 60_000).toISOString(),
      durationMs: 60 * 60_000,
    };
    runtime.database.noteHistoricalSensorDataGap(
      "sensor-01", "temperature", "tp-link", known.startedAt, known.endedAt, unseen.endedAt,
    );
    const archiveGaps = vi.fn(async () => [known, unseen]);
    const telemetryReader = new HybridTelemetryReader({
      local: runtime.database,
      archive: {
        measurementSampleGaps: archiveGaps,
        measurementHistory: async () => [],
        legacyReadingHistory: async () => [],
        outdoorTemperatureHistory: async () => [],
        electricityPriceHistory: async () => [],
        openingStateHistory: async () => [],
        openingStateSnapshot: async () => [],
      },
      archivePhase: () => "ready",
      localHistoryComplete: false,
    });
    const adapter: SensorGapRecoveryAdapter = {
      source: "tp-link",
      availability: (now = new Date()) => [{
        sensorId: "sensor-01", metric: "temperature", source: "tp-link", available: true,
        observedAt: now.toISOString(),
      }],
      recoverHistory: async () => ({ state: "not-supported", samples: [], error: "fixture" }),
    };
    const recovery = new SensorGapRecoveryCoordinator(runtime.database, runtime.measurements, [adapter], {
      telemetryReader,
      historicalGapLimit: 1,
    });

    await recovery.runOnce(new Date(base + 3 * 60 * 60_000));

    expect(archiveGaps).toHaveBeenCalledWith(expect.objectContaining({ limit: 1_000 }));
    expect(runtime.database.listSensorDataGaps("sensor-01")).toEqual(expect.arrayContaining([
      expect.objectContaining({ startedAt: unseen.startedAt, endedAt: unseen.endedAt }),
    ]));
  });

  it("retrieves and normalizes the missing interval from Home Assistant recorder history", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "stugu-sensor-gap-ha-"));
    const mappingPath = join(temporaryDirectory, "entities.json");
    writeFileSync(mappingPath, JSON.stringify({ entities: [{
      sensorId: "sensor-01",
      temperature: "sensor.room_temperature",
    }] }));
    server = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/api/websocket" });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HA test server did not bind");
    let client: WebSocket | null = null;
    server.on("connection", (socket) => {
      client = socket;
      socket.send(JSON.stringify({ type: "auth_required" }));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { id?: number; type?: string };
        if (message.type === "auth") socket.send(JSON.stringify({ type: "auth_ok" }));
        if (message.type === "subscribe_events") {
          socket.send(JSON.stringify({ id: message.id, type: "result", success: true, result: null }));
        }
        if (message.type === "get_states") socket.send(JSON.stringify({
          id: message.id,
          type: "result",
          success: true,
          result: [{
            entity_id: "sensor.room_temperature",
            state: "68",
            last_updated: "2026-07-19T09:00:00Z",
            attributes: { unit_of_measurement: "°F" },
          }],
        }));
      });
    });
    const fetcher = vi.fn(async () => new Response(JSON.stringify([[
      {
        entity_id: "sensor.room_temperature",
        state: "69.8",
        last_updated: "2026-07-19T09:10:00Z",
        attributes: { unit_of_measurement: "°F" },
      },
      {
        entity_id: "sensor.room_temperature",
        state: "71.6",
        last_updated: "2026-07-19T09:20:00Z",
        attributes: { unit_of_measurement: "°F" },
      },
    ]]), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    runtime = createApi({
      config: config({
        integrationSecretsFile: join(temporaryDirectory, "secrets.json"),
        assetDirectory: temporaryDirectory,
        haUrl: `http://127.0.0.1:${address.port}`,
        haToken: "test-token",
        haEntityMapFile: mappingPath,
      }),
      startBackground: false,
    });
    runtime.homeAssistant.start();
    await waitFor(() => runtime?.status.value.homeAssistant.connected === true);
    await runtime.sensorGapRecovery.runOnce(new Date("2026-07-19T09:01:00Z"));
    client?.terminate();
    await waitFor(() => runtime?.status.value.homeAssistant.connected === false);
    await runtime.sensorGapRecovery.runOnce(new Date("2026-07-19T09:35:00Z"));
    expect(runtime.database.openSensorDataGap("sensor-01", "temperature", "home-assistant")).not.toBeNull();

    await waitFor(() => runtime?.status.value.homeAssistant.connected === true, 4_000);
    await runtime.sensorGapRecovery.runOnce(new Date("2026-07-19T09:36:00Z"));

    const [gap] = runtime.database.listSensorDataGaps("sensor-01");
    expect(gap).toMatchObject({ metric: "temperature", recoveryState: "complete", recoveredPoints: 2 });
    const recovered = runtime.database.measurementHistory(
      "sensor-01", "temperature", "2026-07-19T09:00:01Z", "2026-07-19T09:35:00Z",
    );
    expect(recovered.map((sample) => sample.timestamp)).toEqual([
      "2026-07-19T09:10:00.000Z",
      "2026-07-19T09:20:00.000Z",
    ]);
    expect(recovered[0]!.value).toBeCloseTo(21);
    expect(recovered[1]!.value).toBeCloseTo(22);
    expect(fetcher).toHaveBeenCalledOnce();
    const requested = new URL(String(fetcher.mock.calls[0]![0]));
    expect(requested.pathname).toContain("/api/history/period/");
    expect(requested.searchParams.get("filter_entity_id")).toBe("sensor.room_temperature");
  });

  it("continues a multi-segment recovery promptly after a partial result made progress", async () => {
    runtime = createApi({ config: config(), startBackground: false });
    const from = "2026-07-01T00:00:00.000Z";
    const to = "2026-07-01T02:00:00.000Z";
    runtime.database.noteHistoricalSensorDataGap("sensor-01", "temperature", "tp-link", from, to, from);
    let calls = 0;
    const adapter: SensorGapRecoveryAdapter = {
      source: "tp-link",
      availability: () => [],
      recoverHistory: async (sensorId, metric) => {
        calls += 1;
        return {
          state: calls === 1 ? "partial" : "complete",
          error: null,
          samples: [{
            sensorId,
            metric,
            value: 20 + calls,
            canonicalUnit: "°C",
            timestamp: calls === 1 ? "2026-07-01T00:30:00.000Z" : "2026-07-01T01:30:00.000Z",
            source: "tp-link",
            quality: "good",
          }],
        };
      },
    };
    const recovery = new SensorGapRecoveryCoordinator(runtime.database, runtime.measurements, [adapter], {
      retryBaseMs: 60 * 60_000,
    });

    await recovery.runOnce(new Date("2026-07-02T00:00:00.000Z"));
    expect(runtime.database.listSensorDataGaps("sensor-01")[0]).toMatchObject({
      recoveryState: "partial",
      recoveryCompleteness: "partial",
      nextAttemptAt: "2026-07-02T00:00:01.000Z",
    });
    await recovery.runOnce(new Date("2026-07-02T00:00:00.999Z"));
    expect(calls).toBe(1);
    await recovery.runOnce(new Date("2026-07-02T00:00:01.000Z"));
    expect(calls).toBe(2);
    expect(runtime.database.listSensorDataGaps("sensor-01")[0]).toMatchObject({
      recoveryState: "complete",
      recoveryCompleteness: "complete",
      attemptCount: 2,
      recoveredPoints: 2,
    });
  });

  it("accepts Home Assistant recorder rows as recovery for a dual-bound TP-Link sensor", async () => {
    runtime = createApi({ config: config(), startBackground: false });
    runtime.database.updateSensor("sensor-01", {
      tpLinkDeviceId: "dual-bound-device",
      measurementEntityIds: { temperature: "sensor.dual_temperature" },
    });
    const from = "2026-07-01T00:00:00.000Z";
    const to = "2026-07-01T01:00:00.000Z";
    runtime.database.noteHistoricalSensorDataGap("sensor-01", "temperature", "tp-link", from, to, from);
    const adapter: SensorGapRecoveryAdapter = {
      source: "tp-link",
      availability: () => [],
      recoverHistory: async (sensorId, metric) => ({
        state: "complete",
        error: null,
        samples: [{
          sensorId,
          metric,
          value: 21,
          canonicalUnit: "\u00b0C",
          timestamp: "2026-07-01T00:30:00.000Z",
          source: "home-assistant",
          quality: "good",
        }],
      }),
    };
    const recovery = new SensorGapRecoveryCoordinator(runtime.database, runtime.measurements, [adapter]);

    await recovery.runOnce(new Date("2026-07-02T00:00:00.000Z"));

    expect(runtime.database.listSensorDataGaps("sensor-01")[0]).toMatchObject({
      recoveryState: "complete",
      recoveredPoints: 1,
    });
    expect(runtime.database.measurementHistory("sensor-01", "temperature", from, to)).toEqual([
      expect.objectContaining({ source: "home-assistant", value: 21 }),
    ]);
  });

  it("rearms a persisted not-supported TP-Link gap when the fallback is enabled", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "stugu-tapo-gap-rearm-"));
    const databasePath = join(temporaryDirectory, "climate.sqlite");
    runtime = createApi({ config: config({ databasePath }), startBackground: false });
    runtime.database.updateSensor("sensor-01", {
      tpLinkDeviceId: "t315-cellar", tpLinkConnectionId: "connection-1",
    });
    const gap = runtime.database.noteHistoricalSensorDataGap(
      "sensor-01", "temperature", "tp-link",
      "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z",
    );
    runtime.database.updateSensorDataGapRecovery(
      gap.id, "not-supported", 0, "2026-01-03T00:01:00.000Z", "Fallback not configured",
    );
    await runtime.close();
    runtime = null;

    runtime = createApi({
      config: config({
        databasePath,
        tapoHistoryEnabled: true,
        tapoHistoryWorkerToken: "w".repeat(48),
        tapoHistoryExportEmail: "owner@gmail.com",
        tapoHistoryGmailClientId: "client-id",
        tapoHistoryGmailClientSecret: "client-secret",
        tapoHistoryGmailRefreshToken: "refresh-token",
      }),
      startBackground: false,
      tapoHistoryDeviceNameFor: () => "Cellar",
      tapoHistoryNow: () => new Date("2026-01-03T00:02:00.000Z"),
    });
    expect(runtime.database.sensorDataGap(gap.id)).toMatchObject({ recoveryState: "pending", attemptCount: 0 });

    await runtime.sensorGapRecovery.runOnce(new Date("2026-01-03T00:02:00.000Z"));

    expect(runtime.database.sensorDataGap(gap.id)).toMatchObject({ recoveryState: "partial", attemptCount: 1 });
    expect(runtime.tapoHistory.listJobs()).toEqual([
      expect.objectContaining({ sensorId: "sensor-01", metric: "temperature", status: "queued" }),
    ]);
  });

  it("rearms only still-retained obsolete local T310/T315 climate gaps", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "stugu-tapo-local-gap-rearm-"));
    const databasePath = join(temporaryDirectory, "climate.sqlite");
    runtime = createApi({ config: config({ databasePath }), startBackground: false });
    const houseId = runtime.database.getSensor("sensor-01")!.houseId;
    runtime.database.updateSensor("sensor-01", {
      tpLinkDeviceId: "t315-cellar", tpLinkConnectionId: "connection-1",
    });
    const now = Date.now();
    const legacyError = "The direct H100/H200 local API does not expose retained T310/T315 measurement history";
    const recent = runtime.database.noteHistoricalSensorDataGap(
      "sensor-01", "temperature", "tp-link",
      new Date(now - 2 * 60 * 60_000).toISOString(),
      new Date(now - 60 * 60_000).toISOString(),
      new Date(now - 30 * 60_000).toISOString(),
    );
    const expired = runtime.database.noteHistoricalSensorDataGap(
      "sensor-01", "humidity", "tp-link",
      new Date(now - 30 * 60 * 60_000).toISOString(),
      new Date(now - 29 * 60 * 60_000).toISOString(),
      new Date(now - 28 * 60 * 60_000).toISOString(),
    );
    const straddling = runtime.database.noteHistoricalSensorDataGap(
      "sensor-01", "temperature", "tp-link",
      new Date(now - 30 * 60 * 60_000).toISOString(),
      new Date(now - 60 * 60_000).toISOString(),
      new Date(now - 30 * 60_000).toISOString(),
    );
    const differentError = runtime.database.noteHistoricalSensorDataGap(
      "sensor-01", "humidity", "tp-link",
      new Date(now - 2 * 60 * 60_000).toISOString(),
      new Date(now - 60 * 60_000).toISOString(),
      new Date(now - 30 * 60_000).toISOString(),
    );
    const energy = runtime.database.noteHistoricalSensorDataGap(
      "sensor-01", "energy", "tp-link",
      new Date(now - 2 * 60 * 60_000).toISOString(),
      new Date(now - 60 * 60_000).toISOString(),
      new Date(now - 30 * 60_000).toISOString(),
    );
    runtime.database.updateSensorDataGapRecovery(recent.id, "not-supported", 0,
      new Date(now - 20 * 60_000).toISOString(), legacyError);
    runtime.database.updateSensorDataGapRecovery(expired.id, "not-supported", 0,
      new Date(now - 20 * 60_000).toISOString(), legacyError);
    runtime.database.updateSensorDataGapRecovery(straddling.id, "not-supported", 0,
      new Date(now - 20 * 60_000).toISOString(), legacyError);
    runtime.database.updateSensorDataGapRecovery(differentError.id, "not-supported", 0,
      new Date(now - 20 * 60_000).toISOString(), "Local retained climate history is unsupported for this device");
    runtime.database.updateSensorDataGapRecovery(energy.id, "not-supported", 0,
      new Date(now - 20 * 60_000).toISOString(),
      "TP-Link interval energy is not the cumulative energy metric used by this service");
    await runtime.close();
    runtime = null;

    runtime = createApi({
      config: config({
        databasePath,
        tpLinkConnections: [{
          id: "connection-1", houseId, host: "192.0.2.10", username: "owner@example.com", password: "secret",
        }],
      }),
      startBackground: false,
    });

    expect(runtime.database.sensorDataGap(recent.id)).toMatchObject({ recoveryState: "not-supported" });
    runtime.tpLink.start();
    expect(runtime.database.sensorDataGap(recent.id)).toMatchObject({ recoveryState: "pending", attemptCount: 0 });
    expect(runtime.database.sensorDataGap(expired.id)).toMatchObject({ recoveryState: "not-supported" });
    expect(runtime.database.sensorDataGap(straddling.id)).toMatchObject({ recoveryState: "not-supported" });
    expect(runtime.database.sensorDataGap(differentError.id)).toMatchObject({ recoveryState: "not-supported" });
    expect(runtime.database.sensorDataGap(energy.id)).toMatchObject({ recoveryState: "not-supported" });
  });
});
