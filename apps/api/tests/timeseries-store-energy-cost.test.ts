import { describe, expect, it } from "vitest";
import { FakePool, FROM, TO, queryResult, storeFor } from "./timeseries-store-test-support.js";

describe("TimeseriesStore power-cost aggregation", () => {
  it("integrates power with a bounded hold against persisted price intervals", async () => {
    const pool = new FakePool(({ text }) => text.includes("metric = 'power'")
      ? queryResult([{
        delta_count: "4",
        consumption_kwh: 1.5,
        priced_consumption_kwh: 1.5,
        cost_eur: 0.25,
        total_duration_ms: 3_600_000,
        priced_duration_ms: 3_600_000,
        coverage_from: new Date(FROM),
        coverage_until: new Date(TO),
      }])
      : queryResult());
    const store = storeFor(pool);

    await expect(store.powerCostAggregate({
      sensorId: "plug-1",
      propertyId: "property-1",
      from: FROM,
      to: TO,
      excludeSynthetic: true,
    })).resolves.toEqual({
      deltaCount: 4,
      consumptionKwh: 1.5,
      pricedConsumptionKwh: 1.5,
      costEur: 0.25,
      totalDurationMs: 3_600_000,
      pricedDurationMs: 3_600_000,
      coverageFrom: FROM,
      coverageUntil: TO,
    });
    const query = pool.queries.find(({ text }) => text.includes("metric = 'power'"))!;
    expect(query.values).toEqual(["plug-1", FROM, TO, "property-1", true]);
    expect(query.text).toContain("source NOT IN ('mock', 'replay')");
    expect(query.text).toContain("SELECT DISTINCT ON (starts_at)");
    expect(query.text).toContain("sample_at + INTERVAL '15 minutes'");
    expect(query.text).toContain("window_energy_kwh * overlap_ms / window_duration_ms");
  });
});
