import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { runMcpToolRequest } from "../mcp-lifecycle.js";
import {
  mcpBoundedInteger,
  mcpBoundedNumber,
  mcpLanguage,
  mcpLocationQuery,
  requireMcpHouse,
  requireMcpMeasurementTarget,
  requireMcpSensor,
  summarizeMcpAreaEquipment,
  summarizeMcpHouse,
  summarizeMcpProperty,
  summarizeMcpPropertyArea,
  validateMcpToolRegistry,
} from "../mcp-validation.js";
import {
  forecastMeasurement,
  MOCK_SCENARIOS,
  temperatureHumidityForecast,
} from "../services.js";
import { dataMode, database, energyOptimizer, getHouseWeather, homeAssistant, locationDiscovery, measurementSnapshot, mock, objectArguments, optionalBoolean, optionalToolString, replay, requiredToolString, setupDoctor, status, stugubyStore, telemetryReader, timeseries, tpLink } from "./01-config-to-get-house-weather.js";
import { queryMeasurementHistory, querySensorHistory, thermalSimulation } from "./02-thermal-simulation-to-create-alert-rule.js";
import { assetMetadata, discoverIntegrations, homeAssistantConnectionTest, homeAssistantSetup, listMaintenanceTaskRevisions, listMaintenanceTasks, listObservationRevisions, tpLinkConnectionTest, tpLinkSetup } from "./03-update-alert-rule-to-start-replay.js";
import { summarizeMcpStuguby } from "./04-point-schema-to-summarize-mcp-stuguby.js";
import { backupStatus, createMcpServer, dailyAnalyticsFindings, getMcpStuguby, houseElectricityPrice, houseEnergyCost, houseEnergySummary, houseOpeningStates, listPropertyNotes, openingActivity, operations, outdoorTemperatureHistory, propertyElectricity, sensorDataGaps, thermalIsolation } from "./05-get-mcp-stuguby-to-result-output-schema.js";
import { activeMcpToolNames } from "./06-read-only-mcp-tool-names-to-mcp-tool-definitions.js";
import { ToolHandler, buildMcpTools } from "./09-mcp-tool-definitions-part04-to-tool-handler.js";
import type { McpProfile } from "./chatgpt-profile.js";
import {
  calendarComparison,
  homeMonitoring,
  homePerformance,
} from "./11-derived-analytics-tools.js";
import { homeMoistureResponse } from "./home-moisture-response.js";
import { homeMeasurementSummary } from "./home-measurement-summary.js";

