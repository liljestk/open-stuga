import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH } from "@climate-twin/contracts";
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
} from "./app.js";
import { loadConfig } from "./config.js";
import { ClimateDatabase, outdoorLocationKey } from "./db.js";
import { discoverHomeAssistant } from "./discovery.js";
import { TelemetryBus } from "./events.js";
import { HomeAssistantBridge } from "./home-assistant.js";
import { McpOperationTracker } from "./mcp-lifecycle.js";
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
  requireMcpRealDataPersistenceConfirmation,
  requireMcpSensor,
  summarizeMcpAreaEquipment,
  summarizeMcpHouse,
  summarizeMcpProperty,
  summarizeMcpPropertyArea,
  validateMcpToolRegistry,
  validateMcpDateRange,
} from "./mcp-validation.js";
import { LocationDiscoveryService } from "./location-discovery.js";
import { AutomaticWeatherProvider, OpenMeteoWeatherProvider } from "./open-meteo.js";
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
} from "./services.js";
import { runThermalSimulation } from "./thermal-simulation.js";
import { TpLinkBridge } from "./tp-link.js";
import { SYSTEM_VERSION } from "./version.js";
import { FmiWeatherProvider, WeatherRequestSupersededError, WeatherService } from "./weather.js";

const config = loadConfig();
const database = new ClimateDatabase(config.databasePath, config.mockEnabled);
const locationDiscovery = new LocationDiscoveryService();
const bus = new TelemetryBus();
const dataMode = new DataModeCoordinator(database);
if ((config.haUrl && config.haToken) || (config.tpLinkHost && config.tpLinkUsername && config.tpLinkPassword)) {
  dataMode.activate();
}
const status = new RuntimeStatus(config, bus, database);
const alertEngine = new AlertEngine(database, bus, config, status);
const telemetry = new TelemetryService(database, bus, alertEngine, dataMode);
const measurements = new MeasurementService(database, bus, alertEngine, dataMode);
const mock = new MockEngine(database, telemetry, config, dataMode);
const replay = new ReplayEngine(database, bus);
const homeAssistant = new HomeAssistantBridge(config, telemetry, measurements, database, status);
const tpLink = new TpLinkBridge(config, telemetry, measurements, database, status);
const weather = new WeatherService(
  new AutomaticWeatherProvider(new FmiWeatherProvider(), new OpenMeteoWeatherProvider()),
  status.value.weather,
  () => status.changed(),
);
dataMode.onActivated(() => {
  mock.stop();
  replay.reset();
  status.refreshDataMode();
});

function objectArguments(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function nullableString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${key} must be a string or null`);
  return value;
}

function requiredNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function requiredObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} must be an object`);
  return value as Record<string, unknown>;
}

