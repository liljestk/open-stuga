import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync, readdirSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { MeasurementSample } from "@climate-twin/contracts";
import type { AppConfig } from "../../config.js";
import type {
  ClimateDatabase,
  SensorDataGapRecord,
  TapoHistoryExportClaim,
  TapoHistoryExportJob,
  TapoHistoryExportJobStatus,
  TapoHistoryExportProvider,
  TapoHistoryExportStagedSample,
  TapoHistoryExportStagedSampleInput,
} from "../../db.js";
import type { SensorHistoryRecoveryResult } from "../../sensor-gap-recovery.js";
import { CANARY_JOB_RETENTION_MS, CONSUMED_STAGE_RETENTION_MS, EXPORT_JOB_RETENTION_MS, MAX_GMAIL_SEARCH_MS, TAPO_HISTORY_CSV_PARSER_VERSION, TAPO_TARGET_RECLAIM_GRACE_MS, TapoHistoryFormatError } from "../support/01-max-csv-bytes-to-tapo-csv-schema-signature.js";
import { assertTapoCanaryMatchesLive, assertTapoHistoryCsvCoverage, parseTapoHistoryCsv } from "../support/02-finite-csv-number-to-gmail-header.js";
import { GmailAuthenticationUnavailable, GmailSearchBudgetExceeded, gmailSearchBudget } from "../support/03-bounded-response-bytes-to-tapo-private-history-clien.js";
import { safeError, stageMeasurement } from "../support/04-private-history-payload-to-staged-measurement.js";
import { registerTapoHistoryExportServiceMethods, tapoHistoryExportServiceState, type TapoHistoryExportServiceInternals } from "../core.js";

