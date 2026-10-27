import type {
  SpatialConfigurationVersion,
  SpatialDataPartition,
  SpatialScope,
} from "../../types.js";
import { SpatialSourceIdentityCollisionError, SpatialStateValidationError, SqlRow, parseJson, partitionParams, scopeParams, sqlIdentifier, stableJson } from "../support/01-far-future-to-spatial-inference-job.js";
import { registerSpatialLayerStateStoreMethods, spatialLayerStateStoreState, type SpatialLayerStateStoreInternals } from "../core.js";

registerSpatialLayerStateStoreMethods({
  close(this: SpatialLayerStateStoreInternals): void {
      this.db.close();
    },
  transaction<T>(this: SpatialLayerStateStoreInternals, operation: () => T): T {
      if (this[spatialLayerStateStoreState].transactionDepth > 0) return operation();
      this.db.exec("BEGIN IMMEDIATE");
      this[spatialLayerStateStoreState].transactionDepth += 1;
      try {
        const result = operation();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      } finally {
        this[spatialLayerStateStoreState].transactionDepth -= 1;
      }
  },
  migrate(this: SpatialLayerStateStoreInternals): void {
      this.transaction(() => {
        this.db.exec(`
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
        CREATE INDEX IF NOT EXISTS idx_spatial_runs_engine_started
          ON spatial_inference_runs(source_db_id, data_mode, scope_kind, scope_id, engine_id, started_at DESC);

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

        CREATE TABLE IF NOT EXISTS spatial_inference_sessions (
          source_db_id TEXT NOT NULL,
          data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'real')),
          id TEXT NOT NULL,
          house_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'stopped', 'expired')),
          started_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          cadence_minutes INTEGER NOT NULL CHECK (cadence_minutes >= 5 AND cadence_minutes <= 60),
          next_run_at TEXT NOT NULL,
          last_scheduled_at TEXT,
          stopped_at TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(source_db_id, data_mode, id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_spatial_one_active_session
          ON spatial_inference_sessions(source_db_id, data_mode, house_id) WHERE status = 'active';
        CREATE INDEX IF NOT EXISTS idx_spatial_sessions_due
          ON spatial_inference_sessions(source_db_id, data_mode, status, next_run_at, expires_at);

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
          session_id TEXT,
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
      `);
        const jobColumns = this.db.prepare("PRAGMA table_info(spatial_inference_jobs)").all() as unknown as Array<{ name: string }>;
        if (!jobColumns.some((column) => column.name === "session_id")) {
          this.db.exec("ALTER TABLE spatial_inference_jobs ADD COLUMN session_id TEXT");
        }
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_spatial_jobs_session
            ON spatial_inference_jobs(source_db_id, data_mode, session_id, status, available_at);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_spatial_one_outstanding_session_job
            ON spatial_inference_jobs(source_db_id, data_mode, session_id)
            WHERE session_id IS NOT NULL AND status IN ('pending', 'running');
          UPDATE spatial_metadata SET value = '2' WHERE key = 'schema_version';
        `);
      });
    },
  /**
     * Re-keys state written by the former database-path identity scheme to the
     * stable UUID persisted by the core database. Demo and real rows remain in
     * separate partitions. Detection and updates share one IMMEDIATE
     * transaction, and a populated target causes the entire migration to roll
     * back rather than merging two potentially unrelated datasets.
     */
  rekeyLegacySourceDatabaseId(this: SpatialLayerStateStoreInternals, legacySourceDbId: string, stableSourceDbId: string): {
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
    },
  getCurrentConfiguration(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, scope: SpatialScope): SpatialConfigurationVersion {
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
    },
  putConfiguration(this: SpatialLayerStateStoreInternals, input: {
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
    },
});
