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
import { confirmationProperty, maintenanceTaskCreateProperties, maintenanceTaskPatchProperties, observationCreateProperties, observationPatchProperties } from "./04-point-schema-to-summarize-mcp-stuguby.js";
import { resultOutputSchema, server } from "./05-get-mcp-stuguby-to-result-output-schema.js";
import { ACTIVE_MCP_TOOL_NAMES, mcpToolDefinitionsPart01 } from "./06-read-only-mcp-tool-names-to-mcp-tool-definitions.js";
import { mcpToolDefinitionsPart02 } from "./07-mcp-tool-definitions-part02.js";
import { mcpToolDefinitionsPart03 } from "./08-mcp-tool-definitions-part03.js";
import { derivedAnalyticsToolDefinitions } from "./11-derived-analytics-tools.js";
import { isChatgptMcpProfile, presentationForChatgptTool } from "./chatgpt-profile.js";

export const mcpToolDefinitionsPart04 = [
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
        name: "list_sensor_data_gaps",
        description: "List detected sensor-data gaps and recovery state, optionally filtered by Home or sensor.",
        inputSchema: {
          type: "object",
          properties: {
            houseId: { type: "string", minLength: 1, maxLength: 200 },
            sensorId: { type: "string", minLength: 1, maxLength: 200 },
            limit: { type: "integer", minimum: 1, maximum: 1_000, default: 100 },
          },
          additionalProperties: false,
        },
      },
  {
        name: "discover_integrations",
        description: "Run best-effort LAN discovery for Home Assistant and supported TP-Link hubs or energy devices.",
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
] as const;

export const mcpToolDefinitionsPart05 = [
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
        name: "get_backup_status",
        description: "Inspect backup scheduler and verification status without exposing a local backup path or requesting a backup.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
  {
        name: "get_setup_doctor",
        description: "Run read-only SQLite integrity, sensor coverage, integration, notification, backup, and restore-drill readiness checks.",
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
] as const;

export const mcpToolDefinitions = [
  ...mcpToolDefinitionsPart01,
  ...mcpToolDefinitionsPart02,
  ...mcpToolDefinitionsPart03,
  ...mcpToolDefinitionsPart04,
  ...mcpToolDefinitionsPart05,
  ...derivedAnalyticsToolDefinitions,
] as const;

export const mcpTools = mcpToolDefinitions.filter((tool) => ACTIVE_MCP_TOOL_NAMES.has(tool.name)).map((tool) => ({
    ...tool,
    ...(isChatgptMcpProfile ? presentationForChatgptTool(tool.name) : {}),
    outputSchema: resultOutputSchema,
    annotations: {
      ...mcpToolAnnotations(tool.name),
    },
  }));

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: mcpTools }));

export type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;
