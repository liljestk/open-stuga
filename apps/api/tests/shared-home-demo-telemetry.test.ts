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

describe("shared Home demo telemetry isolation", () => {
  let runtime: ApiRuntime;

  beforeEach(() => {
    runtime = createApi({ config, startBackground: false });
  });
  afterEach(async () => {
    await runtime.close();
  });

  it("blocks local telemetry producers and integrations for projected Stuguby sensors", async () => {
    const localHouse = runtime.database.getHouse("house-main")!;
    const sharedHouse = runtime.database.createHouse({
      id: "shared-home",
      propertyId: localHouse.propertyId,
      name: "Shared Home",
      timezone: localHouse.timezone,
      floors: [{
        id: "shared-floor",
        name: "Ground",
        width: 8,
        height: 6,
        elevation: 0,
        walls: [],
        rooms: [],
      }],
    });
    const sharedSensor = runtime.database.createSensor({
      id: "shared-sensor",
      houseId: sharedHouse.id,
      floorId: "shared-floor",
      name: "Remote sensor",
      room: "",
      model: "Remote",
      x: 1,
      y: 1,
      z: 1,
      tags: ["stuguby-shared"],
      enabled: true,
    });

    expect(runtime.mock.generate().map(({ sensorId }) => sensorId)).toContain(sharedSensor.id);
    expect(runtime.database.getLatestReading(sharedSensor.id)?.source).toBe("mock");
    expect(runtime.database.getLatestMeasurementSample(sharedSensor.id, "temperature")?.source).toBe("mock");
    runtime.database.updateSensor(sharedSensor.id, {
      tpLinkDeviceId: "local-device-that-must-not-leak",
      measurementEntityIds: { temperature: "sensor.local_temperature" },
    });
    runtime.database.insertReading({
      sensorId: sharedSensor.id,
      timestamp: new Date(Date.now() + 1_000).toISOString(),
      temperature: 21,
      humidity: 41,
      battery: 91,
      source: "home-assistant",
      quality: "good",
    });
    expect(runtime.database.getLatestReading(sharedSensor.id)?.source).toBe("home-assistant");
    expect(runtime.database.db.prepare(`SELECT metric FROM sensor_recorded_measurements
      WHERE sensor_id = ? ORDER BY metric`).all(sharedSensor.id))
      .toEqual([{ metric: "humidity" }, { metric: "temperature" }]);
    expect(runtime.database.sensorSourceMetrics(sharedSensor.id, "home-assistant"))
      .toEqual(["humidity", "temperature"]);

    runtime.database.setHouseStugubyLink(sharedHouse.id, {
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

    expect(runtime.database.getLatestReading(sharedSensor.id)).toBeNull();
    expect(runtime.database.getLatestMeasurementSample(sharedSensor.id, "temperature")).toBeNull();
    expect(runtime.database.getSensor(sharedSensor.id)).not.toHaveProperty("tpLinkDeviceId");
    expect(runtime.database.getSensor(sharedSensor.id)?.measurementEntityIds ?? {}).toEqual({});
    expect(runtime.database.db.prepare(`SELECT metric FROM sensor_recorded_measurements
      WHERE sensor_id = ?`).all(sharedSensor.id)).toEqual([]);
    expect(runtime.database.sensorSourceMetrics(sharedSensor.id, "home-assistant")).toEqual([]);
    expect(runtime.mock.generate().map(({ sensorId }) => sensorId)).not.toContain(sharedSensor.id);
    expect(() => runtime.database.insertReading({
      sensorId: sharedSensor.id,
      timestamp: new Date().toISOString(),
      temperature: 20,
      humidity: 40,
      battery: 90,
      source: "mock",
      quality: "good",
    })).toThrow(/SHARED_HOME_DEMO_TELEMETRY_DISABLED/);

    const replay = await request(runtime.app).post("/api/v1/replay")
      .send({ sensorIds: [sharedSensor.id] }).expect(403);
    expect(replay.body.error.code).toBe("HOME_LOCAL_AUTHORITY_REQUIRED");

    const weather = await request(runtime.app).get(`/api/v1/houses/${sharedHouse.id}/weather`).expect(403);
    expect(weather.body.error.code).toBe("HOME_LOCAL_AUTHORITY_REQUIRED");

    const readings = await request(runtime.app).post("/api/v1/readings").send({
      sensorId: sharedSensor.id,
      timestamp: new Date().toISOString(),
      temperature: 20,
      humidity: 40,
      battery: 90,
      source: "home-assistant",
      quality: "good",
    }).expect(403);
    expect(readings.body.error.code).toBe("HOME_LOCAL_AUTHORITY_REQUIRED");

    const measurements = await request(runtime.app).post("/api/v2/measurements").send({
      sensorId: sharedSensor.id,
      metric: "temperature",
      value: 20,
      canonicalUnit: "\u00b0C",
      timestamp: new Date().toISOString(),
      source: "home-assistant",
      quality: "good",
    }).expect(403);
    expect(measurements.body.error.code).toBe("HOME_LOCAL_AUTHORITY_REQUIRED");

    const homeAssistant = await request(runtime.app)
      .put("/api/v1/integrations/home-assistant/config")
      .send({ houseId: sharedHouse.id }).expect(403);
    expect(homeAssistant.body.error.code).toBe("HOME_LOCAL_AUTHORITY_REQUIRED");

    const tpLink = await request(runtime.app)
      .put("/api/v1/integrations/tp-link/config")
      .send({
        houseId: sharedHouse.id,
        host: "192.0.2.1",
        username: "shared@example.test",
        password: "not-used",
      }).expect(403);
    expect(tpLink.body.error.code).toBe("HOME_LOCAL_AUTHORITY_REQUIRED");

    const canary = await request(runtime.app)
      .post("/api/v1/integrations/tp-link/history-export/canary")
      .send({ sensorId: sharedSensor.id }).expect(403);
    expect(canary.body.error.code).toBe("HOME_LOCAL_AUTHORITY_REQUIRED");

    const backfill = await request(runtime.app)
      .post("/api/v1/integrations/tp-link/history-export/backfill")
      .send({ sensorId: sharedSensor.id, metric: "temperature" }).expect(403);
    expect(backfill.body.error.code).toBe("HOME_LOCAL_AUTHORITY_REQUIRED");

    runtime.database.setHouseStugubyLink(sharedHouse.id, {
      ...runtime.database.getHouse(sharedHouse.id)!.stuguby!,
      syncState: "detached",
      detachedAt: new Date().toISOString(),
    });
    expect(runtime.mock.generate().map(({ sensorId }) => sensorId)).toContain(sharedSensor.id);
  });
});
