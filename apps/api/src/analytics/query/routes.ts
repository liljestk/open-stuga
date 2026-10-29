import { withResponseSignal } from "../../app/response-signal.js";
import type express from "express";
import { parseAnalyticsCoverageRequest, parseAnalyticsQueryRequest } from "./analytics-query.js";
import {
  analyticsCoverageResponse,
  analyticsQueryDefinitions,
  requireAnalyticsCoverageMeasurements,
  resolveAnalyticsScopeSensors,
} from "./scope.js";
import type { ClimateDatabase } from "../../db.js";
import {
  type HybridTelemetryReader,
} from "../../timeseries/read-facade.js";
import type { AnalyticsWorkLimiter } from "../work-limiter.js";
import { AnalyticsQueryCache } from "./cache.js";
import { queryLatencyOperation } from "../diagnostics/latency.js";
import { executeAnalyticsQuery } from "./execute.js";

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

export function registerAnalyticsQueryRoutes(context: AnalyticsQueryRouteContext): () => void {
  const queryCache = new AnalyticsQueryCache(context.database);
  const removeStats = context.analyticsWorkLimiter.registerCache("analytics-query", () => queryCache.stats());
  context.app.post(`${context.v2Prefix}/analytics/coverage`, async (request, response) => {
    const coverageRequest = parseAnalyticsCoverageRequest(request.body);
    const sensors = resolveAnalyticsScopeSensors(context.database, coverageRequest, context.visibility(response));
    requireAnalyticsCoverageMeasurements(context.database, coverageRequest.measurementIds);
    const startedAt = performance.now();
    const coverage = await withResponseSignal(response, (signal) => context.analyticsWorkLimiter.run(
      "analytics-coverage",
      () => context.telemetryReader.measurementCoverage({
        sensorIds: sensors.map((sensor) => sensor.id),
        metrics: coverageRequest.measurementIds,
        signal,
      }),
      signal,
    ));
    response.setHeader("cache-control", "no-store");
    response.setHeader(
      "server-timing",
      `analytics-coverage;dur=${(performance.now() - startedAt).toFixed(1)}`,
    );
    response.json(analyticsCoverageResponse(coverageRequest, sensors, coverage));
  });
  context.app.post(`${context.v2Prefix}/analytics/query`, async (request, response) => {
    const analyticsRequest = parseAnalyticsQueryRequest(request.body);
    const sensors = resolveAnalyticsScopeSensors(context.database, analyticsRequest, context.visibility(response));
    const definitions = analyticsQueryDefinitions(context.database, analyticsRequest.measurementIds);
    const startedAt = performance.now();
    const expectedIntervalSeconds = context.database.expectedReportingIntervals(sensors.flatMap((sensor) => (
      definitions.map((definition) => ({ sensorId: sensor.id, metric: definition.id }))
    )));
    const result = await withResponseSignal(response, (signal) => queryCache.getOrCompute(
      { request: analyticsRequest, sensorIds: sensors.map((sensor) => sensor.id), expectedIntervalSeconds },
      (loadSignal) => context.analyticsWorkLimiter.run(
        "analytics-query",
        () => executeAnalyticsQuery({
          request: analyticsRequest,
          sensors,
          definitions,
          telemetryReader: context.telemetryReader,
          generatedAt: new Date().toISOString(),
          expectedIntervalSeconds,
          signal: loadSignal,
        }),
        loadSignal,
      ),
      signal,
    ));
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-stugu-cache", result.cache.hit ? "hit" : "miss");
    context.database.recordAnalyticsLatency({
      houseId: analyticsRequest.scope.id,
      operation: queryLatencyOperation(Date.parse(analyticsRequest.range.end) - Date.parse(analyticsRequest.range.start)),
      durationMs: performance.now() - startedAt,
    });
    response.setHeader(
      "server-timing",
      `analytics-query;dur=${(performance.now() - startedAt).toFixed(1)}`,
    );
    response.json(result);
  });
  return () => {
    removeStats();
    queryCache.clear();
  };
}
