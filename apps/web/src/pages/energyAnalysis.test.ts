import type { AnalyticsQueryResponse, HomeEnergyCost, HomeEnergySummary, MeasurementSample, Sensor } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import { createDemoState } from "../domain";
import {
  aggregateCumulativeSeries,
  buildConsumerInsights,
  consumptionHistorySeries,
  electricityUsageSeries,
  holdSeriesForBuckets,
} from "./energyAnalysis";

function sample(sensorId: string, metric: "energy" | "power", value: number, timestamp: string): MeasurementSample {
  return {
    sensorId,
    metric,
    value,
    canonicalUnit: metric === "energy" ? "kWh" : "W",
    timestamp,
    source: "tp-link",
    quality: "good",
  };
}

function contribution(sensorId: string, consumptionKwh: number, from: string, to: string): HomeEnergyCost {
  return {
    houseId: "home",
    sensorId,
    from,
    to,
    measurementBasis: "energy_counter",
    consumptionKwh,
    pricedConsumptionKwh: null,
    costEur: null,
    costBreakdown: null,
    priceCoveragePercent: 0,
    measurementCoverageFrom: from,
    measurementCoverageUntil: to,
    quality: "partial",
    archiveState: "local-only",
    complete: false,
    calculatedAt: to,
  };
}

function summary(consumptionKwh: number, from: string, to: string, costs: HomeEnergyCost[]): HomeEnergySummary {
  return {
    schemaVersion: 3,
    algorithmVersion: "home-energy-summary/v3", tariffRevision: 0,
    houseId: "home",
    from,
    to,
    consumptionKwh,
    pricedConsumptionKwh: null,
    costEur: null,
    totalCostEur: null,
    costBreakdown: null,
    priceCoveragePercent: 0,
    quality: "partial",
    archiveState: "local-only",
    aggregationMode: "independent_sources",
    complete: false,
    sourceCount: costs.length,
    totalSources: costs.length,
    excludedSourceCount: 0,
    failedSourceCount: 0,
    contributions: costs,
    calculatedAt: to,
  };
}

describe("holdSeriesForBuckets", () => {
  const MINUTE = 60_000;
  const base = Date.parse("2026-08-01T00:00:00.000Z");

  it("fills only sample-free buckets and only while the hold lasts", () => {
    const points = [
      { timestamp: base + 1 * MINUTE, value: 100 },
      { timestamp: base + 11 * MINUTE, value: 120 },
      { timestamp: base + 60 * MINUTE, value: 140 },
    ];
    const held = holdSeriesForBuckets(points, 5 * MINUTE, base, base + 90 * MINUTE, 15 * MINUTE);

    // The 00:05 bucket is empty but inside the 15-minute hold of the 00:01
    // sample; buckets past 11 + 15 minutes stay honest gaps until 01:00.
    expect(held).toEqual([
      { timestamp: base + 1 * MINUTE, value: 100 },
      { timestamp: base + 5 * MINUTE, value: 100 },
      { timestamp: base + 11 * MINUTE, value: 120 },
      { timestamp: base + 15 * MINUTE, value: 120 },
      { timestamp: base + 20 * MINUTE, value: 120 },
      { timestamp: base + 25 * MINUTE, value: 120 },
      { timestamp: base + 60 * MINUTE, value: 140 },
      { timestamp: base + 65 * MINUTE, value: 140 },
      { timestamp: base + 70 * MINUTE, value: 140 },
      { timestamp: base + 75 * MINUTE, value: 140 },
    ]);
  });

  it("never fills before the first sample or outside the window", () => {
    const points = [{ timestamp: base + 30 * MINUTE, value: 50 }];
    const held = holdSeriesForBuckets(points, 5 * MINUTE, base + 32 * MINUTE, base + 38 * MINUTE, 15 * MINUTE);

    expect(held).toEqual([
      { timestamp: base + 30 * MINUTE, value: 50 },
      { timestamp: base + 35 * MINUTE, value: 50 },
    ]);
  });

  it("returns an empty copy for an empty series", () => {
    expect(holdSeriesForBuckets([], 5 * MINUTE, base, base + 60 * MINUTE)).toEqual([]);
  });
});

