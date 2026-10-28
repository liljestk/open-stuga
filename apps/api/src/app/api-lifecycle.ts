import { reportBackgroundFailure } from "../system-error-log.js";
import { startArchiveMaintenance } from "../timeseries/archive-maintenance.js";
import type { ApiRuntime } from "./support/api-runtime.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

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
      reportBackgroundFailure(context.systemErrorLog, {
        level: "warning", source: "telemetry-archive", code: "ARCHIVE_UNAVAILABLE",
        message: "Optional TimescaleDB archive is unavailable; SQLite buffering continues",
      });
    });
  void ready.catch(() => undefined);
  return ready;
}

interface BackgroundService {
  /** Absent for work started elsewhere or only stopped here. */
  start?: () => void;
  stop: () => void | Promise<void>;
}

/** Every background service once, with how it starts and how it stops. */
function backgroundServices(context: ApiRouteRegistrationContext): BackgroundService[] {
  const { config } = context;
  return [
    { start: () => context.tracking.start(), stop: () => context.tracking.stop() },
    { start: () => context.alertEngine.start(), stop: () => context.alertEngine.stop() },
    { start: () => context.systemUpdates.start(), stop: () => context.systemUpdates.stop() },
    { start: () => context.hostSystem.start(), stop: () => context.hostSystem.stop() },
    { start: () => context.mock.start(), stop: () => context.mock.stop() },
    { stop: () => { context.replay.stop(); } },
    { start: () => context.stuguby?.start(), stop: () => context.stuguby?.stop() },
    {
      start: () => { if (config.sensorGapRecoveryEnabled) context.sensorGapRecovery?.start(); },
      stop: () => context.sensorGapRecovery?.stop(),
    },
    { start: () => context.tapoHistory.start(), stop: () => context.tapoHistory.stop() },
    { start: () => context.homeAssistant.start(), stop: () => context.homeAssistant.stop() },
    { start: () => context.tpLink.start(), stop: () => context.tpLink.stop() },
    { start: () => context.gree.start(), stop: () => context.gree.stop() },
    { start: () => context.tuya.start(), stop: () => context.tuya.stop() },
    { start: () => context.nexus433.start(), stop: () => context.nexus433.stop() },
    { start: () => context.electricityPrices.start(), stop: () => context.electricityPrices.stop() },
    { start: () => context.weatherMonitor.start(), stop: () => context.weatherMonitor.stop() },
    {
      start: () => { if (config.dailyAnalyticsFindingsEnabled) context.dailyAnalyticsFindings.start(); },
      stop: () => context.dailyAnalyticsFindings.stop(),
    },
    { start: () => context.derivedAnalytics.start(), stop: () => context.derivedAnalytics.stop() },
    { start: () => context.scheduledDataExports.start(), stop: () => context.scheduledDataExports.stop() },
    // The outbox starts with the runtime coordination, setup and recovery on demand.
    { stop: () => context.notificationOutbox.stop() },
    { start: () => context.cloudflareAccess?.start(), stop: () => context.cloudflareAccess?.stop() },
    { stop: () => context.cloudflareSetup.stop() },
    { stop: () => context.weatherRecovery.stop() },
    { start: () => context.notifySpatial((runtime) => runtime.start()), stop: () => context.spatialLayers?.stop() },
    {
      stop: () => Promise.all([
        context.telemetryRetention?.stop() ?? Promise.resolve(),
        context.telemetryOrderedRollups?.stop() ?? Promise.resolve(),
      ]).then(() => context.telemetryArchive?.stop()),
    },
  ];
}

/** Registers every background service's stop, and starts them when the runtime runs background work. */
export function startBackgroundServices(context: ApiRouteRegistrationContext): void {
  for (const service of backgroundServices(context)) {
    context.disposers.stopOnShutdown(service.stop);
    if (context.options.startBackground) service.start?.();
  }
}

/**
 * beginShutdown stops everything registered with the runtime's disposers and
 * closes live streams; close also releases the internal wakes and closes the
 * database. Both are idempotent.
 */
export function createApiShutdown(context: ApiRouteRegistrationContext): Pick<ApiRuntime, "beginShutdown" | "close"> {
  const beginShutdown = (): Promise<void> => {
    if (context.runtimeState.shutdownPromise) return context.runtimeState.shutdownPromise;
    context.runtimeState.shutdownStarted = true;
    const stopping = context.disposers.stopAll();
    for (const closeStream of [...context.activeEventStreams]) closeStream(true);
    context.runtimeState.shutdownPromise = stopping;
    return stopping;
  };
  const close = (): Promise<void> => {
    if (context.runtimeState.closePromise) return context.runtimeState.closePromise;
    if (context.runtimeState.closed) return Promise.resolve();
    context.runtimeState.closed = true;
    context.disposers.releaseAll();
    context.runtimeState.closePromise = beginShutdown().then(() => { context.database.close(); });
    return context.runtimeState.closePromise;
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
