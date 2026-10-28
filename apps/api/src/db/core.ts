import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  MeasurementSample,
} from "@climate-twin/contracts";
import type { EnergyCostAggregateQuery, EnergyCostAggregateRecord } from "../timeseries/types.js";
import {
  assertRegisteredMethods,
  installRegisteredMethods,
  type RegisteredMethodSet,
} from "../method-registry.js";
import { LocalTelemetryWorker } from "../timeseries/local-telemetry-worker.js";
import type { LocalBucketQuery, LocalSensorPageQuery } from "../timeseries/local-telemetry-worker-thread.js";
import { databaseIntegrity, exportTableCounts, type ExportTable, type DatabaseIntegrityResult } from "./inspection.js";
import type { MeasurementWindowQuery, ThermalMeasurementHistoryQuery } from "../timeseries/types.js";
import type { LocalPowerProfileQuery, PowerProfile } from "../timeseries/read-power-profile.js";
import { localPowerProfile } from "./local-power-profile.js";

export interface DatabaseInternals {
  readonly db: DatabaseSync;
  closeCostReader(): void;
  costAggregateAsync(metric: "energy" | "power", query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord>;
  measurementHistoryBucketedAsync(query: LocalBucketQuery): Promise<MeasurementSample[]>;
  sensorMeasurementPageAsync(query: LocalSensorPageQuery): Promise<{ samples: MeasurementSample[]; nextCursor: string | null }>;
  exportTableCountsAsync(tables: readonly ExportTable[], signal?: AbortSignal): Promise<Record<string, number>>;
  integrityAsync(signal?: AbortSignal): Promise<DatabaseIntegrityResult>;
  measurementWindowAsync(query: MeasurementWindowQuery): Promise<MeasurementSample[]>;
  optimizerPowerProfileAsync(query: LocalPowerProfileQuery): Promise<PowerProfile>;
  thermalMeasurementHistoryAsync(query: ThermalMeasurementHistoryQuery): Promise<MeasurementSample[]>;
  transaction<T>(operation: () => T): T;
  immediateTransaction<T>(operation: () => T): T;
}

/**
 * Points SQLite's spill files (temp B-trees for large ORDER BY/GROUP BY and
 * index builds) at a directory on the same volume as the database. The
 * hardened containers run with a read-only root filesystem where the only
 * writable fallback in SQLite's built-in search order is a 32 MiB /tmp tmpfs,
 * and a sort that outgrows it fails the whole statement with SQLITE_FULL
 * ("database or disk is full"). SQLite verifies the directory is writable and
 * silently falls back to its built-in order when it is not, so pointing at a
 * directory that cannot be created (for example a read-only data mount) keeps
 * today's behavior. An operator-provided SQLITE_TMPDIR always wins, and the
 * Windows VFS ignores the variable entirely.
 *
 * SQLite reads the variable once, when the library initializes, so process
 * entry points call this before the first database opens.
 */
export function ensureSqliteSpillDirectory(databasePath: string): void {
  if (databasePath === ":memory:" || process.env.SQLITE_TMPDIR) return;
  const spillDirectory = join(dirname(databasePath), ".sqlite-tmp");
  try {
    mkdirSync(spillDirectory, { recursive: true });
  } catch {
    return;
  }
  process.env.SQLITE_TMPDIR = spillDirectory;
}

export type DatabaseMethodSet = RegisteredMethodSet<DatabaseInternals>;

export interface ClimateDatabaseCore {
  migrateEquipmentPlacementTable(): void;
  purgeSourceLabelledDemoTelemetry(): void;
  purgeSharedHomeLocalState(houseId?: string): void;
  backfillLegacyMeasurements(): void;
  backfillSeedOutdoorTemperature(): void;
}

export class ClimateDatabaseCore {
  readonly db: DatabaseSync;
  readonly #databasePath: string;
  #telemetryWorker: LocalTelemetryWorker | null = null;
  #transactionDepth = 0;
  constructor(path: string, seed = true, options: { readOnly?: boolean } = {}) {
      assertRegisteredMethods("ClimateDatabase", this, "migrate", "db.js");
      this.#databasePath = path;
      if (options.readOnly) {
        if (path === ":memory:") throw new Error("A read-only ClimateDatabase requires an existing database file");
        this.db = new DatabaseSync(path, { readOnly: true });
        this.db.exec("PRAGMA query_only = ON; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
        return;
      }
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
      this.db = new DatabaseSync(path);
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      this.migrateEquipmentPlacementTable();
      this.migrate();
      const realDataMode = this.isRealDataMode();
      // Never seed a database that has crossed the one-way boundary, including
      // partially restored databases whose seed metadata is missing.
      if (seed && !realDataMode) this.seed();
      // A persisted real-data latch is authoritative even if the database was
      // modified outside the application while it was stopped.
      if (realDataMode) this.purgeSourceLabelledDemoTelemetry();
      this.purgeSharedHomeLocalState();
      this.backfillLegacyMeasurements();
      if (seed && !realDataMode) this.backfillSeedOutdoorTemperature();
      // Preserve the same fail-closed cleanup if initialization ever crosses
      // the one-way boundary, without rescanning an already-real database.
      if (!realDataMode && this.isRealDataMode()) this.purgeSourceLabelledDemoTelemetry();
    }
  transaction<T>(operation: () => T): T {
      return this.immediateTransaction(operation);
    }
  async costAggregateAsync(metric: "energy" | "power", query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord> {
      // In-memory fixtures cannot share a connection with a worker. Appliance
      // and standalone deployments use the file-backed, cancellable reader.
      if (this.#databasePath === ":memory:") {
        query.signal?.throwIfAborted();
        return metric === "energy" ? this.energyCostAggregate(query) : this.powerCostAggregate(query);
      }
      this.#telemetryWorker ??= new LocalTelemetryWorker(this.#databasePath);
      return this.#telemetryWorker.read(metric, query);
    }
  closeCostReader(): void {
      this.#telemetryWorker?.close();
    }
  async sensorMeasurementPageAsync(query: LocalSensorPageQuery): Promise<{ samples: MeasurementSample[]; nextCursor: string | null }> {
      query.signal?.throwIfAborted();
      if (this.#databasePath === ":memory:") return this.sensorMeasurementPage(query.sensorId, query.before, query.limit);
      this.#telemetryWorker ??= new LocalTelemetryWorker(this.#databasePath);
      return this.#telemetryWorker.readSensorPage(query);
    }
  async exportTableCountsAsync(tables: readonly ExportTable[], signal?: AbortSignal): Promise<Record<string, number>> {
      signal?.throwIfAborted();
      if (this.#databasePath === ":memory:") return exportTableCounts(this, tables);
      this.#telemetryWorker ??= new LocalTelemetryWorker(this.#databasePath);
      return this.#telemetryWorker.readExportCounts(tables, signal);
    }
  async integrityAsync(signal?: AbortSignal): Promise<DatabaseIntegrityResult> {
      signal?.throwIfAborted();
      if (this.#databasePath === ":memory:") return databaseIntegrity(this);
      this.#telemetryWorker ??= new LocalTelemetryWorker(this.#databasePath);
      return this.#telemetryWorker.readIntegrity(signal);
    }
  async measurementWindowAsync(query: MeasurementWindowQuery): Promise<MeasurementSample[]> {
      query.signal?.throwIfAborted();
      if (this.#databasePath === ":memory:") return this.measurementWindow(query
      );
      this.#telemetryWorker ??= new LocalTelemetryWorker(this.#databasePath);
      return this.#telemetryWorker.readWindow(query);
    }
  async optimizerPowerProfileAsync(query: LocalPowerProfileQuery): Promise<PowerProfile> {
      query.signal?.throwIfAborted();
      if (this.#databasePath === ":memory:") return localPowerProfile(this, query);
      this.#telemetryWorker ??= new LocalTelemetryWorker(this.#databasePath);
      return this.#telemetryWorker.readPowerProfile(query);
    }
  async thermalMeasurementHistoryAsync(query: ThermalMeasurementHistoryQuery): Promise<MeasurementSample[]> {
      query.signal?.throwIfAborted();
      if (this.#databasePath === ":memory:") {
        return (query.metrics.length === 1 && query.metrics[0] === "temperature"
          ? this.thermalTemperatureHistory(query)
          : this.thermalClimateHistory(query))
          .filter(sample => query.metrics.includes(sample.metric));
      }
      this.#telemetryWorker ??= new LocalTelemetryWorker(this.#databasePath);
      return this.#telemetryWorker.readThermal(query);
    }
  async measurementHistoryBucketedAsync(query: LocalBucketQuery): Promise<MeasurementSample[]> {
      query.signal?.throwIfAborted();
      if (this.#databasePath === ":memory:") return this.measurementHistoryBucketed(query);
      this.#telemetryWorker ??= new LocalTelemetryWorker(this.#databasePath);
      return this.#telemetryWorker.readBuckets(query);
    }
  private immediateTransaction<T>(operation: () => T): T {
      if (this.#transactionDepth > 0) return operation();
      this.db.exec("BEGIN IMMEDIATE");
      this.#transactionDepth += 1;
      try {
        const result = operation();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      } finally {
        this.#transactionDepth -= 1;
      }
    }
}

export function registerDatabaseMethods(methods: DatabaseMethodSet): void {
  installRegisteredMethods("ClimateDatabase", ClimateDatabaseCore.prototype, methods);
}
