import type { AnalyticsSampleQuality } from "@climate-twin/contracts";
import { executeAnalyticsQuery } from "../analytics/query/execute.js";
import {
  mcpIsoDate,
  requireMcpHouse,
  requireMcpHouseSensor,
} from "../mcp-validation.js";
import { requiredToolString } from "./arguments.js";
import type { McpRuntime } from "./runtime.js";

const MAX_RANGE_MS = 366 * 24 * 3_600_000;
const allowedQualities = new Set<AnalyticsSampleQuality>(["good", "estimated", "stale"]);

function selectedQualities(value: unknown): AnalyticsSampleQuality[] {
  if (value === undefined) return ["good", "estimated"];
  if (!Array.isArray(value) || value.length === 0 || value.length > 3
    || value.some((item) => typeof item !== "string"
      || !allowedQualities.has(item as AnalyticsSampleQuality))) {
    throw new Error("qualities must contain good, estimated, or stale");
  }
  const qualities = [...new Set(value as AnalyticsSampleQuality[])];
  if (qualities.length !== value.length) throw new Error("qualities must not contain duplicates");
  return qualities;
}

function selectedSensorIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 50
    || value.some((item) => typeof item !== "string"
      || item.trim().length === 0 || item.length > 200)) {
    throw new Error("sensorIds must contain between 1 and 50 sensor identifiers");
  }
  const ids = [...new Set(value.map((item) => (item as string).trim()))];
  if (ids.length !== value.length) throw new Error("sensorIds must not contain duplicates");
  return ids;
}

function rounded(value: number, precision: number): number {
  return Number(value.toFixed(Math.max(0, Math.min(precision, 6))));
}

export async function homeMeasurementSummary(
  runtime: McpRuntime,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { database, telemetryReader } = runtime;
  const house = requireMcpHouse(database, requiredToolString(args, "houseId"));
  const measurementId = requiredToolString(args, "measurementId");
  const definition = database.getMeasurementDefinition(measurementId);
  if (!definition || !definition.enabled) {
    throw new Error(`Unknown or disabled measurement: ${measurementId}`);
  }
  const from = mcpIsoDate(requiredToolString(args, "from"), "from");
  const to = mcpIsoDate(requiredToolString(args, "to"), "to");
  const durationMs = Date.parse(to) - Date.parse(from);
  if (durationMs <= 0 || durationMs > MAX_RANGE_MS) {
    throw new Error("Measurement summary range must be greater than zero and at most 366 days");
  }
  if (Date.parse(to) > Date.now() + 5 * 60_000) {
    throw new Error("Measurement summary cannot end in the future");
  }

  const requestedIds = selectedSensorIds(args.sensorIds);
  const sensors = requestedIds
    ? requestedIds.map((sensorId) => requireMcpHouseSensor(database, house.id, sensorId))
    : database.listSensors(house.id).filter((sensor) => sensor.enabled);
  const qualities = selectedQualities(args.qualities);
  const generatedAt = new Date().toISOString();
  if (sensors.length === 0) {
    return {
      houseId: house.id,
      homeName: house.name,
      timezone: house.timezone,
      measurementId,
      canonicalUnit: definition.unit,
      from,
      to,
      homeMean: null,
      sensorSummaries: [],
      quality: { coverage: 0, sensorCount: 0, sensorsWithData: 0, sampleCount: 0 },
      warnings: [{ code: "NO_SENSORS", message: "No enabled sensors were selected." }],
      generatedAt,
    };
  }

  const response = await executeAnalyticsQuery({
    request: {
      apiVersion: "1.0",
      requestId: `mcp-summary-${Date.now().toString(36)}`,
      dataMode: database.isRealDataMode() ? "live" : "demo",
      scope: { kind: "house", id: house.id, entityIds: sensors.map((sensor) => sensor.id) },
      measurementIds: [measurementId],
      range: { start: from, end: to, timezone: house.timezone },
      resolution: "auto",
      aggregation: "mean",
      qualityFilter: { include: qualities },
      include: ["summary", "quality", "provenance"],
      maxPointsPerSeries: 800,
    },
    sensors,
    definitions: [definition],
    telemetryReader,
    generatedAt,
  });
  const labels = new Map(sensors.map((sensor) => [sensor.id, sensor.name]));
  const summaries = response.summaries.map((summary) => ({
    sensorId: summary.entityId,
    sensorName: labels.get(summary.entityId) ?? summary.entityId,
    count: summary.count,
    coverage: summary.coverage,
    mean: summary.mean,
    minimum: summary.minimum,
    maximum: summary.maximum,
    median: summary.median,
  }));
  const sensorMeans = summaries.flatMap((summary) => (
    summary.mean === null ? [] : [summary.mean]
  ));
  const homeMean = sensorMeans.length === 0
    ? null
    : rounded(
        sensorMeans.reduce((sum, value) => sum + value, 0) / sensorMeans.length,
        definition.precision,
      );

  return {
    houseId: house.id,
    homeName: house.name,
    timezone: house.timezone,
    measurementId,
    canonicalUnit: definition.unit,
    from,
    to,
    homeMean,
    weighting: "equal-weight mean of each sensor's time-bucket mean",
    sensorSummaries: summaries,
    quality: {
      coverage: response.quality.coverage,
      sensorCount: summaries.length,
      sensorsWithData: sensorMeans.length,
      sampleCount: response.quality.sampleCount,
      excludedSampleCount: response.quality.excludedSampleCount,
      includedQualities: response.quality.includedQualities,
    },
    warnings: response.warnings,
    generatedAt,
  };
}
