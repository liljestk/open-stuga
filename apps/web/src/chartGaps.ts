import type { TimeRange } from "./domain";

export interface TimestampedPoint {
  timestamp: number;
}

export interface DisplayDataGap {
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

export interface GapDetectionWindow {
  startedAt: number;
  endedAt: number;
}

/** Minimum missing interval that should be visible at each chart scale. */
export function chartGapThresholdMs(range: TimeRange): number {
  if (range === "6h") return 15 * 60_000;
  if (range === "24h") return 30 * 60_000;
  if (range === "7d") return 3 * 60 * 60_000;
  if (range === "30d") return 12 * 60 * 60_000;
  if (range === "90d") return 24 * 60 * 60_000;
  return 3 * 24 * 60 * 60_000;
}

export function splitSeriesAtGaps<T extends TimestampedPoint>(
  points: readonly T[],
  thresholdMs: number,
): T[][] {
  const segments: T[][] = [];
  for (const point of points) {
    const segment = segments.at(-1);
    const previous = segment?.at(-1);
    if (!segment || (previous && point.timestamp - previous.timestamp > thresholdMs)) {
      segments.push([point]);
    } else {
      segment.push(point);
    }
  }
  return segments;
}

export function detectSeriesGaps<T extends TimestampedPoint>(
  points: readonly T[],
  thresholdMs: number,
  window?: GapDetectionWindow,
): DisplayDataGap[] {
  const gaps: DisplayDataGap[] = [];
  const visiblePoints = window
    ? points.filter((point) => point.timestamp >= window.startedAt && point.timestamp <= window.endedAt)
    : points;
  const addGap = (startedAt: number, endedAt: number): void => {
    const durationMs = endedAt - startedAt;
    if (durationMs > thresholdMs) gaps.push({ startedAt, endedAt, durationMs });
  };
  if (window) {
    const first = visiblePoints[0];
    if (first) addGap(window.startedAt, first.timestamp);
    else addGap(window.startedAt, window.endedAt);
  }
  for (let index = 1; index < visiblePoints.length; index += 1) {
    const previous = visiblePoints[index - 1];
    const current = visiblePoints[index];
    if (!previous || !current) continue;
    addGap(previous.timestamp, current.timestamp);
  }
  if (window && visiblePoints.length > 0) addGap(visiblePoints.at(-1)!.timestamp, window.endedAt);
  return gaps;
}

export function mergeDisplayDataGaps(gaps: readonly DisplayDataGap[]): DisplayDataGap[] {
  const merged: DisplayDataGap[] = [];
  for (const gap of [...gaps].sort((left, right) => left.startedAt - right.startedAt || left.endedAt - right.endedAt)) {
    const previous = merged.at(-1);
    if (!previous || gap.startedAt > previous.endedAt) {
      merged.push({ ...gap });
      continue;
    }
    previous.endedAt = Math.max(previous.endedAt, gap.endedAt);
    previous.durationMs = previous.endedAt - previous.startedAt;
  }
  return merged;
}
