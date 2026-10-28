import { loadConfig, type AppConfig } from "../config.js";
import { DataOperationsService } from "../data-operations.js";
import { ClimateDatabase, ensureSqliteSpillDirectory } from "../db.js";
import { databaseTariffContext } from "../electricity/tariff-context.js";
import { EnergyCostService } from "../electricity/energy-cost.js";
import { EnergyOptimizer } from "../electricity/optimizer.js";
import { TelemetryBus } from "../events.js";
import { HomeAssistantBridge } from "../home-assistant.js";
import { LocationDiscoveryService } from "../location-discovery.js";
import { McpOperationTracker } from "./lifecycle.js";
import { AutomaticWeatherProvider, OpenMeteoWeatherProvider } from "../weather/open-meteo.js";
import { AlertEngine } from "../alerts/alert-engine.js";
import { DataModeCoordinator } from "../demo/data-mode.js";
import { MeasurementService, TelemetryService } from "../telemetry/ingest.js";
import { MockEngine } from "../demo/mock-engine.js";
import { ReplayEngine } from "../demo/replay-engine.js";
import { RuntimeStatus } from "../runtime-status.js";
import { SetupDoctor } from "../setup-doctor.js";
import { StugubyStore } from "../stuguby/store.js";
import { timeseriesPoolConfig } from "../timeseries/pool-options.js";
import { HybridTelemetryReader } from "../timeseries/read-facade.js";
import { isLocalTelemetryHistoryComplete } from "../timeseries/read-support.js";
import { TimeseriesStore } from "../timeseries/store.js";
import { TpLinkBridge } from "../tp-link.js";
import { FmiWeatherProvider, WeatherService } from "../weather.js";

/** The services one MCP process reads its local SQLite workspace (and optional archive) through. */
export interface McpRuntime {
  config: AppConfig;
  database: ClimateDatabase;
  locationDiscovery: LocationDiscoveryService;
  bus: TelemetryBus;
  stugubyStore: StugubyStore;
  dataMode: DataModeCoordinator;
  status: RuntimeStatus;
  dataOperations: DataOperationsService;
  timeseries: TimeseriesStore | null;
  telemetryReader: HybridTelemetryReader;
  energyCost: EnergyCostService;
  energyOptimizer: EnergyOptimizer;
  setupDoctor: SetupDoctor;
  alertEngine: AlertEngine;
  telemetry: TelemetryService;
  measurements: MeasurementService;
  mock: MockEngine;
  replay: ReplayEngine;
  homeAssistant: HomeAssistantBridge;
  tpLink: TpLinkBridge;
  weather: WeatherService;
  /** In-flight tool calls, drained before shutdown. */
  operations: McpOperationTracker;
}

/** Opens the configured workspace read-only and builds the services the MCP tools use. */
export function createMcpRuntime(config: AppConfig = loadConfig()): McpRuntime {
  ensureSqliteSpillDirectory(config.databasePath);
  const database = new ClimateDatabase(config.databasePath, false, { readOnly: true });
  const locationDiscovery = new LocationDiscoveryService();
  const bus = new TelemetryBus();
  const stugubyStore = new StugubyStore(database.db, "mcp-read-only", { readOnly: true });
  const dataMode = new DataModeCoordinator(database);
  const status = new RuntimeStatus(config, bus, database);
  const dataOperations = new DataOperationsService(database, config);
  const timeseries = config.timeseriesEnabled ? new TimeseriesStore({
    poolConfig: timeseriesPoolConfig(config),
    maxConnections: config.timeseriesPoolMax,
    connectionTimeoutMs: config.timeseriesConnectTimeoutMs,
    statementTimeoutMs: config.timeseriesStatementTimeoutMs,
  }) : null;
  const telemetryReader = new HybridTelemetryReader({
    local: database,
    archive: timeseries,
    localHistoryComplete: timeseries === null || config.retentionDays === 0
      ? true
      : (query) => isLocalTelemetryHistoryComplete({
          timeseriesEnabled: true,
          retentionDays: config.retentionDays,
          from: query.from,
        }),
  });
  const energyCost = new EnergyCostService(
    telemetryReader,
    {
      meterRole: (sensorId) => database.getSensor(sensorId)?.energyMeterRole ?? "standalone",
      tariffFor: databaseTariffContext(database),
    },
  );
  const energyOptimizer = new EnergyOptimizer(database, telemetryReader);
  const setupDoctor = new SetupDoctor(database, config, status, dataOperations, null);
  const alertEngine = new AlertEngine(database, bus, config, status);
  const telemetry = new TelemetryService(database, bus, alertEngine, dataMode);
  const measurements = new MeasurementService(database, bus, alertEngine, dataMode);
  const mock = new MockEngine(database, telemetry, config, dataMode);
  const replay = new ReplayEngine(database, bus);
  const homeAssistant = new HomeAssistantBridge(config, telemetry, measurements, database, status);
  const tpLink = new TpLinkBridge(config, telemetry, measurements, database, status);
  const weather = new WeatherService(
    new AutomaticWeatherProvider(new FmiWeatherProvider(), new OpenMeteoWeatherProvider()),
    status.value.weather,
    () => status.changed(),
    undefined,
    undefined,
    undefined,
    undefined,
    database,
  );
  dataMode.onActivated(() => {
    mock.stop();
    replay.reset();
    status.refreshDataMode();
  });
  return {
    config, database, locationDiscovery, bus, stugubyStore, dataMode, status, dataOperations, timeseries,
    telemetryReader, energyCost, energyOptimizer, setupDoctor, alertEngine, telemetry, measurements, mock,
    replay, homeAssistant, tpLink, weather, operations: new McpOperationTracker(),
  };
}
