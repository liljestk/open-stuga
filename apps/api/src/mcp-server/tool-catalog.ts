import type { McpToolHandler } from "../mcp-lifecycle.js";
import { mcpToolAnnotations } from "../mcp-validation.js";
import { type McpProfile, CHATGPT_MCP_TOOL_NAMES, presentationForChatgptTool } from "./chatgpt-profile.js";
import { propertyToolDefinitions } from "./property-tool-definitions.js";
import { homeToolDefinitions } from "./home-tool-definitions.js";
import { telemetryToolDefinitions } from "./telemetry-tool-definitions.js";
import { systemToolDefinitions, workspaceToolDefinitions } from "./workspace-tool-definitions.js";
import { derivedAnalyticsToolDefinitions } from "./derived-analytics-tools.js";

export const resultOutputSchema = {
  type: "object",
  properties: { result: { oneOf: [{ type: "object" }, { type: "array" }] } },
  required: ["result"],
  additionalProperties: false,
} as const;

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

export function activeMcpToolNames(profile: McpProfile): ReadonlySet<string> {
  return profile === "chatgpt" ? CHATGPT_MCP_TOOL_NAMES : READ_ONLY_MCP_TOOL_NAMES;
}

export const mcpToolDefinitions = [
  ...propertyToolDefinitions,
  ...homeToolDefinitions,
  ...telemetryToolDefinitions,
  ...workspaceToolDefinitions,
  ...systemToolDefinitions,
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
