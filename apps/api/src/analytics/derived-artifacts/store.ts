import type { DatabaseSync } from "node:sqlite";
import type { DataMode, DurableDerivedAnalyticsKind } from "@climate-twin/contracts";
import type {
  DerivedIdentity,
  DerivedResult,
  StoredDerivedArtifact,
  StoredDerivedJob,
} from "./types.js";
import {
  DerivedAnalyticsDataModeError,
  DerivedAnalyticsJobFencedError,
} from "./types.js";

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const TERMINAL_FAILURE_CODES = new Set([
  "HOME_PERFORMANCE_SCOPE_TOO_LARGE",
  "THERMAL_SCOPE_TOO_LARGE",
  "MOISTURE_SCOPE_TOO_LARGE",
  "HVAC_EVIDENCE_INSUFFICIENT",
  "DERIVED_ARTIFACT_TOO_LARGE",
]);

interface ArtifactRow {
  id: number;
  identity_key: string;
  kind: DurableDerivedAnalyticsKind;
  house_id: string;
  data_mode: DataMode;
  window_days: number;
  cutoff: string;
  algorithm_version: string;
  evidence_version: string;
  generated_at: string;
  result_json: string;
}

interface JobRow {
  identity_key: string;
  kind: DurableDerivedAnalyticsKind;
  house_id: string;
  data_mode: DataMode;
  window_days: number;
  cutoff: string;
  algorithm_version: string;
  evidence_version: string;
  status: StoredDerivedJob["status"];
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  next_attempt_at: string | null;
  attempt_count: number;
  error_code: string | null;
  error_message: string | null;
}

function artifactFromRow(row: ArtifactRow): StoredDerivedArtifact | null {
  if (Buffer.byteLength(row.result_json, "utf8") > MAX_ARTIFACT_BYTES) return null;
  try {
    const result = JSON.parse(row.result_json) as unknown;
    if (!result || typeof result !== "object" || Array.isArray(result)) return null;
    const fields = result as Record<string, unknown>;
    if (fields.houseId !== row.house_id || typeof fields.generatedAt !== "string") return null;
    if (row.kind === "home-performance") {
      if (fields.apiVersion !== "1.0" || typeof fields.provenance !== "object"
        || typeof fields.exposure !== "object") return null;
    } else if (!Array.isArray(fields.entries) || !Array.isArray(fields.insights)
      || typeof fields.methodology !== "object" || typeof fields.from !== "string"
      || typeof fields.to !== "string") return null;
    return {
      id: row.id,
      identityKey: row.identity_key,
      kind: row.kind,
      houseId: row.house_id,
      dataMode: row.data_mode,
      windowDays: row.window_days,
      cutoff: row.cutoff,
      algorithmVersion: row.algorithm_version,
      evidenceVersion: row.evidence_version,
      generatedAt: row.generated_at,
      result: result as DerivedResult,
    };
  } catch {
    // Reads are fail-soft: a damaged row must not turn page navigation into a
    // 500. Immutable older generations remain eligible as last-good results.
    return null;
  }
}

