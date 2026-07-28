import type { AnalyticsSeries } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import {
  appendAnalyticsSeries,
  createCalendarValueAccumulator,
  type CalendarComparisonBucket,
  type CalendarComparisonPeriod,
  type CalendarValueAccumulator,
} from "./calendarComparison";
import {
  calendarPeriodSeries,
  commonCompletedCalendarSlots,
  summarizeCalendarSeries,
  type LoadedCalendarComparison,
} from "./calendarComparisonView";
import { createDemoState } from "./domain";

function period(key: string, year: number): CalendarComparisonPeriod {
  return {
    key,
    unit: "week",
    start: `${year}-02-02T00:00:00.000Z`,
    end: `${year}-02-09T00:00:00.000Z`,
    naturalEnd: `${year}-02-09T00:00:00.000Z`,
    year,
    month: null,
    day: null,
    week: 6,
    decade: null,
    partial: false,
  };
}

function bucket(owner: CalendarComparisonPeriod, index: number): CalendarComparisonBucket {
  const start = Date.parse(owner.start) + index * 86_400_000;
  return {
    key: `${owner.key}:day-${index}`,
    slot: `day-${index}`,
    order: index,
    index,
    start: new Date(start).toISOString(),
    end: new Date(start + 86_400_000).toISOString(),
    partial: false,
  };
}

function accumulator(sensorId: string, timestamp: string, value: number): CalendarValueAccumulator {
  const result = createCalendarValueAccumulator("mean");
  const series: AnalyticsSeries = {
    entityId: sensorId,
    entityLabel: sensorId,
    measurementId: "temperature",
    canonicalUnit: "°C",
    truthClass: "derived",
    aggregation: "mean",
    resolution: "1h",
    points: [{ timestamp, value, minimum: value, maximum: value, sampleCount: 60, coverage: 1, qualityFlags: [] }],
    summary: {
      entityId: sensorId,
      measurementId: "temperature",
      canonicalUnit: "°C",
      count: 60,
      coverage: 1,
      minimum: value,
      maximum: value,
      mean: value,
      median: value,
      standardDeviation: 0,
      medianAbsoluteDeviation: 0,
      p05: value,
      p95: value,
    },
    provenance: {
      algorithmKey: "test",
      algorithmVersion: "1",
      generatedAt: timestamp,
      inputStart: timestamp,
      inputEnd: timestamp,
      sourceIds: [sensorId],
      archiveState: "not-configured",
    },
  };
  return appendAnalyticsSeries(result, series);
}

describe("calendar comparison view model", () => {
  it("keeps an identical sensor cohort and summarizes only common completed buckets", () => {
    const state = createDemoState();
    const sensors = state.sensors.filter((sensor) => sensor.enabled).slice(0, 2);
    const definition = state.measurementDefinitions.find((item) => item.id === "temperature")!;
    const first = period("2026-W06", 2026);
    const second = period("2027-W06", 2027);
    const firstBuckets = [bucket(first, 0), bucket(first, 1)];
    const secondBuckets = [bucket(second, 0), bucket(second, 1)];
    const values = new Map([
      [first.key, new Map(firstBuckets.map((item, bucketIndex) => [
        item.key,
        new Map(sensors.map((sensor, sensorIndex) => [
          sensor.id,
          accumulator(sensor.id, item.start, 10 + bucketIndex * 2 + sensorIndex),
        ])),
      ]))],
      [second.key, new Map([
        [secondBuckets[0]!.key, new Map(sensors.map((sensor, sensorIndex) => [
          sensor.id,
          accumulator(sensor.id, secondBuckets[0]!.start, 8 + sensorIndex),
        ]))],
        [secondBuckets[1]!.key, new Map([[
          sensors[0]!.id,
          accumulator(sensors[0]!.id, secondBuckets[1]!.start, 9),
        ]])],
      ])],
    ]);
    const loaded: LoadedCalendarComparison = {
      periods: [first, second],
      buckets: new Map([[first.key, firstBuckets], [second.key, secondBuckets]]),
      values,
      complete: true,
      archiveState: "not-configured",
    };

    const series = calendarPeriodSeries(loaded, sensors, "combined", definition);
    expect(series.map((item) => item.points.length)).toEqual([2, 1]);
    const common = commonCompletedCalendarSlots(series);
    expect([...common]).toEqual(["day-0"]);
    expect(summarizeCalendarSeries(series[0]!, common)?.value).toBe(10.5);
    expect(summarizeCalendarSeries(series[1]!, common)?.value).toBe(8.5);
  });
});
