import { withResponseSignal } from "../app/response-signal.js";
import type express from "express";
import type {
  AnalyticsAggregation,
  CalendarComparisonRequest,
  DataMode,
  IntegrationStatus,
  MeasurementSample,
  OpeningActivityRequest,
} from "@climate-twin/contracts";
import { CALENDAR_COMPARISON_UNITS } from "@climate-twin/contracts";
import { DAILY_ANALYTICS_ALGORITHM_VERSION } from "../daily-analytics-findings.js";
import type { AnalyticsWorkLimiter } from "./work-limiter.js";
import type { ClimateDatabase } from "../db.js";
import type { TelemetryBus } from "../events.js";
import type { WeatherEventBroker } from "../weather-events.js";
import {
  type HybridTelemetryReader,
} from "../timeseries/read-facade.js";
import {
  HttpError,
  bodyObject,
  rejectUnknownFields,
  requireNonGuest,
  requiredString,
} from "../app/support/index.js";
import { getOpeningActivity } from "./opening-activity/service.js";
import type { DerivedAnalyticsCoordinator } from "./derived-artifacts/coordinator.js";
import { registerHomeMonitoringRoutes } from "./home-monitoring/routes.js";
import { registerAnalyticsQueryRoutes, type AnalyticsQueryRouteContext } from "./query/routes.js";
import { registerAnalyticsDiagnosticsRoutes, type AnalyticsDiagnosticsRouteContext } from "./diagnostics/routes.js";
import { registerForecastRoutes, type ForecastRouteContext } from "./forecast/routes.js";
import { registerThermalAnalyticsRoutes, type ThermalAnalyticsRouteContext } from "./thermal-routes.js";
import {
  compareCalendarPeriods,
} from "./calendar-comparison/service.js";

interface AnalyticsRouteContext
  extends AnalyticsQueryRouteContext, ForecastRouteContext, ThermalAnalyticsRouteContext, AnalyticsDiagnosticsRouteContext {
  app: express.Express;
  v2Prefix: string;
  database: ClimateDatabase;
  telemetryReader: HybridTelemetryReader;
  bus: TelemetryBus;
  cachedLatestMeasurements(houseId?: string): MeasurementSample[];
  integrationStatusForHouse(houseId?: string): IntegrationStatus;
  weatherEvents: WeatherEventBroker;
  analyticsWorkLimiter: AnalyticsWorkLimiter;
  derivedAnalytics: DerivedAnalyticsCoordinator;
  visibility(response: express.Response): {
    house(houseId: string): boolean;
    sensor(sensorId: string): boolean;
  };
  streamAuthorizationFingerprint(
    request: express.Request,
    response: express.Response,
  ): string | null;
}

function dataMode(value: unknown): DataMode {
  if (value !== "live" && value !== "demo") {
    throw new HttpError(400, "INVALID_DATA_MODE", "dataMode must be live or demo");
  }
  return value;
}

function isoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new HttpError(400, "INVALID_DATE", `${field} must be an ISO date-time`);
  }
  return new Date(value).toISOString();
}

function openingActivityRequest(value: unknown): OpeningActivityRequest {
  const body = bodyObject(value);
  rejectUnknownFields(
    body,
    new Set(["apiVersion", "requestId", "houseId", "dataMode", "range", "elementIds"]),
    "opening activity",
  );
  if (body.apiVersion !== "1.0") {
    throw new HttpError(400, "UNSUPPORTED_ANALYTICS_VERSION", "apiVersion must be 1.0");
  }
  const range = bodyObject(body.range);
  rejectUnknownFields(range, new Set(["start", "end"]), "opening activity range");
  const start = isoDate(range.start, "range.start");
  const end = isoDate(range.end, "range.end");
  const duration = Date.parse(end) - Date.parse(start);
  if (duration <= 0 || duration > 366 * 86_400_000) {
    throw new HttpError(
      400,
      "INVALID_OPENING_HISTORY_RANGE",
      "Opening activity must cover more than zero and at most 366 days",
    );
  }
  let elementIds: string[] | undefined;
  if (body.elementIds !== undefined) {
    if (!Array.isArray(body.elementIds) || body.elementIds.length > 500
      || body.elementIds.some((item) => typeof item !== "string" || item.length === 0 || item.length > 200)) {
      throw new HttpError(400, "INVALID_FIELD", "elementIds must contain at most 500 identifiers");
    }
    elementIds = [...new Set(body.elementIds)];
  }
  return {
    apiVersion: "1.0",
    requestId: requiredString(body, "requestId"),
    houseId: requiredString(body, "houseId"),
    dataMode: dataMode(body.dataMode),
    range: { start, end },
    ...(elementIds ? { elementIds } : {}),
  };
}

