import { stat } from "node:fs/promises";
import type {
  HostSystemDatabaseStatus,
  HostSystemSqliteStatus,
  HostSystemState,
  HostSystemTelemetryDatabaseStatus,
} from "@climate-twin/contracts";
import type { ClimateDatabase } from "./db.js";
import type { TimeseriesStore } from "./timeseries/store.js";
import type { HostStorageHistory, HostStorageSample } from "./host-storage-forecast.js";

const DAY_MS = 86_400_000;
const SAMPLE_INTERVAL_MS = 30 * 60_000;
const HISTORY_RETENTION_MS = 30 * DAY_MS;
const DATABASE_SNAPSHOT_TTL_MS = 60_000;

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statePriority(state: HostSystemState): number {
  return state === "critical" ? 3 : state === "warning" ? 2 : state === "unknown" ? 1 : 0;
}

function worstState(left: HostSystemState, right: HostSystemState): HostSystemState {
  return statePriority(right) > statePriority(left) ? right : left;
}

export class SqliteHostStorageHistory implements HostStorageHistory {
  readonly #database: ClimateDatabase;
  #loaded = false;
  #samples: HostStorageSample[] = [];
  #lastPersistedAt = 0;

  constructor(database: ClimateDatabase) {
    this.#database = database;
  }

