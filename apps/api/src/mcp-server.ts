import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ManualObservation, Reading } from "@climate-twin/contracts";
import { loadConfig } from "./config.js";
import { ClimateDatabase } from "./db.js";
import { mcpIsoDate, requireMcpMeasurementTarget, requireMcpSensor, validateMcpDateRange } from "./mcp-validation.js";
import { forecast, forecastMeasurement } from "./services.js";

const config = loadConfig();
const database = new ClimateDatabase(config.databasePath);

function objectArguments(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value) throw new Error(`${key} is required`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value) throw new Error(`${key} must be a non-empty string`);
  return value;
}

const server = new Server(
  { name: "climate-twin", version: "2.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "list_houses",
      description: "List configured houses and their floor layouts.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "list_sensors",
      description: "Discover configured sensors, optionally scoped to one house.",
      inputSchema: { type: "object", properties: { houseId: { type: "string" } }, additionalProperties: false },
    },
    {
      name: "list_measurement_definitions",
      description: "List the registry of built-in and custom measurement definitions, units, ranges, and capabilities.",
      inputSchema: { type: "object", properties: { includeDisabled: { type: "boolean" } }, additionalProperties: false },
    },
    {
      name: "query_measurement_history",
      description: "Query independently timestamped samples for any registered metric.",
      inputSchema: {
        type: "object",
        properties: { sensorId: { type: "string" }, metric: { type: "string" }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, limit: { type: "integer", minimum: 1, maximum: 10000 } },
        required: ["sensorId", "metric", "from", "to"], additionalProperties: false,
      },
    },
    {
      name: "forecast_measurement",
      description: "Forecast one registered metric when its definition explicitly enables forecasting.",
      inputSchema: {
        type: "object",
        properties: { sensorId: { type: "string" }, metric: { type: "string" }, hours: { type: "integer", minimum: 1, maximum: 168 } },
        required: ["sensorId", "metric"], additionalProperties: false,
      },
    },
    {
      name: "get_sensor_snapshot",
      description: "Get one sensor, its position, and its latest temperature/humidity reading.",
      inputSchema: { type: "object", properties: { sensorId: { type: "string" } }, required: ["sensorId"], additionalProperties: false },
    },
    {
      name: "query_history",
      description: "Query durable sensor history over an ISO date-time range.",
      inputSchema: {
        type: "object",
        properties: { sensorId: { type: "string" }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, limit: { type: "integer", minimum: 1, maximum: 10000 } },
        required: ["sensorId", "from", "to"], additionalProperties: false,
      },
    },
    {
      name: "forecast_sensor",
      description: "Return a bounded linear baseline forecast and confidence bands for a sensor.",
      inputSchema: { type: "object", properties: { sensorId: { type: "string" }, hours: { type: "integer", minimum: 1, maximum: 168 } }, required: ["sensorId"], additionalProperties: false },
    },
    {
      name: "list_active_alerts",
      description: "List unresolved climate alert events.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "list_observations",
      description: "List manual leak, condensation, mould, ventilation, maintenance, and note observations.",
      inputSchema: { type: "object", properties: { houseId: { type: "string" } }, additionalProperties: false },
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
          houseId: { type: "string" }, floorId: { type: "string" }, sensorId: { type: ["string", "null"] },
          kind: { enum: ["leak", "condensation", "mould", "ventilation", "maintenance", "note"] },
          severity: { enum: ["info", "warning", "critical"] }, note: { type: "string" },
          x: { type: ["number", "null"] }, y: { type: ["number", "null"] }, occurredAt: { type: "string", format: "date-time" },
        },
        required: ["houseId", "floorId", "kind", "severity", "note"], additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, (request) => {
  const args = objectArguments(request.params.arguments);
  let result: unknown;
  switch (request.params.name) {
    case "list_houses":
      result = database.listHouses();
      break;
    case "list_sensors":
      result = database.listSensors(optionalString(args, "houseId"));
      break;
    case "list_measurement_definitions":
      result = database.listMeasurementDefinitions(args.includeDisabled !== false);
      break;
    case "query_measurement_history": {
      const sensorId = requiredString(args, "sensorId");
      const metric = requiredString(args, "metric");
      requireMcpMeasurementTarget(database, sensorId, metric);
      const from = mcpIsoDate(requiredString(args, "from"), "from");
      const to = mcpIsoDate(requiredString(args, "to"), "to");
      validateMcpDateRange(from, to);
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(10_000, Math.floor(args.limit))) : 2_000;
      result = database.measurementHistory(sensorId, metric, from, to, limit);
      break;
    }
    case "forecast_measurement": {
      const sensorId = requiredString(args, "sensorId");
      const metric = requiredString(args, "metric");
      requireMcpMeasurementTarget(database, sensorId, metric);
      const hours = typeof args.hours === "number" ? Math.max(1, Math.min(168, Math.floor(args.hours))) : 12;
      result = forecastMeasurement(database, sensorId, metric, hours);
      break;
    }
    case "get_sensor_snapshot": {
      const sensorId = requiredString(args, "sensorId");
      const sensor = database.getSensor(sensorId);
      if (!sensor) throw new Error("Sensor not found");
      result = { ...sensor, reading: database.getLatestReading(sensorId) };
      break;
    }
    case "query_history": {
      const sensorId = requiredString(args, "sensorId");
      requireMcpSensor(database, sensorId);
      const from = mcpIsoDate(requiredString(args, "from"), "from");
      const to = mcpIsoDate(requiredString(args, "to"), "to");
      validateMcpDateRange(from, to);
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(10_000, Math.floor(args.limit))) : 2_000;
      result = database.history([sensorId], from, to, limit);
      break;
    }
    case "forecast_sensor": {
      const sensorId = requiredString(args, "sensorId");
      requireMcpSensor(database, sensorId);
      const hours = typeof args.hours === "number" ? Math.max(1, Math.min(168, Math.floor(args.hours))) : 12;
      result = forecast(database, sensorId, hours);
      break;
    }
    case "list_active_alerts":
      result = database.listAlertEvents(200, true);
      break;
    case "list_observations":
      result = database.listObservations(optionalString(args, "houseId"));
      break;
    case "list_static_parameters":
      result = database.listParameters(optionalString(args, "houseId"));
      break;
    case "create_observation": {
      const kind = requiredString(args, "kind") as ManualObservation["kind"];
      const severity = requiredString(args, "severity") as ManualObservation["severity"];
      result = database.createObservation({
        houseId: requiredString(args, "houseId"),
        floorId: requiredString(args, "floorId"),
        sensorId: typeof args.sensorId === "string" ? args.sensorId : null,
        kind,
        severity,
        note: requiredString(args, "note"),
        x: typeof args.x === "number" ? args.x : null,
        y: typeof args.y === "number" ? args.y : null,
        occurredAt: typeof args.occurredAt === "string" ? args.occurredAt : new Date().toISOString(),
      });
      break;
    }
    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);

function close(): void {
  database.close();
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
