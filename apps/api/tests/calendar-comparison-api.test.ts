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

function comparison(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: "1.0",
    requestId: "calendar-api-test",
    houseId: "calendar-house",
    dataMode: "live",
    sensorIds: ["sensor-a", "sensor-b"],
    measurementId: "temperature",
    unit: "month",
    anchor: { month: 10, day: 15, week: 42 },
    selectedPeriodKeys: ["2024-10", "2025-10"],
    aggregation: "default",
    qualityFilter: { include: ["good", "estimated"] },
    ...overrides,
  };
}

describe("calendar comparison API", () => {
  let runtime: ApiRuntime;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
    runtime = createApi({ config, startBackground: false });
    runtime.database.activateRealDataMode();
    runtime.database.createHouse({
      id: "calendar-house",
      name: "Calendar house",
      timezone: "Europe/Helsinki",
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
    for (const [id, name] of [["sensor-a", "Sensor A"], ["sensor-b", "Sensor B"]]) {
      runtime.database.createSensor({
        id,
        houseId: "calendar-house",
        floorId: "ground",
        roomId: "living",
        room: "Living",
        name,
        model: "T310",
        x: 5,
        y: 4,
        z: 1.2,
        tags: [],
        enabled: true,
      });
    }
    runtime.database.insertMeasurementSamples([
      {
        sensorId: "sensor-a",
        metric: "temperature",
        value: 20,
        canonicalUnit: "°C",
        timestamp: "2024-10-15T09:00:00.000Z",
        source: "api",
        quality: "good",
      },
      {
        sensorId: "sensor-b",
        metric: "temperature",
        value: 24,
        canonicalUnit: "°C",
        timestamp: "2024-10-15T09:00:00.000Z",
        source: "api",
        quality: "good",
      },
      {
        sensorId: "sensor-a",
        metric: "temperature",
        value: 18,
        canonicalUnit: "°C",
        timestamp: "2025-10-15T09:00:00.000Z",
        source: "api",
        quality: "good",
      },
      {
        sensorId: "sensor-b",
        metric: "temperature",
        value: 22,
        canonicalUnit: "°C",
        timestamp: "2025-10-15T09:00:00.000Z",
        source: "api",
        quality: "good",
      },
    ]);
  });

  afterEach(async () => {
    await runtime.close();
    vi.useRealTimers();
  });

  it("uses the stored timezone, batches each selected period, and combines every sensor", async () => {
    const measurementWindow = vi.spyOn(runtime.telemetryReader, "measurementWindow");

    const response = await request(runtime.app)
      .post("/api/v2/analytics/calendar-comparison")
      .send(comparison())
      .expect(200);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(measurementWindow).toHaveBeenCalledTimes(2);
    expect(measurementWindow).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sensorIds: ["sensor-a", "sensor-b"],
      metrics: ["temperature"],
      from: "2024-09-30T21:00:00.000Z",
      to: "2024-10-31T21:59:59.999Z",
    }));
    expect(response.body).toMatchObject({
      apiVersion: "1.0",
      houseId: "calendar-house",
      measurementId: "temperature",
      completeness: "complete",
      provenance: {
        algorithmKey: "calendar-comparison",
        algorithmVersion: "calendar-comparison-v1.0.0",
        sourceIds: ["sensor-a", "sensor-b"],
      },
      selectedPeriods: [{
        key: "2024-10",
        start: "2024-09-30T21:00:00.000Z",
        naturalEnd: "2024-10-31T22:00:00.000Z",
      }, {
        key: "2025-10",
      }],
    });
    const combined = response.body.series.filter(
      (series: { sourceId: string }) => series.sourceId === "combined",
    );
    expect(combined).toHaveLength(2);
    expect(combined.map((series: { summary: { value: number } }) => series.summary.value))
      .toEqual([22, 20]);
  });

  it("accepts only intent fields and rejects unavailable periods and modes", async () => {
    await request(runtime.app)
      .post("/api/v2/analytics/calendar-comparison")
      .send({ ...comparison(), timezone: "UTC" })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("INVALID_FIELD"));

    await request(runtime.app)
      .post("/api/v2/analytics/calendar-comparison")
      .send(comparison({ selectedPeriodKeys: ["2023-10"] }))
      .expect(422)
      .expect(({ body }) => {
        expect(body.error.code).toBe("CALENDAR_COMPARISON_PERIOD_NOT_AVAILABLE");
      });

    await request(runtime.app)
      .post("/api/v2/analytics/calendar-comparison")
      .send(comparison({ dataMode: "demo" }))
      .expect(409);
  });

  it("fails the whole comparison when complete archive coverage cannot be proven", async () => {
    vi.spyOn(runtime.telemetryReader, "measurementCoverage").mockResolvedValueOnce({
      records: [],
      archiveState: "not-ready",
      complete: false,
    });

    await request(runtime.app)
      .post("/api/v2/analytics/calendar-comparison")
      .send(comparison())
      .expect(503)
      .expect(({ body }) => {
        expect(body.error.code).toBe("TELEMETRY_ARCHIVE_REQUIRED");
        expect(body.error.details.archiveState).toBe("not-ready");
      });
  });

  it("requests one context bucket before cumulative-counter periods", async () => {
    runtime.database.insertMeasurementSamples([
      {
        sensorId: "sensor-a",
        metric: "energy",
        value: 10,
        canonicalUnit: "kWh",
        timestamp: "2024-09-30T20:50:00.000Z",
        source: "api",
        quality: "good",
      },
      {
        sensorId: "sensor-a",
        metric: "energy",
        value: 12,
        canonicalUnit: "kWh",
        timestamp: "2024-10-15T09:00:00.000Z",
        source: "api",
        quality: "good",
      },
      {
        sensorId: "sensor-a",
        metric: "energy",
        value: 20,
        canonicalUnit: "kWh",
        timestamp: "2025-09-30T20:50:00.000Z",
        source: "api",
        quality: "good",
      },
      {
        sensorId: "sensor-a",
        metric: "energy",
        value: 23,
        canonicalUnit: "kWh",
        timestamp: "2025-10-15T09:00:00.000Z",
        source: "api",
        quality: "good",
      },
    ]);
    const measurementWindow = vi.spyOn(runtime.telemetryReader, "measurementWindow");

    await request(runtime.app)
      .post("/api/v2/analytics/calendar-comparison")
      .send(comparison({
        sensorIds: ["sensor-a"],
        measurementId: "energy",
      }))
      .expect(200);

    expect(measurementWindow).toHaveBeenNthCalledWith(1, expect.objectContaining({
      from: "2024-09-30T20:45:00.000Z",
      to: "2024-10-31T21:59:59.999Z",
    }));
  });
});
