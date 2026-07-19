import { randomUUID } from "node:crypto";
import type { Application, Request, Response } from "express";
import type { SpatialContextEventKind, Vector3 } from "@climate-twin/spatial-layers";
import type { LocalSpatialLayerRuntime } from "./lifecycle.js";
import { SpatialStateValidationError } from "./state-store.js";
import type {
  SpatialCalibrationSession,
  SpatialEngineAssignment,
  SpatialGroundTruth,
  SpatialScope,
  StoredSpatialContextEvent,
  StoredSpatialSensorBinding,
  StoredSpatialSensorCalibration,
} from "./types.js";

const CONTEXT_KINDS: SpatialContextEventKind[] = [
  "door-open", "window-open", "hvac-change", "heat-pump-change", "extractor-change", "dehumidifier-change",
  "heater-change", "cooking", "shower", "sauna", "solar-gain", "rapid-weather-change",
  "persistent-environmental-source", "known-empty", "known-occupied",
];
const CALIBRATION_METHODS: StoredSpatialSensorCalibration["method"][] = ["co-location", "manual", "factory", "estimated"];
const CALIBRATION_SESSION_KINDS: SpatialCalibrationSession["kind"][] = ["co-location", "controlled-propagation", "empty-house-baseline"];
const GROUND_TRUTH_SOURCES: SpatialGroundTruth["source"][] = ["user", "optional_sensor", "controlled_test"];
const PLACEMENT_RISKS: NonNullable<StoredSpatialSensorBinding["placementRisks"]>[number][] = [
  "near-window", "near-exterior-wall", "near-radiator", "near-heat-pump", "direct-sunlight", "unknown",
];

class SpatialRouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SpatialRouteError(400, "INVALID_BODY", "A JSON object is required");
  return value as Record<string, unknown>;
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new SpatialRouteError(400, "UNKNOWN_FIELD", `${label} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SpatialRouteError(400, "INVALID_FIELD", `${field} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new SpatialRouteError(400, "INVALID_FIELD", `${key} must be a non-empty string`);
  return value.trim();
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new SpatialRouteError(400, "INVALID_FIELD", `${key} must be a string`);
  return value;
}

function nullableString(body: Record<string, unknown>, key: string): string | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") throw new SpatialRouteError(400, "INVALID_FIELD", `${key} must be a string or null`);
  return value;
}

function finiteNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new SpatialRouteError(400, "INVALID_FIELD", `${key} must be a finite number`);
  return value;
}

