import type {
  SpatialLayerEngineHealth as CanonicalEngineHealth,
  SpatialLayerEngineManifest as CanonicalEngineManifest,
  SpatialLayerSnapshot as CanonicalLayerSnapshot,
} from "@climate-twin/spatial-layers";
import { SpatialCoordinateFrame, SpatialLayerConnection, SpatialLayerEngineHealth, SpatialLayerEngineManifest, SpatialLayerEvidence, SpatialLayerMetric, SpatialLayerPoint, SpatialLayerScopeKind, SpatialLayerSnapshot, SpatialLayerSnapshotEvent, SpatialLayerZone, arrayFromPayload, parseSpatialEvidence, parseSpatialMetrics, parseFiniteNumber, parseSpatialPoint, parseRecord, parseStringArray, parseSpatialStyle, parseSpatialZone, parseFiniteUnit } from "./layerTypes";

export function parseSpatialConnection(value: unknown): SpatialLayerConnection | null {
  const candidate = parseRecord(value);
  if (!candidate || typeof candidate.connectionId !== "string") return null;
  const metricValues = parseSpatialMetrics(candidate.metrics);
  const anchors = Array.isArray(candidate.anchors) ? candidate.anchors.flatMap((item) => parseSpatialPoint(item) ?? []) : [];
  const rawState = candidate.state;
  const state = rawState === "bidirectional-evidence" || rawState === "bidirectional" ? "bidirectional"
    : rawState === "no-detectable-propagation" || rawState === "no_detectable_propagation" ? "no_detectable_propagation"
      : rawState === "insufficient-data" || rawState === "insufficient_data" ? "insufficient_data"
      : rawState === "directed" ? "directed" : "uncertain";
  const anchorRefs = Array.isArray(candidate.anchorRefs) ? candidate.anchorRefs.flatMap((item) => {
    const anchor = parseRecord(item);
    const position = parseSpatialPoint(anchor?.position);
    return typeof anchor?.frameId === "string" && position ? [{ frameId: anchor.frameId, position }] : [];
  }) : [];
  const from = anchors[0] ?? parseSpatialPoint(candidate.from);
  const to = anchors.at(-1) ?? parseSpatialPoint(candidate.to);
  const styleHint = parseSpatialStyle(candidate.style);
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
    evidence: parseSpatialEvidence(candidate.evidence, metricValues),
    ...(styleHint ? { style: styleHint } : {}),
    reasonCodes: parseStringArray(candidate.reasonCodes),
  };
}

export function parseSpatialLayerPoint(value: unknown): SpatialLayerPoint | null {
  const candidate = parseRecord(value);
  const id = typeof candidate?.pointId === "string" ? candidate.pointId : typeof candidate?.id === "string" ? candidate.id : null;
  const position = parseSpatialPoint(candidate?.position) ?? parseSpatialPoint(candidate);
  if (!candidate || !id || !position) return null;
  const metricValues = parseSpatialMetrics(candidate.metrics);
  const styleHint = parseSpatialStyle(candidate.style);
  return {
    id,
    ...(typeof candidate.frameId === "string" ? { frameId: candidate.frameId } : {}),
    ...(typeof candidate.floorId === "string" ? { floorId: candidate.floorId } : {}),
    ...(typeof candidate.zoneId === "string" ? { zoneId: candidate.zoneId } : {}),
    ...(typeof candidate.houseId === "string" ? { houseId: candidate.houseId } : {}),
    ...(typeof candidate.label === "string" ? { label: candidate.label } : {}),
    ...position,
    metrics: metricValues,
    evidence: parseSpatialEvidence(candidate.evidence, metricValues),
    ...(styleHint ? { style: styleHint } : {}),
    reasonCodes: parseStringArray(candidate.reasonCodes),
  };
}

