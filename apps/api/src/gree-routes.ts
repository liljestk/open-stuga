import { recordFailureCause, type SystemErrorLog } from "./system-error-log.js";
import type express from "express";
import type { AppConfig } from "./config.js";
import type { ClimateDatabase } from "./db.js";
import { GreeBridge } from "./gree.js";
import type { GreeBindingResult } from "./gree-protocol.js";
import type { HeatPumpStateStore } from "./heat-pump-state.js";
import type { IntegrationStatus } from "@climate-twin/contracts";
import {
  updateIntegrationSecrets,
  type GreeConnectionSecret,
} from "./integration-secrets.js";
import type { RuntimeStatus } from "./services.js";
import type { TelemetryArchiveWorker } from "./timeseries/archive-worker.js";
import { isLocalTelemetryHistoryComplete } from "./timeseries/read-support.js";
import type { TimeseriesStore } from "./timeseries/store.js";
import { HttpError } from "./http-error.js";
import { bodyObject, rejectUnknownFields, requiredString } from "./request-fields.js";
import { credentialString } from "./app/support/credentials.js";
import { requestPrincipal, requireWorkspaceAdmin } from "./app/support/local-sessions.js";
import { safeInteger } from "./app/support/query-fields.js";

interface GreeRouteContext {
  app: express.Express;
  prefix: string;
  config: AppConfig;
  database: ClimateDatabase;
  gree: GreeBridge;
  heatPumpStates: HeatPumpStateStore;
  timeseries: TimeseriesStore | null;
  telemetryArchive: TelemetryArchiveWorker | null;
  status: RuntimeStatus;
  options: { startBackground?: boolean };
  stuguby: { assertHouseLocalAuthority(houseId: string): void };
  dataMode: { activate(): void };
  visibility(response: express.Response): { house(houseId: string): boolean };
  systemErrorLog: Pick<SystemErrorLog, "record">;
  integrationStatusForHouse(houseId?: string): IntegrationStatus;
  recordSecurityAudit(
    principal: ReturnType<typeof requestPrincipal>,
    event: {
      eventType: "integration.credentials.configured" | "integration.credentials.revoked";
      subjectType: "integration";
      subjectId: string;
      details: Record<string, string>;
    },
  ): void;
}

function macAddress(value: string): string {
  const normalized = value.replace(/[:-]/g, "").trim().toUpperCase();
  if (!/^[0-9A-F]{12}$/u.test(normalized)) {
    throw new HttpError(400, "INVALID_GREE_DEVICE", "The selected heat-pump identity is invalid");
  }
  return normalized;
}

function queryDate(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new HttpError(400, "INVALID_DATE", `${label} must be an ISO date-time`);
  }
  return new Date(value).toISOString();
}

function equipmentName(
  device: { name: string | null; brand: string | null; model: string | null },
): string {
  const genericName = device.name && !/^[0-9a-f]{12}$/iu.test(device.name) ? device.name : null;
  return genericName ?? ([device.brand, device.model].filter(Boolean).join(" ") || "Air-source heat pump");
}

function requireFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "INVALID_FIELD", `${name} must be a finite number`);
  }
  return value;
}

function heatPumpPlacement(
  database: ClimateDatabase,
  houseId: string,
  body: Record<string, unknown>,
): Pick<ReturnType<HeatPumpStateStore["current"]>[number], "floorId" | "roomId" | "x" | "y" | "z"> {
  const floorId = body.floorId === null ? null
    : typeof body.floorId === "string" && body.floorId.trim() ? body.floorId.trim() : undefined;
  const roomId = body.roomId === null || body.roomId === undefined ? null
    : typeof body.roomId === "string" && body.roomId.trim() ? body.roomId.trim() : undefined;
  if (floorId === undefined || roomId === undefined) {
    throw new HttpError(400, "INVALID_FIELD", "floorId and roomId must be strings or null");
  }
  if (floorId === null) {
    if (roomId || ["x", "y", "z"].some((key) => body[key] !== undefined && body[key] !== null)) {
      throw new HttpError(422, "GREE_PLACEMENT_INCOMPLETE", "Choose a floor before positioning the heat pump");
    }
    return { floorId: null, roomId: null, x: null, y: null, z: null };
  }
  const house = database.getHouse(houseId);
  const floor = house?.floors.find((candidate) => candidate.id === floorId);
  if (!floor) throw new HttpError(422, "GREE_FLOOR_NOT_FOUND", "The selected floor does not belong to this Home");
  const room = roomId ? floor.rooms.find((candidate) => candidate.id === roomId) : null;
  if (roomId && !room) throw new HttpError(422, "GREE_ROOM_NOT_FOUND", "The selected room does not belong to this floor");
  const x = body.x === undefined ? floor.width / 2 : requireFiniteNumber(body.x, "x");
  const y = body.y === undefined ? floor.height / 2 : requireFiniteNumber(body.y, "y");
  const defaultHeight = Math.max(1.8, (floor.ceilingHeight ?? 2.4) - .35);
  const z = body.z === undefined ? floor.elevation + defaultHeight : requireFiniteNumber(body.z, "z");
  if (x < 0 || x > floor.width || y < 0 || y > floor.height) {
    throw new HttpError(422, "GREE_PLACEMENT_OUT_OF_BOUNDS", "The heat pump must be inside the selected floor");
  }
  return { floorId, roomId: room?.id ?? null, x, y, z };
}

