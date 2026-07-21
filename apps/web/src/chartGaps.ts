import type { TimeRange } from "./domain";

export interface TimestampedPoint {
  timestamp: number;
}

export interface DisplayDataGap {
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

/** Minimum missing interval that should be visible at each chart scale. */
export function chartGapThresholdMs(range: TimeRange): number {
  if (range === "6h") return 10 * 60_000;
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
): DisplayDataGap[] {
  const gaps: DisplayDataGap[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current) continue;
    const durationMs = current.timestamp - previous.timestamp;
    if (durationMs > thresholdMs) gaps.push({
      startedAt: previous.timestamp,
      endedAt: current.timestamp,
      durationMs,
    });
  }
  return gaps;
}
