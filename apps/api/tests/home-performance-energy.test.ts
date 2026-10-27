import { describe, expect, it } from "vitest";
import type { AnalyticsPoint, AnalyticsQueryResponse, AnalyticsSeries, Sensor } from "@climate-twin/contracts";
import { sensorEnergyByHour } from "../src/analytics/home-performance/derive-support.js";

const HOUR = 3_600_000;
const START = Date.parse("2026-10-20T00:00:00.000Z");

function point(hour: number, value: number | null, consumptionKwh?: number | null, flags: string[] = []): AnalyticsPoint {
  return {
    timestamp: new Date(START + hour * HOUR).toISOString(),
    value,
    ...(consumptionKwh === undefined ? {} : { consumptionKwh }),
    minimum: value,
    maximum: value,
    sampleCount: 12,
    coverage: 1,
    qualityFlags: flags,
  } as AnalyticsPoint;
}

function response(measurementId: "energy" | "power", points: AnalyticsPoint[]): AnalyticsQueryResponse {
  const series = {
    entityId: "meter", entityLabel: "Meter", measurementId, canonicalUnit: measurementId === "power" ? "W" : "kWh",
    truthClass: "measured", aggregation: measurementId === "power" ? "time_weighted_mean" : "delta", resolution: "1h",
    points, summary: { count: points.length }, provenance: {},
  } as unknown as AnalyticsSeries;
  return { series: [series] } as unknown as AnalyticsQueryResponse;
}

const sensor = { id: "meter", enabled: true, tags: [] } as unknown as Sensor;

describe("home performance energy per hour", () => {
  it("uses the kernel's power integral instead of mean watts times hours", () => {
    // 1,000 W mean but a 15-minute hold limited the measured energy to 0.6 kWh.
    const hours = sensorEnergyByHour(response("power", [point(0, 1_000, 0.6), point(1, 500, 0.5)]), sensor);
    expect(hours.get(START)).toBe(0.6);
    expect(hours.get(START + HOUR)).toBe(0.5);
  });

  it("keeps the energy counted after a meter restart", () => {
    // The delta value drops the post-restart increment; the integral keeps it.
    const hours = sensorEnergyByHour(response("energy", [point(0, 0, 1.2, ["counter_reset"])]), sensor);
    expect(hours.get(START)).toBe(1.2);
  });

  it("falls back to the bucket value only when the integral is missing", () => {
    const power = sensorEnergyByHour(response("power", [point(0, 2_000)]), sensor);
    expect(power.get(START)).toBe(2);
    const energy = sensorEnergyByHour(response("energy", [point(0, 0.8), point(1, 0.3, null, ["counter_reset"])]), sensor);
    expect(energy.get(START)).toBe(0.8);
    expect(energy.has(START + HOUR)).toBe(false);
  });
});
