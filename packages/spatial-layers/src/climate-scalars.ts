import type {
  SpatialLayerEngine,
  SpatialLayerEngineInput,
  SpatialLayerEngineManifest,
  SpatialLayerMetric,
  SpatialLayerSnapshot,
} from './contracts.js';
import { clamp, mean } from './math.js';
import { latestZonePoints, prepareSpatialWindow } from './series.js';
import { snapshotBase } from './snapshot.js';
import { activeBindingAt } from './topology.js';

export const CLIMATE_LAYER_IDS = [
  'climate.temperature',
  'climate.relative-humidity',
  'climate.absolute-humidity',
  'climate.humidity-ratio',
  'sensor.quality',
] as const;

type ClimateLayerId = (typeof CLIMATE_LAYER_IDS)[number];

interface MetricDefinition {
  key: string;
  unit: string;
  label: string;
  palette: 'temperature' | 'humidity' | 'quality';
  select: (point: ReturnType<typeof latestZonePoints>[number]) => number;
}

const DEFINITIONS: Record<Exclude<ClimateLayerId, 'sensor.quality'>, MetricDefinition> = {
  'climate.temperature': {
    key: 'temperatureC',
    unit: 'degC',
    label: 'Temperature',
    palette: 'temperature',
    select: (point) => point.temperatureC,
  },
  'climate.relative-humidity': {
    key: 'relativeHumidityPct',
    unit: '%',
    label: 'Relative humidity',
    palette: 'humidity',
    select: (point) => point.relativeHumidityPct,
  },
  'climate.absolute-humidity': {
    key: 'absoluteHumidityGM3',
    unit: 'g/m3',
    label: 'Absolute humidity',
    palette: 'humidity',
    select: (point) => point.absoluteHumidityGM3,
  },
  'climate.humidity-ratio': {
    key: 'humidityRatioGKg',
    unit: 'g/kg',
    label: 'Humidity ratio',
    palette: 'humidity',
    select: (point) => point.humidityRatioGKg,
  },
};

function metric(value: number, quality: number, definition: MetricDefinition): Record<string, SpatialLayerMetric> {
  return {
    [definition.key]: {
      value,
      unit: definition.unit,
      quality: clamp(quality),
      label: definition.label,
    },
  };
}

export class ClimateScalarEngine implements SpatialLayerEngine {
  readonly manifest: SpatialLayerEngineManifest = {
    id: 'climate-scalars',
    version: '1.0.0',
    maturity: 'stable',
    title: 'Climate scalar layers',
    description: 'Calibrated climate and sensor-quality values for house and property geometry.',
    supportedScopes: ['house', 'property'],
    requiredMetrics: ['temperatureC', 'relativeHumidityPct'],
    producedLayerIds: [...CLIMATE_LAYER_IDS],
  };

