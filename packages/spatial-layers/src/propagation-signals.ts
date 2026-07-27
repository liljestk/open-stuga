import type {
  ConnectionLayerValue,
  SpatialConnection,
  SpatialConnectionStateInterval,
  SpatialLayerEngine,
  SpatialLayerEngineInput,
  SpatialLayerEngineManifest,
  SpatialLayerSnapshot,
} from './contracts.js';

import { clamp, mean, median, pearson, robustScale } from './math.js';

import { prepareSpatialWindow, type PreparedSpatialWindow, type ZoneClimatePoint } from './series.js';

import { snapshotBase } from './snapshot.js';

import { connectionOpenFractionThroughout } from "./propagation-analysis.js";

export const PROPAGATION_CONFOUNDERS = new Set([
  'hvac-change',
  'heat-pump-change',
  'extractor-change',
  'dehumidifier-change',
  'heater-change',
  'cooking',
  'shower',
  'sauna',
  'solar-gain',
  'rapid-weather-change',
  'persistent-environmental-source',
]);

export type PropagationSignal = 'temperature' | 'humidity-ratio';

export interface ClimatePropagationEvent {
  id: string;
  zoneId: string;
  signal: PropagationSignal;
  startAt: string;
  peakAt: string;
  endAt: string;
  startIndex: number;
  peakIndex: number;
  endIndex: number;
  sign: -1 | 1;
  amplitudeZ: number;
  commonModeFraction: number;
}

export interface MatchedPropagationEvent {
  connectionId: string;
  fromZoneId: string;
  toZoneId: string;
  signal: PropagationSignal;
  sourceEventId: string;
  targetEventId: string;
  sourceAt: string;
  targetAt: string;
  lagSeconds: number;
  evidenceScore: number;
}

export interface DirectedPropagationEvidence {
  fromZoneId: string;
  toZoneId: string;
  evidenceScore: number;
  matchedEventCount: number;
  sourceEventCount: number;
  lagSeconds: number | null;
  temperatureEvidence: number;
  humidityEvidence: number;
  matches: MatchedPropagationEvent[];
}

export interface EdgePropagationEvidence {
  connection: SpatialConnection;
  forward: DirectedPropagationEvidence;
  reverse: DirectedPropagationEvidence;
  endpointCoverage: number;
}

export interface PropagationAnalysis {
  prepared: PreparedSpatialWindow;
  buckets: string[];
  events: ClimatePropagationEvent[];
  edges: EdgePropagationEvidence[];
  /** Buckets whose zone changes have a matched upstream propagation explanation. */
  explainedBucketsByZone: Map<string, Set<string>>;
}

export interface SignalSeries {
  zoneId: string;
  signal: PropagationSignal;
  buckets: string[];
  raw: number[];
  innovation: number[];
  normalized: number[];
  adjusted: number[];
  quality: number[];
  timingResolutionSeconds: number;
}

export interface PropagationConfig {
  baselineBuckets: number;
  eventThresholdZ: number;
  minimumEventBuckets: number;
  minimumLagBuckets: number;
  maximumLagBuckets: number;
  minimumDistinctEvents: number;
  displayEvidenceThreshold: number;
  directionMargin: number;
  minimumCoverage: number;
  commonModeWeight: number;
  minimumTemperatureAmplitudeC: number;
  minimumHumidityRatioAmplitudeGKg: number;
}

