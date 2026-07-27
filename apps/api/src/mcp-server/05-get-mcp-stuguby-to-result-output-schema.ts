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
import { config, dataMode, dataOperations, database, energyCost, optionalString, requiredString, status, stuguby, stugubyStore, telemetry } from "./01-config-to-get-house-weather.js";
import { activeStugubyGrant, recommendedOverviewGrant, stugubySide, summarizeMcpStuguby } from "./04-point-schema-to-summarize-mcp-stuguby.js";

export function getMcpStuguby(args: Record<string, unknown>): object {
  const stugubyId = requiredString(args, "stugubyId");
  const summary = stugubyStore.getStuguby(stugubyId);
  if (!summary) throw new Error(`Unknown Stuguby: ${stugubyId}`);
  const adoption = stugubyStore.getPropertyAdoption(stugubyId);
  const adoptedProperty = adoption ? database.getProperty(adoption.localPropertyId) : null;
  const members = stugubyStore.listMembers(stugubyId);
  const sharedProperty = stugubyStore.getSharedProperty(stugubyId);
  return {
    stuguby: summarizeMcpStuguby(summary),
    members: members.map((member) => ({
      nodeId: member.nodeId,
      displayName: member.displayName,
      side: stugubySide(member.role),
      accessRole: member.role,
      state: member.state,
      isHost: member.nodeId === summary.coordinatorNodeId,
      joinedAt: member.joinedAt,
      updatedAt: member.updatedAt,
    })),
    property: {
      adoption,
      local: adoptedProperty ? summarizeMcpProperty(adoptedProperty) : null,
      shared: sharedProperty ? {
        revision: sharedProperty.revision,
        editPolicy: sharedProperty.editPolicy,
        locationConfigured: sharedProperty.location !== null,
        areaCount: sharedProperty.areas.length,
        equipmentCount: sharedProperty.equipment.length,
        noteCount: sharedProperty.notes.length,
        maintenanceTaskCount: sharedProperty.maintenance.length,
        updatedAt: sharedProperty.updatedAt,
      } : null,
      conflicts: stugubyStore.listPropertyConflicts(stugubyId).length,
      commands: stugubyStore.propertyCommandCounts(stugubyId),
    },
    homes: database.listHouses()
      .filter((house) => house.stuguby?.stugubyId === stugubyId)
      .map(summarizeMcpHouse),
    grants: stugubyStore.listGrants(stugubyId).map((grant) => ({
      id: grant.id,
      authorityNodeId: grant.authorityNodeId,
      publicationId: grant.publicationId,
      localHouseId: grant.localHouseId ?? null,
      audience: {
        kind: grant.audience.kind,
        recipientCount: grant.audience.kind === "all-members"
          ? Math.max(0, members.filter((member) => member.state === "active").length - 1)
          : grant.audience.nodeIds.length,
      },
      datasets: grant.datasets.filter((dataset) => dataset.enabled).map((dataset) => ({
        dataset: dataset.dataset,
        includeLocalIds: dataset.includeLocalIds,
        allowReplicaCache: dataset.allowReplicaCache,
        retentionDays: dataset.retentionDays,
        ...(dataset.telemetry ? { telemetry: dataset.telemetry } : {}),
      })),
      editPolicy: grant.housePolicy.editPolicy,
      recoveryMode: grant.housePolicy.recoveryMode,
      recommendedReadOnlyOverview: recommendedOverviewGrant(grant),
      active: activeStugubyGrant(grant),
      expiresAt: grant.expiresAt,
      revokedAt: grant.revokedAt,
      updatedAt: grant.updatedAt,
    })),
    homeCommands: stugubyStore.homeCommandCounts(stugubyId),
  };
}

export function mcpDateTime(args: Record<string, unknown>, key: string, fallback: Date): string {
  const value = optionalString(args, key);
  return value === undefined ? fallback.toISOString() : mcpIsoDate(value, key);
}

export function dailyAnalyticsFindings(args: Record<string, unknown>): object {
  const house = requireMcpHouse(database, requiredString(args, "houseId"));
  const dataMode = database.isRealDataMode() ? "live" : "demo";
  const stored = database.dailyAnalyticsFindings(house.id, dataMode);
  return {
    snapshot: stored?.snapshot ?? null,
    status: {
      state: stored?.lastError ? "failed" : stored?.snapshot ? "ready" : "pending",
      lastAttemptAt: stored?.lastAttemptAt ?? null,
      lastError: stored?.lastError ?? null,
    },
  };
}

