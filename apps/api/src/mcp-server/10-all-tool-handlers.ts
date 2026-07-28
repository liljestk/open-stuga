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
import { createAreaEquipment, createProperty, createPropertyArea, dataMode, database, energyOptimizer, getHouseWeather, homeAssistant, locationDiscovery, measurementSnapshot, mock, objectArguments, optionalBoolean, optionalString, replay, requiredString, setupDoctor, status, stugubyStore, telemetryReader, timeseries, tpLink, updateAreaEquipment, updatePropertyArea } from "./01-config-to-get-house-weather.js";
import { createAlertRule, createHouse, createMeasurementDefinition, createSensor, deleteHouse, deleteSensor, disableMeasurementDefinition, importMeasurements, ingestMeasurements, ingestReadings, queryMeasurementHistory, querySensorHistory, replaceHouseFloor, replaceHouseLayout, thermalSimulation, updateHouse, updateMeasurementDefinition, updateSensor } from "./02-thermal-simulation-to-create-alert-rule.js";
import { acknowledgeAlert, assetMetadata, createMaintenanceTask, createObservation, deleteAlertRule, deleteAsset, deleteMaintenanceTask, deleteObservation, deleteStaticParameter, discoverIntegrations, homeAssistantConnectionTest, homeAssistantSetup, listMaintenanceTaskRevisions, listMaintenanceTasks, listObservationRevisions, selectMockScenario, startReplay, tpLinkConnectionTest, tpLinkSetup, updateAlertRule, updateMaintenanceTask, updateObservation, uploadAsset, upsertStaticParameter } from "./03-update-alert-rule-to-start-replay.js";
import { summarizeMcpStuguby } from "./04-point-schema-to-summarize-mcp-stuguby.js";
import { backupStatus, dailyAnalyticsFindings, getMcpStuguby, houseElectricityPrice, houseEnergyCost, houseOpeningStates, listPropertyNotes, operations, outdoorTemperatureHistory, propertyElectricity, sensorDataGaps, server, thermalIsolation } from "./05-get-mcp-stuguby-to-result-output-schema.js";
import { READ_ONLY_MCP_TOOL_NAMES } from "./06-read-only-mcp-tool-names-to-mcp-tool-definitions.js";
import { ToolHandler, mcpTools } from "./09-mcp-tool-definitions-part04-to-tool-handler.js";

export const allToolHandlers: Record<string, ToolHandler> = {
  list_properties: () => database.listProperties().map(summarizeMcpProperty),
  get_property: (args) => {
    const propertyId = requiredString(args, "propertyId");
    const property = database.getProperty(propertyId);
    if (!property) throw new Error(`Unknown property: ${propertyId}`);
    return property;
  },
  get_property_electricity: propertyElectricity,
  get_property_energy_optimization: (args) => energyOptimizer.report(
    requiredString(args, "propertyId"),
    mcpBoundedInteger(args.windowHours, "windowHours", 2, 1, 12),
  ),
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
  list_property_notes: listPropertyNotes,
  list_houses: (args) => database.listHouses(args.propertyId === undefined ? undefined : requiredString(args, "propertyId")).map(summarizeMcpHouse),
  get_house: (args) => requireMcpHouse(database, requiredString(args, "houseId")),
  get_daily_analytics_findings: dailyAnalyticsFindings,
  list_stugubys: () => stugubyStore.listStugubys().map(summarizeMcpStuguby),
  get_stuguby: getMcpStuguby,
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
  get_house_weather: (args) => getHouseWeather(
    requiredString(args, "houseId"),
    mcpBoundedInteger(args.hours, "hours", 48, 1, 240),
  ),
  get_house_opening_states: houseOpeningStates,
  get_house_electricity_price: houseElectricityPrice,
  get_house_energy_cost: houseEnergyCost,
  query_outdoor_temperature_history: outdoorTemperatureHistory,
  run_thermal_simulation: thermalSimulation,
  get_house_thermal_isolation: thermalIsolation,
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
    return forecastMeasurement(
      database,
      sensorId,
      metric,
      mcpBoundedInteger(args.hours, "hours", 12, 1, 168),
      telemetryReader,
    );
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
    return forecast(
      database,
      sensorId,
      mcpBoundedInteger(args.hours, "hours", 12, 1, 168),
      telemetryReader,
    );
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
  list_notification_deliveries: (args) => database.listNotificationDeliveries(
    mcpBoundedInteger(args.limit, "limit", 200, 1, 500),
  ),
  list_action_playbooks: (args) => database.listActionPlaybooks(
    optionalString(args, "metric"),
    optionalBoolean(args, "enabledOnly", false),
  ),
  list_action_runs: (args) => database.listActionRuns({
    ...(args.houseId === undefined ? {} : { houseId: requiredString(args, "houseId") }),
    ...(args.sensorId === undefined ? {} : { sensorId: requiredString(args, "sensorId") }),
    ...(args.alertEventId === undefined ? {} : { alertEventId: requiredString(args, "alertEventId") }),
    activeOnly: optionalBoolean(args, "activeOnly", false),
    limit: mcpBoundedInteger(args.limit, "limit", 500, 1, 500),
  }),
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
  list_sensor_data_gaps: sensorDataGaps,
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
  get_backup_status: backupStatus,
  get_setup_doctor: () => setupDoctor.report(),
  start_replay: startReplay,
  stop_replay: () => ({ available: false, replay: replay.stop(), runtimeScope: "mcp-process" }),
};

export const toolHandlers = Object.fromEntries(
  Object.entries(allToolHandlers).filter(([name]) => READ_ONLY_MCP_TOOL_NAMES.has(name)),
) as Record<string, ToolHandler>;

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

export const transport = new StdioServerTransport();

await server.connect(transport);

export let resourcesClosed = false;

export let shutdownPromise: Promise<void> | null = null;

export function closeResources(): void {
  if (resourcesClosed) return;
  resourcesClosed = true;
  mock.stop();
  replay.stop();
  homeAssistant.stop();
  tpLink.stop();
  database.close();
}

export function close(): Promise<void> {
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
      try {
        await timeseries?.close();
      } finally {
        closeResources();
      }
    }
  })();
  return shutdownPromise;
}

export function requestShutdown(): void {
  void close().catch(() => {
    // Keep credentials and request contents out of the stdio protocol logs.
    console.error("Stugu MCP shutdown failed");
    process.exitCode = 1;
  });
}

process.once("SIGINT", requestShutdown);

process.once("SIGTERM", requestShutdown);

process.stdin.once("end", requestShutdown);
