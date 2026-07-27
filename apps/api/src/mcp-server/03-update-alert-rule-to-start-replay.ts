import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH, resolvePlanElementOpeningState } from "@climate-twin/contracts";
import type { StugubyRole, StugubySummary } from "@climate-twin/stuguby-protocol";
import type {
  AreaEquipment,
  AreaEquipmentInput,
  AreaEquipmentPatch,
  AlertRule,
  Floor,
  GeoCoordinate,
  HouseLocation,
  HouseMapPlacement,
  HouseWeather,
  MaintenanceTask,
  ManualObservation,
  MeasurementDefinition,
  MeasurementSample,
  MeasurementSnapshotEntry,
  Property,
  PropertyArea,
  PropertyAreaInput,
  PropertyAreaPatch,
  PropertyCreateInput,
  Reading,
  Sensor,
  StaticParameter,
} from "@climate-twin/contracts";
import {
  parseAlertRule,
  parseMeasurementDefinition,
  parseMeasurementSample,
  parseMaintenanceTaskInput,
  parseMaintenanceTaskPatch,
  parseObservationInput,
  parseObservationPatch,
  parseReading,
  parseSensorPatch,
} from "../app.js";
import { loadConfig } from "../config.js";
import { DataOperationsService } from "../data-operations.js";
import { ClimateDatabase, outdoorLocationKey } from "../db.js";
import { discoverHomeAssistant } from "../discovery.js";
import { EnergyCostService } from "../energy-cost.js";
import { EnergyOptimizer } from "../energy-optimizer.js";
import { publicElectricityConfiguration } from "../electricity-prices.js";
import { TelemetryBus } from "../events.js";
import { HomeAssistantBridge } from "../home-assistant.js";
import { McpOperationTracker } from "../mcp-lifecycle.js";
import {
  mcpToolAnnotations,
  mcpBoundedInteger,
  mcpBoundedNumber,
  mcpIsoDate,
  mcpLanguage,
  mcpLocationQuery,
  mcpOptionalFiniteNumber,
  mcpThermalDateRange,
  requireMcpHouse,
  requireMcpHouseSensor,
  requireMcpConfirmation,
  requireMcpMeasurementTarget,
  requireMcpSensor,
  summarizeMcpAreaEquipment,
  summarizeMcpHouse,
  summarizeMcpProperty,
  summarizeMcpPropertyArea,
  validateMcpToolRegistry,
  validateMcpDateRange,
} from "../mcp-validation.js";
import { LocationDiscoveryService } from "../location-discovery.js";
import { AutomaticWeatherProvider, OpenMeteoWeatherProvider } from "../open-meteo.js";
import {
  AlertEngine,
  DataModeCoordinator,
  forecast,
  forecastMeasurement,
  MeasurementService,
  MOCK_SCENARIOS,
  MockEngine,
  ReplayEngine,
  RuntimeStatus,
  TelemetryService,
} from "../services.js";
import { SetupDoctor } from "../setup-doctor.js";
import { HybridTelemetryReader } from "../timeseries/read-facade.js";
import { runThermalIsolation } from "../thermal-isolation.js";
import { runThermalSimulation } from "../thermal-simulation.js";
import { TpLinkBridge } from "../tp-link.js";
import { SYSTEM_VERSION } from "../version.js";
import { FmiWeatherProvider, WeatherRequestSupersededError, WeatherService } from "../weather.js";
import type { StugubyService } from "../stuguby/service.js";
import { StugubyStore } from "../stuguby/store.js";
import { bus, database, enumString, homeAssistant, measurements, mock, optionalString, optionalStringArray, replay, requiredObject, requiredString, status, stuguby, tpLink } from "./01-config-to-get-house-weather.js";

export function updateAlertRule(args: Record<string, unknown>): AlertRule {
  const ruleId = requiredString(args, "ruleId");
  const current = database.getAlertRule(ruleId);
  if (!current) throw new Error(`Unknown alert rule: ${ruleId}`);
  const currentSensor = current.sensorId ? database.getSensor(current.sensorId) : null;
  if (currentSensor) stuguby.assertHouseLocalAuthority(currentSensor.houseId);
  const parsed = parseAlertRule({ ...current, ...requiredObject(args, "patch"), id: ruleId }, database);
  const nextSensor = parsed.sensorId ? database.getSensor(parsed.sensorId) : null;
  if (nextSensor) stuguby.assertHouseLocalAuthority(nextSensor.houseId);
  const { id: _id, ...patch } = parsed;
  const rule = database.updateAlertRule(ruleId, patch);
  if (!rule) throw new Error(`Unknown alert rule: ${ruleId}`);
  return rule;
}

