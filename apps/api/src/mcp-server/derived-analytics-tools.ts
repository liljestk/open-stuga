import { ANALYTICS_AGGREGATIONS, type AnalyticsAggregation, type AnalyticsSampleQuality, type CalendarComparisonRequest } from "@climate-twin/contracts";
import { requireMcpHouse, requireMcpHouseSensor } from "./validation.js";
import { DAILY_ANALYTICS_ALGORITHM_VERSION } from "../daily-analytics-findings.js";
import { configuredHeatPumpConnectionIds } from "../analytics/heat-pump-evidence.js";
import type { McpRuntime } from "./runtime.js";
import { compareCalendarPeriods } from "../analytics/calendar-comparison/service.js";
import { getHomePerformance } from "../analytics/home-performance/service.js";
import { getHomeMonitoringCollection, getHomeMonitoringDetail, loadHomeMonitoringHistory } from "../analytics/home-monitoring/service.js";
import { objectArguments, optionalToolString, requiredToolString } from "./arguments.js";

export function dailyAnalyticsFindings(runtime: McpRuntime, args: Record<string, unknown>): object {
  const { database } = runtime;
  const house = requireMcpHouse(database, requiredToolString(args, "houseId"));
  const dataMode = database.isRealDataMode() ? "live" : "demo";
  const stored = database.dailyAnalyticsFindings(house.id, dataMode);
  const staleAlgorithm = Boolean(
    stored?.snapshot
    && stored.snapshot.algorithmVersion !== DAILY_ANALYTICS_ALGORITHM_VERSION,
  );
  return {
    snapshot: stored?.snapshot ?? null,
    status: {
      state: stored?.lastError
        ? "failed"
        : staleAlgorithm
          ? "stale-algorithm"
          : stored?.snapshot
            ? "ready"
            : "pending",
      lastAttemptAt: stored?.lastAttemptAt ?? null,
      lastError: stored?.lastError ?? null,
      ...(staleAlgorithm && stored?.snapshot
        ? {
            expectedAlgorithmVersion: DAILY_ANALYTICS_ALGORITHM_VERSION,
            actualAlgorithmVersion: stored.snapshot.algorithmVersion,
          }
        : {}),
    },
  };
}

const aggregations = new Set<AnalyticsAggregation>([
  "default",
  "mean",
  "sum",
  "delta",
  "last",
  "time_weighted_mean",
  "min",
  "max",
]);

const units = new Set(["day", "week", "month", "year", "decade"]);

const qualities = new Set<AnalyticsSampleQuality>(["good", "estimated", "stale"]);

