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
import { confirmationProperty, floorSchema, houseLocationSchema, houseMapPlacementSchema, sensorProperties } from "./04-point-schema-to-summarize-mcp-stuguby.js";

export const mcpToolDefinitionsPart02 = [
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
        description: "Fetch provider-neutral current conditions, forecasts, and warning coverage for a located house without storing the result.",
        inputSchema: {
          type: "object",
          properties: {
            houseId: { type: "string" },
            hours: { type: "integer", minimum: 1, maximum: 240, default: 48 },
          },
          required: ["houseId"],
          additionalProperties: false,
        },
      },
  {
        name: "get_house_opening_states",
        description: "Inspect effective door, window, and vent opening states and optionally their bounded observation history.",
        inputSchema: {
          type: "object",
          properties: {
            houseId: { type: "string", minLength: 1, maxLength: 200 },
            at: { type: "string", format: "date-time" },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
            limit: { type: "integer", minimum: 1, maximum: 10_000, default: 10_000 },
          },
          required: ["houseId"],
          additionalProperties: false,
        },
      },
  {
        name: "get_house_electricity_price",
        description: "Inspect the current effective electricity price for one Home and optional bounded price history inherited from its Property.",
        inputSchema: {
          type: "object",
          properties: {
            houseId: { type: "string", minLength: 1, maxLength: 200 },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
          },
          required: ["houseId"],
          additionalProperties: false,
        },
      },
  {
        name: "get_house_energy_cost",
        description: "Calculate read-only energy consumption, price coverage, and cost for one Home energy sensor over a bounded range.",
        inputSchema: {
          type: "object",
          properties: {
            houseId: { type: "string", minLength: 1, maxLength: 200 },
            sensorId: { type: "string", minLength: 1, maxLength: 200 },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
          },
          required: ["houseId", "sensorId"],
          additionalProperties: false,
        },
      },
  {
        name: "query_outdoor_temperature_history",
        description: "Query locally retained outdoor-temperature history for a located Home.",
        inputSchema: {
          type: "object",
          properties: {
            houseId: { type: "string", minLength: 1, maxLength: 200 },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
            limit: { type: "integer", minimum: 1, maximum: 50_000, default: 20_000 },
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
        name: "get_house_thermal_isolation",
        description: "Compare the experimental thermal-isolation model across up to 64 enabled temperature sensors in one Home.",
        inputSchema: {
          type: "object",
          properties: {
            houseId: { type: "string", minLength: 1, maxLength: 200 },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
          },
          required: ["houseId"],
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
] as const;
