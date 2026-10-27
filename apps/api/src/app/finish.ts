import type { ApiRuntime } from "./support/index.js";
import { configureApiPart28 } from "./part-28.js";

export function finishCreateApi(context: ReturnType<typeof configureApiPart28>): ApiRuntime {
  const { database, systemErrorLog, tracking, systemUpdates, systemStorage, hostSystem, cloudflareSetup, dataOperations, energyOptimizer, integrationMetadata, cloudflareAccess, dataMode, bus, stuguby, timeseries, telemetryArchive, telemetryReader, dailyAnalyticsFindings, scheduledDataExports, status, setupDoctor, energyCost, telegram, telemetry, measurements, notificationOutbox, mock, replay, sensorGapRecovery, tpLink, gree, heatPumpStates, tuya, connectedDevices, tapoHistory, homeAssistant, electricityPrices, weatherRecovery, weather, weatherEvents, weatherMonitor, app, spatialLayers, runtimeReady, beginShutdown, close } = context;
  return {
    app, database, systemErrorLog, integrationMetadata, bus, telemetry, measurements, mock, replay, status, homeAssistant, tpLink, gree, heatPumpStates, tuya, connectedDevices, tapoHistory, electricityPrices, telegram, weather, weatherMonitor, dailyAnalyticsFindings, scheduledDataExports,
    weatherRecovery, sensorGapRecovery, weatherEvents, dataMode, notificationOutbox, dataOperations, energyOptimizer, energyCost, setupDoctor, cloudflareAccess, cloudflareSetup, spatialLayers, timeseries, telemetryArchive, telemetryReader, stuguby, tracking, systemUpdates, systemStorage, hostSystem,
    derivedAnalytics: context.derivedAnalytics,
    ready: () => runtimeReady,
    beginShutdown,
    close,
  };
}