export function propertyElectricity(args: Record<string, unknown>): object {
  const propertyId = requiredString(args, "propertyId");
  if (!database.getProperty(propertyId)) throw new Error(`Unknown property: ${propertyId}`);
  const electricity = database.getPropertyElectricityConfig(propertyId);
  if (!electricity) throw new Error(`Property ${propertyId} does not have electricity configuration`);
  const to = mcpDateTime(args, "to", new Date(Date.now() + 48 * 3_600_000));
  const from = mcpDateTime(args, "from", new Date(Date.now() - 24 * 3_600_000));
  validateMcpDateRange(from, to);
  return {
    config: publicElectricityConfiguration(electricity, true),
    current: database.getCurrentPropertyElectricityPrice(propertyId),
    prices: database.listPropertyElectricityPrices(propertyId, from, to),
  };
}

export function listPropertyNotes(args: Record<string, unknown>): unknown {
  return database.listPropertyNotes({
    ...(args.propertyId === undefined ? {} : { propertyId: requiredString(args, "propertyId") }),
    ...(args.houseId === undefined ? {} : { houseId: requiredString(args, "houseId") }),
    ...(args.areaId === undefined ? {} : { areaId: requiredString(args, "areaId") }),
    ...(args.equipmentId === undefined ? {} : { equipmentId: requiredString(args, "equipmentId") }),
    limit: mcpBoundedInteger(args.limit, "limit", 200, 1, 500),
  });
}

export function houseOpeningStates(args: Record<string, unknown>): object {
  const house = requireMcpHouse(database, requiredString(args, "houseId"));
  const at = mcpDateTime(args, "at", new Date());
  const observations = database.listOpeningStateObservations(house.id, 10_000, at);
  const states = house.floors.flatMap((floor) => (floor.planElements ?? []).flatMap((element) => {
    if (element.kind !== "door" && element.kind !== "window" && element.kind !== "vent") return [];
    return [{
      floorId: floor.id,
      elementId: element.id,
      kind: element.kind,
      ...(element.label ? { label: element.label } : {}),
      ...resolvePlanElementOpeningState(
        element,
        observations.filter((observation) => observation.floorId === floor.id),
        at,
      ),
    }];
  }));
  if (args.from === undefined) return { snapshot: { houseId: house.id, at, states }, observations };
  const from = mcpIsoDate(requiredString(args, "from"), "from");
  const to = mcpDateTime(args, "to", new Date(at));
  const durationMs = Date.parse(to) - Date.parse(from);
  if (durationMs <= 0 || durationMs > 366 * 86_400_000) {
    throw new Error("Opening-state history must cover more than zero and at most 366 days");
  }
  const limit = mcpBoundedInteger(args.limit, "limit", 10_000, 1, 10_000);
  const initial = database.listOpeningStateObservations(house.id, limit, from);
  const history = database.listOpeningStateObservationHistory(
    house.id,
    from,
    to,
    Math.max(1, limit - Math.min(initial.length, limit - 1)),
  );
  const merged = [...new Map([...initial, ...history].map((observation) => [observation.id, observation])).values()]
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id))
    .slice(-limit);
  return { snapshot: { houseId: house.id, at, states }, observations, history: merged, from, to };
}

export function houseElectricityPrice(args: Record<string, unknown>): object {
  const house = requireMcpHouse(database, requiredString(args, "houseId"));
  const toHomePrice = (price: NonNullable<ReturnType<ClimateDatabase["getCurrentPropertyElectricityPrice"]>>) => ({
    startAt: price.startAt,
    endAt: price.endAt,
    effectivePriceCentsPerKwh: price.effectivePriceCentsPerKwh,
    effectivePriceEurPerKwh: price.effectivePriceEurPerKwh,
    fetchedAt: price.fetchedAt,
  });
  const propertyPrice = database.getCurrentPropertyElectricityPrice(house.propertyId);
  const current = propertyPrice ? toHomePrice(propertyPrice) : null;
  if (args.from === undefined && args.to === undefined) return { current };
  const to = mcpDateTime(args, "to", new Date(Date.now() + 48 * 3_600_000));
  const from = mcpDateTime(args, "from", new Date(Date.now() - 24 * 3_600_000));
  validateMcpDateRange(from, to);
  return {
    current,
    prices: database.listPropertyElectricityPrices(house.propertyId, from, to).map(toHomePrice),
  };
}

