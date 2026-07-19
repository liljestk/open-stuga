import type { SpatialLayerEngineInput } from './contracts.js';
import { clamp, mean, weightedMean } from './math.js';
import { assessSensorQuality, type SensorQualityState } from './quality.js';
import { resampleClimateWindow, type ResampledClimatePoint, type ResampledClimateWindow } from './resampling.js';
import { activeBindingAt, validateEngineInput, type TopologyValidationResult } from './topology.js';

export interface ZoneClimatePoint {
  zoneId: string;
  bucketAt: string;
  temperatureC: number;
  relativeHumidityPct: number;
  absoluteHumidityGM3: number;
  humidityRatioGKg: number;
  dewPointC: number | null;
  quality: number;
  sensorIds: string[];
}

export interface PreparedSpatialWindow {
  validation: TopologyValidationResult;
  resampled: ResampledClimateWindow;
  sensorQuality: SensorQualityState[];
  zoneSeries: Map<string, ZoneClimatePoint[]>;
  healthyIndoorSensorCount: number;
  overallQuality: number;
}

function configuredPressure(input: SpatialLayerEngineInput): number | undefined {
  const value = input.config?.['configuredPressureHpa'];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function prepareSpatialWindow(input: SpatialLayerEngineInput): PreparedSpatialWindow {
  const validation = validateEngineInput(input);
  const pressure = configuredPressure(input);
  const resampled = resampleClimateWindow(input.samples, input.calibrations ?? [], {
    startAt: input.windowStart,
    endAt: input.windowEnd,
    targetBucketSeconds: input.targetBucketSeconds ?? 60,
    ...(pressure === undefined ? {} : { configuredPressureHpa: pressure }),
  });
  const sensorQuality = assessSensorQuality(resampled, input.topology);
  const qualityBySensor = new Map(sensorQuality.map((quality) => [quality.sensorId, quality.score]));
  const grouped = new Map<string, ResampledClimatePoint[]>();
  for (const point of resampled.points) {
    // Bind the value to the placement valid when the source reading was
    // observed. A carried value must not jump rooms after a sensor move.
    const binding = activeBindingAt(input.topology.sensorBindings, point.sensorId, point.observedAt);
    if (binding === undefined) continue;
    const key = `${binding.zoneId}\u0000${point.bucketAt}`;
    const list = grouped.get(key) ?? [];
    list.push(point);
    grouped.set(key, list);
  }
  const zoneSeries = new Map<string, ZoneClimatePoint[]>();
  for (const [key, points] of grouped) {
    const separator = key.indexOf('\u0000');
    const zoneId = key.slice(0, separator);
    const bucketAt = key.slice(separator + 1);
    const weighted = (select: (point: ResampledClimatePoint) => number | null): number | null =>
      weightedMean(
        points.flatMap((point) => {
          const value = select(point);
          if (value === null) return [];
          return [{ value, weight: point.pointQuality * (qualityBySensor.get(point.sensorId) ?? 0) }];
        }),
      );
    const temperature = weighted((point) => point.calibratedTemperatureC);
    const humidity = weighted((point) => point.calibratedRelativeHumidityPct);
    const absolute = weighted((point) => point.psychrometrics.absoluteHumidityGM3);
    const ratio = weighted((point) => point.psychrometrics.humidityRatioGKg);
    const dewPoint = weighted((point) => point.psychrometrics.dewPointC);
    if (temperature === null || humidity === null || absolute === null || ratio === null) continue;
    const quality = mean(points.map((point) => point.pointQuality * (qualityBySensor.get(point.sensorId) ?? 0)));
    const list = zoneSeries.get(zoneId) ?? [];
    list.push({
      zoneId,
      bucketAt,
      temperatureC: temperature,
      relativeHumidityPct: humidity,
      absoluteHumidityGM3: absolute,
      humidityRatioGKg: ratio,
      dewPointC: dewPoint,
      quality: clamp(quality),
      sensorIds: points.map((point) => point.sensorId).sort(),
    });
    zoneSeries.set(zoneId, list);
  }
  for (const series of zoneSeries.values()) {
    series.sort((left, right) => Date.parse(left.bucketAt) - Date.parse(right.bucketAt));
  }
  const indoorSensorIds = new Set(
    input.topology.sensorBindings
      .filter((binding) => input.topology.zones.find((zone) => zone.id === binding.zoneId)?.kind !== 'outdoor')
      .map((binding) => binding.sensorId),
  );
  const healthyIndoorSensorCount = sensorQuality.filter(
    (quality) => indoorSensorIds.has(quality.sensorId) && quality.score >= 0.35 && quality.state !== 'offline',
  ).length;
  return {
    validation,
    resampled,
    sensorQuality,
    zoneSeries,
    healthyIndoorSensorCount,
    overallQuality: mean(sensorQuality.map((quality) => quality.score)),
  };
}

export function latestZonePoints(series: Map<string, ZoneClimatePoint[]>): ZoneClimatePoint[] {
  return [...series.values()].flatMap((points) => {
    const latest = points.at(-1);
    return latest === undefined ? [] : [latest];
  });
}

export function seriesByCommonBuckets(
  left: readonly ZoneClimatePoint[],
  right: readonly ZoneClimatePoint[],
): Array<{ left: ZoneClimatePoint; right: ZoneClimatePoint }> {
  const rightByBucket = new Map(right.map((point) => [point.bucketAt, point]));
  return left.flatMap((point) => {
    const match = rightByBucket.get(point.bucketAt);
    return match === undefined ? [] : [{ left: point, right: match }];
  });
}
