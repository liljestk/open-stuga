import type { ApiRuntime, CreateApiOptions } from "./support/index.js";
import { configureApiPart01 } from "./part-01.js";
import { configureApiPart02 } from "./part-02.js";
import { configureApiPart03 } from "./part-03.js";
import { configureApiPart04 } from "./part-04.js";
import { configureApiPart05 } from "./part-05.js";
import { configureApiPart06 } from "./part-06.js";
import { configureApiPart07 } from "./part-07.js";
import { registerLocalAuthRoutes } from "./local-auth-routes.js";
import { registerTenantAdministrationRoutes } from "./tenant-administration-routes.js";
import { registerSystemUpdateRoutes } from "./system-update-routes.js";
import { registerSystemStorageRoutes } from "./system-storage-routes.js";
import { registerScheduledDataExportRoutes } from "./scheduled-data-export-routes.js";
import { registerHostSystemRoutes } from "./host-system-routes.js";
import { registerCloudflareSetupRoutes } from "./cloudflare-setup-routes.js";
import { registerLocationDiscoveryRoutes } from "./location-discovery-routes.js";
import { registerMeasurementDefinitionRoutes } from "./measurement-definition-routes.js";
import { registerNexus433Routes } from "./nexus433-routes.js";
import { registerBugReportRoutes } from "./bug-report-routes.js";
import { registerLocalMcpRuntimeRoutes, registerLocalMcpTransportRoute } from "./local-mcp-runtime-routes.js";
import { LocalMcpRuntimeService } from "../local-mcp-runtime.js";
import { registerEnergyOptimizationRoute } from "./energy-optimization-route.js";
import { registerElectricityRoutes } from "./electricity-routes.js";
import { registerMeasurementIngestRoutes } from "./measurement-ingest-routes.js";
import { registerMeasurementHistoryRoutes } from "./measurement-history-routes.js";
import { registerPropertyRoutes } from "./property-routes.js";
import { registerPropertyAreaRoutes } from "./property-area-routes.js";
import { registerAreaEquipmentRoutes } from "./area-equipment-routes.js";
import { registerPropertyNoteRoutes } from "./property-note-routes.js";
import { registerHouseRoutes } from "./house-routes.js";
import { registerHouseWeatherRoutes } from "./house-weather-routes.js";
import { registerHouseLayoutRoutes } from "./house-layout-routes.js";
import { registerSensorRoutes } from "./sensor-routes.js";
import { registerTelemetryRoutes } from "./telemetry-routes.js";
import { registerAlertRoutes } from "./alert-routes.js";
import { registerNotificationRoutes } from "./notification-routes.js";
import { registerActionRoutes } from "./action-routes.js";
import { registerDataExportRoutes } from "./data-export-routes.js";
import { registerSetupRoutes } from "./setup-routes.js";
import { registerObservationRoutes } from "./observation-routes.js";
import { registerMaintenanceTaskRoutes } from "./maintenance-task-routes.js";
import { registerGreeRoutes } from "../gree-routes.js";
import { registerTuyaRoutes } from "../tuya-routes.js";
import { registerAnalyticsRoutes } from "../analytics/routes.js";
import { registerStaticParameterRoutes } from "./static-parameter-routes.js";
import { registerAssetRoutes } from "./asset-routes.js";
import { registerIntegrationStatusRoutes } from "./integration-status-routes.js";
import { registerIntegrationDiscoveryRoutes } from "./integration-discovery-routes.js";
import { registerTelegramRoutes } from "./telegram-routes.js";
import { registerAppleNotesRoutes } from "./apple-notes-routes.js";
import { registerHomeAssistantRoutes } from "./home-assistant-routes.js";
import { registerTpLinkRoutes } from "./tp-link-routes.js";
import { registerTapoHistoryRoutes } from "./tapo-history-routes.js";
import { registerDemoDataRoutes } from "./demo-data-routes.js";
import { registerTrackingApiRoutes } from "./tracking-routes.js";
import { registerSpatialLayerApiRoutes } from "./spatial-layer-routes.js";
import { registerApiErrorHandling } from "./error-handling.js";
import { buildApiRuntime, createApiShutdown, startBackgroundServices, startTelemetryArchive } from "./api-lifecycle.js";

