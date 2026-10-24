import { counterIncrement } from "./counters.js";

/** One observation at an epoch-millisecond instant. */
export interface TimedValue {
  at: number;
  value: number;
}

export const MILLISECONDS_PER_HOUR = 3_600_000;

/**
 * Longest interval a power reading stands for. Past it the meter is treated
 * as silent rather than as still drawing its last reported load.
 */
export const POWER_HOLD_MS = 15 * 60_000;

/** Energy of a constant `watts` load held for `durationMs`, in kWh. */
export function wattMillisecondsToKwh(watts: number, durationMs: number): number {
  return watts * durationMs / 3_600_000_000;
}

/** Energy of an average `watts` load over `hours`, in kWh. */
export function averageWattsToKwh(watts: number, hours: number): number {
  return watts * hours / 1_000;
}

export type ConsumptionSource = "counter" | "power";

/**
 * Attributes consumption to fixed-width buckets from ordered observations,
 * never from averaged counters.
 *
 * - `counter` readings (cumulative kWh): each increase between consecutive
 *   readings belongs to the bucket of the later reading. The interval that
 *   straddles `start` is prorated by the share of it inside the range.
 * - `power` readings (W): each reading holds until the next one, at most
 *   {@link POWER_HOLD_MS}, and its energy is split across bucket boundaries.
 *
 * Two different values at one instant have no authoritative winner here, so
 * that instant makes its bucket `null` rather than inventing one. Negative
 * counter readings are discarded; negative power marks a signed (net) meter
 * whose positive usage cannot be recovered, which also yields `null`.
 */
export function consumptionBuckets(
  observations: readonly TimedValue[],
  source: ConsumptionSource,
  bucketMs: number,
  end: number,
  start = -Infinity,
): Map<number, number | null> {
  const result = new Map<number, number | null>();
  const byInstant = new Map<number, number | null>();
  for (const observation of observations) {
    if (!Number.isFinite(observation.at) || !Number.isFinite(observation.value)) continue;
    if (source === "counter" && observation.value < 0) continue;
    const existing = byInstant.get(observation.at);
    byInstant.set(observation.at, existing !== undefined && existing !== observation.value ? null : observation.value);
  }
  const ordered = [...byInstant].sort(([left], [right]) => left - right)
    .map(([at, value]) => ({ at, value }));
  const add = (bucket: number, value: number | null) => result.set(bucket,
    value === null || result.get(bucket) === null ? null : (result.get(bucket) ?? 0) + value);
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    const at = current.at;
    if (source === "counter") {
      if (at < start || at > end) continue;
      const previous = ordered[index - 1];
      const fullDelta = current.value === null || previous?.value === null ? null
        : previous ? counterIncrement(previous.value, current.value).increment : 0;
      const fraction = previous ? (at - Math.max(start, previous.at)) / (at - previous.at) : 1;
      const delta = fullDelta === null ? null : fullDelta * Math.max(0, fraction);
      // A reading exactly at the exclusive end closes the final interval but
      // does not become an ordinary sample in the following bucket.
      add(Math.floor(Math.min(at, end - 1) / bucketMs) * bucketMs, delta);
    } else {
      const until = Math.min(end, at + POWER_HOLD_MS, ordered[index + 1]?.at ?? end);
      for (let bucket = Math.floor(Math.max(at, start) / bucketMs) * bucketMs; bucket < until; bucket += bucketMs) {
        const duration = Math.min(until, bucket + bucketMs) - Math.max(at, start, bucket);
        if (duration > 0) {
          add(bucket, current.value === null || current.value < 0 ? null : wattMillisecondsToKwh(current.value, duration));
        }
      }
    }
  }
  return result;
}
