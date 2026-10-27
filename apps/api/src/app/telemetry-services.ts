import { EnergyProjectionCache } from "../electricity/projection-cache.js";
import { EnergySummaryCache } from "../energy-summary-cache.js";
import type {
  MeasurementSample,
  Reading,
} from "@climate-twin/contracts";
import { HeatPumpStateStore } from "../heat-pump-state.js";
import { ConnectedDeviceStore } from "../connected-device-store.js";
import {
  RuntimeStatus,
} from "../services.js";
import { DailyAnalyticsFindingsWorker } from "../daily-analytics-findings.js";
import { LruTtlCache } from "../cache.js";
import { EnergyCostService } from "../energy-cost.js";
import { databaseTariffContext } from "../electricity/tariff-context.js";
import { SetupDoctor } from "../setup-doctor.js";
import { ScheduledDataExportService } from "../scheduled-data-exports.js";
import { TimeseriesStore } from "../timeseries/store.js";
import {
  TelemetryArchiveWorker,
} from "../timeseries/archive-worker.js";
import {
  HybridTelemetryReader,
  isLocalTelemetryHistoryComplete,
} from "../timeseries/read-facade.js";
import { TelemetryRetentionWorker } from "../timeseries/retention-worker.js";
import { TelemetryOrderedRollupWorker } from "../timeseries/ordered-rollup-worker.js";
import { AnalyticsWorkLimiter } from "../analytics/work-limiter.js";
import { DerivedAnalyticsCoordinator } from "../analytics/derived-artifacts/coordinator.js";
import { configuredHeatPumpConnectionIds } from "../analytics/heat-pump-evidence.js";
import { hostAllowsBackgroundWork } from "../analytics/background-admission.js";
import {
  type TelemetryCascadeScope,
} from "../db.js";
import { HttpError } from "./support/index.js";
import type { CoreDataServices } from "./core-data-services.js";
/** Telemetry storage and readers, analytics workers, runtime status, energy caches, latest-value snapshot caches and the archive guards for destructive changes. */
export function createTelemetryServices(context: CoreDataServices) {
  const config = context.config;
  const timeseries = config.timeseriesEnabled ? context.options.timeseriesStore ?? new TimeseriesStore({
      poolConfig: {
        host: config.timeseriesHost,
        port: config.timeseriesPort,
        database: config.timeseriesDatabase,
        user: config.timeseriesUser,
        password: config.timeseriesPassword,
        // Heavy analytics are already admitted in-process. Disabling backend
        // query parallelism prevents two admitted reads from consuming every
        // Raspberry Pi core through PostgreSQL worker fan-out.
        options: "-c max_parallel_workers_per_gather=0",
        ...(context.timeseriesSsl ? { ssl: context.timeseriesSsl } : {}),
      },
      maxConnections: config.timeseriesPoolMax,
      connectionTimeoutMs: config.timeseriesConnectTimeoutMs,
      statementTimeoutMs: config.timeseriesStatementTimeoutMs,
      batchSize: config.timeseriesBatchSize,
      orderedMetricIds: context.database.listMeasurementDefinitions(false)
        .filter((definition) => definition.kind === "rate" || definition.kind === "cumulative_counter")
        .map((definition) => definition.id),
      coldStorageAfterDays: config.timeseriesColumnstoreAfterDays,
    }) : null;
  context.hostDatabaseMetrics.setTimeseries(timeseries);
  const heatPumpStates = new HeatPumpStateStore(context.database);
  const connectedDevices = new ConnectedDeviceStore(context.database);
  const telemetryArchive = timeseries
      ? new TelemetryArchiveWorker(context.database, context.bus, timeseries, {
        batchSize: config.timeseriesBatchSize,
        requireTimescale: config.timeseriesRequired,
        localHistoryRetentionDays: config.retentionDays,
        heatPumpStatePage: (cursor, limit) => heatPumpStates.archivePage(cursor, limit),
      })
      : null;
  const telemetryRetention = telemetryArchive && config.retentionDays > 0
      ? new TelemetryRetentionWorker(context.database, telemetryArchive, config.retentionDays)
      : null;
  const telemetryOrderedRollups = timeseries ? new TelemetryOrderedRollupWorker(timeseries, { ready: () => ["syncing", "ready"].includes(telemetryArchive!.status().phase) }) : null;
  const telemetryReader = context.options.telemetryReader ?? new HybridTelemetryReader({
      local: context.database,
      archive: timeseries,
      archivePhase: () => {
        const archive = telemetryArchive?.status();
        return archive?.caughtUp ? "ready" : archive?.phase;
      },
      archiveLastSuccessAt: () => telemetryArchive?.status().lastSuccessAt,
      reconcile: () => telemetryArchive?.reconcileNow(),
      localHistoryComplete: telemetryArchive === null || config.retentionDays === 0
        ? true
        : (query) => isLocalTelemetryHistoryComplete({
            timeseriesEnabled: true,
            retentionDays: config.retentionDays,
            from: query.from,
          }),
    });
  const analyticsWorkLimiter = new AnalyticsWorkLimiter({
      maxConcurrent: Math.max(1, Math.min(2, config.timeseriesPoolMax)),
      maxQueued: 32,
    });
  const admitLowPriority = context.options.backgroundWorkAdmission
    ?? (context.options.startBackground === false
      ? () => true
      : async (): Promise<boolean> => hostAllowsBackgroundWork(
          await context.hostSystem.snapshot(),
        ));
  const derivedAnalytics = new DerivedAnalyticsCoordinator(
      context.database,
      telemetryReader,
      analyticsWorkLimiter,
      {
        admitLowPriority,
        heatPumpConnectionIds: (houseId) => configuredHeatPumpConnectionIds(
          context.config.greeConnections,
          houseId,
        ),
      },
    );
  context.energyOptimizer.setTelemetryReader(telemetryReader);
  const dailyAnalyticsFindings = new DailyAnalyticsFindingsWorker({
      database: context.database,
      telemetryReader,
      ...(context.options.dailyAnalyticsNow ? { now: context.options.dailyAnalyticsNow } : {}),
    });
  const scheduledDataExports = new ScheduledDataExportService({
      database: context.database,
      telemetryReader,
      systemStorage: context.systemStorage,
      dataOperations: context.dataOperations,
      operationsDirectory: config.backupOperationsDirectory ?? null,
    });
  const measurementSnapshotCache = new LruTtlCache<MeasurementSample[]>({
      maxEntries: 64,
      maxBytes: 8 * 1024 * 1024,
      defaultTtlMs: 2_000,
    });
  const readingSnapshotCache = new LruTtlCache<Reading[]>({
      maxEntries: 4,
      maxBytes: 4 * 1024 * 1024,
      defaultTtlMs: 2_000,
    });
  const status = new RuntimeStatus(config, context.bus, context.database);
  const setupDoctor = new SetupDoctor(context.database, config, status, context.dataOperations, telemetryArchive);
  const energyCost = new EnergyCostService(
      telemetryReader,
      undefined,
      (sensorId) => context.database.getSensor(sensorId)?.energyMeterRole ?? "standalone",
      databaseTariffContext(context.database),
    );
  const energySummaries = new EnergySummaryCache(context.database, energyCost, analyticsWorkLimiter);
  const energyProjections = new EnergyProjectionCache(context.database, telemetryReader, energySummaries, analyticsWorkLimiter);
  context.energyOptimizer.setSummaryCache(energySummaries);
  const withTelemetry = Object.assign(context, { timeseries, heatPumpStates, connectedDevices, telemetryArchive, telemetryRetention, telemetryOrderedRollups, telemetryReader, analyticsWorkLimiter, admitLowPriority, derivedAnalytics, dailyAnalyticsFindings, scheduledDataExports, measurementSnapshotCache, readingSnapshotCache, status, setupDoctor, energyCost, energySummaries, energyProjections });
  const invalidateSnapshotCaches = (): void => {
      withTelemetry.measurementSnapshotCache.clear();
      withTelemetry.readingSnapshotCache.clear();
    };
  const cachedLatestMeasurements = (houseId?: string): MeasurementSample[] => {
      const key = houseId ? `house:${houseId}` : "all";
      const cached = withTelemetry.measurementSnapshotCache.get(key);
      if (cached) return cached;
      const loaded = withTelemetry.database.latestMeasurementSamples(houseId);
      withTelemetry.measurementSnapshotCache.set(key, loaded);
      return loaded;
    };
  const cachedLatestReadings = (): Reading[] => {
      const cached = withTelemetry.readingSnapshotCache.get("all");
      if (cached) return cached;
      const loaded = withTelemetry.database.latestReadings();
      withTelemetry.readingSnapshotCache.set("all", loaded);
      return loaded;
    };
  const requireArchivedBeforeCascade = async (scope: TelemetryCascadeScope, resourceId: string): Promise<void> => {
      if (!withTelemetry.telemetryArchive) {
        if (withTelemetry.database.hasRealTelemetryForCascade(scope, resourceId)) {
          throw new HttpError(
            409,
            "TELEMETRY_ARCHIVE_REQUIRED",
            "This change would erase the only copy of retained telemetry; enable and reconcile the archive first",
          );
        }
        return;
      }
      try {
        await withTelemetry.telemetryArchive.reconcileNow();
      } catch {
        throw new HttpError(
          503,
          "TELEMETRY_ARCHIVE_NOT_READY",
          "Telemetry must be durably archived before deleting a telemetry-owning resource",
        );
      }
      if (!withTelemetry.telemetryArchive.status().caughtUp) {
        throw new HttpError(
          503,
          "TELEMETRY_ARCHIVE_NOT_READY",
          "Telemetry must be durably archived before deleting a telemetry-owning resource",
        );
      }
    };
  const requireImmutableTelemetryLineage = (
      scope: Exclude<TelemetryCascadeScope, "house-location">,
      resourceId: string,
    ): void => {
      if (!withTelemetry.database.hasRealTelemetryForCascade(scope, resourceId)) return;
      throw new HttpError(
        409,
        "TELEMETRY_LINEAGE_REQUIRED",
        "Resources with real telemetry cannot be moved or deleted until immutable historical ownership context is available; disable the resource instead",
      );
    };
  const removeSnapshotMeasurementWake = withTelemetry.bus.subscribeMeasurements(invalidateSnapshotCaches);
  return Object.assign(withTelemetry, { invalidateSnapshotCaches, cachedLatestMeasurements, cachedLatestReadings, requireArchivedBeforeCascade, requireImmutableTelemetryLineage, removeSnapshotMeasurementWake });
}

export type TelemetryServices = ReturnType<typeof createTelemetryServices>;
