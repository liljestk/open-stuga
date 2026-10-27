import { hasLocalHouseAuthority } from "@climate-twin/contracts";
import type {
  Sensor,
} from "@climate-twin/contracts";
import { type AppConfig } from "../config.js";
import { commitCoordinatedIntegrationSecrets } from "../integration-secrets-coordinator.js";
import { HttpError, bodyObject, enumValue, measurementStringMap, optionalBoolean, optionalString, parseReading, parseSensorPatch, queryList, refreshAppleNotesStatus, requiredNumber, requiredString } from "./support/index.js";
import { configureApiPart16 } from "./part-16.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart17(context: ReturnType<typeof configureApiPart16>) {
  const config = context.config as NormalizedApiConfig;
  context.app.delete(`${context.prefix}/houses/:id`, async (request, response) => {
      const houseId = request.params.id as string;
      const previous = context.database.getHouse(houseId);
      if (!previous) throw new HttpError(404, "NOT_FOUND", "House not found");
      context.stuguby.assertHouseWriteAllowed(houseId);
      context.stuguby.assertHouseLocalAuthority(houseId);
      // Revoke every durable share and queue its purge tombstone before the
      // authoritative Home disappears from the local active scope. If this
      // phase fails, the Home stays visible and the request remains retryable.
      context.stuguby.retireLocalHouseShares(houseId);
      const previousHomeAssistantConnections = [...(config.homeAssistantConnections ?? [])];
      const previousTpLinkConnections = [...(config.tpLinkConnections ?? [])];
      const previousGreeConnections = [...(config.greeConnections ?? [])];
      const previousTuyaConnections = [...(config.tuyaConnections ?? [])];
      const previousAppleNotesGrants = [...config.appleNotesGrants];
      const firstLocalHouseId = context.database.listHouses().find(hasLocalHouseAuthority)?.id;
      const hideLegacyHomeAssistant = firstLocalHouseId === houseId && !config.homeAssistantLegacyDisabled
        && Boolean(config.haUrl && config.haToken);
      const hideLegacyTpLink = firstLocalHouseId === houseId && !config.tpLinkLegacyDisabled
        && Boolean(config.tpLinkHost && config.tpLinkUsername && config.tpLinkPassword);
      const remainingHomeAssistantConnections = previousHomeAssistantConnections
        .filter((connection) => connection.houseId !== houseId);
      const remainingTpLinkConnections = previousTpLinkConnections
        .filter((connection) => connection.houseId !== houseId);
      const remainingGreeConnections = previousGreeConnections
        .filter((connection) => connection.houseId !== houseId);
      const greeChanged = remainingGreeConnections.length !== previousGreeConnections.length;
      const remainingTuyaConnections = previousTuyaConnections
        .filter((connection) => connection.houseId !== houseId);
      const tuyaChanged = remainingTuyaConnections.length !== previousTuyaConnections.length;
      const remainingGrants = previousAppleNotesGrants.filter((grant) => grant.houseId !== houseId);
      const connectionsChanged = remainingHomeAssistantConnections.length !== previousHomeAssistantConnections.length
        || remainingTpLinkConnections.length !== previousTpLinkConnections.length
        || greeChanged
        || tuyaChanged
        || hideLegacyHomeAssistant
        || hideLegacyTpLink;
      const grantsChanged = remainingGrants.length !== previousAppleNotesGrants.length;
      if (connectionsChanged || grantsChanged) {
        commitCoordinatedIntegrationSecrets(config.integrationSecretsFile, context.database, (currentSecrets) => {
          context.integrationMetadata.retireHouse(houseId);
          if (!context.database.deleteHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
          const hiddenAt = new Date().toISOString();
          return {
            patch: {
              homeAssistantConnections: remainingHomeAssistantConnections,
              ...(hideLegacyHomeAssistant ? { homeAssistant: null, homeAssistantLegacyDisabled: true } : {}),
              tpLinkConnections: remainingTpLinkConnections,
              ...(hideLegacyTpLink ? { tpLink: null, tpLinkLegacyDisabled: true } : {}),
              greeConnections: remainingGreeConnections,
              tuyaConnections: remainingTuyaConnections,
              appleNotesGrants: remainingGrants,
              hiddenHouseData: [
                ...(currentSecrets.hiddenHouseData ?? []),
                {
                  houseId,
                  hiddenAt,
                  ...(hideLegacyHomeAssistant && currentSecrets.homeAssistant
                    ? { homeAssistant: currentSecrets.homeAssistant }
                    : {}),
                  ...(hideLegacyTpLink && currentSecrets.tpLink ? { tpLink: currentSecrets.tpLink } : {}),
                  homeAssistantConnections: previousHomeAssistantConnections.filter((item) => item.houseId === houseId),
                  tpLinkConnections: previousTpLinkConnections.filter((item) => item.houseId === houseId),
                  greeConnections: previousGreeConnections.filter((item) => item.houseId === houseId),
                  tuyaConnections: previousTuyaConnections.filter((item) => item.houseId === houseId),
                  appleNotesGrants: previousAppleNotesGrants.filter((item) => item.houseId === houseId),
                },
              ],
            },
            result: undefined,
          };
        });
      } else {
        context.database.transaction(() => {
          context.integrationMetadata.retireHouse(houseId);
          if (!context.database.deleteHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
        });
      }
      config.homeAssistantConnections = remainingHomeAssistantConnections;
      if (hideLegacyHomeAssistant) config.homeAssistantLegacyDisabled = true;
      config.tpLinkConnections = remainingTpLinkConnections;
      if (hideLegacyTpLink) config.tpLinkLegacyDisabled = true;
      config.greeConnections = remainingGreeConnections;
      config.tuyaConnections = remainingTuyaConnections;
      config.appleNotesGrants = remainingGrants;
      context.notifySpatial((runtime) => runtime.scheduler.enqueueScope(
        { kind: "property", id: previous.propertyId },
        new Date().toISOString(),
        "ownership-changed",
        true,
      ));
      context.homeAssistant.refreshMappings();
      if (connectionsChanged) {
        if (context.options.startBackground) {
          context.homeAssistant.restart();
          context.tpLink.restart();
        }
        if (greeChanged) context.gree.refreshConfiguration();
        if (tuyaChanged) context.tuya.refreshConfiguration();
      }
      context.weather.invalidate(houseId);
      context.weatherEvents.invalidate(houseId);
      if (grantsChanged) refreshAppleNotesStatus(config, context.status);
      context.status.refreshWeatherConfiguration();
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/sensors/snapshots`, (request, response) => {
      const access = context.visibility(response);
      const sensors = context.database.listSensors(typeof request.query.houseId === "string" ? request.query.houseId : undefined)
        .filter((sensor) => access.sensor(sensor.id));
      const selected = new Set(sensors.map((sensor) => sensor.id));
      const latest = new Map(context.cachedLatestReadings().filter((reading) => selected.has(reading.sensorId))
        .map((reading) => [reading.sensorId, reading]));
      response.json({ sensors: sensors.map((sensor) => ({ ...sensor, reading: latest.get(sensor.id) ?? null })) });
    });
  context.app.get(`${context.prefix}/snapshot`, (request, response) => {
      const access = context.visibility(response);
      const sensors = context.database.listSensors(typeof request.query.houseId === "string" ? request.query.houseId : undefined)
        .filter((sensor) => access.sensor(sensor.id));
      const selected = new Set(sensors.map((sensor) => sensor.id));
      const latest = new Map(context.cachedLatestReadings().filter((reading) => selected.has(reading.sensorId))
        .map((reading) => [reading.sensorId, reading]));
      response.json({ snapshot: sensors.map((sensor) => ({ ...sensor, reading: latest.get(sensor.id) ?? null })) });
    });
  context.app.get(`${context.prefix}/sensors`, (request, response) => {
      const houseId = typeof request.query.houseId === "string" ? request.query.houseId : undefined;
      const access = context.visibility(response);
      response.json({ sensors: context.database.listSensors(houseId).filter((sensor) => access.sensor(sensor.id)) });
    });
  context.app.post(`${context.prefix}/sensors`, (request, response) => {
      const body = bodyObject(request.body);
      const tags = body.tags === undefined ? [] : body.tags;
      if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) throw new HttpError(400, "INVALID_FIELD", "tags must be a string array");
      if (tags.includes("integration:gree")) {
        throw new HttpError(400, "RESERVED_SENSOR_TAG", "The Gree sensor tag is managed by the heat-pump connection");
      }
      const input: Omit<Sensor, "id"> & { id?: string } = {
        ...(typeof body.id === "string" ? { id: body.id } : {}),
        houseId: requiredString(body, "houseId"), floorId: requiredString(body, "floorId"), name: requiredString(body, "name"),
        ...(body.roomId !== undefined ? { roomId: body.roomId === null ? null : requiredString(body, "roomId") } : {}),
        room: requiredString(body, "room"), model: requiredString(body, "model"), x: requiredNumber(body, "x"),
        y: requiredNumber(body, "y"), z: requiredNumber(body, "z"), tags: tags as string[],
        energyMeterRole: body.energyMeterRole === undefined
          ? "standalone"
          : enumValue(body.energyMeterRole, ["whole_home", "submeter", "standalone"] as const, "energyMeterRole"),
        enabled: body.enabled === undefined ? true : optionalBoolean(body, "enabled") as boolean,
        ...(optionalString(body, "temperatureEntityId") !== undefined ? { temperatureEntityId: optionalString(body, "temperatureEntityId") as string } : {}),
        ...(optionalString(body, "humidityEntityId") !== undefined ? { humidityEntityId: optionalString(body, "humidityEntityId") as string } : {}),
        ...(optionalString(body, "batteryEntityId") !== undefined ? { batteryEntityId: optionalString(body, "batteryEntityId") as string } : {}),
        ...(body.tpLinkDeviceId !== undefined && body.tpLinkDeviceId !== null
          ? { tpLinkDeviceId: requiredString(body, "tpLinkDeviceId") }
          : {}),
        ...(body.tpLinkConnectionId !== undefined && body.tpLinkConnectionId !== null
          ? { tpLinkConnectionId: requiredString(body, "tpLinkConnectionId") }
          : {}),
        ...(body.measurementEntityIds !== undefined ? { measurementEntityIds: measurementStringMap(body.measurementEntityIds, "measurementEntityIds") } : {}),
      };
      context.stuguby.assertHouseWriteAllowed(input.houseId);
      if (input.temperatureEntityId || input.humidityEntityId || input.batteryEntityId
        || input.tpLinkDeviceId || input.tpLinkConnectionId || Object.keys(input.measurementEntityIds ?? {}).length > 0) {
        context.stuguby.assertHouseLocalAuthority(input.houseId);
      }
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
      const current = context.database.getSensor(request.params.id as string);
      if (current) context.stuguby.assertHouseWriteAllowed(current.houseId);
      if (current?.tags.includes("integration:gree")) {
        throw new HttpError(409, "SENSOR_MANAGED_BY_INTEGRATION", "Manage this heat-pump sensor from Set up");
      }
      const patch = parseSensorPatch(request.body);
      if (patch.tags?.includes("integration:gree")) {
        throw new HttpError(400, "RESERVED_SENSOR_TAG", "The Gree sensor tag is managed by the heat-pump connection");
      }
      if (current && patch.houseId && patch.houseId !== current.houseId) {
        context.stuguby.assertHouseWriteAllowed(patch.houseId);
        context.assertSensorHouseMoveAllowed(current.houseId, patch.houseId);
      }
      if (current && ["temperatureEntityId", "humidityEntityId", "batteryEntityId", "tpLinkDeviceId", "tpLinkConnectionId", "measurementEntityIds"]
        .some((field) => Object.hasOwn(patch, field))) context.stuguby.assertHouseLocalAuthority(current.houseId);
      if (current && (Object.hasOwn(patch, "houseId") || Object.hasOwn(patch, "tpLinkDeviceId") || Object.hasOwn(patch, "tpLinkConnectionId"))) {
        const candidate = { ...current, ...patch };
        if (patch.tpLinkDeviceId === null) {
          delete candidate.tpLinkDeviceId;
          delete candidate.tpLinkConnectionId;
        }
        if (patch.tpLinkConnectionId === null) delete candidate.tpLinkConnectionId;
        context.assertTpLinkConnectionScope(candidate);
      }
      const sensor = context.database.transaction(() => {
        const updated = context.database.updateSensor(request.params.id as string, patch);
        if (!updated) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
        if (current && current.houseId !== updated.houseId) context.stuguby.captureHomeMutation(current.houseId);
        context.stuguby.captureHomeMutation(updated.houseId);
        return updated;
      });
      context.homeAssistant.refreshMappings();
      context.notifySpatialSensorChange(current, sensor);
      response.json({ sensor });
    });
  context.app.put(`${context.prefix}/sensors/:id`, (request, response) => {
      const current = context.database.getSensor(request.params.id as string);
      if (current) context.stuguby.assertHouseWriteAllowed(current.houseId);
      if (current?.tags.includes("integration:gree")) {
        throw new HttpError(409, "SENSOR_MANAGED_BY_INTEGRATION", "Manage this heat-pump sensor from Set up");
      }
      const patch = parseSensorPatch(request.body);
      if (patch.tags?.includes("integration:gree")) {
        throw new HttpError(400, "RESERVED_SENSOR_TAG", "The Gree sensor tag is managed by the heat-pump connection");
      }
      if (current && patch.houseId && patch.houseId !== current.houseId) {
        context.stuguby.assertHouseWriteAllowed(patch.houseId);
        context.assertSensorHouseMoveAllowed(current.houseId, patch.houseId);
      }
      if (current && ["temperatureEntityId", "humidityEntityId", "batteryEntityId", "tpLinkDeviceId", "tpLinkConnectionId", "measurementEntityIds"]
        .some((field) => Object.hasOwn(patch, field))) context.stuguby.assertHouseLocalAuthority(current.houseId);
      if (current && (Object.hasOwn(patch, "houseId") || Object.hasOwn(patch, "tpLinkDeviceId") || Object.hasOwn(patch, "tpLinkConnectionId"))) {
        const candidate = { ...current, ...patch };
        if (patch.tpLinkDeviceId === null) {
          delete candidate.tpLinkDeviceId;
          delete candidate.tpLinkConnectionId;
        }
        if (patch.tpLinkConnectionId === null) delete candidate.tpLinkConnectionId;
        context.assertTpLinkConnectionScope(candidate);
      }
      const sensor = context.database.transaction(() => {
        const updated = context.database.updateSensor(request.params.id as string, patch);
        if (!updated) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
        if (current && current.houseId !== updated.houseId) context.stuguby.captureHomeMutation(current.houseId);
        context.stuguby.captureHomeMutation(updated.houseId);
        return updated;
      });
      context.homeAssistant.refreshMappings();
      context.notifySpatialSensorChange(current, sensor);
      response.json(sensor);
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
  context.app.post(`${context.prefix}/readings`, context.requireIngestKey, (request, response) => {
      const candidate = request.body as unknown;
      const readingsInput = Array.isArray(candidate) ? candidate : (
        candidate && typeof candidate === "object" && Array.isArray((candidate as Record<string, unknown>).readings)
          ? (candidate as { readings: unknown[] }).readings : [candidate]
      );
      if (readingsInput.length === 0 || readingsInput.length > 1_000) throw new HttpError(400, "INVALID_BATCH", "Submit between 1 and 1000 readings");
      const submitted = readingsInput.map(parseReading);
      for (const reading of submitted) {
        const sensor = context.database.getSensor(reading.sensorId);
        if (sensor) context.stuguby.assertHouseLocalAuthority(sensor.houseId);
      }
      const readings = context.telemetry.ingestBatch(submitted);
      response.status(201).json({ readings, ignoredDuplicates: submitted.length - readings.length });
    });
  context.app.get(`${context.prefix}/readings/latest`, (request, response) => {
      const sensorIds = queryList(request.query.sensorId);
      const access = context.visibility(response);
      const selected = (sensorIds.length ? sensorIds : context.database.listSensors().map((sensor) => sensor.id))
        .filter((sensorId) => access.sensor(sensorId));
      const selectedIds = new Set(selected);
      response.json({ readings: selected.length > 0
        ? context.cachedLatestReadings().filter((reading) => selectedIds.has(reading.sensorId))
        : [] });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
