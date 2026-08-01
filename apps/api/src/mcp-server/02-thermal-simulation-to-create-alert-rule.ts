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
import { runThermalSimulationAsync } from "../thermal-simulation.js";
import { TpLinkBridge } from "../tp-link.js";
import { SYSTEM_VERSION } from "../version.js";
import { FmiWeatherProvider, WeatherRequestSupersededError, WeatherService } from "../weather.js";
import type { StugubyService } from "../stuguby/service.js";
import { StugubyStore } from "../stuguby/store.js";
import { config, database, measurements, optionalBoolean, optionalString, optionalStringArray, requiredArray, requiredNumber, requiredObject, requiredString, status, stuguby, telemetry, telemetryReader, weather } from "./01-config-to-get-house-weather.js";
import { outdoorTemperatureHistory } from "./05-get-mcp-stuguby-to-result-output-schema.js";
import { runMcpThermalWork } from "./thermal-work.js";

export async function thermalSimulation(
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const houseId = requiredString(args, "houseId");
  const house = requireMcpHouse(database, houseId);
  const sensor = requireMcpHouseSensor(database, houseId, requiredString(args, "sensorId"));
  const { from, to } = mcpThermalDateRange(optionalString(args, "from"), optionalString(args, "to"));
  const horizonHours = mcpBoundedInteger(args.horizonHours, "horizonHours", 12, 0, 72);
  const scenarioOutdoorTemperatureC = mcpOptionalFiniteNumber(
    args.scenarioOutdoorTemperatureC,
    "scenarioOutdoorTemperatureC",
  );
  const boundaryPaddingMs = 2 * 3_600_000;
  return runMcpThermalWork({
    subjects: [sensor],
    ...(signal ? { signal } : {}),
    readIndoor: (subject, readSignal) => telemetryReader.thermalMeasurementHistory({
      sensorId: subject.id,
      metrics: ["temperature"],
      from,
      to,
      bucketMinutes: 5,
      limitPerMetric: 5_000,
      ...(readSignal ? { signal: readSignal } : {}),
    }),
    readOutdoor: (readSignal) => telemetryReader.outdoorTemperatureHistory({
      houseId,
      locationKey: outdoorLocationKey(house.location),
      from: new Date(Date.parse(from) - boundaryPaddingMs).toISOString(),
      to: new Date(Date.parse(to) + boundaryPaddingMs).toISOString(),
      limit: 50_000,
      ...(readSignal ? { signal: readSignal } : {}),
    }),
    complete: ({ indoor, outdoor }, completionSignal) => runThermalSimulationAsync({
      houseId,
      sensorId: sensor.id,
      roomLabel: sensor.room,
      from,
      to,
      indoorSamples: indoor[0]!.records,
      outdoorSamples: outdoor.records,
      horizonHours,
      scenarioOutdoorTemperatureC,
    }, undefined, completionSignal ? { signal: completionSignal } : {}),
  });
}

export function createHouse(args: Record<string, unknown>): unknown {
  const propertyId = args.propertyId === undefined ? "property-main" : requiredString(args, "propertyId");
  stuguby.assertPropertyWriteAllowed(propertyId);
  let house = database.createHouse({
    ...(args.id === undefined ? {} : { id: requiredString(args, "id") }),
    propertyId,
    name: requiredString(args, "name"),
    timezone: requiredString(args, "timezone"),
    ...(args.location === undefined ? {} : { location: requiredObject(args, "location") as unknown as HouseLocation }),
    ...(args.mapPlacement === undefined ? {} : { mapPlacement: requiredObject(args, "mapPlacement") as unknown as HouseMapPlacement }),
    ...(args.orientationDegrees === undefined ? {} : { orientationDegrees: requiredNumber(args, "orientationDegrees") }),
    floors: requiredArray(args, "floors", 100, 0) as Floor[],
  });
  house = stuguby.markLocalHouseInAdoptedProperty(house.id);
  status.refreshWeatherConfiguration();
  return house;
}

