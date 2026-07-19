import type {
  CoordinateFrame as CanonicalCoordinateFrame,
  SpatialContextEvent,
  SpatialLayerEngineHealth as CanonicalEngineHealth,
  SpatialLayerEngineManifest as CanonicalEngineManifest,
  SpatialLayerSnapshot as CanonicalLayerSnapshot,
  SpatialSensorBinding,
  SpatialSensorCalibration,
  SpatialTopology,
} from "@climate-twin/spatial-layers";

export type { SpatialContextEvent, SpatialSensorBinding, SpatialSensorCalibration, SpatialTopology };
export type SpatialCoordinateFrame = CanonicalCoordinateFrame;

/**
 * Browser-facing view of the optional spatial-layer engine contracts.
 *
 * The engine is deliberately capability-discovered. These structures are
 * tolerant of older experimental snapshots so an engine upgrade cannot make
 * the core Home or Properties pages unavailable.
 */
export type SpatialLayerMaturity = "research" | "experimental" | "stable";
export type SpatialLayerScopeKind = "house" | "property";
export type SpatialLayerStatus = "ready" | "warming_up" | "insufficient_data" | "error";

export interface SpatialLayerScope {
  kind: SpatialLayerScopeKind;
  id: string;
}

export interface SpatialLayerMetric {
  value: number | string | boolean | null;
  unit?: string;
  normalized?: number;
  label?: string;
  quality?: number;
}

export interface SpatialLayerEvidence {
  confidence?: number;
  quality?: number;
  strength?: number;
  reasonCodes?: string[];
}

export interface SpatialLayerStyleHint {
  emphasis?: number;
  opacity?: number;
  line?: "solid" | "dashed" | "dotted";
  direction?: "forward" | "reverse" | "both" | "none";
  palette?: "temperature" | "humidity" | "quality" | "propagation" | "activity" | "neutral";
}

export interface SpatialLayerPoint {
  id: string;
  frameId?: string;
  floorId?: string;
  zoneId?: string;
  houseId?: string;
  label?: string;
  x?: number;
  y?: number;
  z?: number;
  latitude?: number;
  longitude?: number;
  metrics: Record<string, SpatialLayerMetric>;
  evidence?: SpatialLayerEvidence;
  style?: SpatialLayerStyleHint;
  reasonCodes?: string[];
}

export interface SpatialLayerZone {
  zoneId: string;
  frameId?: string;
  floorId?: string;
  roomId?: string;
  houseId?: string;
  label?: string;
  tags?: string[];
  polygon?: Array<{ x: number; y: number }>;
  centroid?: { x: number; y: number; z?: number };
  metrics: Record<string, SpatialLayerMetric>;
  evidence?: SpatialLayerEvidence;
  style?: SpatialLayerStyleHint;
  reasonCodes?: string[];
}

export interface SpatialLayerConnection {
  connectionId: string;
  frameId?: string;
  floorId?: string;
  fromZoneId?: string;
  toZoneId?: string;
  from?: { x: number; y: number; z?: number; floorId?: string };
  to?: { x: number; y: number; z?: number; floorId?: string };
  anchorRefs?: Array<{ frameId: string; position: { x: number; y: number; z?: number } }>;
  state?: "directed" | "bidirectional" | "no_detectable_propagation" | "insufficient_data" | "uncertain";
  metrics: Record<string, SpatialLayerMetric>;
  evidence?: SpatialLayerEvidence;
  style?: SpatialLayerStyleHint;
  reasonCodes?: string[];
}

export interface SpatialLayerSnapshot {
  id?: string;
  revision?: number;
  scope: SpatialLayerScope;
  /** Coordinate definitions captured with this exact revision for deterministic replay. */
  coordinateFrames: SpatialCoordinateFrame[];
  layerId: string;
  model: { id: string; version: string; maturity: SpatialLayerMaturity };
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  status: SpatialLayerStatus;
  configVersion: string;
  inputDigest: string;
  qualityScore: number;
  staleAfterSeconds?: number;
  warnings: string[];
  reasonCodes: string[];
  zones: SpatialLayerZone[];
  connections: SpatialLayerConnection[];
  points: SpatialLayerPoint[];
}

