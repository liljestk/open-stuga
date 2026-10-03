import { describe, expect, it, vi } from "vitest";
import { RollupsMaterializingError } from "../src/timeseries/read-support.js";
import { FakePool, FROM, TO, queryResult, storeFor } from "./timeseries-store-test-support.js";

describe("TimeseriesStore power-cost aggregation", () => {
  it("integrates power with a bounded hold against persisted price intervals", async () => {
    const pool = new FakePool(({ text }) => {
      if (text.includes("ORDER BY bucket_seconds DESC, day_start")) return queryResult([
        { day_start: new Date("2026-07-16T00:00:00.000Z"), bucket_seconds: 3_600 },
        { day_start: new Date("2026-07-17T00:00:00.000Z"), bucket_seconds: 900 },
        { day_start: new Date("2026-07-17T00:00:00.000Z"), bucket_seconds: 60 },
      ]);
      return text.includes("rollup.metric = $6::TEXT") ? queryResult([{
        coverage_complete: true,
        delta_count: "4",
        consumption_kwh: 1.5,
        priced_consumption_kwh: 1.5,
        cost_eur: 0.25,
        total_duration_ms: 3_600_000,
        priced_duration_ms: 3_600_000,
        maximum_interval_duration_ms: 900_000,
        coverage_from: new Date(FROM),
        coverage_until: new Date(TO),
      }]) : queryResult();
    });
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
      maximumIntervalDurationMs: 900_000,
      coverageFrom: FROM,
      coverageUntil: TO,
    });
    const query = pool.queries.find(({ text }) => text.includes("rollup.metric = $6::TEXT"))!;
    expect(query.values).toEqual(["plug-1", FROM, TO, "property-1", true, "power"]);
    expect(query.text).not.toContain("metric = 'power'");
    expect(query.text).toContain("source NOT IN ('mock', 'replay')");
    expect(query.text).toContain("SELECT DISTINCT ON (starts_at)");
    expect(query.text).toContain("latest_prices_raw");
    expect(query.text).toContain("ends_at + INTERVAL '1 second'");
    expect(query.text).toContain("previous_last_at + INTERVAL '15 minutes'");
    expect(query.text).toContain("measurement_ordered_rollups");
    expect(query.text).toContain("kwh_per_ms * window_duration_ms");
    expect(query.text).toContain("raw_ranges");
    expect(query.text).toContain("hour_units");
    expect(query.text).toContain("quarter_units");
    expect(query.text).toContain("minute_units");
    expect(query.text).toContain("price_hour_slices");
    expect(query.text).toContain("segment_hours");
    expect(query.text).toContain("JOIN price_hour_slices price USING (hour_start)");
    expect(query.text).toContain("priced_units AS MATERIALIZED");
    expect(query.text).toContain("unit.unit_start + make_interval");
    expect(query.text).toContain("dirty.day_start = unit.day_start");
    expect(query.text).toContain("generation.day_start = unit.day_start");
    expect(query.text).toContain("sample.observed_at < $2::TIMESTAMPTZ");
    expect(query.text).not.toContain("price_slices");
    const enqueues = pool.queries.filter(({ text }) => text.includes("measurement_ordered_rollup_dirty")
      && text.includes("INSERT INTO"));
    expect(enqueues.map(({ values }) => values.slice(5))).toEqual([
      [3_600, ["2026-07-16T00:00:00.000Z"]],
      [900, ["2026-07-17T00:00:00.000Z"]],
      [60, ["2026-07-17T00:00:00.000Z"]],
    ]);
  });

  it("reserves pool capacity by admitting at most two cost-state requests", async () => {
    let activeRequirements = 0;
    let maximumActiveRequirements = 0;
    const releaseRequirements: Array<() => void> = [];
    const pool = new FakePool(async ({ text }) => {
      if (text.includes("ORDER BY bucket_seconds DESC, day_start")) {
        activeRequirements += 1;
        maximumActiveRequirements = Math.max(maximumActiveRequirements, activeRequirements);
        await new Promise<void>((resolve) => releaseRequirements.push(resolve));
        activeRequirements -= 1;
        return queryResult();
      }
      if (text.includes("coverage_complete")) {
        return queryResult([{
          coverage_complete: true,
          delta_count: "1",
          consumption_kwh: 0.1,
          priced_consumption_kwh: 0.1,
          cost_eur: 0.02,
          total_duration_ms: 3_600_000,
          priced_duration_ms: 3_600_000,
          maximum_interval_duration_ms: 60_000,
          coverage_from: new Date(FROM),
          coverage_until: new Date(TO),
        }]);
      }
      return queryResult();
    });
    const store = storeFor(pool);
    const request = (sensorId: string) => store.powerCostAggregate({
      sensorId,
      propertyId: "property-1",
      from: FROM,
      to: TO,
    });
    const pending = [request("plug-1"), request("plug-2"), request("plug-3")];

    await vi.waitFor(() => expect(releaseRequirements).toHaveLength(2));
    expect(maximumActiveRequirements).toBe(2);
    releaseRequirements[0]!();
    releaseRequirements[1]!();
    await vi.waitFor(() => expect(releaseRequirements).toHaveLength(3));
    releaseRequirements[2]!();

    await expect(Promise.all(pending)).resolves.toHaveLength(3);
    expect(maximumActiveRequirements).toBe(2);
  });

  it("queues known unfinished days without starting the full price calculation", async () => {
    const pool = new FakePool(({ text }) => text.includes("ORDER BY bucket_seconds DESC, day_start")
      ? queryResult([{ day_start: new Date(FROM), bucket_seconds: 3_600, ready: false }])
      : queryResult());
    await expect(storeFor(pool).energyCostAggregate({
      sensorId: "meter-1", propertyId: "property-1", from: FROM, to: TO,
    })).rejects.toBeInstanceOf(RollupsMaterializingError);
    expect(pool.queries.some(({ text }) => text.includes("INSERT INTO")
      && text.includes("measurement_ordered_rollup_dirty"))).toBe(true);
    expect(pool.queries.some(({ text }) => text.includes("priced_units AS MATERIALIZED"))).toBe(false);
  });

  it("surfaces incomplete rollup coverage as the typed materializing error", async () => {
    const pool = new FakePool(({ text }) => (
      text.includes("rollup.metric = $6::TEXT")
        ? queryResult([{
          coverage_complete: false,
          delta_count: "0",
          consumption_kwh: 0,
          priced_consumption_kwh: 0,
          cost_eur: 0,
          total_duration_ms: 0,
          priced_duration_ms: 0,
          maximum_interval_duration_ms: 0,
          coverage_from: null,
          coverage_until: null,
        }])
        : queryResult()
    ));
    const store = storeFor(pool);

    await expect(store.energyCostAggregate({
      sensorId: "meter-1",
      propertyId: "property-1",
      from: FROM,
      to: TO,
    })).rejects.toBeInstanceOf(RollupsMaterializingError);
  });
});
