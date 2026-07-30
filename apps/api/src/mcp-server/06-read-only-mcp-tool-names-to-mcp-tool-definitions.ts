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
import { areaEquipmentMutableProperties, floorSchema, houseLocationSchema, houseMapPlacementSchema, propertyAreaMutableProperties } from "./04-point-schema-to-summarize-mcp-stuguby.js";
import { CHATGPT_MCP_TOOL_NAMES, isChatgptMcpProfile } from "./chatgpt-profile.js";

export const READ_ONLY_MCP_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_properties",
  "get_property",
  "get_property_electricity",
  "get_property_energy_optimization",
  "list_property_areas",
  "list_area_equipment",
  "list_property_notes",
  "list_houses",
  "get_house",
  "get_daily_analytics_findings",
  "list_stugubys",
  "get_stuguby",
  "search_locations",
  "resolve_coordinate_defaults",
  "get_house_weather",
  "get_house_opening_states",
  "get_opening_activity",
  "get_home_performance",
  "get_home_monitoring",
  "compare_calendar_periods",
  "get_house_electricity_price",
  "get_house_energy_cost",
  "get_house_energy_summary",
  "query_outdoor_temperature_history",
  "get_home_moisture_response",
  "run_thermal_simulation",
  "get_house_thermal_isolation",
  "list_sensors",
  "list_measurement_definitions",
  "get_measurement_snapshot",
  "query_measurement_history",
  "summarize_home_measurements",
  "forecast_measurement",
  "get_sensor_snapshot",
  "query_history",
  "forecast_sensor",
  "list_active_alerts",
  "list_alert_rules",
  "list_alert_events",
  "list_notification_deliveries",
  "list_action_playbooks",
  "list_action_runs",
  "list_observations",
  "list_observation_revisions",
  "list_maintenance_tasks",
  "list_maintenance_task_revisions",
  "list_static_parameters",
  "list_assets",
  "get_asset_metadata",
  "get_integration_status",
  "list_sensor_data_gaps",
  "discover_integrations",
  "get_home_assistant_setup",
  "test_home_assistant_connection",
  "get_tp_link_setup",
  "list_tp_link_devices",
  "test_tp_link_connection",
  "list_mock_scenarios",
  "get_replay_status",
  "get_backup_status",
  "get_setup_doctor",
]);

export const ACTIVE_MCP_TOOL_NAMES = isChatgptMcpProfile
  ? CHATGPT_MCP_TOOL_NAMES
  : READ_ONLY_MCP_TOOL_NAMES;

export const mcpToolDefinitionsPart01 = [
  {
        name: "list_properties",
        description: "List compact property summaries without exact map-centre coordinates or free-form descriptions.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
  {
        name: "get_property",
        description: "Get one explicitly selected Property with its description, location, and Stuguby authority/edit/sync metadata.",
        inputSchema: {
          type: "object",
          properties: { propertyId: { type: "string", minLength: 1, maxLength: 200 } },
          required: ["propertyId"],
          additionalProperties: false,
        },
      },
  {
        name: "get_property_electricity",
        description: "Inspect one Property's redacted electricity configuration, current price, and bounded price history. Endpoint query parameters are omitted.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", minLength: 1, maxLength: 200 },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
          },
          required: ["propertyId"],
          additionalProperties: false,
        },
      },
  {
        name: "get_property_energy_optimization",
        description: "Generate the advisory, read-only electricity-price and measured-load optimization report for one Property.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", minLength: 1, maxLength: 200 },
            windowHours: { type: "integer", minimum: 1, maximum: 12, default: 2 },
          },
          required: ["propertyId"],
          additionalProperties: false,
        },
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
        name: "list_property_notes",
        description: "List Property, Home, area, and equipment notes, optionally filtered to one related resource.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", minLength: 1, maxLength: 200 },
            houseId: { type: "string", minLength: 1, maxLength: 200 },
            areaId: { type: "string", minLength: 1, maxLength: 200 },
            equipmentId: { type: "string", minLength: 1, maxLength: 200 },
            limit: { type: "integer", minimum: 1, maximum: 500, default: 200 },
          },
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
        name: "get_daily_analytics_findings",
        description: "Get the latest stored daily analytics findings and worker status for one Home without triggering a new analysis.",
        inputSchema: {
          type: "object",
          properties: { houseId: { type: "string", minLength: 1, maxLength: 200 } },
          required: ["houseId"],
          additionalProperties: false,
        },
      },
  {
        name: "list_stugubys",
        description: "List compact Host/Client federation, adopted-Property, Home ownership, sharing, and sync summaries.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
  {
        name: "get_stuguby",
        description: "Inspect one Stuguby, including sanitized Host/Client membership, adopted Property state, local and shared Homes, read-only overview grants, and pending command counts. Secrets, invitation material, event payloads, and audit records are omitted.",
        inputSchema: {
          type: "object",
          properties: { stugubyId: { type: "string", minLength: 1, maxLength: 200 } },
          required: ["stugubyId"],
          additionalProperties: false,
        },
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
] as const;
