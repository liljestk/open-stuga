import type { MeasurementSample } from "@climate-twin/contracts";

/** Bucket consumption from ordered observations, never from averaged counters. */
export function analyticsConsumptionBuckets(
  samples: readonly MeasurementSample[], metric: string, bucketMs: number, end: number,
  start = -Infinity,
): Map<number, number | null> {
  const result = new Map<number, number | null>();
  if (metric !== "energy" && metric !== "power") return result;
  const byTimestamp = new Map<number, number | null>();
  for (const sample of samples) {
    const at = Date.parse(sample.timestamp);
    if (!Number.isFinite(at) || !Number.isFinite(sample.value) || (metric === "energy" && sample.value < 0)) continue;
    // Archive states can select the latest ingested observation. Raw samples
    // do not expose that ordering, so conflicting simultaneous values have no
    // authoritative winner. Source names or array order must not invent one.
    const existing = byTimestamp.get(at);
    byTimestamp.set(at, existing !== undefined && existing !== sample.value ? null : sample.value);
  }
  const ordered = [...byTimestamp].sort(([left], [right]) => left - right)
    .map(([at, value]) => ({ at, value }));
  // Signed net power cannot be converted to positive consumption from the
  // stored integral alone. Match that conservative contract on raw samples.
  const add = (bucket: number, value: number | null) => result.set(bucket,
    value === null || result.get(bucket) === null ? null : (result.get(bucket) ?? 0) + value);
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    const at = current.at;
    if (metric === "energy") {
      if (at < start || at > end) continue;
      const previous = ordered[index - 1];
      const fullDelta = current.value === null || previous?.value === null ? null
        : previous ? current.value >= previous.value ? current.value - previous.value : current.value : 0;
      const fraction = previous ? (at - Math.max(start, previous.at)) / (at - previous.at) : 1;
      const delta = fullDelta === null ? null : fullDelta * Math.max(0, fraction);
      // An observation exactly at the exclusive end closes the final interval
      // but does not become an ordinary sample in the following chart bucket.
      add(Math.floor(Math.min(at, end - 1) / bucketMs) * bucketMs, delta);
    } else {
      const until = Math.min(end, at + 15 * 60_000,
        ordered[index + 1]?.at ?? end);
      for (let bucket = Math.floor(Math.max(at, start) / bucketMs) * bucketMs; bucket < until; bucket += bucketMs) {
        const duration = Math.min(until, bucket + bucketMs) - Math.max(at, start, bucket);
        if (duration > 0) add(bucket, current.value === null || current.value < 0 ? null : current.value * duration / 3_600_000_000);
      }
    }
  }
  return result;
}
