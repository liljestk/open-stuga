import type { SpatialTopology } from './contracts.js';
import { clamp, mad, mean, median } from './math.js';
import type { ResampledClimateWindow } from './resampling.js';
import { activeBindingAt } from './topology.js';

export type SensorQualityReason =
  | 'late'
  | 'missing'
  | 'outlier'
  | 'flatline'
  | 'excessive-noise'
  | 'clock-skew'
  | 'uncalibrated'
  | 'placement-risk'
  | 'low-coverage';

export interface SensorQualityState {
  sensorId: string;
  at: string;
  score: number;
  state: 'healthy' | 'degraded' | 'stale' | 'offline' | 'uncalibrated';
  reasons: SensorQualityReason[];
  observedCadenceSeconds: number | null;
  ageSeconds: number | null;
  coverage: number;
}

export interface SensorQualityOptions {
  staleFloorSeconds?: number;
  offlineMultiplier?: number;
}

export function assessSensorQuality(
  window: ResampledClimateWindow,
  topology: SpatialTopology,
  options: SensorQualityOptions = {},
): SensorQualityState[] {
  const sensorIds = new Set([
    ...topology.sensorBindings.map((binding) => binding.sensorId),
    ...window.points.map((point) => point.sensorId),
  ]);
  const ranges = new Map<string, { temperature: number; humidity: number }>();
  for (const sensorId of sensorIds) {
    const points = window.points.filter((point) => point.sensorId === sensorId);
    const temperatures = points.map((point) => point.calibratedTemperatureC);
    const humidities = points.map((point) => point.calibratedRelativeHumidityPct);
    ranges.set(sensorId, {
      temperature: temperatures.length < 2 ? 0 : Math.max(...temperatures) - Math.min(...temperatures),
      humidity: humidities.length < 2 ? 0 : Math.max(...humidities) - Math.min(...humidities),
    });
  }
  const environmentVaried = [...ranges.values()].some((range) => range.temperature > 0.2 || range.humidity > 1);

  return [...sensorIds].sort().map((sensorId) => {
    const points = window.points
      .filter((point) => point.sensorId === sensorId)
      .sort((left, right) => Date.parse(left.bucketAt) - Date.parse(right.bucketAt));
    const latest = points.at(-1);
    const reasons: SensorQualityReason[] = [];
    const cadence = window.observedCadenceSeconds[sensorId] ?? null;
    const staleThreshold = Math.max(options.staleFloorSeconds ?? 120, (cadence ?? window.bucketSeconds) * 3);
    const offlineThreshold = staleThreshold * (options.offlineMultiplier ?? 3);
    const age = latest === undefined ? null : Math.max(0, (Date.parse(window.endAt) - Date.parse(latest.observedAt)) / 1000);
    const coverage = window.expectedBucketCount === 0 ? 0 : clamp(points.length / window.expectedBucketCount);
    if (latest === undefined) reasons.push('missing');
    if (coverage < 0.6) reasons.push('low-coverage');
    if (age !== null && age > staleThreshold) reasons.push('late');
    if (points.some((point) => point.calibrationMethod === 'none')) reasons.push('uncalibrated');
    const binding = activeBindingAt(
      topology.sensorBindings,
      sensorId,
      latest?.observedAt ?? window.endAt,
    );
    if ((binding?.placementRisks?.length ?? 0) > 0) reasons.push('placement-risk');

    const temperatureDiffs: number[] = [];
    const humidityDiffs: number[] = [];
    for (let index = 1; index < points.length; index += 1) {
      temperatureDiffs.push(
        (points[index]?.calibratedTemperatureC ?? 0) - (points[index - 1]?.calibratedTemperatureC ?? 0),
      );
      humidityDiffs.push(
        (points[index]?.calibratedRelativeHumidityPct ?? 0) -
          (points[index - 1]?.calibratedRelativeHumidityPct ?? 0),
      );
    }
    const tempCenter = median(temperatureDiffs);
    const humidityCenter = median(humidityDiffs);
    const tempMad = Math.max(0.01, mad(temperatureDiffs, tempCenter));
    const humidityMad = Math.max(0.05, mad(humidityDiffs, humidityCenter));
    if (
      temperatureDiffs.some((value) => Math.abs(value - tempCenter) > Math.max(2, tempMad * 8)) ||
      humidityDiffs.some((value) => Math.abs(value - humidityCenter) > Math.max(10, humidityMad * 8))
    ) {
      reasons.push('outlier');
    }
    if (temperatureDiffs.length >= 5 && (mad(temperatureDiffs) > 0.35 || mad(humidityDiffs) > 2)) {
      reasons.push('excessive-noise');
    }
    const ownRange = ranges.get(sensorId);
    if (environmentVaried && ownRange !== undefined && ownRange.temperature < 0.01 && ownRange.humidity < 0.05 && points.length >= 5) {
      reasons.push('flatline');
    }
    if (points.some((point) => point.receivedAt !== undefined && Date.parse(point.receivedAt) < Date.parse(point.observedAt) - 1000)) {
      reasons.push('clock-skew');
    }

    let score = coverage;
    score *= mean(points.map((point) => point.pointQuality));
    if (reasons.includes('uncalibrated')) score *= 0.75;
    if (reasons.includes('placement-risk')) score *= 0.85;
    if (reasons.includes('outlier')) score *= 0.7;
    if (reasons.includes('excessive-noise')) score *= 0.7;
    if (reasons.includes('flatline')) score *= 0.4;
    if (reasons.includes('clock-skew')) score *= 0.7;
    if (age !== null && age > staleThreshold) score *= 0.35;
    if (latest === undefined || (age !== null && age > offlineThreshold)) score = 0;

    let state: SensorQualityState['state'] = 'healthy';
    if (score === 0) state = 'offline';
    else if (age !== null && age > staleThreshold) state = 'stale';
    else if (reasons.includes('uncalibrated')) state = 'uncalibrated';
    else if (score < 0.75 || reasons.length > 0) state = 'degraded';
    return {
      sensorId,
      at: window.endAt,
      score: clamp(score),
      state,
      reasons,
      observedCadenceSeconds: cadence,
      ageSeconds: age,
      coverage,
    };
  });
}