function isoTimestamp(value: unknown, field: string, defaultValue?: string): string {
  const candidate = value === undefined ? defaultValue : value;
  if (typeof candidate !== "string" || !Number.isFinite(Date.parse(candidate))) {
    throw new SpatialRouteError(400, "INVALID_TIMESTAMP", `${field} must be an ISO timestamp`);
  }
  return new Date(candidate).toISOString();
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new SpatialRouteError(400, "INVALID_FIELD", `${field} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => (item as string).trim()))];
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new SpatialRouteError(400, "INVALID_FIELD", `${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function pathId(request: Request): string {
  const value = request.params.id;
  if (typeof value !== "string" || !value) throw new SpatialRouteError(400, "INVALID_PATH", "A resource id is required");
  return value;
}

function scope(kind: SpatialScope["kind"], request: Request): SpatialScope {
  return { kind, id: pathId(request) };
}

export interface SpatialRouteOptions {
  runtime: LocalSpatialLayerRuntime | null;
  prefix?: string;
  authorizeScope?: (request: Request, response: Response, scope: SpatialScope) => boolean;
  auditActor?: (request: Request, response: Response) => string | null;
  streamAuthorizationFingerprint?: (request: Request, response: Response) => string | null;
  /** Return false after sending a terminal response (for example, shutdown). */
  validateStream?: (request: Request, response: Response) => boolean;
  acquireStream?: (request: Request, response: Response) => (() => void) | null;
}

function auditActor(options: SpatialRouteOptions, request: Request, response: Response): string | null {
  return options.auditActor?.(request, response) ?? null;
}

function authorizedScope(
  options: SpatialRouteOptions,
  kind: SpatialScope["kind"],
  request: Request,
  response: Response,
): SpatialScope {
  const value = scope(kind, request);
  if (options.authorizeScope && !options.authorizeScope(request, response, value)) {
    // Match the core visibility policy: do not reveal whether an inaccessible
    // house or property exists.
    throw new SpatialRouteError(404, "SPATIAL_SCOPE_NOT_FOUND", `${kind} ${value.id} does not exist`);
  }
  return value;
}

function layerQuery(request: Request): string[] {
  const values = request.query.layers ?? request.query.layer;
  const flattened = Array.isArray(values) ? values : values === undefined ? [] : [values];
  return [...new Set(flattened.flatMap((value) => typeof value === "string" ? value.split(",") : []).map((value) => value.trim()).filter(Boolean))];
}

function requireRuntime(runtime: LocalSpatialLayerRuntime | null): LocalSpatialLayerRuntime {
  if (!runtime) throw new SpatialRouteError(503, "SPATIAL_LAYERS_UNAVAILABLE", "The optional spatial layer engine is unavailable");
  runtime.synchronizeDataMode();
  return runtime;
}

function requireScope(runtime: LocalSpatialLayerRuntime, value: SpatialScope): void {
  if (!runtime.input.scopeExists(value)) throw new SpatialRouteError(404, "SPATIAL_SCOPE_NOT_FOUND", `${value.kind} ${value.id} does not exist`);
}

function sendError(response: Response, error: unknown): void {
  if (error instanceof SpatialRouteError || error instanceof SpatialStateValidationError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  response.status(500).json({ error: { code: "SPATIAL_LAYER_ERROR", message: "The spatial layer request could not be completed" } });
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>): (request: Request, response: Response) => void {
  return (request, response) => { void handler(request, response).catch((error: unknown) => sendError(response, error)); };
}

async function current(runtime: LocalSpatialLayerRuntime, value: SpatialScope, request: Request): Promise<Record<string, unknown>> {
  requireScope(runtime, value);
  const overview = await runtime.host.describeScope(value);
  const layers = runtime.state.currentSnapshots(runtime.host.partition, value, layerQuery(request))
    .filter((layer) => layer.configVersion === String(overview.configuration.version));
  return {
    partition: runtime.host.partition,
    scope: value,
    at: layers.reduce<string | null>((latest, layer) => !latest || layer.generatedAt > latest ? layer.generatedAt : latest, null),
    topology: overview.topology,
    layers,
    warnings: overview.warnings,
  };
}

function history(runtime: LocalSpatialLayerRuntime, value: SpatialScope, request: Request): Record<string, unknown> {
  requireScope(runtime, value);
  const to = isoTimestamp(request.query.to, "to", new Date().toISOString());
  const from = isoTimestamp(request.query.from, "from", new Date(Date.parse(to) - 6 * 60 * 60_000).toISOString());
  if (Date.parse(to) <= Date.parse(from)) throw new SpatialRouteError(400, "INVALID_INTERVAL", "to must be after from");
  if (Date.parse(to) - Date.parse(from) > 31 * 86_400_000) throw new SpatialRouteError(400, "RANGE_TOO_LARGE", "Movement layer history is limited to 31 days per request");
  const limitValue = request.query.limit === undefined ? 2_000 : Number(request.query.limit);
  if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 20_000) throw new SpatialRouteError(400, "INVALID_LIMIT", "limit must be 1 to 20000");
  const layers = runtime.state.snapshotHistory({
    partition: runtime.host.partition,
    scope: value,
    from,
    to,
    layerIds: layerQuery(request),
    includeSuperseded: request.query.includeSuperseded === "true",
    limit: limitValue,
  });
  return { partition: runtime.host.partition, scope: value, from, to, layers };
}

async function configuration(runtime: LocalSpatialLayerRuntime, value: SpatialScope): Promise<Record<string, unknown>> {
  requireScope(runtime, value);
  return { ...(await runtime.host.describeScope(value)) };
}

async function saveConfiguration(
  runtime: LocalSpatialLayerRuntime,
  value: SpatialScope,
  request: Request,
  createdBy: string | null,
): Promise<Record<string, unknown>> {
  requireScope(runtime, value);
  const body = bodyObject(request.body);
  rejectUnknownFields(body, new Set(["baseVersion", "config", "assignments"]), "Spatial layer configuration");
  const baseVersion = finiteNumber(body, "baseVersion");
  if (!Number.isInteger(baseVersion) || baseVersion < 0) throw new SpatialRouteError(400, "INVALID_FIELD", "baseVersion must be a non-negative integer");
  const config = objectValue(body.config, "config");
  const pendingAssignments: Array<Pick<SpatialEngineAssignment, "engineId" | "engineVersion" | "enabled" | "layerIds">> = [];
  if (body.assignments !== undefined) {
    if (!Array.isArray(body.assignments)) throw new SpatialRouteError(400, "INVALID_FIELD", "assignments must be an array");
    const manifests = new Map(runtime.host.manifests.map((manifest) => [manifest.id, manifest]));
    for (const item of body.assignments) {
      const candidate = objectValue(item, "assignment");
      rejectUnknownFields(candidate, new Set(["engineId", "engineVersion", "enabled", "layerIds"]), "Spatial engine assignment");
      const engineId = requiredString(candidate, "engineId");
      const manifest = manifests.get(engineId);
      if (!manifest) throw new SpatialRouteError(400, "UNKNOWN_ENGINE", `Unknown spatial engine ${engineId}`);
      const engineVersion = optionalString(candidate, "engineVersion") ?? manifest.version;
      if (engineVersion !== manifest.version) throw new SpatialRouteError(409, "ENGINE_VERSION_UNAVAILABLE", `${engineId}@${engineVersion} is not installed`);
      const enabled = candidate.enabled;
      if (typeof enabled !== "boolean") throw new SpatialRouteError(400, "INVALID_FIELD", "assignment.enabled must be boolean");
      const layerIds = candidate.layerIds === undefined ? [...manifest.producedLayerIds] : stringArray(candidate.layerIds, "assignment.layerIds");
      if (layerIds.some((layerId) => !manifest.producedLayerIds.includes(layerId))) {
        throw new SpatialRouteError(400, "UNKNOWN_ENGINE_LAYER", `${engineId} cannot produce one or more selected layers`);
      }
      pendingAssignments.push({ engineId, engineVersion, enabled, layerIds });
    }
  }
  // All client-controlled fields are validated before ensureScopeDefaults can
  // initialize durable scope defaults.
  const currentAssignments = runtime.host.ensureScopeDefaults(value).assignments;
  const assignmentMap = new Map(currentAssignments.map((assignment) => [assignment.engineId, assignment]));
  for (const assignment of pendingAssignments) {
    assignmentMap.set(assignment.engineId, {
      scope: value, ...assignment, configVersion: baseVersion + 1, updatedAt: new Date().toISOString(),
    });
  }
  const saved = runtime.state.putConfigurationBundle({
    partition: runtime.host.partition,
    scope: value,
    baseVersion,
    config,
    assignments: [...assignmentMap.values()].map(({ scope: _scope, configVersion: _configVersion, updatedAt: _updatedAt, ...assignment }) => assignment),
    createdBy,
  });
  runtime.scheduler.enqueueScope(value, new Date().toISOString(), "configuration-changed", true);
  const overview = await runtime.host.describeScope(value);
  return { ...overview, configuration: saved.configuration, assignments: saved.assignments };
}

function vector3(value: unknown): Vector3 {
  const body = objectValue(value, "position");
  rejectUnknownFields(body, new Set(["x", "y", "z"]), "position");
  return { x: finiteNumber(body, "x"), y: finiteNumber(body, "y"), z: finiteNumber(body, "z") };
}

async function addBinding(runtime: LocalSpatialLayerRuntime, houseId: string, request: Request): Promise<StoredSpatialSensorBinding> {
  const body = bodyObject(request.body);
  rejectUnknownFields(body, new Set([
    "id", "sensorId", "zoneId", "frameId", "position", "role", "activeFrom", "activeTo", "placementRisks",
  ]), "Spatial sensor binding");
  const sensorId = requiredString(body, "sensorId");
  const sensor = runtime.input.core.getSensor(sensorId);
  if (!sensor || sensor.houseId !== houseId) throw new SpatialRouteError(404, "SENSOR_NOT_FOUND", `Sensor ${sensorId} is not in this house`);
  const now = new Date().toISOString();
  const id = optionalString(body, "id") ?? randomUUID();
  const position = vector3(body.position);
  const role = enumValue(body.role, ["primary", "supporting", "outdoor"] as const, "role");
  const activeFrom = isoTimestamp(body.activeFrom, "activeFrom", now);
  const activeTo = body.activeTo === undefined || body.activeTo === null ? undefined : isoTimestamp(body.activeTo, "activeTo");
  if (activeTo !== undefined && Date.parse(activeTo) <= Date.parse(activeFrom)) {
    throw new SpatialRouteError(400, "INVALID_INTERVAL", "activeTo must be after activeFrom");
  }
  const placementRisks = body.placementRisks === undefined
    ? undefined
    : stringArray(body.placementRisks, "placementRisks").map((risk) => enumValue(risk, PLACEMENT_RISKS, "placementRisks"));
  const overview = await runtime.host.describeScope({ kind: "house", id: houseId });
  const zoneId = requiredString(body, "zoneId");
  const zone = overview.topology.zones.find((candidate) => candidate.id === zoneId);
  if (!zone) throw new SpatialRouteError(400, "ZONE_NOT_FOUND", `Zone ${zoneId} is not in this topology`);
  const frameId = requiredString(body, "frameId");
  if (!overview.topology.frames.some((frame) => frame.id === frameId)) throw new SpatialRouteError(400, "FRAME_NOT_FOUND", `Frame ${frameId} is not in this topology`);
  if (zone.frameId !== frameId) throw new SpatialRouteError(400, "BINDING_FRAME_MISMATCH", `Zone ${zoneId} belongs to frame ${zone.frameId}`);
  const binding = runtime.state.addBinding(runtime.host.partition, {
    id, houseId, sensorId, zoneId, frameId, position, role, activeFrom,
    ...(activeTo === undefined ? {} : { activeTo }),
    ...(placementRisks === undefined ? {} : { placementRisks }),
    createdAt: now,
  });
  const house = runtime.input.core.getHouse(houseId);
  runtime.scheduler.wakeHouse(houseId, house?.propertyId ?? null, now, "binding-changed");
  return binding;
}

function calibrationFromBody(
  runtime: LocalSpatialLayerRuntime,
  houseId: string,
  value: unknown,
  now = new Date().toISOString(),
): StoredSpatialSensorCalibration {
  const body = bodyObject(value);
  rejectUnknownFields(body, new Set([
    "id", "sensorId", "validFrom", "validTo", "temperatureOffsetC", "humidityOffsetPct",
    "responseLagSeconds", "confidence", "method",
  ]), "Spatial sensor calibration");
  const sensorId = requiredString(body, "sensorId");
  const sensor = runtime.input.core.getSensor(sensorId);
  if (!sensor || sensor.houseId !== houseId) throw new SpatialRouteError(404, "SENSOR_NOT_FOUND", `Sensor ${sensorId} is not in this house`);
  const confidence = finiteNumber(body, "confidence");
  const responseLagSeconds = body.responseLagSeconds === undefined || body.responseLagSeconds === null
    ? undefined
    : finiteNumber(body, "responseLagSeconds");
  if (responseLagSeconds !== undefined && responseLagSeconds < 0) {
    throw new SpatialRouteError(400, "INVALID_FIELD", "responseLagSeconds must not be negative");
  }
  if (confidence < 0 || confidence > 1) {
    throw new SpatialRouteError(400, "INVALID_FIELD", "confidence must be between 0 and 1");
  }
  return {
    id: optionalString(body, "id") ?? randomUUID(), houseId, sensorId,
    validFrom: isoTimestamp(body.validFrom, "validFrom", now),
    ...(body.validTo === undefined || body.validTo === null ? {} : { validTo: isoTimestamp(body.validTo, "validTo") }),
    temperatureOffsetC: finiteNumber(body, "temperatureOffsetC"), humidityOffsetPct: finiteNumber(body, "humidityOffsetPct"),
    ...(responseLagSeconds === undefined ? {} : { responseLagSeconds }),
    confidence, method: enumValue(body.method, CALIBRATION_METHODS, "method"), createdAt: now,
  };
}

function addCalibration(runtime: LocalSpatialLayerRuntime, houseId: string, value: unknown): StoredSpatialSensorCalibration {
  const calibration = runtime.state.addCalibration(
    runtime.host.partition,
    calibrationFromBody(runtime, houseId, value),
  );
  const now = calibration.createdAt;
  const house = runtime.input.core.getHouse(houseId);
  runtime.scheduler.wakeHouse(houseId, house?.propertyId ?? null, now, "calibration-changed");
  return calibration;
}

function addContext(runtime: LocalSpatialLayerRuntime, houseId: string, request: Request): StoredSpatialContextEvent {
  const body = bodyObject(request.body);
  rejectUnknownFields(body, new Set([
    "id", "kind", "startAt", "endAt", "zoneIds", "strength", "source", "payload",
  ]), "Spatial context event");
  const now = new Date().toISOString();
  const strength = body.strength === undefined ? undefined : finiteNumber(body, "strength");
  if (strength !== undefined && (strength < 0 || strength > 1)) throw new SpatialRouteError(400, "INVALID_FIELD", "strength must be between 0 and 1");
  const event = runtime.state.addContextEvent(runtime.host.partition, {
    id: optionalString(body, "id") ?? randomUUID(), houseId,
    kind: enumValue(body.kind, CONTEXT_KINDS, "kind"), startAt: isoTimestamp(body.startAt, "startAt", now),
    ...(body.endAt === undefined || body.endAt === null ? {} : { endAt: isoTimestamp(body.endAt, "endAt") }),
    ...(body.zoneIds === undefined ? {} : { zoneIds: stringArray(body.zoneIds, "zoneIds") }),
    ...(strength === undefined ? {} : { strength }),
    source: optionalString(body, "source") ?? "user", payload: body.payload === undefined ? {} : objectValue(body.payload, "payload"), createdAt: now,
  });
  const house = runtime.input.core.getHouse(houseId);
  runtime.scheduler.wakeHouse(houseId, house?.propertyId ?? null, now, "context-changed");
  return event;
}

function addTruth(
  runtime: LocalSpatialLayerRuntime,
  value: SpatialScope,
  request: Request,
  createdBy: string | null,
): SpatialGroundTruth {
  const body = bodyObject(request.body);
  rejectUnknownFields(body, new Set([
    "id", "startAt", "endAt", "label", "zoneId", "fromZoneId", "toZoneId", "source", "note",
  ]), "Spatial ground truth");
  const now = new Date().toISOString();
  return runtime.state.addGroundTruth(runtime.host.partition, {
    id: optionalString(body, "id") ?? randomUUID(), scope: value, startAt: isoTimestamp(body.startAt, "startAt", now),
    endAt: body.endAt === undefined || body.endAt === null ? null : isoTimestamp(body.endAt, "endAt"),
    label: requiredString(body, "label"), zoneId: nullableString(body, "zoneId") ?? null,
    fromZoneId: nullableString(body, "fromZoneId") ?? null, toZoneId: nullableString(body, "toZoneId") ?? null,
    source: enumValue(body.source === undefined ? "user" : body.source, GROUND_TRUTH_SOURCES, "source"), note: nullableString(body, "note") ?? null,
    createdAt: now, createdBy,
  });
}

export function registerSpatialLayerRoutes(
  app: Application,
  options: SpatialRouteOptions,
): void {
  const prefix = options.prefix ?? "/api/v1";
  app.get(`${prefix}/layer-engines`, (_request, response) => {
    response.json({ enabled: options.runtime !== null, engines: options.runtime?.host.manifests ?? [] });
  });

  for (const kind of ["house", "property"] as const) {
    const collection = kind === "house" ? "houses" : "properties";
    const base = `${prefix}/${collection}/:id/layers`;
    app.get(`${base}/current`, asyncRoute(async (request, response) => { response.json(await current(requireRuntime(options.runtime), authorizedScope(options, kind, request, response), request)); }));
    app.get(`${base}/history`, (request, response) => { try { response.json(history(requireRuntime(options.runtime), authorizedScope(options, kind, request, response), request)); } catch (error) { sendError(response, error); } });
    app.get(`${base}/health`, (request, response) => {
      try {
        const runtime = requireRuntime(options.runtime); const value = authorizedScope(options, kind, request, response); requireScope(runtime, value);
        response.json({ partition: runtime.host.partition, scope: value, engines: runtime.host.health(value) });
      } catch (error) { sendError(response, error); }
    });
    app.get(`${base}/config`, asyncRoute(async (request, response) => { response.json(await configuration(requireRuntime(options.runtime), authorizedScope(options, kind, request, response))); }));
    app.put(`${base}/config`, asyncRoute(async (request, response) => {
      response.json(await saveConfiguration(
        requireRuntime(options.runtime),
        authorizedScope(options, kind, request, response),
        request,
        auditActor(options, request, response),
      ));
    }));
    app.post(`${base}/infer`, asyncRoute(async (request, response) => {
      const runtime = requireRuntime(options.runtime); const value = authorizedScope(options, kind, request, response); requireScope(runtime, value);
      const body = bodyObject(request.body);
      rejectUnknownFields(body, new Set(["bucketAt", "layers"]), "Spatial layer inference");
      const bucketAt = isoTimestamp(body.bucketAt, "bucketAt", new Date().toISOString());
      response.json(await runtime.host.inferScope(value, bucketAt, stringArray(body.layers, "layers")));
    }));
    app.get(`${base}/ground-truth`, (request, response) => {
      try {
        const runtime = requireRuntime(options.runtime); const value = authorizedScope(options, kind, request, response); requireScope(runtime, value);
        response.json({ groundTruth: runtime.state.listGroundTruth(runtime.host.partition, value) });
      } catch (error) { sendError(response, error); }
    });
    app.post(`${base}/ground-truth`, (request, response) => {
      try {
        const runtime = requireRuntime(options.runtime); const value = authorizedScope(options, kind, request, response); requireScope(runtime, value);
        response.status(201).json({
          groundTruth: addTruth(runtime, value, request, auditActor(options, request, response)),
        });
      } catch (error) { sendError(response, error); }
    });
  }

  const houseBase = `${prefix}/houses/:id/layers`;
  app.get(`${houseBase}/bindings`, (request, response) => { try {
    const runtime = requireRuntime(options.runtime); requireScope(runtime, authorizedScope(options, "house", request, response));
    response.json({ bindings: runtime.state.listBindings(runtime.host.partition, pathId(request)) });
  } catch (error) { sendError(response, error); } });
  app.post(`${houseBase}/bindings`, asyncRoute(async (request, response) => {
    authorizedScope(options, "house", request, response);
    response.status(201).json({ binding: await addBinding(requireRuntime(options.runtime), pathId(request), request) });
  }));
  app.get(`${houseBase}/calibrations`, (request, response) => { try {
    const runtime = requireRuntime(options.runtime); requireScope(runtime, authorizedScope(options, "house", request, response));
    response.json({ calibrations: runtime.state.listCalibrations(runtime.host.partition, pathId(request)) });
  } catch (error) { sendError(response, error); } });
  app.post(`${houseBase}/calibrations`, (request, response) => { try {
    authorizedScope(options, "house", request, response);
    response.status(201).json({ calibration: addCalibration(requireRuntime(options.runtime), pathId(request), request.body) });
  } catch (error) { sendError(response, error); } });
  app.get(`${houseBase}/calibration-sessions`, (request, response) => { try {
    const runtime = requireRuntime(options.runtime); requireScope(runtime, authorizedScope(options, "house", request, response));
    response.json({ sessions: runtime.state.listCalibrationSessions(runtime.host.partition, pathId(request)) });
  } catch (error) { sendError(response, error); } });
  app.post(`${houseBase}/calibration-sessions`, (request, response) => { try {
    const runtime = requireRuntime(options.runtime);
    requireScope(runtime, authorizedScope(options, "house", request, response));
    const body = bodyObject(request.body);
    rejectUnknownFields(body, new Set([
      "id", "kind", "status", "startAt", "endAt", "intervention", "notes", "calibrations",
    ]), "Spatial calibration session");
    if (body.calibrations !== undefined && !Array.isArray(body.calibrations)) {
      throw new SpatialRouteError(400, "INVALID_FIELD", "calibrations must be an array");
    }
    const now = new Date().toISOString();
    const houseId = pathId(request);
    const session: SpatialCalibrationSession = {
      id: optionalString(body, "id") ?? randomUUID(), houseId,
      kind: enumValue(body.kind, CALIBRATION_SESSION_KINDS, "kind"), status: enumValue(body.status === undefined ? "planned" : body.status, ["planned", "running", "completed", "cancelled"] as const, "status"),
      startAt: isoTimestamp(body.startAt, "startAt", now), endAt: body.endAt === undefined || body.endAt === null ? null : isoTimestamp(body.endAt, "endAt"),
      intervention: body.intervention === undefined ? {} : objectValue(body.intervention, "intervention"), notes: nullableString(body, "notes") ?? null,
      createdAt: now, updatedAt: now,
    };
    // Parse and validate every child before the first write. The state store
    // then commits the already-validated aggregate in one SQLite transaction.
    const calibrationInputs = body.calibrations as unknown[] | undefined;
    const pendingCalibrations = (calibrationInputs ?? []).map((item) => calibrationFromBody(runtime, houseId, item, now));
    const saved = runtime.state.addCalibrationSessionBundle(runtime.host.partition, session, pendingCalibrations);
    const house = runtime.input.core.getHouse(houseId);
    runtime.scheduler.wakeHouse(houseId, house?.propertyId ?? null, now, "calibration-changed");
    response.status(201).json(saved);
  } catch (error) { sendError(response, error); } });
  app.get(`${houseBase}/context-events`, (request, response) => { try {
    const runtime = requireRuntime(options.runtime); requireScope(runtime, authorizedScope(options, "house", request, response));
    const to = isoTimestamp(request.query.to, "to", new Date().toISOString()); const from = isoTimestamp(request.query.from, "from", new Date(Date.parse(to) - 24 * 60 * 60_000).toISOString());
    response.json({ events: runtime.state.listContextEvents(runtime.host.partition, pathId(request), from, to) });
  } catch (error) { sendError(response, error); } });
  app.post(`${houseBase}/context-events`, (request, response) => { try {
    const runtime = requireRuntime(options.runtime);
    requireScope(runtime, authorizedScope(options, "house", request, response));
    response.status(201).json({ event: addContext(runtime, pathId(request), request) });
  } catch (error) { sendError(response, error); } });

  app.get(`${prefix}/layers/events`, (request, response) => {
    let releaseConnection = (): void => undefined;
    try {
      const runtime = requireRuntime(options.runtime);
      const filterKind = request.query.scopeKind;
      const filterId = request.query.scopeId;
      let filteredScope: SpatialScope | null = null;
      if ((filterKind === undefined) !== (filterId === undefined)) {
        throw new SpatialRouteError(400, "INVALID_FILTER", "scopeKind and scopeId must be supplied together");
      }
      if (filterKind !== undefined) {
        if ((filterKind !== "house" && filterKind !== "property") || typeof filterId !== "string" || !filterId) {
          throw new SpatialRouteError(400, "INVALID_FILTER", "scopeKind must be house or property and scopeId must be non-empty");
        }
        filteredScope = { kind: filterKind, id: filterId };
        if (options.authorizeScope && !options.authorizeScope(request, response, filteredScope)) {
          throw new SpatialRouteError(404, "SPATIAL_SCOPE_NOT_FOUND", `${filterKind} ${filterId} does not exist`);
        }
        requireScope(runtime, filteredScope);
      }
      if (options.validateStream && !options.validateStream(request, response)) return;
      const acceptedAuthorization = options.streamAuthorizationFingerprint?.(request, response) ?? null;
      if (options.streamAuthorizationFingerprint && !acceptedAuthorization) {
        throw new SpatialRouteError(401, "UNAUTHORIZED", "The authenticated session is no longer valid");
      }
      if (options.acquireStream) {
        const acquired = options.acquireStream(request, response);
        if (!acquired) {
          response.setHeader("retry-after", "5");
          throw new SpatialRouteError(429, "EVENT_STREAM_LIMIT", "Too many active event streams for this account");
        }
        releaseConnection = acquired;
      }
      response.status(200);
      response.setHeader("content-type", "text/event-stream; charset=utf-8");
      response.setHeader("cache-control", "no-cache, no-transform");
      response.setHeader("connection", "keep-alive");
      response.flushHeaders();
      response.write(`event: ready\ndata: ${JSON.stringify({ partition: runtime.host.partition })}\n\n`);
      let closed = false;
      let unsubscribe = (): void => undefined;
      let releaseRuntimeStream = (): void => undefined;
      let heartbeat: NodeJS.Timeout | null = null;
      const authorizationStatus = (): "valid" | "expired" | "changed" => {
        if (options.streamAuthorizationFingerprint) {
          const current = options.streamAuthorizationFingerprint(request, response);
          if (!current) return "expired";
          if (current !== acceptedAuthorization) return "changed";
        }
        if (filteredScope && options.authorizeScope && !options.authorizeScope(request, response, filteredScope)) {
          return "changed";
        }
        return "valid";
      };
      const close = (authorization?: "expired" | "changed"): void => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        releaseRuntimeStream();
        releaseConnection();
        if (!response.writableEnded) {
          response.end(authorization
            ? `event: authorization\ndata: ${JSON.stringify({ status: authorization })}\n\n`
            : undefined);
        }
      };
      unsubscribe = runtime.notifier.subscribe((notification) => {
        const authorization = authorizationStatus();
        if (authorization !== "valid") { close(authorization); return; }
        if (typeof filterKind === "string" && notification.scope.kind !== filterKind) return;
        if (typeof filterId === "string" && notification.scope.id !== filterId) return;
        if (options.authorizeScope && !options.authorizeScope(request, response, notification.scope)) return;
        if (!response.write(`event: spatial-layer-snapshot\ndata: ${JSON.stringify(notification)}\n\n`)) close();
      });
      heartbeat = setInterval(() => {
        const authorization = authorizationStatus();
        if (authorization !== "valid") { close(authorization); return; }
        if (!response.writableEnded && !response.write(": heartbeat\n\n")) close();
      }, 15_000);
      heartbeat.unref();
      releaseRuntimeStream = runtime.trackStream(close);
      request.once("aborted", close);
      response.once("close", close);
    } catch (error) {
      releaseConnection();
      sendError(response, error);
    }
  });
}
