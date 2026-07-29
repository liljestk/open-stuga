import type { CalendarComparisonResponse } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import { calendarPeriodSeries } from "./calendarComparisonView";

const period = {
  key: "2025-10",
  unit: "month" as const,
  start: "2025-09-30T21:00:00.000Z",
  end: "2025-10-31T22:00:00.000Z",
  naturalEnd: "2025-10-31T22:00:00.000Z",
  year: 2025,
  month: 10,
  day: null,
  week: null,
  decade: null,
  partial: false,
};

const response: CalendarComparisonResponse = {
  apiVersion: "1.0",
  requestId: "test",
  houseId: "house",
  dataMode: "demo",
  measurementId: "temperature",
  unit: "month",
  anchor: { month: 10, day: 15, week: 42 },
  aggregation: "default",
  qualityFilter: { include: ["good"] },
  candidates: [period],
  selectedPeriods: [period],
  series: [{
    id: "2025-10:combined",
    sourceId: "combined",
    sourceLabel: "Combined sensors",
    combination: "mean",
    period,
    aggregation: "mean",
    points: [{
      bucket: {
        key: "2025-10:week-1",
        slot: "week-1",
        order: 1,
        index: 0,
        start: period.start,
        end: "2025-10-07T21:00:00.000Z",
        partial: false,
      },
      value: 21,
      minimum: 20,
      maximum: 22,
      sampleCount: 12,
      coverage: 1,
    }],
    summary: {
      value: 21,
      minimum: 20,
      maximum: 22,
      sampleCount: 12,
      coverage: 1,
      bucketCount: 1,
    },
  }],
  comparisons: [],
  archiveState: "not-configured",
  generatedAt: "2026-07-29T00:00:00.000Z",
  evaluatedAt: "2026-07-29T00:00:00.000Z",
  completeness: "complete",
  warnings: [],
  provenance: {
    algorithmKey: "calendar-comparison",
    algorithmVersion: "calendar-comparison-v1.0.0",
    evaluatedAt: "2026-07-29T00:00:00.000Z",
    sourceIds: ["sensor-a", "sensor-b"],
    archiveState: "not-configured",
  },
};

describe("calendar comparison view adapter", () => {
  it("selects server-derived series without recomputing their values or summaries", () => {
    const series = calendarPeriodSeries(response, "combined");

    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      id: "2025-10:combined",
      summary: response.series[0]!.summary,
      points: [{
        value: 21,
        period,
        aggregation: "mean",
      }],
    });
    expect(calendarPeriodSeries(response, "sensor-a")).toEqual([]);
  });
});
