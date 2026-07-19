import type {
  ConnectionLayerValue,
  SpatialConnection,
  SpatialLayerEngine,
  SpatialLayerEngineInput,
  SpatialLayerEngineManifest,
  SpatialLayerSnapshot,
} from './contracts.js';
import { clamp, mean, median, pearson, robustScale } from './math.js';
import { prepareSpatialWindow, type PreparedSpatialWindow, type ZoneClimatePoint } from './series.js';
import { snapshotBase } from './snapshot.js';

const PROPAGATION_CONFOUNDERS = new Set([
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

interface SignalSeries {
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

interface PropagationConfig {
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

function configNumber(input: SpatialLayerEngineInput, key: string, fallback: number, min: number, max: number): number {
  const value = input.config?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function propagationConfig(input: SpatialLayerEngineInput): PropagationConfig {
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

function createSignalSeries(
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

function detectEvents(series: SignalSeries, config: PropagationConfig): ClimatePropagationEvent[] {
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

function withCommonModeFractions(
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

function segmentCorrelation(source: SignalSeries, target: SignalSeries, sourceEvent: ClimatePropagationEvent, lag: number): number {
  const left: number[] = [];
  const right: number[] = [];
  const start = Math.max(1, sourceEvent.startIndex - 2);
  const end = Math.min(source.adjusted.length - 1, sourceEvent.endIndex + 3);
  for (let index = start; index <= end; index += 1) {
    const targetIndex = index + lag;
    if (targetIndex <= 0 || targetIndex >= target.adjusted.length) continue;
    left.push((source.adjusted[index] ?? 0) - (source.adjusted[index - 1] ?? 0));
    right.push((target.adjusted[targetIndex] ?? 0) - (target.adjusted[targetIndex - 1] ?? 0));
  }
  return pearson(left, right);
}

function directedEvidence(
  connection: SpatialConnection,
  fromZoneId: string,
  toZoneId: string,
  events: ClimatePropagationEvent[],
  series: SignalSeries[],
  config: PropagationConfig,
): DirectedPropagationEvidence {
  const sourceEvents = events.filter((event) => event.zoneId === fromZoneId && event.commonModeFraction < 0.75);
  const targetEvents = events.filter((event) => event.zoneId === toZoneId);
  const matches: MatchedPropagationEvent[] = [];
  const usedTargets = new Set<string>();
  for (const sourceEvent of sourceEvents) {
    const candidates = targetEvents.filter((target) => {
      const lag = target.peakIndex - sourceEvent.peakIndex;
      return (
        !usedTargets.has(target.id) &&
        target.signal === sourceEvent.signal &&
        target.sign === sourceEvent.sign &&
        lag >= config.minimumLagBuckets &&
        lag <= config.maximumLagBuckets
      );
    });
    let best: MatchedPropagationEvent | undefined;
    for (const targetEvent of candidates) {
      const lagBuckets = targetEvent.peakIndex - sourceEvent.peakIndex;
      const sourceSeries = series.find(
        (item) => item.zoneId === fromZoneId && item.signal === sourceEvent.signal,
      );
      const targetSeries = series.find(
        (item) => item.zoneId === toZoneId && item.signal === sourceEvent.signal,
      );
      if (sourceSeries === undefined || targetSeries === undefined) continue;
      const correlation = Math.max(0, segmentCorrelation(sourceSeries, targetSeries, sourceEvent, lagBuckets));
      const amplitudeRatio =
        Math.min(sourceEvent.amplitudeZ, targetEvent.amplitudeZ) /
        Math.max(sourceEvent.amplitudeZ, targetEvent.amplitudeZ, 1e-6);
      const sourceStrength = clamp((sourceEvent.amplitudeZ - config.eventThresholdZ) / 4);
      const targetStrength = clamp((targetEvent.amplitudeZ - config.eventThresholdZ) / 4);
      const sourceQuality = mean(
        sourceSeries.quality.slice(sourceEvent.startIndex, sourceEvent.endIndex + 1),
      );
      const targetQuality = mean(
        targetSeries.quality.slice(targetEvent.startIndex, targetEvent.endIndex + 1),
      );
      const commonPenalty = 1 - 0.85 * Math.max(sourceEvent.commonModeFraction, targetEvent.commonModeFraction);
      const lagSeconds = Math.max(0, (Date.parse(targetEvent.peakAt) - Date.parse(sourceEvent.peakAt)) / 1_000);
      const timingCompatibility = clamp(
        lagSeconds / Math.max(sourceSeries.timingResolutionSeconds, targetSeries.timingResolutionSeconds),
      );
      const score = clamp(
        (0.4 * correlation + 0.25 * amplitudeRatio + 0.2 * sourceStrength + 0.15 * targetStrength) *
          Math.sqrt(sourceQuality * targetQuality) *
          commonPenalty *
          timingCompatibility,
      );
      const match: MatchedPropagationEvent = {
        connectionId: connection.id,
        fromZoneId,
        toZoneId,
        signal: sourceEvent.signal,
        sourceEventId: sourceEvent.id,
        targetEventId: targetEvent.id,
        sourceAt: sourceEvent.peakAt,
        targetAt: targetEvent.peakAt,
        lagSeconds,
        evidenceScore: score,
      };
      if (best === undefined || match.evidenceScore > best.evidenceScore) best = match;
    }
    if (best !== undefined && best.evidenceScore >= 0.2) {
      matches.push(best);
      usedTargets.add(best.targetEventId);
    }
  }
  const recurrence = clamp(matches.length / config.minimumDistinctEvents);
  const score = mean(matches.map((match) => match.evidenceScore)) * recurrence;
  const bySignal = (signal: PropagationSignal): number => {
    const matching = matches.filter((match) => match.signal === signal);
    return mean(matching.map((match) => match.evidenceScore)) * clamp(matching.length / config.minimumDistinctEvents);
  };
  return {
    fromZoneId,
    toZoneId,
    evidenceScore: clamp(score),
    matchedEventCount: matches.length,
    sourceEventCount: sourceEvents.length,
    lagSeconds: matches.length === 0 ? null : median(matches.map((match) => match.lagSeconds)),
    temperatureEvidence: bySignal('temperature'),
    humidityEvidence: bySignal('humidity-ratio'),
    matches,
  };
}

export function analyseGraphPropagation(
  input: SpatialLayerEngineInput,
  existingPrepared?: PreparedSpatialWindow,
): PropagationAnalysis {
  const prepared = existingPrepared ?? prepareSpatialWindow(input);
  const config = propagationConfig(input);
  // Keep the wall-clock grid complete. Building an index only from buckets
  // that contain a reading compresses whole-house outages and invents shorter
  // propagation delays after a gap.
  const bucketMs = prepared.resampled.bucketSeconds * 1_000;
  const firstBucket = Math.ceil(Date.parse(prepared.resampled.startAt) / bucketMs) * bucketMs;
  const end = Date.parse(prepared.resampled.endAt);
  const buckets: string[] = [];
  for (let bucket = firstBucket; bucket <= end; bucket += bucketMs) {
    buckets.push(new Date(bucket).toISOString());
  }
  const signalSeries = [
    ...createSignalSeries(prepared, 'temperature', buckets, config.baselineBuckets, config.commonModeWeight),
    ...createSignalSeries(prepared, 'humidity-ratio', buckets, config.baselineBuckets, config.commonModeWeight),
  ];
  const detected = signalSeries.flatMap((series) => detectEvents(series, config));
  const events = withCommonModeFractions(detected, prepared.zoneSeries.size, signalSeries, config);
  const edges = input.topology.connections.filter((connection) => connection.enabled).map((connection) => {
    const forward = directedEvidence(
      connection,
      connection.zoneAId,
      connection.zoneBId,
      events,
      signalSeries,
      config,
    );
    const reverse = directedEvidence(
      connection,
      connection.zoneBId,
      connection.zoneAId,
      events,
      signalSeries,
      config,
    );
    const expected = Math.max(1, prepared.resampled.expectedBucketCount);
    const leftCoverage = (prepared.zoneSeries.get(connection.zoneAId)?.length ?? 0) / expected;
    const rightCoverage = (prepared.zoneSeries.get(connection.zoneBId)?.length ?? 0) / expected;
    return {
      connection,
      forward,
      reverse,
      endpointCoverage: clamp(Math.min(leftCoverage, rightCoverage)),
    };
  });
  const explainedBucketsByZone = new Map<string, Set<string>>();
  for (const edge of edges) {
    for (const match of [...edge.forward.matches, ...edge.reverse.matches]) {
      if (match.evidenceScore < config.displayEvidenceThreshold) continue;
      const event = events.find((candidate) => candidate.id === match.targetEventId);
      if (event === undefined) continue;
      const set = explainedBucketsByZone.get(match.toZoneId) ?? new Set<string>();
      for (let index = Math.max(0, event.startIndex - 1); index <= event.endIndex + 2; index += 1) {
        const bucket = buckets[index];
        if (bucket !== undefined) set.add(bucket);
      }
      explainedBucketsByZone.set(match.toZoneId, set);
    }
  }
  return { prepared, buckets, events, edges, explainedBucketsByZone };
}

function connectionValue(
  input: SpatialLayerEngineInput,
  edge: EdgePropagationEvidence,
  config: PropagationConfig,
): ConnectionLayerValue {
  const { forward, reverse, connection } = edge;
  const windowStart = Date.parse(input.windowStart);
  const windowEnd = Date.parse(input.windowEnd);
  const relevantContext = (input.contextEvents ?? []).filter((event) => {
    if (!PROPAGATION_CONFOUNDERS.has(event.kind)) return false;
    if (event.zoneIds !== undefined && !event.zoneIds.some(
      (zoneId) => zoneId === connection.zoneAId || zoneId === connection.zoneBId,
    )) return false;
    const start = Date.parse(event.startAt);
    const end = event.endAt !== undefined
      ? Date.parse(event.endAt)
      : event.kind === 'persistent-environmental-source'
        ? Number.POSITIVE_INFINITY
        : start + 15 * 60_000;
    return start <= windowEnd && end >= windowStart;
  });
  const contextPenalty = Math.max(0, ...relevantContext.map((event) => clamp(event.strength ?? 1)));
  const contextFactor = 1 - 0.75 * contextPenalty;
  const forwardScore = forward.evidenceScore * contextFactor;
  const reverseScore = reverse.evidenceScore * contextFactor;
  const enoughForward =
    forwardScore >= config.displayEvidenceThreshold &&
    forward.matchedEventCount >= config.minimumDistinctEvents;
  const enoughReverse =
    reverseScore >= config.displayEvidenceThreshold &&
    reverse.matchedEventCount >= config.minimumDistinctEvents;
  let state: ConnectionLayerValue['state'] = 'uncertain';
  let fromZoneId: string | null = null;
  let toZoneId: string | null = null;
  let direction: NonNullable<ConnectionLayerValue['style']>['direction'] = 'none';
  const reasons: string[] = [];
  if (edge.endpointCoverage < config.minimumCoverage) {
    state = 'insufficient-data';
    reasons.push('insufficient-endpoint-coverage');
  } else if (
    enoughForward &&
    enoughReverse &&
    Math.abs(forwardScore - reverseScore) < config.directionMargin
  ) {
    state = 'bidirectional-evidence';
    direction = 'both';
    reasons.push('distinct-events-support-both-directions');
  } else if (enoughForward && forwardScore >= reverseScore + config.directionMargin) {
    state = 'directed';
    fromZoneId = forward.fromZoneId;
    toZoneId = forward.toZoneId;
    direction = 'a-to-b';
    reasons.push('repeated-delayed-propagation-evidence');
  } else if (enoughReverse && reverseScore >= forwardScore + config.directionMargin) {
    state = 'directed';
    fromZoneId = reverse.fromZoneId;
    toZoneId = reverse.toZoneId;
    direction = 'b-to-a';
    reasons.push('repeated-delayed-propagation-evidence');
  } else if (forward.sourceEventCount + reverse.sourceEventCount >= config.minimumDistinctEvents) {
    state = 'no-detectable-propagation';
    reasons.push('events-present-without-repeatable-edge-propagation');
  } else {
    reasons.push('no-distinct-qualifying-events');
  }
  if (contextPenalty > 0) reasons.push('known-source-context-penalty');
  const dominant = forwardScore >= reverseScore ? forward : reverse;
  const strongestScore = Math.max(forwardScore, reverseScore);
  const zoneA = input.topology.zones.find((zone) => zone.id === connection.zoneAId);
  const zoneB = input.topology.zones.find((zone) => zone.id === connection.zoneBId);
  const sharedFrame = zoneA?.frameId === zoneB?.frameId ? zoneA?.frameId : undefined;
  const anchors = connection.anchors ??
    (zoneA !== undefined && zoneB !== undefined ? [zoneA.centroid, zoneB.centroid] : undefined);
  const anchorRefs = connection.anchors !== undefined
    ? sharedFrame === undefined
      ? undefined
      : connection.anchors.map((position) => ({ frameId: sharedFrame, position }))
    : zoneA !== undefined && zoneB !== undefined
      ? [
          { frameId: zoneA.frameId, position: zoneA.centroid },
          { frameId: zoneB.frameId, position: zoneB.centroid },
        ]
      : undefined;
  return {
    connectionId: connection.id,
    ...(sharedFrame === undefined ? {} : { frameId: sharedFrame }),
    ...(anchors === undefined ? {} : { anchors }),
    ...(anchorRefs === undefined ? {} : { anchorRefs }),
    fromZoneId,
    toZoneId,
    state,
    metrics: {
      evidenceStrength: {
        value: strongestScore,
        quality: edge.endpointCoverage,
        label: 'Propagation evidence strength',
      },
      forwardEvidenceStrength: {
        value: forwardScore,
        quality: edge.endpointCoverage,
        label: `${connection.zoneAId} to ${connection.zoneBId} evidence`,
      },
      reverseEvidenceStrength: {
        value: reverseScore,
        quality: edge.endpointCoverage,
        label: `${connection.zoneBId} to ${connection.zoneAId} evidence`,
      },
      lagSeconds: {
        value: dominant.lagSeconds,
        unit: 's',
        quality: edge.endpointCoverage,
        label: 'Median supporting-event lag',
      },
      matchedEventCount: {
        value: dominant.matchedEventCount,
        quality: edge.endpointCoverage,
        label: 'Distinct matched events',
      },
      contextPenalty: {
        value: contextPenalty,
        quality: edge.endpointCoverage,
        label: 'Known-source context penalty',
      },
    },
    evidence: [
      {
        score: forwardScore,
        kind: 'inference',
        reasonCodes: ['zone-a-to-zone-b-event-evidence'],
        details: {
          matchedEvents: forward.matchedEventCount,
          humidityEvidence: forward.humidityEvidence,
          temperatureEvidence: forward.temperatureEvidence,
        },
      },
      {
        score: reverseScore,
        kind: 'inference',
        reasonCodes: ['zone-b-to-zone-a-event-evidence'],
        details: {
          matchedEvents: reverse.matchedEventCount,
          humidityEvidence: reverse.humidityEvidence,
          temperatureEvidence: reverse.temperatureEvidence,
        },
      },
    ],
    reasonCodes: reasons,
    style: {
      palette: state === 'insufficient-data' ? 'neutral' : 'air',
      direction,
      lineStyle: state === 'directed' ? 'solid' : state === 'bidirectional-evidence' ? 'dashed' : 'dotted',
      emphasis: strongestScore,
      opacity: state === 'insufficient-data' ? 0.25 : clamp(0.25 + strongestScore * 0.75),
    },
  };
}

export class GraphPropagationEngine implements SpatialLayerEngine {
  readonly manifest: SpatialLayerEngineManifest = {
    id: 'graph-propagation',
    version: '1.0.0',
    maturity: 'experimental',
    title: 'Recent climate propagation',
    description: 'Event-conditioned, graph-constrained evidence of recent inter-zone climate propagation.',
    supportedScopes: ['house', 'property'],
    requiredMetrics: ['temperatureC', 'relativeHumidityPct'],
    producedLayerIds: ['climate.propagation.experimental'],
  };

  infer(input: SpatialLayerEngineInput): SpatialLayerSnapshot[] {
    const analysis = analyseGraphPropagation(input);
    const config = propagationConfig(input);
    const errors = analysis.prepared.validation.issues.filter((issue) => issue.severity === 'error');
    const minimumHealthySensors = Math.round(
      configNumber(input, 'minimumHealthyIndoorSensors', input.scope.kind === 'house' ? 3 : 2, 1, 20),
    );
    const status = errors.length > 0
      ? 'error'
      : analysis.prepared.healthyIndoorSensorCount < minimumHealthySensors || analysis.buckets.length < config.baselineBuckets
        ? 'insufficient_data'
        : 'ready';
    const snapshot = snapshotBase(input, {
      layerId: 'climate.propagation.experimental',
      modelId: this.manifest.id,
      modelVersion: this.manifest.version,
      maturity: this.manifest.maturity,
      status,
      qualityScore: analysis.prepared.overallQuality,
      warnings: [
        'Experimental evidence of recent climate propagation; not a measurement of current airflow or flow rate.',
        ...analysis.prepared.validation.issues.map((issue) => issue.message),
        ...(analysis.prepared.healthyIndoorSensorCount < 3 ? ['Fewer than three usable indoor sensors.'] : []),
      ],
      reasonCodes: status === 'ready' ? ['experimental-event-conditioned-inference'] : ['insufficient-climate-history'],
    });
    const connectionValues = analysis.edges.map((edge) => connectionValue(input, edge, config));
    snapshot.connections = status === 'ready'
      ? connectionValues
      : connectionValues.map((connection) => ({
          ...connection,
          fromZoneId: null,
          toZoneId: null,
          state: 'insufficient-data' as const,
          evidence: [],
          reasonCodes: ['house-level-inference-unavailable'],
          style: {
            palette: 'neutral' as const,
            direction: 'none' as const,
            lineStyle: 'dotted' as const,
            emphasis: 0,
            opacity: 0.15,
          },
        }));
    snapshot.zones = status === 'ready' ? input.topology.zones.map((zone) => {
      const sourceEvents = analysis.events.filter((event) => event.zoneId === zone.id && event.commonModeFraction < 0.75);
      const received = analysis.edges.flatMap((edge) => [...edge.forward.matches, ...edge.reverse.matches])
        .filter((match) => match.toZoneId === zone.id);
      return {
        zoneId: zone.id,
        frameId: zone.frameId,
        name: zone.name,
        ...(zone.floorId === undefined ? {} : { floorId: zone.floorId }),
        ...(zone.roomId === undefined ? {} : { roomId: zone.roomId }),
        ...(zone.polygon === undefined ? {} : { polygon: zone.polygon }),
        ...(zone.tags === undefined ? {} : { tags: zone.tags }),
        anchor: zone.centroid,
        metrics: {
          sourceEventCount: { value: sourceEvents.length, quality: analysis.prepared.overallQuality, label: 'Local source-like events' },
          receivedEventCount: { value: received.length, quality: analysis.prepared.overallQuality, label: 'Matched received events' },
          strongestSourceEvidence: {
            value: Math.max(0, ...sourceEvents.map((event) => clamp(event.amplitudeZ / 6))),
            quality: analysis.prepared.overallQuality,
            label: 'Source-like event evidence',
          },
        },
        evidence: sourceEvents.map((event) => ({
          score: clamp(event.amplitudeZ / 6),
          kind: 'inference' as const,
          reasonCodes: ['local-climate-innovation'],
          details: { signal: event.signal, peakAt: event.peakAt, commonModeFraction: event.commonModeFraction },
        })),
        reasonCodes: sourceEvents.length === 0 ? ['no-distinct-local-event'] : [],
        style: { palette: 'air' as const, opacity: clamp(0.2 + analysis.prepared.overallQuality * 0.6) },
      };
    }) : [];
    snapshot.metadata = {
      evidenceSemantics: 'uncalibrated-score-not-probability',
      physicallyCalibrated: false,
      emitsFlowRate: false,
      qualifyingEventCount: analysis.events.filter((event) => event.commonModeFraction < 0.75).length,
      bucketSeconds: analysis.prepared.resampled.bucketSeconds,
      minimumHealthyIndoorSensors: minimumHealthySensors,
    };
    return [snapshot];
  }
}
