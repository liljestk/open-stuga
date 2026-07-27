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
import { TAPO_HISTORY_ACCEPTANCE_REVISION, TAPO_HISTORY_API_IMPLEMENTATION_SHA256, TAPO_HISTORY_CSV_PARSER_VERSION, TAPO_TARGET_RECLAIM_GRACE_MS, TapoHistoryCanaryError, apiImplementationSha256 } from "../support/01-max-csv-bytes-to-tapo-csv-schema-signature.js";
import { tapoExportRecipient } from "../support/02-finite-csv-number-to-gmail-header.js";
import { GmailAuthenticationUnavailable, GmailSearchBudgetExceeded } from "../support/03-bounded-response-bytes-to-tapo-private-history-clien.js";
import { TapoWorkerStatusUpdate } from "../support/04-private-history-payload-to-staged-measurement.js";
import { registerTapoHistoryExportServiceMethods, tapoHistoryExportServiceState, type TapoHistoryExportServiceInternals } from "../core.js";

registerTapoHistoryExportServiceMethods({
  updateFromWorker(this: TapoHistoryExportServiceInternals, jobId: string, leaseToken: string, update: TapoWorkerStatusUpdate): TapoHistoryExportJob | null {
      const now = this[tapoHistoryExportServiceState].now();
      const current = this[tapoHistoryExportServiceState].database.getTapoHistoryExportJob(jobId);
      if (current && !this.targetAliasMatches(current)) {
        return this[tapoHistoryExportServiceState].database.transitionTapoHistoryExportJob(jobId, {
          status: "needs-attention",
          leaseToken,
          at: now.toISOString(),
          attentionReason: "The live Tapo device alias or immutable device binding changed while automation was running",
        });
      }
      return this[tapoHistoryExportServiceState].database.transitionTapoHistoryExportJob(jobId, {
        status: update.status,
        leaseToken,
        at: now.toISOString(),
        ...(update.status === "failed" ? {
          error: update.detail ?? "Tapo mobile export failed",
          availableAt: new Date(now.getTime() + 60_000).toISOString(),
        } : {}),
        ...(update.status === "needs-attention" ? {
          attentionReason: update.detail ?? "Tapo mobile automation needs operator attention",
        } : {}),
      });
    },
  retry(this: TapoHistoryExportServiceInternals, jobId: string): TapoHistoryExportJob | null {
      const now = this[tapoHistoryExportServiceState].now();
      const current = this[tapoHistoryExportServiceState].database.getTapoHistoryExportJob(jobId);
      const leaseFence = current?.leaseExpiresAt
        ? Date.parse(current.leaseExpiresAt) + TAPO_TARGET_RECLAIM_GRACE_MS
        : now.getTime();
      return this[tapoHistoryExportServiceState].database.requeueTapoHistoryExportJob(
        jobId,
        new Date(Math.max(now.getTime(), leaseFence)).toISOString(),
        true,
      );
    },
  cancel(this: TapoHistoryExportServiceInternals, jobId: string): TapoHistoryExportJob | null {
      return this[tapoHistoryExportServiceState].database.cancelTapoHistoryExportJob(jobId, this[tapoHistoryExportServiceState].now().toISOString());
    },
  /** Records an explicit operator-requested historical interval for normal segmented recovery. */
  requestBackfill(this: TapoHistoryExportServiceInternals,
      sensorId: string,
      metric: "temperature" | "humidity",
      from: string,
      to: string,
    ): SensorDataGapRecord {
      if (!this.operational) {
        throw new TapoHistoryCanaryError(
          "TAPO_HISTORY_NOT_CONFIGURED",
          "Tapo history backfill requires a complete app/mailbox or private-adapter configuration",
        );
      }
      const sensor = this[tapoHistoryExportServiceState].database.getSensor(sensorId);
      if (!sensor?.enabled || !this.boundDeviceId(sensorId)) {
        throw new TapoHistoryCanaryError(
          "TAPO_BACKFILL_SENSOR_NOT_BOUND",
          "Backfill sensor must be enabled and have an immutable TP-Link device binding",
        );
      }
      const nowDate = this[tapoHistoryExportServiceState].now();
      const fromMs = Date.parse(from);
      const toMs = Date.parse(to);
      const intervalMs = (this[tapoHistoryExportServiceState].config.tapoHistoryExportIntervalMinutes ?? 15) * 60_000;
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs
        || toMs - fromMs < 2 * intervalMs || toMs > nowDate.getTime() + 5 * 60_000
        || fromMs < nowDate.getTime() - 730 * 24 * 60 * 60_000
        || toMs - fromMs > 730 * 24 * 60 * 60_000) {
        throw new TapoHistoryCanaryError(
          "INVALID_TAPO_BACKFILL_RANGE",
          "Backfill must be within the most recent two years, span at least two export intervals, and not end in the future",
        );
      }
      const definition = this[tapoHistoryExportServiceState].database.getMeasurementDefinition(metric);
      if (!definition?.enabled) {
        throw new TapoHistoryCanaryError("TAPO_BACKFILL_TARGET_DISABLED", "Backfill metric must be enabled");
      }
      const now = nowDate.toISOString();
      const gap = this[tapoHistoryExportServiceState].database.noteHistoricalSensorDataGap(sensorId, metric, "tp-link", from, to, now);
      return this[tapoHistoryExportServiceState].database.rearmSensorDataGapRecovery(gap.id, now, true) ?? gap;
    },
  /** Queues an isolated end-to-end acceptance job; its staged rows are never offered to gap recovery. */
  createCanary(this: TapoHistoryExportServiceInternals, sensorId: string, metric: "temperature" | "humidity", from: string, to: string): TapoHistoryExportJob {
      return this.createCanaryJob(sensorId, metric, from, to, false);
    },
  createCanaryJob(this: TapoHistoryExportServiceInternals,
      sensorId: string,
      metric: "temperature" | "humidity",
      from: string,
      to: string,
      automaticRenewal: boolean,
    ): TapoHistoryExportJob {
      if (!this.enabled || !this[tapoHistoryExportServiceState].config.tapoHistoryExportEmail || !this[tapoHistoryExportServiceState].config.tapoHistoryWorkerToken || !this[tapoHistoryExportServiceState].mailbox) {
        throw new TapoHistoryCanaryError(
          "TAPO_CANARY_NOT_CONFIGURED",
          "Canary requires enabled Tapo history, export email, worker token, and Gmail OAuth configuration",
        );
      }
      const sensor = this[tapoHistoryExportServiceState].database.getSensor(sensorId);
      const deviceId = this.boundDeviceId(sensorId);
      if (!sensor?.enabled || !deviceId) {
        throw new TapoHistoryCanaryError("TAPO_CANARY_SENSOR_NOT_BOUND", "Canary sensor needs an immutable TP-Link device binding");
      }
      if (!["temperature", "humidity"].every(
        (requiredMetric) => this[tapoHistoryExportServiceState].database.getMeasurementDefinition(requiredMetric)?.enabled === true,
      )) {
        throw new TapoHistoryCanaryError(
          "TAPO_CANARY_METRIC_DISABLED",
          "Canary requires enabled temperature and humidity measurement definitions",
        );
      }
      const deviceName = this[tapoHistoryExportServiceState].options.deviceNameFor?.(sensorId, deviceId)?.trim() ?? "";
      if (!deviceName) {
        throw new TapoHistoryCanaryError(
          "TAPO_CANARY_DEVICE_ALIAS_MISSING",
          "Canary is waiting for one unique live-discovered Tapo device alias",
        );
      }
      return this.enqueue(sensorId, metric, from, to, "appium", deviceName, true, automaticRenewal);
    },
  enqueue(this: TapoHistoryExportServiceInternals,
      sensorId: string,
      metric: string,
      from: string,
      to: string,
      provider: TapoHistoryExportProvider,
      deviceName: string,
      canary = false,
      automaticRenewal = false,
    ): TapoHistoryExportJob {
      const sensor = this[tapoHistoryExportServiceState].database.getSensor(sensorId);
      const deviceId = this.boundDeviceId(sensorId);
      if (!sensor || !deviceId) throw new Error("TP-Link sensor binding disappeared");
      const house = this[tapoHistoryExportServiceState].database.getHouse(sensor.houseId);
      if (!house) throw new Error("TP-Link sensor house disappeared");
      const reusable = !canary ? this.findJob(sensorId, deviceId, house.timezone, from, to, [
        "queued", "claimed", "running", "waiting-email", "needs-attention", "completed", "failed", "cancelled",
      ], provider, deviceName, this[tapoHistoryExportServiceState].config.tapoHistoryExportIntervalMinutes ?? 15, metric) : null;
      if (reusable) return reusable;
      const intervalMinutes = this[tapoHistoryExportServiceState].config.tapoHistoryExportIntervalMinutes ?? 15;
      const id = randomUUID();
      const requestIdentity = [
        provider, sensorId, deviceId, deviceName.normalize("NFKC"), house.timezone, metric, from, to, String(intervalMinutes),
        ...(canary ? [id] : []),
      ].join("\u0000");
      const dedupeKey = `${canary ? (automaticRenewal ? "canary:renewal" : "canary") : "automation"}:${createHash("sha256").update(requestIdentity).digest("hex")}`;
      const existing = this[tapoHistoryExportServiceState].database.getTapoHistoryExportJobByDedupeKey(dedupeKey);
      if (existing) return existing;
      const correlationNonce = randomBytes(32).toString("base64url");
      const recipient = this[tapoHistoryExportServiceState].config.tapoHistoryExportEmail
        ? tapoExportRecipient(this[tapoHistoryExportServiceState].config.tapoHistoryExportEmail, correlationNonce, this[tapoHistoryExportServiceState].config.tapoHistoryEmailTagPrefix)
        : null;
      const result = this[tapoHistoryExportServiceState].database.enqueueTapoHistoryExportJob({
        id,
        sensorId,
        expectedDeviceId: deviceId,
        deviceName,
        timeZone: house.timezone,
        metric,
        rangeStart: from,
        rangeEnd: to,
        intervalMinutes,
        provider,
        expectedRecipient: recipient,
        dedupeKey,
      }, this[tapoHistoryExportServiceState].now().toISOString());
      return result.job;
    },
  findJob(this: TapoHistoryExportServiceInternals,
      sensorId: string,
      expectedDeviceId: string,
      timeZone: string,
      from: string,
      to: string,
      statuses: TapoHistoryExportJobStatus[],
      provider?: TapoHistoryExportProvider,
      deviceName?: string,
      intervalMinutes?: number,
      metric?: string,
    ): TapoHistoryExportJob | null {
      const requestedFrom = Date.parse(from);
      const requestedTo = Date.parse(to);
      return this[tapoHistoryExportServiceState].database.listTapoHistoryExportJobs({ sensorId, statuses, ...(provider ? { provider } : {}), limit: 1_000 })
        .find((job) => !job.dedupeKey.startsWith("canary:")
          && Date.parse(job.rangeStart) <= requestedFrom && Date.parse(job.rangeEnd) >= requestedTo
          && job.expectedDeviceId === expectedDeviceId
          && job.timeZone === timeZone
          && (job.provider !== "private-cloud" || metric === undefined || job.metric === metric)
          && (deviceName === undefined || job.deviceName === deviceName)
          && (intervalMinutes === undefined || job.intervalMinutes === intervalMinutes)) ?? null;
    },
  boundDeviceId(this: TapoHistoryExportServiceInternals, sensorId: string): string | null {
      const direct = this[tapoHistoryExportServiceState].database.getSensor(sensorId)?.tpLinkDeviceId?.trim();
      // Automated historical recovery requires a persisted direct binding.
      // Every job snapshots and revalidates this ID; legacy mutable map files are
      // intentionally excluded from the identity boundary.
      return direct || null;
    },
  acceptanceRevision(this: TapoHistoryExportServiceInternals): string {
      const mailboxCredentialProof = this[tapoHistoryExportServiceState].config.tapoHistoryGmailRefreshToken && this[tapoHistoryExportServiceState].config.tapoHistoryWorkerToken
        ? createHmac("sha256", this[tapoHistoryExportServiceState].config.tapoHistoryWorkerToken)
          .update(this[tapoHistoryExportServiceState].config.tapoHistoryGmailRefreshToken, "utf8").digest("hex")
        : null;
      return createHash("sha256").update(JSON.stringify({
        acceptanceContract: TAPO_HISTORY_ACCEPTANCE_REVISION,
        apiImplementationSha256: TAPO_HISTORY_API_IMPLEMENTATION_SHA256,
        runtime: {
          node: process.version,
          icu: process.versions.icu ?? null,
          tz: process.versions.tz ?? null,
          cldr: process.versions.cldr ?? null,
          unicode: process.versions.unicode ?? null,
        },
        parser: TAPO_HISTORY_CSV_PARSER_VERSION,
        exportEmail: this[tapoHistoryExportServiceState].config.tapoHistoryExportEmail?.trim().toLowerCase() ?? null,
        gmailAccountEmail: this[tapoHistoryExportServiceState].config.tapoHistoryGmailAccountEmail?.trim().toLowerCase() ?? null,
        gmailClientId: this[tapoHistoryExportServiceState].config.tapoHistoryGmailClientId?.trim() ?? null,
        mailboxCredentialProof,
      })).digest("hex");
    },
  targetAliasMatches(this: TapoHistoryExportServiceInternals, job: TapoHistoryExportJob): boolean {
      const sensor = this[tapoHistoryExportServiceState].database.getSensor(job.sensorId);
      const house = sensor ? this[tapoHistoryExportServiceState].database.getHouse(sensor.houseId) : null;
      const definition = this[tapoHistoryExportServiceState].database.getMeasurementDefinition(job.metric);
      const canaryDefinitionsEnabled = !job.canary || ["temperature", "humidity"]
        .every((metric) => this[tapoHistoryExportServiceState].database.getMeasurementDefinition(metric)?.enabled === true);
      if (job.provider !== "appium" || !sensor || !sensor.enabled || !definition?.enabled
        || !canaryDefinitionsEnabled || !house
        || sensor.tpLinkDeviceId?.trim() !== job.expectedDeviceId
        || house.timezone !== job.timeZone
        || job.acceptanceRevision !== this.acceptanceRevision()) return false;
      try {
        return (this[tapoHistoryExportServiceState].options.deviceNameFor?.(job.sensorId, job.expectedDeviceId)?.trim() ?? "") === job.deviceName;
      } catch {
        return false;
      }
    },
  recordMailboxSuccess(this: TapoHistoryExportServiceInternals, at = this[tapoHistoryExportServiceState].now().toISOString()): void {
      this[tapoHistoryExportServiceState].mailboxHealth.lastSuccessfulPollAt = at;
      this[tapoHistoryExportServiceState].mailboxHealth.consecutiveFailures = 0;
      this[tapoHistoryExportServiceState].mailboxHealth.lastErrorCode = null;
    },
  recordMailboxFailure(this: TapoHistoryExportServiceInternals, error: unknown, at = this[tapoHistoryExportServiceState].now().toISOString()): void {
      const code = error instanceof GmailSearchBudgetExceeded
        ? "budget_exhausted"
        : error instanceof GmailAuthenticationUnavailable
          ? "oauth_unavailable"
          : error instanceof Error && error.name
            ? error.name.replace(/[^a-z0-9_-]/giu, "_").toLowerCase().slice(0, 80)
            : "unknown_error";
      this[tapoHistoryExportServiceState].mailboxHealth.lastErrorAt = at;
      this[tapoHistoryExportServiceState].mailboxHealth.lastErrorCode = code;
      this[tapoHistoryExportServiceState].mailboxHealth.consecutiveFailures += 1;
      if (error instanceof GmailSearchBudgetExceeded) this[tapoHistoryExportServiceState].mailboxHealth.budgetExhaustions += 1;
    },
});
