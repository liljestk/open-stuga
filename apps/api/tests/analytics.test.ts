import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { ClimateDatabase } from "../src/db.js";
import {
  HybridTelemetryReader,
  type ArchiveTelemetryReader,
} from "../src/timeseries/read-facade.js";
import type { TimeseriesStore } from "../src/timeseries/store.js";

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

  it.each(["energy", "power"] as const)("matches %s summary consumption at both range boundaries without counting anchors as observations", async (metric) => {
    const start = "2026-07-19T10:05:00.000Z";
    const end = "2026-07-19T10:35:00.000Z";
    const values = metric === "energy" ? [100, 102, 0.5, 1.5] : [1000, 2000, 0, 0];
    runtime.database.insertMeasurementSamples([0, 10, 20, 35].map((minute, index) => ({
      sensorId: "sensor-01", metric, value: values[index]!, canonicalUnit: metric === "energy" ? "kWh" : "W",
      timestamp: new Date(Date.parse("2026-07-19T10:00:00.000Z") + minute * 60_000).toISOString(),
      source: "api", quality: "good" as const,
    })));
    const aggregateQuery = { sensorId: "sensor-01", propertyId: "property-main", from: start, to: end };
    const summary = metric === "energy" ? runtime.database.energyCostAggregate(aggregateQuery)
      : runtime.database.powerCostAggregate(aggregateQuery);
    const response = await request(runtime.app).post("/api/v2/analytics/query").send(query({
      measurementIds: [metric], resolution: "15m", aggregation: "default",
      qualityFilter: { include: ["good", "estimated"] },
      range: { start, end, timezone: "UTC" },
    })).expect(200);
    const series = response.body.series[0];
    expect(series.points.reduce((sum: number, point: { consumptionKwh?: number }) => sum + (point.consumptionKwh ?? 0), 0))
      .toBeCloseTo(summary.consumptionKwh, 5);
    expect(series.summary.count).toBe(2);
    expect(response.body.quality.sampleCount).toBe(2);
    expect(series.points.reduce((sum: number, point: { sampleCount: number }) => sum + point.sampleCount, 0)).toBe(2);
  });

  it("returns consumption from raw SQLite counters before downsampling across a reset", async () => {
    runtime.database.insertMeasurementSamples([100, 101, 102, 0, 1, 2].map((value, index) => ({
      sensorId: "sensor-01", metric: "energy", value, canonicalUnit: "kWh",
      timestamp: new Date(Date.parse("2026-07-19T10:00:00.000Z") + index * 60_000).toISOString(),
      source: "api", quality: "good" as const,
    })));
    const response = await request(runtime.app).post("/api/v2/analytics/query").send(query({
      measurementIds: ["energy"], resolution: "2m", aggregation: "delta",
      range: { start: "2026-07-19T10:00:00.000Z", end: "2026-07-19T10:06:00.000Z", timezone: "UTC" },
    })).expect(200);
    expect(response.body.series[0].points.map((point: { consumptionKwh: number }) => point.consumptionKwh)).toEqual([1, 1, 2]);
  });

  it("returns bounded power consumption across empty SQLite display buckets", async () => {
    runtime.database.insertMeasurementSamples([
      { sensorId: "sensor-01", metric: "power", value: 1000, canonicalUnit: "W", timestamp: "2026-07-19T10:04:00.000Z", source: "api", quality: "good" },
      { sensorId: "sensor-01", metric: "power", value: 0, canonicalUnit: "W", timestamp: "2026-07-19T11:04:00.000Z", source: "api", quality: "good" },
    ]);
    const response = await request(runtime.app).post("/api/v2/analytics/query").send(query({
      measurementIds: ["power"], resolution: "5m", aggregation: "time_weighted_mean",
      range: { start: "2026-07-19T10:00:00.000Z", end: "2026-07-19T11:30:00.000Z", timezone: "UTC" },
    })).expect(200);
    const points = response.body.series[0].points as Array<{ consumptionKwh?: number }>;
    expect(points.reduce((sum, point) => sum + (point.consumptionKwh ?? 0), 0)).toBeCloseTo(0.25);
    expect(points[1]?.consumptionKwh).toBeCloseTo(5 / 60);
  });

  it("returns explicit unavailable consumption for conflicting simultaneous SQLite sources", async () => {
    runtime.database.insertMeasurementSamples([
      { sensorId: "sensor-01", metric: "power", value: 1000, canonicalUnit: "W", timestamp: "2026-07-19T10:00:00.000Z", source: "tp-link", quality: "good" },
      { sensorId: "sensor-01", metric: "power", value: 2000, canonicalUnit: "W", timestamp: "2026-07-19T10:00:00.000Z", source: "api", quality: "good" },
      { sensorId: "sensor-01", metric: "power", value: 0, canonicalUnit: "W", timestamp: "2026-07-19T10:15:00.000Z", source: "tp-link", quality: "good" },
    ]);
    const response = await request(runtime.app).post("/api/v2/analytics/query").send(query({
      measurementIds: ["power"], resolution: "5m", aggregation: "time_weighted_mean",
      range: { start: "2026-07-19T10:00:00.000Z", end: "2026-07-19T10:30:00.000Z", timezone: "UTC" },
    })).expect(200);
    expect(response.body.series[0].points.map((point: { consumptionKwh: number | null }) => point.consumptionKwh))
      .toEqual([null, null, null, 0, 0, 0]);
  });

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

  it("accepts whole-minute custom resolutions for export buckets", async () => {
    const response = await request(runtime.app).post("/api/v2/analytics/query").send(query({
      resolution: "7m",
      maxPointsPerSeries: 500,
    })).expect(200);

    expect(response.body).toMatchObject({ resolution: "7m", series: [{ resolution: "7m", aggregation: "mean" }] });
    const timestamps = response.body.series[0].points.map((point: { timestamp: string }) => Date.parse(point.timestamp));
    expect(timestamps.slice(1).map((timestamp: number, index: number) => timestamp - timestamps[index])).toEqual(
      Array.from({ length: Math.max(0, timestamps.length - 1) }, () => 7 * 60_000),
    );
  });

  it("rejects custom resolutions outside the supported whole-minute range", async () => {
    for (const resolution of ["0m", "1441m", "7.5m", "7minutes"]) {
      await request(runtime.app).post("/api/v2/analytics/query").send(query({ resolution })).expect(400)
        .expect(({ body }) => expect(body.error.code).toBe("INVALID_ANALYTICS_RESOLUTION"));
    }
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

  it("allows explicitly selected archived sensors without adding them to the default scope", async () => {
    runtime.database.updateSensor("sensor-01", { enabled: false });
    expect(runtime.database.getSensor("sensor-01")?.recordedMeasurementIds).toEqual(["temperature"]);

    const response = await request(runtime.app).post("/api/v2/analytics/query").send(query()).expect(200);
    expect(response.body).toMatchObject({
      series: [{ entityId: "sensor-01", summary: { count: 3 } }],
    });

    const coverage = await request(runtime.app).post("/api/v2/analytics/coverage").send({
      apiVersion: "1.0",
      dataMode: "live",
      scope: { kind: "house", id: "house-main", entityIds: ["sensor-01"] },
      measurementIds: ["temperature"],
      requestId: "archived-analytics-coverage-test",
    }).expect(200);
    expect(coverage.body).toMatchObject({
      range: { start: "2026-07-19T10:00:00.000Z", end: "2026-07-19T10:10:00.000Z" },
      series: [{ entityId: "sensor-01" }],
    });

    await request(runtime.app).post("/api/v2/analytics/query").send(query({
      scope: { kind: "house", id: "house-main" },
    })).expect(200).expect(({ body }) => expect(
      body.series.map((series: { entityId: string }) => series.entityId),
    ).not.toContain("sensor-01"));

    runtime.database.db.prepare("DELETE FROM measurement_samples WHERE sensor_id = ?").run("sensor-01");
    expect(runtime.database.getSensor("sensor-01")?.recordedMeasurementIds).toEqual(["temperature"]);
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

  it("uses bounded archive rollups instead of loading a high-frequency source window", async () => {
    await runtime.close();
    const database = new ClimateDatabase(":memory:", true);
    database.activateRealDataMode();
    const measurementWindow = vi.spyOn(database, "measurementWindow").mockImplementation(() => {
      throw new Error("raw source window must not be read");
    });
    const measurementAnalyticsRollup = vi.fn(async () => ({
      series: [{
        sensorId: "sensor-01",
        metric: "temperature",
        canonicalUnit: "Â°C",
        sampleCount: 1_166_400,
        excludedSampleCount: 0,
        cadenceSeconds: 2,
        buckets: [{
          bucketStart: "2026-07-01T00:00:00.000Z",
          value: 20,
          minimum: 19,
          maximum: 21,
          sampleCount: 1_800,
          estimatedSampleCount: 0,
          staleSampleCount: 0,
          counterResetCount: 0,
        }],
      }],
    }));
    const archive: ArchiveTelemetryReader = {
      measurementHistory: vi.fn(async () => []),
      measurementAnalyticsRollup,
      legacyReadingHistory: vi.fn(async () => []),
      outdoorTemperatureHistory: vi.fn(async () => []),
    };
    const telemetryReader = new HybridTelemetryReader({
      local: database,
      archive,
      archivePhase: () => "ready",
      localHistoryComplete: false,
    });
    runtime = createApi({ config, database, telemetryReader, startBackground: false });

    const response = await request(runtime.app).post("/api/v2/analytics/query").send(query({
      range: {
        start: "2026-07-01T00:00:00.000Z",
        end: "2026-07-28T00:00:00.000Z",
        timezone: "UTC",
      },
      resolution: "1h",
      maxPointsPerSeries: 1_000,
    })).expect(200);

    expect(measurementAnalyticsRollup).toHaveBeenCalledWith(expect.objectContaining({
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-28T00:00:00.000Z",
      resolution: "1h",
      excludeSynthetic: true,
      series: [{ sensorId: "sensor-01", metric: "temperature", aggregation: "mean" }],
    }));
    expect(measurementWindow).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({
      resolution: "1h",
      quality: { sampleCount: 1_166_400 },
      series: [{
        aggregation: "mean",
        provenance: { archiveState: "merged" },
      }],
    });
    expect(response.body.series[0].points[0]).toMatchObject({ value: 20, sampleCount: 1_800, coverage: 1 });
  });

  it("falls back to complete raw archive data while a continuous aggregate catches up", async () => {
    await runtime.close();
    const database = new ClimateDatabase(":memory:", true);
    database.activateRealDataMode();
    const measurementAnalyticsRollup = vi.fn(async () => {
      throw new Error("continuous aggregate is still materializing");
    });
    const measurementWindow = vi.fn(async () => [
      { sensorId: "sensor-01", metric: "temperature", value: 20, canonicalUnit: "C", timestamp: "2026-07-19T10:00:00.000Z", source: "api" as const, quality: "good" as const },
      { sensorId: "sensor-01", metric: "temperature", value: 21, canonicalUnit: "C", timestamp: "2026-07-19T10:05:00.000Z", source: "api" as const, quality: "good" as const },
      { sensorId: "sensor-01", metric: "temperature", value: 22, canonicalUnit: "C", timestamp: "2026-07-19T10:10:00.000Z", source: "api" as const, quality: "good" as const },
    ]);
    const archive: ArchiveTelemetryReader = {
      measurementHistory: vi.fn(async () => []),
      measurementWindow,
      measurementAnalyticsRollup,
      legacyReadingHistory: vi.fn(async () => []),
      outdoorTemperatureHistory: vi.fn(async () => []),
    };
    const telemetryReader = new HybridTelemetryReader({
      local: database,
      archive,
      archivePhase: () => "ready",
      localHistoryComplete: false,
    });
    runtime = createApi({ config, database, telemetryReader, startBackground: false });

    const response = await request(runtime.app).post("/api/v2/analytics/query").send(query()).expect(200);

    expect(measurementAnalyticsRollup).toHaveBeenCalledOnce();
    expect(measurementWindow).toHaveBeenCalledOnce();
    expect(response.body).toMatchObject({
      quality: { sampleCount: 3 },
      series: [{ provenance: { archiveState: "merged" }, summary: { mean: 21 } }],
    });
  });

  it("uses the complete unbounded SQLite duplicate while TimeDB is unavailable", async () => {
    await runtime.close();
    const database = new ClimateDatabase(":memory:", true);
    database.activateRealDataMode();
    database.insertMeasurementSamples([
      { sensorId: "sensor-01", metric: "temperature", value: 20, canonicalUnit: "C", timestamp: "2026-07-19T10:00:00.000Z", source: "api", quality: "good" },
      { sensorId: "sensor-01", metric: "temperature", value: 21, canonicalUnit: "C", timestamp: "2026-07-19T10:05:00.000Z", source: "api", quality: "good" },
      { sensorId: "sensor-01", metric: "temperature", value: 22, canonicalUnit: "C", timestamp: "2026-07-19T10:10:00.000Z", source: "api", quality: "good" },
    ]);
    const timeseriesStore = {
      close: vi.fn(async () => undefined),
    } as unknown as TimeseriesStore;
    runtime = createApi({
      config: { ...config, timeseriesEnabled: true, retentionDays: 0 },
      database,
      timeseriesStore,
      startBackground: false,
    });

    const response = await request(runtime.app).post("/api/v2/analytics/query").send(query()).expect(200);

    expect(response.body).toMatchObject({
      quality: { sampleCount: 3 },
      series: [{
        provenance: { archiveState: "not-ready" },
        summary: { mean: 21 },
      }],
    });

    const coverageResponse = await request(runtime.app).post("/api/v2/analytics/coverage").send({
      apiVersion: "1.0",
      dataMode: "live",
      scope: { kind: "house", id: "house-main", entityIds: ["sensor-01"] },
      measurementIds: ["temperature"],
      requestId: "analytics-unbounded-local-coverage-test",
    }).expect(200);

    expect(coverageResponse.body).toMatchObject({
      archiveState: "not-ready",
      complete: true,
      range: { start: "2026-07-19T10:00:00.000Z", end: "2026-07-19T10:10:00.000Z" },
    });
  });
});
