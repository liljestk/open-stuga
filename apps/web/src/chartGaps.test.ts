import { describe, expect, it } from "vitest";
import { chartGapThresholdMs, detectSeriesGaps, mergeDisplayDataGaps, splitSeriesAtGaps } from "./chartGaps";

describe("chart gap handling", () => {
  it("breaks a line and reports the missing interval instead of interpolating across it", () => {
    const start = Date.parse("2026-07-19T06:00:00Z");
    const points = [
      { timestamp: start, value: 20 },
      { timestamp: start + 5 * 60_000, value: 20.1 },
      { timestamp: start + 8 * 60 * 60_000, value: 19.5 },
      { timestamp: start + 8 * 60 * 60_000 + 5 * 60_000, value: 19.6 },
    ];

    expect(splitSeriesAtGaps(points, chartGapThresholdMs("24h"))).toEqual([
      points.slice(0, 2),
      points.slice(2),
    ]);
    expect(detectSeriesGaps(points, chartGapThresholdMs("24h"))).toEqual([{
      startedAt: points[1]!.timestamp,
      endedAt: points[2]!.timestamp,
      durationMs: points[2]!.timestamp - points[1]!.timestamp,
    }]);
  });

  it("uses progressively wider visible-gap thresholds for long ranges", () => {
    expect(chartGapThresholdMs("30d")).toBe(12 * 60 * 60_000);
    expect(chartGapThresholdMs("90d")).toBe(24 * 60 * 60_000);
    expect(chartGapThresholdMs("1y")).toBe(3 * 24 * 60 * 60_000);
  });

  it("keeps quarter-hour recovery history continuous in the six-hour view", () => {
    const start = Date.parse("2026-07-19T00:00:00Z");
    const end = start + 6 * 60 * 60_000;
    const points = Array.from({ length: 25 }, (_, index) => ({
      timestamp: start + index * 15 * 60_000,
      value: 20 + index / 10,
    }));
    const threshold = chartGapThresholdMs("6h");

    expect(threshold).toBe(15 * 60_000);
    expect(splitSeriesAtGaps(points, threshold)).toEqual([points]);
    expect(detectSeriesGaps(points, threshold, {
      startedAt: start,
      endedAt: end,
    })).toEqual([]);
  });

  it("reports missing time at both boundaries of the selected window", () => {
    const start = Date.parse("2026-07-19T00:00:00Z");
    const end = start + 24 * 60 * 60_000;
    const points = [
      { timestamp: start + 20 * 60 * 60_000 },
      { timestamp: start + 21 * 60 * 60_000 },
    ];

    expect(detectSeriesGaps(points, chartGapThresholdMs("24h"), {
      startedAt: start,
      endedAt: end,
    })).toEqual([
      { startedAt: start, endedAt: points[0]!.timestamp, durationMs: 20 * 60 * 60_000 },
      { startedAt: points[0]!.timestamp, endedAt: points[1]!.timestamp, durationMs: 60 * 60_000 },
      { startedAt: points[1]!.timestamp, endedAt: end, durationMs: 3 * 60 * 60_000 },
    ]);
    expect(detectSeriesGaps([], chartGapThresholdMs("24h"), {
      startedAt: start,
      endedAt: end,
    })).toEqual([{ startedAt: start, endedAt: end, durationMs: end - start }]);
  });

  it("merges overlapping sensor gaps for one chart missing-data region", () => {
    expect(mergeDisplayDataGaps([
      { startedAt: 10, endedAt: 30, durationMs: 20 },
      { startedAt: 20, endedAt: 40, durationMs: 20 },
      { startedAt: 50, endedAt: 60, durationMs: 10 },
    ])).toEqual([
      { startedAt: 10, endedAt: 40, durationMs: 30 },
      { startedAt: 50, endedAt: 60, durationMs: 10 },
    ]);
  });
});
