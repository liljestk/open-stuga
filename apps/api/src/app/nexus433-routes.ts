import type { Sensor, SensorCreateInput } from "@climate-twin/contracts";
import { Nexus433StoreError } from "../nexus433/index.js";
import {
  HttpError,
  bodyObject,
  optionalBoolean,
  requiredNumber,
  requiredString,
  requireWorkspaceAdmin,
} from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

export type Nexus433RouteContext = Pick<
  ApiRouteRegistrationContext,
  | "app"
  | "prefix"
  | "database"
  | "nexus433"
  | "visibility"
  | "stuguby"
  | "notifySpatialSensorChange"
>;

function houseIdFromQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new HttpError(400, "INVALID_FIELD", "houseId must identify one Home");
  }
  return value.trim();
}

function visibleHouse(context: Nexus433RouteContext, response: Parameters<Nexus433RouteContext["visibility"]>[0], houseId: string): void {
  const house = context.database.getHouse(houseId);
  if (!house || !context.visibility(response).house(houseId)) {
    throw new HttpError(404, "NOT_FOUND", "Home not found");
  }
}

function sensorInput(value: unknown, houseId: string): SensorCreateInput {
  const body = bodyObject(value);
  const tags = body.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 50 || tags.some((tag) => typeof tag !== "string" || tag.length > 100)) {
    throw new HttpError(400, "INVALID_FIELD", "sensor.tags must be a short string array");
  }
  if (body.houseId !== houseId) throw new HttpError(400, "INVALID_FIELD", "The sensor must belong to the selected Home");
  const enabled = body.enabled === undefined ? true : optionalBoolean(body, "enabled") as boolean;
  if (!enabled) throw new HttpError(400, "INVALID_FIELD", "A new receiver sensor must be enabled");
  return {
    ...(typeof body.id === "string" && body.id.trim() ? { id: body.id.trim() } : {}),
    houseId,
    floorId: requiredString(body, "floorId"),
    ...(body.roomId !== undefined ? { roomId: body.roomId === null ? null : requiredString(body, "roomId") } : {}),
    name: requiredString(body, "name"),
    room: requiredString(body, "room"),
    model: requiredString(body, "model"),
    x: requiredNumber(body, "x"),
    y: requiredNumber(body, "y"),
    z: requiredNumber(body, "z"),
    tags: tags as string[],
    enabled,
    energyMeterRole: "standalone",
  };
}

function routeError(error: unknown): unknown {
  if (error instanceof Nexus433StoreError) return new HttpError(error.status, error.code, error.message);
  return error;
}

export function registerNexus433Routes(context: Nexus433RouteContext): void {
  context.app.get(`${context.prefix}/integrations/nexus433/status`, (request, response) => {
    const houseId = houseIdFromQuery(request.query.houseId);
    visibleHouse(context, response, houseId);
    response.setHeader("cache-control", "no-store");
    response.json(context.nexus433.status(houseId));
  });

  context.app.put(`${context.prefix}/integrations/nexus433/config`, requireWorkspaceAdmin, async (request, response, next) => {
    try {
      const body = bodyObject(request.body);
      const houseId = requiredString(body, "houseId");
      visibleHouse(context, response, houseId);
      context.stuguby.assertHouseLocalAuthority(houseId);
      const enabled = optionalBoolean(body, "enabled");
      if (enabled === undefined) throw new HttpError(400, "INVALID_FIELD", "enabled must be a boolean");
      const expectedRevision = body.expectedRevision === undefined
        ? undefined
        : requiredNumber(body, "expectedRevision");
      if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
        throw new HttpError(400, "INVALID_FIELD", "expectedRevision must be a non-negative integer");
      }
      response.status(202).json(await context.nexus433.configure({
        houseId,
        enabled,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }));
    } catch (error) {
      next(routeError(error));
    }
  });

  context.app.get(`${context.prefix}/integrations/nexus433/candidates`, requireWorkspaceAdmin, (request, response) => {
    const houseId = houseIdFromQuery(request.query.houseId);
    visibleHouse(context, response, houseId);
    response.setHeader("cache-control", "no-store");
    response.json({ candidates: context.nexus433.listCandidates(houseId) });
  });

  context.app.get(`${context.prefix}/integrations/nexus433/bindings`, requireWorkspaceAdmin, (request, response) => {
    const houseId = houseIdFromQuery(request.query.houseId);
    visibleHouse(context, response, houseId);
    response.setHeader("cache-control", "no-store");
    response.json({ bindings: context.nexus433.listBindings(houseId) });
  });

  context.app.post(`${context.prefix}/integrations/nexus433/bindings`, requireWorkspaceAdmin, (request, response, next) => {
    try {
      const body = bodyObject(request.body);
      const houseId = requiredString(body, "houseId");
      const candidateId = requiredString(body, "candidateId");
      visibleHouse(context, response, houseId);
      context.stuguby.assertHouseLocalAuthority(houseId);
      const hasSensorId = typeof body.sensorId === "string" && Boolean(body.sensorId.trim());
      const hasSensor = body.sensor !== undefined;
      if (hasSensorId === hasSensor) {
        throw new HttpError(400, "INVALID_FIELD", "Choose either an existing sensor or a new sensor");
      }
      let created: Sensor | null = null;
      const binding = context.database.transaction(() => {
        const id = hasSensorId
          ? requiredString(body, "sensorId")
          : (created = context.database.createSensor(sensorInput(body.sensor, houseId))).id;
        return context.nexus433.store.bindCandidate(houseId, candidateId, id);
      });
      if (created) {
        context.stuguby.captureHomeMutation(houseId);
        context.notifySpatialSensorChange(null, created);
      }
      response.status(201).json({ binding, ...(created ? { sensor: created } : {}) });
    } catch (error) {
      next(routeError(error));
    }
  });

  context.app.post(`${context.prefix}/integrations/nexus433/bindings/:sensorId/reconnect`, requireWorkspaceAdmin, (request, response, next) => {
    try {
      const body = bodyObject(request.body);
      const houseId = requiredString(body, "houseId");
      const candidateId = requiredString(body, "candidateId");
      const expectedRevision = requiredNumber(body, "expectedRevision");
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
        throw new HttpError(400, "INVALID_FIELD", "expectedRevision must be a positive integer");
      }
      visibleHouse(context, response, houseId);
      context.stuguby.assertHouseLocalAuthority(houseId);
      const sensorId = request.params.sensorId as string;
      const sensor = context.database.getSensor(sensorId);
      if (!sensor || sensor.houseId !== houseId) throw new HttpError(404, "SENSOR_NOT_FOUND", "Sensor not found");
      const binding = context.nexus433.store.reconnectCandidate(
        houseId,
        sensorId,
        candidateId,
        expectedRevision,
      );
      response.json({ binding });
    } catch (error) {
      next(routeError(error));
    }
  });
}
