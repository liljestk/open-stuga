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
import { TAPO_CANARY_APPROVAL_MAX_AGE_MS, TAPO_CANARY_RENEWAL_LEAD_MS, TAPO_TARGET_RECLAIM_GRACE_MS } from "../support/01-max-csv-bytes-to-tapo-csv-schema-signature.js";
import { assertTapoHistoryCsvCoverage, tapoExportRecipient } from "../support/02-finite-csv-number-to-gmail-header.js";
import { maxTapoHistoryJobSpanMs, recoveryKey, safeError, stageMeasurement, stagedMeasurement } from "../support/04-private-history-payload-to-staged-measurement.js";
import { registerTapoHistoryExportServiceMethods, tapoHistoryExportServiceState, type TapoHistoryExportServiceInternals } from "../core.js";

registerTapoHistoryExportServiceMethods({
  start(this: TapoHistoryExportServiceInternals): void {
      if (!this.enabled || this[tapoHistoryExportServiceState].timer) return;
      this.wake();
      this[tapoHistoryExportServiceState].timer = setInterval(() => this.wake(), Math.max(15_000, this[tapoHistoryExportServiceState].config.tapoHistoryMailboxPollIntervalMs ?? 60_000));
      this[tapoHistoryExportServiceState].timer.unref();
    },
  async stop(this: TapoHistoryExportServiceInternals): Promise<void> {
      if (this[tapoHistoryExportServiceState].timer) clearInterval(this[tapoHistoryExportServiceState].timer);
      this[tapoHistoryExportServiceState].timer = null;
      await this[tapoHistoryExportServiceState].polling;
    },
  wake(this: TapoHistoryExportServiceInternals): void {
      if (!this.enabled || this[tapoHistoryExportServiceState].polling) return;
      this[tapoHistoryExportServiceState].polling = this.pollMailbox()
        .catch((error: unknown) => {
          this.recordMailboxFailure(error);
          // Structured and deliberately detail-free: OAuth tokens, recipient
          // capabilities, and Gmail payloads must never enter API logs.
          console.warn(JSON.stringify({
            event: "tapo_history_mailbox_poll_failed",
            code: this[tapoHistoryExportServiceState].mailboxHealth.lastErrorCode,
          }));
        })
        .finally(() => { this[tapoHistoryExportServiceState].polling = null; });
    },
  async recoverHistory(this: TapoHistoryExportServiceInternals, sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult> {
      if (!this.enabled) return { state: "not-supported", samples: [], error: "Automated Tapo app history export is disabled" };
      const sensor = this[tapoHistoryExportServiceState].database.getSensor(sensorId);
      const deviceId = this.boundDeviceId(sensorId);
      if (!sensor || !deviceId) {
        return { state: "not-supported", samples: [], error: "Sensor has no TP-Link device binding" };
      }
      const definition = this[tapoHistoryExportServiceState].database.getMeasurementDefinition(metric);
      if (!sensor.enabled || !definition?.enabled) {
        return { state: "not-supported", samples: [], error: "Sensor or measurement metric is disabled" };
      }
      const house = this[tapoHistoryExportServiceState].database.getHouse(sensor.houseId);
      if (!house) return { state: "not-supported", samples: [], error: "Sensor house no longer exists" };
      const requestedFrom = Date.parse(from);
      const requestedTo = Date.parse(to);
      if (!Number.isFinite(requestedFrom) || !Number.isFinite(requestedTo) || requestedTo <= requestedFrom) {
        return { state: "not-supported", samples: [], error: "Tapo history recovery requires a valid increasing range" };
      }
      const providerCutoff = this[tapoHistoryExportServiceState].now().getTime() - 730 * 24 * 60 * 60_000;
      if (requestedFrom < providerCutoff) {
        return { state: "not-supported", samples: [], error: "Tapo app history is limited to the most recent two years" };
      }
      const intervalMinutes = this[tapoHistoryExportServiceState].config.tapoHistoryExportIntervalMinutes ?? 15;
      const maximumJobSpanMs = maxTapoHistoryJobSpanMs(
        intervalMinutes,
        this[tapoHistoryExportServiceState].config.tapoHistoryMaxExportDays ?? 30,
      );
      let segmentStart = requestedFrom;
      const completedJobs = this[tapoHistoryExportServiceState].database.listTapoHistoryExportJobs({ sensorId, statuses: ["completed"], limit: 1_000 })
        .filter((job) => !job.dedupeKey.startsWith("canary:")
          && job.expectedDeviceId === deviceId
          && job.timeZone === house.timezone
          && job.intervalMinutes === intervalMinutes
          && (job.provider === "private-cloud"
            ? job.metric === metric
            : metric === "temperature" || metric === "humidity")
          && Date.parse(job.rangeEnd) > requestedFrom
          && Date.parse(job.rangeStart) < requestedTo)
        .sort((left, right) => Date.parse(left.rangeStart) - Date.parse(right.rangeStart)
          || Date.parse(right.rangeEnd) - Date.parse(left.rangeEnd));
      while (segmentStart < requestedTo) {
        const completed = completedJobs.find((job) => Date.parse(job.rangeStart) <= segmentStart
          && Date.parse(job.rangeEnd) > segmentStart);
        if (!completed) break;
        const staged = this[tapoHistoryExportServiceState].database.listTapoHistoryExportStagedSamples({
          jobId: completed.id,
          sensorId,
          metric,
          from: new Date(segmentStart).toISOString(),
          to: new Date(Math.min(requestedTo, Date.parse(completed.rangeEnd))).toISOString(),
          consumed: false,
          limit: 250_000,
        });
        if (staged.length > 0) {
          this[tapoHistoryExportServiceState].pendingConsumption.set(recoveryKey(sensorId, metric, from, to), {
            jobId: completed.id, sampleIds: staged.map((sample) => sample.id),
          });
          const finalSegment = Date.parse(completed.rangeEnd) >= requestedTo;
          return {
            state: finalSegment ? "complete" : "partial",
            samples: staged.map(stagedMeasurement),
            error: finalSegment ? completed.detail : `Recovered bounded Tapo export segment ${completed.id}`,
          };
        }
        const anyRequestedMetric = this[tapoHistoryExportServiceState].database.listTapoHistoryExportStagedSamples({
          jobId: completed.id, sensorId, metric, limit: 1,
        }).length > 0;
        if (!anyRequestedMetric) {
          return {
            state: "partial",
            samples: [],
            error: `Tapo export job ${completed.id} proved its segment but contained no ${metric} samples`,
          };
        }
        segmentStart = Math.min(requestedTo, Date.parse(completed.rangeEnd));
      }

      if (segmentStart >= requestedTo) return { state: "complete", samples: [], error: null };
      const nextCompletedStart = completedJobs
        .map((job) => Date.parse(job.rangeStart))
        .filter((start) => start > segmentStart)
        .sort((left, right) => left - right)[0];
      const segmentEnd = Math.min(
        requestedTo,
        segmentStart + maximumJobSpanMs,
        nextCompletedStart ?? Number.POSITIVE_INFINITY,
      );
      const segmentFrom = new Date(segmentStart).toISOString();
      const segmentTo = new Date(segmentEnd).toISOString();

      const appReady = (metric === "temperature" || metric === "humidity")
        && Boolean(this[tapoHistoryExportServiceState].config.tapoHistoryExportEmail && this[tapoHistoryExportServiceState].config.tapoHistoryWorkerToken && this[tapoHistoryExportServiceState].mailbox);
      let privateFailure: string | null = null;
      if (this[tapoHistoryExportServiceState].privateClient) {
        try {
          const samples = await this[tapoHistoryExportServiceState].privateClient.fetch(deviceId, sensorId, segmentFrom, segmentTo);
          const currentSensor = this[tapoHistoryExportServiceState].database.getSensor(sensorId);
          const currentHouse = currentSensor ? this[tapoHistoryExportServiceState].database.getHouse(currentSensor.houseId) : null;
          if (!currentSensor?.enabled || !this[tapoHistoryExportServiceState].database.getMeasurementDefinition(metric)?.enabled
            || currentSensor.tpLinkDeviceId?.trim() !== deviceId || currentHouse?.timezone !== house.timezone) {
            throw new Error("Tapo sensor binding, enabled state, or house timezone changed during private history fetch");
          }
          const requestedSamples = samples.filter((sample) => sample.metric === metric);
          if (requestedSamples.length === 0) {
            throw new Error(`Experimental Tapo history response contained no ${metric} samples`);
          }
          assertTapoHistoryCsvCoverage({
            samples: requestedSamples,
            rowsRead: requestedSamples.length,
            rowsSkipped: 0,
            firstTimestamp: requestedSamples[0]?.timestamp ?? null,
            lastTimestamp: requestedSamples.at(-1)?.timestamp ?? null,
            schemaSignature: "private-cloud",
          }, {
            metric: metric as "temperature" | "humidity" | "power",
            from: segmentFrom,
            to: segmentTo,
            intervalMinutes,
          });
          const job = this.enqueue(sensorId, metric, segmentFrom, segmentTo, "private-cloud", sensor.name);
          const staged = this[tapoHistoryExportServiceState].database.completeTapoHistoryExportJobWithSamples(
            job.id,
            requestedSamples.map((sample) => stageMeasurement(sample, `private:${job.id}`)),
            { completedAt: this[tapoHistoryExportServiceState].now().toISOString() },
          );
          this[tapoHistoryExportServiceState].pendingConsumption.set(recoveryKey(sensorId, metric, from, to), {
            jobId: job.id,
            sampleIds: staged.staged.filter((sample) => sample.metric === metric).map((sample) => sample.id),
          });
          return {
            state: segmentEnd >= requestedTo ? "complete" : "partial",
            samples: requestedSamples,
            error: segmentEnd >= requestedTo ? null : `Recovered bounded private Tapo segment ${job.id}`,
          };
        } catch (error) {
          // The private endpoint is deliberately best-effort. A failed probe does
          // not block the documented app-export path or fabricate a worker lease.
          privateFailure = safeError(error);
        }
      }

      if (privateFailure && !appReady) {
        return {
          state: "partial",
          samples: [],
          error: `Experimental Tapo history endpoint is temporarily unavailable: ${privateFailure}`,
        };
      }

      const currentSensor = this[tapoHistoryExportServiceState].database.getSensor(sensorId);
      const currentHouse = currentSensor ? this[tapoHistoryExportServiceState].database.getHouse(currentSensor.houseId) : null;
      if (!currentSensor?.enabled || !this[tapoHistoryExportServiceState].database.getMeasurementDefinition(metric)?.enabled
        || currentSensor.tpLinkDeviceId?.trim() !== deviceId || currentHouse?.timezone !== house.timezone) {
        return {
          state: "partial",
          samples: [],
          error: "Tapo sensor binding, enabled state, or house timezone changed while history recovery was in flight",
        };
      }

      if (metric !== "temperature" && metric !== "humidity") {
        return {
          state: "not-supported",
          samples: [],
          error: `Tapo app CSV automation does not provide the ${metric} metric`,
        };
      }

      if (!appReady) {
        return {
          state: "not-supported",
          samples: [],
          error: "Unattended Tapo app export requires export email, worker token, and Gmail OAuth configuration",
        };
      }
      const appDeviceName = this[tapoHistoryExportServiceState].options.deviceNameFor?.(sensorId, deviceId)?.trim() ?? "";
      if (!appDeviceName) {
        return {
          state: "partial",
          samples: [],
          error: "Tapo app export is waiting for a unique discovered device alias; sensor display names are never guessed",
        };
      }
      const job = this.enqueue(sensorId, metric, segmentFrom, segmentTo, "appium", appDeviceName);
      return { state: "partial", samples: [], error: `Tapo app export job ${job.id} is ${job.status}` };
    },
  consumeRecovered(this: TapoHistoryExportServiceInternals, sensorId: string, metric: string, from: string, to: string): void {
      const key = recoveryKey(sensorId, metric, from, to);
      const pending = this[tapoHistoryExportServiceState].pendingConsumption.get(key);
      if (!pending) return;
      this[tapoHistoryExportServiceState].database.markTapoHistoryExportStagedSamplesConsumed(pending.jobId, pending.sampleIds, this[tapoHistoryExportServiceState].now().toISOString());
      this[tapoHistoryExportServiceState].pendingConsumption.delete(key);
    },
  listJobs(this: TapoHistoryExportServiceInternals, limit = 100): TapoHistoryExportJob[] {
      const now = this[tapoHistoryExportServiceState].now();
      this[tapoHistoryExportServiceState].database.expireExhaustedTapoHistoryExportLeases(
        now.toISOString(),
        new Date(now.getTime() - TAPO_TARGET_RECLAIM_GRACE_MS).toISOString(),
      );
      return this[tapoHistoryExportServiceState].database.listTapoHistoryExportJobs({ limit });
    },
  claim(this: TapoHistoryExportServiceInternals, workerId: string, deploymentFingerprint: string): (TapoHistoryExportClaim & { serverNow: string }) | null {
      for (let skipped = 0; skipped < 100; skipped += 1) {
        const now = this[tapoHistoryExportServiceState].now();
        const reclaimCutoff = new Date(now.getTime() - TAPO_TARGET_RECLAIM_GRACE_MS).toISOString();
        this[tapoHistoryExportServiceState].database.expireExhaustedTapoHistoryExportLeases(now.toISOString(), reclaimCutoff);
        if (this[tapoHistoryExportServiceState].database.countWaitingTapoHistoryExportEmails()
          >= (this[tapoHistoryExportServiceState].config.tapoHistoryMaxPendingEmails ?? 1)) return null;
        const acceptanceRevision = this.acceptanceRevision();
        const renewalTarget = this[tapoHistoryExportServiceState].database.tapoHistoryCanaryRenewalTarget(
          deploymentFingerprint,
          acceptanceRevision,
          new Date(now.getTime() - TAPO_CANARY_APPROVAL_MAX_AGE_MS + TAPO_CANARY_RENEWAL_LEAD_MS).toISOString(),
        );
        if (renewalTarget) {
          const canaryEnd = now.getTime() - 5 * 60_000;
          // Renewal must observe enough real environmental movement for the
          // dual-metric anti-constant canary checks. A two-hour stable room often
          // cannot do that, so use the same bounded window as manual acceptance.
          const canarySpan = Math.max(7 * 24 * 60 * 60_000, 8 * renewalTarget.intervalMinutes * 60_000);
          try {
            this.createCanaryJob(
              renewalTarget.sensorId,
              renewalTarget.metric as "temperature" | "humidity",
              new Date(canaryEnd - canarySpan).toISOString(),
              new Date(canaryEnd).toISOString(),
              true,
            );
          } catch {
            // Keep a still-fresh prior approval usable if automatic renewal could
            // not be queued. Once it expires, ordinary selection below remains
            // closed and the authenticated status exposes the queued work.
          }
        }
        const claimArguments = [
          workerId,
          now.toISOString(),
          new Date(now.getTime() + Math.max(5 * 60_000, this[tapoHistoryExportServiceState].config.tapoHistoryWorkerLeaseMs ?? 5 * 60_000)).toISOString(),
          ["appium"],
          reclaimCutoff,
        ] as const;
        // Always lease a runnable canary first. Ordinary work is selected only
        // when this exact deployment has a fresh approval for the candidate's
        // sensor/device alias/timezone/export-interval scope.
        const claim = this[tapoHistoryExportServiceState].database.claimNextTapoHistoryExportJob(...claimArguments, {
          canaryOnly: true,
          deploymentFingerprint,
          acceptanceRevision,
          maxOutstandingAppium: this[tapoHistoryExportServiceState].config.tapoHistoryMaxPendingEmails ?? 1,
        }) ?? this[tapoHistoryExportServiceState].database.claimNextTapoHistoryExportJob(...claimArguments, {
          deploymentFingerprint,
          acceptanceRevision,
          requireApprovedTarget: true,
          approvalNotBefore: new Date(now.getTime() - TAPO_CANARY_APPROVAL_MAX_AGE_MS).toISOString(),
          requiredAcceptanceRevision: acceptanceRevision,
          maxOutstandingAppium: this[tapoHistoryExportServiceState].config.tapoHistoryMaxPendingEmails ?? 1,
        });
        if (!claim) return null;
        if (this.targetAliasMatches(claim.job) && this[tapoHistoryExportServiceState].config.tapoHistoryExportEmail) {
          const recipient = tapoExportRecipient(
            this[tapoHistoryExportServiceState].config.tapoHistoryExportEmail,
            randomBytes(32).toString("base64url"),
            this[tapoHistoryExportServiceState].config.tapoHistoryEmailTagPrefix,
          );
          const rotated = this[tapoHistoryExportServiceState].database.rotateTapoHistoryExportRecipient(
            claim.job.id,
            claim.leaseToken,
            recipient,
            now.toISOString(),
          );
          if (rotated) return { job: rotated, leaseToken: claim.leaseToken, serverNow: now.toISOString() };
          return null;
        }
        this[tapoHistoryExportServiceState].database.transitionTapoHistoryExportJob(claim.job.id, {
          status: "needs-attention",
          leaseToken: claim.leaseToken,
          at: now.toISOString(),
          attentionReason: "The live Tapo device alias or immutable device binding changed after this job was queued",
        });
      }
      return null;
    },
  heartbeat(this: TapoHistoryExportServiceInternals, jobId: string, leaseToken: string): { job: TapoHistoryExportJob; serverNow: string } | null {
      const now = this[tapoHistoryExportServiceState].now();
      const current = this[tapoHistoryExportServiceState].database.getTapoHistoryExportJob(jobId);
      if (current && !this.targetAliasMatches(current)) {
        this[tapoHistoryExportServiceState].database.transitionTapoHistoryExportJob(jobId, {
          status: "needs-attention",
          leaseToken,
          at: now.toISOString(),
          attentionReason: "The live Tapo device alias or immutable device binding changed while automation was running",
        });
        return null;
      }
      const job = this[tapoHistoryExportServiceState].database.heartbeatTapoHistoryExportJob(
        jobId, leaseToken, now.toISOString(),
        new Date(now.getTime() + Math.max(5 * 60_000, this[tapoHistoryExportServiceState].config.tapoHistoryWorkerLeaseMs ?? 5 * 60_000)).toISOString(),
      );
      return job ? { job, serverNow: now.toISOString() } : null;
    },
});
