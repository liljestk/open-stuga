import type {
  AnalyticsCoverageRequest,
  AnalyticsCoverageResponse,
  AnalyticsEntityScope,
  DataMode,
  MeasurementDefinition,
  Sensor,
} from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import type { HybridMeasurementCoverageResult } from "../../timeseries/read-facade.js";
import { compareCodeUnits } from "../../text-order.js";
import { AnalyticsQueryError } from "./analytics-query.js";

/** Which Homes and sensors a caller may read; a browser session's grants, or everything for MCP inspection. */
export interface AnalyticsScopeAccess {
  house(houseId: string): boolean;
  sensor(sensorId: string): boolean;
}

/** Resolve the requested house sensors exactly as this caller may see them. */
export function resolveAnalyticsScopeSensors(
  database: ClimateDatabase,
  request: { dataMode: DataMode; scope: AnalyticsEntityScope },
  access: AnalyticsScopeAccess,
): Sensor[] {
  const activeDataMode = database.isRealDataMode() ? "live" : "demo";
  if (request.dataMode !== activeDataMode) {
    throw new AnalyticsQueryError(
      409,
      "ANALYTICS_DATA_MODE_MISMATCH",
      `This local database is in ${activeDataMode} mode; cross-mode analytics queries are not allowed`,
    );
  }
  const house = database.getHouse(request.scope.id);
  if (!house || !access.house(house.id)) {
    throw new AnalyticsQueryError(404, "ANALYTICS_SCOPE_NOT_FOUND", "Analytics house scope was not found");
  }
  const accessibleSensors = database.listSensors(house.id)
    .filter((sensor) => access.sensor(sensor.id));
  const byId = new Map(accessibleSensors.map((sensor) => [sensor.id, sensor]));
  const requestedSensorIds = request.scope.entityIds
    ?? accessibleSensors.filter((sensor) => sensor.enabled).map((sensor) => sensor.id);
  return requestedSensorIds.map((sensorId) => {
    const sensor = byId.get(sensorId);
    if (!sensor) {
      throw new AnalyticsQueryError(404, "ANALYTICS_ENTITY_NOT_FOUND", `Sensor ${sensorId} is not available in the requested house`);
    }
    return sensor;
  });
}

/** The definition of every queried measurement, rejecting an unknown one. */
export function analyticsQueryDefinitions(database: ClimateDatabase, measurementIds: readonly string[]): MeasurementDefinition[] {
  return measurementIds.map((metric) => {
    const definition = database.getMeasurementDefinition(metric);
    if (!definition) throw new AnalyticsQueryError(404, "UNKNOWN_ANALYTICS_MEASUREMENT", `Unknown measurement: ${metric}`);
    return definition;
  });
}

/** Coverage is offered only for measurements with generic history and statistics. */
export function requireAnalyticsCoverageMeasurements(database: ClimateDatabase, measurementIds: readonly string[]): void {
  for (const definition of analyticsQueryDefinitions(database, measurementIds)) {
    if (definition.genericHistoryEnabled === false || definition.genericStatsEnabled === false) {
      throw new AnalyticsQueryError(422, "ANALYTICS_MEASUREMENT_DISABLED", `Analytics is disabled for measurement: ${definition.id}`);
    }
  }
}

/** The stored range of each sensor measurement and the span they cover together. */
export function analyticsCoverageResponse(
  request: AnalyticsCoverageRequest,
  sensors: readonly Sensor[],
  coverage: HybridMeasurementCoverageResult,
): AnalyticsCoverageResponse {
  const labels = new Map(sensors.map((sensor) => [sensor.id, sensor.name]));
  const series = coverage.records.map((record) => ({
    entityId: record.sensorId,
    entityLabel: labels.get(record.sensorId) ?? record.sensorId,
    measurementId: record.metric,
    start: record.start,
    end: record.end,
  }));
  const starts = series.map((item) => item.start).sort(compareCodeUnits);
  const ends = series.map((item) => item.end).sort(compareCodeUnits);
  return {
    apiVersion: "1.0",
    requestId: request.requestId,
    dataMode: request.dataMode,
    range: { start: starts[0] ?? null, end: ends.at(-1) ?? null },
    series,
    complete: coverage.complete,
    archiveState: coverage.archiveState,
    generatedAt: new Date().toISOString(),
  };
}