export async function houseEnergyCost(args: Record<string, unknown>): Promise<unknown> {
  const house = requireMcpHouse(database, requiredString(args, "houseId"));
  const sensor = requireMcpHouseSensor(database, house.id, requiredString(args, "sensorId"));
  const to = mcpDateTime(args, "to", new Date());
  const from = mcpDateTime(args, "from", new Date(Date.parse(to) - 30 * 86_400_000));
  const durationMs = Date.parse(to) - Date.parse(from);
  if (durationMs <= 0 || durationMs > 366 * 86_400_000) {
    throw new Error("Energy cost range must be greater than zero and at most 366 days");
  }
  return energyCost.calculate({
    houseId: house.id,
    propertyId: house.propertyId,
    sensorId: sensor.id,
    from,
    to,
  });
}

export function outdoorTemperatureHistory(args: Record<string, unknown>): object {
  const house = requireMcpHouse(database, requiredString(args, "houseId"));
  const to = mcpDateTime(args, "to", new Date());
  const from = mcpDateTime(args, "from", new Date(Date.parse(to) - 24 * 3_600_000));
  validateMcpDateRange(from, to);
  const limit = mcpBoundedInteger(args.limit, "limit", 20_000, 1, 50_000);
  if (!house.location) return { samples: [], from, to, truncated: false };
  const samples = database.outdoorTemperatureHistory(
    house.id,
    outdoorLocationKey(house.location),
    from,
    to,
    limit + 1,
  );
  const truncated = samples.length > limit;
  return { samples: truncated ? samples.slice(-limit) : samples, from, to, truncated };
}

export function thermalIsolation(args: Record<string, unknown>): unknown {
  const house = requireMcpHouse(database, requiredString(args, "houseId"));
  const { from, to } = mcpThermalDateRange(optionalString(args, "from"), optionalString(args, "to"));
  const sensors = database.listSensors(house.id).filter((sensor) => sensor.enabled);
  if (sensors.length > 64) throw new Error("Thermal isolation comparison supports at most 64 enabled sensors");
  const boundaryPaddingMs = 2 * 3_600_000;
  const outdoorSamples = database.outdoorTemperatureHistory(
    house.id,
    outdoorLocationKey(house.location),
    new Date(Date.parse(from) - boundaryPaddingMs).toISOString(),
    new Date(Date.parse(to) + boundaryPaddingMs).toISOString(),
    50_000,
  );
  return runThermalIsolation({
    house,
    sensors,
    indoorSamplesBySensor: new Map(sensors.map((sensor) => [
      sensor.id,
      database.thermalTemperatureHistory(sensor.id, from, to, 5, 5_000),
    ])),
    outdoorSamples,
    from,
    to,
  });
}

export function backupStatus(): object {
  const { backupPath, ...backup } = dataOperations.backupStatus();
  return { ...backup, backupPathConfigured: backupPath !== null };
}

export function sensorDataGaps(args: Record<string, unknown>): unknown {
  const houseId = optionalString(args, "houseId");
  if (houseId) requireMcpHouse(database, houseId);
  const sensorId = optionalString(args, "sensorId");
  if (sensorId) requireMcpSensor(database, sensorId);
  return database.listSensorDataGaps(
    sensorId,
    mcpBoundedInteger(args.limit, "limit", 100, 1, 1_000),
  ).filter((gap) => !houseId || database.getSensor(gap.sensorId)?.houseId === houseId);
}

export const server = new Server(
  { name: "stugu-local", version: SYSTEM_VERSION },
  {
    capabilities: { tools: {} },
    instructions: [
      "This Stugu stdio MCP is a read-only inspection surface over its configured local SQLite workspace.",
      "It cannot inspect a separately running API process's in-memory connections or event bus.",
      "Create, update, delete, import, migration, sharing, synchronization, control, raw credentials, SSE streams, and binary asset downloads are intentionally excluded.",
    ].join(" "),
  },
);

export const operations = new McpOperationTracker();

export const resultOutputSchema = {
  type: "object",
  properties: { result: { oneOf: [{ type: "object" }, { type: "array" }] } },
  required: ["result"],
  additionalProperties: false,
} as const;
