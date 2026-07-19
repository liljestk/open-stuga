import type {
  SpatialContextEvent,
  SpatialLayerEngine,
  SpatialLayerEngineInput,
  SpatialLayerEngineManifest,
  SpatialLayerDependencySnapshot,
  SpatialLayerSnapshot,
  ZoneLayerValue,
} from './contracts.js';
import { clamp, mean, stableDigest } from './math.js';
import {
  analyseGraphPropagation,
  type ClimatePropagationEvent,
  type PropagationAnalysis,
} from './propagation.js';
import { snapshotBase } from './snapshot.js';

const CONFOUNDING_CONTEXT = new Set<SpatialContextEvent['kind']>([
  'door-open',
  'window-open',
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

interface ActivityCandidate {
  events: ClimatePropagationEvent[];
  heatResidualZ: number;
  moistureResidualZ: number;
  persistenceFraction: number;
  airExplainedFraction: number;
  contextPenalty: number;
  recency: number;
  score: number;
  reasonCodes: string[];
}

const GRAPH_ENGINE_ID = 'graph-propagation';
const GRAPH_LAYER_ID = 'climate.propagation.experimental';

function inputNumber(input: SpatialLayerEngineInput, key: string, fallback: number, minimum: number, maximum: number): number {
  const value = input.config?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, minimum, maximum) : fallback;
}

function requiredGraphDependency(input: SpatialLayerEngineInput): SpatialLayerDependencySnapshot {
  const matching = (input.dependencySnapshots ?? []).filter(
    (snapshot) => snapshot.model.id === GRAPH_ENGINE_ID && snapshot.layerId === GRAPH_LAYER_ID,
  );
  if (matching.length !== 1) {
    throw new Error(`Engine unexplained-activity requires exactly one ${GRAPH_ENGINE_ID} dependency snapshot`);
  }
  const dependency = matching[0];
  if (dependency === undefined) throw new Error(`Missing ${GRAPH_ENGINE_ID} dependency snapshot`);
  if (dependency.scope.kind !== input.scope.kind || dependency.scope.id !== input.scope.id) {
    throw new Error(`${GRAPH_ENGINE_ID} dependency scope does not match activity input`);
  }
  if (Date.parse(dependency.generatedAt) !== Date.parse(input.generatedAt)) {
    throw new Error(`${GRAPH_ENGINE_ID} dependency inference time does not match activity input`);
  }
  if (dependency.configVersion !== input.configVersion) {
    throw new Error(`${GRAPH_ENGINE_ID} dependency configuration version does not match activity input`);
  }
  return dependency;
}

function metricNumber(
  dependency: SpatialLayerDependencySnapshot,
  connectionId: string,
  metricId: string,
): { value: number; quality: number } | null {
  const metric = dependency.connections.find((connection) => connection.connectionId === connectionId)?.metrics[metricId];
  return metric !== undefined && typeof metric.value === 'number' && Number.isFinite(metric.value)
    ? { value: metric.value, quality: metric.quality }
    : null;
}

/**
 * Interpret only the graph layer's standardized, qualified connection output.
 * A directed edge can explain its receiving zone; bidirectional evidence can
 * explain either endpoint. Evidence below the graph display threshold remains
 * partial and never becomes a people/occupancy probability.
 */
function graphAirExplainedFraction(
  input: SpatialLayerEngineInput,
  dependency: SpatialLayerDependencySnapshot,
  zoneId: string,
): number {
  if (dependency.status !== 'ready') return 0;
  const threshold = inputNumber(input, 'propagationDisplayEvidenceThreshold', 0.42, 0.1, 0.95);
  const strengths = dependency.connections.flatMap((connection) => {
    const topologyConnection = input.topology.connections.find((candidate) => candidate.id === connection.connectionId);
    const applies = connection.state === 'directed'
      ? connection.toZoneId === zoneId
      : connection.state === 'bidirectional-evidence' && topologyConnection !== undefined &&
        (topologyConnection.zoneAId === zoneId || topologyConnection.zoneBId === zoneId);
    if (!applies) return [];
    const strength = metricNumber(dependency, connection.connectionId, 'evidenceStrength');
    if (strength === null) return [];
    const context = metricNumber(dependency, connection.connectionId, 'contextPenalty');
    const qualified = strength.value * clamp(strength.quality) * (1 - clamp(context?.value ?? 0));
    return [clamp(qualified / threshold)];
  });
  return Math.max(0, ...strengths);
}

function contextPenalty(
  input: SpatialLayerEngineInput,
  zoneId: string,
  events: readonly ClimatePropagationEvent[],
): { penalty: number; reasons: string[] } {
  const start = Math.min(...events.map((event) => Date.parse(event.startAt)));
  const end = Math.max(...events.map((event) => Date.parse(event.endAt)));
  const overlapping = (input.contextEvents ?? []).filter((context) => {
    if (!CONFOUNDING_CONTEXT.has(context.kind)) return false;
    if (context.zoneIds !== undefined && !context.zoneIds.includes(zoneId)) return false;
    const contextStart = Date.parse(context.startAt);
    const contextEnd = context.endAt !== undefined
      ? Date.parse(context.endAt)
      : context.kind === 'persistent-environmental-source'
        ? Number.POSITIVE_INFINITY
        : contextStart + 15 * 60_000;
    return start <= contextEnd && contextStart <= end;
  });
  if (overlapping.length === 0) return { penalty: 0, reasons: [] };
  const maximum = Math.max(...overlapping.map((context) => clamp(context.strength ?? 1)));
  return {
    penalty: maximum,
    reasons: overlapping.map((context) => `context-${context.kind}`),
  };
}

function candidateForEvents(
  input: SpatialLayerEngineInput,
  analysis: PropagationAnalysis,
  zoneId: string,
  events: ClimatePropagationEvent[],
  airExplained: number,
): ActivityCandidate {
  const heat = Math.max(0, ...events.filter((event) => event.signal === 'temperature' && event.sign > 0).map((event) => event.amplitudeZ));
  const moisture = Math.max(
    0,
    ...events.filter((event) => event.signal === 'humidity-ratio' && event.sign > 0).map((event) => event.amplitudeZ),
  );
  const minimumSustainedBuckets = Math.round(inputNumber(input, 'activityMinimumSustainedBuckets', 3, 2, 20));
  const persistence = clamp(
    Math.max(...events.map((event) => event.endIndex - event.startIndex + 1), 0) / minimumSustainedBuckets,
  );
  const context = contextPenalty(input, zoneId, events);
  const lastIndex = Math.max(...events.map((event) => event.endIndex));
  const maximumAge = Math.round(inputNumber(input, 'activityMaximumAgeBuckets', 30, 3, 120));
  const recency = clamp(1 - (analysis.buckets.length - 1 - lastIndex) / maximumAge);
  const pairedEvidence = heat > 0 && moisture > 0 ? 1 : 0.45;
  const rawStrength =
    0.32 * clamp(heat / 5) +
    0.32 * clamp(moisture / 5) +
    0.22 * persistence +
    0.14 * pairedEvidence;
  const score = clamp(rawStrength * recency * (1 - airExplained) * (1 - context.penalty));
  const reasons = [
    ...(heat > 0 ? ['local-positive-heat-residual'] : []),
    ...(moisture > 0 ? ['local-positive-moisture-residual'] : []),
    ...(heat > 0 && moisture > 0 ? ['coincident-heat-and-moisture'] : []),
    ...(persistence >= 1 ? ['sustained-local-residual'] : ['short-lived-residual']),
    ...(airExplained > 0 ? ['masked-by-air-propagation'] : ['not-matched-to-air-propagation']),
    ...context.reasons,
  ];
  return {
    events,
    heatResidualZ: heat,
    moistureResidualZ: moisture,
    persistenceFraction: persistence,
    airExplainedFraction: airExplained,
    contextPenalty: context.penalty,
    recency,
    score,
    reasonCodes: reasons,
  };
}

function zoneCandidate(
  input: SpatialLayerEngineInput,
  analysis: PropagationAnalysis,
  zoneId: string,
  graphDependency: SpatialLayerDependencySnapshot,
): ActivityCandidate | null {
  const maximumAge = Math.round(inputNumber(input, 'activityMaximumAgeBuckets', 30, 3, 120));
  const recentStart = Math.max(0, analysis.buckets.length - maximumAge);
  const local = analysis.events.filter(
    (event) =>
      event.zoneId === zoneId &&
      event.sign > 0 &&
      event.commonModeFraction < 0.6 &&
      event.endIndex >= recentStart,
  );
  if (local.length === 0) return null;

  const groups: ClimatePropagationEvent[][] = [];
  const consumed = new Set<string>();
  for (const event of local) {
    if (consumed.has(event.id)) continue;
    const peers = local.filter(
      (candidate) =>
        !consumed.has(candidate.id) &&
        Math.abs(candidate.peakIndex - event.peakIndex) <= 5 &&
        candidate.signal !== event.signal,
    );
    const group = [event, ...(peers[0] === undefined ? [] : [peers[0]])];
    for (const member of group) consumed.add(member.id);
    groups.push(group);
  }
  const airExplained = graphAirExplainedFraction(input, graphDependency, zoneId);
  return groups
    .map((events) => candidateForEvents(input, analysis, zoneId, events, airExplained))
    .sort((left, right) => right.score - left.score)[0] ?? null;
}

function zoneValue(
  input: SpatialLayerEngineInput,
  analysis: PropagationAnalysis,
  zoneId: string,
  graphDependency: SpatialLayerDependencySnapshot,
): ZoneLayerValue {
  const zone = input.topology.zones.find((candidate) => candidate.id === zoneId);
  const zonePoints = analysis.prepared.zoneSeries.get(zoneId) ?? [];
  const zoneQuality = mean(zonePoints.map((point) => point.quality));
  const candidate = zoneCandidate(input, analysis, zoneId, graphDependency);
  const evidenceScore = clamp((candidate?.score ?? 0) * zoneQuality);
  const state = zoneQuality < 0.35
    ? 'unknown'
    : evidenceScore >= 0.7
      ? 'strong-unexplained-signal'
      : evidenceScore >= 0.4
        ? 'possible-unexplained-signal'
        : 'no-clear-signal';
  const reasonCodes = candidate?.reasonCodes ?? ['no-recent-local-residual'];
  return {
    zoneId,
    frameId: zone?.frameId ?? input.topology.frames[0]?.id ?? 'unknown',
    ...(zone === undefined ? {} : {
      name: zone.name,
      ...(zone.floorId === undefined ? {} : { floorId: zone.floorId }),
      ...(zone.roomId === undefined ? {} : { roomId: zone.roomId }),
      ...(zone.polygon === undefined ? {} : { polygon: zone.polygon }),
      ...(zone.tags === undefined ? {} : { tags: zone.tags }),
      anchor: zone.centroid,
    }),
    metrics: {
      activityEvidenceScore: {
        value: evidenceScore,
        quality: zoneQuality,
        label: 'Unexplained activity evidence (not a probability)',
      },
      state: { value: state, quality: zoneQuality, label: 'Unexplained climate activity state' },
      localHeatResidualZ: {
        value: candidate?.heatResidualZ ?? 0,
        quality: zoneQuality,
        label: 'Local heat residual',
      },
      localMoistureResidualZ: {
        value: candidate?.moistureResidualZ ?? 0,
        quality: zoneQuality,
        label: 'Local moisture residual',
      },
      persistenceFraction: {
        value: candidate?.persistenceFraction ?? 0,
        quality: zoneQuality,
        label: 'Residual persistence',
      },
      airExplainedFraction: {
        value: candidate?.airExplainedFraction ?? 0,
        quality: zoneQuality,
        label: 'Fraction matched to air propagation',
      },
      contextPenalty: {
        value: candidate?.contextPenalty ?? 0,
        quality: zoneQuality,
        label: 'Known-source penalty',
      },
    },
    evidence: candidate === null
      ? []
      : [{
          score: evidenceScore,
          kind: 'inference',
          reasonCodes,
          details: {
            eventCount: candidate.events.length,
            recency: candidate.recency,
            airExplainedFraction: candidate.airExplainedFraction,
            contextPenalty: candidate.contextPenalty,
          },
        }],
    reasonCodes,
    style: {
      palette: state === 'unknown' ? 'neutral' : 'activity',
      opacity: state === 'unknown' ? 0.2 : clamp(0.15 + evidenceScore * 0.85),
      emphasis: evidenceScore,
    },
  };
}

export class UnexplainedActivityEngine implements SpatialLayerEngine {
  readonly manifest: SpatialLayerEngineManifest = {
    id: 'unexplained-activity',
    version: '1.1.0',
    maturity: 'research',
    title: 'Unexplained climate activity',
    description: 'Sustained local climate residual evidence after matched propagation and known-source masking.',
    supportedScopes: ['house', 'property'],
    requiredMetrics: ['temperatureC', 'relativeHumidityPct'],
    producedLayerIds: ['climate.unexplained-activity.research'],
    dependencies: ['graph-propagation'],
  };

  infer(input: SpatialLayerEngineInput): SpatialLayerSnapshot[] {
    const graphDependency = requiredGraphDependency(input);
    const analysis = analyseGraphPropagation(input);
    const errors = analysis.prepared.validation.issues.filter((issue) => issue.severity === 'error');
    const minimumHealthySensors = Math.round(
      inputNumber(input, 'minimumHealthyIndoorSensors', input.scope.kind === 'house' ? 3 : 2, 1, 20),
    );
    const status = errors.length > 0 || graphDependency.status === 'error'
      ? 'error'
      : graphDependency.status !== 'ready' || analysis.prepared.healthyIndoorSensorCount < minimumHealthySensors || analysis.buckets.length < 15
        ? 'insufficient_data'
        : 'ready';
    const snapshot = snapshotBase(input, {
      layerId: 'climate.unexplained-activity.research',
      modelId: this.manifest.id,
      modelVersion: this.manifest.version,
      maturity: this.manifest.maturity,
      status,
      qualityScore: analysis.prepared.overallQuality,
      warnings: [
        'Research signal inferred from climate residuals; it is not a motion detector or occupancy probability.',
        'This engine never emits people trails, identities, or occupant counts.',
        ...analysis.prepared.validation.issues.map((issue) => issue.message),
      ],
      reasonCodes: status === 'ready' ? ['research-residual-evidence'] : ['insufficient-climate-history'],
    });
    snapshot.zones = status === 'ready'
      ? input.topology.zones.map((zone) => zoneValue(input, analysis, zone.id, graphDependency))
      : input.topology.zones.map((zone) => ({
          zoneId: zone.id,
          frameId: zone.frameId,
          name: zone.name,
          ...(zone.floorId === undefined ? {} : { floorId: zone.floorId }),
          ...(zone.roomId === undefined ? {} : { roomId: zone.roomId }),
          ...(zone.polygon === undefined ? {} : { polygon: zone.polygon }),
          ...(zone.tags === undefined ? {} : { tags: zone.tags }),
          anchor: zone.centroid,
          metrics: {
            activityEvidenceScore: {
              value: 0,
              quality: 0,
              label: 'Unexplained activity evidence unavailable',
            },
            state: { value: 'unknown', quality: 0, label: 'Unexplained climate activity state' },
          },
          evidence: [],
          reasonCodes: ['house-level-inference-unavailable'],
          style: { palette: 'neutral' as const, opacity: 0.15, emphasis: 0 },
        }));
    snapshot.connections = [];
    snapshot.points = [];
    snapshot.metadata = {
      evidenceSemantics: 'uncalibrated-score-not-probability',
      emitsPeopleTrails: false,
      emitsOccupantCount: false,
      emitsIdentity: false,
      airMaskApplied: true,
      contextMaskApplied: true,
      propagationDependencyModelVersion: graphDependency.model.version,
      propagationDependencyInputDigest: graphDependency.inputDigest,
      propagationDependencySnapshotDigest: stableDigest(graphDependency),
      minimumHealthyIndoorSensors: minimumHealthySensors,
    };
    return [snapshot];
  }
}