describe("energy analysis", () => {
  it("plots server consumption rather than differencing averaged resetting counters", () => {
    const response = { resolvedRange: { start: "2026-07-01T00:00:00Z", end: "2026-07-01T00:06:00Z" },
      warnings: [{ code: "QUALITY_FILTER_EXCLUDED" }], series: [{ entityId: "plug", measurementId: "energy", resolution: "2m",
        summary: { count: 6 }, points: [100.5, 51, 1.5].map((value, index) => ({
          timestamp: new Date(Date.parse("2026-07-01T00:00:00Z") + index * 120_000).toISOString(),
          value, consumptionKwh: [1, 1, 2][index], sampleCount: 2,
        })) }] } as unknown as AnalyticsQueryResponse;
    const result = consumptionHistorySeries([response], "plug");
    expect(result.points.at(-1)?.value).toBe(4);
    expect(result.partial).toBe(false);
    for (const point of response.series[0]!.points) delete point.consumptionKwh;
    expect(consumptionHistorySeries([response], "plug")).toEqual({ points: [], partial: true });
  });
  it("marks unavailable signed-power holds partial even when the display bucket has no observation", () => {
    const response = { resolvedRange: { start: "2026-07-01T00:00:00Z", end: "2026-07-01T00:15:00Z" },
      warnings: [], series: [{ entityId: "plug", measurementId: "power", resolution: "5m",
        summary: { count: 1 }, points: [
          { timestamp: "2026-07-01T00:00:00Z", consumptionKwh: 0.1, sampleCount: 1 },
          { timestamp: "2026-07-01T00:05:00Z", consumptionKwh: null, sampleCount: 0 },
        ] }] } as unknown as AnalyticsQueryResponse;
    const result = consumptionHistorySeries([response], "plug");
    expect(result.partial).toBe(true);
    expect(result.points.at(-1)?.value).toBe(0.1);
    response.series[0]!.points[0]!.consumptionKwh = null;
    expect(consumptionHistorySeries([response], "plug")).toEqual({ points: [], partial: true });
  });

  it("turns resetting counters into interval consumption and combines their running totals", () => {
    const state = createDemoState();
    state.measurementHistory = {
      plug: { energy: [
        sample("plug", "energy", 10, "2026-07-01T00:00:00.000Z"),
        sample("plug", "energy", 12, "2026-07-01T01:00:00.000Z"),
        sample("plug", "energy", 0.5, "2026-07-01T02:00:00.000Z"),
      ] },
    };
    state.latestMeasurements = {};
    const from = Date.parse("2026-07-01T00:00:00.000Z");
    const to = Date.parse("2026-07-01T02:00:00.000Z");
    const points = electricityUsageSeries(state, "plug", from, to);
    expect(points.at(-1)?.value).toBeCloseTo(2.5);
    const aggregate = aggregateCumulativeSeries([{ sensorId: "plug", points }], 60 * 60_000);
    expect(aggregate.at(-1)?.value).toBeCloseTo(2.5);
    expect(aggregate.map((point) => point.timestamp)).toEqual([from, from + 60 * 60_000, to]);
  });

  it("includes a power-only plug without assuming a reading persists across long gaps", () => {
    const state = createDemoState();
    state.measurementHistory = {
      plug: { power: [
        sample("plug", "power", 1_000, "2026-07-01T00:00:00.000Z"),
        sample("plug", "power", 0, "2026-07-01T01:00:00.000Z"),
      ] },
    };
    state.latestMeasurements = {};
    const points = electricityUsageSeries(
      state,
      "plug",
      Date.parse("2026-07-01T00:00:00.000Z"),
      Date.parse("2026-07-01T01:00:00.000Z"),
    );
    expect(points.at(-1)?.value).toBeCloseTo(0.25);
  });

  it("ranks consumers from the measured summary without chart-history evidence", () => {
    const state = createDemoState();
    const base = state.sensors[0]!;
    const heater: Sensor = { ...base, id: "heater", name: "Water heater" };
    const fridge: Sensor = { ...base, id: "fridge", name: "Fridge" };
    const from = "2026-07-01T00:00:00.000Z";
    const to = "2026-07-11T00:00:00.000Z";
    const insights = buildConsumerInsights(
      summary(15, from, to, [contribution("heater", 10, from, to), contribution("fridge", 5, from, to)]),
      [heater, fridge],
    );
    expect(insights.map((item) => item.sensor.id)).toEqual(["heater", "fridge"]);
    expect(insights[0]?.sharePercent).toBeCloseTo(66.67, 1);
    expect(insights[0]?.consumptionKwh).toBe(10);
    expect(insights[1]?.consumptionKwh).toBe(5);
  });
});