  infer(input: SpatialLayerEngineInput): SpatialLayerSnapshot[] {
    const prepared = prepareSpatialWindow(input);
    const topologyErrors = prepared.validation.issues.filter((issue) => issue.severity === 'error');
    const latest = latestZonePoints(prepared.zoneSeries);
    const status = topologyErrors.length > 0
      ? 'error'
      : latest.length === 0
        ? 'insufficient_data'
        : 'ready';
    const warnings = [
      ...prepared.validation.issues.map((issue) => issue.message),
      ...prepared.resampled.rejected.map((item) => `Rejected ${item.sensorId} reading: ${item.reasons.join(', ')}`),
    ];

    const climateSnapshots = (Object.entries(DEFINITIONS) as Array<[
      Exclude<ClimateLayerId, 'sensor.quality'>,
      MetricDefinition,
    ]>).map(([layerId, definition]) => {
      const snapshot = snapshotBase(input, {
        layerId,
        modelId: this.manifest.id,
        modelVersion: this.manifest.version,
        maturity: this.manifest.maturity,
        status,
        qualityScore: prepared.overallQuality,
        warnings,
        reasonCodes: status === 'ready' ? ['calibrated-observation'] : ['insufficient-climate-data'],
      });
      snapshot.zones = latest.map((point) => {
        const zone = input.topology.zones.find((candidate) => candidate.id === point.zoneId);
        return {
          zoneId: point.zoneId,
          frameId: zone?.frameId ?? input.topology.frames[0]?.id ?? 'unknown',
          ...(zone === undefined ? {} : {
            name: zone.name,
            ...(zone.floorId === undefined ? {} : { floorId: zone.floorId }),
            ...(zone.roomId === undefined ? {} : { roomId: zone.roomId }),
            ...(zone.polygon === undefined ? {} : { polygon: zone.polygon }),
            ...(zone.tags === undefined ? {} : { tags: zone.tags }),
            anchor: zone.centroid,
          }),
          metrics: metric(definition.select(point), point.quality, definition),
          evidence: [{ score: point.quality, kind: 'observation', reasonCodes: ['calibrated-observation'] }],
          reasonCodes: point.quality < 0.5 ? ['degraded-sensor-data'] : [],
          style: { palette: definition.palette, opacity: clamp(0.25 + point.quality * 0.75) },
        };
      });
      const latestPointsBySensor = new Map<string, (typeof prepared.resampled.points)[number]>();
      for (const point of prepared.resampled.points) latestPointsBySensor.set(point.sensorId, point);
      snapshot.points = [...latestPointsBySensor.values()].flatMap((point) => {
        const binding = activeBindingAt(input.topology.sensorBindings, point.sensorId, point.observedAt);
        if (binding === undefined) return [];
        const valueByKey: Record<string, number | null> = {
          temperatureC: point.calibratedTemperatureC,
          relativeHumidityPct: point.calibratedRelativeHumidityPct,
          absoluteHumidityGM3: point.psychrometrics.absoluteHumidityGM3,
          humidityRatioGKg: point.psychrometrics.humidityRatioGKg,
        };
        const value = valueByKey[definition.key];
        if (value === null || value === undefined) return [];
        return [{
          pointId: point.sensorId,
          zoneId: binding.zoneId,
          frameId: binding.frameId,
          position: binding.position,
          metrics: metric(value, point.pointQuality, definition),
          evidence: [{ score: point.pointQuality, kind: 'observation' as const, reasonCodes: ['sensor-reading'] }],
          reasonCodes: point.interpolation === 'carried' ? ['carried-forward'] : [],
          style: { palette: definition.palette, opacity: clamp(0.25 + point.pointQuality * 0.75) },
        }];
      });
      return snapshot;
    });

    const qualitySnapshot = snapshotBase(input, {
      layerId: 'sensor.quality',
      modelId: this.manifest.id,
      modelVersion: this.manifest.version,
      maturity: this.manifest.maturity,
      status,
      qualityScore: prepared.overallQuality,
      warnings,
      reasonCodes: prepared.overallQuality >= 0.75 ? ['sensor-data-healthy'] : ['sensor-data-degraded'],
    });
    qualitySnapshot.zones = latest.map((point) => {
      const zone = input.topology.zones.find((candidate) => candidate.id === point.zoneId);
      return {
        zoneId: point.zoneId,
        frameId: zone?.frameId ?? input.topology.frames[0]?.id ?? 'unknown',
        ...(zone === undefined ? {} : {
          name: zone.name,
          ...(zone.floorId === undefined ? {} : { floorId: zone.floorId }),
          ...(zone.roomId === undefined ? {} : { roomId: zone.roomId }),
          ...(zone.polygon === undefined ? {} : { polygon: zone.polygon }),
          ...(zone.tags === undefined ? {} : { tags: zone.tags }),
          anchor: zone.centroid,
        }),
        metrics: { qualityScore: { value: point.quality, quality: point.quality, label: 'Data quality' } },
        evidence: [{ score: point.quality, kind: 'quality', reasonCodes: ['zone-sensor-quality'] }],
        reasonCodes: point.quality < 0.5 ? ['degraded-sensor-data'] : [],
        style: { palette: 'quality', opacity: clamp(0.25 + point.quality * 0.75) },
      };
    });
    qualitySnapshot.points = prepared.sensorQuality.flatMap((quality) => {
      const binding = input.topology.sensorBindings.find((candidate) => candidate.sensorId === quality.sensorId);
      if (binding === undefined) return [];
      return [{
        pointId: quality.sensorId,
        zoneId: binding.zoneId,
        frameId: binding.frameId,
        position: binding.position,
        metrics: {
          qualityScore: { value: quality.score, quality: quality.score, label: 'Sensor quality' },
          coverage: { value: quality.coverage, quality: quality.score, label: 'Coverage' },
          state: { value: quality.state, quality: quality.score, label: 'Sensor state' },
        },
        evidence: [{ score: quality.score, kind: 'quality' as const, reasonCodes: quality.reasons }],
        reasonCodes: quality.reasons,
        style: { palette: 'quality' as const, opacity: clamp(0.25 + quality.score * 0.75) },
      }];
    });
    qualitySnapshot.metadata = {
      healthySensors: prepared.sensorQuality.filter((quality) => quality.state === 'healthy').length,
      totalSensors: prepared.sensorQuality.length,
      meanQuality: mean(prepared.sensorQuality.map((quality) => quality.score)),
    };
    return [...climateSnapshots, qualitySnapshot];
  }
}
