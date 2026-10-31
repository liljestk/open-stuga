import type { ApiRuntime, CreateApiOptions } from "./support/api-runtime.js";
import { resolveApiConfig } from "./api-config.js";
import { createCoreDataServices } from "./core-data-services.js";
import { createTelemetryServices } from "./telemetry-services.js";
import { createSpatialLayerServices } from "./spatial-layer-services.js";
import { createIntegrationBridges } from "./integration-bridges.js";
import { createExternalFeedServices } from "./external-feed-services.js";
import { createRuntimeCoordination } from "./runtime-coordination.js";
import { installRequestPipeline } from "./request-pipeline.js";
import { installAccessControl } from "./access-control.js";
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
import { AssistantAuthorizationServer } from "../assistant-connector/authorization-server.js";
import { AssistantConnectorStore } from "../assistant-connector/store.js";
import { registerAssistantConnectorProtocolRoutes, registerAssistantConnectorRoutes } from "./assistant-connector-routes.js";
import { requestOrigin } from "./support/origins.js";
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
import { registerGreeRoutes } from "./gree-routes.js";
import { registerTuyaRoutes } from "./tuya-routes.js";
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
  // Composition: each step adds the services it owns to the shared context,
  // in dependency order (spatial layers before the bridges that notify them).
  const config = resolveApiConfig({ options });
  const coreData = createCoreDataServices(config);
  const telemetry = createTelemetryServices(coreData);
  const spatial = createSpatialLayerServices(telemetry);
  const bridges = createIntegrationBridges(spatial);
  const feeds = createExternalFeedServices(bridges);
  const localMcpRuntime = new LocalMcpRuntimeService();
  const runtimeCoordination = createRuntimeCoordination(feeds);
  const assistantConnector = new AssistantAuthorizationServer(new AssistantConnectorStore(runtimeCoordination.database));
  // The MCP bearer route and the assistant OAuth endpoints authenticate
  // themselves and must precede browser sessions.
  registerAssistantConnectorProtocolRoutes(runtimeCoordination, assistantConnector);
  registerLocalMcpTransportRoute(runtimeCoordination, localMcpRuntime, {
    origin: (request) => requestOrigin(request, runtimeCoordination.config),
    verifyAccessToken: (token, origin) => assistantConnector.verifyAccessToken(token, origin),
  });
  const pipeline = installRequestPipeline(runtimeCoordination);
  const context = installAccessControl(pipeline);

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
  registerAssistantConnectorRoutes(context, assistantConnector);
  registerMeasurementIngestRoutes(context);
  registerMeasurementHistoryRoutes(context);
  registerPropertyRoutes(context);
  context.disposers.stopOnShutdown(registerElectricityRoutes(context));
  context.disposers.stopOnShutdown(registerEnergyOptimizationRoute(context));
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
  context.disposers.releaseOnClose(registerAnalyticsRoutes(context));
  registerStaticParameterRoutes(context);
  registerAssetRoutes(context);
  registerIntegrationStatusRoutes(context);
  const integrationDiscoveryJobs = registerIntegrationDiscoveryRoutes(context);
  context.disposers.stopOnShutdown(() => integrationDiscoveryJobs.stop());
  registerTelegramRoutes(context);
  registerAppleNotesRoutes(context);
  registerHomeAssistantRoutes(context);
  registerTpLinkRoutes(context);
  registerTapoHistoryRoutes(context);
  registerDemoDataRoutes(context);
  registerTrackingApiRoutes(context);
  registerSpatialLayerApiRoutes(context);
  registerApiErrorHandling(context);

  context.disposers.stopOnShutdown(async () => { await localMcpRuntime.stop().catch(() => undefined); });
  const runtimeReady = startTelemetryArchive(context);
  startBackgroundServices(context);
  return buildApiRuntime(context, { runtimeReady, ...createApiShutdown(context) });
}