export function updateHouse(args: Record<string, unknown>): unknown {
  const houseId = requiredString(args, "houseId");
  const previous = requireMcpHouse(database, houseId);
  stuguby.assertHouseWriteAllowed(houseId);
  const patch: {
    name?: string;
    timezone?: string;
    propertyId?: string;
    orientationDegrees?: number | null;
    floors?: Floor[];
    location?: HouseLocation | null;
    mapPlacement?: HouseMapPlacement | null;
  } = {};
  if (args.name !== undefined) patch.name = requiredString(args, "name");
  if (args.timezone !== undefined) patch.timezone = requiredString(args, "timezone");
  if (args.propertyId !== undefined) patch.propertyId = requiredString(args, "propertyId");
  if (args.location !== undefined) patch.location = args.location === null
    ? null
    : requiredObject(args, "location") as unknown as HouseLocation;
  if (args.mapPlacement !== undefined) patch.mapPlacement = args.mapPlacement === null
    ? null
    : requiredObject(args, "mapPlacement") as unknown as HouseMapPlacement;
  if (args.orientationDegrees !== undefined) patch.orientationDegrees = args.orientationDegrees === null
    ? null
    : requiredNumber(args, "orientationDegrees");
  if (args.floors !== undefined) patch.floors = requiredArray(args, "floors", 100, 0) as Floor[];
  if (patch.propertyId && patch.propertyId !== previous.propertyId) {
    stuguby.assertPropertyWriteAllowed(patch.propertyId);
    const sourceLink = database.getProperty(previous.propertyId)?.stuguby;
    const targetLink = database.getProperty(patch.propertyId)?.stuguby;
    if ((previous.stuguby && previous.stuguby.syncState !== "detached")
      || (sourceLink && sourceLink.syncState !== "detached")
      || (targetLink && targetLink.syncState !== "detached")) {
      throw new Error("Use the reviewed Stuguby Property migration to move a Home into or out of an adopted Property");
    }
  }
  if (patch.floors) stuguby.assertSharedHouseFloorPlanAssetsUnchanged(houseId, patch.floors);
  const house = database.transaction(() => {
    const updated = database.updateHouse(houseId, patch, "local-mcp");
    if (!updated) throw new Error(`Unknown house: ${houseId}`);
    stuguby.captureHomeMutation(updated.id);
    return updated;
  });
  weather.invalidate(houseId);
  status.refreshWeatherConfiguration();
  return house;
}

export function replaceHouseLayout(args: Record<string, unknown>): unknown {
  const houseId = requiredString(args, "houseId");
  stuguby.assertHouseWriteAllowed(houseId);
  const floors = requiredArray(args, "floors", 100, 0) as Floor[];
  stuguby.assertSharedHouseFloorPlanAssetsUnchanged(houseId, floors);
  const house = database.transaction(() => {
    const updated = database.updateHouse(houseId, { floors }, "local-mcp");
    if (!updated) throw new Error(`Unknown house: ${houseId}`);
    stuguby.captureHomeMutation(updated.id);
    return updated;
  });
  return house;
}

export function replaceHouseFloor(args: Record<string, unknown>): Floor {
  const houseId = requiredString(args, "houseId");
  const floorId = requiredString(args, "floorId");
  const house = requireMcpHouse(database, houseId);
  stuguby.assertHouseWriteAllowed(houseId);
  const floor = requiredObject(args, "floor") as unknown as Floor;
  if (floor.id !== floorId) throw new Error("floor.id must match floorId");
  const index = house.floors.findIndex((candidate) => candidate.id === floorId);
  if (index < 0) throw new Error(`Unknown floor ${floorId} in house ${houseId}`);
  const floors = house.floors.slice();
  floors[index] = floor;
  stuguby.assertSharedHouseFloorPlanAssetsUnchanged(houseId, floors);
  database.transaction(() => {
    database.updateHouse(houseId, { floors }, "local-mcp");
    stuguby.captureHomeMutation(houseId);
  });
  return floor;
}

