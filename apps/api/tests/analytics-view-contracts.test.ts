import { describe, expect, it } from "vitest";
import { isAnalyticsDistribution, isAnalyticsViewDefinition } from "@climate-twin/contracts";

describe("analytics evidence boundary guards", () => {
  it("rejects extra definition fields, duplicate sensors, noncanonical dates and invalid ranges", () => {
    const definition = { metric: "temperature", sensorIds: ["sensor-a"], range: { kind: "relative", value: "24h" },
      resolution: "auto", aggregation: "default", qualityPreset: "reliable", weatherObservationsVisible: true, weatherForecastVisible: false };
    expect(isAnalyticsViewDefinition(definition)).toBe(true);
    expect(isAnalyticsViewDefinition({ ...definition, unexpected: true })).toBe(false);
    expect(isAnalyticsViewDefinition({ ...definition, sensorIds: ["sensor-a", "sensor-a"] })).toBe(false);
    expect(isAnalyticsViewDefinition({ ...definition, range: { kind: "absolute", start: "2026-10-01", end: "2026-10-02" } })).toBe(false);
    expect(isAnalyticsViewDefinition({ ...definition, range: { kind: "absolute", start: "2026-10-02T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" } })).toBe(false);
  });
  it("rejects malformed histogram evidence before a client consumes it", () => {
    const distribution = { basis: "display-buckets", weighting: "equal-values", count: 1, excludedCount: 0,
      minimum: 21, maximum: 21, p05: 21, p25: 21, median: 21, p75: 21, p95: 21, bins: [{ lower: 21, upper: 21, count: 1 }] };
    expect(isAnalyticsDistribution(distribution)).toBe(true);
    expect(isAnalyticsDistribution({ ...distribution, bins: [{ lower: 21, upper: 21, count: 4 }] })).toBe(false);
    expect(isAnalyticsDistribution({ ...distribution, median: Infinity })).toBe(false);
    expect(isAnalyticsDistribution({ ...distribution, p25: 22 })).toBe(false);
    expect(isAnalyticsDistribution({ ...distribution, weighting: "elapsed-time" })).toBe(false);
  });
});
