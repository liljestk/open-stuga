import type { MeasurementSample } from "@climate-twin/contracts";
import type {
  ClimateDatabase,
  TelemetryArchiveDirtyRow,
  TelemetryArchiveMutableTable,
  TelemetryArchiveRow,
} from "../db.js";
import type { TelemetryBus } from "../events.js";
import { TELEMETRY_TABLES, type TelemetryTableName } from "./schema.js";
import type { TimeseriesStore } from "./store.js";
import type {
  TelemetrySchemaInitResult,
} from "./types.js";

const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
const DEFAULT_RETRY_INTERVAL_MS = 15_000;

export type TelemetryArchivePhase = "idle" | "starting" | "syncing" | "ready" | "degraded" | "stopped";

export interface TelemetryArchiveStatus {
  phase: TelemetryArchivePhase;
  caughtUp: boolean;
  timescaleAvailable: boolean;
  timescaleVersion: string | null;
  hypertables: string[];
  aggregateMode: TelemetrySchemaInitResult["aggregateMode"] | null;
  coldStorageMode: TelemetrySchemaInitResult["coldStorageMode"] | null;
  schemaWarningCount: number;
  queuedSamples: number;
  droppedQueueSamples: number;
  archivedRows: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** Public-safe failure category; connection details are deliberately omitted. */
  lastError: "initialization-failed" | "reconciliation-failed" | null;
}

export interface TelemetryArchiveWorkerOptions {
  batchSize?: number;
  reconcileIntervalMs?: number;
  retryIntervalMs?: number;
  /** Fail initialization unless Timescale and every expected hypertable are available. */
  requireTimescale?: boolean;
}

type CheckpointStore = TimeseriesStore & {
  archiveCheckpoint(sourceId: string, tableName: TelemetryTableName): Promise<number>;
  saveArchiveCheckpoint(sourceId: string, tableName: TelemetryTableName, lastRowId: number): Promise<void>;
  enforceRealDataBoundary(sourceId: string, activatedAt: string): Promise<number>;
  invalidateInitialization(): void;
};

function isSyntheticSample(sample: MeasurementSample): boolean {
  return sample.source === "mock" || sample.source === "replay";
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new RangeError(`Expected a positive integer no greater than ${maximum}`);
  }
  return selected;
}

/**
 * Copies the durable SQLite write buffer into TimescaleDB. A remote checkpoint
 * advances only after its page has been committed, so a crash causes a safe
 * idempotent retry rather than a gap. Live samples merely reduce archive lag;
 * reconciliation remains the source of truth.
 */
