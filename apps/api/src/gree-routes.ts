import type express from "express";
import type { AppConfig } from "./config.js";
import type { ClimateDatabase } from "./db.js";
import { GreeBridge } from "./gree.js";
import type { HeatPumpStateStore } from "./heat-pump-state.js";
import type { IntegrationStatus } from "@climate-twin/contracts";
import {
  updateIntegrationSecrets,
  type GreeConnectionSecret,
} from "./integration-secrets.js";
import type { RuntimeStatus } from "./services.js";
import type { TelemetryArchiveWorker } from "./timeseries/archive-worker.js";
import type { TimeseriesStore } from "./timeseries/store.js";
import {
  HttpError,
  bodyObject,
  rejectUnknownFields,
  requestPrincipal,
  requiredString,
  safeInteger,
} from "./app/support/index.js";

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

/** Registers read-only direct Gree/Wilfa state and explicit bind/disconnect routes. */
export function registerGreeRoutes(context: GreeRouteContext): void {
  const pendingBindings = new Set<string>();

  context.app.post(`${context.prefix}/integrations/gree/discover`, async (request, response) => {
    const body = bodyObject(request.body);
    rejectUnknownFields(body, new Set(["houseId"]), "Gree discovery");
    const houseId = requiredString(body, "houseId");
    if (!context.database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "Home not found");
    context.stuguby.assertHouseLocalAuthority(houseId);
    const devices = await context.gree.discoverSources(houseId);
    response.json({ devices });
  });

  context.app.put(`${context.prefix}/integrations/gree/config`, async (request, response) => {
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
      let binding;
      try {
        binding = await context.gree.bind(mac);
      } catch {
        throw new HttpError(
          422,
          "GREE_BIND_FAILED",
          "Stugu could not add the heat pump. Check that it is online, set up in EWPE Smart, and on this LAN.",
        );
      }
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
        ? {
            areaId: existingEquipment.areaId,
            houseId: existingEquipment.houseId ?? null,
            status: existingEquipment.status,
          }
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
        notes: "Local read-only state through the Gree protocol.",
      });
      createdEquipment = !existingEquipment;
      if (existingEquipment && existingEquipment.houseId !== houseId) {
        context.database.updateAreaEquipment(equipment.id, { houseId, status: "active" }, "system-service");
      }
      const connection: GreeConnectionSecret = {
        id,
        houseId,
        equipmentId: equipment.id,
        host: binding.device.host,
        port: binding.device.port,
        mac,
        key: binding.key,
        cipherVersion: binding.cipherVersion,
        ...(binding.device.name ? { name: binding.device.name } : {}),
        ...(binding.device.brand ? { brand: binding.device.brand } : {}),
        ...(binding.device.model ? { model: binding.device.model } : {}),
        ...(binding.device.version ? { version: binding.device.version } : {}),
      };
      const connections = [...(context.config.greeConnections ?? []), connection];
      try {
        updateIntegrationSecrets(context.config.integrationSecretsFile, { greeConnections: connections });
      } catch (error) {
        if (createdEquipment) context.database.deleteAreaEquipment(equipment.id);
        else if (previousEquipmentLocation && existingEquipment?.houseId !== houseId) {
          context.database.updateAreaEquipment(
            equipment.id,
            previousEquipmentLocation,
            "system-service",
          );
        }
        throw error;
      }
      context.config.greeConnections = connections;
      context.dataMode.activate();
      const state = context.gree.recordInitial(connection, binding.state);
      context.gree.refreshConfiguration();
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: "integration.credentials.configured",
        subjectType: "integration",
        subjectId: `gree:${id}`,
        details: { integration: "gree", connectionId: id, houseId },
      });
      response.json({
        ok: true,
        configured: true,
        connectionId: id,
        houseId,
        state,
        integration: structuredClone(context.status.value),
      });
    } finally {
      pendingBindings.delete(mac);
    }
  });

  context.app.delete(`${context.prefix}/integrations/gree/config/:connectionId`, (request, response) => {
    const id = request.params.connectionId as string;
    const connection = (context.config.greeConnections ?? []).find((candidate) => candidate.id === id);
    if (!connection) throw new HttpError(404, "NOT_FOUND", "Heat-pump connection not found");
    context.stuguby.assertHouseLocalAuthority(connection.houseId);
    const connections = (context.config.greeConnections ?? []).filter((candidate) => candidate.id !== id);
    updateIntegrationSecrets(context.config.integrationSecretsFile, { greeConnections: connections });
    const unavailable = context.heatPumpStates.markUnavailable(id);
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
    const localHistoryComplete = !context.config.timeseriesEnabled
      || (from !== undefined && context.config.retentionDays > 0
        && Date.parse(from) >= Date.now() - context.config.retentionDays * 86_400_000);
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
