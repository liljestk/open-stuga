import { ANALYTICS_AGGREGATIONS, type AnalyticsCoverageResponse, type AnalyticsQueryResponse } from "@climate-twin/contracts";
import { parseAnalyticsCoverageRequest, parseAnalyticsQueryRequest } from "../analytics/query/analytics-query.js";
import { executeAnalyticsQuery } from "../analytics/query/execute.js";
import {
  analyticsCoverageResponse,
  analyticsQueryDefinitions,
  requireAnalyticsCoverageMeasurements,
  resolveAnalyticsScopeSensors,
  type AnalyticsScopeAccess,
} from "../analytics/query/scope.js";
import type { McpRuntime } from "./runtime.js";
import { requiredToolString } from "./arguments.js";
import { requireMcpHouse } from "./validation.js";

/** MCP inspection is not limited by browser Guest grants. */
const MCP_ANALYTICS_ACCESS: AnalyticsScopeAccess = { house: () => true, sensor: () => true };

function dataMode(runtime: McpRuntime): "live" | "demo" {
  return runtime.database.isRealDataMode() ? "live" : "demo";
}

/** The house scope shared by both requests; the analytics parsers validate the rest. */
function houseScope(runtime: McpRuntime, args: Record<string, unknown>) {
  const house = requireMcpHouse(runtime.database, requiredToolString(args, "houseId"));
  return { house, scope: { kind: "house", id: house.id, ...(args.sensorIds === undefined ? {} : { entityIds: args.sensorIds }) } };
}

export async function queryAnalytics(
  runtime: McpRuntime,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AnalyticsQueryResponse> {
  const { database, telemetryReader, analyticsWorkLimiter } = runtime;
  const { house, scope } = houseScope(runtime, args);
  const request = parseAnalyticsQueryRequest({
    apiVersion: "1.0",
    dataMode: dataMode(runtime),
    scope,
    measurementIds: args.measurementIds,
    range: { start: args.from, end: args.to, timezone: args.timezone ?? house.timezone },
    resolution: args.resolution ?? "auto",
    aggregation: args.aggregation ?? "default",
    qualityFilter: { include: args.qualities ?? ["good", "estimated"] },
    ...(args.include === undefined ? {} : { include: args.include }),
    maxPointsPerSeries: args.maxPointsPerSeries ?? 200,
    requestId: `mcp-analytics-${Date.now().toString(36)}`,
  });
  const sensors = resolveAnalyticsScopeSensors(database, request, MCP_ANALYTICS_ACCESS);
  const definitions = analyticsQueryDefinitions(database, request.measurementIds);
  const expectedIntervalSeconds = database.expectedReportingIntervals(sensors.flatMap((sensor) => (
    definitions.map((definition) => ({ sensorId: sensor.id, metric: definition.id }))
  )));
  return analyticsWorkLimiter.run("analytics-query", () => executeAnalyticsQuery({
    request,
    sensors,
    definitions,
    telemetryReader,
    generatedAt: new Date().toISOString(),
    expectedIntervalSeconds,
    ...(signal ? { signal } : {}),
  }), signal);
}

export async function measurementCoverage(
  runtime: McpRuntime,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AnalyticsCoverageResponse> {
  const { database, telemetryReader, analyticsWorkLimiter } = runtime;
  const request = parseAnalyticsCoverageRequest({
    apiVersion: "1.0",
    dataMode: dataMode(runtime),
    scope: houseScope(runtime, args).scope,
    measurementIds: args.measurementIds,
    requestId: `mcp-coverage-${Date.now().toString(36)}`,
  });
  const sensors = resolveAnalyticsScopeSensors(database, request, MCP_ANALYTICS_ACCESS);
  requireAnalyticsCoverageMeasurements(database, request.measurementIds);
  const coverage = await analyticsWorkLimiter.run("analytics-coverage", () => telemetryReader.measurementCoverage({
    sensorIds: sensors.map((sensor) => sensor.id),
    metrics: request.measurementIds,
    ...(signal ? { signal } : {}),
  }), signal);
  return analyticsCoverageResponse(request, sensors, coverage);
}

const houseIdSchema = { type: "string", minLength: 1, maxLength: 200 } as const;
const sensorIdsSchema = {
  type: "array",
  minItems: 1,
  maxItems: 50,
  uniqueItems: true,
  items: { type: "string", minLength: 1, maxLength: 200 },
} as const;
const measurementIdsSchema = {
  type: "array",
  minItems: 1,
  maxItems: 8,
  uniqueItems: true,
  items: { type: "string", minLength: 1, maxLength: 200 },
} as const;

export const analyticsQueryToolDefinitions = [
  {
    name: "query_analytics",
    description: "Run the same bucketed analytics query as the Stugu charts: per-sensor series of hourly, daily, or minute buckets with the measurement's own aggregation (time-weighted means, counter deltas), summaries, quality, and provenance over up to ten years. Sensors default to the Home's enabled sensors; the range is half-open and must not end in the future.",
    inputSchema: {
      type: "object",
      properties: {
        houseId: houseIdSchema,
        measurementIds: measurementIdsSchema,
        sensorIds: sensorIdsSchema,
        from: { type: "string", format: "date-time" },
        to: { type: "string", format: "date-time" },
        timezone: { type: "string", minLength: 1, maxLength: 100, description: "IANA timezone for day buckets; defaults to the Home's timezone." },
        resolution: {
          type: "string",
          pattern: "^(auto|raw|1h|1d|[0-9]{1,4}m)$",
          default: "auto",
          description: "auto, raw, 1h, 1d, or a minute interval such as 15m (at most 1440m).",
        },
        aggregation: { enum: ANALYTICS_AGGREGATIONS, default: "default" },
        qualities: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
          items: { enum: ["good", "estimated", "stale"] },
          default: ["good", "estimated"],
        },
        include: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          uniqueItems: true,
          items: { enum: ["series", "summary", "provenance", "quality"] },
          default: ["series", "summary", "provenance", "quality"],
        },
        maxPointsPerSeries: { type: "integer", minimum: 100, maximum: 5_000, default: 200 },
      },
      required: ["houseId", "measurementIds", "from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "get_measurement_coverage",
    description: "Get the earliest and latest stored sample of each Home sensor and measurement, including archived history, to choose a query range.",
    inputSchema: {
      type: "object",
      properties: {
        houseId: houseIdSchema,
        measurementIds: measurementIdsSchema,
        sensorIds: sensorIdsSchema,
      },
      required: ["houseId", "measurementIds"],
      additionalProperties: false,
    },
  },
] as const;