export function parseSpatialLayerSnapshot(value: unknown): SpatialLayerSnapshot | null {
  const candidate = parseRecord(value);
  const scope = parseRecord(candidate?.scope);
  const model = parseRecord(candidate?.model);
  if (!candidate || typeof candidate.layerId !== "string" || typeof candidate.generatedAt !== "string"
    || (scope?.kind !== "house" && scope?.kind !== "property") || typeof scope.id !== "string") return null;
  const canonical = value as CanonicalLayerSnapshot;
  const metadata = parseRecord(candidate.metadata);
  return {
    ...(typeof metadata?.snapshotId === "string" ? { id: metadata.snapshotId } : {}),
    ...(parseFiniteNumber(metadata?.revision) !== undefined ? { revision: parseFiniteNumber(metadata?.revision)! } : {}),
    scope: { kind: scope.kind, id: scope.id },
    coordinateFrames: Array.isArray(candidate.coordinateFrames) ? candidate.coordinateFrames.flatMap((item) => {
      const frame = parseRecord(item);
      if (!frame || typeof frame.id !== "string" || typeof frame.version !== "string"
        || (frame.kind !== "floor-plan-2d" && frame.kind !== "building-local-3d" && frame.kind !== "property-local-3d" && frame.kind !== "geographic")
        || (frame.unit !== "normalized" && frame.unit !== "m" && frame.unit !== "degrees")) return [];
      const origin = parseSpatialPoint(frame.origin);
      return [{
        id: frame.id,
        version: frame.version,
        kind: frame.kind,
        unit: frame.unit,
        ...(origin?.z !== undefined ? { origin: { x: origin.x, y: origin.y, z: origin.z } } : {}),
        ...(typeof frame.floorId === "string" ? { floorId: frame.floorId } : {}),
        ...(parseFiniteNumber(frame.rotationDegrees) !== undefined ? { rotationDegrees: parseFiniteNumber(frame.rotationDegrees)! } : {}),
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
    qualityScore: parseFiniteUnit(candidate.qualityScore) ?? 0,
    ...(parseFiniteNumber(metadata?.staleAfterSeconds) !== undefined ? { staleAfterSeconds: parseFiniteNumber(metadata?.staleAfterSeconds)! } : {}),
    warnings: parseStringArray(candidate.warnings),
    reasonCodes: parseStringArray(candidate.reasonCodes),
    zones: arrayFromPayload(candidate.zones, []).map(parseSpatialZone).filter((item): item is SpatialLayerZone => item !== null),
    connections: arrayFromPayload(candidate.connections, []).map(parseSpatialConnection).filter((item): item is SpatialLayerConnection => item !== null),
    points: arrayFromPayload(candidate.points, []).map(parseSpatialLayerPoint).filter((item): item is SpatialLayerPoint => item !== null),
  };
}

export function parseSpatialLayerSnapshots(value: unknown): SpatialLayerSnapshot[] {
  return arrayFromPayload(value, ["snapshots", "layers", "data"])
    .map(parseSpatialLayerSnapshot)
    .filter((item): item is SpatialLayerSnapshot => item !== null);
}

export function parseSpatialLayerEngines(value: unknown): SpatialLayerEngineManifest[] {
  return arrayFromPayload(value, ["engines", "data"]).flatMap((item) => {
    const candidate = parseRecord(item);
    if (!candidate || typeof candidate.id !== "string" || typeof candidate.version !== "string") return [];
    const canonical = item as CanonicalEngineManifest;
    const producedLayerIds = parseStringArray(candidate.producedLayerIds);
    const legacyLayerIds = parseStringArray(candidate.layerIds);
    return [{
      id: candidate.id,
      version: candidate.version,
      maturity: canonical.maturity === "stable" || canonical.maturity === "experimental" ? canonical.maturity : "research",
      ...(typeof candidate.title === "string" ? { title: candidate.title, name: candidate.title } : {}),
      ...(typeof candidate.description === "string" ? { description: candidate.description } : {}),
      supportedScopes: Array.isArray(candidate.supportedScopes) ? candidate.supportedScopes.filter((scope): scope is SpatialLayerScopeKind => scope === "house" || scope === "property") : ["house"],
      requiredMetrics: parseStringArray(candidate.requiredMetrics),
      layerIds: producedLayerIds.length ? producedLayerIds : legacyLayerIds.length ? legacyLayerIds : [candidate.id],
      ...(typeof candidate.enabled === "boolean" ? { enabled: candidate.enabled } : {}),
      ...(typeof candidate.defaultEnabled === "boolean" ? { defaultEnabled: candidate.defaultEnabled } : {}),
    }];
  });
}

export function parseSpatialLayerHealth(value: unknown): SpatialLayerEngineHealth[] {
  return arrayFromPayload(value, ["engines", "health", "data"]).flatMap((item) => {
    const candidate = parseRecord(item);
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
      reasonCodes: parseStringArray(candidate.reasonCodes),
    }];
  });
}

export function parseSpatialLayerSnapshotEvent(value: unknown): SpatialLayerSnapshotEvent | null {
  const envelope = parseRecord(value);
  const candidate = parseRecord(envelope?.data) ?? parseRecord(envelope?.snapshot) ?? envelope;
  const explicitScope = parseRecord(candidate?.scope);
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
    ...(parseStringArray(candidate.snapshotIds).length ? { snapshotIds: parseStringArray(candidate.snapshotIds) } : {}),
    ...(parseFiniteNumber(candidate.revision) !== undefined ? { revision: parseFiniteNumber(candidate.revision)! } : {}),
  };
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
  return parseFiniteUnit(value.evidence?.confidence)
    ?? parseFiniteUnit(value.evidence?.quality)
    ?? parseFiniteUnit(metricNumber(value, "confidence", "quality"))
    ?? 0;
}

export function layerStrength(value: { metrics?: Record<string, SpatialLayerMetric>; evidence?: SpatialLayerEvidence }): number {
  return parseFiniteUnit(value.evidence?.strength)
    ?? parseFiniteUnit(metricNumber(value, "strength", "evidenceStrength", "propagationEvidenceStrength", "activityEvidenceScore", "activityProbability", "qualityScore", "value"))
    ?? layerConfidence(value);
}

export function layerVisualStrength(layerId: string, value: { metrics?: Record<string, SpatialLayerMetric>; evidence?: SpatialLayerEvidence }): number {
  const metric = layerId === "climate.temperature" ? metricNumber(value, "temperatureC")
    : layerId === "climate.relative-humidity" ? metricNumber(value, "relativeHumidityPct")
      : layerId === "climate.absolute-humidity" ? metricNumber(value, "absoluteHumidityGM3")
        : layerId === "climate.humidity-ratio" ? metricNumber(value, "humidityRatioGKg")
          : layerId === "sensor.quality" ? metricNumber(value, "qualityScore") : null;
  if (metric === null) return layerStrength(value);
  if (layerId === "climate.temperature") return parseFiniteUnit((metric + 10) / 45) ?? 0;
  if (layerId === "climate.relative-humidity") return parseFiniteUnit(metric / 100) ?? 0;
  if (layerId === "climate.absolute-humidity") return parseFiniteUnit(metric / 30) ?? 0;
  if (layerId === "climate.humidity-ratio") return parseFiniteUnit(metric / 25) ?? 0;
  return parseFiniteUnit(metric) ?? 0;
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