export interface SpatialLayerEngineManifest {
  id: string;
  version: string;
  name?: string;
  title?: string;
  description?: string;
  maturity: SpatialLayerMaturity;
  supportedScopes: SpatialLayerScopeKind[];
  requiredMetrics: string[];
  layerIds: string[];
  enabled?: boolean;
  defaultEnabled?: boolean;
}

export interface SpatialLayerEngineHealth {
  engineId: string;
  layerId?: string;
  state: "healthy" | "learning_baseline" | "degraded_sensor_data" | "configuration_incomplete" | "calibration_stale" | "model_drift" | "disabled" | "error";
  checkedAt?: string;
  reasonCodes?: string[];
  message?: string;
}

export interface SpatialLayerSnapshotEvent {
  scope: SpatialLayerScope;
  /** Older engine notifications identify a layer; host notifications identify snapshot IDs. */
  layerId?: string;
  snapshotIds?: string[];
  generatedAt: string;
  revision?: number;
}

export interface SpatialLayerAssignment {
  engineId: string;
  engineVersion: string;
  enabled: boolean;
  layerIds: string[];
}

export interface SpatialLayerConfigurationDocument {
  version: number;
  enabled: boolean;
  config: Record<string, unknown>;
  topology?: SpatialTopology;
  updatedAt?: string;
}

export interface SpatialLayerConfigurationResponse {
  configuration: SpatialLayerConfigurationDocument;
  assignments: SpatialLayerAssignment[];
  topology?: SpatialTopology;
}

export interface SpatialGroundTruth {
  id: string;
  startAt: string;
  endAt?: string;
  label: "house_empty" | "people_present" | "zone_active" | "transition" | "false_positive" | "unknown";
  zoneId?: string;
  fromZoneId?: string;
  toZoneId?: string;
  source: "user" | "optional_sensor" | "controlled_test";
  createdAt?: string;
}

export type SpatialCalibrationSessionKind = "co-location" | "controlled-propagation" | "empty-house-baseline";
export type SpatialCalibrationSessionStatus = "planned" | "running" | "completed" | "cancelled";

/**
 * UI-facing calibration workflow record. It deliberately mirrors only the
 * stable host fields and tolerates absent metadata from earlier engine hosts.
 */
