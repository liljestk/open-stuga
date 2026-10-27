import { applyApiConfigDefaults } from "../config/api-defaults.js";
import { timeseriesPoolConfig } from "../timeseries/pool-options.js";
import { isLocalTelemetryHistoryComplete } from "../timeseries/read-support.js";
import { hasLocalHouseAuthority } from "@climate-twin/contracts";
import type {
  HouseWeather,
  MeasurementSample,
  MeasurementSnapshotEntry,
} from "@climate-twin/contracts";
import { loadConfig } from "../config.js";
import { DataOperationsService } from "../data-operations.js";
import { ClimateDatabase, ensureSqliteSpillDirectory, outdoorLocationKey } from "../db.js";
import { EnergyCostService } from "../energy-cost.js";
import { databaseTariffContext } from "../electricity/tariff-context.js";
import { EnergyOptimizer } from "../energy-optimizer.js";
import { TelemetryBus } from "../events.js";
import { HomeAssistantBridge } from "../home-assistant.js";
import {
  requireMcpHouse,
} from "../mcp-validation.js";
import { LocationDiscoveryService } from "../location-discovery.js";
import { AutomaticWeatherProvider, OpenMeteoWeatherProvider } from "../open-meteo.js";
import {
  AlertEngine,
  DataModeCoordinator,
  MeasurementService,
  MockEngine,
  ReplayEngine,
  RuntimeStatus,
  TelemetryService,
} from "../services.js";
import { SetupDoctor } from "../setup-doctor.js";
import { HybridTelemetryReader } from "../timeseries/read-facade.js";
import { TimeseriesStore } from "../timeseries/store.js";
import { TpLinkBridge } from "../tp-link.js";
import { FmiWeatherProvider, WeatherRequestSupersededError, WeatherService } from "../weather.js";
import { StugubyStore } from "../stuguby/store.js";

// The same defaults createApi applies, so both entry points see one normalized config.
export const config = applyApiConfigDefaults(loadConfig());
ensureSqliteSpillDirectory(config.databasePath);

export const database = new ClimateDatabase(config.databasePath, false, { readOnly: true });

export const locationDiscovery = new LocationDiscoveryService();

export const bus = new TelemetryBus();

export const stugubyStore = new StugubyStore(database.db, "mcp-read-only", { readOnly: true });

export const dataMode = new DataModeCoordinator(database);

export const status = new RuntimeStatus(config, bus, database);

export const dataOperations = new DataOperationsService(database, config);

export const timeseries = config.timeseriesEnabled ? new TimeseriesStore({
  poolConfig: timeseriesPoolConfig(config),
  maxConnections: config.timeseriesPoolMax,
  connectionTimeoutMs: config.timeseriesConnectTimeoutMs,
  statementTimeoutMs: config.timeseriesStatementTimeoutMs,
}) : null;

export const telemetryReader = new HybridTelemetryReader({
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

export const energyCost = new EnergyCostService(
  telemetryReader,
  undefined,
  (sensorId) => database.getSensor(sensorId)?.energyMeterRole ?? "standalone",
  databaseTariffContext(database),
);

export const energyOptimizer = new EnergyOptimizer(database, telemetryReader);

export const setupDoctor = new SetupDoctor(database, config, status, dataOperations, null);

export const alertEngine = new AlertEngine(database, bus, config, status);

export const telemetry = new TelemetryService(database, bus, alertEngine, dataMode);

export const measurements = new MeasurementService(database, bus, alertEngine, dataMode);

export const mock = new MockEngine(database, telemetry, config, dataMode);

export const replay = new ReplayEngine(database, bus);

export const homeAssistant = new HomeAssistantBridge(config, telemetry, measurements, database, status);

export const tpLink = new TpLinkBridge(config, telemetry, measurements, database, status);

export const weather = new WeatherService(
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

export function objectArguments(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

export function optionalBoolean(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

export function measurementSnapshot(houseId?: string): MeasurementSnapshotEntry[] {
  if (houseId) requireMcpHouse(database, houseId);
  const bySensor = new Map<string, Record<string, MeasurementSample>>();
  for (const sample of database.latestMeasurementSamples(houseId)) {
    const measurements = bySensor.get(sample.sensorId) ?? Object.create(null) as Record<string, MeasurementSample>;
    measurements[sample.metric] = sample;
    bySensor.set(sample.sensorId, measurements);
  }
  return database.listSensors(houseId).map((sensor) => ({
    sensorId: sensor.id,
    measurements: bySensor.get(sensor.id) ?? {},
  }));
}

export async function getHouseWeather(houseId: string, hours: number): Promise<HouseWeather> {
  const house = requireMcpHouse(database, houseId);
  if (!hasLocalHouseAuthority(house)) {
    throw new Error(`House ${houseId} is a remote Stuguby projection`);
  }
  if (!house.location) throw new Error(`House ${houseId} does not have a weather location`);
  const result = await weather.get(house, hours);
  const current = database.getHouse(house.id);
  if (!current || current.updatedAt !== house.updatedAt
    || outdoorLocationKey(current.location) !== outdoorLocationKey(result.location)) {
    throw new WeatherRequestSupersededError();
  }
  return result;
}
