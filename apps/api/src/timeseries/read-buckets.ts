import type { MeasurementSample, Reading } from "@climate-twin/contracts";
import { compareMeasurements, compareReadings } from "./read-records.js";

/**
 * The in-process half of one bucketing contract with three implementations:
 * this file, the `measurement_history_bucketed` SQL in
 * `store/methods/02-write-batches-to-electricity-price-history.ts`, and
 * `qualityWeightedThermalBuckets` in `read-facade.ts`.
 *
 * All three must agree that a bucket's value is the mean of its samples and
 * that quality degrades to `estimated` as soon as a bucket merges more than one
 * sample or more than one source. The hybrid reader dedupes local and archived
 * buckets by (sensor, metric, bucket timestamp), so a divergence here does not
 * surface as a visible error — it silently returns whichever side won the merge.
 * `apps/api/tests/timeseries-read-facade.test.ts` pins the shared behaviour.
 */
export function bucketMeasurementSamples(
  samples: readonly MeasurementSample[],
  bucketSeconds: number,
): MeasurementSample[] {
  const buckets = new Map<number, MeasurementSample[]>();
  for (const sample of samples) {
    const epoch = Math.floor(Date.parse(sample.timestamp) / (bucketSeconds * 1_000)) * bucketSeconds;
    if (!Number.isFinite(epoch)) continue;
    const bucket = buckets.get(epoch) ?? [];
    bucket.push(sample);
    buckets.set(epoch, bucket);
  }
  return [...buckets.entries()].sort(([left], [right]) => left - right).map(([epoch, bucket]) => {
    const latest = [...bucket].sort(compareMeasurements).at(-1)!;
    return {
      ...latest,
      value: bucket.reduce((sum, sample) => sum + sample.value, 0) / bucket.length,
      timestamp: new Date(epoch * 1_000).toISOString(),
      quality: bucket.length > 1 || new Set(bucket.map((sample) => sample.source)).size > 1
        ? "estimated"
        : latest.quality,
    };
  });
}

export function bucketLegacyReadings(readings: readonly Reading[], bucketSeconds: number): Reading[] {
  const buckets = new Map<string, Reading[]>();
  for (const reading of readings) {
    const epoch = Math.floor(Date.parse(reading.timestamp) / (bucketSeconds * 1_000)) * bucketSeconds;
    if (!Number.isFinite(epoch)) continue;
    const key = JSON.stringify([reading.sensorId, epoch]);
    const bucket = buckets.get(key) ?? [];
    bucket.push(reading);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()].map(([key, bucket]) => {
    const [sensorId, epoch] = JSON.parse(key) as [string, number];
    const latest = [...bucket].sort(compareReadings).at(-1)!;
    return {
      ...latest,
      sensorId,
      timestamp: new Date(epoch * 1_000).toISOString(),
      temperature: bucket.reduce((sum, reading) => sum + reading.temperature, 0) / bucket.length,
      humidity: bucket.reduce((sum, reading) => sum + reading.humidity, 0) / bucket.length,
      quality: bucket.length > 1 || new Set(bucket.map((reading) => reading.source)).size > 1
        ? "estimated"
        : latest.quality,
    };
  }).sort(compareReadings);
}
