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
} from "../mcp-validation.js";
import {
  forecastMeasurement,
  MOCK_SCENARIOS,
  temperatureHumidityForecast,
} from "../services.js";
import { getHouseWeather } from "./weather-tools.js";
import { measurementSnapshot } from "./history-tools.js";
import { optionalBoolean, optionalToolString, requiredToolString } from "./arguments.js";
import { queryMeasurementHistory, querySensorHistory } from "./history-tools.js";
import { thermalSimulation } from "./thermal-tools.js";
import { assetMetadata, listMaintenanceTaskRevisions, listMaintenanceTasks, listObservationRevisions } from "./record-tools.js";
import { discoverIntegrations, homeAssistantConnectionTest, homeAssistantSetup, tpLinkConnectionTest, tpLinkSetup } from "./setup-tools.js";
import { summarizeMcpStuguby } from "./stuguby-tools.js";
import { backupStatus } from "./setup-tools.js";
import { dailyAnalyticsFindings } from "./derived-analytics-tools.js";
import { getMcpStuguby } from "./stuguby-tools.js";
import { houseElectricityPrice, houseEnergyCost, houseEnergySummary, propertyElectricity } from "./energy-tools.js";
import { houseOpeningStates, openingActivity } from "./opening-tools.js";
import { listPropertyNotes } from "./record-tools.js";
import { outdoorTemperatureHistory } from "./weather-tools.js";
import { sensorDataGaps } from "./history-tools.js";
import { thermalIsolation } from "./thermal-tools.js";
import type { ToolHandler } from "./tool-catalog.js";
import { calendarComparison, homeMonitoring, homePerformance } from "./derived-analytics-tools.js";
import { homeMoistureResponse } from "./home-moisture-response.js";
import { homeMeasurementSummary } from "./home-measurement-summary.js";
import type { McpRuntime } from "./runtime.js";

/** The handler of every MCP tool, each answering from `runtime`. */
export function createToolHandlers(runtime: McpRuntime): Record<string, ToolHandler> {
  const { database, energyOptimizer, stugubyStore, locationDiscovery, telemetryReader, dataMode, status, mock, replay, setupDoctor } = runtime;
  return {
    list_properties: () => database.listProperties().map(summarizeMcpProperty),
    get_property: (args) => {
      const propertyId = requiredToolString(args, "propertyId");
      const property = database.getProperty(propertyId);
      if (!property) throw new Error(`Unknown property: ${propertyId}`);
      return property;
    },
    get_property_electricity: (args) => propertyElectricity(runtime, args),
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
    list_property_notes: (args) => listPropertyNotes(runtime, args),
    list_houses: (args) => database.listHouses(args.propertyId === undefined ? undefined : requiredToolString(args, "propertyId")).map(summarizeMcpHouse),
    get_house: (args) => requireMcpHouse(database, requiredToolString(args, "houseId")),
    get_daily_analytics_findings: (args) => dailyAnalyticsFindings(runtime, args),
    list_stugubys: () => stugubyStore.listStugubys().map((stuguby) => summarizeMcpStuguby(runtime, stuguby)),
    get_stuguby: (args) => getMcpStuguby(runtime, args),
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
      runtime,
      requiredToolString(args, "houseId"),
      mcpBoundedInteger(args.hours, "hours", 48, 1, 240),
    ),
    get_house_opening_states: (args) => houseOpeningStates(runtime, args),
    get_opening_activity: (args) => openingActivity(runtime, args),
    get_home_performance: (args) => homePerformance(runtime, args),
    get_home_monitoring: (args) => homeMonitoring(runtime, args),
    compare_calendar_periods: (args) => calendarComparison(runtime, args),
    get_house_electricity_price: (args) => houseElectricityPrice(runtime, args),
    get_house_energy_cost: (args) => houseEnergyCost(runtime, args),
    get_house_energy_summary: (args) => houseEnergySummary(runtime, args),
    query_outdoor_temperature_history: (args) => outdoorTemperatureHistory(runtime, args),
    get_home_moisture_response: (args) => homeMoistureResponse(runtime, args),
    run_thermal_simulation: (args, signal) => thermalSimulation(runtime, args, signal),
    get_house_thermal_isolation: (args, signal) => thermalIsolation(runtime, args, signal),
    list_sensors: (args) => database.listSensors(optionalToolString(args, "houseId")),
    list_measurement_definitions: (args) => database.listMeasurementDefinitions(
      optionalBoolean(args, "includeDisabled", true),
    ),
    get_measurement_snapshot: (args) => measurementSnapshot(runtime, optionalToolString(args, "houseId")),
    query_measurement_history: (args) => queryMeasurementHistory(runtime, args),
    summarize_home_measurements: (args) => homeMeasurementSummary(runtime, args),
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
    query_history: (args) => querySensorHistory(runtime, args),
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
    list_observation_revisions: (args) => listObservationRevisions(runtime, args),
    list_maintenance_tasks: (args) => listMaintenanceTasks(runtime, args),
    list_maintenance_task_revisions: (args) => listMaintenanceTaskRevisions(runtime, args),
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
    list_sensor_data_gaps: (args) => sensorDataGaps(runtime, args),
    discover_integrations: () => discoverIntegrations(runtime),
    get_home_assistant_setup: () => homeAssistantSetup(runtime),
    test_home_assistant_connection: homeAssistantConnectionTest,
    get_tp_link_setup: () => tpLinkSetup(runtime),
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
    get_backup_status: () => backupStatus(runtime),
    get_setup_doctor: () => setupDoctor.report(),
  };
}
