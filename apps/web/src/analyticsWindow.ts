import { timeRangeHours, type TimeRange } from "./domain";

export function explorerWindow(input: { absoluteRange?: { start: string; end: string } | undefined; now: number; range: TimeRange }) {
  return input.absoluteRange ? { from: Date.parse(input.absoluteRange.start), end: Date.parse(input.absoluteRange.end) }
    : { from: input.now - timeRangeHours(input.range) * 3_600_000, end: input.now };
}

/** A selected interval is half-open, including for supplementary live samples. */
export function analyticsPointsInWindow<T extends { timestamp: number }>(points: readonly T[], window: { from: number; to: number }): T[] {
  return points.filter((point) => point.timestamp >= window.from && point.timestamp < window.to);
}
