import type { MeasurementSample } from "@climate-twin/contracts";
import { createBuiltinSpatialLayerRegistry, type SpatialLayerEngineRegistry } from "@climate-twin/spatial-layers";
import { ClimateDatabaseSpatialInputAdapter, type CoreClimateReader } from "./core-input.js";
import { HybridTelemetryReader } from "../timeseries/read-facade.js";
import { EngineHost, type SpatialEngineHostLogger } from "./engine-host.js";
import {
  WorkerThreadSpatialEngineExecutor,
  type SpatialEngineExecutor,
} from "./executor.js";
import { InMemorySpatialSnapshotNotifier } from "./notifier.js";
import { SpatialLayerScheduler } from "./scheduler.js";
import { deriveSpatialStatePath, sourceDatabaseId, SpatialLayerStateStore } from "./state-store.js";
import type { SpatialDataPartition } from "./types.js";

export type SpatialRuntimeCoreReader = CoreClimateReader;
export type SpatialRuntimeTelemetryReader = Pick<HybridTelemetryReader, "measurementWindow" | "outdoorTemperatureHistory">;

export interface LocalSpatialLayerRuntime {
  readonly state: SpatialLayerStateStore;
  readonly input: ClimateDatabaseSpatialInputAdapter;
  readonly host: EngineHost;
  readonly scheduler: SpatialLayerScheduler;
  readonly notifier: InMemorySpatialSnapshotNotifier;
  start(): void;
  stop(): Promise<void>;
  wakeMeasurement(sample: MeasurementSample): void;
  handleDataModeActivated(dataMode?: "real"): void;
  synchronizeDataMode(): void;
  trackStream(close: () => void): () => void;
}

export function createLocalSpatialLayerRuntime(options: {
  coreDatabase: SpatialRuntimeCoreReader;
  telemetryReader?: SpatialRuntimeTelemetryReader;
  coreDatabasePath: string;
  dataMode: "demo" | "real";
  statePath?: string;
  sourceDbId?: string;
  registry?: SpatialLayerEngineRegistry;
  startBackground?: boolean;
  timeoutMs?: number;
  intervalMs?: number;
  retentionDays?: number;
  logger?: SpatialEngineHostLogger;
  executor?: SpatialEngineExecutor;
}): LocalSpatialLayerRuntime {
  const stableSourceDbId = options.sourceDbId ?? options.coreDatabase.telemetryArchiveSourceId();
  const partition: SpatialDataPartition = {
    sourceDbId: stableSourceDbId,
    dataMode: options.dataMode,
  };
  const state = new SpatialLayerStateStore(options.statePath ?? deriveSpatialStatePath(options.coreDatabasePath));
  if (options.sourceDbId === undefined) {
    try {
      state.rekeyLegacySourceDatabaseId(sourceDatabaseId(options.coreDatabasePath), stableSourceDbId);
    } catch (error) {
      state.close();
      throw error;
    }
  }
  const telemetryReader = options.telemetryReader ?? new HybridTelemetryReader({ local: options.coreDatabase });
  const input = new ClimateDatabaseSpatialInputAdapter(options.coreDatabase, telemetryReader);
  const notifier = new InMemorySpatialSnapshotNotifier();
  if (options.registry && !options.executor) {
    state.close();
    throw new Error("A custom spatial engine registry requires an explicitly injected executor");
  }
  const host = new EngineHost({
    partition,
    coreInput: input,
    state,
    registry: options.registry ?? createBuiltinSpatialLayerRegistry(),
    notifier,
    executor: options.executor ?? new WorkerThreadSpatialEngineExecutor(),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const scheduler = new SpatialLayerScheduler({
    host,
    state,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays }),
  });
  let stopped = false;
  const streams = new Set<() => void>();
  const runtime: LocalSpatialLayerRuntime = {
    state,
    input,
    host,
    scheduler,
    notifier,
    start(): void {
      if (!stopped) scheduler.start();
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const close of [...streams]) close();
      streams.clear();
      await scheduler.stop();
      host.close();
      state.close();
    },
    wakeMeasurement(sample): void {
      if (stopped || (sample.metric !== "temperature" && sample.metric !== "humidity")) return;
      runtime.synchronizeDataMode();
      const sensor = options.coreDatabase.getSensor(sample.sensorId);
      if (!sensor) return;
      const house = options.coreDatabase.getHouse(sensor.houseId);
      scheduler.wakeHouse(sensor.houseId, house?.propertyId ?? null, sample.timestamp);
    },
    handleDataModeActivated(dataMode = "real"): void {
      if (stopped) return;
      const next = { ...host.partition, dataMode };
      host.handleDataModeActivated(next);
      scheduler.handleDataModeActivated(next);
    },
    synchronizeDataMode(): void {
      if (stopped) return;
      const actualMode = options.coreDatabase.isRealDataMode() ? "real" : "demo";
      if (host.partition.dataMode === actualMode) return;
      // Core mode is a one-way latch, so only demo -> real is possible.
      if (actualMode === "real") runtime.handleDataModeActivated("real");
    },
    trackStream(close): () => void {
      if (stopped) {
        close();
        return () => undefined;
      }
      streams.add(close);
      return () => streams.delete(close);
    },
  };
  host.ensureAllScopeDefaults();
  if (options.startBackground) runtime.start();
  return runtime;
}