export function createApi(options: CreateApiOptions = {}): ApiRuntime {
  const context0 = { options };
  const context1 = configureApiPart01(context0);
  const context2 = configureApiPart02(context1);
  const context3 = configureApiPart03(context2);
  const context4 = configureApiPart04(context3);
  const localMcpRuntime = new LocalMcpRuntimeService();
  const context5 = configureApiPart05(context4);
  registerLocalMcpTransportRoute(context5, localMcpRuntime);
  const context6 = configureApiPart06(context5);
  const context = configureApiPart07(context6);

  // Route families. Express matches in registration order, so the error
  // handling registered last answers every path nothing else claimed.
  registerLocalAuthRoutes(context);
  registerTenantAdministrationRoutes(context);
  registerHostSystemRoutes(context);
  registerSystemUpdateRoutes(context);
  registerSystemStorageRoutes(context);
  registerScheduledDataExportRoutes(context);
  registerCloudflareSetupRoutes(context);
  registerLocationDiscoveryRoutes(context);
  registerMeasurementDefinitionRoutes(context);
  registerNexus433Routes(context);
  registerBugReportRoutes(context);
  registerLocalMcpRuntimeRoutes(context, localMcpRuntime);
  registerMeasurementIngestRoutes(context);
  registerMeasurementHistoryRoutes(context);
  registerPropertyRoutes(context);
  const stopElectricity = registerElectricityRoutes(context);
  const stopEnergyOptimization = registerEnergyOptimizationRoute(context);
  registerPropertyAreaRoutes(context);
  registerAreaEquipmentRoutes(context);
  registerPropertyNoteRoutes(context);
  registerHouseRoutes(context);
  registerHouseWeatherRoutes(context);
  registerHouseLayoutRoutes(context);
  registerSensorRoutes(context);
  registerTelemetryRoutes(context);
  registerAlertRoutes(context);
  registerNotificationRoutes(context);
  registerActionRoutes(context);
  registerDataExportRoutes(context);
  registerSetupRoutes(context);
  registerObservationRoutes(context);
  registerMaintenanceTaskRoutes(context);
  registerGreeRoutes(context);
  registerTuyaRoutes(context);
  const removeAnalyticsCacheWake = registerAnalyticsRoutes(context);
  registerStaticParameterRoutes(context);
  registerAssetRoutes(context);
  registerIntegrationStatusRoutes(context);
  const integrationDiscoveryJobs = registerIntegrationDiscoveryRoutes(context);
  registerTelegramRoutes(context);
  registerAppleNotesRoutes(context);
  registerHomeAssistantRoutes(context);
  registerTpLinkRoutes(context);
  registerTapoHistoryRoutes(context);
  registerDemoDataRoutes(context);
  registerTrackingApiRoutes(context);
  registerSpatialLayerApiRoutes(context);
  registerApiErrorHandling(context);

  const runtimeReady = startTelemetryArchive(context);
  startBackgroundServices(context);
  const runtime = buildApiRuntime(context, {
    runtimeReady,
    ...createApiShutdown(context, { integrationDiscoveryJobs, removeAnalyticsCacheWake }),
  });
  const stopLocalMcp = async (): Promise<void> => {
    stopEnergyOptimization();
    stopElectricity();
    await localMcpRuntime.stop().catch(() => undefined);
  };
  return {
    ...runtime,
    beginShutdown: async () => {
      await Promise.all([runtime.beginShutdown(), stopLocalMcp()]);
    },
    close: async () => {
      await stopLocalMcp();
      await runtime.close();
    },
  };
}
