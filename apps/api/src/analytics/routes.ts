import type express from "express";
import { createHash } from "node:crypto";
import type {
  AnalyticsAggregation,
  CalendarComparisonRequest,
  DataMode,
  HomePerformanceResponse,
  IntegrationStatus,
  MeasurementSample,
  OpeningActivityRequest,
} from "@climate-twin/contracts";
import {
  CALENDAR_COMPARISON_UNITS,
  HOME_PERFORMANCE_ALGORITHM_VERSION as HOME_PERFORMANCE_VERSION,
} from "@climate-twin/contracts";
import { AnalyticsQueryError } from "../analytics.js";
import { LruTtlCache } from "../cache.js";
import type { ClimateDatabase } from "../db.js";
import type { TelemetryBus } from "../events.js";
import type { WeatherEventBroker } from "../weather-events.js";
import {
  IncompleteTelemetryHistoryError,
  type HybridTelemetryReader,
} from "../timeseries/read-facade.js";
import {
  HttpError,
  bodyObject,
  rejectUnknownFields,
  requiredString,
} from "../app/support/index.js";
import { getOpeningActivity } from "./opening-activity/service.js";
import {
  getHomePerformance,
  HomePerformanceScopeError,
} from "./home-performance/service.js";
import {
  getHomeMonitoringCollection,
  getHomeMonitoringDetail,
} from "./home-monitoring/service.js";
import {
  CalendarComparisonSelectionError,
  compareCalendarPeriods,
} from "./calendar-comparison/service.js";

