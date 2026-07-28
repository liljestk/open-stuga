import type { MeasurementSample, Reading } from "@climate-twin/contracts";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareMeasurements(left: MeasurementSample, right: MeasurementSample): number {
  return compareText(left.timestamp, right.timestamp)
    || compareText(left.sensorId, right.sensorId)
    || compareText(left.metric, right.metric)
    || compareText(left.source, right.source);
}

function compareReadings(left: Reading, right: Reading): number {
  return compareText(left.timestamp, right.timestamp)
    || compareText(left.sensorId, right.sensorId)
    || compareText(left.source, right.source);
}

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
