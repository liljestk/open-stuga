import type {
  CoordinateFrame as CanonicalCoordinateFrame,
  SpatialSensorCalibration,
  SpatialTopology,
} from "@climate-twin/spatial-layers";

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

export interface SpatialInferenceSession {
  id: string;
  houseId: string;
  status: "active" | "stopped" | "expired";
  startedAt: string;
  expiresAt: string;
  cadenceMinutes: number;
  nextRunAt: string;
  lastScheduledAt: string | null;
  stoppedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SpatialInferenceSessionStartInput {
  durationMinutes?: number;
  cadenceMinutes?: number;
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

export function parseRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function arrayFromPayload(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const candidate = parseRecord(value);
  if (!candidate) return [];
  for (const key of keys) if (Array.isArray(candidate[key])) return candidate[key] as unknown[];
  return [];
}

export function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function parseFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseCalibrationSession(value: unknown): SpatialCalibrationSession | null {
  const candidate = parseRecord(value);
  if (!candidate || typeof candidate.id !== "string" || typeof candidate.startAt !== "string") return null;
  if (candidate.kind !== "co-location" && candidate.kind !== "controlled-propagation" && candidate.kind !== "empty-house-baseline") return null;
  if (candidate.status !== "planned" && candidate.status !== "running" && candidate.status !== "completed" && candidate.status !== "cancelled") return null;
  const intervention = parseRecord(candidate.intervention) ?? {};
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

export function parseSpatialCalibrationSessions(value: unknown): SpatialCalibrationSession[] {
  return arrayFromPayload(value, ["sessions", "data"])
    .map(parseCalibrationSession)
    .filter((item): item is SpatialCalibrationSession => item !== null);
}

export function parseSpatialCalibrationSessionResult(value: unknown): SpatialCalibrationSessionResult | null {
  const payload = parseRecord(value);
  const session = parseCalibrationSession(payload?.session ?? value);
  if (!session) return null;
  const calibrations = arrayFromPayload(value, ["calibrations"]).filter((item): item is SpatialSensorCalibration => {
    const candidate = parseRecord(item);
    return typeof candidate?.sensorId === "string" && typeof candidate.validFrom === "string"
      && typeof candidate.temperatureOffsetC === "number" && typeof candidate.humidityOffsetPct === "number"
      && typeof candidate.confidence === "number" && typeof candidate.method === "string";
  });
  return { session, calibrations };
}

export function parseSpatialInferenceSession(value: unknown): SpatialInferenceSession | null {
  const payload = parseRecord(value);
  const candidate = parseRecord(payload && Object.hasOwn(payload, "session") ? payload.session : value);
  if (!candidate || typeof candidate.id !== "string" || typeof candidate.houseId !== "string") return null;
  if (candidate.status !== "active" && candidate.status !== "stopped" && candidate.status !== "expired") return null;
  if (typeof candidate.startedAt !== "string" || typeof candidate.expiresAt !== "string"
      || typeof candidate.nextRunAt !== "string" || typeof candidate.createdAt !== "string"
      || typeof candidate.updatedAt !== "string" || !Number.isInteger(candidate.cadenceMinutes)) return null;
  return {
    id: candidate.id,
    houseId: candidate.houseId,
    status: candidate.status,
    startedAt: candidate.startedAt,
    expiresAt: candidate.expiresAt,
    cadenceMinutes: candidate.cadenceMinutes as number,
    nextRunAt: candidate.nextRunAt,
    lastScheduledAt: typeof candidate.lastScheduledAt === "string" ? candidate.lastScheduledAt : null,
    stoppedAt: typeof candidate.stoppedAt === "string" ? candidate.stoppedAt : null,
    createdBy: typeof candidate.createdBy === "string" ? candidate.createdBy : null,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

export function parseSpatialMetrics(value: unknown): Record<string, SpatialLayerMetric> {
  const candidate = parseRecord(value);
  if (!candidate) return {};
  return Object.fromEntries(Object.entries(candidate).flatMap(([key, raw]) => {
    const metric = parseRecord(raw);
    if (!metric) return [];
    const metricValue = metric?.value;
    if (!(metricValue === null || typeof metricValue === "number" || typeof metricValue === "string" || typeof metricValue === "boolean")) return [];
    const result: SpatialLayerMetric = { value: metricValue };
    if (typeof metric.unit === "string") result.unit = metric.unit;
    if (typeof metric.label === "string") result.label = metric.label;
    const quality = parseFiniteUnit(metric.quality);
    if (quality !== null) result.quality = quality;
    const normalized = parseFiniteUnit(metric.normalized);
    if (normalized !== null) result.normalized = normalized;
    return [[key, result]];
  }));
}

export function parseSpatialEvidence(value: unknown, metricValues: Record<string, SpatialLayerMetric>): SpatialLayerEvidence {
  const entries = Array.isArray(value) ? value.map(parseRecord).filter((item): item is Record<string, unknown> => item !== null) : [parseRecord(value)].filter((item): item is Record<string, unknown> => item !== null);
  const scores = entries.flatMap((item) => parseFiniteNumber(item.score) ?? parseFiniteNumber(item.confidence) ?? parseFiniteNumber(item.strength) ?? []);
  const qualities = Object.values(metricValues).flatMap((metric) => metric.quality ?? []);
  const quality = parseFiniteUnit(Math.max(0, ...qualities));
  const strength = parseFiniteUnit(Math.max(0, ...scores));
  return {
    confidence: parseFiniteUnit(Math.max(0, ...scores, ...qualities)) ?? 0,
    ...(qualities.length && quality !== null ? { quality } : {}),
    ...(scores.length && strength !== null ? { strength } : {}),
    reasonCodes: [...new Set(entries.flatMap((item) => parseStringArray(item.reasonCodes)))],
  };
}

export function parseSpatialPoint(value: unknown): { x: number; y: number; z?: number } | undefined {
  const candidate = parseRecord(value);
  const x = parseFiniteNumber(candidate?.x);
  const y = parseFiniteNumber(candidate?.y);
  const z = parseFiniteNumber(candidate?.z);
  if (x === undefined || y === undefined) return undefined;
  return z === undefined ? { x, y } : { x, y, z };
}

export function parseSpatialStyle(value: unknown): SpatialLayerStyleHint | undefined {
  const candidate = parseRecord(value);
  if (!candidate) return undefined;
  const direction = candidate.direction === "a-to-b" ? "forward"
    : candidate.direction === "b-to-a" ? "reverse"
      : candidate.direction === "both" ? "both"
        : "none";
  const palette = candidate.palette === "air" ? "propagation" : candidate.palette;
  return {
    ...(parseFiniteNumber(candidate.emphasis) !== undefined ? { emphasis: parseFiniteNumber(candidate.emphasis)! } : {}),
    ...(parseFiniteUnit(candidate.opacity) !== null ? { opacity: parseFiniteUnit(candidate.opacity)! } : {}),
    ...(candidate.lineStyle === "solid" || candidate.lineStyle === "dashed" || candidate.lineStyle === "dotted" ? { line: candidate.lineStyle } : {}),
    direction,
    ...(palette === "temperature" || palette === "humidity" || palette === "quality" || palette === "propagation" || palette === "activity" || palette === "neutral" ? { palette } : {}),
  };
}

export function parseSpatialZone(value: unknown): SpatialLayerZone | null {
  const candidate = parseRecord(value);
  if (!candidate || typeof candidate.zoneId !== "string") return null;
  const metricValues = parseSpatialMetrics(candidate.metrics);
  const anchor = parseSpatialPoint(candidate.anchor ?? candidate.centroid);
  const polygon = Array.isArray(candidate.polygon) ? candidate.polygon.flatMap((item) => {
    const positioned = parseSpatialPoint(item);
    return positioned ? [{ x: positioned.x, y: positioned.y }] : [];
  }) : undefined;
  const styleHint = parseSpatialStyle(candidate.style);
  return {
    zoneId: candidate.zoneId,
    ...(typeof candidate.frameId === "string" ? { frameId: candidate.frameId } : {}),
    ...(typeof candidate.floorId === "string" ? { floorId: candidate.floorId } : {}),
    ...(typeof candidate.roomId === "string" ? { roomId: candidate.roomId } : {}),
    ...(typeof candidate.houseId === "string" ? { houseId: candidate.houseId } : {}),
    ...(typeof candidate.name === "string" ? { label: candidate.name } : typeof candidate.label === "string" ? { label: candidate.label } : {}),
    ...(parseStringArray(candidate.tags).length ? { tags: parseStringArray(candidate.tags) } : {}),
    ...(polygon?.length ? { polygon } : {}),
    ...(anchor ? { centroid: anchor } : {}),
    metrics: metricValues,
    evidence: parseSpatialEvidence(candidate.evidence, metricValues),
    ...(styleHint ? { style: styleHint } : {}),
    reasonCodes: parseStringArray(candidate.reasonCodes),
  };
}

export function parseFiniteUnit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : null;
}
