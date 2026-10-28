import express from "express";
import type { IntegrationDiscoveryResult } from "@climate-twin/contracts";
import { ClimateDatabase } from "../../db.js";
import { TelemetryBus } from "../../events.js";
import { HomeAssistantBridge } from "../../home-assistant.js";
import { TpLinkBridge } from "../../tp-link.js";
import { GreeBridge } from "../../gree.js";
import { HeatPumpStateStore } from "../../heat-pump-state.js";
import { TuyaBridge } from "../../tuya.js";
import { ConnectedDeviceStore } from "../../connected-device-store.js";
import { IntegrationMetadataStore } from "../../integration-metadata.js";
import { WeatherService, type WeatherProvider } from "../../weather.js";
import { DataModeCoordinator, MeasurementService, MockEngine, ReplayEngine, RuntimeStatus, TelemetryService } from "../../services.js";
import { SystemUpdateService } from "../../system-updates.js";
import { SystemStorageService } from "../../system-storage.js";
import { HostSystemMonitor } from "../../host-system.js";
import { SystemErrorLog } from "../../system-error-log.js";
import { WeatherMonitor } from "../../weather-monitor.js";
import { DailyAnalyticsFindingsWorker } from "../../daily-analytics-findings.js";
import { ScheduledDataExportService } from "../../scheduled-data-exports.js";
import { WeatherRecoveryCoordinator } from "../../weather-recovery.js";
import { SensorGapRecoveryCoordinator } from "../../sensor-gap-recovery.js";
import { TapoHistoryExportService } from "../../tapo-history-export.js";
import type { WeatherEventBroker } from "../../weather-events.js";
import { TelegramService } from "../../telegram.js";
import { NotificationOutboxWorker } from "../../outbox.js";
import { ElectricityPriceService, type ElectricityEndpointResolver } from "../../electricity-prices.js";
import { CloudflareAccessGroupSynchronizer } from "../../cloudflare-access.js";
import { CloudflareSetupService } from "../../cloudflare-setup.js";
import type { LocalSpatialLayerRuntime } from "../../spatial-layers/index.js";
import { DataOperationsService } from "../../data-operations.js";
import { EnergyOptimizer } from "../../energy-optimizer.js";
import { EnergyCostService } from "../../energy-cost.js";
import { SetupDoctor } from "../../setup-doctor.js";
import { TimeseriesStore } from "../../timeseries/store.js";
import { TelemetryArchiveWorker } from "../../timeseries/archive-worker.js";
import { HybridTelemetryReader } from "../../timeseries/read-facade.js";
import { StugubyService } from "../../stuguby/service.js";
import { TrackingService } from "../../tracking/service.js";
import type { AppConfigInput } from "../../config/api-defaults.js";
import { LocationDiscoveryService } from "../../location-discovery.js";

export interface ApiRuntime {
  app: express.Express;
  database: ClimateDatabase;
  integrationMetadata: IntegrationMetadataStore;
  bus: TelemetryBus;
  telemetry: TelemetryService;
  measurements: MeasurementService;
  mock: MockEngine;
  replay: ReplayEngine;
  status: RuntimeStatus;
  homeAssistant: HomeAssistantBridge;
  tpLink: TpLinkBridge;
  gree: GreeBridge;
  heatPumpStates: HeatPumpStateStore;
  tuya: TuyaBridge;
  connectedDevices: ConnectedDeviceStore;
  tapoHistory: TapoHistoryExportService;
  electricityPrices: ElectricityPriceService;
  telegram: TelegramService;
  weather: WeatherService;
  weatherMonitor: WeatherMonitor;
  dailyAnalyticsFindings: DailyAnalyticsFindingsWorker;
  derivedAnalytics: import("../../analytics/derived-artifacts/coordinator.js").DerivedAnalyticsCoordinator;
  scheduledDataExports: ScheduledDataExportService;
  weatherRecovery: WeatherRecoveryCoordinator;
  sensorGapRecovery: SensorGapRecoveryCoordinator;
  weatherEvents: WeatherEventBroker;
  dataMode: DataModeCoordinator;
  notificationOutbox: NotificationOutboxWorker;
  dataOperations: DataOperationsService;
  energyOptimizer: EnergyOptimizer;
  energyCost: EnergyCostService;
  setupDoctor: SetupDoctor;
  cloudflareAccess: CloudflareAccessGroupSynchronizer | null;
  cloudflareSetup: CloudflareSetupService;
  spatialLayers: LocalSpatialLayerRuntime | null;
  timeseries: TimeseriesStore | null;
  telemetryArchive: TelemetryArchiveWorker | null;
  telemetryReader: HybridTelemetryReader;
  stuguby: StugubyService;
  tracking: TrackingService;
  systemUpdates: SystemUpdateService;
  systemStorage: SystemStorageService;
  hostSystem: HostSystemMonitor;
  systemErrorLog: SystemErrorLog;
  ready: () => Promise<void>;
  beginShutdown: () => Promise<void>;
  close: () => Promise<void>;
}

export interface IntegrationDraftTestResult {
  ok: boolean;
  connected: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface CreateApiOptions {
  /** Normalized by createApi, so programmatic callers may leave defaulted fields out. */
  config?: AppConfigInput;
  database?: ClimateDatabase;
  weatherProvider?: WeatherProvider;
  weatherEventBroker?: WeatherEventBroker;
  locationDiscovery?: LocationDiscoveryService;
  telegram?: TelegramService;
  homeAssistantCredentialTester?: (url: string, token: string) => Promise<IntegrationDraftTestResult>;
  tpLinkCredentialTester?: (host: string, username: string, password: string) => Promise<IntegrationDraftTestResult>;
  integrationDiscoverer?: (
    houseId?: string,
    tpLinkCredentials?: { username: string; password: string },
  ) => Promise<IntegrationDiscoveryResult>;
  electricityPriceFetcher?: typeof fetch;
  cloudflareAccessFetcher?: typeof fetch;
  cloudflareSetupFetcher?: typeof fetch;
  bugReportFetcher?: typeof fetch;
  cloudflareSetup?: CloudflareSetupService;
  stugubyFetcher?: typeof fetch;
  electricityEndpointResolver?: ElectricityEndpointResolver;
  /** Test/embedding hook; normal deployments resolve aliases from live TP-Link discovery. */
  tapoHistoryDeviceNameFor?: (sensorId: string, deviceId: string) => string | null;
  /** Test/embedding clock for durable Tapo history transitions. */
  tapoHistoryNow?: () => Date;
  /** Test/embedding clock for house-local daily peer-period findings. */
  dailyAnalyticsNow?: () => number;
  timeseriesStore?: TimeseriesStore;
  telemetryReader?: HybridTelemetryReader;
  /** Test/embedding admission seam; production defaults to live host health. */
  backgroundWorkAdmission?: () => boolean | Promise<boolean>;
  startBackground?: boolean;
}
