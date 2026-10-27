import { withResponseSignal } from "../../app/response-signal.js";
import { createHash } from "node:crypto";
import type express from "express";
import type {
  DataMode,
  DerivedAnalyticsWarning,
  HomeMonitoringCollectionResponse,
  HomeMonitoringDetailResponse,
  IntegrationStatus,
  MeasurementSample,
} from "@climate-twin/contracts";
import { HttpError } from "../../app/support/index.js";
import { LruTtlCache } from "../../cache.js";
import type { ClimateDatabase } from "../../db.js";
import type { TelemetryBus } from "../../events.js";
import {
  IncompleteTelemetryHistoryError,
  type HybridTelemetryReader,
} from "../../timeseries/read-facade.js";
import type { WeatherEventBroker } from "../../weather-events.js";
import type { AnalyticsWorkLimiter } from "../work-limiter.js";
import {
  getHomeMonitoringCollection,
  getHomeMonitoringDetail,
  loadHomeMonitoringHistory,
} from "./service.js";

interface HomeMonitoringRouteContext {
  app: express.Express;
  v2Prefix: string;
  database: ClimateDatabase;
  telemetryReader: HybridTelemetryReader;
  bus: TelemetryBus;
  analyticsWorkLimiter: AnalyticsWorkLimiter;
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

interface HomeMonitoringHistoryResult {
  history: Awaited<ReturnType<typeof loadHomeMonitoringHistory>>;
  warning: DerivedAnalyticsWarning | null;
}

function incompleteHistoryResult(error: IncompleteTelemetryHistoryError): HomeMonitoringHistoryResult {
  return {
    history: {},
    warning: {
      code: error.code,
      message: "Trend history is temporarily unavailable while the telemetry archive recovers.",
      details: { archiveState: error.archiveState },
    },
  };
}

function dataMode(value: unknown): DataMode {
  if (value !== "live" && value !== "demo") {
    throw new HttpError(400, "INVALID_DATA_MODE", "dataMode must be live or demo");
  }
  return value;
}

function cacheKey(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function registerHomeMonitoringRoutes(context: HomeMonitoringRouteContext): () => void {
  const collectionCache = new LruTtlCache<HomeMonitoringCollectionResponse>({
    maxEntries: 64,
    maxBytes: 8 * 1024 * 1024,
    defaultTtlMs: 2_000,
  });
  const detailCache = new LruTtlCache<HomeMonitoringDetailResponse>({
    maxEntries: 128,
    maxBytes: 16 * 1024 * 1024,
    defaultTtlMs: 2_000,
  });
  const historyCache = new LruTtlCache<HomeMonitoringHistoryResult>({
    maxEntries: 128,
    maxBytes: 32 * 1024 * 1024,
    defaultTtlMs: 60_000,
  });
  const removeCollectionStats = context.analyticsWorkLimiter.registerCache(
    "home-monitoring-collection",
    () => collectionCache.stats(),
  );
  const removeDetailStats = context.analyticsWorkLimiter.registerCache(
    "home-monitoring-detail",
    () => detailCache.stats(),
  );
  const removeHistoryStats = context.analyticsWorkLimiter.registerCache(
    "home-monitoring-history",
    () => historyCache.stats(),
  );
  const removeCacheWake = context.bus.subscribe((event) => {
    if (
      event.type === "heartbeat"
      || event.type === "reading"
      || event.type === "measurement"
    ) return;
    collectionCache.clear();
    detailCache.clear();
    historyCache.clear();
  });

  context.app.get(`${context.v2Prefix}/monitoring/houses`, async (request, response) => {
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
    const authorization = context.streamAuthorizationFingerprint(request, response) ?? "bootstrap";
    const key = `monitoring:collection:${cacheKey([
      requestedDataMode,
      Math.floor(Date.now() / 2_000),
      authorization,
      scopes.map((scope) => [
        scope.house.id,
        scope.house.updatedAt,
        scope.sensors,
      ]),
    ])}`;
    const hit = collectionCache.has(key);
    const coalesced = !hit && collectionCache.isLoading(key);
    const startedAt = performance.now();
    const result = await collectionCache.getOrLoad(key, () => {
      const evaluatedAt = new Date().toISOString();
      return getHomeMonitoringCollection({
        database: context.database,
        latestMeasurements: (houseId) => context.cachedLatestMeasurements(houseId),
        integrationStatus: (houseId) => context.integrationStatusForHouse(houseId),
        latestWeather: (houseId) => context.weatherEvents.latest(houseId)?.weather ?? null,
        dataMode: requestedDataMode,
        evaluatedAt,
      }, scopes);
    }, { serveStale: false, ttlMs: 2_000 });
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("x-stugu-cache", hit ? "hit" : coalesced ? "coalesced" : "miss");
    response.setHeader(
      "server-timing",
      `home-monitoring-collection;dur=${(performance.now() - startedAt).toFixed(1)}`,
    );
    response.json(result);
  });

  context.app.get(`${context.v2Prefix}/monitoring/houses/:houseId`, async (request, response) => {
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
    const authorization = context.streamAuthorizationFingerprint(request, response) ?? "bootstrap";
    const key = `monitoring:detail:${house.id}:${cacheKey([
      requestedDataMode,
      Math.floor(Date.now() / 2_000),
      authorization,
      house.updatedAt,
      sensors,
    ])}`;
    const hit = detailCache.has(key);
    const coalesced = !hit && detailCache.isLoading(key);
    const startedAt = performance.now();
    const result = await withResponseSignal(response, (requestSignal) => detailCache.getOrLoad(key, async (signal) => {
      const evaluatedAt = new Date().toISOString();
      const scope = { house, sensors };
      const historyKey = `monitoring:history:${house.id}:${cacheKey([
        Math.floor(Date.now() / 60_000),
        house.updatedAt,
        sensors,
      ])}`;
      const historyResult = await historyCache.getOrLoad(
        historyKey,
        async (historySignal) => {
          try {
            return {
              history: await context.analyticsWorkLimiter.run(
                "home-monitoring-history",
                () => loadHomeMonitoringHistory({
                  database: context.database,
                  telemetryReader: context.telemetryReader,
                  scope,
                  evaluatedAt,
                  signal: historySignal,
                }),
                historySignal,
              ),
              warning: null,
            };
          } catch (error) {
            if (error instanceof IncompleteTelemetryHistoryError) return incompleteHistoryResult(error);
            throw error;
          }
        },
        { serveStale: false, ttlMs: 60_000, signal },
      );
      return getHomeMonitoringDetail({
        database: context.database,
        latestMeasurements: (id) => context.cachedLatestMeasurements(id),
        integrationStatus: (id) => context.integrationStatusForHouse(id),
        latestWeather: (id) => context.weatherEvents.latest(id)?.weather ?? null,
        dataMode: requestedDataMode,
        evaluatedAt,
        measurementHistory: historyResult.history,
        ...(historyResult.warning ? { warnings: [historyResult.warning] } : {}),
      }, scope);
    }, {
      serveStale: false,
      ttlMs: 2_000,
      signal: requestSignal,
    }));
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("x-stugu-cache", hit ? "hit" : coalesced ? "coalesced" : "miss");
    response.setHeader(
      "server-timing",
      `home-monitoring-detail;dur=${(performance.now() - startedAt).toFixed(1)}`,
    );
    response.json(result);
  });

  return () => {
    removeCacheWake();
    removeCollectionStats();
    removeDetailStats();
    removeHistoryStats();
  };
}
