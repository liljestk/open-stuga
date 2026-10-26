import type express from "express";
import type { AnalyticsEntityScope, DataMode, Sensor } from "@climate-twin/contracts";
import {
  AnalyticsQueryError,
  parseAnalyticsCoverageRequest,
  parseAnalyticsQueryRequest,
} from "../../analytics.js";
import type { ClimateDatabase } from "../../db.js";
import { HttpError } from "../../app/support/index.js";
import {
  IncompleteTelemetryHistoryError,
  type HybridTelemetryReader,
} from "../../timeseries/read-facade.js";
import type { AnalyticsWorkLimiter } from "../work-limiter.js";
import { executeAnalyticsQuery } from "./execute.js";
import { compareCodeUnits } from "../../text-order.js";

export interface AnalyticsQueryRouteContext {
  app: express.Express;
  v2Prefix: string;
  database: ClimateDatabase;
  telemetryReader: HybridTelemetryReader;
  analyticsWorkLimiter: AnalyticsWorkLimiter;
  visibility(response: express.Response): {
    house(houseId: string): boolean;
    sensor(sensorId: string): boolean;
  };
}

/** Resolve the requested house sensors exactly as this caller may see them. */
function resolveScopeSensors(
  context: AnalyticsQueryRouteContext,
  response: express.Response,
  request: { dataMode: DataMode; scope: AnalyticsEntityScope },
): Sensor[] {
  const activeDataMode = context.database.isRealDataMode() ? "live" : "demo";
  if (request.dataMode !== activeDataMode) {
    throw new AnalyticsQueryError(
      409,
      "ANALYTICS_DATA_MODE_MISMATCH",
      `This local database is in ${activeDataMode} mode; cross-mode analytics queries are not allowed`,
    );
  }
  const house = context.database.getHouse(request.scope.id);
  if (!house || !context.visibility(response).house(house.id)) {
    throw new AnalyticsQueryError(404, "ANALYTICS_SCOPE_NOT_FOUND", "Analytics house scope was not found");
  }
  const accessibleSensors = context.database.listSensors(house.id)
    .filter((sensor) => context.visibility(response).sensor(sensor.id));
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

async function untilClientCloses<T>(
  response: express.Response,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abortController = new AbortController();
  const abortOnClose = () => abortController.abort();
  response.once("close", abortOnClose);
  try {
    return await operation(abortController.signal);
  } finally {
    response.off("close", abortOnClose);
  }
}

export function registerAnalyticsQueryRoutes(context: AnalyticsQueryRouteContext): void {
  context.app.post(`${context.v2Prefix}/analytics/coverage`, async (request, response) => {
    try {
      const coverageRequest = parseAnalyticsCoverageRequest(request.body);
      const sensors = resolveScopeSensors(context, response, coverageRequest);
      for (const metric of coverageRequest.measurementIds) {
        const definition = context.database.getMeasurementDefinition(metric);
        if (!definition) throw new AnalyticsQueryError(404, "UNKNOWN_ANALYTICS_MEASUREMENT", `Unknown measurement: ${metric}`);
        if (definition.genericHistoryEnabled === false || definition.genericStatsEnabled === false) {
          throw new AnalyticsQueryError(422, "ANALYTICS_MEASUREMENT_DISABLED", `Analytics is disabled for measurement: ${metric}`);
        }
      }
      const startedAt = performance.now();
      const coverage = await untilClientCloses(response, (signal) => context.analyticsWorkLimiter.run(
        "analytics-coverage",
        () => context.telemetryReader.measurementCoverage({
          sensorIds: sensors.map((sensor) => sensor.id),
          metrics: coverageRequest.measurementIds,
          signal,
        }),
        signal,
      ));
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
      response.setHeader("cache-control", "no-store");
      response.setHeader(
        "server-timing",
        `analytics-coverage;dur=${(performance.now() - startedAt).toFixed(1)}`,
      );
      response.json({
        apiVersion: "1.0",
        requestId: coverageRequest.requestId,
        dataMode: coverageRequest.dataMode,
        range: { start: starts[0] ?? null, end: ends.at(-1) ?? null },
        series,
        complete: coverage.complete,
        archiveState: coverage.archiveState,
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof AnalyticsQueryError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  });
  context.app.post(`${context.v2Prefix}/analytics/query`, async (request, response) => {
    try {
      const analyticsRequest = parseAnalyticsQueryRequest(request.body);
      const sensors = resolveScopeSensors(context, response, analyticsRequest);
      const definitions = analyticsRequest.measurementIds.map((metric) => {
        const definition = context.database.getMeasurementDefinition(metric);
        if (!definition) throw new AnalyticsQueryError(404, "UNKNOWN_ANALYTICS_MEASUREMENT", `Unknown measurement: ${metric}`);
        return definition;
      });
      const startedAt = performance.now();
      const result = await untilClientCloses(response, (signal) => context.analyticsWorkLimiter.run(
        "analytics-query",
        () => executeAnalyticsQuery({
          request: analyticsRequest,
          sensors,
          definitions,
          telemetryReader: context.telemetryReader,
          generatedAt: new Date().toISOString(),
          signal,
        }),
        signal,
      ));
      response.setHeader("cache-control", "no-store");
      response.setHeader(
        "server-timing",
        `analytics-query;dur=${(performance.now() - startedAt).toFixed(1)}`,
      );
      response.json(result);
    } catch (error) {
      if (error instanceof AnalyticsQueryError) throw new HttpError(error.status, error.code, error.message);
      if (error instanceof IncompleteTelemetryHistoryError) {
        throw new HttpError(
          503,
          "TELEMETRY_ARCHIVE_REQUIRED",
          "Complete telemetry history is temporarily unavailable",
        );
      }
      throw error;
    }
  });
}
