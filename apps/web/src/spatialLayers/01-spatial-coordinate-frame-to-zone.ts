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
import { finiteUnit } from "./02-connection-to-latest-snapshot-per-layer";

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

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function arrayFromPayload(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const candidate = record(value);
  if (!candidate) return [];
  for (const key of keys) if (Array.isArray(candidate[key])) return candidate[key] as unknown[];
  return [];
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function calibrationSession(value: unknown): SpatialCalibrationSession | null {
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

export function metrics(value: unknown): Record<string, SpatialLayerMetric> {
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

export function evidence(value: unknown, metricValues: Record<string, SpatialLayerMetric>): SpatialLayerEvidence {
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

export function point(value: unknown): { x: number; y: number; z?: number } | undefined {
  const candidate = record(value);
  const x = number(candidate?.x);
  const y = number(candidate?.y);
  const z = number(candidate?.z);
  if (x === undefined || y === undefined) return undefined;
  return z === undefined ? { x, y } : { x, y, z };
}

export function style(value: unknown): SpatialLayerStyleHint | undefined {
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

export function zone(value: unknown): SpatialLayerZone | null {
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
