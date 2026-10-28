import { createHash } from "node:crypto";
import type express from "express";
import type {
  ConnectedDeviceCapabilities,
  ConnectedDeviceCommand,
  ConnectedDevicePlacement,
  IntegrationStatus,
} from "@climate-twin/contracts";
import type { AppConfig } from "../config.js";
import type { ConnectedDeviceStore } from "../connected-device-store.js";
import type { ClimateDatabase } from "../db.js";
import type { TuyaConnectionSecret } from "../integration-secrets.js";
import { commitCoordinatedIntegrationSecrets } from "../integration-secrets-coordinator.js";
import type { RuntimeStatus } from "../runtime-status.js";
import { TuyaBridge, localIpv4 } from "../tuya.js";
import { HttpError } from "../http-error.js";
import { bodyObject, rejectUnknownFields, requiredString } from "../request-fields.js";
import { credentialString } from "./support/credentials.js";
import { requestPrincipal, requireWorkspaceAdmin } from "./support/local-sessions.js";

interface TuyaRouteContext {
  app: express.Express;
  prefix: string;
  config: AppConfig;
  database: ClimateDatabase;
  tuya: TuyaBridge;
  connectedDevices: ConnectedDeviceStore;
  status: RuntimeStatus;
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

const CONFIG_FIELDS = new Set([
  "houseId", "host", "deviceId", "localKey", "protocolVersion",
  "productKey", "mac", "name", "model", "floorId", "roomId", "x", "y", "z",
]);
const COMMAND_FIELDS = new Set([
  "operationId", "power", "brightnessPercent", "colorTemperatureKelvin", "color",
]);

function optionalText(
  body: Record<string, unknown>,
  key: string,
  maximum = 200,
): string | null | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new HttpError(400, "INVALID_FIELD", `${key} must be a non-empty string`);
  }
  return value.trim();
}

function tuyaCredentials(body: Record<string, unknown>): { deviceId: string; localKey: string } {
  const deviceId = requiredString(body, "deviceId");
  const localKey = credentialString(body, "localKey", 256);
  if (deviceId.length > 200) {
    throw new HttpError(400, "INVALID_TUYA_CREDENTIAL", "The Tuya LAN identity is invalid");
  }
  return { deviceId, localKey };
}

function requireFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "INVALID_FIELD", `${name} must be a finite number`);
  }
  return value;
}

function placement(
  database: ClimateDatabase,
  houseId: string,
  body: Record<string, unknown>,
): ConnectedDevicePlacement {
  const floorId = optionalText(body, "floorId");
  const roomId = optionalText(body, "roomId");
  if (!floorId) {
    if (roomId || ["x", "y", "z"].some((key) => body[key] !== undefined && body[key] !== null)) {
      throw new HttpError(422, "TUYA_PLACEMENT_INCOMPLETE", "Choose a floor before positioning the device");
    }
    return { floorId: null, roomId: null, x: null, y: null, z: null };
  }
  const house = database.getHouse(houseId);
  const floor = house?.floors.find((candidate) => candidate.id === floorId);
  if (!floor) {
    throw new HttpError(422, "TUYA_FLOOR_NOT_FOUND", "The selected floor does not belong to this Home");
  }
  const room = roomId ? floor.rooms.find((candidate) => candidate.id === roomId) : null;
  if (roomId && !room) {
    throw new HttpError(422, "TUYA_ROOM_NOT_FOUND", "The selected room does not belong to this floor");
  }
  const x = body.x === undefined ? floor.width / 2 : requireFiniteNumber(body.x, "x");
  const y = body.y === undefined ? floor.height / 2 : requireFiniteNumber(body.y, "y");
  const z = body.z === undefined ? floor.elevation + 1.2 : requireFiniteNumber(body.z, "z");
  if (x < 0 || x > floor.width || y < 0 || y > floor.height) {
    throw new HttpError(422, "TUYA_PLACEMENT_OUT_OF_BOUNDS", "The device must be inside the selected floor");
  }
  return { floorId, roomId: room?.id ?? null, x, y, z };
}

