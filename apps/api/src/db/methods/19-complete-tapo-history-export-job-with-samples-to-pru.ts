import type { TapoHistoryExportCompletionOptions, TapoHistoryExportJobRow, TapoHistoryExportStageResult, TapoHistoryExportStagedSample, TapoHistoryExportStagedSampleFilter, TapoHistoryExportStagedSampleInput, TapoHistoryExportStagedSampleRow } from "../tapo-history-export-types.js";
import { ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { normalizedSha256, normalizedTapoHistoryText, normalizedTapoHistoryTimestamp, tapoHistoryExportJobFromRow, tapoHistoryExportStagedSampleFromRow } from "../support/06-canonical-observation-patch-time-to-outdoor-location.js";
import { registerDatabaseMethods } from "../core.js";

registerDatabaseMethods({
  /**
     * Commits mailbox/private-response identity and every normalized row in one transaction.
     * Reprocessing the same source identities is a no-op; conflicting identities are rejected.
     */
  completeTapoHistoryExportJobWithSamples(
      id: string,
      samples: TapoHistoryExportStagedSampleInput[],
      options: TapoHistoryExportCompletionOptions = {},
    ): TapoHistoryExportStageResult {
      if (!Array.isArray(samples) || samples.length > 250_000) {
        throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_SAMPLES", "A Tapo export may stage at most 250000 samples");
      }
      const completedAt = normalizedTapoHistoryTimestamp(options.completedAt ?? new Date().toISOString(), "completedAt");
      const mailboxMessageId = options.mailboxMessageId === undefined
        ? null
        : normalizedTapoHistoryText(options.mailboxMessageId, "mailboxMessageId", 1_000);
      const expectedRecipient = options.expectedRecipient === undefined
        ? null
        : normalizedTapoHistoryText(options.expectedRecipient, "expectedRecipient", 320).toLowerCase();
      const expectedSubmittedAt = options.expectedSubmittedAt === undefined
        ? null
        : normalizedTapoHistoryTimestamp(options.expectedSubmittedAt, "expectedSubmittedAt");
      const sourceArtifactSha256 = options.sourceArtifactSha256 === undefined
        ? null
        : normalizedSha256(options.sourceArtifactSha256, "sourceArtifactSha256");
      const sourceArtifactBytes = options.sourceArtifactBytes ?? null;
      if (sourceArtifactBytes !== null
        && (!Number.isSafeInteger(sourceArtifactBytes) || sourceArtifactBytes < 0 || sourceArtifactBytes > 100 * 1024 * 1024)) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_TAPO_EXPORT_FIELD",
          "sourceArtifactBytes must be a non-negative safe integer no larger than 100 MiB",
        );
      }
      const parserVersion = options.parserVersion === undefined
        ? null
        : normalizedTapoHistoryText(options.parserVersion, "parserVersion", 100);
      const sourceSchemaSignature = options.sourceSchemaSignature === undefined
        ? null
        : normalizedSha256(options.sourceSchemaSignature, "sourceSchemaSignature");
      return this.immediateTransaction(() => {
        const jobRow = this.db.prepare("SELECT * FROM tapo_history_export_jobs WHERE id = ?")
          .get(id) as unknown as TapoHistoryExportJobRow | undefined;
        if (!jobRow) throw new ClimateDataValidationError(404, "TAPO_EXPORT_NOT_FOUND", `Tapo export job ${id} does not exist`);
        const job = tapoHistoryExportJobFromRow(jobRow);
        if (job.status === "cancelled") {
          throw new ClimateDataValidationError(409, "TAPO_EXPORT_CANCELLED", "A cancelled Tapo export cannot be completed");
        }
        if (job.provider === "appium") {
          if (!mailboxMessageId) {
            throw new ClimateDataValidationError(
              409,
              "TAPO_EXPORT_MAILBOX_MESSAGE_REQUIRED",
              "An app export can only be completed by a correlated mailbox message",
            );
          }
          if (!sourceArtifactSha256 || sourceArtifactBytes === null || !parserVersion || !sourceSchemaSignature) {
            throw new ClimateDataValidationError(
              409,
              "TAPO_EXPORT_ARTIFACT_AUDIT_REQUIRED",
              "An app export requires its raw attachment hash, byte count, parser version, and schema signature",
            );
          }
          if (job.status === "completed") {
            if (job.mailboxMessageId !== mailboxMessageId) {
              throw new ClimateDataValidationError(
                409,
                "TAPO_EXPORT_MAILBOX_MESSAGE_MISMATCH",
                "A completed Tapo export can only be replayed with its original mailbox message",
              );
            }
            if (job.sourceArtifactSha256 !== sourceArtifactSha256
              || job.sourceArtifactBytes !== sourceArtifactBytes || job.parserVersion !== parserVersion
              || job.sourceSchemaSignature !== sourceSchemaSignature) {
              throw new ClimateDataValidationError(
                409,
                "TAPO_EXPORT_ARTIFACT_MISMATCH",
                "A completed Tapo export can only be replayed with its original audited attachment",
              );
            }
          } else if (job.status !== "waiting-email"
            || !job.expectedRecipient || !job.submittedAt
            || expectedRecipient === null || expectedSubmittedAt === null
            || job.expectedRecipient !== expectedRecipient || job.submittedAt !== expectedSubmittedAt) {
            throw new ClimateDataValidationError(
              409,
              "TAPO_EXPORT_GENERATION_CHANGED",
              "The Tapo export mailbox attempt is no longer current",
            );
          }
          if (!job.canary && job.deploymentFingerprint
            && job.expectedSchemaSignature !== sourceSchemaSignature) {
            throw new ClimateDataValidationError(
              409,
              "TAPO_EXPORT_SCHEMA_DRIFT",
              "The Tapo CSV schema no longer matches the last accepted canary",
            );
          }
          if (!job.canary && job.status !== "completed" && job.deploymentFingerprint) {
            const approvalStillPresent = Boolean(this.db.prepare(`SELECT 1 AS approved
                FROM tapo_history_canary_approvals AS approval
                JOIN tapo_history_export_jobs AS canary ON canary.id = approval.canary_job_id
                WHERE approval.deployment_fingerprint = ? AND approval.acceptance_revision = ?
                  AND approval.schema_signature = ? AND canary.status = 'completed'
                  AND canary.sensor_id = ? AND canary.expected_device_id = ?
                  AND canary.device_name = ? AND canary.time_zone = ? AND canary.interval_minutes = ?
                LIMIT 1`)
              .get(
                job.deploymentFingerprint,
                job.acceptanceRevision,
                job.expectedSchemaSignature,
                job.sensorId,
                job.expectedDeviceId,
                job.deviceName,
                job.timeZone,
                job.intervalMinutes,
              ));
            if (!approvalStillPresent) {
              throw new ClimateDataValidationError(
                409,
                "TAPO_EXPORT_APPROVAL_REVOKED",
                "The Tapo canary approval was revoked before this export completed",
              );
            }
          }
        } else {
          if (mailboxMessageId) {
            throw new ClimateDataValidationError(
              409,
              "TAPO_EXPORT_MAILBOX_MESSAGE_UNEXPECTED",
              "A private-cloud export cannot claim a mailbox message",
            );
          }
          if (job.status !== "queued" && job.status !== "completed") {
            throw new ClimateDataValidationError(
              409,
              "INVALID_TAPO_EXPORT_TRANSITION",
              `Cannot complete a private-cloud Tapo export from ${job.status}`,
            );
          }
        }
        const resolvedMessageId = mailboxMessageId ?? job.mailboxMessageId;
        if (mailboxMessageId) {
          const owner = this.db.prepare("SELECT id FROM tapo_history_export_jobs WHERE mailbox_message_id = ?")
            .get(mailboxMessageId) as { id: string } | undefined;
          if (owner && owner.id !== id) {
            throw new ClimateDataValidationError(
              409,
              "TAPO_EXPORT_MAILBOX_MESSAGE_CLAIMED",
              "The mailbox message has already been assigned to another Tapo export job",
            );
          }
          if (job.mailboxMessageId && job.mailboxMessageId !== mailboxMessageId) {
            throw new ClimateDataValidationError(
              409,
              "TAPO_EXPORT_MAILBOX_MESSAGE_MISMATCH",
              "The Tapo export job is already associated with a different mailbox message",
            );
          }
        }

        const insert = this.db.prepare(`INSERT OR IGNORE INTO tapo_history_export_staged_samples
          (job_id, sensor_id, metric, value, canonical_unit, timestamp, source, quality,
           source_identity, created_at, consumed_at)
          VALUES (?, ?, ?, ?, ?, ?, 'tp-link', ?, ?, ?, NULL)`);
        const byIdentity = this.db.prepare(`SELECT * FROM tapo_history_export_staged_samples
          WHERE job_id = ? AND metric = ? AND source_identity = ?`);
        const staged: TapoHistoryExportStagedSample[] = [];
        let duplicateCount = 0;
        for (const sample of samples) {
          const metric = normalizedTapoHistoryText(sample.metric, "metric", 200);
          const definition = this.getMeasurementDefinition(metric);
          if (!definition) {
            throw new ClimateDataValidationError(404, "TAPO_EXPORT_METRIC_NOT_FOUND", `Unknown measurement metric: ${metric}`);
          }
          if (sample.canonicalUnit !== definition.unit) {
            throw new ClimateDataValidationError(
              422,
              "TAPO_EXPORT_UNIT_MISMATCH",
              `${metric} canonicalUnit must be ${definition.unit}`,
            );
          }
          if (!Number.isFinite(sample.value)
            || (definition.validMin !== null && sample.value < definition.validMin)
            || (definition.validMax !== null && sample.value > definition.validMax)) {
            throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_VALUE", `${metric} value is outside its valid range`);
          }
          if (sample.source !== undefined && sample.source !== "tp-link") {
            throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_SOURCE", "Tapo export samples must use source tp-link");
          }
          const quality = sample.quality ?? "estimated";
          if (quality !== "good" && quality !== "estimated" && quality !== "stale") {
            throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_QUALITY", "Unsupported sample quality");
          }
          const timestamp = normalizedTapoHistoryTimestamp(sample.timestamp, "sample.timestamp");
          if (Date.parse(timestamp) < Date.parse(job.rangeStart) || Date.parse(timestamp) > Date.parse(job.rangeEnd)) {
            throw new ClimateDataValidationError(
              422,
              "TAPO_EXPORT_SAMPLE_OUTSIDE_RANGE",
              "A staged sample falls outside the export job range",
            );
          }
          const sourceIdentity = normalizedTapoHistoryText(sample.sourceIdentity, "sourceIdentity", 1_000);
          const existing = byIdentity.get(id, metric, sourceIdentity) as unknown as TapoHistoryExportStagedSampleRow | undefined;
          if (existing) {
            if (existing.sensor_id !== job.sensorId || existing.value !== sample.value
              || existing.canonical_unit !== definition.unit || existing.timestamp !== timestamp
              || existing.quality !== quality) {
              throw new ClimateDataValidationError(
                409,
                "TAPO_EXPORT_SOURCE_IDENTITY_COLLISION",
                `Source identity ${sourceIdentity} was reused for different sample content`,
              );
            }
            duplicateCount += 1;
            continue;
          }
          const result = insert.run(
            id, job.sensorId, metric, sample.value, definition.unit, timestamp,
            quality, sourceIdentity, completedAt,
          );
          if (Number(result.changes) === 0) {
            duplicateCount += 1;
            continue;
          }
          const row = this.db.prepare("SELECT * FROM tapo_history_export_staged_samples WHERE id = ?")
            .get(Number(result.lastInsertRowid)) as unknown as TapoHistoryExportStagedSampleRow;
          staged.push(tapoHistoryExportStagedSampleFromRow(row));
        }
        const counts = this.db.prepare(`SELECT COUNT(*) AS staged,
            SUM(CASE WHEN consumed_at IS NOT NULL THEN 1 ELSE 0 END) AS consumed
          FROM tapo_history_export_staged_samples WHERE job_id = ?`)
          .get(id) as { staged: number; consumed: number | null };
        this.db.prepare(`UPDATE tapo_history_export_jobs SET status = 'completed', mailbox_message_id = ?,
            source_artifact_sha256 = ?, source_artifact_bytes = ?, parser_version = ?, source_schema_signature = ?,
            staged_sample_count = ?, consumed_sample_count = ?, lease_owner = NULL, lease_token = NULL,
            lease_expires_at = NULL, last_error = NULL, attention_reason = NULL, updated_at = ?,
            completed_at = COALESCE(completed_at, ?)
          WHERE id = ?`)
          .run(
            resolvedMessageId,
            sourceArtifactSha256 ?? job.sourceArtifactSha256,
            sourceArtifactBytes ?? job.sourceArtifactBytes,
            parserVersion ?? job.parserVersion,
            sourceSchemaSignature ?? job.sourceSchemaSignature,
            Number(counts.staged),
            Number(counts.consumed ?? 0),
            completedAt,
            completedAt,
            id,
          );
        return { job: this.getTapoHistoryExportJob(id)!, staged, duplicateCount };
      });
    },
  /** Read staged rows without mutating them so the recovery coordinator remains the ingestion authority. */
  listTapoHistoryExportStagedSamples(
      filter: TapoHistoryExportStagedSampleFilter = {},
    ): TapoHistoryExportStagedSample[] {
      const conditions: string[] = [];
      const parameters: Array<string | number> = [];
      if (filter.jobId) {
        conditions.push("job_id = ?");
        parameters.push(filter.jobId);
      }
      if (filter.sensorId) {
        conditions.push("sensor_id = ?");
        parameters.push(filter.sensorId);
      }
      if (filter.metric) {
        conditions.push("metric = ?");
        parameters.push(filter.metric);
      }
      if (filter.from) {
        conditions.push("timestamp >= ?");
        parameters.push(normalizedTapoHistoryTimestamp(filter.from, "from"));
      }
      if (filter.to) {
        conditions.push("timestamp <= ?");
        parameters.push(normalizedTapoHistoryTimestamp(filter.to, "to"));
      }
      if (filter.consumed !== undefined) conditions.push(filter.consumed ? "consumed_at IS NOT NULL" : "consumed_at IS NULL");
      // A job cannot stage more than 250,000 rows, so this upper bound lets a
      // recovery read prove it has the complete requested metric rather than
      // silently treating a truncated page as complete.
      const limit = Math.max(1, Math.min(250_000, Math.trunc(filter.limit ?? 10_000)));
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = this.db.prepare(`SELECT * FROM tapo_history_export_staged_samples ${where}
        ORDER BY timestamp, metric, id LIMIT ?`).all(...parameters, limit) as unknown as TapoHistoryExportStagedSampleRow[];
      return rows.map(tapoHistoryExportStagedSampleFromRow);
    },
  /** Marks only rows actually accepted by the coordinator; duplicate calls are harmless. */
  markTapoHistoryExportStagedSamplesConsumed(
      jobId: string,
      sampleIds: number[],
      consumedAt = new Date().toISOString(),
    ): number {
      const at = normalizedTapoHistoryTimestamp(consumedAt, "consumedAt");
      const ids = [...new Set(sampleIds)];
      if (ids.length === 0) return 0;
      if (ids.length > 250_000 || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_TAPO_EXPORT_SAMPLE_IDS",
          "sampleIds must contain at most 250000 positive integer identifiers",
        );
      }
      return this.immediateTransaction(() => {
        let changed = 0;
        // Stay below SQLite's host-parameter ceiling even for a maximum-size job.
        for (let offset = 0; offset < ids.length; offset += 5_000) {
          const batch = ids.slice(offset, offset + 5_000);
          const placeholders = batch.map(() => "?").join(",");
          const result = this.db.prepare(`UPDATE tapo_history_export_staged_samples SET consumed_at = ?
            WHERE job_id = ? AND consumed_at IS NULL AND id IN (${placeholders})`).run(at, jobId, ...batch);
          changed += Number(result.changes);
        }
        const counts = this.db.prepare(`SELECT COUNT(*) AS staged,
            SUM(CASE WHEN consumed_at IS NOT NULL THEN 1 ELSE 0 END) AS consumed
          FROM tapo_history_export_staged_samples WHERE job_id = ?`)
          .get(jobId) as { staged: number; consumed: number | null };
        this.db.prepare(`UPDATE tapo_history_export_jobs SET staged_sample_count = ?,
          consumed_sample_count = ?, updated_at = ? WHERE id = ?`)
          .run(Number(counts.staged), Number(counts.consumed ?? 0), at, jobId);
        return changed;
      });
    },
  /**
     * Bounds operational history while retaining recent audit evidence. Pending
     * recovery rows survive 180 days; cancellation/attention tombstones survive a year.
     */
  pruneTapoHistoryExportHistory(options: {
      consumedBefore: string;
      completedBefore: string;
      canaryBefore: string;
    }): { samples: number; jobs: number } {
      const consumedBefore = normalizedTapoHistoryTimestamp(options.consumedBefore, "consumedBefore");
      const completedBefore = normalizedTapoHistoryTimestamp(options.completedBefore, "completedBefore");
      const canaryBefore = normalizedTapoHistoryTimestamp(options.canaryBefore, "canaryBefore");
      return this.immediateTransaction(() => {
        const eligible = `status IN ('needs-attention', 'cancelled') AND updated_at <= :canaryBefore
          OR status = 'failed' AND updated_at <= :completedBefore
          OR status = 'completed' AND (
            dedupe_key LIKE 'canary:%' AND COALESCE(completed_at, updated_at) <= :canaryBefore
            OR dedupe_key NOT LIKE 'canary:%' AND (
              COALESCE(completed_at, updated_at) <= :completedBefore
              OR COALESCE(completed_at, updated_at) <= :consumedBefore AND NOT EXISTS (
                SELECT 1 FROM tapo_history_export_staged_samples pending
                WHERE pending.job_id = tapo_history_export_jobs.id AND pending.consumed_at IS NULL
              )
            )
          )`;
        const parameters = { consumedBefore, completedBefore, canaryBefore };
        const sampleCount = this.db.prepare(`SELECT COUNT(*) AS count
          FROM tapo_history_export_staged_samples staged
          WHERE EXISTS (
            SELECT 1 FROM tapo_history_export_jobs
            WHERE tapo_history_export_jobs.id = staged.job_id AND (${eligible})
          )`).get(parameters) as { count: number };
        // Delete the coverage authority and its rows together. Keeping an empty
        // completed job would otherwise block a future recovery forever.
        const jobs = this.db.prepare(`DELETE FROM tapo_history_export_jobs WHERE ${eligible}`).run(parameters);
        return { samples: Number(sampleCount.count), jobs: Number(jobs.changes) };
      });
    },
});
