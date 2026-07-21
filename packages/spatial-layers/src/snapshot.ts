import type {
  SpatialLayerEngineInput,
  SpatialLayerMaturity,
  SpatialLayerSnapshot,
  SpatialLayerStatus,
} from './contracts.js';
import { clamp, stableDigest } from './math.js';

export interface SnapshotBaseOptions {
  layerId: string;
  modelId: string;
  modelVersion: string;
  maturity: SpatialLayerMaturity;
  status: SpatialLayerStatus;
  qualityScore: number;
  warnings?: string[];
  reasonCodes?: string[];
}

function dependencyProvenance(input: SpatialLayerEngineInput): Array<{
  engineId: string;
  modelVersion: string;
  maturity: SpatialLayerMaturity;
  scopeKind: 'house' | 'property';
  scopeId: string;
  layerId: string;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  configVersion: string;
  inputDigest: string;
  snapshotDigest: string;
}> {
  return [...(input.dependencySnapshots ?? [])]
    .map((snapshot) => ({
      engineId: snapshot.model.id,
      modelVersion: snapshot.model.version,
      maturity: snapshot.model.maturity,
      scopeKind: snapshot.scope.kind,
      scopeId: snapshot.scope.id,
      layerId: snapshot.layerId,
      generatedAt: snapshot.generatedAt,
      windowStart: snapshot.windowStart,
      windowEnd: snapshot.windowEnd,
      configVersion: snapshot.configVersion,
      inputDigest: snapshot.inputDigest,
      snapshotDigest: stableDigest(snapshot),
    }))
    .sort((left, right) => `${left.engineId}\u0000${left.layerId}`.localeCompare(`${right.engineId}\u0000${right.layerId}`));
}

export function snapshotBase(input: SpatialLayerEngineInput, options: SnapshotBaseOptions): SpatialLayerSnapshot {
  return {
    scope: input.scope,
    coordinateFrames: structuredClone(input.topology.frames),
    layerId: options.layerId,
    model: { id: options.modelId, version: options.modelVersion, maturity: options.maturity },
    generatedAt: new Date(input.generatedAt).toISOString(),
    windowStart: new Date(input.windowStart).toISOString(),
    windowEnd: new Date(input.windowEnd).toISOString(),
    status: options.status,
    configVersion: input.configVersion,
    inputDigest: stableDigest({
      scope: input.scope,
      topology: input.topology,
      connectionStateIntervals: input.connectionStateIntervals ?? [],
      samples: input.samples,
      calibrations: input.calibrations ?? [],
      contextEvents: input.contextEvents ?? [],
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      targetBucketSeconds: input.targetBucketSeconds ?? 60,
      configVersion: input.configVersion,
      config: input.config ?? {},
      dependencies: dependencyProvenance(input),
    }),
    qualityScore: clamp(options.qualityScore),
    warnings: options.warnings ?? [],
    reasonCodes: options.reasonCodes ?? [],
    zones: [],
    connections: [],
    points: [],
  };
}
