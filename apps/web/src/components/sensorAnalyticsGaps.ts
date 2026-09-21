import type { SensorDataGap } from "@climate-twin/contracts";
import {
  detectSeriesGaps,
  mergeDisplayDataGaps,
  type DisplayDataGap,
  type TimestampedPoint,
} from "../chartGaps";

type GapStatusKey =
  | "analytics.gapSourceOffline"
  | "analytics.gapRecoveryActive"
  | "analytics.gapRecoveryPartial"
  | "analytics.gapRecoveryRetry"
  | "analytics.gapRecoveryUnavailable"
  | "analytics.gapRecoveryChecking";

interface SensorAnalyticsGapInput {
  observed: Array<{ sensor: { id: string }; points: TimestampedPoint[] }>;
  durable: SensorDataGap[];
  activeSensorIds: string[];
  metric: string;
  from: number;
  to: number;
  thresholdMs: number;
}

export interface SensorAnalyticsGapStatus {
  missingSeriesCount: number;
  missingIntervals: DisplayDataGap[];
  statusKey: GapStatusKey;
}

export function deriveSensorAnalyticsGapStatus(input: SensorAnalyticsGapInput): SensorAnalyticsGapStatus {
  const visible = input.observed.flatMap(({ sensor, points }) => detectSeriesGaps(
    points,
    input.thresholdMs,
    { startedAt: input.from, endedAt: input.to },
  ).map((gap) => ({ ...gap, sensorId: sensor.id })));
  const activeSensorIds = new Set(input.activeSensorIds);
  const durable = input.durable.flatMap((gap) => {
    if (gap.metric !== input.metric || gap.recoveryState === "complete" || !activeSensorIds.has(gap.sensorId)) return [];
    const startedAt = Date.parse(gap.startedAt);
    const endedAt = gap.endedAt ? Date.parse(gap.endedAt) : input.to;
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)
      || endedAt <= input.from || startedAt >= input.to) return [];
    const clippedStart = Math.max(input.from, startedAt);
    const clippedEnd = Math.min(input.to, endedAt);
    // Source-outage records can outlive the outage or be filled by another
    // source. Use them to explain observed holes, never to hide real readings.
    return visible.filter((hole) => hole.sensorId === gap.sensorId
      && hole.startedAt < clippedEnd && hole.endedAt > clippedStart).map((hole) => ({
        ...gap,
        startedAt: Math.max(clippedStart, hole.startedAt),
        endedAt: Math.min(clippedEnd, hole.endedAt),
      }));
  });
  const missingSeriesCount = new Set([
    ...visible.map((gap) => gap.sensorId),
  ]).size;
  const statusKey: GapStatusKey = durable.some((gap) => gap.recoveryState === "open" && gap.endedAt === input.to)
    ? "analytics.gapSourceOffline"
    : durable.some((gap) => gap.recoveryState === "running" || gap.recoveryState === "pending")
      ? "analytics.gapRecoveryActive"
      : durable.some((gap) => gap.recoveryState === "partial")
        ? "analytics.gapRecoveryPartial"
        : durable.some((gap) => gap.recoveryState === "failed")
          ? "analytics.gapRecoveryRetry"
          : durable.some((gap) => gap.recoveryState === "not-supported")
            ? "analytics.gapRecoveryUnavailable"
            : "analytics.gapRecoveryChecking";
  return {
    missingSeriesCount,
    missingIntervals: mergeDisplayDataGaps(visible),
    statusKey,
  };
}
