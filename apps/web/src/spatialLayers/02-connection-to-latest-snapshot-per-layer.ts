import type {
  SpatialLayerEngineHealth as CanonicalEngineHealth,
  SpatialLayerEngineManifest as CanonicalEngineManifest,
  SpatialLayerSnapshot as CanonicalLayerSnapshot,
} from "@climate-twin/spatial-layers";
import { SpatialCoordinateFrame, SpatialLayerConnection, SpatialLayerEngineHealth, SpatialLayerEngineManifest, SpatialLayerEvidence, SpatialLayerMetric, SpatialLayerPoint, SpatialLayerScopeKind, SpatialLayerSnapshot, SpatialLayerSnapshotEvent, SpatialLayerZone, arrayFromPayload, evidence, metrics, number, point, record, strings, style, zone, finiteUnit } from "./01-spatial-coordinate-frame-to-zone";

export function connection(value: unknown): SpatialLayerConnection | null {
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

export function layerPoint(value: unknown): SpatialLayerPoint | null {
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

export function snapshot(value: unknown): SpatialLayerSnapshot | null {
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
