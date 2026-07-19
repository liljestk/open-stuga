import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: "integration-secrets.test.json", assetDirectory: ".",
  mockEnabled: false, mockIntervalMs: 25, retentionDays: 730, ingestApiKey: null,
  haUrl: null, haToken: null, haEntityMapFile: null,
  tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null, tpLinkDeviceMapFile: null,
  tpLinkPollIntervalMs: 10_000, tpLinkPython: "python", tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
  alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
};

describe("sensor detail history", () => {
  let runtime: ApiRuntime;
  beforeEach(() => { runtime = createApi({ config, startBackground: false }); });
  afterEach(async () => { await runtime.close(); });

  it("keeps only the covering latest-reading index", () => {
    const indexes = runtime.database.db.prepare("PRAGMA index_list('readings')").all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toContain("idx_readings_sensor_time_id");
    expect(indexes.map((index) => index.name)).not.toContain("idx_readings_sensor_time");
  });

  it("pages all metrics newest-first without duplicates", async () => {
    await request(runtime.app).post("/api/v2/measurements").send({ samples: [
      { sensorId: "sensor-01", metric: "temperature", value: 20, canonicalUnit: "°C", timestamp: "2026-07-14T10:00:00Z" },
      { sensorId: "sensor-01", metric: "humidity", value: 45, canonicalUnit: "%", timestamp: "2026-07-14T10:01:00Z" },
      { sensorId: "sensor-01", metric: "co2", value: 800, canonicalUnit: "ppm", timestamp: "2026-07-14T10:02:00Z" },
    ] }).expect(201);

    const first = await request(runtime.app).get("/api/v2/sensors/sensor-01/measurements").query({ limit: 2 }).expect(200);
    expect(first.body.samples.map((sample: { metric: string }) => sample.metric)).toEqual(["co2", "humidity"]);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await request(runtime.app).get("/api/v2/sensors/sensor-01/measurements")
      .query({ limit: 2, cursor: first.body.nextCursor }).expect(200);
    expect(second.body.samples.map((sample: { metric: string }) => sample.metric)).toEqual(["temperature"]);
    expect(second.body.nextCursor).toBeNull();
  });

  it("canonicalizes parseable cursor timestamps before lexical pagination", async () => {
    await request(runtime.app).post("/api/v2/measurements").send({ samples: [
      { sensorId: "sensor-01", metric: "temperature", value: 20, canonicalUnit: "°C", timestamp: "2026-07-14T10:00:00Z" },
      { sensorId: "sensor-01", metric: "humidity", value: 45, canonicalUnit: "%", timestamp: "2026-07-14T10:01:00Z" },
      { sensorId: "sensor-01", metric: "co2", value: 800, canonicalUnit: "ppm", timestamp: "2026-07-14T10:02:00Z" },
    ] }).expect(201);

    const cursor = Buffer.from(JSON.stringify([
      "2026-07-14T13:01:00+03:00",
      Number.MAX_SAFE_INTEGER,
    ])).toString("base64url");
    const page = await request(runtime.app).get("/api/v2/sensors/sensor-01/measurements")
      .query({ cursor, limit: 10 }).expect(200);
    expect(page.body.samples.map((sample: { metric: string }) => sample.metric)).toEqual(["humidity", "temperature"]);
  });
});