  observe(sample: HostStorageSample): HostStorageSample[] {
    try {
      if (!this.#loaded) this.#load(sample.sampledAtMs);
      if (sample.sampledAtMs - this.#lastPersistedAt >= SAMPLE_INTERVAL_MS) {
        const sampledAt = new Date(sample.sampledAtMs).toISOString();
        this.#database.db.prepare(`INSERT OR IGNORE INTO host_storage_samples
          (sampled_at, total_bytes, available_bytes) VALUES (?, ?, ?)`)
          .run(sampledAt, sample.totalBytes, sample.availableBytes);
        this.#samples.push(sample);
        this.#lastPersistedAt = sample.sampledAtMs;
        const cutoff = sample.sampledAtMs - HISTORY_RETENTION_MS;
        this.#database.db.prepare("DELETE FROM host_storage_samples WHERE sampled_at < ?")
          .run(new Date(cutoff).toISOString());
        this.#samples = this.#samples.filter((entry) => entry.sampledAtMs >= cutoff);
        return [...this.#samples];
      }
      return [...this.#samples, sample];
    } catch {
      return [sample];
    }
  }

  #load(nowMs: number): void {
    const cutoff = new Date(nowMs - HISTORY_RETENTION_MS).toISOString();
    const rows = this.#database.db.prepare(`SELECT sampled_at, total_bytes, available_bytes
      FROM host_storage_samples WHERE sampled_at >= ? ORDER BY sampled_at`).all(cutoff) as Array<{
        sampled_at: string;
        total_bytes: number;
        available_bytes: number;
      }>;
    this.#samples = rows.flatMap((row) => {
      const sampledAtMs = Date.parse(row.sampled_at);
      return Number.isFinite(sampledAtMs) ? [{
        sampledAtMs,
        totalBytes: row.total_bytes,
        availableBytes: row.available_bytes,
      }] : [];
    });
    this.#lastPersistedAt = this.#samples.at(-1)?.sampledAtMs ?? 0;
    this.#loaded = true;
  }
}

function unavailableSqlite(): HostSystemSqliteStatus {
  return {
    state: "unknown",
    sizeBytes: null,
    usedBytes: null,
    walBytes: null,
    pageCount: null,
    freePages: null,
    tableCount: null,
  };
}

export class HostDatabaseMetricsCollector {
  readonly #database: ClimateDatabase;
  readonly #databasePath: string;
  readonly #telemetryEnabled: boolean;
  readonly #telemetryRequired: boolean;
  #timeseries: TimeseriesStore | null = null;
  #cached: HostSystemDatabaseStatus | null = null;
  #cachedUntil = 0;
  #loading: Promise<HostSystemDatabaseStatus> | null = null;

  constructor(
    database: ClimateDatabase,
    options: { databasePath: string; telemetryEnabled: boolean; telemetryRequired: boolean },
  ) {
    this.#database = database;
    this.#databasePath = options.databasePath;
    this.#telemetryEnabled = options.telemetryEnabled;
    this.#telemetryRequired = options.telemetryRequired;
  }

  setTimeseries(timeseries: TimeseriesStore | null): void {
    this.#timeseries = timeseries;
    this.#cached = null;
    this.#cachedUntil = 0;
  }

  async snapshot(): Promise<HostSystemDatabaseStatus> {
    const now = Date.now();
    if (this.#cached && now < this.#cachedUntil) return this.#cached;
    if (this.#loading) return this.#loading;
    const loading = this.#collect().then((snapshot) => {
      this.#cached = snapshot;
      this.#cachedUntil = Date.now() + DATABASE_SNAPSHOT_TTL_MS;
      return snapshot;
    }).finally(() => {
      if (this.#loading === loading) this.#loading = null;
    });
    this.#loading = loading;
    return loading;
  }

  async #collect(): Promise<HostSystemDatabaseStatus> {
    const sqlite = await this.#sqlite().catch(unavailableSqlite);
    const telemetry = await this.#telemetry();
    const telemetryState: HostSystemState = telemetry.state === "disabled" ? "healthy" : telemetry.state;
    return {
      state: worstState(sqlite.state, telemetryState),
      sqlite,
      telemetry,
    };
  }

  async #sqlite(): Promise<HostSystemSqliteStatus> {
    const pageCount = numberValue((this.#database.db.prepare("PRAGMA page_count").get() as Record<string, unknown> | undefined)?.page_count);
    const pageSize = numberValue((this.#database.db.prepare("PRAGMA page_size").get() as Record<string, unknown> | undefined)?.page_size);
    const freePages = numberValue((this.#database.db.prepare("PRAGMA freelist_count").get() as Record<string, unknown> | undefined)?.freelist_count);
    const tableCount = numberValue((this.#database.db.prepare(
      "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).get() as Record<string, unknown> | undefined)?.count);
    const sizeBytes = pageCount === null || pageSize === null ? null : pageCount * pageSize;
    const usedBytes = sizeBytes === null || freePages === null || pageSize === null
      ? null
      : Math.max(0, sizeBytes - freePages * pageSize);
    let walBytes = 0;
    if (this.#databasePath !== ":memory:") {
      walBytes = await stat(`${this.#databasePath}-wal`).then((value) => value.size, () => 0);
    }
    return { state: "healthy", sizeBytes, usedBytes, walBytes, pageCount, freePages, tableCount };
  }

  async #telemetry(): Promise<HostSystemTelemetryDatabaseStatus> {
    if (!this.#telemetryEnabled) {
      return {
        enabled: false,
        required: false,
        state: "disabled",
        sizeBytes: null,
        latencyMilliseconds: null,
        pool: null,
        queries: null,
      };
    }
    if (!this.#timeseries) return this.#unavailableTelemetry();
    const health = await this.#timeseries.health({ timeoutMs: 5_000 });
    const diagnostics = this.#timeseries.diagnostics();
    return {
      enabled: true,
      required: this.#telemetryRequired,
      state: health.ok ? "healthy" : this.#telemetryRequired ? "critical" : "warning",
      sizeBytes: health.databaseSizeBytes,
      latencyMilliseconds: Number(health.latencyMs.toFixed(2)),
      pool: health.pool,
      queries: {
        active: diagnostics.active,
        started: diagnostics.started,
        succeeded: diagnostics.succeeded,
        failed: diagnostics.failed,
        averageDurationMilliseconds: Number(diagnostics.averageDurationMs.toFixed(2)),
        maximumDurationMilliseconds: Number(diagnostics.maxDurationMs.toFixed(2)),
        averagePoolWaitMilliseconds: Number(diagnostics.averagePoolWaitMs.toFixed(2)),
        maximumPoolWaitMilliseconds: Number(diagnostics.maxPoolWaitMs.toFixed(2)),
      },
    };
  }

  #unavailableTelemetry(): HostSystemTelemetryDatabaseStatus {
    return {
      enabled: true,
      required: this.#telemetryRequired,
      state: this.#telemetryRequired ? "critical" : "warning",
      sizeBytes: null,
      latencyMilliseconds: null,
      pool: null,
      queries: null,
    };
  }
}