function jobFromRow(row: JobRow): StoredDerivedJob {
  return {
    identityKey: row.identity_key,
    kind: row.kind,
    houseId: row.house_id,
    dataMode: row.data_mode,
    windowDays: row.window_days,
    cutoff: row.cutoff,
    algorithmVersion: row.algorithm_version,
    evidenceVersion: row.evidence_version,
    status: row.status,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    nextAttemptAt: row.next_attempt_at,
    attemptCount: row.attempt_count,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

/** Durable queue and immutable last-good artifact store. */
export class DerivedAnalyticsStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync, now = new Date().toISOString()) {
    this.#db = db;
    // A process cannot resume an in-memory calculation after restart. Keep its
    // identity and retry it instead of discarding either the job or last-good.
    this.#db.prepare(`
      UPDATE derived_analytics_jobs
      SET status = 'pending', started_at = NULL, next_attempt_at = NULL,
          error_code = 'PROCESS_RESTARTED',
          error_message = 'The previous calculation stopped before completion'
      WHERE status = 'running'
    `).run();
    this.purgeObsoleteDataMode();
    this.prune(now);
  }

  enqueue(identity: DerivedIdentity, requestedAt: string, force = false): StoredDerivedJob {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#assertActiveDataMode(identity.dataMode);
      this.#db.prepare(`
        INSERT INTO derived_analytics_jobs (
          identity_key, kind, house_id, data_mode, window_days, cutoff,
          algorithm_version, evidence_version, status, requested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(identity_key) DO UPDATE SET
          status = CASE
            WHEN ? = 1 AND derived_analytics_jobs.status IN ('succeeded', 'failed') THEN 'pending'
            ELSE derived_analytics_jobs.status
          END,
          requested_at = CASE
            WHEN ? = 1 AND derived_analytics_jobs.status IN ('succeeded', 'failed') THEN excluded.requested_at
            ELSE derived_analytics_jobs.requested_at
          END,
          started_at = CASE
            WHEN ? = 1 AND derived_analytics_jobs.status IN ('succeeded', 'failed') THEN NULL
            ELSE derived_analytics_jobs.started_at
          END,
          completed_at = CASE
            WHEN ? = 1 AND derived_analytics_jobs.status IN ('succeeded', 'failed') THEN NULL
            ELSE derived_analytics_jobs.completed_at
          END,
          next_attempt_at = CASE
            WHEN ? = 1 AND derived_analytics_jobs.status IN ('succeeded', 'failed') THEN NULL
            ELSE derived_analytics_jobs.next_attempt_at
          END,
          error_code = CASE
            WHEN ? = 1 AND derived_analytics_jobs.status IN ('succeeded', 'failed') THEN NULL
            ELSE derived_analytics_jobs.error_code
          END,
          error_message = CASE
            WHEN ? = 1 AND derived_analytics_jobs.status IN ('succeeded', 'failed') THEN NULL
            ELSE derived_analytics_jobs.error_message
          END,
          attempt_count = CASE
            WHEN ? = 1 AND derived_analytics_jobs.status IN ('succeeded', 'failed') THEN 0
            ELSE derived_analytics_jobs.attempt_count
          END
      `).run(
        identity.identityKey,
        identity.kind,
        identity.houseId,
        identity.dataMode,
        identity.windowDays,
        identity.cutoff,
        identity.algorithmVersion,
        identity.evidenceVersion,
        requestedAt,
        Number(force), Number(force), Number(force), Number(force),
        Number(force), Number(force), Number(force), Number(force),
      );
      const stored = this.job(identity.identityKey);
      if (!stored) throw new Error("The newly queued derived analytics job could not be read back");
      this.#db.exec("COMMIT");
      return stored;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  job(identityKey: string): StoredDerivedJob | null {
    const row = this.#db.prepare(
      "SELECT * FROM derived_analytics_jobs WHERE identity_key = ?",
    ).get(identityKey) as unknown as JobRow | undefined;
    return row ? jobFromRow(row) : null;
  }

  latestArtifact(input: {
    houseId: string;
    kind: DurableDerivedAnalyticsKind;
    dataMode: DataMode;
    windowDays: number;
  }): StoredDerivedArtifact | null {
    const rows = this.#db.prepare(`
      SELECT * FROM derived_analytics_artifacts
      WHERE house_id = ? AND kind = ? AND data_mode = ? AND window_days = ?
        AND length(CAST(result_json AS BLOB)) <= ?
        AND CASE WHEN json_valid(result_json) THEN json_type(result_json) END = 'object'
      ORDER BY id DESC LIMIT 4
    `).all(
      input.houseId, input.kind, input.dataMode, input.windowDays, MAX_ARTIFACT_BYTES,
    ) as unknown as ArtifactRow[];
    for (const row of rows) {
      const artifact = artifactFromRow(row);
      if (artifact) return artifact;
    }
    return null;
  }

  artifactForIdentity(identityKey: string): StoredDerivedArtifact | null {
    const rows = this.#db.prepare(`
      SELECT * FROM derived_analytics_artifacts
      WHERE identity_key = ?
        AND length(CAST(result_json AS BLOB)) <= ?
        AND CASE WHEN json_valid(result_json) THEN json_type(result_json) END = 'object'
      ORDER BY id DESC LIMIT 4
    `).all(identityKey, MAX_ARTIFACT_BYTES) as unknown as ArtifactRow[];
    for (const row of rows) {
      const artifact = artifactFromRow(row);
      if (artifact) return artifact;
    }
    return null;
  }

  claim(now: string, dataMode = this.#activeDataMode()): StoredDerivedJob | null {
    const candidate = this.claimable(now, 1, dataMode)[0];
    return candidate ? this.claimIdentity(candidate.identityKey, now, dataMode) : null;
  }

  claimable(now: string, limit = 64, dataMode = this.#activeDataMode()): StoredDerivedJob[] {
    const safeLimit = Math.min(256, Math.max(1, Math.trunc(limit)));
    // A failed job is claimable only through a scheduled retry. Terminal
    // failures clear next_attempt_at, so treating NULL as "retry now" would
    // burn the whole attempt budget on deterministic failures.
    const rows = this.#db.prepare(`
      SELECT * FROM derived_analytics_jobs
      WHERE data_mode = ?
        AND (
          (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
          OR (status = 'failed' AND attempt_count < 3
            AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
        )
      ORDER BY requested_at ASC, identity_key ASC
      LIMIT ?
    `).all(dataMode, now, now, safeLimit) as unknown as JobRow[];
    return rows.map(jobFromRow);
  }

  claimIdentity(
    identityKey: string,
    now: string,
    dataMode = this.#activeDataMode(),
  ): StoredDerivedJob | null {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#assertActiveDataMode(dataMode);
      const row = this.#db.prepare(`
        SELECT * FROM derived_analytics_jobs
        WHERE identity_key = ? AND data_mode = ?
          AND (
            (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
            OR (status = 'failed' AND attempt_count < 3
              AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
          )
      `).get(identityKey, dataMode, now, now) as unknown as JobRow | undefined;
      if (!row) {
        this.#db.exec("COMMIT");
        return null;
      }
      this.#db.prepare(`
        UPDATE derived_analytics_jobs
        SET status = 'running', started_at = ?, completed_at = NULL,
            attempt_count = attempt_count + 1
        WHERE identity_key = ? AND data_mode = ?
      `).run(now, row.identity_key, dataMode);
      this.#db.exec("COMMIT");
      return this.job(row.identity_key);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  succeed(job: StoredDerivedJob, result: DerivedResult, generatedAt: string): StoredDerivedArtifact {
    const resultJson = JSON.stringify(result);
    if (Buffer.byteLength(resultJson, "utf8") > MAX_ARTIFACT_BYTES) {
      throw Object.assign(new Error("Derived analytics artifact exceeds the storage limit"), {
        code: "DERIVED_ARTIFACT_TOO_LARGE",
      });
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#assertActiveDataMode(job.dataMode);
      const running = this.#db.prepare(`
        SELECT 1 AS present FROM derived_analytics_jobs
        WHERE identity_key = ? AND data_mode = ? AND status = 'running'
      `).get(job.identityKey, job.dataMode) as { present: number } | undefined;
      if (!running) throw new DerivedAnalyticsJobFencedError(job.identityKey);
      const inserted = this.#db.prepare(`
        INSERT INTO derived_analytics_artifacts (
          identity_key, kind, house_id, data_mode, window_days, cutoff,
          algorithm_version, evidence_version, generated_at, result_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        job.identityKey, job.kind, job.houseId, job.dataMode, job.windowDays,
        job.cutoff, job.algorithmVersion, job.evidenceVersion, generatedAt,
        resultJson,
      );
      this.#db.prepare(`
        UPDATE derived_analytics_jobs
        SET status = 'succeeded', completed_at = ?, next_attempt_at = NULL,
            error_code = NULL, error_message = NULL
        WHERE identity_key = ?
      `).run(generatedAt, job.identityKey);
      // Retain four immutable generations for each canonical view. The newest
      // successful row is never mutated by a later refresh or failure.
      this.#db.prepare(`
        DELETE FROM derived_analytics_artifacts
        WHERE house_id = ? AND kind = ? AND data_mode = ? AND window_days = ?
          AND id NOT IN (
            SELECT id FROM derived_analytics_artifacts
            WHERE house_id = ? AND kind = ? AND data_mode = ? AND window_days = ?
            ORDER BY id DESC LIMIT 4
          )
      `).run(
        job.houseId, job.kind, job.dataMode, job.windowDays,
        job.houseId, job.kind, job.dataMode, job.windowDays,
      );
      const row = this.#db.prepare(
        "SELECT * FROM derived_analytics_artifacts WHERE id = ?",
      ).get(Number(inserted.lastInsertRowid)) as unknown as ArtifactRow;
      const artifact = artifactFromRow(row);
      if (!artifact) throw new Error("The newly stored derived artifact could not be read back");
      this.#db.exec("COMMIT");
      return artifact;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  fail(job: StoredDerivedJob, error: unknown, failedAt: string): void {
    const attempt = Math.max(1, job.attemptCount);
    const retryDelayMs = Math.min(30 * 60_000, 30_000 * (2 ** (attempt - 1)));
    const code = error && typeof error === "object" && "code" in error
      && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "DERIVED_ANALYTICS_FAILED";
    const retryAt = attempt < 3 && !TERMINAL_FAILURE_CODES.has(code)
      ? new Date(Date.parse(failedAt) + retryDelayMs).toISOString()
      : null;
    const message = error instanceof Error ? error.message : "Derived analytics calculation failed";
    this.#db.prepare(`
      UPDATE derived_analytics_jobs
      SET status = 'failed', completed_at = ?, next_attempt_at = ?,
          error_code = ?, error_message = ?
      WHERE identity_key = ? AND data_mode = ? AND status = 'running'
    `).run(
      failedAt,
      retryAt,
      code.slice(0, 120),
      message.slice(0, 1_000),
      job.identityKey,
      job.dataMode,
    );
  }

  /** Return a canceled in-process claim to the durable queue. */
  interrupt(job: StoredDerivedJob, reason: unknown): void {
    const message = reason instanceof Error
      ? reason.message
      : "Derived analytics calculation was interrupted";
    this.#db.prepare(`
      UPDATE derived_analytics_jobs
      SET status = 'pending', started_at = NULL, completed_at = NULL,
          next_attempt_at = NULL, error_code = 'DERIVED_ANALYTICS_INTERRUPTED',
          error_message = ?
      WHERE identity_key = ? AND data_mode = ? AND status = 'running'
    `).run(message.slice(0, 1_000), job.identityKey, job.dataMode);
  }

  /** Removes work and results that cannot cross the one-way demo/live boundary. */
  purgeObsoleteDataMode(dataMode = this.#activeDataMode()): {
    jobs: number;
    artifacts: number;
  } {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#assertActiveDataMode(dataMode);
      const jobs = Number(this.#db.prepare(
        "DELETE FROM derived_analytics_jobs WHERE data_mode <> ?",
      ).run(dataMode).changes);
      const artifacts = Number(this.#db.prepare(
        "DELETE FROM derived_analytics_artifacts WHERE data_mode <> ?",
      ).run(dataMode).changes);
      this.#db.exec("COMMIT");
      return { jobs, artifacts };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  prune(now: string): void {
    const threshold = new Date(Date.parse(now) - 45 * 86_400_000).toISOString();
    this.#db.prepare(`
      DELETE FROM derived_analytics_jobs
      WHERE cutoff < ? AND status IN ('succeeded', 'failed')
    `).run(threshold);
  }

  counts(): { pending: number; running: number; artifacts: number } {
    const jobs = this.#db.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('pending', 'failed') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
      FROM derived_analytics_jobs
    `).get() as unknown as { pending: number | null; running: number | null };
    const artifacts = this.#db.prepare(
      "SELECT COUNT(*) AS count FROM derived_analytics_artifacts",
    ).get() as unknown as { count: number };
    return { pending: jobs.pending ?? 0, running: jobs.running ?? 0, artifacts: artifacts.count };
  }

  #activeDataMode(): DataMode {
    const row = this.#db.prepare(
      "SELECT value FROM metadata WHERE key = 'data_mode'",
    ).get() as { value: string } | undefined;
    return row?.value === "real" ? "live" : "demo";
  }

  #assertActiveDataMode(requestedMode: DataMode): void {
    const activeMode = this.#activeDataMode();
    if (requestedMode !== activeMode) {
      throw new DerivedAnalyticsDataModeError(requestedMode, activeMode);
    }
  }
}
