import { startArchiveMaintenance } from "../timeseries/archive-maintenance.js";
import type { IntegrationDiscoveryJobs } from "../integration-discovery-jobs.js";
import type { ApiRuntime } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Handles owned by route modules that shutdown must release. */
export interface RouteLifecycleHandles {
  integrationDiscoveryJobs: IntegrationDiscoveryJobs;
  removeAnalyticsCacheWake: () => void;
}

/**
 * Starts TimescaleDB archive maintenance when background work is enabled.
 * The promise rejects only when the archive is required; an optional archive
 * keeps SQLite buffering and the worker retries.
 */
export function startTelemetryArchive(context: ApiRouteRegistrationContext): Promise<void> {
  if (!context.options.startBackground || !context.telemetryArchive) return Promise.resolve();
  const starting = startArchiveMaintenance(context.telemetryArchive, context.telemetryOrderedRollups, context.telemetryRetention);
  const ready = context.config.timeseriesRequired
    ? starting
    : starting.catch(() => {
      // Never log connection configuration: it contains a database credential.
      console.error("[telemetry-archive] Optional TimescaleDB archive is unavailable; SQLite buffering continues");
    });
  void ready.catch(() => undefined);
  return ready;
}

/** Starts every background service when the runtime was created with startBackground. */
export function startBackgroundServices(context: ApiRouteRegistrationContext): void {
  if (!context.options.startBackground) return;
  context.tracking.start();
  context.systemUpdates.start();
  context.hostSystem.start();
  context.stuguby?.start();
  context.cloudflareAccess?.start();
  context.alertEngine.start();
  context.mock.start();
  context.homeAssistant.start();
  context.tpLink.start();
  context.gree.start();
  context.tuya.start();
  context.nexus433.start();
  context.tapoHistory.start();
  if (context.config.sensorGapRecoveryEnabled) context.sensorGapRecovery?.start();
  context.electricityPrices.start();
  context.weatherMonitor.start();
  if (context.config.dailyAnalyticsFindingsEnabled) context.dailyAnalyticsFindings.start();
  context.derivedAnalytics.start();
  context.scheduledDataExports.start();
  context.notifySpatial((runtime) => runtime.start());
}

/**
 * beginShutdown stops background work and closes live streams; close also
 * removes the internal wakes and closes the database. Both are idempotent.
 */
export function createApiShutdown(
  context: ApiRouteRegistrationContext,
  handles: RouteLifecycleHandles,
): Pick<ApiRuntime, "beginShutdown" | "close"> {
  const beginShutdown = (): Promise<void> => {
    if (context.shutdownPromise) return context.shutdownPromise;
    context.shutdownStarted = true;
    context.tracking.stop();
    context.alertEngine.stop();
    context.systemUpdates.stop();
    context.hostSystem.stop();
    context.mock.stop();
    context.replay.stop();
    const stoppingStuguby = context.stuguby?.stop() ?? Promise.resolve();
    const stoppingSensorGapRecovery = context.sensorGapRecovery?.stop() ?? Promise.resolve();
    const stoppingTapoHistory = context.tapoHistory.stop();
    context.homeAssistant.stop();
    context.tpLink.stop();
    context.gree.stop();
    context.tuya.stop();
    const stoppingNexus433 = context.nexus433.stop();
    handles.integrationDiscoveryJobs.stop();
    context.electricityPrices.stop();
    context.weatherMonitor.stop();
    const stoppingDailyAnalyticsFindings = context.dailyAnalyticsFindings.stop();
    const stoppingDerivedAnalytics = context.derivedAnalytics.stop();
    context.scheduledDataExports.stop();
    for (const closeStream of [...context.activeEventStreams]) closeStream(true);
    context.shutdownPromise = Promise.all([
      context.notificationOutbox.stop(),
      stoppingStuguby,
      context.cloudflareAccess?.stop() ?? Promise.resolve(),
      context.cloudflareSetup.stop(),
      stoppingSensorGapRecovery,
      stoppingTapoHistory,
      stoppingNexus433,
      context.weatherRecovery.stop(),
      stoppingDailyAnalyticsFindings,
      stoppingDerivedAnalytics,
      context.spatialLayers?.stop() ?? Promise.resolve(),
      Promise.all([
        context.telemetryRetention?.stop() ?? Promise.resolve(),
        context.telemetryOrderedRollups?.stop() ?? Promise.resolve(),
      ]).then(() => context.telemetryArchive?.stop()),
    ]).then(() => undefined);
    return context.shutdownPromise;
  };
  const close = (): Promise<void> => {
    if (context.closePromise) return context.closePromise;
    if (context.closed) return Promise.resolve();
    context.closed = true;
    context.removeSnapshotMutationWake();
    context.removeSnapshotMeasurementWake();
    context.removeNotificationWake();
    context.removeSpatialLayerWake();
    handles.removeAnalyticsCacheWake();
    context.removeWeatherTelemetryBridge();
    context.removeWeatherProjector();
    context.closePromise = beginShutdown().then(() => { context.database.close(); });
    return context.closePromise;
  };
  return { beginShutdown, close };
}

/** The public runtime handle returned by createApi. */
export function buildApiRuntime(
  context: ApiRouteRegistrationContext,
  lifecycle: Pick<ApiRuntime, "beginShutdown" | "close"> & { runtimeReady: Promise<void> },
): ApiRuntime {
  return {
    app: context.app,
    database: context.database,
    systemErrorLog: context.systemErrorLog,
    integrationMetadata: context.integrationMetadata,
    bus: context.bus,
    telemetry: context.telemetry,
    measurements: context.measurements,
    mock: context.mock,
    replay: context.replay,
    status: context.status,
    homeAssistant: context.homeAssistant,
    tpLink: context.tpLink,
    gree: context.gree,
    heatPumpStates: context.heatPumpStates,
    tuya: context.tuya,
    connectedDevices: context.connectedDevices,
    tapoHistory: context.tapoHistory,
    electricityPrices: context.electricityPrices,
    telegram: context.telegram,
    weather: context.weather,
    weatherMonitor: context.weatherMonitor,
    dailyAnalyticsFindings: context.dailyAnalyticsFindings,
    scheduledDataExports: context.scheduledDataExports,
    weatherRecovery: context.weatherRecovery,
    sensorGapRecovery: context.sensorGapRecovery,
    weatherEvents: context.weatherEvents,
    dataMode: context.dataMode,
    notificationOutbox: context.notificationOutbox,
    dataOperations: context.dataOperations,
    energyOptimizer: context.energyOptimizer,
    energyCost: context.energyCost,
    setupDoctor: context.setupDoctor,
    cloudflareAccess: context.cloudflareAccess,
    cloudflareSetup: context.cloudflareSetup,
    spatialLayers: context.spatialLayers,
    timeseries: context.timeseries,
    telemetryArchive: context.telemetryArchive,
    telemetryReader: context.telemetryReader,
    stuguby: context.stuguby,
    tracking: context.tracking,
    systemUpdates: context.systemUpdates,
    systemStorage: context.systemStorage,
    hostSystem: context.hostSystem,
    derivedAnalytics: context.derivedAnalytics,
    ready: () => lifecycle.runtimeReady,
    beginShutdown: lifecycle.beginShutdown,
    close: lifecycle.close,
  };
}
