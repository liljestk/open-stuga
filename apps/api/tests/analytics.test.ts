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

function query(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: "1.0",
    dataMode: "live",
    scope: { kind: "house", id: "house-main", entityIds: ["sensor-01"] },
    measurementIds: ["temperature"],
    range: { start: "2026-07-19T10:00:00.000Z", end: "2026-07-19T10:15:00.000Z", timezone: "Europe/Helsinki" },
    resolution: "5m",
    aggregation: "default",
    include: ["series", "summary", "quality", "provenance"],
    maxPointsPerSeries: 500,
    requestId: "analytics-test",
    ...overrides,
  };
}

describe("analytics query API", () => {
  let runtime: ApiRuntime;

  beforeEach(() => {
    runtime = createApi({ config, startBackground: false });
    runtime.database.activateRealDataMode();
    runtime.database.insertMeasurementSamples([
      { sensorId: "sensor-01", metric: "temperature", value: 20, canonicalUnit: "°C", timestamp: "2026-07-19T10:00:00.000Z", source: "api", quality: "good" },
      { sensorId: "sensor-01", metric: "temperature", value: 21, canonicalUnit: "°C", timestamp: "2026-07-19T10:05:00.000Z", source: "api", quality: "good" },
      { sensorId: "sensor-01", metric: "temperature", value: 22, canonicalUnit: "°C", timestamp: "2026-07-19T10:10:00.000Z", source: "api", quality: "good" },
    ]);
  });

  afterEach(async () => { await runtime.close(); });

  it("returns bounded coverage-aware series, robust summaries, and provenance", async () => {
    const response = await request(runtime.app).post("/api/v2/analytics/query").send(query()).expect(200);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({
      apiVersion: "1.0",
      requestId: "analytics-test",
      dataMode: "live",
      resolution: "5m",
      cache: { hit: false, keyVersion: "analytics-query-v1" },
      quality: { seriesCount: 1, sampleCount: 3 },
      series: [{
        entityId: "sensor-01",
        measurementId: "temperature",
        canonicalUnit: "°C",
        truthClass: "derived",
        aggregation: "mean",
        summary: { count: 3, minimum: 20, maximum: 22, mean: 21, median: 21, p05: 20.1, p95: 21.9 },
        provenance: { algorithmKey: "analytics-bucket-rollup", algorithmVersion: "1.0.0", archiveState: "not-configured" },
      }],
    });
    expect(response.body.series[0].points).toHaveLength(3);
  });

  it("treats the requested end as exclusive", async () => {
    runtime.database.insertMeasurementSamples([
      { sensorId: "sensor-01", metric: "temperature", value: 99, canonicalUnit: "Â°C", timestamp: "2026-07-19T10:15:00.000Z", source: "api", quality: "good" },
    ]);

    const response = await request(runtime.app).post("/api/v2/analytics/query").send(query()).expect(200);

    expect(response.body.quality).toMatchObject({ sampleCount: 3, excludedSampleCount: 0 });
    expect(response.body.series[0].points.map((point: { value: number | null }) => point.value)).toEqual([20, 21, 22]);
  });

  it("discovers the complete recorded span for calendar comparisons", async () => {
    const response = await request(runtime.app).post("/api/v2/analytics/coverage").send({
      apiVersion: "1.0",
      dataMode: "live",
      scope: { kind: "house", id: "house-main", entityIds: ["sensor-01"] },
      measurementIds: ["temperature"],
      requestId: "analytics-coverage-test",
    }).expect(200);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({
      apiVersion: "1.0",
      requestId: "analytics-coverage-test",
      dataMode: "live",
      range: { start: "2026-07-19T10:00:00.000Z", end: "2026-07-19T10:10:00.000Z" },
      complete: true,
      archiveState: "not-configured",
      series: [{
        entityId: "sensor-01",
        measurementId: "temperature",
        start: "2026-07-19T10:00:00.000Z",
        end: "2026-07-19T10:10:00.000Z",
      }],
    });
  });

  it("rejects a missing or mismatched data mode and invalid measurement aggregation", async () => {
    const missing = query();
    delete (missing as { dataMode?: string }).dataMode;
    await request(runtime.app).post("/api/v2/analytics/query").send(missing).expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("DATA_MODE_REQUIRED"));
    await request(runtime.app).post("/api/v2/analytics/query").send(query({ dataMode: "demo" })).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("ANALYTICS_DATA_MODE_MISMATCH"));
    await request(runtime.app).post("/api/v2/analytics/query").send(query({ aggregation: "sum" })).expect(422)
      .expect(({ body }) => expect(body.error.code).toBe("INVALID_MEASUREMENT_AGGREGATION"));
  });

  it("uses reset-aware deltas for cumulative energy", async () => {
    runtime.database.insertMeasurementSamples([
      { sensorId: "sensor-01", metric: "energy", value: 10, canonicalUnit: "kWh", timestamp: "2026-07-19T10:00:00.000Z", source: "api", quality: "good" },
      { sensorId: "sensor-01", metric: "energy", value: 12, canonicalUnit: "kWh", timestamp: "2026-07-19T10:03:00.000Z", source: "api", quality: "good" },
      { sensorId: "sensor-01", metric: "energy", value: 1, canonicalUnit: "kWh", timestamp: "2026-07-19T10:06:00.000Z", source: "api", quality: "good" },
      { sensorId: "sensor-01", metric: "energy", value: 3, canonicalUnit: "kWh", timestamp: "2026-07-19T10:09:00.000Z", source: "api", quality: "good" },
    ]);
    const response = await request(runtime.app).post("/api/v2/analytics/query").send(query({
      measurementIds: ["energy"], resolution: "5m",
    })).expect(200);

    expect(response.body.series[0]).toMatchObject({ aggregation: "delta", points: [{ value: 2 }, { value: 2 }, { value: null }] });
    expect(response.body.series[0].points[1].qualityFlags).toContain("counter_reset");
  });

  it("labels unmodified raw observations without claiming an aggregation", async () => {
    const response = await request(runtime.app).post("/api/v2/analytics/query").send(query({
      resolution: "raw",
    })).expect(200);

    expect(response.body.series[0]).toMatchObject({ aggregation: "raw", truthClass: "observed" });
    expect(response.body.series[0].points).toHaveLength(3);
  });

  it("filters source quality explicitly while preserving excluded intervals as gaps", async () => {
    runtime.database.insertMeasurementSamples([
      { sensorId: "sensor-01", metric: "temperature", value: 23, canonicalUnit: "°C", timestamp: "2026-07-19T10:15:00.000Z", source: "api", quality: "estimated" },
      { sensorId: "sensor-01", metric: "temperature", value: 24, canonicalUnit: "°C", timestamp: "2026-07-19T10:20:00.000Z", source: "api", quality: "stale" },
    ]);
    const range = { start: "2026-07-19T10:00:00.000Z", end: "2026-07-19T10:25:00.000Z", timezone: "UTC" };
    const good = await request(runtime.app).post("/api/v2/analytics/query").send(query({
      range, qualityFilter: { include: ["good"] },
    })).expect(200);

    expect(good.body.quality).toMatchObject({ sampleCount: 3, excludedSampleCount: 2, includedQualities: ["good"] });
    expect(good.body.series[0].points.map((point: { value: number | null }) => point.value)).toEqual([20, 21, 22, null, null]);
    expect(good.body.warnings).toContainEqual(expect.objectContaining({ code: "QUALITY_FILTER_EXCLUDED" }));

    const estimated = await request(runtime.app).post("/api/v2/analytics/query").send(query({
      range, qualityFilter: { include: ["estimated"] },
    })).expect(200);
    expect(estimated.body.series[0].points[3]).toMatchObject({ value: 23, qualityFlags: ["source_estimated"] });

    await request(runtime.app).post("/api/v2/analytics/query").send(query({ qualityFilter: { include: ["unknown"] } }))
      .expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_ANALYTICS_QUALITY_FILTER"));
  });

  it("rejects an explicit resolution that exceeds the per-series point budget", async () => {
    await request(runtime.app).post("/api/v2/analytics/query").send(query({
      range: { start: "2026-07-17T10:00:00.000Z", end: "2026-07-19T10:00:00.000Z", timezone: "UTC" },
      resolution: "1m",
      maxPointsPerSeries: 100,
    })).expect(422).expect(({ body }) => expect(body.error.code).toBe("ANALYTICS_POINT_LIMIT_EXCEEDED"));
  });

  it("rejects raw responses that exceed the declared interactive point budget", async () => {
    const samples = Array.from({ length: 101 }, (_, index) => ({
      sensorId: "sensor-01", metric: "co2", value: 500 + index, canonicalUnit: "ppm",
      timestamp: new Date(Date.parse("2026-07-19T10:00:00.000Z") + index * 1_000).toISOString(),
      source: "api" as const, quality: "good" as const,
    }));
    runtime.database.insertMeasurementSamples(samples);
    await request(runtime.app).post("/api/v2/analytics/query").send(query({
      measurementIds: ["co2"], resolution: "raw", maxPointsPerSeries: 100,
      range: { start: "2026-07-19T10:00:00.000Z", end: "2026-07-19T10:02:00.000Z", timezone: "UTC" },
    })).expect(422).expect(({ body }) => expect(body.error.code).toBe("RAW_POINT_LIMIT_EXCEEDED"));
  });
});