export function createSensor(args: Record<string, unknown>): Sensor {
  const tags = optionalStringArray(args, "tags", []);
  const houseId = requiredString(args, "houseId");
  stuguby.assertHouseWriteAllowed(houseId);
  if (["temperatureEntityId", "humidityEntityId", "batteryEntityId", "tpLinkDeviceId", "measurementEntityIds"]
    .some((field) => args[field] !== undefined && args[field] !== null)) {
    stuguby.assertHouseLocalAuthority(houseId);
  }
  const sensor = database.transaction(() => {
    const created = database.createSensor({
      ...(args.id === undefined ? {} : { id: requiredString(args, "id") }),
      houseId,
      floorId: requiredString(args, "floorId"),
      name: requiredString(args, "name"),
      ...(args.roomId === undefined ? {} : { roomId: args.roomId === null ? null : requiredString(args, "roomId") }),
      room: requiredString(args, "room"),
      model: requiredString(args, "model"),
      x: requiredNumber(args, "x"), y: requiredNumber(args, "y"), z: requiredNumber(args, "z"),
      tags,
      enabled: optionalBoolean(args, "enabled", true),
      ...(args.temperatureEntityId === undefined ? {} : { temperatureEntityId: requiredString(args, "temperatureEntityId") }),
      ...(args.humidityEntityId === undefined ? {} : { humidityEntityId: requiredString(args, "humidityEntityId") }),
      ...(args.batteryEntityId === undefined ? {} : { batteryEntityId: requiredString(args, "batteryEntityId") }),
      ...(args.tpLinkDeviceId === undefined || args.tpLinkDeviceId === null ? {} : { tpLinkDeviceId: requiredString(args, "tpLinkDeviceId") }),
      ...(args.measurementEntityIds === undefined
        ? {}
        : { measurementEntityIds: stringRecord(requiredObject(args, "measurementEntityIds"), "measurementEntityIds") }),
    });
    stuguby.captureHomeMutation(created.houseId);
    return created;
  });
  return sensor;
}

export function stringRecord(value: Record<string, unknown>, field: string): Record<string, string> {
  if (Object.values(value).some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`${field} values must be non-empty strings`);
  }
  return value as Record<string, string>;
}

export function updateSensor(args: Record<string, unknown>): Sensor {
  const sensorId = requiredString(args, "sensorId");
  const current = database.getSensor(sensorId);
  if (!current) throw new Error(`Unknown sensor: ${sensorId}`);
  stuguby.assertHouseWriteAllowed(current.houseId);
  const patch = parseSensorPatch(requiredObject(args, "patch"));
  if (patch.houseId && patch.houseId !== current.houseId) {
    stuguby.assertHouseWriteAllowed(patch.houseId);
    const source = database.getHouse(current.houseId)?.stuguby;
    const target = database.getHouse(patch.houseId)?.stuguby;
    if ((source?.ownership === "shared" && source.syncState !== "detached")
      || (target?.ownership === "shared" && target.syncState !== "detached")) {
      throw new Error("A sensor in a shared Home remains with that Home until permanent disconnect");
    }
  }
  if (["temperatureEntityId", "humidityEntityId", "batteryEntityId", "tpLinkDeviceId", "tpLinkConnectionId", "measurementEntityIds"]
    .some((field) => Object.hasOwn(patch, field))) {
    stuguby.assertHouseLocalAuthority(current.houseId);
  }
  const sensor = database.transaction(() => {
    const updated = database.updateSensor(sensorId, patch);
    if (!updated) throw new Error(`Unknown sensor: ${sensorId}`);
    if (updated.houseId !== current.houseId) stuguby.captureHomeMutation(current.houseId);
    stuguby.captureHomeMutation(updated.houseId);
    return updated;
  });
  return sensor;
}

export function deleteSensor(args: Record<string, unknown>): { deleted: true; sensorId: string } {
  requireMcpConfirmation(args.confirm);
  const sensorId = requiredString(args, "sensorId");
  const current = database.getSensor(sensorId);
  if (!current) throw new Error(`Unknown sensor: ${sensorId}`);
  stuguby.assertHouseWriteAllowed(current.houseId);
  database.transaction(() => {
    if (!database.deleteSensor(sensorId)) throw new Error(`Unknown sensor: ${sensorId}`);
    stuguby.captureHomeMutation(current.houseId);
  });
  return { deleted: true, sensorId };
}

export function createMeasurementDefinition(args: Record<string, unknown>): MeasurementDefinition {
  return database.createMeasurementDefinition(parseMeasurementDefinition(requiredObject(args, "definition")));
}