interface AnalyticsRouteContext {
  app: express.Express;
  v2Prefix: string;
  database: ClimateDatabase;
  telemetryReader: HybridTelemetryReader;
  bus: TelemetryBus;
  cachedLatestMeasurements(houseId?: string): MeasurementSample[];
  integrationStatusForHouse(houseId?: string): IntegrationStatus;
  weatherEvents: WeatherEventBroker;
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

function cacheKey(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function registerAnalyticsRoutes(context: AnalyticsRouteContext): () => void {
  const homePerformanceCache = new LruTtlCache<HomePerformanceResponse>({
    maxEntries: 128,
    maxBytes: 32 * 1024 * 1024,
    defaultTtlMs: 60_000,
    defaultStaleWhileRevalidateMs: 0,
  });
  const invalidateHouse = (houseId: string | null | undefined) => {
    if (houseId) homePerformanceCache.invalidatePrefix(`home:${houseId}:`);
    else homePerformanceCache.clear();
  };
  const invalidateSensorHouse = (sensorId: string) => {
    invalidateHouse(context.database.getSensor(sensorId)?.houseId);
  };
  const removeLegacyCacheWake = context.bus.subscribe((event) => {
    if (event.type === "heartbeat") return;
    if (event.type === "reading" || event.type === "alert") {
      invalidateSensorHouse(event.data.sensorId);
      return;
    }
    if (event.type === "opening" || event.type === "weather" || event.type === "heat-pump") {
      invalidateHouse(event.data.houseId);
      return;
    }
    homePerformanceCache.clear();
  });
  const removeMeasurementCacheWake = context.bus.subscribeMeasurements((sample) => {
    invalidateSensorHouse(sample.sensorId);
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
    try {
      const result = await getOpeningActivity({
        house,
        request: input,
        telemetryReader: context.telemetryReader,
        generatedAt: new Date().toISOString(),
      });
      response.setHeader("cache-control", "no-store");
      response.json(result);
    } catch (error) {
      if (error instanceof IncompleteTelemetryHistoryError) {
        throw new HttpError(
          503,
          error.code,
          error.message,
          { archiveState: error.archiveState },
        );
      }
      throw error;
    }
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
      .filter((sensor) => sensor.enabled && access.sensor(sensor.id))
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
    try {
      const result = await compareCalendarPeriods({
        request: input,
        house,
        sensors,
        definition,
        telemetryReader: context.telemetryReader,
        evaluatedAt: new Date().toISOString(),
      });
      response.setHeader("cache-control", "no-store");
      response.json(result);
    } catch (error) {
      if (error instanceof CalendarComparisonSelectionError) {
        throw new HttpError(422, error.code, error.message);
      }
      if (error instanceof AnalyticsQueryError) {
        throw new HttpError(error.status, error.code, error.message);
      }
      if (error instanceof IncompleteTelemetryHistoryError) {
        throw new HttpError(
          503,
          "TELEMETRY_ARCHIVE_REQUIRED",
          "Complete telemetry history is temporarily unavailable",
          { archiveState: error.archiveState },
        );
      }
      throw error;
    }
  });
  context.app.get(`${context.v2Prefix}/analytics/home-performance`, async (request, response) => {
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
    const sensors = context.database.listSensors(house.id)
      .filter((sensor) => sensor.enabled && access.sensor(sensor.id))
      .sort((left, right) => left.id.localeCompare(right.id));
    const definitions = context.database.listMeasurementDefinitions(false);
    const authorization = context.streamAuthorizationFingerprint(request, response) ?? "bootstrap";
    const evaluatedBucket = Math.floor(Date.now() / 60_000);
    const key = `home:${house.id}:${cacheKey([
      requestedDataMode,
      HOME_PERFORMANCE_VERSION,
      evaluatedBucket,
      authorization,
      sensors.map((sensor) => sensor.id),
      house.updatedAt,
      definitions.map((definition) => [definition.id, definition.enabled, definition.unit]),
    ])}`;
    const hit = homePerformanceCache.has(key);
    try {
      const result = await homePerformanceCache.getOrLoad(
        key,
        (signal) => getHomePerformance({
          house,
          sensors,
          definitions,
          dataMode: requestedDataMode,
          database: context.database,
          telemetryReader: context.telemetryReader,
          evaluatedAt: new Date().toISOString(),
          signal,
        }),
        { serveStale: false, ttlMs: 60_000 },
      );
      response.setHeader("cache-control", "private, no-store");
      response.json({
        ...result,
        cache: { ...result.cache, hit },
      });
    } catch (error) {
      if (error instanceof HomePerformanceScopeError) {
        throw new HttpError(422, error.code, error.message);
      }
      throw error;
    }
  });
  context.app.get(`${context.v2Prefix}/monitoring/houses`, (request, response) => {
    const requestedDataMode = dataMode(request.query.dataMode);
    const activeDataMode = context.database.isRealDataMode() ? "live" : "demo";
    if (requestedDataMode !== activeDataMode) {
      throw new HttpError(
        409,
        "ANALYTICS_DATA_MODE_MISMATCH",
        `This local database is in ${activeDataMode} mode; cross-mode monitoring queries are not allowed`,
      );
    }
    const access = context.visibility(response);
    const scopes = context.database.listHouses()
      .filter((house) => access.house(house.id))
      .map((house) => ({
        house,
        sensors: context.database.listSensors(house.id)
          .filter((sensor) => access.sensor(sensor.id)),
      }));
    const evaluatedAt = new Date().toISOString();
    response.setHeader("cache-control", "private, no-store");
    response.json(getHomeMonitoringCollection({
      database: context.database,
      latestMeasurements: (houseId) => context.cachedLatestMeasurements(houseId),
      integrationStatus: (houseId) => context.integrationStatusForHouse(houseId),
      latestWeather: (houseId) => context.weatherEvents.latest(houseId)?.weather ?? null,
      dataMode: requestedDataMode,
      evaluatedAt,
    }, scopes));
  });
  context.app.get(`${context.v2Prefix}/monitoring/houses/:houseId`, (request, response) => {
    const requestedDataMode = dataMode(request.query.dataMode);
    const include = request.query.include;
    if (include !== undefined && include !== "insights") {
      throw new HttpError(400, "INVALID_FIELD", "include must be insights");
    }
    const activeDataMode = context.database.isRealDataMode() ? "live" : "demo";
    if (requestedDataMode !== activeDataMode) {
      throw new HttpError(
        409,
        "ANALYTICS_DATA_MODE_MISMATCH",
        `This local database is in ${activeDataMode} mode; cross-mode monitoring queries are not allowed`,
      );
    }
    const houseId = request.params.houseId as string;
    const house = context.database.getHouse(houseId);
    const access = context.visibility(response);
    if (!house || !access.house(house.id)) {
      throw new HttpError(404, "ANALYTICS_SCOPE_NOT_FOUND", "Monitoring Home scope was not found");
    }
    const sensors = context.database.listSensors(house.id)
      .filter((sensor) => access.sensor(sensor.id));
    const evaluatedAt = new Date().toISOString();
    response.setHeader("cache-control", "private, no-store");
    response.json(getHomeMonitoringDetail({
      database: context.database,
      latestMeasurements: (id) => context.cachedLatestMeasurements(id),
      integrationStatus: (id) => context.integrationStatusForHouse(id),
      latestWeather: (id) => context.weatherEvents.latest(id)?.weather ?? null,
      dataMode: requestedDataMode,
      evaluatedAt,
    }, { house, sensors }));
  });
  return () => {
    removeLegacyCacheWake();
    removeMeasurementCacheWake();
  };
}
