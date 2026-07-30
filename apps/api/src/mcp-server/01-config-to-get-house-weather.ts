import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { isIP } from "node:net";
import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH, hasLocalHouseAuthority, resolvePlanElementOpeningState } from "@climate-twin/contracts";
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
import { TimeseriesStore } from "../timeseries/store.js";
import { runThermalIsolation } from "../thermal-isolation.js";
import { runThermalSimulation } from "../thermal-simulation.js";
import { TpLinkBridge } from "../tp-link.js";
import { SYSTEM_VERSION } from "../version.js";
import { FmiWeatherProvider, WeatherRequestSupersededError, WeatherService } from "../weather.js";
import type { StugubyService } from "../stuguby/service.js";
import { StugubyStore } from "../stuguby/store.js";

export const config = loadConfig();
const mcpTimeseriesHost = config.timeseriesHost ?? "127.0.0.1";

export const database = new ClimateDatabase(config.databasePath, false, { readOnly: true });

export const locationDiscovery = new LocationDiscoveryService();

export const bus = new TelemetryBus();

export const stugubyStore = new StugubyStore(database.db, "mcp-read-only", { readOnly: true });

export const stuguby = new Proxy({} as StugubyService, {
  get: () => () => {
    throw new Error("The Stugu MCP server is read-only");
  },
});

export const dataMode = new DataModeCoordinator(database);

export const status = new RuntimeStatus(config, bus, database);

export const dataOperations = new DataOperationsService(database, config);

const timeseriesSsl = config.timeseriesSslMode === "disable"
  ? undefined
  : config.timeseriesSslMode === "require"
    ? { rejectUnauthorized: false }
    : config.timeseriesSslMode === "verify-ca"
      ? {
        rejectUnauthorized: true,
        ...(config.timeseriesSslCa ? { ca: config.timeseriesSslCa } : {}),
        checkServerIdentity: () => undefined,
      }
      : {
        rejectUnauthorized: true,
        ...(config.timeseriesSslCa ? { ca: config.timeseriesSslCa } : {}),
        ...(isIP(mcpTimeseriesHost) === 0 ? { servername: mcpTimeseriesHost } : {}),
      };

export const timeseries = config.timeseriesEnabled ? new TimeseriesStore({
  poolConfig: {
    host: mcpTimeseriesHost,
    port: config.timeseriesPort ?? 5432,
    database: config.timeseriesDatabase ?? "stuga",
    user: config.timeseriesUser ?? "stuga_app",
    password: config.timeseriesPassword ?? "",
    options: "-c max_parallel_workers_per_gather=0",
    ...(timeseriesSsl ? { ssl: timeseriesSsl } : {}),
  },
  maxConnections: config.timeseriesPoolMax ?? 6,
  connectionTimeoutMs: config.timeseriesConnectTimeoutMs ?? 5_000,
  statementTimeoutMs: config.timeseriesStatementTimeoutMs ?? 15_000,
}) : null;

export const telemetryReader = new HybridTelemetryReader({
  local: database,
  archive: timeseries,
  localHistoryComplete: !timeseries
    ? true
    : (query) => (config.retentionDays ?? 0) > 0
      && Date.parse(query.from) >= Date.now() - (config.retentionDays ?? 0) * 86_400_000,
});

export const energyCost = new EnergyCostService(
  telemetryReader,
  undefined,
  (sensorId) => database.getSensor(sensorId)?.energyMeterRole ?? "standalone",
);

export const energyOptimizer = new EnergyOptimizer(database, telemetryReader);

export const setupDoctor = new SetupDoctor(database, config, status, dataOperations, null);

export const alertEngine = new AlertEngine(database, bus, config, status);

export const telemetry = new TelemetryService(database, bus, alertEngine, dataMode);

export const measurements = new MeasurementService(database, bus, alertEngine, dataMode);

export const mock = new MockEngine(database, telemetry, config, dataMode);

export const replay = new ReplayEngine(database, bus);

export const homeAssistant = new HomeAssistantBridge(config, telemetry, measurements, database, status);

export const tpLink = new TpLinkBridge(config, telemetry, measurements, database, status);

export const weather = new WeatherService(
  new AutomaticWeatherProvider(new FmiWeatherProvider(), new OpenMeteoWeatherProvider()),
  status.value.weather,
  () => status.changed(),
);

dataMode.onActivated(() => {
  mock.stop();
  replay.reset();
  status.refreshDataMode();
});

export function objectArguments(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

export function nullableString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${key} must be a string or null`);
  return value;
}

export function requiredNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  return value;
}

export function optionalBoolean(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

export function requiredObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} must be an object`);
  return value as Record<string, unknown>;
}

