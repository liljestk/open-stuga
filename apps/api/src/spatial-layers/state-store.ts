import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  PersistedSpatialLayerSnapshot,
  SpatialConfigurationVersion,
  SpatialCalibrationSession,
  SpatialDataPartition,
  SpatialEngineAssignment,
  SpatialGroundTruth,
  SpatialInferenceRun,
  SpatialLayerSnapshotDraft,
  SpatialRunStatus,
  SpatialScope,
  StoredSpatialContextEvent,
  StoredSpatialSensorBinding,
  StoredSpatialSensorCalibration,
} from "./types.js";

const FAR_FUTURE = "9999-12-31T23:59:59.999Z";

type SqlRow = Record<string, unknown>;

export class SpatialStateValidationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class NonDeterministicSpatialOutputError extends SpatialStateValidationError {
  constructor(layerId: string, bucketAt: string) {
    super(
      409,
      "NON_DETERMINISTIC_ENGINE_OUTPUT",
      `Engine returned different ${layerId} output for the same inputs at ${bucketAt}`,
    );
  }
}

export function deriveSpatialStatePath(coreDatabasePath: string): string {
  if (coreDatabasePath === ":memory:") return ":memory:";
  const absolute = resolve(coreDatabasePath);
  return resolve(dirname(absolute), `${basename(absolute)}.spatial-layers.sqlite`);
}

/** Legacy path-derived identity retained only to migrate pre-UUID spatial state. */
export function sourceDatabaseId(coreDatabasePath: string, memoryInstanceId = "default"): string {
  const material = coreDatabasePath === ":memory:"
    ? `memory:${memoryInstanceId}`
    : `file:${resolve(coreDatabasePath).toLowerCase()}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 24);
}

export class SpatialSourceIdentityCollisionError extends Error {
  readonly code = "SPATIAL_SOURCE_ID_COLLISION";

  constructor(
    readonly legacySourceDbId: string,
    readonly stableSourceDbId: string,
    readonly dataMode: SpatialDataPartition["dataMode"],
  ) {
    super(
      `Cannot migrate the legacy spatial ${dataMode} partition from ${legacySourceDbId} to ${stableSourceDbId}: `
      + "the stable-identity target already contains spatial state",
    );
  }
}

function parseJson<T>(value: unknown): T {
  if (typeof value !== "string") throw new TypeError("Expected persisted JSON text");
  return JSON.parse(value) as T;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function assertIsoTimestamp(value: string, field: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new SpatialStateValidationError(400, "INVALID_TIMESTAMP", `${field} must be an ISO timestamp`);
  }
}

function assertInterval(from: string, to: string | null, fromField: string, toField: string): void {
  assertIsoTimestamp(from, fromField);
  if (to !== null) {
    assertIsoTimestamp(to, toField);
    if (Date.parse(to) <= Date.parse(from)) {
      throw new SpatialStateValidationError(400, "INVALID_INTERVAL", `${toField} must be after ${fromField}`);
    }
  }
}

function scopeParams(scope: SpatialScope): [string, string] {
  return [scope.kind, scope.id];
}

function partitionParams(partition: SpatialDataPartition): [string, string] {
  return [partition.sourceDbId, partition.dataMode];
}

function sqlIdentifier(value: string): string {
  if (!/^spatial_[a-z0-9_]+$/i.test(value)) throw new Error(`Unsafe spatial table name ${value}`);
  return `"${value.replaceAll('"', '""')}"`;
}

function scopeFromRow(row: SqlRow): SpatialScope {
  const kind = String(row.scope_kind);
  if (kind !== "house" && kind !== "property") throw new Error(`Invalid spatial scope kind ${kind}`);
  return { kind, id: String(row.scope_id) };
}

function partitionFromRow(row: SqlRow): SpatialDataPartition {
  const dataMode = String(row.data_mode);
  if (dataMode !== "demo" && dataMode !== "real") throw new Error(`Invalid spatial data mode ${dataMode}`);
  return { sourceDbId: String(row.source_db_id), dataMode };
}

/**
 * Early spatial databases used a SQL-safe underscore for co-location even
 * though the public contract has always used the hyphenated spelling. Keep
 * that storage encoding so existing databases remain readable without a
 * destructive table rebuild, but never let it escape through the API.
 */
function calibrationMethodForStorage(method: StoredSpatialSensorCalibration["method"]): string {
  return method === "co-location" ? "co_location" : method;
}

function calibrationMethodFromStorage(value: unknown): StoredSpatialSensorCalibration["method"] {
  const method = String(value);
  if (method === "co_location" || method === "co-location") return "co-location";
  if (method === "manual" || method === "factory" || method === "estimated") return method;
  throw new Error(`Invalid spatial calibration method ${method}`);
}

function snapshotFromRow(row: SqlRow): PersistedSpatialLayerSnapshot {
  const payload = parseJson<Pick<PersistedSpatialLayerSnapshot,
    "coordinateFrames" | "reasonCodes" | "zones" | "connections" | "points" | "metadata">>(row.payload_json);
  return {
    id: String(row.id),
    partition: partitionFromRow(row),
    scope: scopeFromRow(row),
    layerId: String(row.layer_id),
    generatedAt: String(row.bucket_at),
    windowStart: String(row.window_start),
    windowEnd: String(row.window_end),
    status: row.status as PersistedSpatialLayerSnapshot["status"],
    model: parseJson<PersistedSpatialLayerSnapshot["model"]>(row.model_json),
    configVersion: String(row.config_version),
    inputDigest: String(row.input_digest),
    qualityScore: Number(row.quality_score),
    warnings: parseJson<string[]>(row.warnings_json),
    coordinateFrames: payload.coordinateFrames,
    reasonCodes: payload.reasonCodes,
    zones: payload.zones,
    connections: payload.connections,
    points: payload.points,
    ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
    revision: Number(row.revision),
    supersedesSnapshotId: row.supersedes_snapshot_id === null ? null : String(row.supersedes_snapshot_id),
    createdAt: String(row.created_at),
  };
}

function runFromRow(row: SqlRow): SpatialInferenceRun {
  return {
    id: String(row.id),
    partition: partitionFromRow(row),
    scope: scopeFromRow(row),
    engineId: String(row.engine_id),
    engineVersion: String(row.engine_version),
    bucketAt: String(row.bucket_at),
    configVersion: Number(row.config_version),
    status: row.status as SpatialRunStatus,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    inputDigest: row.input_digest === null ? null : String(row.input_digest),
    snapshotIds: parseJson<string[]>(row.snapshot_ids_json),
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
  };
}