function boundedStringList(
  value: unknown,
  field: string,
  maximum: number,
): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum
    || value.some((item) => typeof item !== "string"
      || item.trim().length === 0
      || item.length > 200)) {
    throw new HttpError(
      400,
      "INVALID_FIELD",
      `${field} must contain between 1 and ${maximum} identifiers`,
    );
  }
  const result = [...new Set(value.map((item) => (item as string).trim()))];
  if (result.length !== value.length) {
    throw new HttpError(400, "INVALID_FIELD", `${field} must not contain duplicates`);
  }
  return result;
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new HttpError(
      400,
      "INVALID_FIELD",
      `${field} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value as number;
}

function calendarComparisonRequest(value: unknown): CalendarComparisonRequest {
  const body = bodyObject(value);
  rejectUnknownFields(body, new Set([
    "apiVersion",
    "requestId",
    "houseId",
    "dataMode",
    "sensorIds",
    "measurementId",
    "unit",
    "anchor",
    "selectedPeriodKeys",
    "aggregation",
    "qualityFilter",
  ]), "calendar comparison");
  if (body.apiVersion !== "1.0") {
    throw new HttpError(400, "UNSUPPORTED_ANALYTICS_VERSION", "apiVersion must be 1.0");
  }
  if (!CALENDAR_COMPARISON_UNITS.includes(body.unit as never)) {
    throw new HttpError(400, "INVALID_FIELD", "unit must be day, week, month, year, or decade");
  }
  const anchor = bodyObject(body.anchor);
  rejectUnknownFields(anchor, new Set(["month", "day", "week"]), "calendar comparison anchor");
  const aggregationValues = new Set<AnalyticsAggregation>([
    "default",
    "mean",
    "sum",
    "delta",
    "last",
    "time_weighted_mean",
    "min",
    "max",
  ]);
  if (!aggregationValues.has(body.aggregation as AnalyticsAggregation)) {
    throw new HttpError(400, "INVALID_FIELD", "aggregation is not supported");
  }
  const qualityFilter = bodyObject(body.qualityFilter);
  rejectUnknownFields(qualityFilter, new Set(["include"]), "calendar comparison quality filter");
  const qualities = boundedStringList(qualityFilter.include, "qualityFilter.include", 3);
  if (qualities.some((quality) => !["good", "estimated", "stale"].includes(quality))) {
    throw new HttpError(400, "INVALID_FIELD", "qualityFilter.include contains an invalid quality");
  }
  const requestId = requiredString(body, "requestId");
  const houseId = requiredString(body, "houseId");
  const measurementId = requiredString(body, "measurementId");
  if ([requestId, houseId, measurementId].some((item) => item.length > 200)) {
    throw new HttpError(400, "INVALID_FIELD", "Identifiers must be at most 200 characters");
  }
  return {
    apiVersion: "1.0",
    requestId,
    houseId,
    dataMode: dataMode(body.dataMode),
    sensorIds: boundedStringList(body.sensorIds, "sensorIds", 50),
    measurementId,
    unit: body.unit as CalendarComparisonRequest["unit"],
    anchor: {
      month: boundedInteger(anchor.month, "anchor.month", 1, 12),
      day: boundedInteger(anchor.day, "anchor.day", 1, 31),
      week: boundedInteger(anchor.week, "anchor.week", 1, 53),
    },
    ...(body.selectedPeriodKeys !== undefined
      ? { selectedPeriodKeys: boundedStringList(body.selectedPeriodKeys, "selectedPeriodKeys", 2) }
      : {}),
    aggregation: body.aggregation as AnalyticsAggregation,
    qualityFilter: {
      include: qualities as CalendarComparisonRequest["qualityFilter"]["include"],
    },
  };
}

export function registerAnalyticsRoutes(context: AnalyticsRouteContext): () => void {
  const removeHomeMonitoringRoutes = registerHomeMonitoringRoutes(context);
  const removeAnalyticsQueryRoutes = registerAnalyticsQueryRoutes(context);
  registerAnalyticsDiagnosticsRoutes(context);
  registerForecastRoutes(context);
  registerThermalAnalyticsRoutes(context);

  context.app.get(`${context.v2Prefix}/analytics/findings`, (request, response) => {
    const houseId = typeof request.query.houseId === "string" ? request.query.houseId.trim() : "";
    if (!houseId || houseId.length > 200) throw new HttpError(400, "INVALID_FIELD", "houseId is required");
    const house = context.database.getHouse(houseId);
    if (!house || !context.visibility(response).house(house.id)) {
      throw new HttpError(404, "ANALYTICS_SCOPE_NOT_FOUND", "Analytics house scope was not found");
    }
    const dataMode = context.database.isRealDataMode() ? "live" : "demo";
    const stored = context.database.dailyAnalyticsFindings(house.id, dataMode);
    const staleAlgorithm = Boolean(
      stored?.snapshot
      && stored.snapshot.algorithmVersion !== DAILY_ANALYTICS_ALGORITHM_VERSION,
    );
    response.setHeader("cache-control", "no-store");
    response.json({
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
    });
  });

  context.app.post(`${context.v2Prefix}/analytics/opening-activity`, async (request, response) => {
    const input = openingActivityRequest(request.body);
    const activeDataMode = context.database.isRealDataMode() ? "live" : "demo";
    if (input.dataMode !== activeDataMode) {
      throw new HttpError(
        409,
        "ANALYTICS_DATA_MODE_MISMATCH",
        `This local database is in ${activeDataMode} mode; cross-mode analytics queries are not allowed`,
      );
    }
    const house = context.database.getHouse(input.houseId);
    if (!house || !context.visibility(response).house(house.id)) {
      throw new HttpError(
        404,
        "ANALYTICS_SCOPE_NOT_FOUND",
        "Analytics Home scope was not found",
      );
    }
    const startedAt = performance.now();
    const result = await withResponseSignal(response, (signal) => context.analyticsWorkLimiter.run(
      "opening-activity",
      () => getOpeningActivity({
        house,
        request: input,
        telemetryReader: context.telemetryReader,
        generatedAt: new Date().toISOString(),
        signal,
      }),
      signal,
    ));
    response.setHeader("cache-control", "no-store");
    response.setHeader(
      "server-timing",
      `opening-activity;dur=${(performance.now() - startedAt).toFixed(1)}`,
    );
    response.json(result);
  });
  context.app.post(`${context.v2Prefix}/analytics/calendar-comparison`, async (request, response) => {
    const input = calendarComparisonRequest(request.body);
    const activeDataMode = context.database.isRealDataMode() ? "live" : "demo";
    if (input.dataMode !== activeDataMode) {
      throw new HttpError(
        409,
        "ANALYTICS_DATA_MODE_MISMATCH",
        `This local database is in ${activeDataMode} mode; cross-mode analytics queries are not allowed`,
      );
    }
    const house = context.database.getHouse(input.houseId);
    const access = context.visibility(response);
    if (!house || !access.house(house.id)) {
      throw new HttpError(404, "ANALYTICS_SCOPE_NOT_FOUND", "Analytics Home scope was not found");
    }
    const availableSensors = new Map(context.database.listSensors(house.id)
      .filter((sensor) => access.sensor(sensor.id))
      .map((sensor) => [sensor.id, sensor]));
    const sensors = input.sensorIds.map((sensorId) => {
      const sensor = availableSensors.get(sensorId);
      if (!sensor) {
        throw new HttpError(
          404,
          "ANALYTICS_ENTITY_NOT_FOUND",
          `Sensor ${sensorId} is not available in the requested Home`,
        );
      }
      return sensor;
    });
    const definition = context.database.getMeasurementDefinition(input.measurementId);
    if (!definition) {
      throw new HttpError(
        404,
        "UNKNOWN_ANALYTICS_MEASUREMENT",
        `Unknown measurement: ${input.measurementId}`,
      );
    }
    if (!definition.enabled
      || definition.genericHistoryEnabled === false
      || definition.genericStatsEnabled === false) {
      throw new HttpError(
        422,
        "ANALYTICS_MEASUREMENT_DISABLED",
        `Analytics is disabled for measurement: ${input.measurementId}`,
      );
    }
    const startedAt = performance.now();
    const result = await context.analyticsWorkLimiter.run(
      "calendar-comparison",
      () => compareCalendarPeriods({
        request: input,
        house,
        sensors,
        definition,
        telemetryReader: context.telemetryReader,
        evaluatedAt: new Date().toISOString(),
      }),
    );
    response.setHeader("cache-control", "no-store");
    response.setHeader(
      "server-timing",
      `calendar-comparison;dur=${(performance.now() - startedAt).toFixed(1)}`,
    );
    response.json(result);
  });
  const derivedInput = (
    request: express.Request,
    response: express.Response,
    kind: "thermal-isolation" | "moisture-response" | "home-performance",
  ) => {
    const houseId = typeof request.query.houseId === "string" ? request.query.houseId.trim() : "";
    if (!houseId || houseId.length > 200) {
      throw new HttpError(400, "INVALID_FIELD", "houseId is required");
    }
    const requestedDataMode = dataMode(request.query.dataMode);
    const activeDataMode = context.database.isRealDataMode() ? "live" : "demo";
    if (requestedDataMode !== activeDataMode) {
      throw new HttpError(
        409,
        "ANALYTICS_DATA_MODE_MISMATCH",
        `This local database is in ${activeDataMode} mode; cross-mode analytics queries are not allowed`,
      );
    }
    const house = context.database.getHouse(houseId);
    const access = context.visibility(response);
    if (!house || !access.house(house.id)) {
      throw new HttpError(
        404,
        "ANALYTICS_SCOPE_NOT_FOUND",
        "Analytics Home scope was not found",
      );
    }
    let windowDays: number | undefined;
    if (kind !== "home-performance") {
      const rawWindow = typeof request.query.windowDays === "string"
        ? Number(request.query.windowDays)
        : 7;
      if (rawWindow !== 1 && rawWindow !== 7 && rawWindow !== 14) {
        throw new HttpError(400, "INVALID_FIELD", "windowDays must be 1, 7, or 14");
      }
      windowDays = rawWindow;
    }
    return {
      kind,
      houseId: house.id,
      dataMode: requestedDataMode,
      ...(windowDays === undefined ? {} : { windowDays }),
    };
  };
  const registerDerivedRoute = (
    path: string,
    kind: "thermal-isolation" | "moisture-response" | "home-performance",
  ) => {
    context.app.get(`${context.v2Prefix}${path}`, (request, response) => {
      const startedAt = performance.now();
      const result = context.derivedAnalytics.read(derivedInput(request, response, kind));
      response.setHeader("cache-control", "private, no-store");
      response.setHeader(
        "server-timing",
        `derived-artifact-read;dur=${(performance.now() - startedAt).toFixed(1)}`,
      );
      response.json(result);
    });
    context.app.post(`${context.v2Prefix}${path}`, requireNonGuest, (request, response) => {
      const result = context.derivedAnalytics.refresh(derivedInput(request, response, kind));
      response.setHeader("cache-control", "private, no-store");
      response.status(202).json(result);
    });
  };
  registerDerivedRoute("/analytics/thermal-isolation", "thermal-isolation");
  registerDerivedRoute("/analytics/moisture-response", "moisture-response");
  registerDerivedRoute("/analytics/home-performance", "home-performance");
  return () => {
    removeHomeMonitoringRoutes();
    removeAnalyticsQueryRoutes();
  };
}
