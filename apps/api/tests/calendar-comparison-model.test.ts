import type { AnalyticsSeries } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import {
  appendAnalyticsSeries,
  calendarAccumulatorValue,
  calendarComparisonBuckets,
  calendarComparisonPeriods,
  comparisonAggregationOptions,
  createCalendarValueAccumulator,
  splitCalendarAnalyticsRange,
} from "../src/analytics/calendar-comparison/model.js";

const anchor = { month: 10, day: 15, week: 42 };

function series(
  aggregation: AnalyticsSeries["aggregation"],
  resolution: AnalyticsSeries["resolution"],
  points: AnalyticsSeries["points"],
): AnalyticsSeries {
  return {
    entityId: "sensor-a",
    entityLabel: "Sensor A",
    measurementId: "temperature",
    canonicalUnit: "°C",
    truthClass: "derived",
    aggregation,
    resolution,
    points,
    summary: {
      entityId: "sensor-a", measurementId: "temperature", canonicalUnit: "°C",
      count: 0, coverage: 0, minimum: null, maximum: null, mean: null, median: null,
      standardDeviation: null, medianAbsoluteDeviation: null, p05: null, p95: null,
    },
    provenance: {
      algorithmKey: "test", algorithmVersion: "1", generatedAt: "2026-01-01T00:00:00.000Z",
      inputStart: "2026-01-01T00:00:00.000Z", inputEnd: "2026-01-02T00:00:00.000Z",
      sourceIds: ["sensor-a"], archiveState: "not-configured",
    },
  };
}

describe("calendarComparisonPeriods", () => {
  it("returns every recorded October using house-local boundaries across DST", () => {
    const periods = calendarComparisonPeriods({
      unit: "month",
      anchor,
      coverageStart: "2022-10-10T00:00:00.000Z",
      coverageEnd: "2024-10-20T00:00:00.000Z",
      timeZone: "Europe/Helsinki",
      now: Date.parse("2025-01-01T00:00:00.000Z"),
    });

    expect(periods.map((period) => period.key)).toEqual(["2022-10", "2023-10", "2024-10"]);
    expect(periods[0]).toMatchObject({
      start: "2022-09-30T21:00:00.000Z",
      end: "2022-10-31T22:00:00.000Z",
      partial: false,
    });
  });

  it("skips invalid leap days and ISO week 53 in years that do not have one", () => {
    const leapDays = calendarComparisonPeriods({
      unit: "day", anchor: { ...anchor, month: 2, day: 29 },
      coverageStart: "2019-01-01T00:00:00.000Z", coverageEnd: "2024-12-31T00:00:00.000Z",
      timeZone: "UTC", now: Date.parse("2025-01-01T00:00:00.000Z"),
    });
    const week53 = calendarComparisonPeriods({
      unit: "week", anchor: { ...anchor, week: 53 },
      coverageStart: "2019-01-01T00:00:00.000Z", coverageEnd: "2026-12-31T00:00:00.000Z",
      timeZone: "UTC", now: Date.parse("2027-01-10T00:00:00.000Z"),
    });

    expect(leapDays.map((period) => period.key)).toEqual(["2020-02-29", "2024-02-29"]);
    expect(week53.map((period) => period.key)).toEqual(["2020-W53", "2026-W53"]);
  });

  it("groups history into house-local calendar decades", () => {
    const periods = calendarComparisonPeriods({
      unit: "decade", anchor,
      coverageStart: "1998-06-01T00:00:00.000Z", coverageEnd: "2026-07-01T00:00:00.000Z",
      timeZone: "Europe/Helsinki", now: Date.parse("2026-07-21T12:00:00.000Z"),
    });

    expect(periods.map((period) => period.key)).toEqual(["1990s", "2000s", "2010s", "2020s"]);
    expect(periods[1]).toMatchObject({ start: "1999-12-31T22:00:00.000Z", end: "2009-12-31T22:00:00.000Z" });
    expect(periods.at(-1)?.partial).toBe(true);
  });

  it("breaks matching ISO weeks into Monday-through-Sunday local buckets", () => {
    const periods = calendarComparisonPeriods({
      unit: "week",
      anchor: { ...anchor, week: 6 },
      coverageStart: "2026-01-01T00:00:00.000Z",
      coverageEnd: "2027-12-31T00:00:00.000Z",
      timeZone: "Europe/Helsinki",
      now: Date.parse("2028-01-01T00:00:00.000Z"),
    });

    expect(periods.map((period) => period.key)).toEqual(["2026-W06", "2027-W06"]);
    const buckets = calendarComparisonBuckets(periods[0]!, "Europe/Helsinki");
    expect(buckets).toHaveLength(7);
    expect(buckets.map((bucket) => bucket.slot)).toEqual([
      "day-0", "day-1", "day-2", "day-3", "day-4", "day-5", "day-6",
    ]);
    expect(buckets[0]).toMatchObject({
      start: "2026-02-01T22:00:00.000Z",
      end: "2026-02-02T22:00:00.000Z",
    });
  });

  it("uses stable seven-day blocks inside a month and calendar months inside a year", () => {
    const month = calendarComparisonPeriods({
      unit: "month",
      anchor: { ...anchor, month: 10 },
      coverageStart: "2024-01-01T00:00:00.000Z",
      coverageEnd: "2024-12-31T00:00:00.000Z",
      timeZone: "Europe/Helsinki",
      now: Date.parse("2025-01-01T00:00:00.000Z"),
    })[0]!;
    const years = calendarComparisonPeriods({
      unit: "year",
      anchor,
      coverageStart: "2025-01-01T00:00:00.000Z",
      coverageEnd: "2026-12-31T00:00:00.000Z",
      timeZone: "Europe/Helsinki",
      now: Date.parse("2027-01-01T00:00:00.000Z"),
    });

    const monthBuckets = calendarComparisonBuckets(month, "Europe/Helsinki");
    expect(monthBuckets).toHaveLength(5);
    expect(monthBuckets.map((bucket) => bucket.slot)).toEqual([
      "week-0", "week-1", "week-2", "week-3", "week-4",
    ]);
    expect(monthBuckets.at(-1)).toMatchObject({
      start: "2024-10-28T22:00:00.000Z",
      end: "2024-10-31T22:00:00.000Z",
    });
    expect(years.map((period) => period.key)).toEqual(["2025", "2026"]);
    expect(years.every((period) => calendarComparisonBuckets(period, "Europe/Helsinki").length === 12)).toBe(true);
  });

  it("represents 23- and 25-hour local days without inventing or dropping an instant", () => {
    const spring = calendarComparisonPeriods({
      unit: "day",
      anchor: { ...anchor, month: 3, day: 29 },
      coverageStart: "2026-03-01T00:00:00.000Z",
      coverageEnd: "2026-04-01T00:00:00.000Z",
      timeZone: "Europe/Helsinki",
      now: Date.parse("2027-01-01T00:00:00.000Z"),
    })[0]!;
    const autumn = calendarComparisonPeriods({
      unit: "day",
      anchor: { ...anchor, month: 10, day: 25 },
      coverageStart: "2026-10-01T00:00:00.000Z",
      coverageEnd: "2026-11-01T00:00:00.000Z",
      timeZone: "Europe/Helsinki",
      now: Date.parse("2027-01-01T00:00:00.000Z"),
    })[0]!;

    expect(calendarComparisonBuckets(spring, "Europe/Helsinki")).toHaveLength(23);
    const autumnBuckets = calendarComparisonBuckets(autumn, "Europe/Helsinki");
    expect(autumnBuckets).toHaveLength(25);
    expect(autumnBuckets.some((bucket) => bucket.slot.endsWith("-1"))).toBe(true);
  });
});

