import { type AppConfig } from "../config.js";
import { configureApiPart27 } from "./part-27.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart28(context: ReturnType<typeof configureApiPart27>) {
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  if (context.options.startBackground) {
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
      if (config.sensorGapRecoveryEnabled) sensorGapRecovery.start();
      context.electricityPrices.start();
      context.weatherMonitor.start();
      if (config.dailyAnalyticsFindingsEnabled) context.dailyAnalyticsFindings.start();
      context.derivedAnalytics.start();
      context.scheduledDataExports.start();
      context.notifySpatial((runtime) => runtime.start());
    }
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
      const stoppingSensorGapRecovery = sensorGapRecovery.stop();
      const stoppingTapoHistory = context.tapoHistory.stop();
      context.homeAssistant.stop();
      context.tpLink.stop();
      context.gree.stop();
      context.tuya.stop();
      const stoppingNexus433 = context.nexus433.stop();
      context.integrationDiscoveryJobs.stop();
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
      context.removeAnalyticsCacheWake?.();
      context.removeWeatherTelemetryBridge();
      context.removeWeatherProjector();
      context.closePromise = beginShutdown().then(() => { context.database.close(); });
      return context.closePromise;
    };
  const extended = Object.assign(context, { beginShutdown, close });
  return extended;
}