export function updateMeasurementDefinition(args: Record<string, unknown>): MeasurementDefinition {
  const id = requiredString(args, "metric");
  const current = database.getMeasurementDefinition(id);
  if (!current) throw new Error(`Unknown measurement metric: ${id}`);
  const definition = database.updateMeasurementDefinition(
    id,
    parseMeasurementDefinition(requiredObject(args, "patch"), current),
  );
  if (!definition) throw new Error(`Unknown measurement metric: ${id}`);
  return definition;
}

export function disableMeasurementDefinition(args: Record<string, unknown>): MeasurementDefinition {
  const id = requiredString(args, "metric");
  const definition = database.disableMeasurementDefinition(id);
  if (!definition) throw new Error(`Unknown measurement metric: ${id}`);
  return definition;
}

export function parseMeasurementSamples(args: Record<string, unknown>, maximum: number): MeasurementSample[] {
  return requiredArray(args, "samples", maximum).map((sample) => parseMeasurementSample(sample, database));
}

export function ingestMeasurements(args: Record<string, unknown>): { accepted: number; samples: MeasurementSample[] } {
  const submitted = parseMeasurementSamples(args, 1_000);
  for (const sample of submitted) {
    const sensor = database.getSensor(sample.sensorId);
    if (sensor) stuguby.assertHouseLocalAuthority(sensor.houseId);
  }
  const samples = measurements.ingestBatch(submitted);
  return { accepted: samples.length, samples };
}

export function importMeasurements(args: Record<string, unknown>): { accepted: number; ignoredDuplicates: number } {
  const submitted = parseMeasurementSamples(args, 10_000).map((sample) => ({ ...sample, source: "import" as const }));
  for (const sample of submitted) {
    const sensor = database.getSensor(sample.sensorId);
    if (sensor) stuguby.assertHouseLocalAuthority(sensor.houseId);
  }
  const samples = measurements.ingestBatch(submitted, {
    allowDisabledSensors: true,
    publish: false,
    evaluateAlerts: false,
    deduplicateAcrossSources: true,
  });
  return { accepted: samples.length, ignoredDuplicates: submitted.length - samples.length };
}

export function ingestReadings(args: Record<string, unknown>): { readings: Reading[]; ignoredDuplicates: number } {
  const submitted = requiredArray(args, "readings", 1_000).map(parseReading);
  for (const reading of submitted) {
    const sensor = database.getSensor(reading.sensorId);
    if (sensor) stuguby.assertHouseLocalAuthority(sensor.houseId);
  }
  const readings = telemetry.ingestBatch(submitted);
  return { readings, ignoredDuplicates: submitted.length - readings.length };
}

export async function queryMeasurementHistory(args: Record<string, unknown>): Promise<MeasurementSample[]> {
  const sensorId = requiredString(args, "sensorId");
  const metric = requiredString(args, "metric");
  requireMcpMeasurementTarget(database, sensorId, metric);
  const from = mcpIsoDate(requiredString(args, "from"), "from");
  const to = mcpIsoDate(requiredString(args, "to"), "to");
  validateMcpDateRange(from, to);
  return (await telemetryReader.measurementHistory({
    sensorId,
    metric,
    from,
    to,
    limit: mcpBoundedInteger(args.limit, "limit", 2_000, 1, 50_000),
  })).records;
}

export async function querySensorHistory(args: Record<string, unknown>): Promise<Reading[]> {
  const sensorId = requiredString(args, "sensorId");
  requireMcpSensor(database, sensorId);
  const from = mcpIsoDate(requiredString(args, "from"), "from");
  const to = mcpIsoDate(requiredString(args, "to"), "to");
  validateMcpDateRange(from, to);
  return (await telemetryReader.legacyReadingHistory({
    sensorIds: [sensorId],
    from,
    to,
    limit: mcpBoundedInteger(args.limit, "limit", 2_000, 1, 50_000),
  })).records;
}

export function createAlertRule(args: Record<string, unknown>): AlertRule {
  const input = parseAlertRule(requiredObject(args, "rule"), database);
  const sensor = input.sensorId ? database.getSensor(input.sensorId) : null;
  if (sensor) stuguby.assertHouseLocalAuthority(sensor.houseId);
  return database.saveAlertRule(input);
}