export const allToolHandlers: Record<string, ToolHandler> = {
  list_properties: () => database.listProperties().map(summarizeMcpProperty),
  get_property: (args) => {
    const propertyId = requiredToolString(args, "propertyId");
    const property = database.getProperty(propertyId);
    if (!property) throw new Error(`Unknown property: ${propertyId}`);
    return property;
  },
  get_property_electricity: propertyElectricity,
  get_property_energy_optimization: (args) => energyOptimizer.report(
    requiredToolString(args, "propertyId"),
    mcpBoundedInteger(args.windowHours, "windowHours", 2, 1, 12),
  ),
  list_property_areas: (args) => database.listPropertyAreas(optionalToolString(args, "propertyId"))
    .map(summarizeMcpPropertyArea),
  list_area_equipment: (args) => database.listAreaEquipment({
    ...(args.propertyId === undefined ? {} : { propertyId: requiredToolString(args, "propertyId") }),
    ...(args.areaId === undefined ? {} : { areaId: requiredToolString(args, "areaId") }),
  }).map(summarizeMcpAreaEquipment),
  list_property_notes: listPropertyNotes,
  list_houses: (args) => database.listHouses(args.propertyId === undefined ? undefined : requiredToolString(args, "propertyId")).map(summarizeMcpHouse),
  get_house: (args) => requireMcpHouse(database, requiredToolString(args, "houseId")),
  get_daily_analytics_findings: dailyAnalyticsFindings,
  list_stugubys: () => stugubyStore.listStugubys().map(summarizeMcpStuguby),
  get_stuguby: getMcpStuguby,
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
    requiredToolString(args, "houseId"),
    mcpBoundedInteger(args.hours, "hours", 48, 1, 240),
  ),
  get_house_opening_states: houseOpeningStates,
  get_opening_activity: openingActivity,
  get_home_performance: homePerformance,
  get_home_monitoring: homeMonitoring,
  compare_calendar_periods: calendarComparison,
  get_house_electricity_price: houseElectricityPrice,
  get_house_energy_cost: houseEnergyCost,
  get_house_energy_summary: houseEnergySummary,
  query_outdoor_temperature_history: outdoorTemperatureHistory,
  get_home_moisture_response: homeMoistureResponse,
  run_thermal_simulation: thermalSimulation,
  get_house_thermal_isolation: thermalIsolation,
  list_sensors: (args) => database.listSensors(optionalToolString(args, "houseId")),
  list_measurement_definitions: (args) => database.listMeasurementDefinitions(
    optionalBoolean(args, "includeDisabled", true),
  ),
  get_measurement_snapshot: (args) => measurementSnapshot(optionalToolString(args, "houseId")),
  query_measurement_history: queryMeasurementHistory,
  summarize_home_measurements: homeMeasurementSummary,
  forecast_measurement: (args) => {
    const sensorId = requiredToolString(args, "sensorId");
    const metric = requiredToolString(args, "metric");
    requireMcpMeasurementTarget(database, sensorId, metric);
    const hours = mcpBoundedInteger(args.hours, "hours", 12, 1, 168);
    return forecastMeasurement(database, { sensorId, metric, hours, telemetryReader }).then((result) => result.points);
  },
  get_sensor_snapshot: (args) => {
    const sensorId = requiredToolString(args, "sensorId");
    const sensor = database.getSensor(sensorId);
    if (!sensor) throw new Error(`Unknown sensor: ${sensorId}`);
    return { ...sensor, reading: database.getLatestReading(sensorId) };
  },
  query_history: querySensorHistory,
  forecast_sensor: (args) => {
    const sensorId = requiredToolString(args, "sensorId");
    requireMcpSensor(database, sensorId);
    const hours = mcpBoundedInteger(args.hours, "hours", 12, 1, 168);
    return temperatureHumidityForecast(database, { sensorId, hours, telemetryReader });
  },
  list_active_alerts: () => database.listAlertEvents(200, true),
  list_alert_rules: () => database.listAlertRules(),
  list_alert_events: (args) => database.listAlertEvents(
    mcpBoundedInteger(args.limit, "limit", 200, 1, 1_000),
    optionalBoolean(args, "activeOnly", false),
  ),
  list_notification_deliveries: (args) => database.listNotificationDeliveries(
    mcpBoundedInteger(args.limit, "limit", 200, 1, 500),
  ),
  list_action_playbooks: (args) => database.listActionPlaybooks(
    optionalToolString(args, "metric"),
    optionalBoolean(args, "enabledOnly", false),
  ),
  list_action_runs: (args) => database.listActionRuns({
    ...(args.houseId === undefined ? {} : { houseId: requiredToolString(args, "houseId") }),
    ...(args.sensorId === undefined ? {} : { sensorId: requiredToolString(args, "sensorId") }),
    ...(args.alertEventId === undefined ? {} : { alertEventId: requiredToolString(args, "alertEventId") }),
    activeOnly: optionalBoolean(args, "activeOnly", false),
    limit: mcpBoundedInteger(args.limit, "limit", 500, 1, 500),
  }),
  list_observations: (args) => database.listObservations(optionalToolString(args, "houseId")),
  list_observation_revisions: listObservationRevisions,
  list_maintenance_tasks: listMaintenanceTasks,
  list_maintenance_task_revisions: listMaintenanceTaskRevisions,
  list_static_parameters: (args) => database.listParameters(optionalToolString(args, "houseId")),
  list_assets: (args) => database.listAssets(optionalToolString(args, "houseId")),
  get_asset_metadata: (args) => {
    const assetId = requiredToolString(args, "assetId");
    const asset = database.getAsset(assetId);
    if (!asset) throw new Error(`Unknown asset: ${assetId}`);
    return assetMetadata(asset);
  },
  get_integration_status: () => {
    dataMode.synchronize();
    return {
      runtimeScope: "mcp-process",
      liveConnectionsAvailable: false,
      status: structuredClone(status.value),
      note: "This isolated MCP process does not start live integration adapters and cannot inspect the API process's connection state.",
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
    note: "Live TP-Link inventory belongs to the long-running API process and is unavailable in the isolated MCP process.",
  }),
  test_tp_link_connection: tpLinkConnectionTest,
  list_mock_scenarios: () => {
    dataMode.synchronize();
    return { scenarios: MOCK_SCENARIOS, active: mock.scenario, enabled: status.value.mock.enabled };
  },
  get_replay_status: () => ({ available: false, replay: { ...replay.state, count: 0 }, runtimeScope: "mcp-process" }),
  get_backup_status: backupStatus,
  get_setup_doctor: () => setupDoctor.report(),
};

/** Each profile's listed tools and the handlers that answer them, checked against each other at load. */
const profiles = new Map((["local", "chatgpt"] as const).map((profile) => {
  const active = activeMcpToolNames(profile);
  const tools = buildMcpTools(profile);
  const handlers = Object.fromEntries(
    Object.entries(allToolHandlers).filter(([name]) => active.has(name)),
  ) as Record<string, ToolHandler>;
  validateMcpToolRegistry(tools.map((tool) => tool.name), Object.keys(handlers));
  return [profile, { tools, handlers }];
}));

export type ConnectedMcpServer = ReturnType<typeof createMcpServer>;
export type McpTransport = Parameters<ConnectedMcpServer["connect"]>[0];

const connectedServers = new Set<ConnectedMcpServer>();

function registerMcpRequestHandlers(server: ConnectedMcpServer, profile: McpProfile): void {
  const { tools, handlers } = profiles.get(profile)!;
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await runMcpToolRequest(
      operations,
      handlers,
      request.params.name,
      objectArguments(request.params.arguments),
      extra.signal,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: { result },
    };
  });
}

export async function connectMcpTransport(transport: McpTransport, profile: McpProfile = "local"): Promise<ConnectedMcpServer> {
  const server = createMcpServer(profile);
  registerMcpRequestHandlers(server, profile);
  server.onclose = () => connectedServers.delete(server);
  connectedServers.add(server);
  try {
    await server.connect(transport);
    return server;
  } catch (error) {
    connectedServers.delete(server);
    await server.close().catch(() => undefined);
    throw error;
  }
}

export async function disconnectMcpServer(server: ConnectedMcpServer): Promise<void> {
  if (!connectedServers.delete(server)) return;
  await server.close();
}

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
      await Promise.all([...connectedServers].map((server) => server.close()));
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
    // Keep credentials and request contents out of protocol logs.
    console.error("Stugu MCP shutdown failed");
    process.exitCode = 1;
  });
}