/** Registers read-only direct Gree/Wilfa state and explicit bind/disconnect routes. */
export function registerGreeRoutes(context: GreeRouteContext): void {
  const pendingBindings = new Set<string>();

  const saveBinding = (
    houseId: string,
    binding: GreeBindingResult,
    transport: "local" | "ewpe-cloud",
    credentials: { username: string; password: string } | null,
    response: express.Response,
  ) => {
    const house = context.database.getHouse(houseId);
    if (!house) throw new HttpError(404, "NOT_FOUND", "Home not found");
    const mac = binding.device.mac;
    if ((context.config.greeConnections ?? []).some((connection) => connection.mac === mac)) {
      throw new HttpError(409, "GREE_ALREADY_CONFIGURED", "This heat pump has already been added");
    }
    const id = GreeBridge.connectionId(mac);
    const equipmentId = `heat-pump-${mac.toLowerCase()}`;
    const existingEquipment = context.database.getAreaEquipment(equipmentId);
    if (existingEquipment && (
      existingEquipment.propertyId !== house.propertyId
      || existingEquipment.serialNumber !== mac
    )) {
      throw new HttpError(409, "GREE_EQUIPMENT_CONFLICT", "The heat-pump inventory identity is already in use");
    }
    let createdEquipment = false;
    const previousEquipmentLocation = existingEquipment
      ? { areaId: existingEquipment.areaId, houseId: existingEquipment.houseId ?? null, status: existingEquipment.status }
      : null;
    const equipment = existingEquipment ?? context.database.createAreaEquipment({
      id: equipmentId,
      propertyId: house.propertyId,
      houseId,
      name: equipmentName(binding.device),
      kind: "air-source-heat-pump",
      manufacturer: binding.device.brand,
      model: binding.device.model,
      serialNumber: mac,
      status: "active",
      notes: transport === "local"
        ? "Local read-only state through the Gree protocol."
        : "Read-only state through the EWPE Smart cloud.",
    });
    createdEquipment = !existingEquipment;
    if (existingEquipment && existingEquipment.houseId !== houseId) {
      context.database.updateAreaEquipment(equipment.id, { houseId, status: "active" }, "system-service");
    }
    const connection: GreeConnectionSecret = {
      id,
      houseId,
      equipmentId: equipment.id,
      ...(transport === "ewpe-cloud" ? { transport } : {}),
      host: binding.device.host,
      port: binding.device.port,
      mac,
      key: binding.key,
      cipherVersion: binding.cipherVersion,
      ...(binding.device.name ? { name: binding.device.name } : {}),
      ...(binding.device.brand ? { brand: binding.device.brand } : {}),
      ...(binding.device.model ? { model: binding.device.model } : {}),
      ...(binding.device.version ? { version: binding.device.version } : {}),
      ...(credentials ? { cloudUsername: credentials.username, cloudPassword: credentials.password } : {}),
    };
    const connections = [...(context.config.greeConnections ?? []), connection];
    try {
      updateIntegrationSecrets(context.config.integrationSecretsFile, { greeConnections: connections });
    } catch (error) {
      if (createdEquipment) context.database.deleteAreaEquipment(equipment.id);
      else if (previousEquipmentLocation && existingEquipment?.houseId !== houseId) {
        context.database.updateAreaEquipment(equipment.id, previousEquipmentLocation, "system-service");
      }
      throw error;
    }
    context.config.greeConnections = connections;
    context.dataMode.activate();
    const state = context.gree.recordInitial(connection, binding.state, true);
    context.gree.refreshConfiguration();
    context.recordSecurityAudit(requestPrincipal(response), {
      eventType: "integration.credentials.configured",
      subjectType: "integration",
      subjectId: `gree:${id}`,
      details: { integration: "gree", connectionId: id, houseId, transport },
    });
    response.json({
      ok: true,
      configured: true,
      connectionId: id,
      houseId,
      state,
      integration: structuredClone(context.status.value),
    });
  };

  context.app.post(`${context.prefix}/integrations/gree/discover`, requireWorkspaceAdmin, async (request, response) => {
    const body = bodyObject(request.body);
    rejectUnknownFields(body, new Set(["houseId"]), "Gree discovery");
    const houseId = requiredString(body, "houseId");
    if (!context.database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "Home not found");
    context.stuguby.assertHouseLocalAuthority(houseId);
    const devices = await context.gree.discoverSources(houseId);
    response.json({ devices });
  });

  context.app.put(`${context.prefix}/integrations/gree/config`, requireWorkspaceAdmin, async (request, response) => {
    const body = bodyObject(request.body);
    rejectUnknownFields(body, new Set(["houseId", "mac"]), "Gree configuration");
    const houseId = requiredString(body, "houseId");
    const house = context.database.getHouse(houseId);
    if (!house) throw new HttpError(404, "NOT_FOUND", "Home not found");
    context.stuguby.assertHouseLocalAuthority(houseId);
    const mac = macAddress(requiredString(body, "mac"));
    if ((context.config.greeConnections ?? []).some((connection) => connection.mac === mac)) {
      throw new HttpError(409, "GREE_ALREADY_CONFIGURED", "This heat pump has already been added");
    }
    if (pendingBindings.has(mac)) {
      throw new HttpError(409, "GREE_BIND_IN_PROGRESS", "This heat pump is already being added");
    }
    pendingBindings.add(mac);
    try {
      let binding: GreeBindingResult;
      try {
        binding = await context.gree.bind(mac);
      } catch (error) {
        recordFailureCause(context.systemErrorLog, "gree", error);
        throw new HttpError(
          422,
          "GREE_BIND_FAILED",
          "Stugu could not add the heat pump. Check that it is online, set up in EWPE Smart, and on this LAN.",
        );
      }
      saveBinding(houseId, binding, "local", null, response);
    } finally {
      pendingBindings.delete(mac);
    }
  });

  context.app.post(`${context.prefix}/integrations/gree/cloud/discover`, requireWorkspaceAdmin, async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const body = bodyObject(request.body);
    rejectUnknownFields(body, new Set(["houseId", "username", "password"]), "EWPE cloud discovery");
    const houseId = requiredString(body, "houseId");
    if (!context.database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "Home not found");
    context.stuguby.assertHouseLocalAuthority(houseId);
    const username = credentialString(body, "username", 320, true);
    const password = credentialString(body, "password", 8_192);
    try {
      const devices = await context.gree.discoverCloud(username, password, houseId);
      response.json({ devices });
    } catch (error) {
      recordFailureCause(context.systemErrorLog, "gree", error);
      throw new HttpError(
        422,
        "EWPE_DISCOVERY_FAILED",
        "Stugu could not read this EWPE account. Check the credentials and internet connection.",
      );
    }
  });

  context.app.put(`${context.prefix}/integrations/gree/cloud/config`, requireWorkspaceAdmin, async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const body = bodyObject(request.body);
    rejectUnknownFields(body, new Set(["houseId", "mac", "username", "password"]), "EWPE cloud configuration");
    const houseId = requiredString(body, "houseId");
    if (!context.database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "Home not found");
    context.stuguby.assertHouseLocalAuthority(houseId);
    const mac = macAddress(requiredString(body, "mac"));
    const username = credentialString(body, "username", 320, true);
    const password = credentialString(body, "password", 8_192);
    if ((context.config.greeConnections ?? []).some((connection) => connection.mac === mac)) {
      throw new HttpError(409, "GREE_ALREADY_CONFIGURED", "This heat pump has already been added");
    }
    if (pendingBindings.has(mac)) throw new HttpError(409, "GREE_BIND_IN_PROGRESS", "This heat pump is already being added");
    pendingBindings.add(mac);
    try {
      let binding: GreeBindingResult;
      try {
        binding = await context.gree.bindCloud(username, password, mac);
      } catch (error) {
        recordFailureCause(context.systemErrorLog, "gree", error);
        throw new HttpError(
          422,
          "EWPE_BIND_FAILED",
          "Stugu could not verify live read-only data for this heat pump through EWPE Smart.",
        );
      }
      saveBinding(houseId, binding, "ewpe-cloud", { username, password }, response);
    } finally {
      pendingBindings.delete(mac);
    }
  });

  context.app.delete(`${context.prefix}/integrations/gree/config/:connectionId`, requireWorkspaceAdmin, (request, response) => {
    const id = request.params.connectionId as string;
    const connection = (context.config.greeConnections ?? []).find((candidate) => candidate.id === id);
    if (!connection) throw new HttpError(404, "NOT_FOUND", "Heat-pump connection not found");
    context.stuguby.assertHouseLocalAuthority(connection.houseId);
    const connections = (context.config.greeConnections ?? []).filter((candidate) => candidate.id !== id);
    updateIntegrationSecrets(context.config.integrationSecretsFile, { greeConnections: connections });
    const unavailable = context.heatPumpStates.markUnavailable(id);
    context.heatPumpStates.detachSensor(id, connection.houseId);
    if (unavailable) void context.telemetryArchive?.reconcileNow().catch(() => undefined);
    context.config.greeConnections = connections;
    context.gree.refreshConfiguration();
    context.recordSecurityAudit(requestPrincipal(response), {
      eventType: "integration.credentials.revoked",
      subjectType: "integration",
      subjectId: `gree:${id}`,
      details: { integration: "gree", connectionId: id, houseId: connection.houseId },
    });
    response.json({
      ok: true,
      integration: structuredClone(context.status.value),
    });
  });

  context.app.get(`${context.prefix}/heat-pumps`, (request, response) => {
    const houseId = typeof request.query.houseId === "string" ? request.query.houseId.trim() : undefined;
    if (houseId && (!context.database.getHouse(houseId) || !context.visibility(response).house(houseId))) {
      throw new HttpError(404, "NOT_FOUND", "Home not found");
    }
    const activeIds = new Set((context.config.greeConnections ?? [])
      .filter((connection) => !houseId || connection.houseId === houseId)
      .map((connection) => connection.id));
    const states = context.heatPumpStates.current(houseId)
      .filter((state) => activeIds.has(state.connectionId) && context.visibility(response).house(state.houseId));
    response.json({ states });
  });

  context.app.patch(`${context.prefix}/heat-pumps/:connectionId/placement`, requireWorkspaceAdmin, (request, response) => {
    const id = request.params.connectionId as string;
    const connection = (context.config.greeConnections ?? []).find((candidate) => candidate.id === id);
    if (!connection) throw new HttpError(404, "NOT_FOUND", "Heat-pump connection not found");
    context.stuguby.assertHouseLocalAuthority(connection.houseId);
    const body = bodyObject(request.body);
    rejectUnknownFields(body, new Set(["floorId", "roomId", "x", "y", "z"]), "heat-pump placement");
    const placement = heatPumpPlacement(context.database, connection.houseId, body);
    const state = context.heatPumpStates.setPlacement(id, connection.houseId, placement);
    response.json({ state });
  });

  context.app.get(`${context.prefix}/heat-pumps/:connectionId/history`, async (request, response) => {
    const id = request.params.connectionId as string;
    const current = context.heatPumpStates.current().find((state) => state.connectionId === id);
    if (!current || !context.visibility(response).house(current.houseId)) {
      throw new HttpError(404, "NOT_FOUND", "Heat-pump history not found");
    }
    const from = queryDate(request.query.from, "from");
    const to = queryDate(request.query.to, "to");
    if (from && to && from > to) throw new HttpError(400, "INVALID_RANGE", "from must not be after to");
    const limit = safeInteger(request.query.limit, 250, 1, 1_000);
    const archiveFrom = from ?? "1970-01-01T00:00:00.000Z";
    const archiveTo = to ?? new Date(Date.now() + 86_400_000).toISOString();
    const localHistoryComplete = isLocalTelemetryHistoryComplete({
      timeseriesEnabled: Boolean(context.config.timeseriesEnabled),
      retentionDays: context.config.retentionDays,
      ...(from === undefined ? {} : { from }),
    });
    const local = context.heatPumpStates.history(id, {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      limit,
    });
    let archived: typeof local = [];
    if (context.timeseries) {
      try {
        archived = await context.timeseries.heatPumpStateHistory({
          connectionId: id,
          from: archiveFrom,
          to: archiveTo,
          limit,
        });
      } catch {
        void context.telemetryArchive?.reconcileNow().catch(() => undefined);
        if (!localHistoryComplete) {
          throw new HttpError(
            503,
            "TELEMETRY_ARCHIVE_REQUIRED",
            "Complete heat-pump history is temporarily unavailable",
          );
        }
      }
    } else if (!localHistoryComplete) {
      throw new HttpError(
        503,
        "TELEMETRY_ARCHIVE_REQUIRED",
        "Complete heat-pump history is temporarily unavailable",
      );
    }
    const merged = new Map<string, (typeof local)[number]>();
    for (const state of [...archived, ...local]) {
      merged.set(JSON.stringify([state.connectionId, state.observedAt]), state);
    }
    const states = [...merged.values()]
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
      .slice(0, limit);
    response.json({ states });
  });
}