function stringList(
  value: unknown,
  field: string,
  maximum: number,
  fallback?: string[],
): string[] {
  if (value === undefined && fallback) return fallback;
  if (!Array.isArray(value)
    || value.length === 0
    || value.length > maximum
    || value.some((item) => typeof item !== "string"
      || item.trim().length === 0
      || item.length > 200)) {
    throw new Error(`${field} must contain between 1 and ${maximum} identifiers`);
  }
  const result = [...new Set(value.map((item) => (item as string).trim()))];
  if (result.length !== value.length) throw new Error(`${field} must not contain duplicates`);
  return result;
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function monitoringContext(runtime: McpRuntime, evaluatedAt: string) {
  const { dataMode, database, status } = runtime;
  dataMode.synchronize();
  status.refreshDataMode();
  return {
    database,
    latestMeasurements: (houseId: string) => database.latestMeasurementSamples(houseId),
    integrationStatus: () => structuredClone(status.value),
    latestWeather: () => null,
    dataMode: database.isRealDataMode() ? "live" as const : "demo" as const,
    evaluatedAt,
  };
}

export async function homePerformance(runtime: McpRuntime, args: Record<string, unknown>) {
  const { config, database, telemetryReader } = runtime;
  const house = requireMcpHouse(database, requiredToolString(args, "houseId"));
  const evaluatedAt = new Date().toISOString();
  return getHomePerformance({
    house,
    sensors: database.listSensors(house.id).filter((sensor) => sensor.enabled),
    definitions: database.listMeasurementDefinitions(false),
    dataMode: database.isRealDataMode() ? "live" : "demo",
    database,
    telemetryReader,
    heatPumpConnectionIds: configuredHeatPumpConnectionIds(config.greeConnections, house.id),
    evaluatedAt,
  });
}

export async function homeMonitoring(runtime: McpRuntime, args: Record<string, unknown>) {
  const { database, telemetryReader } = runtime;
  const evaluatedAt = new Date().toISOString();
  const context = monitoringContext(runtime, evaluatedAt);
  const houseId = optionalToolString(args, "houseId");
  if (houseId) {
    const house = requireMcpHouse(database, houseId);
    const scope = {
      house,
      sensors: database.listSensors(house.id).filter((sensor) => sensor.enabled),
    };
    const measurementHistory = await loadHomeMonitoringHistory({
      database,
      telemetryReader,
      scope,
      evaluatedAt,
    });
    return getHomeMonitoringDetail({ ...context, measurementHistory }, scope);
  }
  return getHomeMonitoringCollection(
    context,
    database.listHouses().map((house) => ({
      house,
      sensors: database.listSensors(house.id).filter((sensor) => sensor.enabled),
    })),
  );
}

export async function calendarComparison(runtime: McpRuntime, args: Record<string, unknown>) {
  const { database, telemetryReader } = runtime;
  const house = requireMcpHouse(database, requiredToolString(args, "houseId"));
  const sensorIds = stringList(args.sensorIds, "sensorIds", 50);
  const sensors = sensorIds.map((sensorId) => (
    requireMcpHouseSensor(database, house.id, sensorId)
  ));
  const measurementId = requiredToolString(args, "measurementId");
  const definition = database.getMeasurementDefinition(measurementId);
  if (!definition || !definition.enabled) {
    throw new Error(`Unknown or disabled measurement: ${measurementId}`);
  }
  const unit = requiredToolString(args, "unit");
  if (!units.has(unit)) throw new Error("unit must be day, week, month, year, or decade");
  const anchor = objectArguments(args.anchor);
  const aggregation = args.aggregation ?? "default";
  if (!aggregations.has(aggregation as AnalyticsAggregation)) {
    throw new Error("aggregation is not supported");
  }
  const includedQualities = stringList(
    args.qualities,
    "qualities",
    3,
    ["good", "estimated"],
  );
  if (includedQualities.some((quality) => !qualities.has(quality as AnalyticsSampleQuality))) {
    throw new Error("qualities contains an invalid sample quality");
  }
  const selectedPeriodKeys = args.selectedPeriodKeys === undefined
    ? undefined
    : stringList(args.selectedPeriodKeys, "selectedPeriodKeys", 2);
  const request: CalendarComparisonRequest = {
    apiVersion: "1.0",
    requestId: `mcp-calendar-${Date.now().toString(36)}`,
    houseId: house.id,
    dataMode: database.isRealDataMode() ? "live" : "demo",
    sensorIds,
    measurementId,
    unit: unit as CalendarComparisonRequest["unit"],
    anchor: {
      month: boundedInteger(anchor.month, "anchor.month", 1, 12),
      day: boundedInteger(anchor.day, "anchor.day", 1, 31),
      week: boundedInteger(anchor.week, "anchor.week", 1, 53),
    },
    ...(selectedPeriodKeys ? { selectedPeriodKeys } : {}),
    aggregation: aggregation as AnalyticsAggregation,
    qualityFilter: {
      include: includedQualities as AnalyticsSampleQuality[],
    },
  };
  return compareCalendarPeriods({
    request,
    house,
    sensors,
    definition,
    telemetryReader,
    evaluatedAt: new Date().toISOString(),
  });
}

export const derivedAnalyticsToolDefinitions = [
  {
    name: "get_home_performance",
    description: "Derive the authoritative versioned 30-day Home Performance result using the complete enabled sensor scope.",
    inputSchema: {
      type: "object",
      properties: {
        houseId: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["houseId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_home_monitoring",
    description: "Inspect authoritative monitoring status for every Home or detailed freshness and insights for one Home.",
    inputSchema: {
      type: "object",
      properties: {
        houseId: { type: "string", minLength: 1, maxLength: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "compare_calendar_periods",
    description: "Compare Home-local calendar periods with server-owned timezone boundaries, aggregation, alignment, and summaries.",
    inputSchema: {
      type: "object",
      properties: {
        houseId: { type: "string", minLength: 1, maxLength: 200 },
        sensorIds: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 200 },
        },
        measurementId: { type: "string", minLength: 1, maxLength: 200 },
        unit: { enum: ["day", "week", "month", "year", "decade"] },
        anchor: {
          type: "object",
          properties: {
            month: { type: "integer", minimum: 1, maximum: 12 },
            day: { type: "integer", minimum: 1, maximum: 31 },
            week: { type: "integer", minimum: 1, maximum: 53 },
          },
          required: ["month", "day", "week"],
          additionalProperties: false,
        },
        selectedPeriodKeys: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 200 },
        },
        aggregation: {
          enum: ANALYTICS_AGGREGATIONS,
          default: "default",
        },
        qualities: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
          items: { enum: ["good", "estimated", "stale"] },
          default: ["good", "estimated"],
        },
      },
      required: ["houseId", "sensorIds", "measurementId", "unit", "anchor"],
      additionalProperties: false,
    },
  },
  {
    name: "get_home_moisture_response",
    description: "Compare temperature-corrected indoor and outdoor moisture over up to 14 days. This measures association and response, not whether wind caused a humidity change.",
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
    name: "summarize_home_measurements",
    description: "Compute coverage-aware per-sensor and equal-weight whole-Home means for one measured quantity over an exact, half-open time range.",
    inputSchema: {
      type: "object",
      properties: {
        houseId: { type: "string", minLength: 1, maxLength: 200 },
        measurementId: { type: "string", minLength: 1, maxLength: 200 },
        sensorIds: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 200 },
        },
        from: { type: "string", format: "date-time" },
        to: { type: "string", format: "date-time" },
        qualities: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
          items: { enum: ["good", "estimated", "stale"] },
          default: ["good", "estimated"],
        },
      },
      required: ["houseId", "measurementId", "from", "to"],
      additionalProperties: false,
    },
  },
] as const;