function command(body: Record<string, unknown>, capabilities: ConnectedDeviceCapabilities): ConnectedDeviceCommand {
  rejectUnknownFields(body, COMMAND_FIELDS, "Tuya device command");
  const operationId = requiredString(body, "operationId");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operationId)) {
    throw new HttpError(400, "INVALID_OPERATION_ID", "operationId must be a UUID");
  }
  const result: ConnectedDeviceCommand = { operationId };
  if (body.power !== undefined) {
    if (!capabilities.power || typeof body.power !== "boolean") {
      throw new HttpError(422, "TUYA_POWER_UNSUPPORTED", "This device does not support that power command");
    }
    result.power = body.power;
  }
  if (body.brightnessPercent !== undefined) {
    const value = requireFiniteNumber(body.brightnessPercent, "brightnessPercent");
    if (!capabilities.brightness || value < 1 || value > 100) {
      throw new HttpError(422, "TUYA_BRIGHTNESS_UNSUPPORTED", "Brightness must be from 1 to 100 for this device");
    }
    result.brightnessPercent = value;
  }
  if (body.colorTemperatureKelvin !== undefined) {
    const value = requireFiniteNumber(body.colorTemperatureKelvin, "colorTemperatureKelvin");
    if (!capabilities.colorTemperature || value < 2_700 || value > 6_500) {
      throw new HttpError(
        422,
        "TUYA_COLOR_TEMPERATURE_UNSUPPORTED",
        "Colour temperature must be from 2700 K to 6500 K for this device",
      );
    }
    result.colorTemperatureKelvin = value;
  }
  if (body.color !== undefined) {
    const value = body.color as Record<string, unknown>;
    if (!capabilities.color || !value || typeof value !== "object"
      || Object.keys(value).some((key) => !["hue", "saturation", "value"].includes(key))
      || Object.keys(value).length !== 3) {
      throw new HttpError(422, "TUYA_COLOR_UNSUPPORTED", "This device does not support that colour command");
    }
    const hue = requireFiniteNumber(value.hue, "color.hue");
    const saturation = requireFiniteNumber(value.saturation, "color.saturation");
    const brightness = requireFiniteNumber(value.value, "color.value");
    if (hue < 0 || hue > 360 || saturation < 0 || saturation > 100
      || brightness < 1 || brightness > 100) {
      throw new HttpError(422, "TUYA_COLOR_OUT_OF_RANGE", "The requested colour is outside its supported range");
    }
    result.color = { hue, saturation, value: brightness };
  }
  if (Object.keys(result).length === 1) {
    throw new HttpError(400, "EMPTY_TUYA_COMMAND", "Choose at least one device setting");
  }
  return result;
}

function sensorId(connectionId: string): string {
  return `tuya-energy-${connectionId.slice("tuya-".length)}`;
}

function addEnergySensor(
  context: TuyaRouteContext,
  connection: TuyaConnectionSecret,
  capabilities: ConnectedDeviceCapabilities,
  devicePlacement: ConnectedDevicePlacement,
): string | undefined {
  if (!capabilities.measuredPower || !devicePlacement.floorId
    || devicePlacement.x === null || devicePlacement.y === null || devicePlacement.z === null) return undefined;
  const id = sensorId(connection.id);
  const house = context.database.getHouse(connection.houseId)!;
  const floor = house.floors.find((candidate) => candidate.id === devicePlacement.floorId)!;
  const room = devicePlacement.roomId
    ? floor.rooms.find((candidate) => candidate.id === devicePlacement.roomId)
    : null;
  const existing = context.database.getSensor(id);
  if (existing) {
    if (existing.houseId !== connection.houseId) {
      throw new HttpError(409, "TUYA_ENERGY_SENSOR_CONFLICT", "The energy sensor identity is already in use");
    }
    context.database.updateSensor(id, {
      floorId: devicePlacement.floorId,
      roomId: room?.id ?? null,
      room: room?.name ?? "",
      x: devicePlacement.x,
      y: devicePlacement.y,
      z: devicePlacement.z,
      enabled: true,
    });
    return id;
  }
  context.database.createSensor({
    id,
    houseId: connection.houseId,
    floorId: devicePlacement.floorId,
    name: `${connection.name} energy`,
    roomId: room?.id ?? null,
    room: room?.name ?? "",
    model: connection.model ?? "Tuya LAN power meter",
    x: devicePlacement.x,
    y: devicePlacement.y,
    z: devicePlacement.z,
    energyMeterRole: "standalone",
    tags: ["energy", "tuya", "local"],
    enabled: true,
  });
  return id;
}

function commitTuyaSecretsMutation<T>(
  context: TuyaRouteContext,
  operation: (previousConnections: TuyaConnectionSecret[]) => { connections: TuyaConnectionSecret[]; result: T },
): { connections: TuyaConnectionSecret[]; result: T } {
  const committed = commitCoordinatedIntegrationSecrets(
    context.config.integrationSecretsFile,
    context.database,
    (current) => {
      const mutation = operation(current.tuyaConnections ?? []);
      return { patch: { tuyaConnections: mutation.connections }, result: mutation.result };
    },
  );
  return { connections: committed.secrets.tuyaConnections ?? [], result: committed.result };
}