export interface SpatialCalibrationSession {
  id: string;
  houseId?: string;
  kind: SpatialCalibrationSessionKind;
  status: SpatialCalibrationSessionStatus;
  startAt: string;
  endAt: string | null;
  intervention: Record<string, unknown>;
  notes: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface SpatialCalibrationSessionInput {
  kind: SpatialCalibrationSessionKind;
  status: SpatialCalibrationSessionStatus;
  startAt: string;
  endAt?: string | null;
  intervention?: Record<string, unknown>;
  notes?: string | null;
}

export interface SpatialCalibrationSessionResult {
  session: SpatialCalibrationSession;
  calibrations: SpatialSensorCalibration[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function arrayFromPayload(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const candidate = record(value);
  if (!candidate) return [];
  for (const key of keys) if (Array.isArray(candidate[key])) return candidate[key] as unknown[];
  return [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function calibrationSession(value: unknown): SpatialCalibrationSession | null {
  const candidate = record(value);
  if (!candidate || typeof candidate.id !== "string" || typeof candidate.startAt !== "string") return null;
  if (candidate.kind !== "co-location" && candidate.kind !== "controlled-propagation" && candidate.kind !== "empty-house-baseline") return null;
  if (candidate.status !== "planned" && candidate.status !== "running" && candidate.status !== "completed" && candidate.status !== "cancelled") return null;
  const intervention = record(candidate.intervention) ?? {};
  return {
    id: candidate.id,
    ...(typeof candidate.houseId === "string" ? { houseId: candidate.houseId } : {}),
    kind: candidate.kind,
    status: candidate.status,
    startAt: candidate.startAt,
    endAt: typeof candidate.endAt === "string" ? candidate.endAt : null,
    intervention,
    notes: typeof candidate.notes === "string" ? candidate.notes : null,
    ...(typeof candidate.createdAt === "string" ? { createdAt: candidate.createdAt } : {}),
    ...(typeof candidate.updatedAt === "string" ? { updatedAt: candidate.updatedAt } : {}),
  };
}

export function spatialCalibrationSessions(value: unknown): SpatialCalibrationSession[] {
  return arrayFromPayload(value, ["sessions", "data"])
    .map(calibrationSession)
    .filter((item): item is SpatialCalibrationSession => item !== null);
}

export function spatialCalibrationSessionResult(value: unknown): SpatialCalibrationSessionResult | null {
  const payload = record(value);
  const session = calibrationSession(payload?.session ?? value);
  if (!session) return null;
  const calibrations = arrayFromPayload(value, ["calibrations"]).filter((item): item is SpatialSensorCalibration => {
    const candidate = record(item);
    return typeof candidate?.sensorId === "string" && typeof candidate.validFrom === "string"
      && typeof candidate.temperatureOffsetC === "number" && typeof candidate.humidityOffsetPct === "number"
      && typeof candidate.confidence === "number" && typeof candidate.method === "string";
  });
  return { session, calibrations };
}

function metrics(value: unknown): Record<string, SpatialLayerMetric> {
  const candidate = record(value);
  if (!candidate) return {};
  return Object.fromEntries(Object.entries(candidate).flatMap(([key, raw]) => {
    const metric = record(raw);
    if (!metric) return [];
    const metricValue = metric?.value;
    if (!(metricValue === null || typeof metricValue === "number" || typeof metricValue === "string" || typeof metricValue === "boolean")) return [];
    const result: SpatialLayerMetric = { value: metricValue };
    if (typeof metric.unit === "string") result.unit = metric.unit;
    if (typeof metric.label === "string") result.label = metric.label;
    const quality = finiteUnit(metric.quality);
    if (quality !== null) result.quality = quality;
    const normalized = finiteUnit(metric.normalized);
    if (normalized !== null) result.normalized = normalized;
    return [[key, result]];
  }));
}

function evidence(value: unknown, metricValues: Record<string, SpatialLayerMetric>): SpatialLayerEvidence {
  const entries = Array.isArray(value) ? value.map(record).filter((item): item is Record<string, unknown> => item !== null) : [record(value)].filter((item): item is Record<string, unknown> => item !== null);
  const scores = entries.flatMap((item) => number(item.score) ?? number(item.confidence) ?? number(item.strength) ?? []);
  const qualities = Object.values(metricValues).flatMap((metric) => metric.quality ?? []);
  const quality = finiteUnit(Math.max(0, ...qualities));
  const strength = finiteUnit(Math.max(0, ...scores));
  return {
    confidence: finiteUnit(Math.max(0, ...scores, ...qualities)) ?? 0,
    ...(qualities.length && quality !== null ? { quality } : {}),
    ...(scores.length && strength !== null ? { strength } : {}),
    reasonCodes: [...new Set(entries.flatMap((item) => strings(item.reasonCodes)))],
  };
}

function point(value: unknown): { x: number; y: number; z?: number } | undefined {
  const candidate = record(value);
  const x = number(candidate?.x);
  const y = number(candidate?.y);
  const z = number(candidate?.z);
  if (x === undefined || y === undefined) return undefined;
  return z === undefined ? { x, y } : { x, y, z };
}

function style(value: unknown): SpatialLayerStyleHint | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  const direction = candidate.direction === "a-to-b" ? "forward"
    : candidate.direction === "b-to-a" ? "reverse"
      : candidate.direction === "both" ? "both"
        : "none";
  const palette = candidate.palette === "air" ? "propagation" : candidate.palette;
  return {
    ...(number(candidate.emphasis) !== undefined ? { emphasis: number(candidate.emphasis)! } : {}),
    ...(finiteUnit(candidate.opacity) !== null ? { opacity: finiteUnit(candidate.opacity)! } : {}),
    ...(candidate.lineStyle === "solid" || candidate.lineStyle === "dashed" || candidate.lineStyle === "dotted" ? { line: candidate.lineStyle } : {}),
    direction,
    ...(palette === "temperature" || palette === "humidity" || palette === "quality" || palette === "propagation" || palette === "activity" || palette === "neutral" ? { palette } : {}),
  };
}

function zone(value: unknown): SpatialLayerZone | null {
  const candidate = record(value);
  if (!candidate || typeof candidate.zoneId !== "string") return null;
  const metricValues = metrics(candidate.metrics);
  const anchor = point(candidate.anchor ?? candidate.centroid);
  const polygon = Array.isArray(candidate.polygon) ? candidate.polygon.flatMap((item) => {
    const positioned = point(item);
    return positioned ? [{ x: positioned.x, y: positioned.y }] : [];
  }) : undefined;
  const styleHint = style(candidate.style);
  return {
    zoneId: candidate.zoneId,
    ...(typeof candidate.frameId === "string" ? { frameId: candidate.frameId } : {}),
    ...(typeof candidate.floorId === "string" ? { floorId: candidate.floorId } : {}),
    ...(typeof candidate.roomId === "string" ? { roomId: candidate.roomId } : {}),
    ...(typeof candidate.houseId === "string" ? { houseId: candidate.houseId } : {}),
    ...(typeof candidate.name === "string" ? { label: candidate.name } : typeof candidate.label === "string" ? { label: candidate.label } : {}),
    ...(strings(candidate.tags).length ? { tags: strings(candidate.tags) } : {}),
    ...(polygon?.length ? { polygon } : {}),
    ...(anchor ? { centroid: anchor } : {}),
    metrics: metricValues,
    evidence: evidence(candidate.evidence, metricValues),
    ...(styleHint ? { style: styleHint } : {}),
    reasonCodes: strings(candidate.reasonCodes),
  };
}

function connection(value: unknown): SpatialLayerConnection | null {
  const candidate = record(value);
  if (!candidate || typeof candidate.connectionId !== "string") return null;
  const metricValues = metrics(candidate.metrics);
  const anchors = Array.isArray(candidate.anchors) ? candidate.anchors.flatMap((item) => point(item) ?? []) : [];
  const rawState = candidate.state;
  const state = rawState === "bidirectional-evidence" || rawState === "bidirectional" ? "bidirectional"
    : rawState === "no-detectable-propagation" || rawState === "no_detectable_propagation" ? "no_detectable_propagation"
      : rawState === "insufficient-data" || rawState === "insufficient_data" ? "insufficient_data"
      : rawState === "directed" ? "directed" : "uncertain";
  const anchorRefs = Array.isArray(candidate.anchorRefs) ? candidate.anchorRefs.flatMap((item) => {
    const anchor = record(item);
    const position = point(anchor?.position);
    return typeof anchor?.frameId === "string" && position ? [{ frameId: anchor.frameId, position }] : [];
  }) : [];
  const from = anchors[0] ?? point(candidate.from);
  const to = anchors.at(-1) ?? point(candidate.to);
  const styleHint = style(candidate.style);
  return {
    connectionId: candidate.connectionId,
    ...(typeof candidate.frameId === "string" ? { frameId: candidate.frameId } : {}),
    ...(typeof candidate.floorId === "string" ? { floorId: candidate.floorId } : {}),
    ...(typeof candidate.fromZoneId === "string" ? { fromZoneId: candidate.fromZoneId } : {}),
    ...(typeof candidate.toZoneId === "string" ? { toZoneId: candidate.toZoneId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(anchorRefs.length ? { anchorRefs } : {}),
    state,
    metrics: metricValues,
    evidence: evidence(candidate.evidence, metricValues),
    ...(styleHint ? { style: styleHint } : {}),
    reasonCodes: strings(candidate.reasonCodes),
  };
}

function layerPoint(value: unknown): SpatialLayerPoint | null {
  const candidate = record(value);
  const id = typeof candidate?.pointId === "string" ? candidate.pointId : typeof candidate?.id === "string" ? candidate.id : null;
  const position = point(candidate?.position) ?? point(candidate);
  if (!candidate || !id || !position) return null;
  const metricValues = metrics(candidate.metrics);
  const styleHint = style(candidate.style);
  return {
    id,
    ...(typeof candidate.frameId === "string" ? { frameId: candidate.frameId } : {}),
    ...(typeof candidate.floorId === "string" ? { floorId: candidate.floorId } : {}),
    ...(typeof candidate.zoneId === "string" ? { zoneId: candidate.zoneId } : {}),
    ...(typeof candidate.houseId === "string" ? { houseId: candidate.houseId } : {}),
    ...(typeof candidate.label === "string" ? { label: candidate.label } : {}),
    ...position,
    metrics: metricValues,
    evidence: evidence(candidate.evidence, metricValues),
    ...(styleHint ? { style: styleHint } : {}),
    reasonCodes: strings(candidate.reasonCodes),
  };
}

function snapshot(value: unknown): SpatialLayerSnapshot | null {
  const candidate = record(value);
  const scope = record(candidate?.scope);
  const model = record(candidate?.model);
  if (!candidate || typeof candidate.layerId !== "string" || typeof candidate.generatedAt !== "string"
    || (scope?.kind !== "house" && scope?.kind !== "property") || typeof scope.id !== "string") return null;
  const canonical = value as CanonicalLayerSnapshot;
  const metadata = record(candidate.metadata);
  return {
    ...(typeof metadata?.snapshotId === "string" ? { id: metadata.snapshotId } : {}),
    ...(number(metadata?.revision) !== undefined ? { revision: number(metadata?.revision)! } : {}),
    scope: { kind: scope.kind, id: scope.id },
    coordinateFrames: Array.isArray(candidate.coordinateFrames) ? candidate.coordinateFrames.flatMap((item) => {
      const frame = record(item);
      if (!frame || typeof frame.id !== "string" || typeof frame.version !== "string"
        || (frame.kind !== "floor-plan-2d" && frame.kind !== "building-local-3d" && frame.kind !== "property-local-3d" && frame.kind !== "geographic")
        || (frame.unit !== "normalized" && frame.unit !== "m" && frame.unit !== "degrees")) return [];
      const origin = point(frame.origin);
      return [{
        id: frame.id,
        version: frame.version,
        kind: frame.kind,
        unit: frame.unit,
        ...(origin?.z !== undefined ? { origin: { x: origin.x, y: origin.y, z: origin.z } } : {}),
        ...(typeof frame.floorId === "string" ? { floorId: frame.floorId } : {}),
        ...(number(frame.rotationDegrees) !== undefined ? { rotationDegrees: number(frame.rotationDegrees)! } : {}),
      } satisfies SpatialCoordinateFrame];
    }) : [],
    layerId: candidate.layerId,
    model: {
      id: typeof model?.id === "string" ? model.id : "unknown",
      version: typeof model?.version === "string" ? model.version : "unknown",
      maturity: model?.maturity === "stable" || model?.maturity === "experimental" ? model.maturity : "research",
    },
    generatedAt: candidate.generatedAt,
    windowStart: typeof candidate.windowStart === "string" ? candidate.windowStart : candidate.generatedAt,
    windowEnd: typeof candidate.windowEnd === "string" ? candidate.windowEnd : candidate.generatedAt,
    status: canonical.status === "ready" || canonical.status === "warming_up" || canonical.status === "insufficient_data" ? canonical.status : "error",
    configVersion: typeof candidate.configVersion === "string" ? candidate.configVersion : "unknown",
    inputDigest: typeof candidate.inputDigest === "string" ? candidate.inputDigest : "",
    qualityScore: finiteUnit(candidate.qualityScore) ?? 0,
    ...(number(metadata?.staleAfterSeconds) !== undefined ? { staleAfterSeconds: number(metadata?.staleAfterSeconds)! } : {}),
    warnings: strings(candidate.warnings),
    reasonCodes: strings(candidate.reasonCodes),
    zones: arrayFromPayload(candidate.zones, []).map(zone).filter((item): item is SpatialLayerZone => item !== null),
    connections: arrayFromPayload(candidate.connections, []).map(connection).filter((item): item is SpatialLayerConnection => item !== null),
    points: arrayFromPayload(candidate.points, []).map(layerPoint).filter((item): item is SpatialLayerPoint => item !== null),
  };
}

export function spatialLayerSnapshots(value: unknown): SpatialLayerSnapshot[] {
  return arrayFromPayload(value, ["snapshots", "layers", "data"])
    .map(snapshot)
    .filter((item): item is SpatialLayerSnapshot => item !== null);
}

export function spatialLayerEngines(value: unknown): SpatialLayerEngineManifest[] {
  return arrayFromPayload(value, ["engines", "data"]).flatMap((item) => {
    const candidate = record(item);
    if (!candidate || typeof candidate.id !== "string" || typeof candidate.version !== "string") return [];
    const canonical = item as CanonicalEngineManifest;
    const producedLayerIds = strings(candidate.producedLayerIds);
    const legacyLayerIds = strings(candidate.layerIds);
    return [{
      id: candidate.id,
      version: candidate.version,
      maturity: canonical.maturity === "stable" || canonical.maturity === "experimental" ? canonical.maturity : "research",
      ...(typeof candidate.title === "string" ? { title: candidate.title, name: candidate.title } : {}),
      ...(typeof candidate.description === "string" ? { description: candidate.description } : {}),
      supportedScopes: Array.isArray(candidate.supportedScopes) ? candidate.supportedScopes.filter((scope): scope is SpatialLayerScopeKind => scope === "house" || scope === "property") : ["house"],
      requiredMetrics: strings(candidate.requiredMetrics),
      layerIds: producedLayerIds.length ? producedLayerIds : legacyLayerIds.length ? legacyLayerIds : [candidate.id],
      ...(typeof candidate.enabled === "boolean" ? { enabled: candidate.enabled } : {}),
      ...(typeof candidate.defaultEnabled === "boolean" ? { defaultEnabled: candidate.defaultEnabled } : {}),
    }];
  });
}

export function spatialLayerHealth(value: unknown): SpatialLayerEngineHealth[] {
  return arrayFromPayload(value, ["engines", "health", "data"]).flatMap((item) => {
    const candidate = record(item);
    if (!candidate || typeof candidate.engineId !== "string" || typeof candidate.state !== "string") return [];
    const canonical = item as CanonicalEngineHealth;
    const state = canonical.state === "available" || candidate.state === "healthy" ? "healthy"
      : canonical.state === "disabled" ? "disabled"
        : candidate.state === "never_run" ? "learning_baseline"
        : candidate.state === "learning_baseline" || candidate.state === "degraded_sensor_data" || candidate.state === "configuration_incomplete" || candidate.state === "calibration_stale" || candidate.state === "model_drift"
          ? candidate.state : "error";
    return [{
      engineId: candidate.engineId,
      state,
      ...(typeof candidate.layerId === "string" ? { layerId: candidate.layerId } : {}),
      ...(typeof candidate.checkedAt === "string" ? { checkedAt: candidate.checkedAt } : {}),
      ...(typeof candidate.message === "string" ? { message: candidate.message } : {}),
      reasonCodes: strings(candidate.reasonCodes),
    }];
  });
}

export function spatialLayerSnapshotEvent(value: unknown): SpatialLayerSnapshotEvent | null {
  const envelope = record(value);
  const candidate = record(envelope?.data) ?? record(envelope?.snapshot) ?? envelope;
  const explicitScope = record(candidate?.scope);
  const scope = explicitScope ?? ((candidate?.scopeKind === "house" || candidate?.scopeKind === "property") && typeof candidate.scopeId === "string"
    ? { kind: candidate.scopeKind, id: candidate.scopeId }
    : null);
  const generatedAt = typeof candidate?.generatedAt === "string" ? candidate.generatedAt
    : typeof candidate?.bucketAt === "string" ? candidate.bucketAt
      : typeof candidate?.emittedAt === "string" ? candidate.emittedAt : null;
  if (!candidate || !generatedAt || (scope?.kind !== "house" && scope?.kind !== "property") || typeof scope.id !== "string") return null;
  return {
    scope: { kind: scope.kind, id: scope.id },
    generatedAt,
    ...(typeof candidate.layerId === "string" ? { layerId: candidate.layerId } : {}),
    ...(strings(candidate.snapshotIds).length ? { snapshotIds: strings(candidate.snapshotIds) } : {}),
    ...(number(candidate.revision) !== undefined ? { revision: number(candidate.revision)! } : {}),
  };
}

export function finiteUnit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : null;
}

export function metricNumber(
  value: { metrics?: Record<string, SpatialLayerMetric> },
  ...keys: string[]
): number | null {
  for (const key of keys) {
    const metric = value.metrics?.[key];
    if (typeof metric?.value === "number" && Number.isFinite(metric.value)) return metric.value;
    if (typeof metric?.normalized === "number" && Number.isFinite(metric.normalized)) return metric.normalized;
  }
  return null;
}

export function layerConfidence(value: { metrics?: Record<string, SpatialLayerMetric>; evidence?: SpatialLayerEvidence }): number {
  return finiteUnit(value.evidence?.confidence)
    ?? finiteUnit(value.evidence?.quality)
    ?? finiteUnit(metricNumber(value, "confidence", "quality"))
    ?? 0;
}

export function layerStrength(value: { metrics?: Record<string, SpatialLayerMetric>; evidence?: SpatialLayerEvidence }): number {
  return finiteUnit(value.evidence?.strength)
    ?? finiteUnit(metricNumber(value, "strength", "evidenceStrength", "propagationEvidenceStrength", "activityEvidenceScore", "activityProbability", "qualityScore", "value"))
    ?? layerConfidence(value);
}

export function layerVisualStrength(layerId: string, value: { metrics?: Record<string, SpatialLayerMetric>; evidence?: SpatialLayerEvidence }): number {
  const metric = layerId === "climate.temperature" ? metricNumber(value, "temperatureC")
    : layerId === "climate.relative-humidity" ? metricNumber(value, "relativeHumidityPct")
      : layerId === "climate.absolute-humidity" ? metricNumber(value, "absoluteHumidityGM3")
        : layerId === "climate.humidity-ratio" ? metricNumber(value, "humidityRatioGKg")
          : layerId === "sensor.quality" ? metricNumber(value, "qualityScore") : null;
  if (metric === null) return layerStrength(value);
  if (layerId === "climate.temperature") return finiteUnit((metric + 10) / 45) ?? 0;
  if (layerId === "climate.relative-humidity") return finiteUnit(metric / 100) ?? 0;
  if (layerId === "climate.absolute-humidity") return finiteUnit(metric / 30) ?? 0;
  if (layerId === "climate.humidity-ratio") return finiteUnit(metric / 25) ?? 0;
  return finiteUnit(metric) ?? 0;
}

export function layerMetricText(layerId: string, value: { metrics?: Record<string, SpatialLayerMetric> }, locale: string): string | null {
  const preferred = layerId === "climate.temperature" ? "temperatureC"
    : layerId === "climate.relative-humidity" ? "relativeHumidityPct"
      : layerId === "climate.absolute-humidity" ? "absoluteHumidityGM3"
        : layerId === "climate.humidity-ratio" ? "humidityRatioGKg"
          : layerId === "sensor.quality" ? "qualityScore" : null;
  const entry = preferred ? value.metrics?.[preferred] : undefined;
  if (!entry || entry.value === null) return null;
  const display = typeof entry.value === "number"
    ? new Intl.NumberFormat(locale, { maximumFractionDigits: layerId === "sensor.quality" ? 0 : 1 }).format(layerId === "sensor.quality" ? entry.value * 100 : entry.value)
    : String(entry.value);
  const unit = layerId === "sensor.quality" ? "%" : entry.unit ?? "";
  return `${display}${unit ? ` ${unit}` : ""}`;
}

export function isActivityLayer(layerId: string): boolean {
  return layerId.includes("activity") || layerId.includes("people") || layerId.includes("presence");
}

export function isSnapshotStale(snapshot: SpatialLayerSnapshot, now = Date.now()): boolean {
  const generatedAt = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(generatedAt)) return true;
  return now - generatedAt > Math.max(30, snapshot.staleAfterSeconds ?? 300) * 1_000;
}

export function latestSnapshotPerLayer(snapshots: readonly SpatialLayerSnapshot[], at?: number): SpatialLayerSnapshot[] {
  const selected = new Map<string, SpatialLayerSnapshot>();
  for (const snapshot of snapshots) {
    const generatedAt = Date.parse(snapshot.generatedAt);
    if (!Number.isFinite(generatedAt) || (at !== undefined && generatedAt > at)) continue;
    const previous = selected.get(snapshot.layerId);
    if (!previous || previous.generatedAt < snapshot.generatedAt) selected.set(snapshot.layerId, snapshot);
  }
  return [...selected.values()];
}
