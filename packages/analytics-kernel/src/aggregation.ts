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

/**
 * The time-weighted mean the archive forms from stored states `stateMs` wide.
 * Inside one state a value holds until the next observation, as the state
 * itself records it; across a state boundary, and from the last observation
 * to `end`, it holds for at most `maxHoldMs`.
 */
export function stateTimeWeightedMean(
  ordered: readonly TimedValue[],
  end: number,
  maxHoldMs: number,
  stateMs: number,
): number | null {
  if (ordered.length === 0) return null;
  if (ordered.length === 1) return ordered[0]!.value;
  let weighted = 0;
  let duration = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    const following = ordered[index + 1];
    const sameState = following !== undefined
      && Math.floor(following.at / stateMs) === Math.floor(current.at / stateMs);
    const next = following?.at ?? end;
    const seconds = Math.max(0, (sameState ? next - current.at : Math.min(next - current.at, maxHoldMs)) / 1_000);
    weighted += current.value * seconds;
    duration += seconds;
  }
  return duration > 0 ? weighted / duration : ordered.at(-1)!.value;
}

/**
 * Width of the stored ordered states read for a display bucket: the widest
 * stored width that divides it, but at most 15 minutes when power is read
 * (its 15-minute hold must stay exact) and at most an hour when a
 * time-weighted mean is read (a reading never holds for longer unseen).
 */
export function orderedStateSeconds(
  resolutionSeconds: number,
  reads: { power: boolean; timeWeighted: boolean },
): 60 | 900 | 3600 | 86400 {
  const width = resolutionSeconds % 86_400 === 0 ? 86_400
    : resolutionSeconds % 3_600 === 0 ? 3_600
      : resolutionSeconds % 900 === 0 ? 900
        : 60;
  if (reads.power) return Math.min(900, width) as 60 | 900;
  if (reads.timeWeighted) return Math.min(3_600, width) as 60 | 900 | 3600;
  return width;
}
