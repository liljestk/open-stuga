import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  port: 0,
  apiHost: "127.0.0.1",
  databasePath: ":memory:",
  integrationSecretsFile: "integration-secrets.test.json",
  assetDirectory: ".",
  mockEnabled: false,
  mockIntervalMs: 25,
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
};

describe("home performance durable API", () => {
  let runtime: ApiRuntime;

  beforeEach(() => {
    runtime = createApi({ config, startBackground: false });
    runtime.database.activateRealDataMode();
    runtime.database.createHouse({
      id: "performance-house",
      name: "Performance house",
      timezone: "UTC",
      floors: [{
        id: "ground",
        name: "Ground",
        width: 10,
        height: 8,
        elevation: 0,
        walls: [],
        rooms: [{
          id: "living",
          name: "Living",
          points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }],
        }],
      }],
    });
    runtime.database.createSensor({
      id: "performance-sensor",
      houseId: "performance-house",
      floorId: "ground",
      roomId: "living",
      room: "Living",
      name: "Living sensor",
      model: "T310",
      x: 5,
      y: 4,
      z: 1.2,
      tags: [],
      enabled: true,
    });
    const timestamp = new Date(Date.now() - 30 * 60_000).toISOString();
    runtime.database.insertMeasurementSamples([
      {
        sensorId: "performance-sensor", metric: "temperature", value: 21,
        canonicalUnit: "°C", timestamp, source: "api", quality: "good",
      },
      {
        sensorId: "performance-sensor", metric: "humidity", value: 45,
        canonicalUnit: "%", timestamp, source: "api", quality: "good",
      },
    ]);
  });

  afterEach(async () => runtime.close());

  it("keeps 20 constant-time reads pure without queueing, telemetry, or fitting", async () => {
    const rollup = vi.spyOn(runtime.telemetryReader, "measurementAnalyticsRollup");
    const responses = await Promise.all(Array.from({ length: 20 }, () => request(runtime.app)
      .get("/api/v2/analytics/home-performance?houseId=performance-house&dataMode=live")
      .expect(200)));

    expect(responses[0]?.headers["cache-control"]).toBe("private, no-store");
    expect(responses.every(({ body }) => body.state === "idle" && body.result === null)).toBe(true);
    expect(runtime.derivedAnalytics.snapshot()).toMatchObject({ pending: 0, artifacts: 0 });
    expect(rollup).not.toHaveBeenCalled();
    expect(await runtime.derivedAnalytics.drainOnce()).toBe(false);

    await request(runtime.app)
      .post("/api/v2/analytics/home-performance?houseId=performance-house&dataMode=live")
      .expect(202);
    expect(await runtime.derivedAnalytics.drainOnce()).toBe(true);
    const ready = await request(runtime.app)
      .get("/api/v2/analytics/home-performance?houseId=performance-house&dataMode=live")
      .expect(200);
    expect(ready.body).toMatchObject({
      apiVersion: "1.0",
      kind: "home-performance",
      houseId: "performance-house",
      dataMode: "live",
      windowDays: 30,
      state: "ready",
      stale: false,
      result: {
        provenance: {
          algorithmKey: "home-performance",
          algorithmVersion: "home-performance-v3.2.0",
        },
      },
    });
    const callsAfterFit = rollup.mock.calls.length;
    await request(runtime.app)
      .get("/api/v2/analytics/home-performance?houseId=performance-house&dataMode=live")
      .expect(200);
    expect(rollup).toHaveBeenCalledTimes(callsAfterFit);
  });

  it("returns 202 for idempotent refreshes and retains last-good", async () => {
    await request(runtime.app)
      .post("/api/v2/analytics/home-performance?houseId=performance-house&dataMode=live")
      .expect(202);
    await runtime.derivedAnalytics.drainOnce();

    const refreshes = await Promise.all(Array.from({ length: 20 }, () => request(runtime.app)
      .post("/api/v2/analytics/home-performance?houseId=performance-house&dataMode=live")
      .expect(202)));
    expect(refreshes.every(({ body }) => body.state === "queued" && body.result !== null)).toBe(true);
    expect(runtime.derivedAnalytics.snapshot()).toMatchObject({ pending: 1, artifacts: 1 });
  });

  it("propagates evidence AbortError instead of publishing a partial artifact", async () => {
    vi.spyOn(runtime.telemetryReader, "measurementAnalyticsRollup")
      .mockRejectedValue(new DOMException("history read canceled", "AbortError"));

    await request(runtime.app)
      .post("/api/v2/analytics/home-performance?houseId=performance-house&dataMode=live")
      .expect(202);
    await runtime.derivedAnalytics.drainOnce();

    await request(runtime.app)
      .get("/api/v2/analytics/home-performance?houseId=performance-house&dataMode=live")
      .expect(200)
      .expect(({ body }) => {
        expect(body.state).toBe("failed");
        expect(body.result).toBeNull();
        expect(body.artifact).toBeNull();
        expect(body.job.errorMessage).toBe("history read canceled");
      });
    expect(runtime.derivedAnalytics.snapshot().artifacts).toBe(0);
  });

  it("keeps thermal and moisture panel reads off telemetry and the fitters", async () => {
    const history = vi.spyOn(runtime.telemetryReader, "thermalMeasurementHistory");
    const reads = await Promise.all(Array.from({ length: 20 }, (_, index) => request(runtime.app)
      .get(`/api/v2/analytics/${index % 2 === 0 ? "thermal-isolation" : "moisture-response"}?houseId=performance-house&dataMode=live&windowDays=7`)
      .expect(200)));
    expect(reads.every(({ body }) => body.state === "idle" && body.result === null)).toBe(true);
    expect(runtime.derivedAnalytics.snapshot()).toMatchObject({ pending: 0, artifacts: 0 });
    expect(history).not.toHaveBeenCalled();
    expect(await runtime.derivedAnalytics.drainOnce()).toBe(false);

    await request(runtime.app)
      .post("/api/v2/analytics/thermal-isolation?houseId=performance-house&dataMode=live&windowDays=7")
      .expect(202);
    await request(runtime.app)
      .post("/api/v2/analytics/moisture-response?houseId=performance-house&dataMode=live&windowDays=7")
      .expect(202);
    await runtime.derivedAnalytics.drainOnce();
    await runtime.derivedAnalytics.drainOnce();
    expect(runtime.derivedAnalytics.snapshot()).toMatchObject({ pending: 0, artifacts: 2 });
    expect(history).toHaveBeenCalled();
    await request(runtime.app)
      .get("/api/v2/analytics/thermal-isolation?houseId=performance-house&dataMode=live&windowDays=7")
      .expect(200)
      .expect(({ body }) => expect(body.state).toBe("ready"));
    await request(runtime.app)
      .get("/api/v2/analytics/moisture-response?houseId=performance-house&dataMode=live&windowDays=7")
      .expect(200)
      .expect(({ body }) => expect(body.state).toBe("ready"));
  });

  it("reports cross-mode immediately and oversized work as a durable failure", async () => {
    await request(runtime.app)
      .get("/api/v2/analytics/home-performance?houseId=performance-house&dataMode=demo")
      .expect(409);

    for (let index = 0; index < 80; index += 1) {
      runtime.database.createSensor({
        id: `extra-${String(index).padStart(2, "0")}`,
        houseId: "performance-house",
        floorId: "ground",
        roomId: "living",
        room: "Living",
        name: `Extra ${index}`,
        model: "Test",
        x: 1,
        y: 1,
        z: 1,
        tags: [],
        enabled: true,
      });
    }
    await request(runtime.app)
      .post("/api/v2/analytics/home-performance?houseId=performance-house&dataMode=live")
      .expect(202);
    await runtime.derivedAnalytics.drainOnce();
    await request(runtime.app)
      .get("/api/v2/analytics/home-performance?houseId=performance-house&dataMode=live")
      .expect(200)
      .expect(({ body }) => {
        expect(body.state).toBe("failed");
        expect(body.result).toBeNull();
        expect(body.job.errorCode).toBe("HOME_PERFORMANCE_SCOPE_TOO_LARGE");
        expect(body.job.nextAttemptAt).toBeNull();
      });
  });
});