export class TelemetryArchiveWorker {
  readonly #database: ClimateDatabase;
  readonly #bus: TelemetryBus;
  readonly #store: CheckpointStore;
  readonly #sourceId: string;
  readonly #batchSize: number;
  readonly #maxQueuedSamples: number;
  readonly #reconcileIntervalMs: number;
  readonly #retryIntervalMs: number;
  readonly #requireTimescale: boolean;
  readonly #queue: MeasurementSample[] = [];
  #status: TelemetryArchiveStatus = {
    phase: "idle",
    caughtUp: false,
    timescaleAvailable: false,
    timescaleVersion: null,
    hypertables: [],
    aggregateMode: null,
    coldStorageMode: null,
    schemaWarningCount: 0,
    queuedSamples: 0,
    droppedQueueSamples: 0,
    archivedRows: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
  };
  #removeMeasurementListener: (() => void) | null = null;
  #timer: NodeJS.Timeout | null = null;
  #wakeTimer: NodeJS.Timeout | null = null;
  #startPromise: Promise<void> | null = null;
  #cyclePromise: Promise<void> | null = null;
  #reconcileGeneration = 0;
  #stopping = false;
  #realDataBoundaryEnforced = false;

  constructor(
    database: ClimateDatabase,
    bus: TelemetryBus,
    store: CheckpointStore,
    options: TelemetryArchiveWorkerOptions = {},
  ) {
    this.#database = database;
    this.#bus = bus;
    this.#store = store;
    this.#sourceId = database.telemetryArchiveSourceId();
    this.#batchSize = positiveInteger(options.batchSize, 1_000, 5_000);
    this.#maxQueuedSamples = Math.max(1_000, this.#batchSize * 4);
    this.#reconcileIntervalMs = positiveInteger(
      options.reconcileIntervalMs,
      DEFAULT_RECONCILE_INTERVAL_MS,
      24 * 60 * 60 * 1_000,
    );
    this.#retryIntervalMs = positiveInteger(options.retryIntervalMs, DEFAULT_RETRY_INTERVAL_MS, 60 * 60 * 1_000);
    this.#requireTimescale = options.requireTimescale ?? false;
  }

  get store(): TimeseriesStore {
    return this.#store;
  }

  status(): TelemetryArchiveStatus {
    return structuredClone({ ...this.#status, queuedSamples: this.#queue.length });
  }

  start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    if (this.#stopping) return Promise.reject(new Error("Telemetry archive worker is stopped"));
    this.#status.phase = "starting";
    this.#removeMeasurementListener ??= this.#bus.subscribeMeasurements((sample) => this.#enqueue(sample));
    this.#startPromise = this.#initialize();
    return this.#startPromise;
  }

  async #initialize(): Promise<void> {
    try {
      const schema = await this.#store.initialize();
      const missingHypertables = TELEMETRY_TABLES.filter((table) => !schema.hypertables.includes(table));
      if (this.#requireTimescale && (!schema.timescaleAvailable || missingHypertables.length > 0)) {
        this.#store.invalidateInitialization();
        throw new Error("Required TimescaleDB telemetry hypertables are unavailable");
      }
      if (this.#stopping) return;
      this.#status = {
        ...this.#status,
        phase: "syncing",
        timescaleAvailable: schema.timescaleAvailable,
        timescaleVersion: schema.timescaleVersion,
        hypertables: [...schema.hypertables],
        aggregateMode: schema.aggregateMode,
        coldStorageMode: schema.coldStorageMode,
        schemaWarningCount: schema.warnings.length,
        lastError: null,
      };
      void this.reconcileNow().catch(() => undefined);
    } catch (error) {
      this.#recordFailure("initialization-failed");
      this.#startPromise = null;
      this.#schedule(this.#retryIntervalMs);
      throw error;
    }
  }

  reconcileNow(): Promise<void> {
    this.#reconcileGeneration += 1;
    if (this.#cyclePromise) return this.#cyclePromise;
    if (this.#stopping) return Promise.resolve();
    this.#status.caughtUp = false;
    if (this.#status.phase === "ready") this.#status.phase = "syncing";
    const cycle = this.#reconcile();
    this.#cyclePromise = cycle;
    void cycle.finally(() => {
      if (this.#cyclePromise === cycle) this.#cyclePromise = null;
    }).catch(() => undefined);
    return cycle;
  }

  enforceRealDataBoundary(): void {
    this.#realDataBoundaryEnforced = false;
    void this.reconcileNow().catch(() => undefined);
  }

  async #reconcile(): Promise<void> {
    try {
      if (!this.#startPromise) await this.start();
      else await this.#startPromise;
      if (this.#stopping) return;
      while (!this.#stopping) {
        this.#status.phase = "syncing";
        const passGeneration = this.#reconcileGeneration;
        const before = this.#database.telemetryArchiveStateToken();
        this.#discardSyntheticQueueInRealMode();
        await this.#flushQueuedSamples();
        await this.#reconcileMeasurements();
        await this.#reconcileReadings();
        await this.#reconcileOutdoorTemperatures();
        await this.#reconcileElectricityPrices();
        await this.#flushDirtyRows();
        const realDataActivatedAt = this.#database.realDataModeActivatedAt();
        if (realDataActivatedAt && !this.#realDataBoundaryEnforced) {
          // This is deliberately the final archive mutation in the pass. Any
          // synthetic sample queued before activation is discarded, while the
          // persisted boundary makes cleanup idempotent across process restarts.
          this.#discardSyntheticQueueInRealMode();
          await this.#store.enforceRealDataBoundary(this.#sourceId, realDataActivatedAt);
          this.#realDataBoundaryEnforced = true;
        }
        const after = this.#database.telemetryArchiveStateToken();
        if (passGeneration === this.#reconcileGeneration && before === after && this.#queue.length === 0) break;
      }
      if (this.#stopping) return;
      this.#status.phase = "ready";
      this.#status.caughtUp = true;
      this.#status.lastSuccessAt = new Date().toISOString();
      this.#status.lastError = null;
      this.#schedule(this.#reconcileIntervalMs);
    } catch (error) {
      if (this.#stopping) return;
      this.#recordFailure("reconciliation-failed");
      this.#schedule(this.#retryIntervalMs);
      throw error;
    }
  }

  #recordFailure(kind: NonNullable<TelemetryArchiveStatus["lastError"]>): void {
    this.#status.phase = "degraded";
    this.#status.caughtUp = false;
    this.#status.lastFailureAt = new Date().toISOString();
    this.#status.lastError = kind;
  }

  #schedule(delayMs: number): void {
    if (this.#stopping) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#status.phase === "degraded" && !this.#startPromise) {
        void this.start().catch(() => undefined);
        return;
      }
      void this.reconcileNow().catch(() => undefined);
    }, delayMs);
    this.#timer.unref();
  }

  #enqueue(sample: MeasurementSample): void {
    if (this.#stopping) return;
    this.#reconcileGeneration += 1;
    if (this.#database.isRealDataMode() && isSyntheticSample(sample)) {
      this.#status.droppedQueueSamples += 1;
      return;
    }
    this.#status.caughtUp = false;
    if (this.#status.phase === "ready") this.#status.phase = "syncing";
    this.#queue.push(sample);
    if (this.#queue.length > this.#maxQueuedSamples) {
      const dropped = this.#queue.length - this.#maxQueuedSamples;
      this.#queue.splice(0, dropped);
      this.#status.droppedQueueSamples += dropped;
    }
    if (this.#wakeTimer) return;
    this.#wakeTimer = setTimeout(() => {
      this.#wakeTimer = null;
      void this.reconcileNow().catch(() => undefined);
    }, 100);
    this.#wakeTimer.unref();
  }

  #discardSyntheticQueueInRealMode(): void {
    if (!this.#database.isRealDataMode() || this.#queue.length === 0) return;
    const retained = this.#queue.filter((sample) => !isSyntheticSample(sample));
    this.#status.droppedQueueSamples += this.#queue.length - retained.length;
    this.#queue.splice(0, this.#queue.length, ...retained);
  }

  async #flushQueuedSamples(): Promise<void> {
    while (this.#queue.length > 0) {
      const samples = this.#queue.slice(0, this.#batchSize);
      const result = await this.#store.upsertMeasurementSamples(samples.map((sample) => ({ ...sample })));
      this.#queue.splice(0, samples.length);
      this.#status.archivedRows += result.affected;
    }
  }

  async #reconcileMeasurements(): Promise<void> {
    await this.#reconcileTable("measurement_samples", (cursor) => this.#database.measurementArchivePage(cursor, this.#batchSize),
      (rows) => this.#store.upsertMeasurementSamples(rows.map(({ record }) => ({ ...record }))));
  }

  async #reconcileReadings(): Promise<void> {
    await this.#reconcileTable("legacy_readings", (cursor) => this.#database.readingArchivePage(cursor, this.#batchSize),
      (rows) => this.#store.upsertLegacyReadings(rows.map(({ record }) => ({ ...record }))));
  }

  async #reconcileOutdoorTemperatures(): Promise<void> {
    await this.#reconcileTable(
      "outdoor_temperature_samples",
      (cursor) => this.#database.outdoorTemperatureArchivePage(cursor, this.#batchSize),
      (rows) => this.#store.upsertOutdoorTemperatureSamples(rows.map(({ record }) => ({
        ...record,
        metadata: record.conditions ? { conditions: record.conditions } : {},
      }))),
    );
  }

  async #reconcileElectricityPrices(): Promise<void> {
    await this.#reconcileTable(
      "electricity_price_samples",
      (cursor) => this.#database.electricityPriceArchivePage(cursor, this.#batchSize),
      (rows) => this.#store.upsertElectricityPriceSamples(rows.map(({ record }) => ({ ...record }))),
    );
  }

  async #reconcileTable<T>(
    table: TelemetryTableName,
    page: (cursor: number) => TelemetryArchiveRow<T>[],
    write: (rows: TelemetryArchiveRow<T>[]) => Promise<{ affected: number }>,
  ): Promise<void> {
    const remoteCursor = await this.#store.archiveCheckpoint(this.#sourceId, table);
    // The local half is intentionally included in SQLite backups. Taking the
    // minimum makes a restored/rewound SQLite file replay safely even when the
    // remote archive still remembers a later cursor.
    let cursor = Math.min(remoteCursor, this.#database.telemetryArchiveCheckpoint(table));
    while (!this.#stopping) {
      const rows = page(cursor);
      if (rows.length === 0) return;
      const result = await write(rows);
      const lastRowId = rows.at(-1)!.rowId;
      await this.#store.saveArchiveCheckpoint(this.#sourceId, table, lastRowId);
      this.#database.saveTelemetryArchiveCheckpoint(table, lastRowId);
      cursor = lastRowId;
      this.#status.archivedRows += result.affected;
      if (rows.length < this.#batchSize) return;
    }
  }

  async #flushDirtyRows(): Promise<void> {
    await this.#flushDirtyTable("legacy_readings", () => this.#database.readingArchiveDirtyPage(this.#batchSize),
      (rows) => this.#store.upsertLegacyReadings(rows.map(({ record }) => ({ ...record }))));
    await this.#flushDirtyTable(
      "outdoor_temperature_samples",
      () => this.#database.outdoorTemperatureArchiveDirtyPage(this.#batchSize),
      (rows) => this.#store.upsertOutdoorTemperatureSamples(rows.map(({ record }) => ({
        ...record,
        metadata: record.conditions ? { conditions: record.conditions } : {},
      }))),
    );
    await this.#flushDirtyTable(
      "electricity_price_samples",
      () => this.#database.electricityPriceArchiveDirtyPage(this.#batchSize),
      (rows) => this.#store.upsertElectricityPriceSamples(rows.map(({ record }) => ({ ...record }))),
    );
  }

  async #flushDirtyTable<T>(
    table: TelemetryArchiveMutableTable,
    page: () => TelemetryArchiveDirtyRow<T>[],
    write: (rows: TelemetryArchiveDirtyRow<T>[]) => Promise<{ affected: number }>,
  ): Promise<void> {
    while (!this.#stopping) {
      const rows = page();
      if (rows.length === 0) return;
      const result = await write(rows);
      this.#status.archivedRows += result.affected;
      // Version matching prevents an update that arrives during the network
      // write from being acknowledged accidentally; it remains for the next pass.
      this.#database.acknowledgeTelemetryArchiveDirtyRows(table, rows.map(({ dirtyId, version }) => ({
        dirtyId,
        version,
      })));
    }
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#status.phase = "stopped";
    this.#status.caughtUp = false;
    this.#removeMeasurementListener?.();
    this.#removeMeasurementListener = null;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#wakeTimer) clearTimeout(this.#wakeTimer);
    this.#timer = null;
    this.#wakeTimer = null;
    await this.#cyclePromise?.catch(() => undefined);
    await this.#store.close();
  }
}
