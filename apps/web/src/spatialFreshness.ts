import type { MeasurementSample } from "@climate-twin/contracts";

export const DEFAULT_SPATIAL_MAX_SAMPLE_AGE_MS = 15 * 60_000;
export const DEFAULT_SPATIAL_REPLAY_MAX_SAMPLE_AGE_MS = 90 * 60_000;
export const DEFAULT_SPATIAL_FUTURE_TOLERANCE_MS = 30_000;

export interface SpatialFreshnessOptions {
  referenceTimeMs: number;
  maxSampleAgeMs: number;
  futureToleranceMs?: number;
}

function positiveFinite(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function configuredSpatialMaxSampleAgeMs(): number {
  return positiveFinite(import.meta.env.VITE_SPATIAL_MAX_SAMPLE_AGE_MS)
    ?? DEFAULT_SPATIAL_MAX_SAMPLE_AGE_MS;
}

export function configuredSpatialReplayMaxSampleAgeMs(): number {
  return positiveFinite(import.meta.env.VITE_SPATIAL_REPLAY_MAX_SAMPLE_AGE_MS)
    ?? DEFAULT_SPATIAL_REPLAY_MAX_SAMPLE_AGE_MS;
}

export function isSpatialSampleFresh(
  sample: MeasurementSample | undefined,
  options: SpatialFreshnessOptions,
): boolean {
  if (!sample || sample.quality === "stale") return false;
  const timestampMs = Date.parse(sample.timestamp);
  if (!Number.isFinite(timestampMs) || !Number.isFinite(options.referenceTimeMs)) return false;
  const tolerance = Math.max(0, options.futureToleranceMs ?? DEFAULT_SPATIAL_FUTURE_TOLERANCE_MS);
  const maximumAge = Math.max(0, options.maxSampleAgeMs);
  return timestampMs <= options.referenceTimeMs + tolerance
    && options.referenceTimeMs - timestampMs <= maximumAge;
}