export interface SpatialInferenceJob {
  id: string;
  partition: SpatialDataPartition;
  scope: SpatialScope;
  bucketAt: string;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  reason: string;
  availableAt: string;
  attempts: number;
  lastError: string | null;
  lockToken: string | null;
  createdAt: string;
  updatedAt: string;
}

export class SpatialLayerStateStore {
  readonly db: DatabaseSync;
  #transactionDepth = 0;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    const db = new DatabaseSync(path);
    this.db = db;
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      this.migrate();
    } catch (error) {
      // A corrupt or incompatible optional state database must not leave a
      // partially constructed SQLite handle behind. On Windows that handle
      // also keeps the file locked after the research subsystem fails open.
      try {
        db.close();
      } catch {
        // Preserve the initialization error, which is the actionable failure.
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(operation: () => T): T {
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

  private migrate(): void {
    this.transaction(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS spatial_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO spatial_metadata(key, value) VALUES ('schema_version', '1');

      CREATE TABLE IF NOT EXISTS spatial_config_versions (
        source_db_id TEXT NOT NULL,
        data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'real')),
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('house', 'property')),
        scope_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT,
        PRIMARY KEY(source_db_id, data_mode, scope_kind, scope_id, version)
      );

      CREATE TABLE IF NOT EXISTS spatial_sensor_bindings (
        source_db_id TEXT NOT NULL,
        data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'real')),
        id TEXT NOT NULL,
        house_id TEXT NOT NULL,
        sensor_id TEXT NOT NULL,
        zone_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('primary', 'supporting', 'outdoor')),
        placement_json TEXT NOT NULL,
        active_from TEXT NOT NULL,
        active_to TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(source_db_id, data_mode, id)
      );
      CREATE INDEX IF NOT EXISTS idx_spatial_bindings_lookup
        ON spatial_sensor_bindings(source_db_id, data_mode, house_id, sensor_id, active_from, active_to);

      CREATE TABLE IF NOT EXISTS spatial_sensor_calibrations (
        source_db_id TEXT NOT NULL,
        data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'real')),
        id TEXT NOT NULL,
        house_id TEXT NOT NULL,
        sensor_id TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        temperature_offset_c REAL NOT NULL,
        humidity_offset_pct REAL NOT NULL,
        response_lag_seconds REAL,
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        method TEXT NOT NULL CHECK (method IN ('co_location', 'manual', 'factory', 'estimated')),
        created_at TEXT NOT NULL,
        PRIMARY KEY(source_db_id, data_mode, id)
      );
      CREATE INDEX IF NOT EXISTS idx_spatial_calibrations_lookup
        ON spatial_sensor_calibrations(source_db_id, data_mode, house_id, sensor_id, valid_from, valid_to);

      CREATE TABLE IF NOT EXISTS spatial_calibration_sessions (
        source_db_id TEXT NOT NULL,
        data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'real')),
        id TEXT NOT NULL,
        house_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('co-location', 'controlled-propagation', 'empty-house-baseline')),
        status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'completed', 'cancelled')),
        start_at TEXT NOT NULL,
        end_at TEXT,
        intervention_json TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(source_db_id, data_mode, id)
      );
      CREATE INDEX IF NOT EXISTS idx_spatial_calibration_sessions_house
        ON spatial_calibration_sessions(source_db_id, data_mode, house_id, start_at DESC);

      CREATE TABLE IF NOT EXISTS spatial_context_events (
        source_db_id TEXT NOT NULL,
        data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'real')),
        id TEXT NOT NULL,
        house_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT,
        zone_id TEXT,
        source TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(source_db_id, data_mode, id)
      );
      CREATE INDEX IF NOT EXISTS idx_spatial_context_window
        ON spatial_context_events(source_db_id, data_mode, house_id, start_at, end_at);

      CREATE TABLE IF NOT EXISTS spatial_engine_assignments (
        source_db_id TEXT NOT NULL,
        data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'real')),
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('house', 'property')),
        scope_id TEXT NOT NULL,
        engine_id TEXT NOT NULL,
        engine_version TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        layer_ids_json TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(source_db_id, data_mode, scope_kind, scope_id, engine_id)
      );

      CREATE TABLE IF NOT EXISTS spatial_inference_runs (
        source_db_id TEXT NOT NULL,
        data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'real')),
        id TEXT NOT NULL,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('house', 'property')),
        scope_id TEXT NOT NULL,
        engine_id TEXT NOT NULL,
        engine_version TEXT NOT NULL,
        bucket_at TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'timed_out', 'skipped')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        input_digest TEXT,
        snapshot_ids_json TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        duration_ms INTEGER,
        PRIMARY KEY(source_db_id, data_mode, id)
      );
      CREATE INDEX IF NOT EXISTS idx_spatial_runs_scope_time
        ON spatial_inference_runs(source_db_id, data_mode, scope_kind, scope_id, bucket_at DESC);

      CREATE TABLE IF NOT EXISTS spatial_layer_snapshots (
        source_db_id TEXT NOT NULL,
        data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'real')),
        id TEXT NOT NULL,
        snapshot_key TEXT NOT NULL,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('house', 'property')),
        scope_id TEXT NOT NULL,
        layer_id TEXT NOT NULL,
        bucket_at TEXT NOT NULL,
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ready', 'warming_up', 'insufficient_data', 'error')),
        model_json TEXT NOT NULL,
        config_version TEXT NOT NULL,
        input_digest TEXT NOT NULL,
        quality_score REAL NOT NULL CHECK (quality_score >= 0 AND quality_score <= 1),
        warnings_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
        supersedes_snapshot_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(source_db_id, data_mode, id),
        UNIQUE(source_db_id, data_mode, snapshot_key, revision)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_spatial_snapshot_one_current
        ON spatial_layer_snapshots(source_db_id, data_mode, snapshot_key) WHERE is_current = 1;
      CREATE INDEX IF NOT EXISTS idx_spatial_snapshots_history
        ON spatial_layer_snapshots(source_db_id, data_mode, scope_kind, scope_id, layer_id, bucket_at DESC, revision DESC);

      CREATE TABLE IF NOT EXISTS spatial_ground_truth (
        source_db_id TEXT NOT NULL,
        data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'real')),
        id TEXT NOT NULL,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('house', 'property')),
        scope_id TEXT NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT,
        label TEXT NOT NULL,
        zone_id TEXT,
        from_zone_id TEXT,
        to_zone_id TEXT,
        source TEXT NOT NULL CHECK (source IN ('user', 'optional_sensor', 'controlled_test')),
        note TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT,
        PRIMARY KEY(source_db_id, data_mode, id)
      );
      CREATE INDEX IF NOT EXISTS idx_spatial_ground_truth_window
        ON spatial_ground_truth(source_db_id, data_mode, scope_kind, scope_id, start_at DESC);

      CREATE TABLE IF NOT EXISTS spatial_inference_jobs (
        source_db_id TEXT NOT NULL,
        data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'real')),
        id TEXT NOT NULL,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('house', 'property')),
        scope_id TEXT NOT NULL,
        bucket_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
        reason TEXT NOT NULL,
        available_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        lock_token TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(source_db_id, data_mode, id),
        UNIQUE(source_db_id, data_mode, scope_kind, scope_id, bucket_at)
      );
      CREATE INDEX IF NOT EXISTS idx_spatial_jobs_due
        ON spatial_inference_jobs(source_db_id, data_mode, status, available_at);

      CREATE TABLE IF NOT EXISTS spatial_checkpoints (
        source_db_id TEXT NOT NULL,
        data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'real')),
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('house', 'property')),
        scope_id TEXT NOT NULL,
        checkpoint_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(source_db_id, data_mode, scope_kind, scope_id, checkpoint_key)
      );
    `));
  }

  /**
   * Re-keys state written by the former database-path identity scheme to the
   * stable UUID persisted by the core database. Demo and real rows remain in
   * separate partitions. Detection and updates share one IMMEDIATE
   * transaction, and a populated target causes the entire migration to roll
   * back rather than merging two potentially unrelated datasets.
   */
  rekeyLegacySourceDatabaseId(legacySourceDbId: string, stableSourceDbId: string): {
    migratedModes: SpatialDataPartition["dataMode"][];
    migratedRows: number;
  } {
    if (!legacySourceDbId || !stableSourceDbId) throw new Error("Spatial source database identities must not be empty");
    if (legacySourceDbId === stableSourceDbId) return { migratedModes: [], migratedRows: 0 };

    return this.transaction(() => {
      const tableRows = this.db.prepare(`SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name LIKE 'spatial_%' ORDER BY name`).all() as unknown as Array<{ name: string }>;
      const partitionTables = tableRows.map((row) => row.name).filter((name) => {
        const columns = this.db.prepare(`PRAGMA table_info(${sqlIdentifier(name)})`).all() as unknown as Array<{ name: string }>;
        const names = new Set(columns.map((column) => column.name));
        return names.has("source_db_id") && names.has("data_mode");
      });
      if (partitionTables.length === 0) throw new Error("Spatial state schema has no source-partitioned tables");

      const modes: SpatialDataPartition["dataMode"][] = ["demo", "real"];
      const modesToMigrate: SpatialDataPartition["dataMode"][] = [];
      for (const dataMode of modes) {
        const legacyPresent = partitionTables.some((table) => Boolean(this.db.prepare(
          `SELECT 1 AS present FROM ${sqlIdentifier(table)} WHERE source_db_id = ? AND data_mode = ? LIMIT 1`,
        ).get(legacySourceDbId, dataMode)));
        if (!legacyPresent) continue;
        const targetPresent = partitionTables.some((table) => Boolean(this.db.prepare(
          `SELECT 1 AS present FROM ${sqlIdentifier(table)} WHERE source_db_id = ? AND data_mode = ? LIMIT 1`,
        ).get(stableSourceDbId, dataMode)));
        if (targetPresent) {
          throw new SpatialSourceIdentityCollisionError(legacySourceDbId, stableSourceDbId, dataMode);
        }
        modesToMigrate.push(dataMode);
      }

      let migratedRows = 0;
      for (const dataMode of modesToMigrate) {
        for (const table of partitionTables) {
          // A single UPDATE of the snapshot table can exceed a deliberately
          // small container /tmp while SQLite stages changed primary keys.
          // Bounded rowid batches keep temporary space constant while the
          // outer transaction still makes the complete cross-table re-key
          // atomic and collision-safe.
          const identifier = sqlIdentifier(table);
          const updateBatch = this.db.prepare(`UPDATE ${identifier} SET source_db_id = ? WHERE rowid IN (
            SELECT rowid FROM ${identifier} WHERE source_db_id = ? AND data_mode = ? LIMIT 128
          )`);
          while (true) {
            const changed = Number(updateBatch.run(stableSourceDbId, legacySourceDbId, dataMode).changes);
            migratedRows += changed;
            if (changed === 0) break;
          }
        }
      }
      return { migratedModes: modesToMigrate, migratedRows };
    });
  }

  getCurrentConfiguration(partition: SpatialDataPartition, scope: SpatialScope): SpatialConfigurationVersion {
    const row = this.db.prepare(`SELECT * FROM spatial_config_versions
      WHERE source_db_id = ? AND data_mode = ? AND scope_kind = ? AND scope_id = ?
      ORDER BY version DESC LIMIT 1`).get(...partitionParams(partition), ...scopeParams(scope)) as SqlRow | undefined;
    if (!row) return { scope, version: 0, config: {}, createdAt: new Date(0).toISOString(), createdBy: null };
    return {
      scope,
      version: Number(row.version),
      config: parseJson<Record<string, unknown>>(row.config_json),
      createdAt: String(row.created_at),
      createdBy: row.created_by === null ? null : String(row.created_by),
    };
  }

  putConfiguration(input: {
    partition: SpatialDataPartition;
    scope: SpatialScope;
    baseVersion: number;
    config: Record<string, unknown>;
    createdAt?: string;
    createdBy?: string | null;
  }): SpatialConfigurationVersion {
    return this.transaction(() => {
      const current = this.getCurrentConfiguration(input.partition, input.scope);
      if (current.version !== input.baseVersion) {
        throw new SpatialStateValidationError(
          409,
          "CONFIG_VERSION_CONFLICT",
          `Configuration changed from version ${input.baseVersion} to ${current.version}`,
        );
      }
      const createdAt = input.createdAt ?? new Date().toISOString();
      const version = current.version + 1;
      this.db.prepare(`INSERT INTO spatial_config_versions
        (source_db_id, data_mode, scope_kind, scope_id, version, config_json, created_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...partitionParams(input.partition), ...scopeParams(input.scope), version, stableJson(input.config), createdAt, input.createdBy ?? null);
      return { scope: input.scope, version, config: structuredClone(input.config), createdAt, createdBy: input.createdBy ?? null };
    });
  }

  putConfigurationBundle(input: {
    partition: SpatialDataPartition;
    scope: SpatialScope;
    baseVersion: number;
    config: Record<string, unknown>;
    assignments: Array<Omit<SpatialEngineAssignment, "scope" | "configVersion" | "updatedAt">>;
    createdAt?: string;
    createdBy?: string | null;
  }): { configuration: SpatialConfigurationVersion; assignments: SpatialEngineAssignment[] } {
    return this.transaction(() => {
      const createdAt = input.createdAt ?? new Date().toISOString();
      const configuration = this.putConfiguration({
        partition: input.partition,
        scope: input.scope,
        baseVersion: input.baseVersion,
        config: input.config,
        createdAt,
        createdBy: input.createdBy ?? null,
      });
      const assignments = input.assignments.map((assignment) => this.putAssignment(input.partition, {
        ...assignment,
        scope: input.scope,
        configVersion: configuration.version,
        updatedAt: createdAt,
      }));
      return { configuration, assignments };
    });
  }

  listAssignments(partition: SpatialDataPartition, scope: SpatialScope, includeDisabled = true): SpatialEngineAssignment[] {
    const disabledClause = includeDisabled ? "" : "AND enabled = 1";
    const rows = this.db.prepare(`SELECT * FROM spatial_engine_assignments
      WHERE source_db_id = ? AND data_mode = ? AND scope_kind = ? AND scope_id = ? ${disabledClause}
      ORDER BY engine_id`).all(...partitionParams(partition), ...scopeParams(scope)) as SqlRow[];
    return rows.map((row) => ({
      scope,
      engineId: String(row.engine_id),
      engineVersion: String(row.engine_version),
      enabled: Number(row.enabled) === 1,
      layerIds: parseJson<string[]>(row.layer_ids_json),
      configVersion: Number(row.config_version),
      updatedAt: String(row.updated_at),
    }));
  }

  putAssignment(partition: SpatialDataPartition, assignment: SpatialEngineAssignment): SpatialEngineAssignment {
    this.db.prepare(`INSERT INTO spatial_engine_assignments
      (source_db_id, data_mode, scope_kind, scope_id, engine_id, engine_version, enabled, layer_ids_json, config_version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_db_id, data_mode, scope_kind, scope_id, engine_id) DO UPDATE SET
        engine_version = excluded.engine_version, enabled = excluded.enabled,
        layer_ids_json = excluded.layer_ids_json, config_version = excluded.config_version, updated_at = excluded.updated_at`)
      .run(...partitionParams(partition), ...scopeParams(assignment.scope), assignment.engineId, assignment.engineVersion,
        assignment.enabled ? 1 : 0, stableJson(assignment.layerIds), assignment.configVersion, assignment.updatedAt);
    return structuredClone(assignment);
  }

  putAssignments(partition: SpatialDataPartition, assignments: SpatialEngineAssignment[]): SpatialEngineAssignment[] {
    return this.transaction(() => assignments.map((assignment) => this.putAssignment(partition, assignment)));
  }

  addBinding(partition: SpatialDataPartition, binding: StoredSpatialSensorBinding): StoredSpatialSensorBinding {
    assertInterval(binding.activeFrom, binding.activeTo ?? null, "activeFrom", "activeTo");
    const overlap = this.db.prepare(`SELECT id FROM spatial_sensor_bindings
      WHERE source_db_id = ? AND data_mode = ? AND sensor_id = ?
        AND active_from < COALESCE(?, ?) AND COALESCE(active_to, ?) > ? LIMIT 1`)
      .get(...partitionParams(partition), binding.sensorId, binding.activeTo ?? null, FAR_FUTURE, FAR_FUTURE, binding.activeFrom) as SqlRow | undefined;
    if (overlap) {
      throw new SpatialStateValidationError(409, "BINDING_INTERVAL_OVERLAP", `Sensor ${binding.sensorId} already has a binding in this interval`);
    }
    this.db.prepare(`INSERT INTO spatial_sensor_bindings
      (source_db_id, data_mode, id, house_id, sensor_id, zone_id, role, placement_json, active_from, active_to, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...partitionParams(partition), binding.id, binding.houseId, binding.sensorId, binding.zoneId, binding.role,
        stableJson({
          frameId: binding.frameId,
          position: binding.position,
          placementRisks: binding.placementRisks ?? [],
        }), binding.activeFrom, binding.activeTo ?? null, binding.createdAt);
    return structuredClone(binding);
  }

  listBindings(partition: SpatialDataPartition, houseId: string, from?: string, to?: string): StoredSpatialSensorBinding[] {
    const rows = (from && to
      ? this.db.prepare(`SELECT * FROM spatial_sensor_bindings WHERE source_db_id = ? AND data_mode = ? AND house_id = ?
          AND active_from <= ? AND COALESCE(active_to, ?) >= ? ORDER BY sensor_id, active_from`)
        .all(...partitionParams(partition), houseId, to, FAR_FUTURE, from)
      : this.db.prepare(`SELECT * FROM spatial_sensor_bindings WHERE source_db_id = ? AND data_mode = ? AND house_id = ?
          ORDER BY sensor_id, active_from`).all(...partitionParams(partition), houseId)) as SqlRow[];
    return rows.map((row) => {
      const placement = parseJson<{
        frameId: string;
        position: { x: number; y: number; z: number };
        placementRisks: StoredSpatialSensorBinding["placementRisks"];
      }>(row.placement_json);
      return {
        id: String(row.id), houseId: String(row.house_id), sensorId: String(row.sensor_id), zoneId: String(row.zone_id),
        role: row.role as StoredSpatialSensorBinding["role"], frameId: placement.frameId, position: placement.position,
        activeFrom: String(row.active_from), ...(row.active_to === null ? {} : { activeTo: String(row.active_to) }),
        ...(placement.placementRisks && placement.placementRisks.length > 0 ? { placementRisks: placement.placementRisks } : {}),
        createdAt: String(row.created_at),
      };
    });
  }

  addCalibration(partition: SpatialDataPartition, calibration: StoredSpatialSensorCalibration): StoredSpatialSensorCalibration {
    assertInterval(calibration.validFrom, calibration.validTo ?? null, "validFrom", "validTo");
    if (!Number.isFinite(calibration.confidence) || calibration.confidence < 0 || calibration.confidence > 1) {
      throw new SpatialStateValidationError(400, "INVALID_CONFIDENCE", "Calibration confidence must be between 0 and 1");
    }
    const overlap = this.db.prepare(`SELECT id FROM spatial_sensor_calibrations
      WHERE source_db_id = ? AND data_mode = ? AND sensor_id = ?
        AND valid_from < COALESCE(?, ?) AND COALESCE(valid_to, ?) > ? LIMIT 1`)
      .get(...partitionParams(partition), calibration.sensorId, calibration.validTo ?? null, FAR_FUTURE, FAR_FUTURE, calibration.validFrom) as SqlRow | undefined;
    if (overlap) {
      throw new SpatialStateValidationError(409, "CALIBRATION_INTERVAL_OVERLAP", `Sensor ${calibration.sensorId} already has calibration in this interval`);
    }
    this.db.prepare(`INSERT INTO spatial_sensor_calibrations
      (source_db_id, data_mode, id, house_id, sensor_id, valid_from, valid_to, temperature_offset_c,
       humidity_offset_pct, response_lag_seconds, confidence, method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...partitionParams(partition), calibration.id, calibration.houseId, calibration.sensorId,
        calibration.validFrom, calibration.validTo ?? null, calibration.temperatureOffsetC, calibration.humidityOffsetPct,
        calibration.responseLagSeconds ?? null, calibration.confidence, calibrationMethodForStorage(calibration.method), calibration.createdAt);
    return structuredClone(calibration);
  }

  listCalibrations(partition: SpatialDataPartition, houseId: string, from?: string, to?: string): StoredSpatialSensorCalibration[] {
    const rows = (from && to
      ? this.db.prepare(`SELECT * FROM spatial_sensor_calibrations WHERE source_db_id = ? AND data_mode = ? AND house_id = ?
          AND valid_from <= ? AND COALESCE(valid_to, ?) >= ? ORDER BY sensor_id, valid_from`)
        .all(...partitionParams(partition), houseId, to, FAR_FUTURE, from)
      : this.db.prepare(`SELECT * FROM spatial_sensor_calibrations WHERE source_db_id = ? AND data_mode = ? AND house_id = ?
          ORDER BY sensor_id, valid_from`).all(...partitionParams(partition), houseId)) as SqlRow[];
    return rows.map((row) => ({
      id: String(row.id), houseId: String(row.house_id), sensorId: String(row.sensor_id), validFrom: String(row.valid_from),
      ...(row.valid_to === null ? {} : { validTo: String(row.valid_to) }), temperatureOffsetC: Number(row.temperature_offset_c),
      humidityOffsetPct: Number(row.humidity_offset_pct), ...(row.response_lag_seconds === null ? {} : { responseLagSeconds: Number(row.response_lag_seconds) }),
      confidence: Number(row.confidence), method: calibrationMethodFromStorage(row.method), createdAt: String(row.created_at),
    }));
  }

  addCalibrationSession(partition: SpatialDataPartition, session: SpatialCalibrationSession): SpatialCalibrationSession {
    assertInterval(session.startAt, session.endAt, "startAt", "endAt");
    this.db.prepare(`INSERT INTO spatial_calibration_sessions
      (source_db_id, data_mode, id, house_id, kind, status, start_at, end_at, intervention_json, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...partitionParams(partition), session.id, session.houseId, session.kind, session.status, session.startAt,
        session.endAt, stableJson(session.intervention), session.notes, session.createdAt, session.updatedAt);
    return structuredClone(session);
  }

  /**
   * Store a calibration session and its child calibrations as one durable unit.
   *
   * Route-level parsing deliberately happens before this method is called, but
   * database constraints (including interval overlap checks) can still fail.
   * Keeping both inserts in the same SQLite transaction prevents a session or
   * an earlier child from surviving a later-child failure.
   */
  addCalibrationSessionBundle(
    partition: SpatialDataPartition,
    session: SpatialCalibrationSession,
    calibrations: StoredSpatialSensorCalibration[],
  ): { session: SpatialCalibrationSession; calibrations: StoredSpatialSensorCalibration[] } {
    return this.transaction(() => ({
      session: this.addCalibrationSession(partition, session),
      calibrations: calibrations.map((calibration) => this.addCalibration(partition, calibration)),
    }));
  }

  listCalibrationSessions(partition: SpatialDataPartition, houseId: string): SpatialCalibrationSession[] {
    const rows = this.db.prepare(`SELECT * FROM spatial_calibration_sessions
      WHERE source_db_id = ? AND data_mode = ? AND house_id = ? ORDER BY start_at DESC`)
      .all(...partitionParams(partition), houseId) as SqlRow[];
    return rows.map((row) => ({
      id: String(row.id), houseId: String(row.house_id), kind: row.kind as SpatialCalibrationSession["kind"],
      status: row.status as SpatialCalibrationSession["status"], startAt: String(row.start_at),
      endAt: row.end_at === null ? null : String(row.end_at), intervention: parseJson<Record<string, unknown>>(row.intervention_json),
      notes: row.notes === null ? null : String(row.notes), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }));
  }

  addContextEvent(partition: SpatialDataPartition, event: StoredSpatialContextEvent): StoredSpatialContextEvent {
    assertInterval(event.startAt, event.endAt ?? null, "startAt", "endAt");
    this.db.prepare(`INSERT INTO spatial_context_events
      (source_db_id, data_mode, id, house_id, event_type, start_at, end_at, zone_id, source, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...partitionParams(partition), event.id, event.houseId, event.kind, event.startAt, event.endAt ?? null,
        event.zoneIds?.[0] ?? null, event.source, stableJson({
          ...event.payload,
          ...(event.zoneIds === undefined ? {} : { zoneIds: event.zoneIds }),
          ...(event.strength === undefined ? {} : { strength: event.strength }),
        }), event.createdAt);
    return structuredClone(event);
  }

  listContextEvents(partition: SpatialDataPartition, houseId: string, from: string, to: string): StoredSpatialContextEvent[] {
    const rows = this.db.prepare(`SELECT * FROM spatial_context_events
      WHERE source_db_id = ? AND data_mode = ? AND house_id = ?
        AND start_at <= ? AND COALESCE(end_at, start_at) >= ? ORDER BY start_at`)
      .all(...partitionParams(partition), houseId, to, from) as SqlRow[];
    return rows.map((row) => {
      const payload = parseJson<Record<string, unknown> & { zoneIds?: string[]; strength?: number }>(row.payload_json);
      const { zoneIds, strength, ...extra } = payload;
      return {
        id: String(row.id), houseId: String(row.house_id), kind: String(row.event_type) as StoredSpatialContextEvent["kind"],
        startAt: String(row.start_at), ...(row.end_at === null ? {} : { endAt: String(row.end_at) }),
        ...(zoneIds === undefined ? {} : { zoneIds }), ...(strength === undefined ? {} : { strength }),
        source: String(row.source), payload: extra, createdAt: String(row.created_at),
      };
    });
  }

  addGroundTruth(partition: SpatialDataPartition, truth: SpatialGroundTruth): SpatialGroundTruth {
    assertInterval(truth.startAt, truth.endAt, "startAt", "endAt");
    this.db.prepare(`INSERT INTO spatial_ground_truth
      (source_db_id, data_mode, id, scope_kind, scope_id, start_at, end_at, label, zone_id, from_zone_id,
       to_zone_id, source, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...partitionParams(partition), truth.id, ...scopeParams(truth.scope), truth.startAt, truth.endAt, truth.label,
        truth.zoneId, truth.fromZoneId, truth.toZoneId, truth.source, truth.note, truth.createdAt, truth.createdBy);
    return structuredClone(truth);
  }

  listGroundTruth(partition: SpatialDataPartition, scope: SpatialScope, from?: string, to?: string): SpatialGroundTruth[] {
    const rows = (from && to
      ? this.db.prepare(`SELECT * FROM spatial_ground_truth WHERE source_db_id = ? AND data_mode = ? AND scope_kind = ? AND scope_id = ?
          AND start_at <= ? AND COALESCE(end_at, start_at) >= ? ORDER BY start_at DESC`)
        .all(...partitionParams(partition), ...scopeParams(scope), to, from)
      : this.db.prepare(`SELECT * FROM spatial_ground_truth WHERE source_db_id = ? AND data_mode = ? AND scope_kind = ? AND scope_id = ?
          ORDER BY start_at DESC`).all(...partitionParams(partition), ...scopeParams(scope))) as SqlRow[];
    return rows.map((row) => ({
      id: String(row.id), scope, startAt: String(row.start_at), endAt: row.end_at === null ? null : String(row.end_at),
      label: String(row.label), zoneId: row.zone_id === null ? null : String(row.zone_id),
      fromZoneId: row.from_zone_id === null ? null : String(row.from_zone_id), toZoneId: row.to_zone_id === null ? null : String(row.to_zone_id),
      source: row.source as SpatialGroundTruth["source"], note: row.note === null ? null : String(row.note),
      createdAt: String(row.created_at), createdBy: row.created_by === null ? null : String(row.created_by),
    }));
  }

  startRun(input: Omit<SpatialInferenceRun, "id" | "status" | "finishedAt" | "inputDigest" | "snapshotIds" | "errorCode" | "errorMessage" | "durationMs"> & { id?: string }): SpatialInferenceRun {
    const run: SpatialInferenceRun = {
      ...input,
      id: input.id ?? randomUUID(),
      status: "running",
      finishedAt: null,
      inputDigest: null,
      snapshotIds: [],
      errorCode: null,
      errorMessage: null,
      durationMs: null,
    };
    this.db.prepare(`INSERT INTO spatial_inference_runs
      (source_db_id, data_mode, id, scope_kind, scope_id, engine_id, engine_version, bucket_at, config_version,
       status, started_at, finished_at, input_digest, snapshot_ids_json, error_code, error_message, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '[]', NULL, NULL, NULL)`)
      .run(...partitionParams(run.partition), run.id, ...scopeParams(run.scope), run.engineId, run.engineVersion,
        run.bucketAt, run.configVersion, run.status, run.startedAt);
    return run;
  }

  finishRun(partition: SpatialDataPartition, id: string, result: {
    status: Exclude<SpatialRunStatus, "running">;
    finishedAt: string;
    inputDigest?: string | null;
    snapshotIds?: string[];
    errorCode?: string | null;
    errorMessage?: string | null;
    durationMs: number;
  }): SpatialInferenceRun {
    this.db.prepare(`UPDATE spatial_inference_runs SET status = ?, finished_at = ?, input_digest = ?, snapshot_ids_json = ?,
      error_code = ?, error_message = ?, duration_ms = ? WHERE source_db_id = ? AND data_mode = ? AND id = ?`)
      .run(result.status, result.finishedAt, result.inputDigest ?? null, stableJson(result.snapshotIds ?? []), result.errorCode ?? null,
        result.errorMessage?.slice(0, 2_000) ?? null, result.durationMs, ...partitionParams(partition), id);
    const row = this.db.prepare("SELECT * FROM spatial_inference_runs WHERE source_db_id = ? AND data_mode = ? AND id = ?")
      .get(...partitionParams(partition), id) as SqlRow | undefined;
    if (!row) throw new Error(`Spatial inference run ${id} disappeared`);
    return runFromRow(row);
  }

  latestRun(partition: SpatialDataPartition, scope: SpatialScope, engineId?: string): SpatialInferenceRun | null {
    const engineClause = engineId ? "AND engine_id = ?" : "";
    const row = this.db.prepare(`SELECT * FROM spatial_inference_runs
      WHERE source_db_id = ? AND data_mode = ? AND scope_kind = ? AND scope_id = ? ${engineClause}
      ORDER BY started_at DESC LIMIT 1`)
      .get(...partitionParams(partition), ...scopeParams(scope), ...(engineId ? [engineId] : [])) as SqlRow | undefined;
    return row ? runFromRow(row) : null;
  }

  persistSnapshot(partition: SpatialDataPartition, draft: SpatialLayerSnapshotDraft, createdAt = new Date().toISOString()): PersistedSpatialLayerSnapshot {
    return this.transaction(() => {
      assertInterval(draft.windowStart, draft.windowEnd, "windowStart", "windowEnd");
      assertIsoTimestamp(draft.generatedAt, "generatedAt");
      if (!Number.isFinite(draft.qualityScore) || draft.qualityScore < 0 || draft.qualityScore > 1) {
        throw new SpatialStateValidationError(400, "INVALID_QUALITY_SCORE", "qualityScore must be between 0 and 1");
      }
      const keyMaterial = {
        scope: draft.scope,
        layerId: draft.layerId,
        generatedAt: draft.generatedAt,
        model: draft.model,
        configVersion: draft.configVersion,
      };
      const snapshotKey = contentHash(keyMaterial);
      const hash = contentHash(draft);
      const currentRow = this.db.prepare(`SELECT * FROM spatial_layer_snapshots
        WHERE source_db_id = ? AND data_mode = ? AND snapshot_key = ? AND is_current = 1 LIMIT 1`)
        .get(...partitionParams(partition), snapshotKey) as SqlRow | undefined;
      if (currentRow) {
        if (String(currentRow.input_digest) === draft.inputDigest) {
          if (String(currentRow.content_hash) !== hash) throw new NonDeterministicSpatialOutputError(draft.layerId, draft.generatedAt);
          return snapshotFromRow(currentRow);
        }
        this.db.prepare(`UPDATE spatial_layer_snapshots SET is_current = 0
          WHERE source_db_id = ? AND data_mode = ? AND id = ?`)
          .run(...partitionParams(partition), String(currentRow.id));
      }
      const revision = currentRow ? Number(currentRow.revision) + 1 : 1;
      const id = randomUUID();
      this.db.prepare(`INSERT INTO spatial_layer_snapshots
        (source_db_id, data_mode, id, snapshot_key, scope_kind, scope_id, layer_id, bucket_at, window_start, window_end,
         status, model_json, config_version, input_digest, quality_score, warnings_json, payload_json, content_hash,
         revision, is_current, supersedes_snapshot_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(...partitionParams(partition), id, snapshotKey, ...scopeParams(draft.scope), draft.layerId, draft.generatedAt,
          draft.windowStart, draft.windowEnd, draft.status, stableJson(draft.model), draft.configVersion, draft.inputDigest,
          draft.qualityScore, stableJson(draft.warnings), stableJson({
            coordinateFrames: draft.coordinateFrames,
            reasonCodes: draft.reasonCodes,
            zones: draft.zones,
            connections: draft.connections,
            points: draft.points,
            ...(draft.metadata === undefined ? {} : { metadata: draft.metadata }),
          }), hash, revision,
          currentRow ? String(currentRow.id) : null, createdAt);
      const row = this.db.prepare(`SELECT * FROM spatial_layer_snapshots
        WHERE source_db_id = ? AND data_mode = ? AND id = ?`).get(...partitionParams(partition), id) as SqlRow;
      return snapshotFromRow(row);
    });
  }

  persistSnapshots(partition: SpatialDataPartition, drafts: SpatialLayerSnapshotDraft[], createdAt = new Date().toISOString()): PersistedSpatialLayerSnapshot[] {
    return this.transaction(() => drafts.map((draft) => this.persistSnapshot(partition, draft, createdAt)));
  }

  currentSnapshots(partition: SpatialDataPartition, scope: SpatialScope, layerIds: string[] = []): PersistedSpatialLayerSnapshot[] {
    const layerClause = layerIds.length > 0 ? `AND layer_id IN (${layerIds.map(() => "?").join(",")})` : "";
    const rows = this.db.prepare(`WITH ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY layer_id ORDER BY bucket_at DESC, revision DESC, created_at DESC) AS position
        FROM spatial_layer_snapshots WHERE source_db_id = ? AND data_mode = ? AND scope_kind = ? AND scope_id = ?
          AND is_current = 1 ${layerClause}
      ) SELECT * FROM ranked WHERE position = 1 ORDER BY layer_id`)
      .all(...partitionParams(partition), ...scopeParams(scope), ...layerIds) as SqlRow[];
    return rows.map(snapshotFromRow);
  }

  snapshotHistory(input: {
    partition: SpatialDataPartition;
    scope: SpatialScope;
    from: string;
    to: string;
    layerIds?: string[];
    includeSuperseded?: boolean;
    limit?: number;
  }): PersistedSpatialLayerSnapshot[] {
    assertInterval(input.from, input.to, "from", "to");
    const layerIds = input.layerIds ?? [];
    const layerClause = layerIds.length > 0 ? `AND layer_id IN (${layerIds.map(() => "?").join(",")})` : "";
    const revisionClause = input.includeSuperseded ? "" : "AND is_current = 1";
    const limit = Math.max(1, Math.min(20_000, Math.trunc(input.limit ?? 2_000)));
    const rows = this.db.prepare(`SELECT * FROM spatial_layer_snapshots
      WHERE source_db_id = ? AND data_mode = ? AND scope_kind = ? AND scope_id = ?
        AND bucket_at >= ? AND bucket_at <= ? ${revisionClause} ${layerClause}
      ORDER BY bucket_at ASC, layer_id, revision ASC LIMIT ?`)
      .all(...partitionParams(input.partition), ...scopeParams(input.scope), input.from, input.to, ...layerIds, limit) as SqlRow[];
    return rows.map(snapshotFromRow);
  }

  scheduleJob(input: {
    partition: SpatialDataPartition;
    scope: SpatialScope;
    bucketAt: string;
    reason: string;
    availableAt?: string;
    allowReopen?: boolean;
    now?: string;
  }): SpatialInferenceJob {
    assertIsoTimestamp(input.bucketAt, "bucketAt");
    const now = input.now ?? new Date().toISOString();
    const availableAt = input.availableAt ?? now;
    const id = randomUUID();
    this.db.prepare(`INSERT INTO spatial_inference_jobs
      (source_db_id, data_mode, id, scope_kind, scope_id, bucket_at, status, reason, available_at, attempts,
       last_error, lock_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, NULL, NULL, ?, ?)
      ON CONFLICT(source_db_id, data_mode, scope_kind, scope_id, bucket_at) DO UPDATE SET
        status = CASE
          WHEN spatial_inference_jobs.status = 'running' THEN spatial_inference_jobs.status
          WHEN spatial_inference_jobs.status IN ('done', 'cancelled') AND ? = 0 THEN spatial_inference_jobs.status
          ELSE 'pending' END,
        reason = CASE WHEN spatial_inference_jobs.status = 'running' THEN spatial_inference_jobs.reason ELSE excluded.reason END,
        available_at = CASE WHEN spatial_inference_jobs.status = 'running' THEN spatial_inference_jobs.available_at ELSE excluded.available_at END,
        last_error = CASE WHEN spatial_inference_jobs.status = 'running' THEN spatial_inference_jobs.last_error ELSE NULL END,
        lock_token = CASE WHEN spatial_inference_jobs.status = 'running' THEN spatial_inference_jobs.lock_token ELSE NULL END,
        updated_at = excluded.updated_at`)
      .run(...partitionParams(input.partition), id, ...scopeParams(input.scope), input.bucketAt, input.reason, availableAt,
        now, now, input.allowReopen ? 1 : 0);
    const row = this.db.prepare(`SELECT * FROM spatial_inference_jobs
      WHERE source_db_id = ? AND data_mode = ? AND scope_kind = ? AND scope_id = ? AND bucket_at = ?`)
      .get(...partitionParams(input.partition), ...scopeParams(input.scope), input.bucketAt) as SqlRow;
    return this.jobFromRow(row);
  }

  claimDueJobs(partition: SpatialDataPartition, now = new Date().toISOString(), limit = 10): SpatialInferenceJob[] {
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM spatial_inference_jobs
        WHERE source_db_id = ? AND data_mode = ? AND status IN ('pending', 'failed') AND available_at <= ?
        ORDER BY available_at, bucket_at LIMIT ?`)
        .all(...partitionParams(partition), now, Math.max(1, Math.min(100, limit))) as SqlRow[];
      const claimed: SpatialInferenceJob[] = [];
      for (const row of rows) {
        const token = randomUUID();
        const changed = Number(this.db.prepare(`UPDATE spatial_inference_jobs SET status = 'running', lock_token = ?,
          attempts = attempts + 1, updated_at = ? WHERE source_db_id = ? AND data_mode = ? AND id = ?
          AND status IN ('pending', 'failed')`).run(token, now, ...partitionParams(partition), String(row.id)).changes);
        if (changed === 1) claimed.push(this.getJob(partition, String(row.id))!);
      }
      return claimed;
    });
  }

  completeJob(partition: SpatialDataPartition, id: string, lockToken: string, now = new Date().toISOString()): boolean {
    return Number(this.db.prepare(`UPDATE spatial_inference_jobs SET status = 'done', lock_token = NULL, last_error = NULL, updated_at = ?
      WHERE source_db_id = ? AND data_mode = ? AND id = ? AND status = 'running' AND lock_token = ?`)
      .run(now, ...partitionParams(partition), id, lockToken).changes) === 1;
  }

  failJob(partition: SpatialDataPartition, id: string, lockToken: string, error: string, retryAt: string, maximumAttempts = 5): boolean {
    const row = this.getJob(partition, id);
    if (!row || row.lockToken !== lockToken || row.status !== "running") return false;
    const terminal = row.attempts >= maximumAttempts;
    return Number(this.db.prepare(`UPDATE spatial_inference_jobs SET status = ?, lock_token = NULL, last_error = ?, available_at = ?, updated_at = ?
      WHERE source_db_id = ? AND data_mode = ? AND id = ? AND status = 'running' AND lock_token = ?`)
      .run(terminal ? "failed" : "pending", error.slice(0, 2_000), retryAt, new Date().toISOString(),
        ...partitionParams(partition), id, lockToken).changes) === 1;
  }

  cancelOutstandingJobs(partition: SpatialDataPartition, now = new Date().toISOString()): number {
    return Number(this.db.prepare(`UPDATE spatial_inference_jobs SET status = 'cancelled', lock_token = NULL, updated_at = ?
      WHERE source_db_id = ? AND data_mode = ? AND status IN ('pending', 'running', 'failed')`)
      .run(now, ...partitionParams(partition)).changes);
  }

  /** Purge derived operational history only; configuration, calibration, and labels are retained. */
  purgeOperationalHistoryBefore(partition: SpatialDataPartition, before: string): {
    snapshots: number;
    runs: number;
    jobs: number;
  } {
    assertIsoTimestamp(before, "before");
    return this.transaction(() => ({
      snapshots: Number(this.db.prepare(`DELETE FROM spatial_layer_snapshots
        WHERE source_db_id = ? AND data_mode = ? AND bucket_at < ?`)
        .run(...partitionParams(partition), before).changes),
      runs: Number(this.db.prepare(`DELETE FROM spatial_inference_runs
        WHERE source_db_id = ? AND data_mode = ? AND started_at < ? AND status <> 'running'`)
        .run(...partitionParams(partition), before).changes),
      jobs: Number(this.db.prepare(`DELETE FROM spatial_inference_jobs
        WHERE source_db_id = ? AND data_mode = ? AND updated_at < ? AND status IN ('done', 'failed', 'cancelled')`)
        .run(...partitionParams(partition), before).changes),
    }));
  }

  getCheckpoint<T>(partition: SpatialDataPartition, scope: SpatialScope, key: string): T | null {
    const row = this.db.prepare(`SELECT value_json FROM spatial_checkpoints
      WHERE source_db_id = ? AND data_mode = ? AND scope_kind = ? AND scope_id = ? AND checkpoint_key = ?`)
      .get(...partitionParams(partition), ...scopeParams(scope), key) as SqlRow | undefined;
    return row ? parseJson<T>(row.value_json) : null;
  }

  putCheckpoint(partition: SpatialDataPartition, scope: SpatialScope, key: string, value: unknown, now = new Date().toISOString()): void {
    this.db.prepare(`INSERT INTO spatial_checkpoints
      (source_db_id, data_mode, scope_kind, scope_id, checkpoint_key, value_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_db_id, data_mode, scope_kind, scope_id, checkpoint_key) DO UPDATE SET
        value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(...partitionParams(partition), ...scopeParams(scope), key, stableJson(value), now);
  }

  private getJob(partition: SpatialDataPartition, id: string): SpatialInferenceJob | null {
    const row = this.db.prepare("SELECT * FROM spatial_inference_jobs WHERE source_db_id = ? AND data_mode = ? AND id = ?")
      .get(...partitionParams(partition), id) as SqlRow | undefined;
    return row ? this.jobFromRow(row) : null;
  }

  private jobFromRow(row: SqlRow): SpatialInferenceJob {
    return {
      id: String(row.id), partition: partitionFromRow(row), scope: scopeFromRow(row), bucketAt: String(row.bucket_at),
      status: row.status as SpatialInferenceJob["status"], reason: String(row.reason), availableAt: String(row.available_at),
      attempts: Number(row.attempts), lastError: row.last_error === null ? null : String(row.last_error),
      lockToken: row.lock_token === null ? null : String(row.lock_token), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }
}