export function deleteAlertRule(args: Record<string, unknown>): { deleted: true; ruleId: string } {
  requireMcpConfirmation(args.confirm);
  const ruleId = requiredString(args, "ruleId");
  const current = database.getAlertRule(ruleId);
  const sensor = current?.sensorId ? database.getSensor(current.sensorId) : null;
  if (sensor) stuguby.assertHouseLocalAuthority(sensor.houseId);
  if (!database.deleteAlertRule(ruleId)) throw new Error(`Unknown alert rule: ${ruleId}`);
  return { deleted: true, ruleId };
}

export function acknowledgeAlert(args: Record<string, unknown>): unknown {
  const alertId = requiredString(args, "alertId");
  const event = database.acknowledgeAlert(alertId, new Date().toISOString());
  if (!event) throw new Error(`Unknown alert event: ${alertId}`);
  bus.publish({ type: "alert", data: event });
  return event;
}

export function createObservation(args: Record<string, unknown>): ManualObservation {
  const input = parseObservationInput(args);
  stuguby.assertHouseWriteAllowed(input.houseId);
  const observation = database.createObservation(input, "local-mcp");
  stuguby.captureHomeMutation(observation.houseId);
  return observation;
}

export function updateObservation(args: Record<string, unknown>): ManualObservation {
  const observationId = requiredString(args, "observationId");
  const current = database.getObservation(observationId);
  if (!current) throw new Error(`Unknown observation: ${observationId}`);
  stuguby.assertHouseWriteAllowed(current.houseId);
  const observation = database.updateObservation(
    observationId,
    parseObservationPatch({ ...requiredObject(args, "patch"), baseRevision: args.baseRevision }),
    "local-mcp",
  );
  if (!observation) throw new Error(`Unknown observation: ${observationId}`);
  stuguby.captureHomeMutation(observation.houseId);
  return observation;
}

export function listObservationRevisions(args: Record<string, unknown>): unknown[] {
  const observationId = requiredString(args, "observationId");
  if (!database.getObservation(observationId)) throw new Error(`Unknown observation: ${observationId}`);
  return database.listObservationRevisions(observationId);
}

export function deleteObservation(args: Record<string, unknown>): { deleted: true; observationId: string } {
  requireMcpConfirmation(args.confirm);
  const observationId = requiredString(args, "observationId");
  const current = database.getObservation(observationId);
  if (current) stuguby.assertHouseWriteAllowed(current.houseId);
  if (!database.deleteObservation(observationId)) throw new Error(`Unknown observation: ${observationId}`);
  if (current) stuguby.captureHomeMutation(current.houseId);
  return { deleted: true, observationId };
}

export function createMaintenanceTask(args: Record<string, unknown>): MaintenanceTask {
  const input = parseMaintenanceTaskInput(args);
  const propertyId = input.propertyId ?? (input.houseId ? database.getHouse(input.houseId)?.propertyId : undefined);
  if (propertyId) stuguby.assertPropertyWriteAllowed(propertyId);
  const task = database.createMaintenanceTask(input, "local-mcp");
  stuguby.captureCurrentPropertyEntity(task.propertyId, "maintenance", task.id, "upsert");
  return task;
}

export function listMaintenanceTasks(args: Record<string, unknown>): MaintenanceTask[] {
  const propertyId = optionalString(args, "propertyId");
  const houseId = optionalString(args, "houseId");
  const areaId = optionalString(args, "areaId");
  const equipmentId = optionalString(args, "equipmentId");
  return database.listMaintenanceTasks({
    ...(propertyId ? { propertyId } : {}),
    ...(houseId ? { houseId } : {}),
    ...(areaId ? { areaId } : {}),
    ...(equipmentId ? { equipmentId } : {}),
  });
}

export function updateMaintenanceTask(args: Record<string, unknown>): MaintenanceTask {
  const maintenanceTaskId = requiredString(args, "maintenanceTaskId");
  const previous = database.getMaintenanceTask(maintenanceTaskId);
  if (!previous) throw new Error(`Unknown maintenance task: ${maintenanceTaskId}`);
  stuguby.assertPropertyWriteAllowed(previous.propertyId);
  const task = database.updateMaintenanceTask(
    maintenanceTaskId,
    parseMaintenanceTaskPatch({ ...requiredObject(args, "patch"), baseRevision: args.baseRevision }),
    "local-mcp",
  );
  if (!task) throw new Error(`Unknown maintenance task: ${maintenanceTaskId}`);
  stuguby.captureCurrentPropertyEntity(task.propertyId, "maintenance", task.id, "upsert");
  return task;
}

