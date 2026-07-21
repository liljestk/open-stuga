import { describe, expect, it } from "vitest";
import { chartGapThresholdMs, detectSeriesGaps, splitSeriesAtGaps } from "./chartGaps";

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
});
