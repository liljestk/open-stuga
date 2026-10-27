import express from "express";
import type {
  OpeningStateObservation,
  MeasurementSample,
  Reading,
  Sensor,
} from "@climate-twin/contracts";
import {
  outdoorLocationKey,
  type TelemetryCascadeScope,
} from "../db.js";
import { testHomeAssistantCredentials } from "../home-assistant.js";
import {
  FmiWeatherProvider,
  WeatherService,
} from "../weather.js";
import { LocationDiscoveryService } from "../location-discovery.js";
import { AutomaticWeatherProvider, OpenMeteoWeatherProvider } from "../open-meteo.js";
import { WeatherMonitor } from "../weather-monitor.js";
import { WeatherRecoveryCoordinator } from "../weather-recovery.js";
import {
  InMemoryWeatherEventBroker,
} from "../weather-events.js";
import {
  ElectricityPriceService,
} from "../electricity-prices.js";
import {
  createLocalSpatialLayerRuntime,
  type LocalSpatialLayerRuntime,
} from "../spatial-layers/index.js";
import { HttpError, persistWeatherObservation } from "./support/index.js";
import { configureApiPart03 } from "./part-03.js";

type DeferredContext = {
  spatialLayers: LocalSpatialLayerRuntime | null;
};


export function configureApiPart04(context: ReturnType<typeof configureApiPart03>) {
  const deferred = context as typeof context & DeferredContext;
  const config = context.config;
  const electricityPrices = new ElectricityPriceService(
      context.database,
      context.options.electricityPriceFetcher ?? fetch,
      undefined,
      {
        allowPrivateNetwork: config.electricityAllowPrivateEndpoints,
        ...(context.options.electricityEndpointResolver ? { resolver: context.options.electricityEndpointResolver } : {}),
      },
      () => context.telemetryArchive?.reconcileNow(),
    );
  const homeAssistantCredentialTester = context.options.homeAssistantCredentialTester ?? testHomeAssistantCredentials;
  const tpLinkCredentialTester = context.options.tpLinkCredentialTester
      ?? ((host: string, username: string, password: string) => context.tpLink.testCredentials(host, username, password));
  const locationDiscovery = context.options.locationDiscovery ?? new LocationDiscoveryService();
  const weatherProvider = context.options.weatherProvider ?? new AutomaticWeatherProvider(
        new FmiWeatherProvider(),
        new OpenMeteoWeatherProvider(),
      );
  const weatherRecovery = new WeatherRecoveryCoordinator(context.database, weatherProvider, {
      telemetryReader: context.telemetryReader,
      onRecovered: () => context.telemetryArchive?.reconcileNow(),
    });
  const weather = new WeatherService(
      weatherProvider,
      context.status.value.weather,
      () => context.status.changed(),
      undefined,
      undefined,
      undefined,
      weatherRecovery,
      context.database,
    );
  const weatherEvents = context.options.weatherEventBroker ?? new InMemoryWeatherEventBroker();
  const removeWeatherProjector = weatherEvents.addProjector((event) => {
      persistWeatherObservation(context.database, event.weather, context.dataMode);
      void context.telemetryArchive?.reconcileNow().catch(() => undefined);
    });
  const removeWeatherTelemetryBridge = weatherEvents.subscribe((event) => {
      context.bus.publish({ type: "weather", data: event });
    });
  const weatherMonitor = new WeatherMonitor({
      houses: context.database,
      weather,
      // Polling is an input adapter: providers do not need native push support.
      persist: async (result) => {
        context.database.saveWeatherSnapshot(result, outdoorLocationKey(result.location));
        try {
          await weatherEvents.publish(result, "scheduled-refresh");
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown projection failure";
          console.error(`[weather] Snapshot stored, but live projection failed: ${message}`);
        }
      },
      persistFailure: (house, error, attemptedAt) => {
        if (!house.location) return;
        const message = (error instanceof Error && error.message.trim()
          ? error.message.trim()
          : "Weather refresh failed").slice(0, 1000);
        const connection = context.status.value.weather.connections
          ?.find((candidate) => candidate.houseId === house.id);
        const statusChanged = context.status.value.weather.error !== message
          || (connection !== undefined && connection.error !== message);
        context.status.value.weather.error = message;
        if (connection) connection.error = message;
        if (statusChanged) context.status.changed();
        context.database.noteWeatherSnapshotFailure(
          house.id,
          outdoorLocationKey(house.location),
          error,
          attemptedAt,
        );
      },
    });
  const app = express();
  app.disable("x-powered-by");
  // Security middleware classifies route prefixes before Express dispatches.
    // Keep dispatch case-sensitive so mixed-case paths cannot cross auth zones.
    app.set("case sensitive routing", true);
  const initialSpatialLayers: LocalSpatialLayerRuntime | null = null;
  Object.assign(context, { spatialLayers: initialSpatialLayers });
  if (config.spatialLayersEnabled ?? false) {
      try {
        deferred.spatialLayers = createLocalSpatialLayerRuntime({
          coreDatabase: context.database,
          telemetryReader: context.telemetryReader,
          coreDatabasePath: config.databasePath,
          dataMode: context.database.isRealDataMode() ? "real" : "demo",
          startBackground: false,
          admission: {
            acquire: () => context.analyticsWorkLimiter.acquireLowPriority(
              "spatial-inference",
              context.admitLowPriority,
            ),
          },
          ...(config.spatialLayersDatabasePath === undefined ? {} : { statePath: config.spatialLayersDatabasePath }),
          ...(config.spatialLayersIntervalMs === undefined ? {} : { intervalMs: config.spatialLayersIntervalMs }),
          ...(config.spatialLayersRetentionDays === undefined ? {} : { retentionDays: config.spatialLayersRetentionDays }),
        });
      } catch (error) {
        // This optional research subsystem must never prevent the core API from
        // starting. Its routes remain available and report 503 while disabled.
        const message = error instanceof Error ? error.message : "unknown startup failure";
        console.error(`[spatial-layers] Optional engine unavailable: ${message}`);
      }
    }
  const notifySpatial = (operation: (runtime: LocalSpatialLayerRuntime) => void): void => {
      if (!deferred.spatialLayers) return;
      try {
        operation(deferred.spatialLayers);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown notification failure";
        // Core writes are authoritative and may already be committed. An
        // optional derived subsystem must never turn that successful mutation
        // into an HTTP failure; its periodic scheduler can reconcile later.
        console.error(`[spatial-layers] Optional change notification failed: ${message}`);
      }
    };
  context.notifyOpeningStateRecorded = (observation: OpeningStateObservation): void => {
      context.bus.publish({ type: "opening", data: observation });
      void context.telemetryArchive?.reconcileNow().catch(() => undefined);
      notifySpatial((runtime) => runtime.scheduler.wakeHouse(
        observation.houseId,
        null,
        observation.observedAt,
        "property-context-changed",
      ));
    };
  const notifySpatialSensorChange = (before: Sensor | null, after: Sensor | null): void => {
      const houseIds = [...new Set([before?.houseId, after?.houseId].filter((id): id is string => Boolean(id)))];
      if (houseIds.length === 0) return;
      const observedAt = new Date().toISOString();
      notifySpatial((runtime) => {
        for (const houseId of houseIds) {
          runtime.scheduler.wakeHouse(houseId, null, observedAt, "sensor-context-changed");
        }
      });
    };
  // Authentication decisions use the real socket address. Proxy headers must
    // never turn a remote first-owner setup request into a loopback request.
    app.disable("trust proxy");
  context.dataMode.onActivated(() => {
      context.mock.stop();
      context.replay.reset();
      context.derivedAnalytics.handleDataModeActivated();
      notifySpatial((runtime) => runtime.handleDataModeActivated("real"));
      context.telemetryArchive?.enforceRealDataBoundary();
      context.status.refreshDataMode();
    });
  const invalidateSnapshotCaches = (): void => {
      context.measurementSnapshotCache.clear();
      context.readingSnapshotCache.clear();
    };
  const cachedLatestMeasurements = (houseId?: string): MeasurementSample[] => {
      const key = houseId ? `house:${houseId}` : "all";
      const cached = context.measurementSnapshotCache.get(key);
      if (cached) return cached;
      const loaded = context.database.latestMeasurementSamples(houseId);
      context.measurementSnapshotCache.set(key, loaded);
      return loaded;
    };
  const cachedLatestReadings = (): Reading[] => {
      const cached = context.readingSnapshotCache.get("all");
      if (cached) return cached;
      const loaded = context.database.latestReadings();
      context.readingSnapshotCache.set("all", loaded);
      return loaded;
    };
  const requireArchivedBeforeCascade = async (scope: TelemetryCascadeScope, resourceId: string): Promise<void> => {
      if (!context.telemetryArchive) {
        if (context.database.hasRealTelemetryForCascade(scope, resourceId)) {
          throw new HttpError(
            409,
            "TELEMETRY_ARCHIVE_REQUIRED",
            "This change would erase the only copy of retained telemetry; enable and reconcile the archive first",
          );
        }
        return;
      }
      try {
        await context.telemetryArchive.reconcileNow();
      } catch {
        throw new HttpError(
          503,
          "TELEMETRY_ARCHIVE_NOT_READY",
          "Telemetry must be durably archived before deleting a telemetry-owning resource",
        );
      }
      if (!context.telemetryArchive.status().caughtUp) {
        throw new HttpError(
          503,
          "TELEMETRY_ARCHIVE_NOT_READY",
          "Telemetry must be durably archived before deleting a telemetry-owning resource",
        );
      }
    };
  const requireImmutableTelemetryLineage = (
      scope: Exclude<TelemetryCascadeScope, "house-location">,
      resourceId: string,
    ): void => {
      if (!context.database.hasRealTelemetryForCascade(scope, resourceId)) return;
      throw new HttpError(
        409,
        "TELEMETRY_LINEAGE_REQUIRED",
        "Resources with real telemetry cannot be moved or deleted until immutable historical ownership context is available; disable the resource instead",
      );
    };
  const removeSnapshotMeasurementWake = context.bus.subscribeMeasurements(invalidateSnapshotCaches);
  const extended = Object.assign(context, { electricityPrices, homeAssistantCredentialTester, tpLinkCredentialTester, locationDiscovery, weatherProvider, weatherRecovery, weather, weatherEvents, removeWeatherProjector, removeWeatherTelemetryBridge, weatherMonitor, app, notifySpatial, notifySpatialSensorChange, invalidateSnapshotCaches, cachedLatestMeasurements, cachedLatestReadings, requireArchivedBeforeCascade, requireImmutableTelemetryLineage, removeSnapshotMeasurementWake });
  return extended as typeof extended & { spatialLayers: LocalSpatialLayerRuntime | null };
}
