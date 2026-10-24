import type { TimedValue } from "./energy.js";

/**
 * Mean of the step function through chronologically ordered observations.
 * Each value holds until the next observation and the last until `end`, but
 * never longer than `maxHoldMs`, so a gap does not stretch one reading across
 * hours of missing data. A single observation is its own mean.
 */
export function timeWeightedMean(ordered: readonly TimedValue[], end: number, maxHoldMs: number): number | null {
  if (ordered.length === 0) return null;
  if (ordered.length === 1) return ordered[0]!.value;
  let weighted = 0;
  let duration = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    const next = index + 1 < ordered.length ? ordered[index + 1]!.at : end;
    const seconds = Math.max(0, Math.min(next - current.at, maxHoldMs) / 1_000);
    weighted += current.value * seconds;
    duration += seconds;
  }
  return duration > 0 ? weighted / duration : ordered.at(-1)!.value;
}
