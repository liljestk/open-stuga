import type { HeatPumpState } from "@climate-twin/contracts";
import { readHeatPumpStateHistory } from "../heat-pump-state.js";
import type { McpRuntime } from "./runtime.js";
import { optionalToolString, requiredToolString } from "./arguments.js";
import { mcpBoundedInteger, mcpIsoDate, requireMcpHouse, validateMcpDateRange } from "./validation.js";

/** Connection IDs still configured, optionally in one Home; a removed connection's last state is not current. */
function configuredConnectionIds(runtime: McpRuntime, houseId?: string): Set<string> {
  return new Set((runtime.config.greeConnections ?? [])
    .filter((connection) => !houseId || connection.houseId === houseId)
    .map((connection) => connection.id));
}

export function listHeatPumpStates(runtime: McpRuntime, args: Record<string, unknown>): { states: HeatPumpState[] } {
  const houseId = optionalToolString(args, "houseId");
  if (houseId) requireMcpHouse(runtime.database, houseId);
  const configured = configuredConnectionIds(runtime, houseId);
  return {
    states: runtime.heatPumpStates.current(houseId).filter((state) => configured.has(state.connectionId)),
  };
}

export async function heatPumpHistory(runtime: McpRuntime, args: Record<string, unknown>): Promise<{ states: HeatPumpState[] }> {
  const connectionId = requiredToolString(args, "connectionId");
  if (!runtime.heatPumpStates.current().some((state) => state.connectionId === connectionId)) {
    throw new Error(`Unknown heat pump: ${connectionId}`);
  }
  const from = args.from === undefined ? undefined : mcpIsoDate(requiredToolString(args, "from"), "from");
  const to = args.to === undefined ? undefined : mcpIsoDate(requiredToolString(args, "to"), "to");
  if (from && to) validateMcpDateRange(from, to);
  const history = await readHeatPumpStateHistory({
    store: runtime.heatPumpStates,
    timeseries: runtime.timeseries,
    retention: { timeseriesEnabled: Boolean(runtime.config.timeseriesEnabled), retentionDays: runtime.config.retentionDays },
    connectionId,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit: mcpBoundedInteger(args.limit, "limit", 250, 1, 1_000),
  });
  if (!history.complete) throw new Error("Complete heat-pump history is temporarily unavailable");
  return { states: history.states };
}

export const heatPumpToolDefinitions = [
  {
    name: "list_heat_pump_states",
    description: "List the latest stored state of each configured heat pump or air conditioner: power, mode, target and room temperature, humidity, fan, compressor activity, and availability. Connection credentials are never included.",
    inputSchema: {
      type: "object",
      properties: { houseId: { type: "string", minLength: 1, maxLength: 200 } },
      additionalProperties: false,
    },
  },
  {
    name: "query_heat_pump_history",
    description: "List one heat pump's recorded states, newest first, merging local history with the telemetry archive.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: { type: "string", minLength: 1, maxLength: 200 },
        from: { type: "string", format: "date-time" },
        to: { type: "string", format: "date-time" },
        limit: { type: "integer", minimum: 1, maximum: 1_000, default: 250 },
      },
      required: ["connectionId"],
      additionalProperties: false,
    },
  },
] as const;
