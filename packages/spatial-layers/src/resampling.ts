import type { SpatialClimateSample, SpatialSensorCalibration } from './contracts.js';
import { clamp, isoTime, median } from './math.js';
import { calibrateAndConvert, type CalibratedPsychrometricSample } from './psychrometrics.js';

export interface ResampledClimatePoint extends CalibratedPsychrometricSample {
  bucketAt: string;
  interpolation: 'observed' | 'carried';
  ageSeconds: number;
  observedCadenceSeconds: number | null;
  /** Confidence-weighted response-delay correction used for event alignment. */
  appliedResponseLagSeconds: number;
  pointQuality: number;
}

export interface ResampledClimateWindow {
  startAt: string;
  endAt: string;
  bucketSeconds: 30 | 60;
  expectedBucketCount: number;
  observedCadenceSeconds: Record<string, number | null>;
  points: ResampledClimatePoint[];
  rejected: Array<{ sensorId: string; observedAt: string; reasons: string[] }>;
}

export interface ResamplingOptions {
  startAt: string;
  endAt: string;
  targetBucketSeconds?: 30 | 60;
  maximumCarryForwardSeconds?: number;
  minimumCarryForwardSeconds?: number;
  configuredPressureHpa?: number;
}

export function observedMedianCadenceSeconds(samples: readonly SpatialClimateSample[]): number | null {
  const timestamps = [...new Set(samples.map((sample) => isoTime(sample.observedAt)).filter((time): time is number => time !== null))]
    .sort((left, right) => left - right);
  const differences: number[] = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const difference = ((timestamps[index] ?? 0) - (timestamps[index - 1] ?? 0)) / 1000;
    if (difference > 0) differences.push(difference);
  }
  return differences.length === 0 ? null : median(differences);
}

function deduplicate(samples: readonly SpatialClimateSample[]): SpatialClimateSample[] {
  const byKey = new Map<string, SpatialClimateSample>();
  for (const sample of samples) {
    const key = sample.sourceSequence === undefined
      ? `${sample.sensorId}\u0000${sample.observedAt}`
      : `${sample.sensorId}\u0000sequence:${sample.sourceSequence}`;
    byKey.set(key, sample);
  }
  return [...byKey.values()];
}

export function resampleClimateWindow(
  samples: readonly SpatialClimateSample[],
  calibrations: readonly SpatialSensorCalibration[] = [],
  options: ResamplingOptions,
): ResampledClimateWindow {
  const start = Date.parse(options.startAt);
  const end = Date.parse(options.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error('Invalid resampling interval');
  }
  const bucketSeconds = options.targetBucketSeconds ?? 60;
  const bucketMs = bucketSeconds * 1000;
  const sensorSamples = new Map<string, SpatialClimateSample[]>();
  const rejected: ResampledClimateWindow['rejected'] = [];
  const rejectedKeys = new Set<string>();
  const rejectOnce = (sensorId: string, observedAt: string, reasons: string[]): void => {
    const key = `${sensorId}\u0000${observedAt}\u0000${reasons.join(',')}`;
    if (rejectedKeys.has(key)) return;
    rejectedKeys.add(key);
    rejected.push({ sensorId, observedAt, reasons });
  };
  for (const sample of deduplicate(samples)) {
    const timestamp = isoTime(sample.observedAt);
    const reasons: string[] = [];
    if (timestamp === null) reasons.push('invalid-timestamp');
    if (!Number.isFinite(sample.temperatureC)) reasons.push('invalid-temperature');
    if (!Number.isFinite(sample.relativeHumidityPct) || sample.relativeHumidityPct < 0 || sample.relativeHumidityPct > 100) {
      reasons.push('invalid-humidity');
    }
    if (reasons.length > 0) {
      rejectOnce(sample.sensorId, sample.observedAt, reasons);
      continue;
    }
    const list = sensorSamples.get(sample.sensorId) ?? [];
    list.push(sample);
    sensorSamples.set(sample.sensorId, list);
  }

  const cadences: Record<string, number | null> = {};
  const points: ResampledClimatePoint[] = [];
  const firstBucket = Math.ceil(start / bucketMs) * bucketMs;
  const expectedBucketCount = firstBucket > end ? 0 : Math.floor((end - firstBucket) / bucketMs) + 1;

  for (const [sensorId, unordered] of sensorSamples) {
    const cadence = observedMedianCadenceSeconds(unordered);
    cadences[sensorId] = cadence;
    const ordered = unordered.map((sample) => {
      const converted = calibrateAndConvert(sample, calibrations, {
        ...(options.configuredPressureHpa === undefined ? {} : { configuredPressureHpa: options.configuredPressureHpa }),
      });
      const appliedResponseLagSeconds = converted.responseLagSeconds * converted.calibrationConfidence;
      return {
        sample,
        converted,
        appliedResponseLagSeconds,
        effectiveObservedAt: Date.parse(sample.observedAt) - appliedResponseLagSeconds * 1_000,
      };
    }).sort((left, right) => left.effectiveObservedAt - right.effectiveObservedAt);
    const dynamicCarry = Math.max(
      options.minimumCarryForwardSeconds ?? bucketSeconds * 2,
      cadence === null ? bucketSeconds * 3 : cadence * 3,
    );
    const carryLimit = options.maximumCarryForwardSeconds === undefined
      ? dynamicCarry
      : Math.min(dynamicCarry, options.maximumCarryForwardSeconds);
    let cursor = 0;
    let latest: (typeof ordered)[number] | undefined;
    for (let bucket = firstBucket; bucket <= end; bucket += bucketMs) {
      let observedInBucket = false;
      while (cursor < ordered.length) {
        const candidate = ordered[cursor];
        if (candidate === undefined || candidate.effectiveObservedAt > bucket) break;
        latest = candidate;
        observedInBucket = candidate.effectiveObservedAt > bucket - bucketMs;
        cursor += 1;
      }
      if (latest === undefined) continue;
      const ageSeconds = Math.max(0, (bucket - latest.effectiveObservedAt) / 1000);
      if (ageSeconds > carryLimit) continue;
      const { converted } = latest;
      if (!converted.psychrometrics.valid) {
        rejectOnce(sensorId, latest.sample.observedAt, converted.psychrometrics.reasons);
        continue;
      }
      const interpolation = observedInBucket && ageSeconds <= bucketSeconds ? 'observed' : 'carried';
      const sourceQuality = clamp(latest.sample.sourceQuality ?? 1);
      const agePenalty = carryLimit <= 0 ? 0 : clamp(1 - ageSeconds / carryLimit);
      const calibrationQuality = converted.calibrationMethod === 'none'
        ? 0.75
        : 0.5 + 0.5 * converted.calibrationConfidence;
      points.push({
        ...converted,
        bucketAt: new Date(bucket).toISOString(),
        interpolation,
        ageSeconds,
        observedCadenceSeconds: cadence,
        appliedResponseLagSeconds: latest.appliedResponseLagSeconds,
        pointQuality:
          sourceQuality *
          calibrationQuality *
          (interpolation === 'observed' ? 1 : Math.max(0.25, agePenalty)),
      });
    }
  }

  return {
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    bucketSeconds,
    expectedBucketCount,
    observedCadenceSeconds: cadences,
    points,
    rejected,
  };
}
