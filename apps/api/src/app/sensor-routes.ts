import type { Request, Response } from "express";
import type { Sensor } from "@climate-twin/contracts";
import { HttpError, bodyObject, enumValue, measurementStringMap, optionalBoolean, optionalString, parseSensorPatch, requiredNumber, requiredString } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Sensor CRUD, sensor labels and the sensor snapshot views. */
export function registerSensorRoutes(context: ApiRouteRegistrationContext): void {
  context.app.get(`${context.prefix}/sensors/snapshots`, (request, response) => {
      response.json({ sensors: visibleSensorSnapshots(context, request, response) });
    });
  // Compatibility path documented as listSnapshotCompatibility.
  context.app.get(`${context.prefix}/snapshot`, (request, response) => {
      response.json({ snapshot: visibleSensorSnapshots(context, request, response) });
    });
  context.app.get(`${context.prefix}/sensors`, (request, response) => {
      const houseId = typeof request.query.houseId === "string" ? request.query.houseId : undefined;
      const access = context.visibility(response);
      response.json({ sensors: context.database.listSensors(houseId).filter((sensor) => access.sensor(sensor.id)) });
    });
  context.app.post(`${context.prefix}/sensors`, (request, response) => {
      const input = parseSensorInput(bodyObject(request.body));
      context.stuguby.assertHouseWriteAllowed(input.houseId);
      if (bindsIntegration(input)) context.stuguby.assertHouseLocalAuthority(input.houseId);
      context.assertTpLinkConnectionScope(input);
      const sensor = context.database.transaction(() => {
        const created = context.database.createSensor(input);
        context.stuguby.captureHomeMutation(created.houseId);
        return created;
      });
      context.homeAssistant.refreshMappings();
      context.notifySpatialSensorChange(null, sensor);
      response.status(201).json({ sensor });
    });
  context.app.get(`${context.prefix}/sensors/:id`, (request, response) => {
      const sensor = context.database.getSensor(request.params.id as string);
      if (!sensor || !context.visibility(response).sensor(sensor.id)) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
      response.json({ sensor, reading: context.database.getLatestReading(sensor.id) });
    });
  context.app.patch(`${context.prefix}/sensors/:id`, (request, response) => {
      response.json({ sensor: applySensorPatch(context, request.params.id as string, request.body) });
    });
  // Compatibility verb: same update, answered with the bare sensor.
  context.app.put(`${context.prefix}/sensors/:id`, (request, response) => {
      response.json(applySensorPatch(context, request.params.id as string, request.body));
    });
  context.app.delete(`${context.prefix}/sensors/:id`, async (request, response) => {
      const current = context.database.getSensor(request.params.id as string);
      if (current) context.stuguby.assertHouseWriteAllowed(current.houseId);
      if (current?.tags.includes("integration:gree")) {
        throw new HttpError(409, "SENSOR_MANAGED_BY_INTEGRATION", "Disconnect this heat pump from Set up; its history will be retained");
      }
      context.requireImmutableTelemetryLineage("sensor", request.params.id as string);
      context.database.transaction(() => {
        if (!context.database.deleteSensor(request.params.id as string)) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
        if (current) context.stuguby.captureHomeMutation(current.houseId);
      });
      context.homeAssistant.refreshMappings();
      context.notifySpatialSensorChange(current, null);
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/sensors/:id/label`, (request, response) => {
      const sensorId = request.params.id as string;
      if (!context.visibility(response).sensor(sensorId)) {
        throw new HttpError(404, "NOT_FOUND", "Sensor not found");
      }
      const label = context.setupDoctor.sensorLabel(sensorId);
      if (!label) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
      response.json({ label });
    });
}

/** Validated body of POST /sensors. */
function parseSensorInput(body: Record<string, unknown>): Omit<Sensor, "id"> & { id?: string } {
  const tags = body.tags === undefined ? [] : body.tags;
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) throw new HttpError(400, "INVALID_FIELD", "tags must be a string array");
  if (tags.includes("integration:gree")) {
    throw new HttpError(400, "RESERVED_SENSOR_TAG", "The Gree sensor tag is managed by the heat-pump connection");
  }
  return {
    ...(typeof body.id === "string" ? { id: body.id } : {}),
    houseId: requiredString(body, "houseId"), floorId: requiredString(body, "floorId"), name: requiredString(body, "name"),
    ...(body.roomId !== undefined ? { roomId: body.roomId === null ? null : requiredString(body, "roomId") } : {}),
    room: requiredString(body, "room"), model: requiredString(body, "model"), x: requiredNumber(body, "x"),
    y: requiredNumber(body, "y"), z: requiredNumber(body, "z"), tags: tags as string[],
    energyMeterRole: body.energyMeterRole === undefined
      ? "standalone"
      : enumValue(body.energyMeterRole, ["whole_home", "submeter", "standalone"] as const, "energyMeterRole"),
    enabled: body.enabled === undefined ? true : optionalBoolean(body, "enabled") as boolean,
    ...presentOptionalString(body, "temperatureEntityId"),
    ...presentOptionalString(body, "humidityEntityId"),
    ...presentOptionalString(body, "batteryEntityId"),
    ...presentRequiredString(body, "tpLinkDeviceId"),
    ...presentRequiredString(body, "tpLinkConnectionId"),
    ...(body.measurementEntityIds !== undefined ? { measurementEntityIds: measurementStringMap(body.measurementEntityIds, "measurementEntityIds") } : {}),
  };
}

/** A sensor bound to Home Assistant, TP-Link or measurement entities needs local Home authority. */
function bindsIntegration(input: Omit<Sensor, "id">): boolean {
  return Boolean(input.temperatureEntityId || input.humidityEntityId || input.batteryEntityId
    || input.tpLinkDeviceId || input.tpLinkConnectionId || Object.keys(input.measurementEntityIds ?? {}).length > 0);
}

/** `{ [key]: value }` when the optional string field is present, else `{}`. */
function presentOptionalString<K extends string>(body: Record<string, unknown>, key: K): Partial<Record<K, string>> {
  const value = optionalString(body, key);
  return value === undefined ? {} : { [key]: value } as Record<K, string>;
}

/** `{ [key]: value }` when the field is set (not undefined or null), validated as a required string. */
function presentRequiredString<K extends string>(body: Record<string, unknown>, key: K): Partial<Record<K, string>> {
  return body[key] === undefined || body[key] === null ? {} : { [key]: requiredString(body, key) } as Record<K, string>;
}

/** Sensors the caller may see, each with its latest v1 reading. */
function visibleSensorSnapshots(context: ApiRouteRegistrationContext, request: Request, response: Response) {
  const access = context.visibility(response);
  const sensors = context.database.listSensors(typeof request.query.houseId === "string" ? request.query.houseId : undefined)
    .filter((sensor) => access.sensor(sensor.id));
  const selected = new Set(sensors.map((sensor) => sensor.id));
  const latest = new Map(context.cachedLatestReadings().filter((reading) => selected.has(reading.sensorId))
    .map((reading) => [reading.sensorId, reading]));
  return sensors.map((sensor) => ({ ...sensor, reading: latest.get(sensor.id) ?? null }));
}

const INTEGRATION_BINDING_FIELDS = ["temperatureEntityId", "humidityEntityId", "batteryEntityId", "tpLinkDeviceId", "tpLinkConnectionId", "measurementEntityIds"];

/** Checks that depend on the parsed patch: reserved tags, house moves, integration bindings and TP-Link scope. */
function assertSensorPatchAllowed(context: ApiRouteRegistrationContext, current: Sensor | null, patch: ReturnType<typeof parseSensorPatch>): void {
  if (patch.tags?.includes("integration:gree")) {
    throw new HttpError(400, "RESERVED_SENSOR_TAG", "The Gree sensor tag is managed by the heat-pump connection");
  }
  if (!current) return;
  if (patch.houseId && patch.houseId !== current.houseId) {
    context.stuguby.assertHouseWriteAllowed(patch.houseId);
    context.assertSensorHouseMoveAllowed(current.houseId, patch.houseId);
  }
  if (INTEGRATION_BINDING_FIELDS.some((field) => Object.hasOwn(patch, field))) context.stuguby.assertHouseLocalAuthority(current.houseId);
  if (Object.hasOwn(patch, "houseId") || Object.hasOwn(patch, "tpLinkDeviceId") || Object.hasOwn(patch, "tpLinkConnectionId")) {
    const candidate = { ...current, ...patch };
    if (patch.tpLinkDeviceId === null) {
      delete candidate.tpLinkDeviceId;
      delete candidate.tpLinkConnectionId;
    }
    if (patch.tpLinkConnectionId === null) delete candidate.tpLinkConnectionId;
    context.assertTpLinkConnectionScope(candidate);
  }
}

/** PATCH and PUT /sensors/:id: validate, update, record Stuguby mutations and refresh dependants. */
function applySensorPatch(context: ApiRouteRegistrationContext, sensorId: string, body: unknown): Sensor {
  const current = context.database.getSensor(sensorId);
  // Parse after the authority check on the current sensor, as before, so a
  // shared sensor rejects the write before its body is validated.
  if (current) context.stuguby.assertHouseWriteAllowed(current.houseId);
  if (current?.tags.includes("integration:gree")) {
    throw new HttpError(409, "SENSOR_MANAGED_BY_INTEGRATION", "Manage this heat-pump sensor from Set up");
  }
  const patch = parseSensorPatch(body);
  assertSensorPatchAllowed(context, current, patch);
  const sensor = context.database.transaction(() => {
    const updated = context.database.updateSensor(sensorId, patch);
    if (!updated) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
    if (current && current.houseId !== updated.houseId) context.stuguby.captureHomeMutation(current.houseId);
    context.stuguby.captureHomeMutation(updated.houseId);
    return updated;
  });
  context.homeAssistant.refreshMappings();
  context.notifySpatialSensorChange(current, sensor);
  return sensor;
}
