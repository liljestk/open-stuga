import type { HomeEnergyCost, HomeEnergySummary, MeasurementSample, Sensor } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import { createDemoState } from "../domain";
import {
  aggregateCumulativeSeries,
  buildConsumerInsights,
  buildEnergyProjection,
  electricityUsageSeries,
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
    schemaVersion: 2,
    algorithmVersion: "home-energy-summary/v2",
    houseId: "home",
    from,
    to,
    consumptionKwh,
    pricedConsumptionKwh: null,
    costEur: null,
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

describe("energy analysis", () => {
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

  it("projects with a weighted recent/trailing pace and an uncertainty range", () => {
    const rollingFrom = "2026-07-01T00:00:00.000Z";
    const recentFrom = "2026-07-10T00:00:00.000Z";
    const to = "2026-07-11T00:00:00.000Z";
    const rolling = summary(30, rollingFrom, to, [contribution("plug", 30, rollingFrom, to)]);
    const recent = summary(2, recentFrom, to, [contribution("plug", 2, recentFrom, to)]);
    const projection = buildEnergyProjection(recent, rolling, 0.2)!;
    expect(projection.next30DaysKwh).toBeGreaterThan(60);
    expect(projection.next30DaysKwh).toBeLessThan(90);
    expect(projection.lowKwh).toBeLessThan(projection.next30DaysKwh);
    expect(projection.highKwh).toBeGreaterThan(projection.next30DaysKwh);
    expect(projection.estimatedCostEur).toBeCloseTo(projection.next30DaysKwh * 0.2);
    expect(projection.confidence).toBe("medium");
  });

  it("does not treat sparse historical prices as representative of the projection", () => {
    const from = "2026-07-01T00:00:00.000Z";
    const to = "2026-07-11T00:00:00.000Z";
    const rolling = {
      ...summary(30, from, to, [contribution("plug", 30, from, to)]),
      pricedConsumptionKwh: 1,
      costEur: 1,
      priceCoveragePercent: 3.3,
    };
    const projection = buildEnergyProjection(null, rolling, 0.2)!;
    expect(projection.priceBasis).toBe("current");
    expect(projection.estimatedCostEur).toBeCloseTo(projection.next30DaysKwh * 0.2);
  });

  it("orders projected cost bounds correctly when electricity prices are negative", () => {
    const from = "2026-07-01T00:00:00.000Z";
    const to = "2026-07-11T00:00:00.000Z";
    const rolling = summary(30, from, to, [contribution("plug", 30, from, to)]);
    const projection = buildEnergyProjection(null, rolling, -0.1)!;
    expect(projection.estimatedCostEur).toBeLessThan(0);
    expect(projection.lowCostEur).toBeLessThan(projection.estimatedCostEur!);
    expect(projection.highCostEur).toBeGreaterThan(projection.estimatedCostEur!);
  });

  it("keeps confidence low when a selected source is missing from the projection", () => {
    const from = "2026-07-01T00:00:00.000Z";
    const to = "2026-07-21T00:00:00.000Z";
    const partial = {
      ...summary(30, from, to, [contribution("plug", 30, from, to)]),
      totalSources: 2,
      sourceCount: 1,
      failedSourceCount: 1,
    };
    expect(buildEnergyProjection(null, partial, 0.2)?.confidence).toBe("low");
  });

  it("ranks cumulative consumers and separates short peaks from cycling loads", () => {
    const state = createDemoState();
    const base = state.sensors[0]!;
    const heater: Sensor = { ...base, id: "heater", name: "Water heater" };
    const fridge: Sensor = { ...base, id: "fridge", name: "Fridge" };
    state.measurementHistory = {
      heater: { power: [
        sample("heater", "power", 0, "2026-07-10T00:00:00.000Z"),
        sample("heater", "power", 2_000, "2026-07-10T00:30:00.000Z"),
        sample("heater", "power", 0, "2026-07-10T00:35:00.000Z"),
        sample("heater", "power", 0, "2026-07-10T01:00:00.000Z"),
      ] },
      fridge: { power: [
        sample("fridge", "power", 90, "2026-07-10T00:00:00.000Z"),
        sample("fridge", "power", 0, "2026-07-10T00:15:00.000Z"),
        sample("fridge", "power", 90, "2026-07-10T00:30:00.000Z"),
        sample("fridge", "power", 0, "2026-07-10T00:45:00.000Z"),
      ] },
    };
    state.latestMeasurements = {};
    const from = "2026-07-01T00:00:00.000Z";
    const to = "2026-07-11T00:00:00.000Z";
    const insights = buildConsumerInsights(
      summary(15, from, to, [contribution("heater", 10, from, to), contribution("fridge", 5, from, to)]),
      [heater, fridge],
      state,
    );
    expect(insights.map((item) => item.sensor.id)).toEqual(["heater", "fridge"]);
    expect(insights[0]?.sharePercent).toBeCloseTo(66.67, 1);
    expect(insights[0]?.pattern).toBe("short_peaks");
    expect(insights[1]?.pattern).toBe("cycling");
  });
});