export function listMaintenanceTaskRevisions(args: Record<string, unknown>): unknown[] {
  const maintenanceTaskId = requiredString(args, "maintenanceTaskId");
  if (!database.getMaintenanceTask(maintenanceTaskId)) {
    throw new Error(`Unknown maintenance task: ${maintenanceTaskId}`);
  }
  return database.listMaintenanceTaskRevisions(maintenanceTaskId);
}

export function deleteMaintenanceTask(args: Record<string, unknown>): { deleted: true; maintenanceTaskId: string } {
  requireMcpConfirmation(args.confirm);
  const maintenanceTaskId = requiredString(args, "maintenanceTaskId");
  const previous = database.getMaintenanceTask(maintenanceTaskId);
  if (previous) stuguby.assertPropertyWriteAllowed(previous.propertyId);
  if (!database.deleteMaintenanceTask(maintenanceTaskId)) {
    throw new Error(`Unknown maintenance task: ${maintenanceTaskId}`);
  }
  if (previous) stuguby.captureCurrentPropertyEntity(previous.propertyId, "maintenance", maintenanceTaskId, "delete");
  return { deleted: true, maintenanceTaskId };
}

export function upsertStaticParameter(args: Record<string, unknown>): StaticParameter {
  const value = args.value;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error("value must be a string, number, or boolean");
  }
  const houseId = requiredString(args, "houseId");
  stuguby.assertHouseLocalAuthority(houseId);
  return database.saveParameter({
    ...(args.id === undefined ? {} : { id: requiredString(args, "id") }),
    houseId,
    scopeType: enumString(args, "scopeType", ["house", "floor", "room", "sensor"] as const),
    scopeId: requiredString(args, "scopeId"),
    key: requiredString(args, "key"),
    value,
    unit: args.unit === null || args.unit === undefined ? null : requiredString(args, "unit"),
    label: requiredString(args, "label"),
  });
}

export function deleteStaticParameter(args: Record<string, unknown>): { deleted: true; parameterId: string } {
  requireMcpConfirmation(args.confirm);
  const parameterId = requiredString(args, "parameterId");
  const current = database.listParameters().find((parameter) => parameter.id === parameterId);
  if (current) stuguby.assertHouseLocalAuthority(current.houseId);
  if (!database.deleteParameter(parameterId)) throw new Error(`Unknown static parameter: ${parameterId}`);
  return { deleted: true, parameterId };
}

export const safeAssetMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "model/gltf+json", "model/gltf-binary"]);

export function assetMetadata(asset: { id: string; houseId: string; name: string; mimeType: string; kind: string; size: number; createdAt: string }): object {
  return {
    id: asset.id,
    houseId: asset.houseId,
    name: asset.name,
    mimeType: asset.mimeType,
    kind: asset.kind,
    size: asset.size,
    createdAt: asset.createdAt,
  };
}

export function uploadAsset(args: Record<string, unknown>): object {
  const houseId = requiredString(args, "houseId");
  stuguby.assertHouseLocalAuthority(houseId);
  const mimeType = requiredString(args, "mimeType").toLowerCase();
  if (!safeAssetMimeTypes.has(mimeType)) throw new Error("mimeType must be PNG, JPEG, WebP, glTF, or GLB");
  const encoded = requiredString(args, "data").replace(/^data:[^;]+;base64,/, "");
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("data must contain valid base64 bytes");
  }
  const data = Buffer.from(encoded, "base64");
  if (data.length === 0) throw new Error("data must contain valid base64 bytes");
  if (data.length > 10 * 1024 * 1024) throw new Error("decoded assets are limited to 10 MiB");
  return assetMetadata(database.createAsset({
    houseId,
    name: requiredString(args, "name"),
    mimeType,
    kind: enumString(args, "kind", ["floor-plan", "model-3d", "other"] as const),
    data,
  }));
}

export function deleteAsset(args: Record<string, unknown>): { deleted: true; assetId: string } {
  requireMcpConfirmation(args.confirm);
  const assetId = requiredString(args, "assetId");
  const current = database.getAsset(assetId);
  if (current) stuguby.assertHouseLocalAuthority(current.houseId);
  if (!database.deleteAsset(assetId)) throw new Error(`Unknown asset: ${assetId}`);
  return { deleted: true, assetId };
}