/** Registers Home-scoped local Tuya onboarding, state, placement, and control. */
export function registerTuyaRoutes(context: TuyaRouteContext): void {
  const pendingConfigurations = new Set<string>();

  context.app.post(`${context.prefix}/integrations/tuya/discover`, requireWorkspaceAdmin, async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const body = bodyObject(request.body);
    rejectUnknownFields(body, new Set(["houseId", "deviceId", "localKey"]), "Tuya discovery");
    const houseId = requiredString(body, "houseId");
    if (!context.database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "Home not found");
    context.stuguby.assertHouseLocalAuthority(houseId);
    const { deviceId, localKey } = tuyaCredentials(body);
    if ((context.config.tuyaConnections ?? []).some((item) => item.deviceId === deviceId)) {
      throw new HttpError(409, "TUYA_ALREADY_CONFIGURED", "This Tuya device has already been added");
    }
    const [device] = await context.tuya.discoverSources(houseId, deviceId);
    if (!device) {
      response.json({ devices: [] });
      return;
    }
    let verified;
    try {
      verified = await context.tuya.verify({
        host: device.host,
        deviceId,
        localKey,
        protocolVersion: device.protocolVersion,
      });
    } catch {
      throw new HttpError(
        422,
        "TUYA_DISCOVERY_VERIFICATION_FAILED",
        "Stugu found the Tuya device but could not verify it locally. Check its Device ID and local key.",
      );
    }
    if (!localIpv4(verified.host)) {
      throw new HttpError(422, "TUYA_DISCOVERY_VERIFICATION_FAILED", "The Tuya device did not verify on the local network");
    }
    response.json({ devices: [{ ...device, host: verified.host }] });
  });

  context.app.put(`${context.prefix}/integrations/tuya/config`, requireWorkspaceAdmin, async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const body = bodyObject(request.body);
    rejectUnknownFields(body, CONFIG_FIELDS, "Tuya configuration");
    const houseId = requiredString(body, "houseId");
    const house = context.database.getHouse(houseId);
    if (!house) throw new HttpError(404, "NOT_FOUND", "Home not found");
    context.stuguby.assertHouseLocalAuthority(houseId);
    const host = requiredString(body, "host");
    if (!localIpv4(host)) {
      throw new HttpError(400, "INVALID_TUYA_HOST", "Tuya host must be a local IPv4 address");
    }
    const { deviceId, localKey } = tuyaCredentials(body);
    const protocolVersion = requiredString(body, "protocolVersion");
    if (!["3.1", "3.2", "3.3", "3.4", "3.5"].includes(protocolVersion)) {
      throw new HttpError(400, "INVALID_TUYA_CREDENTIAL", "The Tuya LAN identity or protocol version is invalid");
    }
    if ((context.config.tuyaConnections ?? []).some((item) => item.deviceId === deviceId)) {
      throw new HttpError(409, "TUYA_ALREADY_CONFIGURED", "This Tuya device has already been added");
    }
    if (pendingConfigurations.has(deviceId)) {
      throw new HttpError(409, "TUYA_CONFIGURATION_IN_PROGRESS", "This Tuya device is already being added");
    }
    pendingConfigurations.add(deviceId);
    try {
      let verified;
      try {
        verified = await context.tuya.verify({ host, deviceId, localKey, protocolVersion });
      } catch {
        throw new HttpError(
          422,
          "TUYA_VERIFICATION_FAILED",
          "Stugu could not verify the device locally. Check its address, local key, protocol version, and Wi-Fi.",
        );
      }
      if (!localIpv4(verified.host)) {
        throw new HttpError(422, "TUYA_VERIFICATION_FAILED", "The Tuya device did not verify on the local network");
      }
      const id = TuyaBridge.connectionId(deviceId);
      const equipmentId = `equipment-${id}`;
      const deviceName = optionalText(body, "name") ?? (
        verified.kind === "light" ? "Smart lamp" : verified.kind === "outlet" ? "Smart outlet" : "Smart switch"
      );
      const model = optionalText(body, "model");
      const productKey = optionalText(body, "productKey");
      const mac = optionalText(body, "mac", 32);
      const devicePlacement = placement(context.database, houseId, body);
      const existingEquipment = context.database.getAreaEquipment(equipmentId);
      if (existingEquipment && existingEquipment.propertyId !== house.propertyId) {
        throw new HttpError(409, "TUYA_EQUIPMENT_CONFLICT", "The device inventory identity is already in use");
      }
      let connection: TuyaConnectionSecret = {
        id,
        houseId,
        equipmentId,
        host: verified.host,
        deviceId,
        localKey,
        protocolVersion: protocolVersion as TuyaConnectionSecret["protocolVersion"],
        profileId: verified.profileId,
        name: deviceName,
        ...(model ? { model } : {}),
        ...(productKey ? { productKey } : {}),
        ...(mac ? { mac } : {}),
      };
      const committed = commitTuyaSecretsMutation(context, (previousConnections) => {
        if (previousConnections.some((item) => item.deviceId === deviceId)) {
          throw new HttpError(409, "TUYA_ALREADY_CONFIGURED", "This Tuya device has already been added");
        }
        if (existingEquipment) {
          context.database.updateAreaEquipment(equipmentId, {
            houseId,
            name: deviceName,
            kind: verified.kind === "light" ? "smart-light" : `smart-${verified.kind}`,
            manufacturer: "Tuya-compatible",
            model: model ?? null,
            status: "active",
            notes: "Direct local-network control. No cloud connection is used at runtime.",
          }, "system-service");
        } else {
          context.database.createAreaEquipment({
            id: equipmentId,
            propertyId: house.propertyId,
            houseId,
            name: deviceName,
            kind: verified.kind === "light" ? "smart-light" : `smart-${verified.kind}`,
            manufacturer: "Tuya-compatible",
            model: model ?? null,
            serialNumber: id,
            status: "active",
            notes: "Direct local-network control. No cloud connection is used at runtime.",
          });
        }
        const energySensorId = addEnergySensor(context, connection, verified.capabilities, devicePlacement);
        if (energySensorId) connection = { ...connection, sensorId: energySensorId };
        context.connectedDevices.setPlacement(id, houseId, devicePlacement);
        return {
          connections: [...previousConnections, connection],
          result: connection,
        };
      });
      connection = committed.result;
      context.config.tuyaConnections = committed.connections;
      const state = context.tuya.recordInitial(connection, verified.state);
      context.dataMode.activate();
      context.tuya.refreshConfiguration();
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: "integration.credentials.configured",
        subjectType: "integration",
        subjectId: `tuya:${id}`,
        details: { integration: "tuya-local", connectionId: id, houseId },
      });
      response.json({
        ok: true,
        configured: true,
        connectionId: id,
        state,
        integration: context.integrationStatusForHouse(houseId),
      });
    } finally {
      pendingConfigurations.delete(deviceId);
    }
  });

  context.app.delete(`${context.prefix}/integrations/tuya/config/:connectionId`, requireWorkspaceAdmin, (request, response) => {
    const id = request.params.connectionId as string;
    const connection = (context.config.tuyaConnections ?? []).find((item) => item.id === id);
    if (!connection) throw new HttpError(404, "NOT_FOUND", "Tuya device connection not found");
    context.stuguby.assertHouseLocalAuthority(connection.houseId);
    const committed = commitTuyaSecretsMutation(context, (previousConnections) => {
      if (!previousConnections.some((item) => item.id === id)) {
        throw new HttpError(404, "NOT_FOUND", "Tuya device connection not found");
      }
      context.connectedDevices.deleteConnection(id);
      if (connection.sensorId && context.database.getSensor(connection.sensorId)) {
        context.database.updateSensor(connection.sensorId, { enabled: false });
      }
      if (connection.equipmentId && context.database.getAreaEquipment(connection.equipmentId)) {
        context.database.updateAreaEquipment(connection.equipmentId, { status: "retired" }, "system-service");
      }
      return {
        connections: previousConnections.filter((item) => item.id !== id),
        result: undefined,
      };
    });
    context.config.tuyaConnections = committed.connections;
    context.tuya.refreshConfiguration();
    context.recordSecurityAudit(requestPrincipal(response), {
      eventType: "integration.credentials.revoked",
      subjectType: "integration",
      subjectId: `tuya:${id}`,
      details: { integration: "tuya-local", connectionId: id, houseId: connection.houseId },
    });
    response.json({ ok: true, integration: context.integrationStatusForHouse(connection.houseId) });
  });

  context.app.get(`${context.prefix}/connected-devices`, (request, response) => {
    const houseId = typeof request.query.houseId === "string" ? request.query.houseId.trim() : undefined;
    if (houseId && (!context.database.getHouse(houseId) || !context.visibility(response).house(houseId))) {
      throw new HttpError(404, "NOT_FOUND", "Home not found");
    }
    const active = new Set((context.config.tuyaConnections ?? [])
      .filter((connection) => !houseId || connection.houseId === houseId)
      .map((connection) => connection.id));
    response.json({
      devices: context.connectedDevices.current(houseId)
        .filter((device) => active.has(device.connectionId) && context.visibility(response).house(device.houseId)),
    });
  });

  context.app.patch(`${context.prefix}/connected-devices/:connectionId/placement`, requireWorkspaceAdmin, (request, response) => {
    const id = request.params.connectionId as string;
    const connection = (context.config.tuyaConnections ?? []).find((item) => item.id === id);
    if (!connection) throw new HttpError(404, "NOT_FOUND", "Connected device not found");
    context.stuguby.assertHouseLocalAuthority(connection.houseId);
    const body = bodyObject(request.body);
    rejectUnknownFields(body, new Set(["floorId", "roomId", "x", "y", "z"]), "Device placement");
    if (!Object.prototype.hasOwnProperty.call(body, "floorId")) {
      throw new HttpError(400, "CONNECTED_DEVICE_FLOOR_REQUIRED", "floorId is required when changing device placement");
    }
    const devicePlacement = placement(context.database, connection.houseId, body);
    const currentState = context.connectedDevices.get(id);
    const shouldAddSensor = !connection.sensorId && Boolean(
      currentState?.capabilities.measuredPower
      && devicePlacement.floorId
      && devicePlacement.x !== null
      && devicePlacement.y !== null
      && devicePlacement.z !== null,
    );
    let nextConnection = connection;
    let state;
    if (shouldAddSensor) {
      const committed = commitTuyaSecretsMutation(context, (previousConnections) => {
        if (!previousConnections.some((item) => item.id === id)) {
          throw new HttpError(404, "NOT_FOUND", "Connected device not found");
        }
        const energySensorId = addEnergySensor(
          context,
          connection,
          currentState!.capabilities,
          devicePlacement,
        )!;
        nextConnection = { ...connection, sensorId: energySensorId };
        state = context.connectedDevices.setPlacement(id, connection.houseId, devicePlacement);
        return {
          connections: previousConnections.map((item) => item.id === id ? nextConnection : item),
          result: state,
        };
      });
      context.config.tuyaConnections = committed.connections;
      state = committed.result;
      context.tuya.refreshConfiguration();
    } else {
      state = context.database.transaction(() => {
        if (connection.sensorId) {
          if (devicePlacement.floorId && devicePlacement.x !== null
            && devicePlacement.y !== null && devicePlacement.z !== null) {
            const house = context.database.getHouse(connection.houseId)!;
            const floor = house.floors.find((item) => item.id === devicePlacement.floorId)!;
            const room = devicePlacement.roomId
              ? floor.rooms.find((item) => item.id === devicePlacement.roomId)
              : null;
            context.database.updateSensor(connection.sensorId, {
              floorId: devicePlacement.floorId,
              roomId: room?.id ?? null,
              room: room?.name ?? "",
              x: devicePlacement.x,
              y: devicePlacement.y,
              z: devicePlacement.z,
              enabled: true,
            });
          } else {
            context.database.updateSensor(connection.sensorId, { enabled: false });
          }
        }
        return context.connectedDevices.setPlacement(id, connection.houseId, devicePlacement);
      });
    }
    response.json({ state, energySensorId: nextConnection.sensorId ?? null });
  });

  context.app.post(`${context.prefix}/connected-devices/:connectionId/commands`, requireWorkspaceAdmin, async (request, response) => {
    const id = request.params.connectionId as string;
    const connection = (context.config.tuyaConnections ?? []).find((item) => item.id === id);
    const current = context.connectedDevices.get(id);
    if (!connection || !current) throw new HttpError(404, "NOT_FOUND", "Connected device not found");
    context.stuguby.assertHouseLocalAuthority(connection.houseId);
    const requested = command(bodyObject(request.body), current.capabilities);
    const requestHash = createHash("sha256").update(JSON.stringify(requested)).digest("hex");
    const claim = context.connectedDevices.claimCommand(id, connection.houseId, requested.operationId, requestHash);
    if (claim.status === "conflict") {
      throw new HttpError(409, "OPERATION_ID_CONFLICT", "This operationId was already used for another command");
    }
    if (claim.status === "pending") {
      throw new HttpError(409, "COMMAND_IN_PROGRESS", "This command is already in progress");
    }
    if (claim.status === "complete") {
      response.json({ ok: true, deduplicated: true, state: claim.state });
      return;
    }
    try {
      const state = await context.tuya.command(id, requested);
      context.connectedDevices.completeCommand(id, requested.operationId, state);
      response.json({ ok: true, deduplicated: false, state });
    } catch {
      context.connectedDevices.releaseCommand(id, requested.operationId);
      throw new HttpError(
        503,
        "TUYA_COMMAND_FAILED",
        "The device did not confirm the change. Stugu kept the previous displayed state.",
      );
    }
  });
}