describe("calendar comparison aggregation", () => {
  it("weights mean values by covered duration and preserves quality metadata", () => {
    const accumulator = createCalendarValueAccumulator("mean");
    appendAnalyticsSeries(accumulator, series("mean", "1h", [
      { timestamp: "2026-01-01T00:00:00.000Z", value: 10, minimum: 9, maximum: 11, sampleCount: 2, coverage: 1, qualityFlags: [] },
      { timestamp: "2026-01-01T01:00:00.000Z", value: 20, minimum: 18, maximum: 22, sampleCount: 1, coverage: 0.5, qualityFlags: ["low_coverage"] },
    ]));

    expect(calendarAccumulatorValue(accumulator)).toEqual({
      value: 40 / 3,
      minimum: 9,
      maximum: 22,
      sampleCount: 3,
      coverage: 0.75,
    });
  });

  it("splits retry ranges on the API's UTC bucket boundary with one context bucket", () => {
    const split = splitCalendarAnalyticsRange(
      "2026-03-31T21:00:00.000Z",
      "2026-04-30T21:00:00.000Z",
      1_000,
    );

    expect(split).not.toBeNull();
    expect(split?.bucketMilliseconds).toBe(3_600_000);
    expect(Date.parse(split!.middle) % split!.bucketMilliseconds).toBe(0);
    expect(Date.parse(split!.middle) - Date.parse(split!.overlapStart)).toBe(split!.bucketMilliseconds);
  });

  it("adds sum buckets across split calendar segments and exposes valid choices by measurement kind", () => {
    const accumulator = createCalendarValueAccumulator("sum");
    appendAnalyticsSeries(accumulator, series("sum", "1d", [
      { timestamp: "2026-01-01T00:00:00.000Z", value: 2, minimum: 2, maximum: 2, sampleCount: 1, coverage: 1, qualityFlags: [] },
    ]));
    appendAnalyticsSeries(accumulator, series("sum", "1d", [
      { timestamp: "2026-01-02T00:00:00.000Z", value: 3, minimum: 3, maximum: 3, sampleCount: 1, coverage: 1, qualityFlags: [] },
    ]));

    expect(calendarAccumulatorValue(accumulator)?.value).toBe(5);
    expect(comparisonAggregationOptions("cumulative_counter")).toContain("delta");
    expect(comparisonAggregationOptions("rate")).not.toContain("sum");
  });

  it("normalizes coverage for a range that clips a UTC bucket boundary", () => {
    const accumulator = createCalendarValueAccumulator("mean");
    appendAnalyticsSeries(accumulator, series("mean", "1h", [
      { timestamp: "2026-01-01T00:00:00.000Z", value: 12, minimum: 12, maximum: 12, sampleCount: 30, coverage: 0.5, qualityFlags: ["low_coverage"] },
    ]), {
      start: "2026-01-01T00:30:00.000Z",
      end: "2026-01-01T01:00:00.000Z",
    });

    expect(calendarAccumulatorValue(accumulator)).toMatchObject({ value: 12, coverage: 1 });
  });
});
