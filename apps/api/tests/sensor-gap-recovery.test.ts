import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { WebSocketServer, type WebSocket } from "ws";
import { createApi, type ApiRuntime } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import {
  SensorGapRecoveryCoordinator,
  type SensorGapRecoveryAdapter,
} from "../src/sensor-gap-recovery.js";

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    apiHost: "127.0.0.1",
    databasePath: ":memory:",
    integrationSecretsFile: "unused.json",
    assetDirectory: ".",
    mockEnabled: false,
    mockIntervalMs: 2_000,
    retentionDays: 730,
    ingestApiKey: null,
    haUrl: null,
    haToken: null,
    haEntityMapFile: null,
    tpLinkHost: null,
    tpLinkUsername: null,
    tpLinkPassword: null,
    tpLinkDeviceMapFile: null,
    tpLinkPollIntervalMs: 10_000,
    tpLinkPython: "python",
    tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
    alertWebhookUrl: null,
    alertWebhookBearerToken: null,
    corsOrigin: null,
    ...overrides,
  };
}

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

  it("durably detects an unavailable metric and backfills it after recovery", async () => {
    runtime = createApi({ config: config(), startBackground: false });
    const base = Date.now() - 120_000;
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
    const recoveredTimestamp = new Date(base + 60_000).toISOString();
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

    await recovery.runOnce(new Date(base + 90_000));
    expect(runtime.database.openSensorDataGap("sensor-01", "temperature", "home-assistant")).toMatchObject({
      startedAt: initialTimestamp,
      recoveryState: "open",
    });

    available = true;
    await recovery.runOnce(new Date(base + 120_000));
    const [gap] = runtime.database.listSensorDataGaps("sensor-01");
    expect(gap).toMatchObject({ recoveryState: "complete", recoveredPoints: 1, attemptCount: 1 });
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

    await recovery.runOnce(new Date(base + 121_000));
    expect(recoveryCalls).toBe(1);
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

  it("retrieves and normalizes the missing interval from Home Assistant recorder history", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "stuga-sensor-gap-ha-"));
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
        last_updated: "2026-07-19T09:05:00Z",
        attributes: { unit_of_measurement: "°F" },
      },
      {
        entity_id: "sensor.room_temperature",
        state: "71.6",
        last_updated: "2026-07-19T09:10:00Z",
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
    await runtime.sensorGapRecovery.runOnce(new Date("2026-07-19T09:15:00Z"));
    expect(runtime.database.openSensorDataGap("sensor-01", "temperature", "home-assistant")).not.toBeNull();

    await waitFor(() => runtime?.status.value.homeAssistant.connected === true, 4_000);
    await runtime.sensorGapRecovery.runOnce(new Date("2026-07-19T09:16:00Z"));

    const [gap] = runtime.database.listSensorDataGaps("sensor-01");
    expect(gap).toMatchObject({ metric: "temperature", recoveryState: "complete", recoveredPoints: 2 });
    const recovered = runtime.database.measurementHistory(
      "sensor-01", "temperature", "2026-07-19T09:00:01Z", "2026-07-19T09:15:00Z",
    );
    expect(recovered.map((sample) => sample.timestamp)).toEqual([
      "2026-07-19T09:05:00.000Z",
      "2026-07-19T09:10:00.000Z",
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
      recoveryState: "partial", nextAttemptAt: "2026-07-02T00:00:01.000Z",
    });
    await recovery.runOnce(new Date("2026-07-02T00:00:00.999Z"));
    expect(calls).toBe(1);
    await recovery.runOnce(new Date("2026-07-02T00:00:01.000Z"));
    expect(calls).toBe(2);
    expect(runtime.database.listSensorDataGaps("sensor-01")[0]).toMatchObject({
      recoveryState: "complete", attemptCount: 2, recoveredPoints: 2,
    });
  });

  it("rearms a persisted not-supported TP-Link gap when the fallback is enabled", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "stuga-tapo-gap-rearm-"));
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
    temporaryDirectory = mkdtempSync(join(tmpdir(), "stuga-tapo-local-gap-rearm-"));
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
