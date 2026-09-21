import { describe, expect, it } from "vitest";
import type {
  AnalyticsQueryRequest,
  MeasurementDefinition,
  MeasurementSample,
} from "@climate-twin/contracts";
import {
  AnalyticsQueryError,
  buildAnalyticsResponse,
  resolveAnalyticsQueryShape,
} from "../src/analytics.js";

const definition = {
  id: "temperature",
  label: "Temperature",
  unit: "C",
  precision: 1,
  enabled: true,
  kind: "gauge",
  defaultAggregation: "mean",
} as unknown as MeasurementDefinition;

function request(overrides: Partial<AnalyticsQueryRequest> = {}): AnalyticsQueryRequest {
  return {
    apiVersion: "1.0",
    dataMode: "live",
    scope: { kind: "house", id: "house-1" },
    measurementIds: ["temperature"],
    range: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T02:00:00.000Z", timezone: "UTC" },
    resolution: "1h",
    aggregation: "default",
    include: ["series"],
    maxPointsPerSeries: 800,
    requestId: "request-1",
    ...overrides,
  } as AnalyticsQueryRequest;
}

function denseSamples(count: number, sensorId = "sensor-1"): MeasurementSample[] {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => ({
    sensorId,
    metric: "temperature",
    value: index % 50,
    canonicalUnit: "C",
    timestamp: new Date(start + index * 10).toISOString(),
    source: "tp-link",
    quality: "good",
  })) as MeasurementSample[];
}

describe("analytics bucket extents", () => {
  // `Math.min(...values)` exceeded the engine argument limit once a bucket held
  // more samples than the stack allows, turning a valid query into a 500.
  it("aggregates a bucket holding far more samples than a spread call accepts", async () => {
    const response = await buildAnalyticsResponse({
      request: request({ aggregation: "min" }),
      samples: denseSamples(200_000),
      definitions: [definition],
      entities: [{ id: "sensor-1", label: "Sensor 1" }],
      archiveState: "merged",
    });
    const [series] = response.series;
    expect(series?.points[0]?.value).toBe(0);
    expect(series?.points[0]?.maximum).toBe(49);
    expect(response.summaries[0]?.minimum).toBe(0);
  });
});

describe("analytics admission guard", () => {
  it("does not advise automatic resolution when the caller already asked for it", () => {
    expect.assertions(2);
    try {
      resolveAnalyticsQueryShape({
        request: request({
          resolution: "auto",
          range: { start: "2016-01-01T00:00:00.000Z", end: "2026-01-01T00:00:00.000Z", timezone: "UTC" },
        }),
        entityCount: 1,
      });
    } catch (error) {
      expect((error as AnalyticsQueryError).message).toContain("coarsest supported resolution");
      expect((error as AnalyticsQueryError).message).not.toContain("choose automatic resolution");
    }
  });

  it("still points an explicit resolution back at automatic selection", () => {
    expect.assertions(1);
    try {
      resolveAnalyticsQueryShape({
        request: request({
          resolution: "1m",
          range: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-08T00:00:00.000Z", timezone: "UTC" },
        }),
        entityCount: 1,
      });
    } catch (error) {
      expect((error as AnalyticsQueryError).message).toContain("choose automatic resolution");
    }
  });
});