registerTapoHistoryExportServiceMethods({
  async pollMailbox(this: TapoHistoryExportServiceInternals): Promise<void> {
      const maintenanceNow = this[tapoHistoryExportServiceState].now();
      this[tapoHistoryExportServiceState].database.expireExhaustedTapoHistoryExportLeases(
        maintenanceNow.toISOString(),
        new Date(maintenanceNow.getTime() - TAPO_TARGET_RECLAIM_GRACE_MS).toISOString(),
      );
      if (maintenanceNow.getTime() - this[tapoHistoryExportServiceState].lastMaintenanceAt >= 24 * 60 * 60_000) {
        this[tapoHistoryExportServiceState].database.pruneTapoHistoryExportHistory({
          consumedBefore: new Date(maintenanceNow.getTime() - CONSUMED_STAGE_RETENTION_MS).toISOString(),
          completedBefore: new Date(maintenanceNow.getTime() - EXPORT_JOB_RETENTION_MS).toISOString(),
          canaryBefore: new Date(maintenanceNow.getTime() - CANARY_JOB_RETENTION_MS).toISOString(),
        });
        this[tapoHistoryExportServiceState].lastMaintenanceAt = maintenanceNow.getTime();
      }
      if (!this[tapoHistoryExportServiceState].mailbox) return;
      const jobs = this[tapoHistoryExportServiceState].database.listTapoHistoryExportJobs({ statuses: ["waiting-email"], oldestFirst: true, limit: 100 });
      const pollDeadlineAt = Date.now() + MAX_GMAIL_SEARCH_MS;
      const pollBudget = gmailSearchBudget(pollDeadlineAt);
      for (const job of jobs) {
        if (Date.now() >= pollDeadlineAt) break;
        if (!job.expectedRecipient) continue;
        const now = this[tapoHistoryExportServiceState].now();
        const timeoutMs = Math.max(60_000, this[tapoHistoryExportServiceState].config.tapoHistoryEmailTimeoutMs ?? 6 * 60 * 60_000);
        if (!job.submittedAt) {
          this[tapoHistoryExportServiceState].database.transitionTapoHistoryExportJob(job.id, {
            status: "needs-attention",
            at: now.toISOString(),
            expectedRecipient: job.expectedRecipient,
            expectedSubmittedAt: null,
            attentionReason: "Tapo export is missing its server-recorded submission timestamp",
          });
          continue;
        }
        const emailDeadlineExpired = Date.parse(job.submittedAt) + timeoutMs <= now.getTime();
        try {
          const seen = new Set(this[tapoHistoryExportServiceState].database.listTapoHistoryExportJobs({ limit: 1_000 })
            .flatMap((candidate) => candidate.mailboxMessageId ? [candidate.mailboxMessageId] : []));
          const search = await this[tapoHistoryExportServiceState].mailbox.findCsv(job.expectedRecipient, seen, job.submittedAt, pollBudget);
          if (search.transientFailures === 0) this.recordMailboxSuccess(now.toISOString());
          else {
            const transient = new Error("One or more Gmail message fetches failed transiently");
            transient.name = "GmailTransientFailure";
            this.recordMailboxFailure(transient, now.toISOString());
          }
          let attachmentError: string | null = null;
          let completed = false;
          for (const attachment of search.attachments) {
            try {
              const sensor = this[tapoHistoryExportServiceState].database.getSensor(job.sensorId);
              if (!sensor || !this.targetAliasMatches(job)) {
                throw new Error("Tapo export job device binding or unique live alias changed");
              }
              const parsed = parseTapoHistoryCsv(attachment.bytes, {
                sensorId: job.sensorId, timeZone: job.timeZone, from: job.from, to: job.to,
              });
              if (!job.canary && parsed.schemaSignature !== job.expectedSchemaSignature) {
                this[tapoHistoryExportServiceState].database.revokeTapoHistoryCanaryApprovalsForJobTarget(job.id);
                const canaryEnd = this[tapoHistoryExportServiceState].now().getTime() - 5 * 60_000;
                const canarySpan = Math.max(7 * 24 * 60 * 60_000, 8 * job.intervalMinutes * 60_000);
                try {
                  this.createCanaryJob(
                    job.sensorId,
                    job.metric as "temperature" | "humidity",
                    new Date(canaryEnd - canarySpan).toISOString(),
                    new Date(canaryEnd).toISOString(),
                    true,
                  );
                } catch {
                  // Approval remains revoked even if target state prevents an
                  // automatic recertification job. Operator health exposes the
                  // needs-attention job and ordinary claims remain closed.
                }
                throw new TapoHistoryFormatError(
                  "Tapo CSV schema changed after acceptance; approval was revoked and a fresh canary is required",
                );
              }
              if (job.metric !== "temperature" && job.metric !== "humidity") {
                throw new Error(`Tapo app CSV cannot satisfy ${job.metric}`);
              }
              assertTapoHistoryCsvCoverage(parsed, {
                metric: job.metric,
                from: job.from,
                to: job.to,
                intervalMinutes: job.intervalMinutes,
              });
              if (job.canary) {
                // Approval is deployment-wide, so the canary must independently
                // prove both climate columns rather than only the gap that caused
                // the operator to enqueue it.
                for (const canaryMetric of ["temperature", "humidity"] as const) {
                  assertTapoHistoryCsvCoverage(parsed, {
                    metric: canaryMetric,
                    from: job.from,
                    to: job.to,
                    intervalMinutes: job.intervalMinutes,
                  });
                  const live = this[tapoHistoryExportServiceState].options.telemetryReader
                    ? (await this[tapoHistoryExportServiceState].options.telemetryReader.measurementHistory({
                      sensorId: job.sensorId,
                      metric: canaryMetric,
                      from: job.from,
                      to: job.to,
                      limit: 20_000,
                    })).records
                    : this[tapoHistoryExportServiceState].database.measurementHistory(
                      job.sensorId,
                      canaryMetric,
                      job.from,
                      job.to,
                      20_000,
                    );
                  assertTapoCanaryMatchesLive(
                    parsed.samples,
                    live,
                    canaryMetric,
                    job.intervalMinutes,
                  );
                }
              }
              const result = this[tapoHistoryExportServiceState].database.completeTapoHistoryExportJobWithSamples(
                job.id,
                parsed.samples.map((sample) => stageMeasurement(sample, `gmail:${attachment.messageId}`)),
                {
                  mailboxMessageId: attachment.messageId,
                  completedAt: this[tapoHistoryExportServiceState].now().toISOString(),
                  expectedRecipient: job.expectedRecipient,
                  expectedSubmittedAt: job.submittedAt,
                  sourceArtifactSha256: createHash("sha256").update(attachment.bytes).digest("hex"),
                  sourceArtifactBytes: attachment.bytes.byteLength,
                  parserVersion: TAPO_HISTORY_CSV_PARSER_VERSION,
                  sourceSchemaSignature: parsed.schemaSignature,
                },
              );
              if (job.canary) {
                this[tapoHistoryExportServiceState].database.approveTapoHistoryDeploymentFromCanary(
                  result.job.id,
                  this.acceptanceRevision(),
                  this[tapoHistoryExportServiceState].now().toISOString(),
                );
              } else {
                this[tapoHistoryExportServiceState].database.expediteSensorDataGapRecovery(
                  job.sensorId, "tp-link", job.rangeStart, job.rangeEnd, this[tapoHistoryExportServiceState].now().toISOString(),
                );
                this[tapoHistoryExportServiceState].options.onHistoryReady?.(result.job);
              }
              completed = true;
              break;
            } catch (error) { attachmentError = safeError(error); }
          }
          if (!completed && attachmentError) {
            this[tapoHistoryExportServiceState].database.transitionTapoHistoryExportJob(job.id, {
              status: "needs-attention",
              at: this[tapoHistoryExportServiceState].now().toISOString(),
              expectedRecipient: job.expectedRecipient,
              expectedSubmittedAt: job.submittedAt,
              attentionReason: attachmentError,
            });
          } else if (!completed && search.rejectedCandidates > 0) {
            this[tapoHistoryExportServiceState].database.transitionTapoHistoryExportJob(job.id, {
              status: "needs-attention",
              at: this[tapoHistoryExportServiceState].now().toISOString(),
              expectedRecipient: job.expectedRecipient,
              expectedSubmittedAt: job.submittedAt,
              attentionReason: `Correlated Gmail messages contained ${search.rejectedCandidates} invalid or oversized CSV attachment(s)`,
            });
          } else if (!completed && emailDeadlineExpired && search.transientFailures === 0) {
            // A delivery deadline is meaningful only after a healthy Gmail list
            // and message scan. OAuth/network/individual-message failures pause
            // the deadline instead of burning another mobile export attempt.
            this[tapoHistoryExportServiceState].database.transitionTapoHistoryExportJob(job.id, {
              status: "failed",
              at: now.toISOString(),
              expectedRecipient: job.expectedRecipient,
              expectedSubmittedAt: job.submittedAt,
              availableAt: new Date(now.getTime() + 60_000).toISOString(),
              error: "No correlated Tapo export email arrived before the configured timeout",
            });
          }
        } catch (error) {
          this.recordMailboxFailure(error);
          if (error instanceof GmailSearchBudgetExceeded || error instanceof GmailAuthenticationUnavailable) break;
          // Mailbox network/OAuth failures are transient. The job remains in
          // waiting-email and the next bounded poll retries it.
        }
      }
    },
});