export function configNumber(input: SpatialLayerEngineInput, key: string, fallback: number, min: number, max: number): number {
  const value = input.config?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

export function propagationConfig(input: SpatialLayerEngineInput): PropagationConfig {
  return {
    baselineBuckets: Math.round(configNumber(input, 'propagationBaselineBuckets', 15, 3, 120)),
    eventThresholdZ: configNumber(input, 'propagationEventThresholdZ', 1.6, 0.5, 8),
    minimumEventBuckets: Math.round(configNumber(input, 'propagationMinimumEventBuckets', 2, 1, 10)),
    minimumLagBuckets: Math.round(configNumber(input, 'propagationMinimumLagBuckets', 1, 1, 10)),
    maximumLagBuckets: Math.round(configNumber(input, 'propagationMaximumLagBuckets', 20, 2, 60)),
    minimumDistinctEvents: Math.round(configNumber(input, 'propagationMinimumDistinctEvents', 2, 1, 10)),
    displayEvidenceThreshold: configNumber(input, 'propagationDisplayEvidenceThreshold', 0.42, 0.1, 0.95),
    directionMargin: configNumber(input, 'propagationDirectionMargin', 0.12, 0.02, 0.5),
    minimumCoverage: configNumber(input, 'propagationMinimumCoverage', 0.55, 0.1, 1),
    commonModeWeight: configNumber(input, 'propagationCommonModeWeight', 0.8, 0, 1),
    minimumTemperatureAmplitudeC: configNumber(input, 'propagationMinimumTemperatureAmplitudeC', 0.12, 0.01, 5),
    minimumHumidityRatioAmplitudeGKg: configNumber(input, 'propagationMinimumHumidityRatioAmplitudeGKg', 0.08, 0.005, 5),
  };
}

export function createSignalSeries(
  prepared: PreparedSpatialWindow,
  signal: PropagationSignal,
  buckets: string[],
  baselineBuckets: number,
  commonModeWeight: number,
): SignalSeries[] {
  const series: SignalSeries[] = [];
  for (const [zoneId, points] of prepared.zoneSeries) {
    const byBucket = new Map(points.map((point) => [point.bucketAt, point]));
    const raw = buckets.map((bucket) => {
      const point = byBucket.get(bucket);
      if (point === undefined) return Number.NaN;
      return signal === 'temperature' ? point.temperatureC : point.humidityRatioGKg;
    });
    const quality = buckets.map((bucket) => byBucket.get(bucket)?.quality ?? 0);
    const innovation: number[] = [];
    let baseline: number | null = null;
    const alpha = 2 / (baselineBuckets + 1);
    for (const value of raw) {
      if (!Number.isFinite(value)) {
        innovation.push(0);
        continue;
      }
      if (baseline === null) {
        baseline = value;
        innovation.push(0);
        continue;
      }
      innovation.push(value - baseline);
      baseline += alpha * (value - baseline);
    }
    const scaleSource = innovation.slice(Math.min(2, Math.floor(innovation.length / 4)));
    const scale = robustScale(scaleSource);
    const normalized = innovation.map((value) => value / scale);
    const sensorIds = new Set(points.flatMap((point) => point.sensorIds));
    const observedCadences = prepared.sensorQuality
      .filter((item) => sensorIds.has(item.sensorId) && item.observedCadenceSeconds !== null)
      .map((item) => item.observedCadenceSeconds as number);
    series.push({
      zoneId,
      signal,
      buckets,
      raw,
      innovation,
      normalized,
      adjusted: [],
      quality,
      timingResolutionSeconds: Math.max(
        prepared.resampled.bucketSeconds,
        observedCadences.length === 0 ? prepared.resampled.bucketSeconds : median(observedCadences),
      ),
    });
  }
  for (let index = 0; index < buckets.length; index += 1) {
    const common = median(series.map((item) => item.normalized[index] ?? 0));
    for (const item of series) item.adjusted[index] = (item.normalized[index] ?? 0) - commonModeWeight * common;
  }
  return series;
}

export function detectEvents(series: SignalSeries, config: PropagationConfig): ClimatePropagationEvent[] {
  const events: ClimatePropagationEvent[] = [];
  let index = 0;
  while (index < series.adjusted.length) {
    const value = series.adjusted[index] ?? 0;
    if (Math.abs(value) < config.eventThresholdZ || (series.quality[index] ?? 0) < 0.3) {
      index += 1;
      continue;
    }
    const sign: -1 | 1 = value < 0 ? -1 : 1;
    const start = index;
    let peak = index;
    let gap = 0;
    index += 1;
    while (index < series.adjusted.length) {
      const candidate = series.adjusted[index] ?? 0;
      const qualifies = Math.sign(candidate) === sign && Math.abs(candidate) >= config.eventThresholdZ * 0.55;
      if (qualifies) {
        gap = 0;
        if (Math.abs(candidate) > Math.abs(series.adjusted[peak] ?? 0)) peak = index;
      } else {
        gap += 1;
        if (gap > 1) break;
      }
      index += 1;
    }
    const end = Math.min(series.adjusted.length - 1, Math.max(start, index - gap));
    if (end - start + 1 < config.minimumEventBuckets) continue;
    const minimumRawAmplitude = series.signal === 'temperature'
      ? config.minimumTemperatureAmplitudeC
      : config.minimumHumidityRatioAmplitudeGKg;
    if (Math.abs(series.innovation[peak] ?? 0) < minimumRawAmplitude) continue;
    events.push({
      id: `${series.zoneId}:${series.signal}:${series.buckets[start] ?? start}`,
      zoneId: series.zoneId,
      signal: series.signal,
      startAt: series.buckets[start] ?? '',
      peakAt: series.buckets[peak] ?? '',
      endAt: series.buckets[end] ?? '',
      startIndex: start,
      peakIndex: peak,
      endIndex: end,
      sign,
      amplitudeZ: Math.abs(series.adjusted[peak] ?? 0),
      commonModeFraction: 0,
    });
  }
  return events;
}

export function withCommonModeFractions(
  events: ClimatePropagationEvent[],
  zoneCount: number,
  series: SignalSeries[],
  config: PropagationConfig,
): ClimatePropagationEvent[] {
  return events.map((event) => {
    const minimumRawAmplitude = event.signal === 'temperature'
      ? config.minimumTemperatureAmplitudeC
      : config.minimumHumidityRatioAmplitudeGKg;
    const simultaneousZones = series.filter((candidate) => {
      if (candidate.signal !== event.signal) return false;
      for (let index = Math.max(0, event.peakIndex - 1); index <= event.peakIndex + 1; index += 1) {
        const rawInnovation = candidate.innovation[index] ?? 0;
        if (Math.sign(rawInnovation) === event.sign && Math.abs(rawInnovation) >= minimumRawAmplitude) return true;
      }
      return false;
    }).length;
    return { ...event, commonModeFraction: zoneCount <= 1 ? 0 : clamp((simultaneousZones - 1) / (zoneCount - 1)) };
  });
}

export function segmentCorrelation(
  source: SignalSeries,
  target: SignalSeries,
  sourceEvent: ClimatePropagationEvent,
  lag: number,
  connection: SpatialConnection,
  stateIntervals?: readonly SpatialConnectionStateInterval[],
): number {
  const left: number[] = [];
  const right: number[] = [];
  const start = Math.max(1, sourceEvent.startIndex - 2);
  const end = Math.min(source.adjusted.length - 1, sourceEvent.endIndex + 3);
  for (let index = start; index <= end; index += 1) {
    const targetIndex = index + lag;
    if (targetIndex <= 0 || targetIndex >= target.adjusted.length) continue;
    const sourceAt = source.buckets[index];
    const targetAt = target.buckets[targetIndex];
    if (sourceAt === undefined || targetAt === undefined || connectionOpenFractionThroughout(
      stateIntervals,
      connection.enabled,
      sourceAt,
      targetAt,
    ) <= 0) continue;
    left.push((source.adjusted[index] ?? 0) - (source.adjusted[index - 1] ?? 0));
    right.push((target.adjusted[targetIndex] ?? 0) - (target.adjusted[targetIndex - 1] ?? 0));
  }
  return pearson(left, right);
}
