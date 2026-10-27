import type {
  ConnectionLayerValue,
  SpatialConnection,
  SpatialLayerEngine,
  SpatialLayerEngineInput,
  SpatialLayerEngineManifest,
  SpatialLayerSnapshot,
} from './contracts.js';

import { clamp } from './math.js';

import { snapshotBase } from './snapshot.js';

import { PROPAGATION_CONFOUNDERS, configNumber, propagationConfig } from "./propagation-signals.js";
import type { EdgePropagationEvidence, PropagationConfig } from "./propagation-signals.js";

import { analyseGraphPropagation } from "./propagation-analysis.js";

export function connectionValue(
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
  const { state, fromZoneId, toZoneId, direction, reasons } = classifyPropagation(edge, config, forwardScore, reverseScore);
  if (contextPenalty > 0) reasons.push('known-source-context-penalty');
  const dominant = forwardScore >= reverseScore ? forward : reverse;
  const strongestScore = Math.max(forwardScore, reverseScore);
  return {
    connectionId: connection.id,
    ...connectionGeometry(input, connection),
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
    style: connectionStyle(state, direction, strongestScore),
  };
}

type PropagationDirection = NonNullable<NonNullable<ConnectionLayerValue['style']>['direction']>;

interface PropagationClassification {
  state: ConnectionLayerValue['state'];
  fromZoneId: string | null;
  toZoneId: string | null;
  direction: PropagationDirection;
  reasons: string[];
}

function classifyPropagation(
  edge: EdgePropagationEvidence,
  config: PropagationConfig,
  forwardScore: number,
  reverseScore: number,
): PropagationClassification {
  const { forward, reverse } = edge;
  const enoughForward =
    forwardScore >= config.displayEvidenceThreshold &&
    forward.matchedEventCount >= config.minimumDistinctEvents;
  const enoughReverse =
    reverseScore >= config.displayEvidenceThreshold &&
    reverse.matchedEventCount >= config.minimumDistinctEvents;
  const undirected = (state: ConnectionLayerValue['state'], direction: PropagationDirection, reason: string): PropagationClassification => (
    { state, fromZoneId: null, toZoneId: null, direction, reasons: [reason] }
  );
  const directed = (evidence: EdgePropagationEvidence['forward'], direction: PropagationDirection): PropagationClassification => ({
    state: 'directed',
    fromZoneId: evidence.fromZoneId,
    toZoneId: evidence.toZoneId,
    direction,
    reasons: ['repeated-delayed-propagation-evidence'],
  });
  if (edge.endpointCoverage < config.minimumCoverage) {
    return undirected('insufficient-data', 'none', 'insufficient-endpoint-coverage');
  }
  if (enoughForward && enoughReverse && Math.abs(forwardScore - reverseScore) < config.directionMargin) {
    return undirected('bidirectional-evidence', 'both', 'distinct-events-support-both-directions');
  }
  if (enoughForward && forwardScore >= reverseScore + config.directionMargin) return directed(forward, 'a-to-b');
  if (enoughReverse && reverseScore >= forwardScore + config.directionMargin) return directed(reverse, 'b-to-a');
  if (forward.sourceEventCount + reverse.sourceEventCount >= config.minimumDistinctEvents) {
    return undirected('no-detectable-propagation', 'none', 'events-present-without-repeatable-edge-propagation');
  }
  return undirected('uncertain', 'none', 'no-distinct-qualifying-events');
}

// Where to draw the edge: the configured anchors, or the two zone centroids.
function connectionGeometry(
  input: SpatialLayerEngineInput,
  connection: SpatialConnection,
): Pick<ConnectionLayerValue, 'frameId' | 'anchors' | 'anchorRefs'> {
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
    ...(sharedFrame === undefined ? {} : { frameId: sharedFrame }),
    ...(anchors === undefined ? {} : { anchors }),
    ...(anchorRefs === undefined ? {} : { anchorRefs }),
  };
}

function connectionStyle(
  state: ConnectionLayerValue['state'],
  direction: PropagationDirection,
  strongestScore: number,
): NonNullable<ConnectionLayerValue['style']> {
  return {
    palette: state === 'insufficient-data' ? 'neutral' : 'air',
    direction,
    lineStyle: state === 'directed' ? 'solid' : state === 'bidirectional-evidence' ? 'dashed' : 'dotted',
    emphasis: strongestScore,
    opacity: state === 'insufficient-data' ? 0.25 : clamp(0.25 + strongestScore * 0.75),
  };
}

export class GraphPropagationEngine implements SpatialLayerEngine {
  readonly manifest: SpatialLayerEngineManifest = {
    id: 'graph-propagation',
    version: '1.1.0',
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
