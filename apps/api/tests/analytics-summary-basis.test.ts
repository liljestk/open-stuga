import { describe, expect, it } from "vitest";
import type { MeasurementDefinition, MeasurementSample } from "@climate-twin/contracts";
import { buildAnalyticsResponse, parseAnalyticsQueryRequest } from "../src/analytics.js";
import { ClimateDatabase } from "../src/db.js";

const START = Date.parse("2026-07-19T00:00:00.000Z");
const HOUR = 3_600_000;
const definition = {
  id: "temperature", labels: { en: "Temperature" }, unit: "°C", kind: "gauge", defaultAggregation: "mean",
  precision: 2, interpolationDelta: 0.5, enabled: true,
} as unknown as MeasurementDefinition;

function samples(intervalMs: number, hours: number, keep: (index: number) => boolean = () => true): MeasurementSample[] {
  const result: MeasurementSample[] = [];
  for (let index = 0; index * intervalMs < hours * HOUR; index += 1) {
    if (!keep(index)) continue;
    const time = START + index * intervalMs;
    // A warm afternoon: the value spends more time high than low.
    const value = 20 + 3 * Math.sin(2 * Math.PI * (time - START) / (24 * HOUR)) + (index % 7) * 0.01;
    result.push({ sensorId: "room", metric: "temperature", value, canonicalUnit: "°C",
      timestamp: new Date(time).toISOString(), source: "api", quality: "good" });
  }
  return result;
}

async function summaryAt(resolution: string, input: MeasurementSample[], expected?: number) {
  const request = parseAnalyticsQueryRequest({
    apiVersion: "1.0", dataMode: "live",
    scope: { kind: "house", id: "house-main", entityIds: ["room"] },
    measurementIds: ["temperature"],
    range: { start: new Date(START).toISOString(), end: new Date(START + 24 * HOUR).toISOString(), timezone: "UTC" },
    resolution, aggregation: "default", requestId: `summary-${resolution}`,
  }, START + 25 * HOUR);
  const response = await buildAnalyticsResponse({
    request, samples: input, definitions: [definition], entities: [{ id: "room", label: "Room" }],
    archiveState: "merged",
    ...(expected ? { expectedIntervalSeconds: new Map([[JSON.stringify(["room", "temperature"]), expected]]) } : {}),
  });
  return response.series[0]!.summary;
}

describe("analytics summaries", () => {
  it("do not change with the displayed resolution", async () => {
    const input = samples(60_000, 24);
    const summaries = await Promise.all(["5m", "15m", "1h", "1d"].map((resolution) => summaryAt(resolution, input)));
    for (const summary of summaries) {
      expect(summary.basis).toEqual({ statistics: "mean-base", baseResolution: "1m" });
      for (const key of ["mean", "median", "p05", "p95", "minimum", "maximum", "standardDeviation"] as const) {
        expect(summary[key], key).toBeCloseTo(summaries[0]![key]!, 9);
      }
    }
    // Extremes come from the samples, not from bucket averages.
    expect(summaries[3]!.maximum).toBeCloseTo(Math.max(...input.map((sample) => sample.value)), 9);
    expect(summaries[3]!.minimum).toBeCloseTo(Math.min(...input.map((sample) => sample.value)), 9);
  });

  it("weights equal stretches of time equally, not by how many readings arrived", async () => {
    // Readings arrive every 10 s in the warm half of the day and every 5 min otherwise.
    const dense = samples(10_000, 24).filter((sample) => {
      const hour = (Date.parse(sample.timestamp) - START) / HOUR;
      return hour < 12 || (Date.parse(sample.timestamp) - START) % 300_000 === 0;
    });
    const even = await summaryAt("1h", samples(60_000, 24));
    const uneven = await summaryAt("1h", dense);
    expect(Math.abs(uneven.mean! - even.mean!)).toBeLessThan(0.05);
    const sampleMean = dense.reduce((sum, sample) => sum + sample.value, 0) / dense.length;
    expect(Math.abs(sampleMean - even.mean!)).toBeGreaterThan(0.5);
  });

  it("measures coverage against the sensor's usual reporting interval", async () => {
    // Every other one-minute reading is lost all day.
    const halved = samples(60_000, 24, (index) => index % 2 === 0);
    const density = await summaryAt("1h", halved);
    const expected = await summaryAt("1h", halved, 60);
    expect(density.coverageBasis).toBe("window-density");
    expect(density.coverage).toBeGreaterThan(0.95);
    expect(expected.coverageBasis).toBe("expected-interval");
    expect(expected.expectedIntervalSeconds).toBe(60);
    expect(expected.coverage).toBeCloseTo(0.5, 2);
  });
});

describe("expected reporting intervals", () => {
  it("stores the median gap, ignores outages and refreshes daily", () => {
    const database = new ClimateDatabase(":memory:");
    try {
      const now = Date.now();
      const readings = Array.from({ length: 200 }, (_, index) => ({
        sensorId: "sensor-01", metric: "humidity", value: 40, canonicalUnit: "%",
        // 30-second reporting with a two-hour outage in the middle.
        timestamp: new Date(now - 2 * HOUR - 200 * 30_000 + index * 30_000 + (index >= 100 ? 2 * HOUR : 0)).toISOString(),
        source: "api" as const, quality: "good" as const,
      }));
      database.insertMeasurementSamples(readings);
      const key = JSON.stringify(["sensor-01", "humidity"]);
      expect(database.expectedReportingIntervals([{ sensorId: "sensor-01", metric: "humidity" }], now).get(key)).toBe(30);
      // Too few readings give no interval rather than a guess.
      expect(database.expectedReportingIntervals([{ sensorId: "sensor-01", metric: "co2" }], now).has(JSON.stringify(["sensor-01", "co2"])))
        .toBe(false);
      // Cached within a day, even after more readings arrive.
      database.insertMeasurementSamples(readings.map((reading, index) => ({
        ...reading, timestamp: new Date(now - 60_000 + index * 100).toISOString(),
      })));
      expect(database.expectedReportingIntervals([{ sensorId: "sensor-01", metric: "humidity" }], now + 60_000).get(key)).toBe(30);
    } finally {
      database.close();
    }
  });
});