export function requiredArray(args: Record<string, unknown>, key: string, maximum: number, minimum = 1): unknown[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${key} must contain between ${minimum} and ${maximum} items`);
  }
  return value;
}

export function optionalStringArray(args: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const value = args[key];
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`${key} must be an array of non-empty strings`);
  }
  return value as string[];
}

export function enumString<T extends string>(args: Record<string, unknown>, key: string, values: readonly T[]): T {
  const value = args[key];
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${key} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

export const propertyAreaKinds = [
  "well", "beach", "garage", "plantation", "garden", "field", "forest",
  "shoreline", "dock", "road", "yard", "building", "other",
] as const;

export const areaEquipmentStatuses = ["active", "out-of-service", "retired"] as const;

export function createProperty(args: Record<string, unknown>): Property {
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

export function createPropertyArea(args: Record<string, unknown>): PropertyArea {
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
  stuguby.assertPropertyWriteAllowed(input.propertyId);
  const area = database.transaction(() => {
    const created = database.createPropertyArea(input);
    stuguby.captureCurrentPropertyEntity(created.propertyId, "area", created.id, "upsert");
    return created;
  });
  return area;
}

export function updatePropertyArea(args: Record<string, unknown>): PropertyArea {
  const areaId = requiredString(args, "areaId");
  const previous = database.getPropertyArea(areaId);
  if (!previous) throw new Error(`Unknown property area: ${areaId}`);
  stuguby.assertPropertyWriteAllowed(previous.propertyId);
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
  if (patch.propertyId && patch.propertyId !== previous.propertyId) stuguby.assertPropertyWriteAllowed(patch.propertyId);
  const area = database.transaction(() => {
    const updated = database.updatePropertyArea(areaId, patch, "local-mcp");
    if (!updated) throw new Error(`Unknown property area: ${areaId}`);
    if (updated.propertyId !== previous.propertyId) {
      stuguby.captureCurrentPropertyEntity(previous.propertyId, "area", updated.id, "delete");
      stuguby.captureCurrentPropertyEntity(updated.propertyId, "area", updated.id, "upsert");
    } else {
      stuguby.captureCurrentPropertyEntity(updated.propertyId, "area", updated.id, "upsert",
        Object.keys(patch).filter((field) => field !== "propertyId"));
    }
    return updated;
  });
  return area;
}

export function createAreaEquipment(args: Record<string, unknown>): AreaEquipment {
  const areaId = requiredString(args, "areaId");
  const input: AreaEquipmentInput = {
    ...(args.id === undefined ? {} : { id: requiredString(args, "id") }),
    areaId,
    name: requiredString(args, "name"),
    kind: requiredString(args, "kind"),
    ...(args.manufacturer === undefined ? {} : { manufacturer: nullableString(args, "manufacturer") }),
    ...(args.model === undefined ? {} : { model: nullableString(args, "model") }),
    ...(args.serialNumber === undefined ? {} : { serialNumber: nullableString(args, "serialNumber") }),
    ...(args.status === undefined ? {} : { status: enumString(args, "status", areaEquipmentStatuses) }),
    ...(args.notes === undefined ? {} : { notes: nullableString(args, "notes") }),
  };
  const area = database.getPropertyArea(areaId);
  if (!area) throw new Error(`Unknown property area: ${areaId}`);
  stuguby.assertPropertyWriteAllowed(area.propertyId);
  const equipment = database.transaction(() => {
    const created = database.createAreaEquipment(input);
    stuguby.captureCurrentPropertyEntity(created.propertyId, "equipment", created.id, "upsert");
    return created;
  });
  return equipment;
}

export function updateAreaEquipment(args: Record<string, unknown>): AreaEquipment {
  const equipmentId = requiredString(args, "equipmentId");
  const previous = database.getAreaEquipment(equipmentId);
  if (!previous) throw new Error(`Unknown area equipment: ${equipmentId}`);
  stuguby.assertPropertyWriteAllowed(previous.propertyId);
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
  if (patch.areaId) {
    const targetArea = database.getPropertyArea(patch.areaId);
    if (!targetArea) throw new Error(`Unknown property area: ${patch.areaId}`);
    if (targetArea.propertyId !== previous.propertyId) stuguby.assertPropertyWriteAllowed(targetArea.propertyId);
  }
  const equipment = database.transaction(() => {
    const updated = database.updateAreaEquipment(equipmentId, patch, "local-mcp");
    if (!updated) throw new Error(`Unknown area equipment: ${equipmentId}`);
    if (updated.propertyId !== previous.propertyId) {
      stuguby.captureCurrentPropertyEntity(previous.propertyId, "equipment", updated.id, "delete");
      stuguby.captureCurrentPropertyEntity(updated.propertyId, "equipment", updated.id, "upsert");
    } else {
      stuguby.captureCurrentPropertyEntity(updated.propertyId, "equipment", updated.id, "upsert", Object.keys(patch));
    }
    return updated;
  });
  return equipment;
}

export function measurementSnapshot(houseId?: string): MeasurementSnapshotEntry[] {
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

export async function getHouseWeather(houseId: string, hours: number): Promise<HouseWeather> {
  const house = requireMcpHouse(database, houseId);
  if (!hasLocalHouseAuthority(house)) {
    throw new Error(`House ${houseId} is a remote Stuguby projection`);
  }
  if (!house.location) throw new Error(`House ${houseId} does not have a weather location`);
  const result = await weather.get(house, hours);
  const current = database.getHouse(house.id);
  if (!current || current.updatedAt !== house.updatedAt
    || outdoorLocationKey(current.location) !== outdoorLocationKey(result.location)) {
    throw new WeatherRequestSupersededError();
  }
  return result;
}
