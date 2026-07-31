import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("home performance API", () => {
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
        sensorId: "performance-sensor",
        metric: "temperature",
        value: 21,
        canonicalUnit: "Â°C",
        timestamp,
        source: "api",
        quality: "good",
      },
      {
        sensorId: "performance-sensor",
        metric: "humidity",
        value: 45,
        canonicalUnit: "%",
        timestamp,
        source: "api",
        quality: "good",
      },
    ]);
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("owns the complete evidence policy and returns a cached versioned result", async () => {
    const first = await request(runtime.app)
      .get("/api/v2/analytics/home-performance?houseId=performance-house&dataMode=live")
      .expect(200);

    expect(first.headers["cache-control"]).toBe("private, no-store");
    expect(first.headers["x-stugu-cache"]).toBe("miss");
    expect(first.body).toMatchObject({
      apiVersion: "1.0",
      houseId: "performance-house",
      dataMode: "live",
      cache: { hit: false, keyVersion: "home-performance-v1", ttlSeconds: 60 },
      provenance: {
        algorithmKey: "home-performance",
        algorithmVersion: "home-performance-v2.0.0",
      },
      exposure: { state: "limited" },
    });
    expect(Date.parse(first.body.from)).toBeLessThan(Date.parse(first.body.recoveryFrom));
    expect(Date.parse(first.body.recoveryFrom)).toBeLessThan(Date.parse(first.body.to));

    const second = await request(runtime.app)
      .get("/api/v2/analytics/home-performance?houseId=performance-house&dataMode=live")
      .expect(200);
    expect(second.body.cache.hit).toBe(true);
    expect(second.body.generatedAt).toBe(first.body.generatedAt);

    runtime.bus.publishMeasurement({
      sensorId: "performance-sensor",
      metric: "temperature",
      value: 22,
      canonicalUnit: "Â°C",
      timestamp: new Date().toISOString(),
      source: "api",
      quality: "good",
    });
    const afterMeasurement = await request(runtime.app)
      .get("/api/v2/analytics/home-performance?houseId=performance-house&dataMode=live")
      .expect(200);
    expect(afterMeasurement.body.cache).toMatchObject({ hit: true, coalesced: false });
    expect(afterMeasurement.headers["x-stugu-cache"]).toBe("hit");
  });

  it("does not cancel an active calculation when a routine measurement arrives", async () => {
    const originalRollup = runtime.telemetryReader.measurementAnalyticsRollup
      .bind(runtime.telemetryReader);
    let releaseRollups!: () => void;
    const rollupsReleased = new Promise<void>((resolve) => { releaseRollups = resolve; });
    let markRollupStarted!: () => void;
    const rollupStarted = new Promise<void>((resolve) => { markRollupStarted = resolve; });
    runtime.telemetryReader.measurementAnalyticsRollup = async (query) => {
      markRollupStarted();
      await rollupsReleased;
      return originalRollup(query);
    };

    const pending = request(runtime.app)
      .get("/api/v2/analytics/home-performance?houseId=performance-house&dataMode=live")
      .then((response) => response);
    await rollupStarted;
    runtime.bus.publishMeasurement({
      sensorId: "performance-sensor",
      metric: "temperature",
      value: 22,
      canonicalUnit: "Ã‚Â°C",
      timestamp: new Date().toISOString(),
      source: "api",
      quality: "good",
    });
    releaseRollups();

    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.body.cache).toMatchObject({ hit: false, coalesced: false });
  });

  it("rejects cross-mode requests and whole-Home scopes over the deterministic limit", async () => {
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
      .get("/api/v2/analytics/home-performance?houseId=performance-house&dataMode=live")
      .expect(422)
      .expect(({ body }) => {
        expect(body.error.code).toBe("HOME_PERFORMANCE_SCOPE_TOO_LARGE");
      });
  });
});