export async function discoverIntegrations(): Promise<object> {
  const [homeAssistantResult, tpLinkResult] = await Promise.allSettled([
    discoverHomeAssistant(),
    tpLink.discoverSources(),
  ]);
  const warnings: string[] = [];
  if (homeAssistantResult.status === "rejected") warnings.push("Home Assistant discovery was unavailable. Enter its address manually.");
  if (tpLinkResult.status === "rejected") warnings.push("TP-Link discovery was unavailable. Enter the hub or energy-device address manually.");
  return {
    homeAssistant: homeAssistantResult.status === "fulfilled" ? homeAssistantResult.value : [],
    tpLink: tpLinkResult.status === "fulfilled" ? tpLinkResult.value.sources : [],
    warnings,
  };
}

export function homeAssistantSetup(): object {
  return {
    configured: status.value.homeAssistant.configured,
    steps: [
      "Create a Home Assistant long-lived access token for a dedicated local user.",
      "Configure its local URL and token in the Stugu web integration screen or the API process's protected environment/secrets file.",
      "Map each Stugu sensor to legacy climate keys and/or a measurements object keyed by registry id.",
      "Verify integration status reports connected=true in the long-running API process.",
    ],
    entityMapSchema: {
      entities: [{
        sensorId: "sensor-01",
        temperature: "sensor.living_room_temperature",
        humidity: "sensor.living_room_humidity",
        battery: "sensor.living_room_battery",
        measurements: { co2: "sensor.living_room_co2" },
      }],
    },
    notes: [
      "Saved credentials are write-only and live outside SQLite.",
      "The MCP server deliberately does not accept or write credentials; keep secrets out of model and tool arguments.",
      "A stdio MCP process does not mirror the separate API process's live WebSocket connection state.",
      "Saving a real integration permanently disables and purges demo telemetry for this database.",
    ],
  };
}

export function tpLinkSetup(): object {
  return {
    configured: status.value.tpLink.configured,
    supportedHubs: ["H100", "H200"],
    supportedClimateSensors: ["T310", "T315"],
    supportedEnergyDevices: "Configured TP-Link/Kasa hosts that python-kasa exposes through Module.Energy",
    steps: [
      "Install python-kasa from apps/api/python/requirements.txt.",
      "Configure a hub or direct energy device's reserved LAN address and TP-Link credentials in the Stugu web integration screen or the API process's protected environment/secrets file.",
      "Inspect discovered devices in the long-running API process.",
      "Assign a stable child device id to a sensor's tpLinkDeviceId field.",
    ],
    sensorPatchSchema: { tpLinkDeviceId: "hub-child-device-id" },
    deviceMapSchema: { devices: [{ deviceId: "hub-child-device-id", sensorId: "sensor-01" }] },
    notes: [
      "Credentials are never returned and are stored outside SQLite.",
      "The MCP server deliberately does not accept or write credentials; keep secrets out of model and tool arguments.",
      "The stdio MCP process deliberately does not start a second continuous hub poller beside the API process.",
      "LAN discovery includes H100/H200 hubs and energy devices that python-kasa verifies through Module.Energy using saved TP-Link credentials; energy devices expose power, plus cumulative energy only when python-kasa provides consumption_total.",
      "Saving a real integration permanently disables and purges demo telemetry for this database.",
    ],
  };
}

export function homeAssistantConnectionTest(): object {
  return {
    ok: false,
    available: false,
    runtimeScope: "mcp-process",
    message: "Live Home Assistant connection testing belongs to the long-running API process and is unavailable over stdio.",
  };
}

export function tpLinkConnectionTest(): object {
  return {
    ok: false,
    available: false,
    runtimeScope: "mcp-process",
    message: "Live TP-Link connection testing belongs to the long-running API process and is unavailable over stdio.",
  };
}

export function selectMockScenario(args: Record<string, unknown>): object {
  const scenario = enumString(args, "scenario", MOCK_SCENARIOS.map((item) => item.id));
  mock.setScenario(scenario);
  return { active: mock.scenario };
}

export function startReplay(args: Record<string, unknown>): object {
  const sensorIds = optionalStringArray(args, "sensorIds", database.listSensors().map((sensor) => sensor.id));
  for (const sensorId of sensorIds) requireMcpSensor(database, sensorId);
  const to = args.to === undefined ? new Date().toISOString() : mcpIsoDate(requiredString(args, "to"), "to");
  const from = args.from === undefined
    ? new Date(Date.parse(to) - 3_600_000).toISOString()
    : mcpIsoDate(requiredString(args, "from"), "from");
  validateMcpDateRange(from, to);
  if (args.speed !== undefined) mcpBoundedNumber(args.speed, "speed", 0.1, 10_000);
  return {
    available: false,
    replay: { ...replay.state, count: 0 },
    runtimeScope: "mcp-process",
    note: "No replay was started because stdio has no observable live event consumer; use the API replay endpoint.",
  };
}
