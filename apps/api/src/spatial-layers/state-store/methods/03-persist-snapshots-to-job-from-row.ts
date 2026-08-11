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
  SpatialInferenceSession,
  SpatialInferenceRun,
  SpatialLayerSnapshotDraft,
  SpatialRunStatus,
  SpatialScope,
  StoredSpatialContextEvent,
  StoredSpatialSensorBinding,
  StoredSpatialSensorCalibration,
} from "../../types.js";
import { SpatialInferenceJob, SpatialStateValidationError, SqlRow, assertInterval, assertIsoTimestamp, inferenceSessionFromRow, parseJson, partitionFromRow, partitionParams, scopeFromRow, scopeParams, snapshotFromRow, stableJson } from "../support/01-far-future-to-spatial-inference-job.js";
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
      sessionId?: string | null;
      now?: string;
    }): SpatialInferenceJob {
      assertIsoTimestamp(input.bucketAt, "bucketAt");
      const now = input.now ?? new Date().toISOString();
      const availableAt = input.availableAt ?? now;
      const id = randomUUID();
      this.db.prepare(`INSERT INTO spatial_inference_jobs
        (source_db_id, data_mode, id, scope_kind, scope_id, bucket_at, status, reason, available_at, attempts,
         last_error, lock_token, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, NULL, NULL, ?, ?, ?)
        ON CONFLICT(source_db_id, data_mode, scope_kind, scope_id, bucket_at) DO UPDATE SET
          status = CASE
            WHEN spatial_inference_jobs.status = 'running' THEN spatial_inference_jobs.status
            WHEN spatial_inference_jobs.status IN ('done', 'cancelled') AND ? = 0 THEN spatial_inference_jobs.status
            ELSE 'pending' END,
          reason = CASE WHEN spatial_inference_jobs.status = 'running' THEN spatial_inference_jobs.reason ELSE excluded.reason END,
          available_at = CASE WHEN spatial_inference_jobs.status = 'running' THEN spatial_inference_jobs.available_at ELSE excluded.available_at END,
          last_error = CASE WHEN spatial_inference_jobs.status = 'running' THEN spatial_inference_jobs.last_error ELSE NULL END,
          lock_token = CASE WHEN spatial_inference_jobs.status = 'running' THEN spatial_inference_jobs.lock_token ELSE NULL END,
          session_id = CASE WHEN spatial_inference_jobs.status = 'running' THEN spatial_inference_jobs.session_id ELSE excluded.session_id END,
          updated_at = excluded.updated_at`)
        .run(...partitionParams(input.partition), id, ...scopeParams(input.scope), input.bucketAt, input.reason, availableAt,
          input.sessionId ?? null, now, now, input.allowReopen ? 1 : 0);
      const row = this.db.prepare(`SELECT * FROM spatial_inference_jobs
        WHERE source_db_id = ? AND data_mode = ? AND scope_kind = ? AND scope_id = ? AND bucket_at = ?`)
        .get(...partitionParams(input.partition), ...scopeParams(input.scope), input.bucketAt) as SqlRow;
      return this.jobFromRow(row);
    },
  claimDueJobs(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, now = new Date().toISOString(), limit = 10): SpatialInferenceJob[] {
      return this.transaction(() => {
        const rows = this.db.prepare(`SELECT job.* FROM spatial_inference_jobs AS job
          INNER JOIN spatial_inference_sessions AS session
            ON session.source_db_id = job.source_db_id AND session.data_mode = job.data_mode
            AND session.id = job.session_id AND session.house_id = job.scope_id
          WHERE job.source_db_id = ? AND job.data_mode = ? AND job.scope_kind = 'house'
            AND job.status = 'pending' AND job.available_at <= ?
            AND session.status = 'active' AND session.expires_at > ?
          ORDER BY job.available_at, job.bucket_at LIMIT ?`)
          .all(...partitionParams(partition), now, now, Math.max(1, Math.min(100, limit))) as SqlRow[];
        const claimed: SpatialInferenceJob[] = [];
        for (const row of rows) {
          const token = randomUUID();
          const changed = Number(this.db.prepare(`UPDATE spatial_inference_jobs SET status = 'running', lock_token = ?,
            attempts = attempts + 1, updated_at = ? WHERE source_db_id = ? AND data_mode = ? AND id = ?
            AND status = 'pending'`).run(token, now, ...partitionParams(partition), String(row.id)).changes);
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
  deferJob(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, id: string, lockToken: string, availableAt: string, now = new Date().toISOString()): boolean {
      assertIsoTimestamp(availableAt, "availableAt");
      return Number(this.db.prepare(`UPDATE spatial_inference_jobs SET status = 'pending', lock_token = NULL,
        available_at = ?, attempts = MAX(0, attempts - 1), updated_at = ?
        WHERE source_db_id = ? AND data_mode = ? AND id = ? AND status = 'running' AND lock_token = ?`)
        .run(availableAt, now, ...partitionParams(partition), id, lockToken).changes) === 1;
    },
  cancelOutstandingJobs(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, now = new Date().toISOString()): number {
      return Number(this.db.prepare(`UPDATE spatial_inference_jobs SET status = 'cancelled', lock_token = NULL, updated_at = ?
        WHERE source_db_id = ? AND data_mode = ? AND status IN ('pending', 'running', 'failed')`)
        .run(now, ...partitionParams(partition)).changes);
    },
  cancelOutstandingJobsForSession(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, sessionId: string, now = new Date().toISOString()): number {
      return Number(this.db.prepare(`UPDATE spatial_inference_jobs SET status = 'cancelled', lock_token = NULL, updated_at = ?
        WHERE source_db_id = ? AND data_mode = ? AND session_id = ? AND status IN ('pending', 'running', 'failed')`)
        .run(now, ...partitionParams(partition), sessionId).changes);
    },
  cancelLegacyOutstandingJobs(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, now = new Date().toISOString()): number {
      return Number(this.db.prepare(`UPDATE spatial_inference_jobs SET status = 'cancelled', lock_token = NULL, updated_at = ?
        WHERE source_db_id = ? AND data_mode = ? AND session_id IS NULL AND status IN ('pending', 'running', 'failed')`)
        .run(now, ...partitionParams(partition)).changes);
    },
  recoverInterruptedSessionJobs(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, now = new Date().toISOString()): number {
      return this.transaction(() => {
        this.db.prepare(`UPDATE spatial_inference_runs SET status = 'failed', finished_at = ?,
          error_code = 'ENGINE_INTERRUPTED', error_message = 'Spatial inference was interrupted before completion'
          WHERE source_db_id = ? AND data_mode = ? AND status = 'running'`)
          .run(now, ...partitionParams(partition));
        return Number(this.db.prepare(`UPDATE spatial_inference_jobs SET status = 'pending', lock_token = NULL,
          available_at = ?, last_error = 'Spatial inference was interrupted before completion', updated_at = ?
          WHERE source_db_id = ? AND data_mode = ? AND session_id IS NOT NULL AND status = 'running'`)
          .run(now, now, ...partitionParams(partition)).changes);
      });
    },
  startInferenceSession(this: SpatialLayerStateStoreInternals, input: {
      partition: SpatialDataPartition;
      houseId: string;
      durationMinutes?: number;
      cadenceMinutes?: number;
      now?: string;
      createdBy?: string | null;
    }): SpatialInferenceSession {
      const now = input.now ?? new Date().toISOString();
      assertIsoTimestamp(now, "now");
      const houseId = input.houseId.trim();
      if (!houseId) throw new SpatialStateValidationError(400, "INVALID_HOUSE_ID", "houseId must not be empty");
      const durationMinutes = input.durationMinutes ?? 60;
      const cadenceMinutes = input.cadenceMinutes ?? 10;
      if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 240) {
        throw new SpatialStateValidationError(400, "INVALID_SESSION_DURATION", "durationMinutes must be an integer from 15 to 240");
      }
      if (!Number.isInteger(cadenceMinutes) || cadenceMinutes < 5 || cadenceMinutes > 60 || cadenceMinutes > durationMinutes) {
        throw new SpatialStateValidationError(400, "INVALID_SESSION_CADENCE", "cadenceMinutes must be an integer from 5 to 60 and no longer than the session");
      }
      return this.transaction(() => {
        this.expireInferenceSessions(input.partition, now);
        const active = this.db.prepare(`SELECT id FROM spatial_inference_sessions
          WHERE source_db_id = ? AND data_mode = ? AND house_id = ? AND status = 'active' LIMIT 1`)
          .get(...partitionParams(input.partition), houseId) as { id: string } | undefined;
        if (active) {
          throw new SpatialStateValidationError(409, "SPATIAL_SESSION_ACTIVE", "A spatial inference session is already active for this Home");
        }
        const id = randomUUID();
        const expiresAt = new Date(Date.parse(now) + durationMinutes * 60_000).toISOString();
        this.db.prepare(`INSERT INTO spatial_inference_sessions
          (source_db_id, data_mode, id, house_id, status, started_at, expires_at, cadence_minutes,
           next_run_at, last_scheduled_at, stopped_at, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`)
          .run(...partitionParams(input.partition), id, houseId, now, expiresAt, cadenceMinutes,
            now, input.createdBy ?? null, now, now);
        return this.getInferenceSession(input.partition, id)!;
      });
    },
  latestInferenceSession(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, houseId: string): SpatialInferenceSession | null {
      const row = this.db.prepare(`SELECT * FROM spatial_inference_sessions
        WHERE source_db_id = ? AND data_mode = ? AND house_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`)
        .get(...partitionParams(partition), houseId) as SqlRow | undefined;
      return row ? inferenceSessionFromRow(row) : null;
    },
  getInferenceSession(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, id: string): SpatialInferenceSession | null {
      const row = this.db.prepare(`SELECT * FROM spatial_inference_sessions
        WHERE source_db_id = ? AND data_mode = ? AND id = ?`)
        .get(...partitionParams(partition), id) as SqlRow | undefined;
      return row ? inferenceSessionFromRow(row) : null;
    },
  hasActiveInferenceSessions(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition): boolean {
      return Boolean(this.db.prepare(`SELECT 1 AS present FROM spatial_inference_sessions
        WHERE source_db_id = ? AND data_mode = ? AND status = 'active' LIMIT 1`)
        .get(...partitionParams(partition)));
    },
  stopInferenceSession(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, houseId: string, now = new Date().toISOString()): SpatialInferenceSession | null {
      assertIsoTimestamp(now, "now");
      return this.transaction(() => {
        const row = this.db.prepare(`SELECT * FROM spatial_inference_sessions
          WHERE source_db_id = ? AND data_mode = ? AND house_id = ? AND status = 'active'
          ORDER BY created_at DESC, rowid DESC LIMIT 1`)
          .get(...partitionParams(partition), houseId) as SqlRow | undefined;
        if (!row) return null;
        const id = String(row.id);
        this.db.prepare(`UPDATE spatial_inference_sessions SET status = 'stopped', stopped_at = ?, updated_at = ?
          WHERE source_db_id = ? AND data_mode = ? AND id = ? AND status = 'active'`)
          .run(now, now, ...partitionParams(partition), id);
        this.cancelOutstandingJobsForSession(partition, id, now);
        return this.getInferenceSession(partition, id);
      });
    },
  expireInferenceSessions(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, now = new Date().toISOString()): SpatialInferenceSession[] {
      assertIsoTimestamp(now, "now");
      return this.transaction(() => {
        const rows = this.db.prepare(`SELECT * FROM spatial_inference_sessions
          WHERE source_db_id = ? AND data_mode = ? AND status = 'active' AND expires_at <= ?
          ORDER BY expires_at, id`).all(...partitionParams(partition), now) as SqlRow[];
        const expired: SpatialInferenceSession[] = [];
        for (const row of rows) {
          const id = String(row.id);
          const changed = Number(this.db.prepare(`UPDATE spatial_inference_sessions
            SET status = 'expired', stopped_at = ?, updated_at = ?
            WHERE source_db_id = ? AND data_mode = ? AND id = ? AND status = 'active'`)
            .run(now, now, ...partitionParams(partition), id).changes);
          if (changed !== 1) continue;
          this.cancelOutstandingJobsForSession(partition, id, now);
          expired.push(this.getInferenceSession(partition, id)!);
        }
        return expired;
      });
    },
  scheduleDueInferenceSessions(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, now = new Date().toISOString(), limit = 10, houseId?: string): SpatialInferenceJob[] {
      assertIsoTimestamp(now, "now");
      return this.transaction(() => {
        this.expireInferenceSessions(partition, now);
        const houseClause = houseId === undefined ? "" : "AND house_id = ?";
        const rows = this.db.prepare(`SELECT * FROM spatial_inference_sessions
          WHERE source_db_id = ? AND data_mode = ? AND status = 'active'
            AND expires_at > ? AND next_run_at <= ? ${houseClause}
          ORDER BY next_run_at, created_at LIMIT ?`)
          .all(...partitionParams(partition), now, now, ...(houseId === undefined ? [] : [houseId]),
            Math.max(1, Math.min(100, Math.trunc(limit)))) as SqlRow[];
        const nowEpoch = Date.parse(now);
        const scheduled: SpatialInferenceJob[] = [];
        for (const row of rows) {
          const cadenceMs = Number(row.cadence_minutes) * 60_000;
          const dueEpoch = Date.parse(String(row.next_run_at));
          const elapsedIntervals = Math.floor(Math.max(0, nowEpoch - dueEpoch) / cadenceMs) + 1;
          const nextRunAt = new Date(dueEpoch + elapsedIntervals * cadenceMs).toISOString();
          const changed = Number(this.db.prepare(`UPDATE spatial_inference_sessions
            SET next_run_at = ?, last_scheduled_at = ?, updated_at = ?
            WHERE source_db_id = ? AND data_mode = ? AND id = ? AND status = 'active' AND next_run_at = ?`)
            .run(nextRunAt, now, now, ...partitionParams(partition), String(row.id), String(row.next_run_at)).changes);
          if (changed !== 1) continue;
          const outstanding = this.db.prepare(`SELECT * FROM spatial_inference_jobs
            WHERE source_db_id = ? AND data_mode = ? AND session_id = ? AND status IN ('pending', 'running')
            ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at LIMIT 1`)
            .get(...partitionParams(partition), String(row.id)) as SqlRow | undefined;
          if (outstanding) {
            if (outstanding.status === "pending") {
              this.db.prepare(`UPDATE spatial_inference_jobs SET bucket_at = ?, reason = 'session-cadence',
                available_at = MIN(available_at, ?), updated_at = ?
                WHERE source_db_id = ? AND data_mode = ? AND id = ? AND status = 'pending'`)
                .run(now, now, now, ...partitionParams(partition), String(outstanding.id));
              scheduled.push(this.getJob(partition, String(outstanding.id))!);
            }
            continue;
          }
          scheduled.push(this.scheduleJob({
            partition,
            scope: { kind: "house", id: String(row.house_id) },
            bucketAt: now,
            reason: row.last_scheduled_at === null ? "session-started" : "session-cadence",
            availableAt: now,
            allowReopen: true,
            sessionId: String(row.id),
            now,
          }));
        }
        return scheduled;
      });
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
        lockToken: row.lock_token === null ? null : String(row.lock_token),
        sessionId: row.session_id === null ? null : String(row.session_id),
        createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      };
    },
});
