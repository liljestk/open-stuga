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
} from "../../types.js";
import { SpatialInferenceJob, SqlRow, assertInterval, assertIsoTimestamp, parseJson, partitionFromRow, partitionParams, scopeFromRow, scopeParams, snapshotFromRow, stableJson } from "../support/01-far-future-to-spatial-inference-job.js";
import { registerSpatialLayerStateStoreMethods, spatialLayerStateStoreState, type SpatialLayerStateStoreInternals } from "../core.js";

registerSpatialLayerStateStoreMethods({
  persistSnapshots(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, drafts: SpatialLayerSnapshotDraft[], createdAt = new Date().toISOString()): PersistedSpatialLayerSnapshot[] {
      return this.transaction(() => drafts.map((draft) => this.persistSnapshot(partition, draft, createdAt)));
    },
  currentSnapshots(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, scope: SpatialScope, layerIds: string[] = []): PersistedSpatialLayerSnapshot[] {
      const candidates = layerIds.length > 0
        ? [...new Set(layerIds)].sort()
        : (this.db.prepare(`SELECT DISTINCT layer_id FROM spatial_layer_snapshots
            WHERE source_db_id = ? AND data_mode = ? AND scope_kind = ? AND scope_id = ?
            ORDER BY layer_id`)
          .all(...partitionParams(partition), ...scopeParams(scope)) as unknown as Array<{ layer_id: string }>)
          .map((row) => row.layer_id);
      // Rank only rowids so large payload JSON never enters SQLite's bounded
      // container temp store; fetch the single winning payload afterwards.
      const latest = this.db.prepare(`SELECT snapshot.* FROM spatial_layer_snapshots AS snapshot
        WHERE snapshot.rowid = (
          SELECT candidate.rowid FROM spatial_layer_snapshots AS candidate
          WHERE candidate.source_db_id = ? AND candidate.data_mode = ? AND candidate.scope_kind = ? AND candidate.scope_id = ?
            AND candidate.layer_id = ? AND candidate.is_current = 1
          ORDER BY candidate.bucket_at DESC, candidate.revision DESC, candidate.created_at DESC
          LIMIT 1
        )`);
      const rows = candidates.flatMap((layerId) => {
        const row = latest.get(...partitionParams(partition), ...scopeParams(scope), layerId) as SqlRow | undefined;
        return row ? [row] : [];
      });
      return rows.map(snapshotFromRow);
    },
  snapshotHistory(this: SpatialLayerStateStoreInternals, input: {
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
    },
  scheduleJob(this: SpatialLayerStateStoreInternals, input: {
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
    },
  claimDueJobs(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, now = new Date().toISOString(), limit = 10): SpatialInferenceJob[] {
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
    },
  completeJob(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, id: string, lockToken: string, now = new Date().toISOString()): boolean {
      return Number(this.db.prepare(`UPDATE spatial_inference_jobs SET status = 'done', lock_token = NULL, last_error = NULL, updated_at = ?
        WHERE source_db_id = ? AND data_mode = ? AND id = ? AND status = 'running' AND lock_token = ?`)
        .run(now, ...partitionParams(partition), id, lockToken).changes) === 1;
    },
  failJob(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, id: string, lockToken: string, error: string, retryAt: string, maximumAttempts = 5): boolean {
      const row = this.getJob(partition, id);
      if (!row || row.lockToken !== lockToken || row.status !== "running") return false;
      const terminal = row.attempts >= maximumAttempts;
      return Number(this.db.prepare(`UPDATE spatial_inference_jobs SET status = ?, lock_token = NULL, last_error = ?, available_at = ?, updated_at = ?
        WHERE source_db_id = ? AND data_mode = ? AND id = ? AND status = 'running' AND lock_token = ?`)
        .run(terminal ? "failed" : "pending", error.slice(0, 2_000), retryAt, new Date().toISOString(),
          ...partitionParams(partition), id, lockToken).changes) === 1;
    },
  cancelOutstandingJobs(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, now = new Date().toISOString()): number {
      return Number(this.db.prepare(`UPDATE spatial_inference_jobs SET status = 'cancelled', lock_token = NULL, updated_at = ?
        WHERE source_db_id = ? AND data_mode = ? AND status IN ('pending', 'running', 'failed')`)
        .run(now, ...partitionParams(partition)).changes);
    },
  /** Purge derived operational history only; configuration, calibration, and labels are retained. */
  purgeOperationalHistoryBefore(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, before: string): {
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
    },
  getCheckpoint<T>(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, scope: SpatialScope, key: string): T | null {
      const row = this.db.prepare(`SELECT value_json FROM spatial_checkpoints
        WHERE source_db_id = ? AND data_mode = ? AND scope_kind = ? AND scope_id = ? AND checkpoint_key = ?`)
        .get(...partitionParams(partition), ...scopeParams(scope), key) as SqlRow | undefined;
      return row ? parseJson<T>(row.value_json) : null;
    },
  putCheckpoint(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, scope: SpatialScope, key: string, value: unknown, now = new Date().toISOString()): void {
      this.db.prepare(`INSERT INTO spatial_checkpoints
        (source_db_id, data_mode, scope_kind, scope_id, checkpoint_key, value_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_db_id, data_mode, scope_kind, scope_id, checkpoint_key) DO UPDATE SET
          value_json = excluded.value_json, updated_at = excluded.updated_at`)
        .run(...partitionParams(partition), ...scopeParams(scope), key, stableJson(value), now);
    },
  getJob(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, id: string): SpatialInferenceJob | null {
      const row = this.db.prepare("SELECT * FROM spatial_inference_jobs WHERE source_db_id = ? AND data_mode = ? AND id = ?")
        .get(...partitionParams(partition), id) as SqlRow | undefined;
      return row ? this.jobFromRow(row) : null;
    },
  jobFromRow(this: SpatialLayerStateStoreInternals, row: SqlRow): SpatialInferenceJob {
      return {
        id: String(row.id), partition: partitionFromRow(row), scope: scopeFromRow(row), bucketAt: String(row.bucket_at),
        status: row.status as SpatialInferenceJob["status"], reason: String(row.reason), availableAt: String(row.available_at),
        attempts: Number(row.attempts), lastError: row.last_error === null ? null : String(row.last_error),
        lockToken: row.lock_token === null ? null : String(row.lock_token), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      };
    },
});
