import type { MeasurementSample } from "@climate-twin/contracts";

/** Bucket consumption from ordered observations, never from averaged counters. */
export function analyticsConsumptionBuckets(
  samples: readonly MeasurementSample[], metric: string, bucketMs: number, end: number,
): Map<number, number | null> {
  const result = new Map<number, number | null>();
  if (metric !== "energy" && metric !== "power") return result;
  const ordered = [...new Map(samples.filter((sample) => Number.isFinite(sample.value) && (metric === "power" || sample.value >= 0))
    .map((sample) => [Date.parse(sample.timestamp), sample])).values()]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  // Signed net power cannot be converted to positive consumption from the
  // stored integral alone. Match that conservative contract on raw samples.
  const add = (bucket: number, value: number | null) => result.set(bucket,
    value === null || result.get(bucket) === null ? null : (result.get(bucket) ?? 0) + value);
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    const at = Date.parse(current.timestamp);
    if (metric === "energy") {
      const previous = ordered[index - 1];
      const delta = previous ? current.value >= previous.value ? current.value - previous.value : current.value : 0;
      add(Math.floor(at / bucketMs) * bucketMs, delta);
    } else {
      const until = Math.min(end, at + 15 * 60_000,
        ordered[index + 1] ? Date.parse(ordered[index + 1]!.timestamp) : end);
      for (let bucket = Math.floor(at / bucketMs) * bucketMs; bucket < until; bucket += bucketMs) {
        const duration = Math.min(until, bucket + bucketMs) - Math.max(at, bucket);
        if (duration > 0) add(bucket, current.value < 0 ? null : current.value * duration / 3_600_000_000);
      }
    }
  }
  return result;
}