function requiredArray(args: Record<string, unknown>, key: string, maximum: number, minimum = 1): unknown[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${key} must contain between ${minimum} and ${maximum} items`);
  }
  return value;
}

function optionalStringArray(args: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const value = args[key];
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`${key} must be an array of non-empty strings`);
  }
  return value as string[];
}

function enumString<T extends string>(args: Record<string, unknown>, key: string, values: readonly T[]): T {
  const value = args[key];
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${key} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

const propertyAreaKinds = [
  "well", "beach", "garage", "plantation", "garden", "field", "forest",
  "shoreline", "dock", "road", "yard", "building", "other",
] as const;
const areaEquipmentStatuses = ["active", "out-of-service", "retired"] as const;

function createProperty(args: Record<string, unknown>): Property {
  const input: PropertyCreateInput = {
    ...(args.id === undefined ? {} : { id: requiredString(args, "id") }),
    name: requiredString(args, "name"),
    ...(args.description === undefined ? {} : { description: nullableString(args, "description") }),
    ...(args.location === undefined
      ? {}
      : { location: args.location === null ? null : requiredObject(args, "location") as unknown as HouseLocation }),
  };
  return database.createProperty(input);
}

function createPropertyArea(args: Record<string, unknown>): PropertyArea {
  const input: PropertyAreaInput = {
    ...(args.id === undefined ? {} : { id: requiredString(args, "id") }),
    propertyId: requiredString(args, "propertyId"),
    name: requiredString(args, "name"),
    kind: enumString(args, "kind", propertyAreaKinds),
    ...(args.description === undefined ? {} : { description: nullableString(args, "description") }),
    ...(args.location === undefined || args.location === null
      ? {}
      : { location: requiredObject(args, "location") as unknown as GeoCoordinate }),
    polygon: requiredArray(args, "polygon", 500, 0) as GeoCoordinate[],
  };
  return database.createPropertyArea(input);
}

function updatePropertyArea(args: Record<string, unknown>): PropertyArea {
  const areaId = requiredString(args, "areaId");
  const values = requiredObject(args, "patch");
  const patch: PropertyAreaPatch = {};
  if (values.propertyId !== undefined) patch.propertyId = requiredString(values, "propertyId");
  if (values.name !== undefined) patch.name = requiredString(values, "name");
  if (values.kind !== undefined) patch.kind = enumString(values, "kind", propertyAreaKinds);
  if (values.description !== undefined) patch.description = nullableString(values, "description");
  if (values.location !== undefined) patch.location = values.location === null
    ? null
    : requiredObject(values, "location") as unknown as GeoCoordinate;
  if (values.polygon !== undefined) patch.polygon = requiredArray(values, "polygon", 500, 0) as GeoCoordinate[];
  if (Object.keys(patch).length === 0) throw new Error("patch must contain at least one mutable field");
  const area = database.updatePropertyArea(areaId, patch, "local-mcp");
  if (!area) throw new Error(`Unknown property area: ${areaId}`);
  return area;
}

function createAreaEquipment(args: Record<string, unknown>): AreaEquipment {
  const input: AreaEquipmentInput = {
    ...(args.id === undefined ? {} : { id: requiredString(args, "id") }),
    areaId: requiredString(args, "areaId"),
    name: requiredString(args, "name"),
    kind: requiredString(args, "kind"),
    ...(args.manufacturer === undefined ? {} : { manufacturer: nullableString(args, "manufacturer") }),
    ...(args.model === undefined ? {} : { model: nullableString(args, "model") }),
    ...(args.serialNumber === undefined ? {} : { serialNumber: nullableString(args, "serialNumber") }),
    ...(args.status === undefined ? {} : { status: enumString(args, "status", areaEquipmentStatuses) }),
    ...(args.notes === undefined ? {} : { notes: nullableString(args, "notes") }),
  };
  return database.createAreaEquipment(input);
}

function updateAreaEquipment(args: Record<string, unknown>): AreaEquipment {
  const equipmentId = requiredString(args, "equipmentId");
  const values = requiredObject(args, "patch");
  const patch: AreaEquipmentPatch = {};
  if (values.areaId !== undefined) patch.areaId = requiredString(values, "areaId");
  if (values.name !== undefined) patch.name = requiredString(values, "name");
  if (values.kind !== undefined) patch.kind = requiredString(values, "kind");
  if (values.manufacturer !== undefined) patch.manufacturer = nullableString(values, "manufacturer");
  if (values.model !== undefined) patch.model = nullableString(values, "model");
  if (values.serialNumber !== undefined) patch.serialNumber = nullableString(values, "serialNumber");
  if (values.status !== undefined) patch.status = enumString(values, "status", areaEquipmentStatuses);
  if (values.notes !== undefined) patch.notes = nullableString(values, "notes");
  if (Object.keys(patch).length === 0) throw new Error("patch must contain at least one mutable field");
  const equipment = database.updateAreaEquipment(equipmentId, patch, "local-mcp");
  if (!equipment) throw new Error(`Unknown area equipment: ${equipmentId}`);
  return equipment;
}

function measurementSnapshot(houseId?: string): MeasurementSnapshotEntry[] {
  if (houseId) requireMcpHouse(database, houseId);
  const bySensor = new Map<string, Record<string, MeasurementSample>>();
  for (const sample of database.latestMeasurementSamples(houseId)) {
    const measurements = bySensor.get(sample.sensorId) ?? Object.create(null) as Record<string, MeasurementSample>;
    measurements[sample.metric] = sample;
    bySensor.set(sample.sensorId, measurements);
  }
  return database.listSensors(houseId).map((sensor) => ({
    sensorId: sensor.id,
    measurements: bySensor.get(sensor.id) ?? {},
  }));
}

function persistFreshWeatherObservation(result: HouseWeather): boolean {
  if (result.stale || !result.current || !Number.isFinite(result.current.temperatureC)) return false;
  database.upsertCurrentOutdoorTemperatureSample({
    houseId: result.houseId,
    locationKey: outdoorLocationKey(result.location),
    timestamp: result.current.timestamp,
    temperatureC: result.current.temperatureC as number,
    source: result.provider === "fmi" ? "fmi-observation" : "open-meteo-current",
    fetchedAt: result.fetchedAt,
    stationId: result.observationStation?.id ?? null,
    stationName: result.observationStation?.name ?? null,
    conditions: result.current,
  });
  dataMode.synchronize();
  return true;
}

async function getHouseWeather(houseId: string, hours: number, persistObservation: boolean): Promise<HouseWeather & {
  persistence: { requested: boolean; persisted: boolean; realDataMode: boolean };
}> {
  const house = requireMcpHouse(database, houseId);
  if (!house.location) throw new Error(`House ${houseId} does not have a weather location`);
  const result = await weather.get(house, hours);
  const current = database.getHouse(house.id);
  if (!current || current.updatedAt !== house.updatedAt
    || outdoorLocationKey(current.location) !== outdoorLocationKey(result.location)) {
    throw new WeatherRequestSupersededError();
  }
  const persisted = persistObservation ? persistFreshWeatherObservation(result) : false;
  return {
    ...result,
    persistence: { requested: persistObservation, persisted, realDataMode: dataMode.isRealMode },
  };
}

function thermalSimulation(args: Record<string, unknown>): unknown {
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
  return runThermalSimulation({
    houseId,
    sensorId: sensor.id,
    roomLabel: sensor.room,
    from,
    to,
    indoorSamples: database.thermalTemperatureHistory(sensor.id, from, to, 5, 5_000),
    outdoorSamples: database.outdoorTemperatureHistory(
      houseId,
      outdoorLocationKey(house.location),
      new Date(Date.parse(from) - boundaryPaddingMs).toISOString(),
      new Date(Date.parse(to) + boundaryPaddingMs).toISOString(),
      50_000,
    ),
    horizonHours,
    scenarioOutdoorTemperatureC,
  });
}

function createHouse(args: Record<string, unknown>): unknown {
  const house = database.createHouse({
    ...(args.id === undefined ? {} : { id: requiredString(args, "id") }),
    ...(args.propertyId === undefined ? {} : { propertyId: requiredString(args, "propertyId") }),
    name: requiredString(args, "name"),
    timezone: requiredString(args, "timezone"),
    ...(args.location === undefined ? {} : { location: requiredObject(args, "location") as unknown as HouseLocation }),
    ...(args.mapPlacement === undefined ? {} : { mapPlacement: requiredObject(args, "mapPlacement") as unknown as HouseMapPlacement }),
    ...(args.orientationDegrees === undefined ? {} : { orientationDegrees: requiredNumber(args, "orientationDegrees") }),
    floors: requiredArray(args, "floors", 100, 0) as Floor[],
  });
  status.refreshWeatherConfiguration();
  return house;
}

function updateHouse(args: Record<string, unknown>): unknown {
  const houseId = requiredString(args, "houseId");
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
  const house = database.updateHouse(houseId, patch, "local-mcp");
  if (!house) throw new Error(`Unknown house: ${houseId}`);
  weather.invalidate(houseId);
  status.refreshWeatherConfiguration();
  return house;
}

function replaceHouseLayout(args: Record<string, unknown>): unknown {
  const houseId = requiredString(args, "houseId");
  const house = database.updateHouse(houseId, { floors: requiredArray(args, "floors", 100, 0) as Floor[] }, "local-mcp");
  if (!house) throw new Error(`Unknown house: ${houseId}`);
  return house;
}

function replaceHouseFloor(args: Record<string, unknown>): Floor {
  const houseId = requiredString(args, "houseId");
  const floorId = requiredString(args, "floorId");
  const house = requireMcpHouse(database, houseId);
  const floor = requiredObject(args, "floor") as unknown as Floor;
  if (floor.id !== floorId) throw new Error("floor.id must match floorId");
  const index = house.floors.findIndex((candidate) => candidate.id === floorId);
  if (index < 0) throw new Error(`Unknown floor ${floorId} in house ${houseId}`);
  const floors = house.floors.slice();
  floors[index] = floor;
  database.updateHouse(houseId, { floors }, "local-mcp");
  return floor;
}

function deleteHouse(args: Record<string, unknown>): { deleted: true; houseId: string } {
  requireMcpConfirmation(args.confirm);
  const houseId = requiredString(args, "houseId");
  if (!database.deleteHouse(houseId)) throw new Error(`Unknown house: ${houseId}`);
  weather.invalidate(houseId);
  status.refreshWeatherConfiguration();
  return { deleted: true, houseId };
}

function createSensor(args: Record<string, unknown>): Sensor {
  const tags = optionalStringArray(args, "tags", []);
  const sensor = database.createSensor({
    ...(args.id === undefined ? {} : { id: requiredString(args, "id") }),
    houseId: requiredString(args, "houseId"),
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
  return sensor;
}

function stringRecord(value: Record<string, unknown>, field: string): Record<string, string> {
  if (Object.values(value).some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`${field} values must be non-empty strings`);
  }
  return value as Record<string, string>;
}

function updateSensor(args: Record<string, unknown>): Sensor {
  const sensorId = requiredString(args, "sensorId");
  const patch = parseSensorPatch(requiredObject(args, "patch"));
  const sensor = database.updateSensor(sensorId, patch);
  if (!sensor) throw new Error(`Unknown sensor: ${sensorId}`);
  return sensor;
}

function deleteSensor(args: Record<string, unknown>): { deleted: true; sensorId: string } {
  requireMcpConfirmation(args.confirm);
  const sensorId = requiredString(args, "sensorId");
  if (!database.deleteSensor(sensorId)) throw new Error(`Unknown sensor: ${sensorId}`);
  return { deleted: true, sensorId };
}

function createMeasurementDefinition(args: Record<string, unknown>): MeasurementDefinition {
  return database.createMeasurementDefinition(parseMeasurementDefinition(requiredObject(args, "definition")));
}

function updateMeasurementDefinition(args: Record<string, unknown>): MeasurementDefinition {
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

function disableMeasurementDefinition(args: Record<string, unknown>): MeasurementDefinition {
  const id = requiredString(args, "metric");
  const definition = database.disableMeasurementDefinition(id);
  if (!definition) throw new Error(`Unknown measurement metric: ${id}`);
  return definition;
}

function parseMeasurementSamples(args: Record<string, unknown>, maximum: number): MeasurementSample[] {
  return requiredArray(args, "samples", maximum).map((sample) => parseMeasurementSample(sample, database));
}

function ingestMeasurements(args: Record<string, unknown>): { accepted: number; samples: MeasurementSample[] } {
  const samples = measurements.ingestBatch(parseMeasurementSamples(args, 1_000));
  return { accepted: samples.length, samples };
}

function importMeasurements(args: Record<string, unknown>): { accepted: number; ignoredDuplicates: number } {
  const submitted = parseMeasurementSamples(args, 10_000).map((sample) => ({ ...sample, source: "import" as const }));
  const samples = measurements.ingestBatch(submitted, {
    allowDisabledSensors: true,
    publish: false,
    evaluateAlerts: false,
    deduplicateAcrossSources: true,
  });
  return { accepted: samples.length, ignoredDuplicates: submitted.length - samples.length };
}

function ingestReadings(args: Record<string, unknown>): { readings: Reading[]; ignoredDuplicates: number } {
  const submitted = requiredArray(args, "readings", 1_000).map(parseReading);
  const readings = telemetry.ingestBatch(submitted);
  return { readings, ignoredDuplicates: submitted.length - readings.length };
}

function queryMeasurementHistory(args: Record<string, unknown>): MeasurementSample[] {
  const sensorId = requiredString(args, "sensorId");
  const metric = requiredString(args, "metric");
  requireMcpMeasurementTarget(database, sensorId, metric);
  const from = mcpIsoDate(requiredString(args, "from"), "from");
  const to = mcpIsoDate(requiredString(args, "to"), "to");
  validateMcpDateRange(from, to);
  assertMcpLocalHistoryComplete(from);
  return database.measurementHistory(
    sensorId,
    metric,
    from,
    to,
    mcpBoundedInteger(args.limit, "limit", 2_000, 1, 50_000),
  );
}

function querySensorHistory(args: Record<string, unknown>): Reading[] {
  const sensorId = requiredString(args, "sensorId");
  requireMcpSensor(database, sensorId);
  const from = mcpIsoDate(requiredString(args, "from"), "from");
  const to = mcpIsoDate(requiredString(args, "to"), "to");
  validateMcpDateRange(from, to);
  assertMcpLocalHistoryComplete(from);
  return database.history([sensorId], from, to, mcpBoundedInteger(args.limit, "limit", 2_000, 1, 50_000));
}

function assertMcpLocalHistoryComplete(from: string): void {
  if (config.retentionDays <= 0 || !config.timeseriesEnabled) return;
  if (Date.parse(from) >= Date.now() - config.retentionDays * 86_400_000) return;
  throw new Error("Complete cold telemetry history must be queried through the archive-aware REST API");
}

function createAlertRule(args: Record<string, unknown>): AlertRule {
  return database.saveAlertRule(parseAlertRule(requiredObject(args, "rule"), database));
}

function updateAlertRule(args: Record<string, unknown>): AlertRule {
  const ruleId = requiredString(args, "ruleId");
  const current = database.getAlertRule(ruleId);
  if (!current) throw new Error(`Unknown alert rule: ${ruleId}`);
  const parsed = parseAlertRule({ ...current, ...requiredObject(args, "patch"), id: ruleId }, database);
  const { id: _id, ...patch } = parsed;
  const rule = database.updateAlertRule(ruleId, patch);
  if (!rule) throw new Error(`Unknown alert rule: ${ruleId}`);
  return rule;
}

function deleteAlertRule(args: Record<string, unknown>): { deleted: true; ruleId: string } {
  requireMcpConfirmation(args.confirm);
  const ruleId = requiredString(args, "ruleId");
  if (!database.deleteAlertRule(ruleId)) throw new Error(`Unknown alert rule: ${ruleId}`);
  return { deleted: true, ruleId };
}

function acknowledgeAlert(args: Record<string, unknown>): unknown {
  const alertId = requiredString(args, "alertId");
  const event = database.acknowledgeAlert(alertId, new Date().toISOString());
  if (!event) throw new Error(`Unknown alert event: ${alertId}`);
  bus.publish({ type: "alert", data: event });
  return event;
}

function createObservation(args: Record<string, unknown>): ManualObservation {
  return database.createObservation(parseObservationInput(args), "local-mcp");
}

function updateObservation(args: Record<string, unknown>): ManualObservation {
  const observationId = requiredString(args, "observationId");
  const observation = database.updateObservation(
    observationId,
    parseObservationPatch({ ...requiredObject(args, "patch"), baseRevision: args.baseRevision }),
    "local-mcp",
  );
  if (!observation) throw new Error(`Unknown observation: ${observationId}`);
  return observation;
}

function listObservationRevisions(args: Record<string, unknown>): unknown[] {
  const observationId = requiredString(args, "observationId");
  if (!database.getObservation(observationId)) throw new Error(`Unknown observation: ${observationId}`);
  return database.listObservationRevisions(observationId);
}

function deleteObservation(args: Record<string, unknown>): { deleted: true; observationId: string } {
  requireMcpConfirmation(args.confirm);
  const observationId = requiredString(args, "observationId");
  if (!database.deleteObservation(observationId)) throw new Error(`Unknown observation: ${observationId}`);
  return { deleted: true, observationId };
}

function createMaintenanceTask(args: Record<string, unknown>): MaintenanceTask {
  return database.createMaintenanceTask(parseMaintenanceTaskInput(args), "local-mcp");
}

function listMaintenanceTasks(args: Record<string, unknown>): MaintenanceTask[] {
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

function updateMaintenanceTask(args: Record<string, unknown>): MaintenanceTask {
  const maintenanceTaskId = requiredString(args, "maintenanceTaskId");
  const task = database.updateMaintenanceTask(
    maintenanceTaskId,
    parseMaintenanceTaskPatch({ ...requiredObject(args, "patch"), baseRevision: args.baseRevision }),
    "local-mcp",
  );
  if (!task) throw new Error(`Unknown maintenance task: ${maintenanceTaskId}`);
  return task;
}

function listMaintenanceTaskRevisions(args: Record<string, unknown>): unknown[] {
  const maintenanceTaskId = requiredString(args, "maintenanceTaskId");
  if (!database.getMaintenanceTask(maintenanceTaskId)) {
    throw new Error(`Unknown maintenance task: ${maintenanceTaskId}`);
  }
  return database.listMaintenanceTaskRevisions(maintenanceTaskId);
}

function deleteMaintenanceTask(args: Record<string, unknown>): { deleted: true; maintenanceTaskId: string } {
  requireMcpConfirmation(args.confirm);
  const maintenanceTaskId = requiredString(args, "maintenanceTaskId");
  if (!database.deleteMaintenanceTask(maintenanceTaskId)) {
    throw new Error(`Unknown maintenance task: ${maintenanceTaskId}`);
  }
  return { deleted: true, maintenanceTaskId };
}

function upsertStaticParameter(args: Record<string, unknown>): StaticParameter {
  const value = args.value;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error("value must be a string, number, or boolean");
  }
  return database.saveParameter({
    ...(args.id === undefined ? {} : { id: requiredString(args, "id") }),
    houseId: requiredString(args, "houseId"),
    scopeType: enumString(args, "scopeType", ["house", "floor", "room", "sensor"] as const),
    scopeId: requiredString(args, "scopeId"),
    key: requiredString(args, "key"),
    value,
    unit: args.unit === null || args.unit === undefined ? null : requiredString(args, "unit"),
    label: requiredString(args, "label"),
  });
}

function deleteStaticParameter(args: Record<string, unknown>): { deleted: true; parameterId: string } {
  requireMcpConfirmation(args.confirm);
  const parameterId = requiredString(args, "parameterId");
  if (!database.deleteParameter(parameterId)) throw new Error(`Unknown static parameter: ${parameterId}`);
  return { deleted: true, parameterId };
}

const safeAssetMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "model/gltf+json", "model/gltf-binary"]);

function assetMetadata(asset: { id: string; houseId: string; name: string; mimeType: string; kind: string; size: number; createdAt: string }): object {
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

function uploadAsset(args: Record<string, unknown>): object {
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
    houseId: requiredString(args, "houseId"),
    name: requiredString(args, "name"),
    mimeType,
    kind: enumString(args, "kind", ["floor-plan", "model-3d", "other"] as const),
    data,
  }));
}

function deleteAsset(args: Record<string, unknown>): { deleted: true; assetId: string } {
  requireMcpConfirmation(args.confirm);
  const assetId = requiredString(args, "assetId");
  if (!database.deleteAsset(assetId)) throw new Error(`Unknown asset: ${assetId}`);
  return { deleted: true, assetId };
}

async function discoverIntegrations(): Promise<object> {
  const [homeAssistantResult, tpLinkResult] = await Promise.allSettled([
    discoverHomeAssistant(),
    tpLink.discoverHubs(),
  ]);
  const warnings: string[] = [];
  if (homeAssistantResult.status === "rejected") warnings.push("Home Assistant discovery was unavailable. Enter its address manually.");
  if (tpLinkResult.status === "rejected") warnings.push("TP-Link discovery was unavailable. Enter the hub address manually.");
  return {
    homeAssistant: homeAssistantResult.status === "fulfilled" ? homeAssistantResult.value : [],
    tpLink: tpLinkResult.status === "fulfilled" ? tpLinkResult.value : [],
    warnings,
  };
}

function homeAssistantSetup(): object {
  return {
    configured: status.value.homeAssistant.configured,
    steps: [
      "Create a Home Assistant long-lived access token for a dedicated local user.",
      "Configure its local URL and token in the Stuga web integration screen or the API process's protected environment/secrets file.",
      "Map each Stuga sensor to legacy climate keys and/or a measurements object keyed by registry id.",
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

function tpLinkSetup(): object {
  return {
    configured: status.value.tpLink.configured,
    supportedHubs: ["H100", "H200"],
    supportedClimateSensors: ["T310", "T315"],
    supportedEnergyDevices: "Configured TP-Link/Kasa hosts that python-kasa exposes through Module.Energy",
    steps: [
      "Install python-kasa from apps/api/python/requirements.txt.",
      "Configure a hub or direct energy device's reserved LAN address and TP-Link credentials in the Stuga web integration screen or the API process's protected environment/secrets file.",
      "Inspect discovered devices in the long-running API process.",
      "Assign a stable child device id to a sensor's tpLinkDeviceId field.",
    ],
    sensorPatchSchema: { tpLinkDeviceId: "hub-child-device-id" },
    deviceMapSchema: { devices: [{ deviceId: "hub-child-device-id", sensorId: "sensor-01" }] },
    notes: [
      "Credentials are never returned and are stored outside SQLite.",
      "The MCP server deliberately does not accept or write credentials; keep secrets out of model and tool arguments.",
      "The stdio MCP process deliberately does not start a second continuous hub poller beside the API process.",
      "LAN discovery remains H100/H200-only; direct energy devices need manual address entry and expose power, plus cumulative energy only when python-kasa provides consumption_total.",
      "Saving a real integration permanently disables and purges demo telemetry for this database.",
    ],
  };
}

function homeAssistantConnectionTest(): object {
  return {
    ok: false,
    available: false,
    runtimeScope: "mcp-process",
    message: "Live Home Assistant connection testing belongs to the long-running API process and is unavailable over stdio.",
  };
}

function tpLinkConnectionTest(): object {
  return {
    ok: false,
    available: false,
    runtimeScope: "mcp-process",
    message: "Live TP-Link connection testing belongs to the long-running API process and is unavailable over stdio.",
  };
}

function selectMockScenario(args: Record<string, unknown>): object {
  const scenario = enumString(args, "scenario", MOCK_SCENARIOS.map((item) => item.id));
  mock.setScenario(scenario);
  return { active: mock.scenario };
}

function startReplay(args: Record<string, unknown>): object {
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

const pointSchema = {
  type: "object",
  properties: { x: { type: "number" }, y: { type: "number" } },
  required: ["x", "y"],
  additionalProperties: false,
} as const;

const houseLocationSchema = {
  type: "object",
  properties: {
    latitude: { type: "number", minimum: -90, maximum: 90 },
    longitude: { type: "number", minimum: -180, maximum: 180 },
    label: { type: "string", maxLength: 200 },
    countryCode: { type: "string", pattern: "^[A-Za-z]{2}$" },
    source: { enum: ["manual", "place-search", "browser-geolocation", "home-assistant", "map-placement"] },
    confidence: { enum: ["high", "medium", "low"] },
    discoveredAt: { type: "string", format: "date-time" },
    userOverridden: { type: "boolean" },
  },
  required: ["latitude", "longitude"],
  additionalProperties: false,
} as const;

const geoCoordinateSchema = {
  type: "object",
  properties: {
    latitude: { type: "number", minimum: -90, maximum: 90 },
    longitude: { type: "number", minimum: -180, maximum: 180 },
  },
  required: ["latitude", "longitude"],
  additionalProperties: false,
} as const;

const propertyAreaMutableProperties = {
  propertyId: { type: "string", minLength: 1, maxLength: 200 },
  name: { type: "string", minLength: 1, maxLength: 200 },
  kind: { enum: propertyAreaKinds },
  description: { type: ["string", "null"], maxLength: 5_000 },
  location: { oneOf: [geoCoordinateSchema, { type: "null" }] },
  polygon: { type: "array", minItems: 0, maxItems: 500, items: geoCoordinateSchema },
} as const;

const areaEquipmentMutableProperties = {
  areaId: { type: "string", minLength: 1, maxLength: 200 },
  name: { type: "string", minLength: 1, maxLength: 200 },
  kind: { type: "string", minLength: 1, maxLength: 200 },
  manufacturer: { type: ["string", "null"], maxLength: 200 },
  model: { type: ["string", "null"], maxLength: 200 },
  serialNumber: { type: ["string", "null"], maxLength: 200 },
  status: { enum: areaEquipmentStatuses },
  notes: { type: ["string", "null"], maxLength: 5_000 },
} as const;

const houseMapPlacementSchema = {
  type: "object",
  properties: {
    latitude: { type: "number", minimum: -90, maximum: 90 },
    longitude: { type: "number", minimum: -180, maximum: 180 },
    metersPerPlanUnit: { type: "number", exclusiveMinimum: 0 },
    footprintFloorId: { type: "string", minLength: 1 },
  },
  required: ["latitude", "longitude", "metersPerPlanUnit"],
  additionalProperties: false,
} as const;

const floorSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 },
    type: { enum: ["basement", "ground", "upper", "attic", "mezzanine", "outdoor"] },
    width: { type: "number", exclusiveMinimum: 0 }, height: { type: "number", exclusiveMinimum: 0 },
    elevation: { type: "number" }, ceilingHeight: { type: "number", exclusiveMinimum: 0 },
    wallHeight: { type: "number", exclusiveMinimum: 0, maximum: 20 },
    roof: {
      type: "object",
      properties: {
        style: { enum: ["gable", "hip", "shed", "flat"] },
        pitchDegrees: { type: "number", minimum: 0, maximum: 75 },
        ridgeAxis: { enum: ["x", "y"] },
        overhang: { type: "number", minimum: 0 },
        eavesHeight: { type: "number", minimum: 0 },
      },
      required: ["style", "pitchDegrees", "ridgeAxis", "overhang", "eavesHeight"],
      additionalProperties: false,
    },
    walls: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string", minLength: 1 }, from: pointSchema, to: pointSchema },
        required: ["id", "from", "to"],
        additionalProperties: false,
      },
    },
    rooms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, kind: { type: "string" },
          points: { type: "array", minItems: 3, items: pointSchema },
        },
        required: ["id", "name", "points"],
        additionalProperties: false,
      },
    },
    planElements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          kind: { enum: ["door", "window", "fireplace", "vent"] },
          position: pointSchema,
          rotationDegrees: { type: "number", minimum: 0, exclusiveMaximum: 360 },
          width: { type: "number", exclusiveMinimum: 0 },
          height: { type: "number", exclusiveMinimum: 0, description: "Physical element height in metres for the 3D representation." },
          wallId: { type: "string", minLength: 1 },
          verticalExtent: { enum: ["level", "roof"] },
          chimneyHeightAboveRoof: { type: "number", minimum: 0, maximum: 5 },
        },
        required: ["id", "kind", "position", "rotationDegrees"],
        additionalProperties: false,
      },
    },
    backgroundImage: { type: "string" },
  },
  required: ["id", "name", "width", "height", "elevation", "walls", "rooms"],
  additionalProperties: false,
} as const;

const sensorProperties = {
  houseId: { type: "string", minLength: 1 }, floorId: { type: "string", minLength: 1 },
  name: { type: "string", minLength: 1 }, roomId: { type: ["string", "null"], minLength: 1 },
  room: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1 },
  x: { type: "number" }, y: { type: "number" }, z: { type: "number" },
  temperatureEntityId: { type: "string", minLength: 1 }, humidityEntityId: { type: "string", minLength: 1 },
  batteryEntityId: { type: "string", minLength: 1 }, tpLinkDeviceId: { type: ["string", "null"] },
  measurementEntityIds: { type: "object", additionalProperties: { type: "string", minLength: 1 } },
  tags: { type: "array", items: { type: "string" } }, enabled: { type: "boolean" },
} as const;

const measurementDefinitionProperties = {
  labels: { type: "object", minProperties: 1, additionalProperties: { type: "string", minLength: 1 } },
  unit: { type: "string", minLength: 1 }, precision: { type: "integer", minimum: 0, maximum: 6 },
  validMin: { type: ["number", "null"] }, validMax: { type: ["number", "null"] },
  displayMin: { type: ["number", "null"] }, displayMax: { type: ["number", "null"] },
  interpolationDelta: { type: "number", exclusiveMinimum: 0 },
  colorScale: { enum: ["thermal", "humidity", "air-quality", "sequential"] },
  enabled: { type: "boolean" }, spatialInterpolation: { type: "boolean" }, forecastSupported: { type: "boolean" },
} as const;

const measurementSampleSchema = {
  type: "object",
  properties: {
    sensorId: { type: "string", minLength: 1 }, metric: { type: "string", minLength: 1 }, value: { type: "number" },
    canonicalUnit: { type: "string", minLength: 1 }, timestamp: { type: "string", format: "date-time" },
    quality: { enum: ["good", "estimated", "stale"] },
  },
  required: ["sensorId", "metric", "value"],
  additionalProperties: false,
} as const;

const readingInputSchema = {
  type: "object",
  properties: {
    sensorId: { type: "string", minLength: 1 }, timestamp: { type: "string", format: "date-time" },
    temperature: { type: "number", minimum: -80, maximum: 100 }, humidity: { type: "number", minimum: 0, maximum: 100 },
    battery: { type: ["number", "null"], minimum: 0, maximum: 100 },
    quality: { enum: ["good", "estimated", "stale"] },
    measurements: { type: "object", additionalProperties: { type: "number" } },
  },
  required: ["sensorId", "temperature", "humidity"],
  additionalProperties: false,
} as const;

const alertRuleProperties = {
  name: { type: "string", minLength: 1 }, sensorId: { type: ["string", "null"] }, metric: { type: "string", minLength: 1 },
  operator: { enum: ["gt", "gte", "lt", "lte"] }, threshold: { type: "number" },
  durationSeconds: { type: "integer", minimum: 1, maximum: 31_536_000 },
  severity: { enum: ["info", "warning", "critical"] }, enabled: { type: "boolean" }, webhookEnabled: { type: "boolean" }, telegramEnabled: { type: "boolean" },
} as const;

const observationCreateProperties = {
  floorId: { type: "string", minLength: 1 }, sensorId: { type: ["string", "null"] },
  kind: { enum: ["leak", "condensation", "mould", "ventilation", "maintenance", "note"] },
  severity: { enum: ["info", "warning", "critical"] }, note: { type: "string", minLength: 1 },
  x: { type: ["number", "null"] }, y: { type: ["number", "null"] },
  occurredAt: { oneOf: [{ type: "string", format: "date-time" }, { type: "string", format: "date" }] },
  timePrecision: { enum: ["exact", "approximate", "date-only", "date-range", "unknown"] },
  validFrom: { type: ["string", "null"], format: "date" },
  validTo: { type: ["string", "null"], format: "date" },
  source: { enum: ["owner", "caretaker", "contractor", "sensor", "imported-document", "automated-analysis", "unknown"] },
  sourceDetail: { type: ["string", "null"] },
  confidence: { enum: ["confirmed", "probable", "uncertain", "awaiting-inspection"] },
} as const;

const observationPatchProperties = {
  ...observationCreateProperties,
  status: { enum: ["open", "resolved"] },
  resolutionNote: {
    type: ["string", "null"],
    minLength: 1,
    maxLength: MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH,
  },
} as const;

const maintenanceTaskCreateProperties = {
  floorId: { type: ["string", "null"], maxLength: 200 },
  areaId: { type: ["string", "null"], minLength: 1, maxLength: 200 },
  equipmentId: { type: ["string", "null"], minLength: 1, maxLength: 200 },
  title: { type: "string", minLength: 1, maxLength: 200 },
  description: { type: ["string", "null"], maxLength: 5_000 },
  basis: { enum: ["required", "scheduled", "condition-based", "predictive", "optional-improvement"] },
  basisDetail: { type: ["string", "null"], maxLength: 5_000 },
  priority: { enum: ["low", "normal", "high", "urgent"] },
  plannedFor: { type: ["string", "null"], format: "date" },
  dueBy: { type: ["string", "null"], format: "date" },
  observationIds: {
    type: "array", maxItems: 100,
    items: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

const maintenanceTaskPatchProperties = {
  ...maintenanceTaskCreateProperties,
  houseId: { type: ["string", "null"], minLength: 1, maxLength: 200 },
  status: { enum: ["planned", "in-progress", "completed", "verified", "cancelled"] },
  completionNote: { type: ["string", "null"], maxLength: 5_000 },
  verificationNote: { type: ["string", "null"], maxLength: 5_000 },
} as const;

const confirmationProperty = { confirm: { const: true, description: "Must be true to authorize this destructive operation." } } as const;

const server = new Server(
  { name: "stuga-local", version: SYSTEM_VERSION },
  {
    capabilities: { tools: {} },
    instructions: [
      "This Stuga stdio MCP operates only on its configured local SQLite workspace and is not an administration API.",
      "It cannot inspect a separately running API process's in-memory connections or event bus.",
      "Raw integration credentials, SSE streams, and binary asset downloads are intentionally excluded from MCP tool arguments and results.",
    ].join(" "),
  },
);
const operations = new McpOperationTracker();

const resultOutputSchema = {
  type: "object",
  properties: { result: { oneOf: [{ type: "object" }, { type: "array" }] } },
  required: ["result"],
  additionalProperties: false,
} as const;

const mcpTools = [
    {
      name: "list_properties",
      description: "List compact property summaries without exact map-centre coordinates or free-form descriptions.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "create_property",
      description: "Create a property that can own houses, mapped areas, and equipment.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1, maxLength: 200 },
          name: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: ["string", "null"], maxLength: 5_000 },
          location: { oneOf: [houseLocationSchema, { type: "null" }] },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    {
      name: "list_property_areas",
      description: "List compact mapped-area and fixed-asset summaries, optionally for one property. Exact coordinates and free-form descriptions are omitted.",
      inputSchema: {
        type: "object",
        properties: { propertyId: { type: "string", minLength: 1, maxLength: 200 } },
        additionalProperties: false,
      },
    },
    {
      name: "create_property_area",
      description: "Create a mapped polygon area or fixed-position asset on a property. Use an empty polygon for a point asset.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", minLength: 1, maxLength: 200 }, ...propertyAreaMutableProperties },
        required: ["propertyId", "name", "kind", "polygon"],
        additionalProperties: false,
      },
    },
    {
      name: "update_property_area",
      description: "Update an area or fixed asset, including its position, or move its complete aggregate to another property.",
      inputSchema: {
        type: "object",
        properties: {
          areaId: { type: "string", minLength: 1, maxLength: 200 },
          patch: { type: "object", properties: propertyAreaMutableProperties, minProperties: 1, additionalProperties: false },
        },
        required: ["areaId", "patch"],
        additionalProperties: false,
      },
    },
    {
      name: "list_area_equipment",
      description: "List compact area-equipment summaries, optionally filtered by property or area. Serial numbers and free-form notes are omitted.",
      inputSchema: {
        type: "object",
        properties: {
          propertyId: { type: "string", minLength: 1, maxLength: 200 },
          areaId: { type: "string", minLength: 1, maxLength: 200 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "create_area_equipment",
      description: "Create equipment in a mapped area; its property is derived from that area.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", minLength: 1, maxLength: 200 }, ...areaEquipmentMutableProperties },
        required: ["areaId", "name", "kind"],
        additionalProperties: false,
      },
    },
    {
      name: "update_area_equipment",
      description: "Update equipment or move it to another area; its property follows the target area automatically.",
      inputSchema: {
        type: "object",
        properties: {
          equipmentId: { type: "string", minLength: 1, maxLength: 200 },
          patch: { type: "object", properties: areaEquipmentMutableProperties, minProperties: 1, additionalProperties: false },
        },
        required: ["equipmentId", "patch"],
        additionalProperties: false,
      },
    },
    {
      name: "list_houses",
      description: "List compact house and floor summaries. Coordinates, map placement, detailed geometry, and embedded floor-plan images are omitted; request get_house for one explicitly selected house when those details are needed.",
      inputSchema: { type: "object", properties: { propertyId: { type: "string" } }, additionalProperties: false },
    },
    {
      name: "get_house",
      description: "Get one house with its location, map placement, orientation, and floor layout.",
      inputSchema: { type: "object", properties: { houseId: { type: "string" } }, required: ["houseId"], additionalProperties: false },
    },
    {
      name: "create_house",
      description: "Create a house and validated floor layout.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" }, propertyId: { type: "string" }, name: { type: "string" }, timezone: { type: "string" },
          location: houseLocationSchema, mapPlacement: houseMapPlacementSchema,
          orientationDegrees: { type: "number", minimum: 0, exclusiveMaximum: 360 },
          floors: { type: "array", maxItems: 100, items: floorSchema },
        },
        required: ["name", "timezone", "floors"],
        additionalProperties: false,
      },
    },
    {
      name: "update_house",
      description: "Update house metadata, location, map placement, orientation, and/or its full floor layout.",
      inputSchema: {
        type: "object",
        properties: {
          houseId: { type: "string" }, propertyId: { type: "string" }, name: { type: "string" }, timezone: { type: "string" },
          location: { oneOf: [houseLocationSchema, { type: "null" }] },
          mapPlacement: { oneOf: [houseMapPlacementSchema, { type: "null" }] },
          orientationDegrees: { type: ["number", "null"], minimum: 0, exclusiveMaximum: 360 },
          floors: { type: "array", maxItems: 100, items: floorSchema },
        },
        required: ["houseId"],
        additionalProperties: false,
      },
    },
    {
      name: "replace_house_layout",
      description: "Replace a house's complete validated floor collection.",
      inputSchema: { type: "object", properties: { houseId: { type: "string" }, floors: { type: "array", maxItems: 100, items: floorSchema } }, required: ["houseId", "floors"], additionalProperties: false },
    },
    {
      name: "replace_house_floor",
      description: "Replace one existing floor; the nested floor id must match floorId.",
      inputSchema: { type: "object", properties: { houseId: { type: "string" }, floorId: { type: "string" }, floor: floorSchema }, required: ["houseId", "floorId", "floor"], additionalProperties: false },
    },
    {
      name: "delete_house",
      description: "Permanently delete a house and its dependent local data. Requires confirm=true.",
      inputSchema: { type: "object", properties: { houseId: { type: "string" }, ...confirmationProperty }, required: ["houseId", "confirm"], additionalProperties: false },
    },
    {
      name: "search_locations",
      description: "Search worldwide place and timezone suggestions through Open-Meteo geocoding. The query is sent to that public service only when this tool is called.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 2, maxLength: 120 },
          language: { type: "string", pattern: "^[a-zA-Z]{2}$", default: "en" },
          limit: { type: "integer", minimum: 1, maximum: 10, default: 6 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "resolve_coordinate_defaults",
      description: "Resolve an IANA timezone for explicitly supplied WGS84 coordinates through Open-Meteo.",
      inputSchema: {
        type: "object",
        properties: {
          latitude: { type: "number", minimum: -90, maximum: 90 },
          longitude: { type: "number", minimum: -180, maximum: 180 },
        },
        required: ["latitude", "longitude"],
        additionalProperties: false,
      },
    },
    {
      name: "get_house_weather",
      description: "Fetch provider-neutral current conditions, forecasts, and warning coverage for a located house. This contacts the configured public weather provider but does not write by default. Setting persistObservation=true stores a fresh current temperature, can permanently activate real-data mode, and can purge demo telemetry; it requires confirmRealDataPersistence=true.",
      inputSchema: {
        type: "object",
        properties: {
          houseId: { type: "string" },
          hours: { type: "integer", minimum: 1, maximum: 240, default: 48 },
          persistObservation: {
            type: "boolean",
            default: false,
            description: "Opt in to storing a fresh current observation for thermal calibration.",
          },
          confirmRealDataPersistence: {
            const: true,
            description: "Required when persistObservation=true because the one-way real-data latch can purge demo telemetry.",
          },
        },
        required: ["houseId"],
        additionalProperties: false,
      },
    },
    {
      name: "run_thermal_simulation",
      description: "Fit the experimental first-order room model from observed indoor and outdoor temperatures and return calibration quality, reconstruction, residuals, and an optional constant-outdoor scenario.",
      inputSchema: {
        type: "object",
        properties: {
          houseId: { type: "string" },
          sensorId: { type: "string" },
          from: { type: "string", format: "date-time" },
          to: { type: "string", format: "date-time" },
          horizonHours: { type: "integer", minimum: 0, maximum: 72, default: 12 },
          scenarioOutdoorTemperatureC: { type: "number" },
        },
        required: ["houseId", "sensorId"],
        additionalProperties: false,
      },
    },
    {
      name: "list_sensors",
      description: "Discover configured sensors, optionally scoped to one house.",
      inputSchema: { type: "object", properties: { houseId: { type: "string" } }, additionalProperties: false },
    },
    {
      name: "create_sensor",
      description: "Create and place a sensor, including optional Home Assistant and TP-Link bindings.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, ...sensorProperties },
        required: ["houseId", "floorId", "name", "room", "model", "x", "y", "z"],
        additionalProperties: false,
      },
    },
    {
      name: "update_sensor",
      description: "Atomically update a sensor's metadata, placement, state, or integration bindings.",
      inputSchema: {
        type: "object",
        properties: {
          sensorId: { type: "string" },
          patch: { type: "object", properties: sensorProperties, minProperties: 1, additionalProperties: false },
        },
        required: ["sensorId", "patch"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_sensor",
      description: "Permanently delete a sensor and dependent local data. Requires confirm=true.",
      inputSchema: { type: "object", properties: { sensorId: { type: "string" }, ...confirmationProperty }, required: ["sensorId", "confirm"], additionalProperties: false },
    },
    {
      name: "list_measurement_definitions",
      description: "List the registry of built-in and custom measurement definitions, units, ranges, and capabilities.",
      inputSchema: { type: "object", properties: { includeDisabled: { type: "boolean" } }, additionalProperties: false },
    },
    {
      name: "create_measurement_definition",
      description: "Create a custom numeric measurement definition.",
      inputSchema: {
        type: "object",
        properties: {
          definition: {
            type: "object",
            properties: { id: { type: "string" }, ...measurementDefinitionProperties },
            required: ["id", "labels", "unit"],
            additionalProperties: false,
          },
        },
        required: ["definition"],
        additionalProperties: false,
      },
    },
    {
      name: "update_measurement_definition",
      description: "Update mutable fields of an existing measurement definition.",
      inputSchema: {
        type: "object",
        properties: {
          metric: { type: "string" },
          patch: { type: "object", properties: measurementDefinitionProperties, minProperties: 1, additionalProperties: false },
        },
        required: ["metric", "patch"],
        additionalProperties: false,
      },
    },
    {
      name: "disable_measurement_definition",
      description: "Disable a measurement definition without deleting its historical samples or alert rules.",
      inputSchema: { type: "object", properties: { metric: { type: "string" } }, required: ["metric"], additionalProperties: false },
    },
    {
      name: "ingest_measurements",
      description: "Atomically persist 1-1000 validated registry measurement samples with server-assigned API provenance and durable alert evaluation. A separate API process's SSE bus is not available over stdio.",
      inputSchema: { type: "object", properties: { samples: { type: "array", minItems: 1, maxItems: 1000, items: measurementSampleSchema } }, required: ["samples"], additionalProperties: false },
    },
    {
      name: "import_measurements",
      description: "Duplicate-safe import of 1-10000 historical measurement samples without live events or alert evaluation.",
      inputSchema: { type: "object", properties: { samples: { type: "array", minItems: 1, maxItems: 10000, items: measurementSampleSchema } }, required: ["samples"], additionalProperties: false },
    },
    {
      name: "ingest_readings",
      description: "Ingest 1-1000 validated v1 temperature/humidity readings plus optional registry projections.",
      inputSchema: { type: "object", properties: { readings: { type: "array", minItems: 1, maxItems: 1000, items: readingInputSchema } }, required: ["readings"], additionalProperties: false },
    },
    {
      name: "get_measurement_snapshot",
      description: "Get the latest independently timestamped sample for every registered metric on each sensor, optionally scoped to one house.",
      inputSchema: { type: "object", properties: { houseId: { type: "string" } }, additionalProperties: false },
    },
    {
      name: "query_measurement_history",
      description: "Query independently timestamped samples for any registered metric.",
      inputSchema: {
        type: "object",
        properties: { sensorId: { type: "string" }, metric: { type: "string" }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, limit: { type: "integer", minimum: 1, maximum: 50000 } },
        required: ["sensorId", "metric", "from", "to"], additionalProperties: false,
      },
    },
    {
      name: "forecast_measurement",
      description: "Forecast one registered metric when its definition explicitly enables forecasting.",
      inputSchema: {
        type: "object",
        properties: { sensorId: { type: "string" }, metric: { type: "string" }, hours: { type: "integer", minimum: 1, maximum: 168 } },
        required: ["sensorId", "metric"], additionalProperties: false,
      },
    },
    {
      name: "get_sensor_snapshot",
      description: "Get one sensor, its position, and its latest temperature/humidity reading.",
      inputSchema: { type: "object", properties: { sensorId: { type: "string" } }, required: ["sensorId"], additionalProperties: false },
    },
    {
      name: "query_history",
      description: "Query durable sensor history over an ISO date-time range.",
      inputSchema: {
        type: "object",
        properties: { sensorId: { type: "string" }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, limit: { type: "integer", minimum: 1, maximum: 50000 } },
        required: ["sensorId", "from", "to"], additionalProperties: false,
      },
    },
    {
      name: "forecast_sensor",
      description: "Return a bounded linear baseline forecast and confidence bands for a sensor.",
      inputSchema: { type: "object", properties: { sensorId: { type: "string" }, hours: { type: "integer", minimum: 1, maximum: 168 } }, required: ["sensorId"], additionalProperties: false },
    },
    {
      name: "list_active_alerts",
      description: "List unresolved climate alert events.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "list_alert_rules",
      description: "List all configured alert rules.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "create_alert_rule",
      description: "Create a metric threshold alert rule.",
      inputSchema: {
        type: "object",
        properties: {
          rule: {
            type: "object",
            properties: { id: { type: "string" }, ...alertRuleProperties },
            required: ["name", "metric", "operator", "threshold", "durationSeconds", "severity"],
            additionalProperties: false,
          },
        },
        required: ["rule"],
        additionalProperties: false,
      },
    },
    {
      name: "update_alert_rule",
      description: "Update mutable fields of an alert rule.",
      inputSchema: {
        type: "object",
        properties: { ruleId: { type: "string" }, patch: { type: "object", properties: alertRuleProperties, minProperties: 1, additionalProperties: false } },
        required: ["ruleId", "patch"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_alert_rule",
      description: "Permanently delete an alert rule. Requires confirm=true.",
      inputSchema: { type: "object", properties: { ruleId: { type: "string" }, ...confirmationProperty }, required: ["ruleId", "confirm"], additionalProperties: false },
    },
    {
      name: "list_alert_events",
      description: "List recent alert events, optionally only unresolved events.",
      inputSchema: { type: "object", properties: { activeOnly: { type: "boolean", default: false }, limit: { type: "integer", minimum: 1, maximum: 1000, default: 200 } }, additionalProperties: false },
    },
    {
      name: "acknowledge_alert",
      description: "Acknowledge an alert event at the current server time.",
      inputSchema: { type: "object", properties: { alertId: { type: "string" } }, required: ["alertId"], additionalProperties: false },
    },
    {
      name: "list_observations",
      description: "List manual leak, condensation, mould, ventilation, maintenance, and note observations.",
      inputSchema: { type: "object", properties: { houseId: { type: "string" } }, additionalProperties: false },
    },
    {
      name: "list_observation_revisions",
      description: "List the append-only local revision history for one observation.",
      inputSchema: {
        type: "object",
        properties: { observationId: { type: "string", minLength: 1 } },
        required: ["observationId"],
        additionalProperties: false,
      },
    },
    {
      name: "list_static_parameters",
      description: "List static house, floor, room, and sensor context used to interpret readings.",
      inputSchema: { type: "object", properties: { houseId: { type: "string" } }, additionalProperties: false },
    },
    {
      name: "create_observation",
      description: "Record a manual leak, condensation, mould, ventilation, maintenance, or note observation.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" }, houseId: { type: "string" }, ...observationCreateProperties,
        },
        required: ["houseId", "floorId", "kind", "severity", "note"], additionalProperties: false,
      },
    },
    {
      name: "update_observation",
      description: "Optimistically update observation evidence, resolve it with a required resolutionNote, or reopen it while preserving append-only revision snapshots.",
      inputSchema: {
        type: "object",
        properties: {
          observationId: { type: "string", minLength: 1 },
          baseRevision: { type: "integer", minimum: 1 },
          patch: { type: "object", properties: observationPatchProperties, minProperties: 1, additionalProperties: false },
        },
        required: ["observationId", "baseRevision", "patch"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_observation",
      description: "Permanently delete a manual observation. Requires confirm=true.",
      inputSchema: { type: "object", properties: { observationId: { type: "string" }, ...confirmationProperty }, required: ["observationId", "confirm"], additionalProperties: false },
    },
    {
      name: "list_maintenance_tasks",
      description: "List planned, active, completed, verified, and cancelled maintenance tasks, optionally filtered by property, house, area, or equipment.",
      inputSchema: {
        type: "object",
        properties: {
          propertyId: { type: "string", minLength: 1, maxLength: 200 },
          houseId: { type: "string", minLength: 1, maxLength: 200 },
          areaId: { type: "string", minLength: 1, maxLength: 200 },
          equipmentId: { type: "string", minLength: 1, maxLength: 200 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "list_maintenance_task_revisions",
      description: "List the append-only local revision history for one maintenance task.",
      inputSchema: {
        type: "object",
        properties: { maintenanceTaskId: { type: "string", minLength: 1 } },
        required: ["maintenanceTaskId"],
        additionalProperties: false,
      },
    },
    {
      name: "create_maintenance_task",
      description: "Plan property-owned maintenance with optional house, floor, area, equipment, and observation evidence context.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          propertyId: { type: "string", minLength: 1, maxLength: 200 },
          houseId: { type: ["string", "null"], minLength: 1, maxLength: 200 },
          ...maintenanceTaskCreateProperties,
        },
        required: ["title", "basis"],
        anyOf: [
          { required: ["propertyId"] },
          {
            required: ["houseId"],
            properties: { houseId: { type: "string", minLength: 1, maxLength: 200 } },
          },
        ],
        additionalProperties: false,
      },
    },
    {
      name: "update_maintenance_task",
      description: "Optimistically edit, complete, verify, replan, or cancel maintenance while preserving revision history.",
      inputSchema: {
        type: "object",
        properties: {
          maintenanceTaskId: { type: "string", minLength: 1 },
          baseRevision: { type: "integer", minimum: 1 },
          patch: { type: "object", properties: maintenanceTaskPatchProperties, minProperties: 1, additionalProperties: false },
        },
        required: ["maintenanceTaskId", "baseRevision", "patch"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_maintenance_task",
      description: "Permanently delete a maintenance task and its revision history. Requires confirm=true.",
      inputSchema: {
        type: "object",
        properties: { maintenanceTaskId: { type: "string" }, ...confirmationProperty },
        required: ["maintenanceTaskId", "confirm"],
        additionalProperties: false,
      },
    },
    {
      name: "upsert_static_parameter",
      description: "Create or update static house, floor, room, or sensor context.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" }, houseId: { type: "string" }, scopeType: { enum: ["house", "floor", "room", "sensor"] },
          scopeId: { type: "string" }, key: { type: "string" },
          value: { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
          unit: { type: ["string", "null"] }, label: { type: "string" },
        },
        required: ["houseId", "scopeType", "scopeId", "key", "value", "label"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_static_parameter",
      description: "Permanently delete a static parameter. Requires confirm=true.",
      inputSchema: { type: "object", properties: { parameterId: { type: "string" }, ...confirmationProperty }, required: ["parameterId", "confirm"], additionalProperties: false },
    },
    {
      name: "list_assets",
      description: "List floor-plan and 3D asset metadata without returning binary content.",
      inputSchema: { type: "object", properties: { houseId: { type: "string" } }, additionalProperties: false },
    },
    {
      name: "get_asset_metadata",
      description: "Get metadata for one stored asset without returning its potentially large binary content.",
      inputSchema: { type: "object", properties: { assetId: { type: "string" } }, required: ["assetId"], additionalProperties: false },
    },
    {
      name: "upload_asset",
      description: "Upload a trusted base64 PNG, JPEG, WebP, glTF, or GLB asset up to 10 MiB decoded.",
      inputSchema: {
        type: "object",
        properties: {
          houseId: { type: "string" }, name: { type: "string" },
          mimeType: { enum: ["image/png", "image/jpeg", "image/webp", "model/gltf+json", "model/gltf-binary"] },
          kind: { enum: ["floor-plan", "model-3d", "other"] },
          data: { type: "string", minLength: 1, maxLength: 14_000_000 },
        },
        required: ["houseId", "name", "mimeType", "kind", "data"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_asset",
      description: "Permanently delete a stored asset. Requires confirm=true.",
      inputSchema: { type: "object", properties: { assetId: { type: "string" }, ...confirmationProperty }, required: ["assetId", "confirm"], additionalProperties: false },
    },
    {
      name: "get_integration_status",
      description: "Get redacted integration and data-mode status for this MCP process. No URL, token, username, or password is returned.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "discover_integrations",
      description: "Run best-effort LAN discovery for Home Assistant and TP-Link H100/H200 hubs.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "get_home_assistant_setup",
      description: "Get credential, entity-map, and real-data-mode setup guidance without secrets.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "test_home_assistant_connection",
      description: "Report redacted connection state visible to this MCP process; it cannot inspect a separate API process's in-memory WebSocket.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "get_tp_link_setup",
      description: "Get direct H100/H200 setup, mapping, and real-data-mode guidance without secrets.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "list_tp_link_devices",
      description: "List sanitized TP-Link child devices cached in this MCP process. The MCP server does not start a duplicate continuous poller beside the API process.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "test_tp_link_connection",
      description: "Report redacted TP-Link connection state visible to this MCP process; it cannot inspect a separate API process's in-memory poller.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "list_mock_scenarios",
      description: "List bundled mock scenarios and the active scenario/data-mode state.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "select_mock_scenario",
      description: "Select a mock scenario. Rejected permanently once the shared database has entered real-data mode.",
      inputSchema: { type: "object", properties: { scenario: { enum: ["normal", "shower", "leak", "cold-front", "heating-failure"] } }, required: ["scenario"], additionalProperties: false },
    },
    {
      name: "generate_mock_tick",
      description: "Generate and persist one mock reading tick. Rejected permanently in real-data mode.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "get_replay_status",
      description: "Get replay state for this MCP process's in-memory event bus.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "start_replay",
      description: "Report that live replay is unavailable over stdio; use the long-running API replay endpoint for observable SSE playback.",
      inputSchema: {
        type: "object",
        properties: {
          sensorIds: { type: "array", items: { type: "string" } }, from: { type: "string", format: "date-time" },
          to: { type: "string", format: "date-time" }, speed: { type: "number", minimum: 0.1, maximum: 10000, default: 60 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "stop_replay",
      description: "Stop replay on this MCP process's in-memory event bus.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ].map((tool) => ({
    ...tool,
    outputSchema: resultOutputSchema,
    annotations: {
      ...mcpToolAnnotations(tool.name),
    },
  }));

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: mcpTools }));

type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

const toolHandlers: Record<string, ToolHandler> = {
  list_properties: () => database.listProperties().map(summarizeMcpProperty),
  create_property: createProperty,
  list_property_areas: (args) => database.listPropertyAreas(optionalString(args, "propertyId"))
    .map(summarizeMcpPropertyArea),
  create_property_area: createPropertyArea,
  update_property_area: updatePropertyArea,
  list_area_equipment: (args) => database.listAreaEquipment({
    ...(args.propertyId === undefined ? {} : { propertyId: requiredString(args, "propertyId") }),
    ...(args.areaId === undefined ? {} : { areaId: requiredString(args, "areaId") }),
  }).map(summarizeMcpAreaEquipment),
  create_area_equipment: createAreaEquipment,
  update_area_equipment: updateAreaEquipment,
  list_houses: (args) => database.listHouses(args.propertyId === undefined ? undefined : requiredString(args, "propertyId")).map(summarizeMcpHouse),
  get_house: (args) => requireMcpHouse(database, requiredString(args, "houseId")),
  create_house: createHouse,
  update_house: updateHouse,
  replace_house_layout: replaceHouseLayout,
  replace_house_floor: replaceHouseFloor,
  delete_house: deleteHouse,
  search_locations: (args) => locationDiscovery.search(
    mcpLocationQuery(args.query),
    mcpLanguage(args.language),
    mcpBoundedInteger(args.limit, "limit", 6, 1, 10),
  ),
  resolve_coordinate_defaults: (args) => locationDiscovery.defaultsForCoordinates(
    mcpBoundedNumber(args.latitude, "latitude", -90, 90),
    mcpBoundedNumber(args.longitude, "longitude", -180, 180),
  ),
  get_house_weather: (args) => {
    const persistObservation = optionalBoolean(args, "persistObservation", false);
    if (persistObservation) requireMcpRealDataPersistenceConfirmation(args.confirmRealDataPersistence);
    return getHouseWeather(
      requiredString(args, "houseId"),
      mcpBoundedInteger(args.hours, "hours", 48, 1, 240),
      persistObservation,
    );
  },
  run_thermal_simulation: thermalSimulation,
  list_sensors: (args) => database.listSensors(optionalString(args, "houseId")),
  create_sensor: createSensor,
  update_sensor: updateSensor,
  delete_sensor: deleteSensor,
  list_measurement_definitions: (args) => database.listMeasurementDefinitions(
    optionalBoolean(args, "includeDisabled", true),
  ),
  create_measurement_definition: createMeasurementDefinition,
  update_measurement_definition: updateMeasurementDefinition,
  disable_measurement_definition: disableMeasurementDefinition,
  ingest_measurements: ingestMeasurements,
  import_measurements: importMeasurements,
  ingest_readings: ingestReadings,
  get_measurement_snapshot: (args) => measurementSnapshot(optionalString(args, "houseId")),
  query_measurement_history: queryMeasurementHistory,
  forecast_measurement: (args) => {
    const sensorId = requiredString(args, "sensorId");
    const metric = requiredString(args, "metric");
    requireMcpMeasurementTarget(database, sensorId, metric);
    return forecastMeasurement(database, sensorId, metric, mcpBoundedInteger(args.hours, "hours", 12, 1, 168));
  },
  get_sensor_snapshot: (args) => {
    const sensorId = requiredString(args, "sensorId");
    const sensor = database.getSensor(sensorId);
    if (!sensor) throw new Error(`Unknown sensor: ${sensorId}`);
    return { ...sensor, reading: database.getLatestReading(sensorId) };
  },
  query_history: querySensorHistory,
  forecast_sensor: (args) => {
    const sensorId = requiredString(args, "sensorId");
    requireMcpSensor(database, sensorId);
    return forecast(database, sensorId, mcpBoundedInteger(args.hours, "hours", 12, 1, 168));
  },
  list_active_alerts: () => database.listAlertEvents(200, true),
  list_alert_rules: () => database.listAlertRules(),
  create_alert_rule: createAlertRule,
  update_alert_rule: updateAlertRule,
  delete_alert_rule: deleteAlertRule,
  list_alert_events: (args) => database.listAlertEvents(
    mcpBoundedInteger(args.limit, "limit", 200, 1, 1_000),
    optionalBoolean(args, "activeOnly", false),
  ),
  acknowledge_alert: acknowledgeAlert,
  list_observations: (args) => database.listObservations(optionalString(args, "houseId")),
  list_observation_revisions: listObservationRevisions,
  create_observation: createObservation,
  update_observation: updateObservation,
  delete_observation: deleteObservation,
  list_maintenance_tasks: listMaintenanceTasks,
  list_maintenance_task_revisions: listMaintenanceTaskRevisions,
  create_maintenance_task: createMaintenanceTask,
  update_maintenance_task: updateMaintenanceTask,
  delete_maintenance_task: deleteMaintenanceTask,
  list_static_parameters: (args) => database.listParameters(optionalString(args, "houseId")),
  upsert_static_parameter: upsertStaticParameter,
  delete_static_parameter: deleteStaticParameter,
  list_assets: (args) => database.listAssets(optionalString(args, "houseId")),
  get_asset_metadata: (args) => {
    const assetId = requiredString(args, "assetId");
    const asset = database.getAsset(assetId);
    if (!asset) throw new Error(`Unknown asset: ${assetId}`);
    return assetMetadata(asset);
  },
  upload_asset: uploadAsset,
  delete_asset: deleteAsset,
  get_integration_status: () => {
    dataMode.synchronize();
    return {
      runtimeScope: "mcp-process",
      liveConnectionsAvailable: false,
      status: structuredClone(status.value),
      note: "This stdio process does not start live integration adapters and cannot inspect the API process's connection state.",
    };
  },
  discover_integrations: discoverIntegrations,
  get_home_assistant_setup: homeAssistantSetup,
  test_home_assistant_connection: homeAssistantConnectionTest,
  get_tp_link_setup: tpLinkSetup,
  list_tp_link_devices: () => ({
    devices: [],
    available: false,
    runtimeScope: "mcp-process",
    note: "Live TP-Link inventory belongs to the long-running API process and is unavailable over stdio.",
  }),
  test_tp_link_connection: tpLinkConnectionTest,
  list_mock_scenarios: () => {
    dataMode.synchronize();
    return { scenarios: MOCK_SCENARIOS, active: mock.scenario, enabled: status.value.mock.enabled };
  },
  select_mock_scenario: selectMockScenario,
  generate_mock_tick: () => ({ readings: mock.generate(), scenario: mock.scenario }),
  get_replay_status: () => ({ available: false, replay: { ...replay.state, count: 0 }, runtimeScope: "mcp-process" }),
  start_replay: startReplay,
  stop_replay: () => ({ available: false, replay: replay.stop(), runtimeScope: "mcp-process" }),
};

validateMcpToolRegistry(mcpTools.map((tool) => tool.name), Object.keys(toolHandlers));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const handler = toolHandlers[request.params.name];
  if (!handler) throw new Error(`Unknown tool: ${request.params.name}`);
  const result = await operations.run(() => handler(objectArguments(request.params.arguments)));
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: { result },
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);

let resourcesClosed = false;
let shutdownPromise: Promise<void> | null = null;

function closeResources(): void {
  if (resourcesClosed) return;
  resourcesClosed = true;
  mock.stop();
  replay.stop();
  homeAssistant.stop();
  tpLink.stop();
  database.close();
}

function close(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  operations.stopAccepting();
  mock.stop();
  replay.stop();
  shutdownPromise = (async () => {
    let drainError: unknown;
    try {
      try {
        await operations.waitForIdle(10_000);
      } catch (error) {
        drainError = error;
      }
      // Let the protocol flush the response produced by the final handler.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await server.close();
      if (drainError) throw drainError;
    } finally {
      closeResources();
    }
  })();
  return shutdownPromise;
}

function requestShutdown(): void {
  void close().catch(() => {
    // Keep credentials and request contents out of the stdio protocol logs.
    console.error("Stuga MCP shutdown failed");
    process.exitCode = 1;
  });
}

process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);
process.stdin.once("end", requestShutdown);
