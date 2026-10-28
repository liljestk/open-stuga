import type { McpToolHandler } from "../mcp-lifecycle.js";
import {
  mcpToolAnnotations,
} from "../mcp-validation.js";

import { resultOutputSchema } from "./05-get-mcp-stuguby-to-result-output-schema.js";
import { activeMcpToolNames, mcpToolDefinitionsPart01 } from "./06-read-only-mcp-tool-names-to-mcp-tool-definitions.js";
import { mcpToolDefinitionsPart02 } from "./07-mcp-tool-definitions-part02.js";
import { mcpToolDefinitionsPart03 } from "./08-mcp-tool-definitions-part03.js";
import { derivedAnalyticsToolDefinitions } from "./11-derived-analytics-tools.js";
import { presentationForChatgptTool, type McpProfile } from "./chatgpt-profile.js";

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
        description: "Get direct H100/H200/H500 setup, mapping, and real-data-mode guidance without secrets.",
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
] as const;

export const mcpToolDefinitions = [
  ...mcpToolDefinitionsPart01,
  ...mcpToolDefinitionsPart02,
  ...mcpToolDefinitionsPart03,
  ...mcpToolDefinitionsPart04,
  ...mcpToolDefinitionsPart05,
  ...derivedAnalyticsToolDefinitions,
] as const;

/** The tools a server with this profile lists, with the ChatGPT app's titles when it is that profile. */
export function buildMcpTools(profile: McpProfile) {
  const active = activeMcpToolNames(profile);
  return mcpToolDefinitions.filter((tool) => active.has(tool.name)).map((tool) => ({
    ...tool,
    ...(profile === "chatgpt" ? presentationForChatgptTool(tool.name) : {}),
    outputSchema: resultOutputSchema,
    annotations: {
      ...mcpToolAnnotations(tool.name),
    },
  }));
}

export type ToolHandler = McpToolHandler;
