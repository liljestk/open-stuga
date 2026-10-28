import { reportBackgroundFailure } from "../system-error-log.js";
import { hasLocalHouseAuthority } from "@climate-twin/contracts";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { ClimateDatabase, SensorDataGapRecord, TapoHistoryExportClaim, TapoHistoryExportJob, TapoHistoryExportJobStatus, TapoHistoryExportProvider } from "../db.js";
import type { SensorHistoryRecoveryResult } from "../sensor-gap-recovery.js";
import { CANARY_JOB_RETENTION_MS, CONSUMED_STAGE_RETENTION_MS, EXPORT_JOB_RETENTION_MS, MAX_GMAIL_SEARCH_MS, TAPO_CANARY_APPROVAL_MAX_AGE_MS, TAPO_CANARY_RENEWAL_LEAD_MS, TAPO_HISTORY_ACCEPTANCE_REVISION, TAPO_HISTORY_API_IMPLEMENTATION_SHA256, TAPO_HISTORY_CSV_PARSER_VERSION, TAPO_TARGET_RECLAIM_GRACE_MS, TapoHistoryCanaryError, TapoHistoryFormatError } from "./support/01-max-csv-bytes-to-tapo-csv-schema-signature.js";
import { assertTapoCanaryMatchesLive, assertTapoHistoryCsvCoverage, parseTapoHistoryCsv, tapoExportRecipient } from "./support/02-finite-csv-number-to-gmail-header.js";
import { GmailAuthenticationUnavailable, gmailSearchBudget, GmailSearchBudgetExceeded, GmailTapoMailbox } from "./support/03-bounded-response-bytes-to-tapo-private-history-clien.js";
import { maxTapoHistoryJobSpanMs, recoveryKey, safeError, stagedMeasurement, stageMeasurement, TapoHistoryMailboxHealth, TapoHistoryServiceOptions, TapoPrivateHistoryClient, TapoWorkerStatusUpdate } from "./support/04-private-history-payload-to-staged-measurement.js";

export class TapoHistoryExportServiceCore {
  readonly #mailbox: GmailTapoMailbox | null;
  readonly #privateClient: TapoPrivateHistoryClient | null;
  readonly #fetcher: typeof fetch;
  readonly #now: () => Date;
  readonly #pendingConsumption: Map<string, { jobId: string; sampleIds: number[] }> = new Map<string, { jobId: string; sampleIds: number[] }>();
  readonly #mailboxHealth: TapoHistoryMailboxHealth = {
    lastSuccessfulPollAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    consecutiveFailures: 0,
    budgetExhaustions: 0,
  };
  #timer: NodeJS.Timeout | null = null;
  #polling: Promise<void> | null = null;
  #lastMaintenanceAt: number = 0;
  readonly #config: AppConfig;
  readonly #database: ClimateDatabase;
  readonly #options: TapoHistoryServiceOptions;

  get enabled(): boolean { return this.#config.tapoHistoryEnabled === true; }

  get operational(): boolean {
    const appReady = Boolean(this.#config.tapoHistoryExportEmail
      && this.#config.tapoHistoryWorkerToken && this.#mailbox);
    return this.enabled && (appReady || this.#privateClient !== null);
  }

  get mailboxHealth(): Readonly<TapoHistoryMailboxHealth> {
    return { ...this.#mailboxHealth };
  }

  constructor(
    config: AppConfig,
    database: ClimateDatabase,
    options: TapoHistoryServiceOptions = {},
  ) {
    this.#config = config;
    this.#database = database;
    this.#options = options;
    this.#fetcher = options.fetcher ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#mailbox = config.tapoHistoryGmailClientId && config.tapoHistoryGmailClientSecret && config.tapoHistoryGmailRefreshToken
      ? new GmailTapoMailbox({
          clientId: config.tapoHistoryGmailClientId,
          clientSecret: config.tapoHistoryGmailClientSecret,
          refreshToken: config.tapoHistoryGmailRefreshToken,
          expectedEmail: config.tapoHistoryGmailAccountEmail ?? config.tapoHistoryExportEmail!,
          fetcher: this.#fetcher,
    }) : null;
    this.#privateClient = config.tapoHistoryPrivateEndpoint && config.tapoHistoryPrivateToken
      ? new TapoPrivateHistoryClient({
          endpoint: config.tapoHistoryPrivateEndpoint,
          token: config.tapoHistoryPrivateToken,
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
          ...(options.privateResolver ? { resolver: options.privateResolver } : {}),
        })
    : null;
    if (this.operational) {
      const appReady = Boolean(config.tapoHistoryExportEmail && config.tapoHistoryWorkerToken && this.#mailbox);
      const capabilityRevision = createHash("sha256").update(JSON.stringify({
        schema: 2,
        appReady,
        privateEndpoint: this.#privateClient ? config.tapoHistoryPrivateEndpoint : null,
        parser: TAPO_HISTORY_CSV_PARSER_VERSION,
      })).digest("hex");
      this.#database.rearmNotSupportedSensorDataGaps(
        "tp-link",
        capabilityRevision,
        this.#now().toISOString(),
      );
    }
  }

  start(): void {
    if (!this.enabled || this.#timer) return;
    this.wake();
    this.#timer = setInterval(() => this.wake(), Math.max(15_000, this.#config.tapoHistoryMailboxPollIntervalMs ?? 60_000));
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#polling;
  }

  wake(): void {
    if (!this.enabled || this.#polling) return;
    this.#polling = this.pollMailbox()
      .catch((error: unknown) => {
        this.recordMailboxFailure(error);
        // Deliberately detail-free: OAuth tokens, recipient capabilities and
        // Gmail payloads must never enter the logs.
        reportBackgroundFailure(this.#options.systemErrorLog, {
          level: "warning",
          source: "tapo-history",
          code: this.#mailboxHealth.lastErrorCode ?? "MAILBOX_POLL_FAILED",
          message: "Tapo history mailbox poll failed",
        });
      })
      .finally(() => { this.#polling = null; });
  }

  async recoverHistory(sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult> {
    if (!this.enabled) return { state: "not-supported", samples: [], error: "Automated Tapo app history export is disabled" };
    const sensor = this.#database.getSensor(sensorId);
    const deviceId = this.boundDeviceId(sensorId);
    if (!sensor || !deviceId) {
      return { state: "not-supported", samples: [], error: "Sensor has no TP-Link device binding" };
    }
    const definition = this.#database.getMeasurementDefinition(metric);
    if (!sensor.enabled || !definition?.enabled) {
      return { state: "not-supported", samples: [], error: "Sensor or measurement metric is disabled" };
    }
    const house = this.#database.getHouse(sensor.houseId);
    if (!house) return { state: "not-supported", samples: [], error: "Sensor house no longer exists" };
    if (!hasLocalHouseAuthority(house)) {
      return { state: "not-supported", samples: [], error: "Tapo history recovery requires local Home authority" };
    }
    const requestedFrom = Date.parse(from);
    const requestedTo = Date.parse(to);
    if (!Number.isFinite(requestedFrom) || !Number.isFinite(requestedTo) || requestedTo <= requestedFrom) {
      return { state: "not-supported", samples: [], error: "Tapo history recovery requires a valid increasing range" };
    }
    const providerCutoff = this.#now().getTime() - 730 * 24 * 60 * 60_000;
    if (requestedFrom < providerCutoff) {
      return { state: "not-supported", samples: [], error: "Tapo app history is limited to the most recent two years" };
    }
    const intervalMinutes = this.#config.tapoHistoryExportIntervalMinutes ?? 15;
    const maximumJobSpanMs = maxTapoHistoryJobSpanMs(
      intervalMinutes,
      this.#config.tapoHistoryMaxExportDays ?? 30,
    );
    let segmentStart = requestedFrom;
    const completedJobs = this.#database.listTapoHistoryExportJobs({ sensorId, statuses: ["completed"], limit: 1_000 })
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
      const staged = this.#database.listTapoHistoryExportStagedSamples({
        jobId: completed.id,
        sensorId,
        metric,
        from: new Date(segmentStart).toISOString(),
        to: new Date(Math.min(requestedTo, Date.parse(completed.rangeEnd))).toISOString(),
        consumed: false,
        limit: 250_000,
      });
      if (staged.length > 0) {
        this.#pendingConsumption.set(recoveryKey(sensorId, metric, from, to), {
          jobId: completed.id, sampleIds: staged.map((sample) => sample.id),
        });
        const finalSegment = Date.parse(completed.rangeEnd) >= requestedTo;
        return {
          state: finalSegment ? "complete" : "partial",
          samples: staged.map(stagedMeasurement),
          error: finalSegment ? completed.detail : `Recovered bounded Tapo export segment ${completed.id}`,
        };
      }
      const anyRequestedMetric = this.#database.listTapoHistoryExportStagedSamples({
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
      && Boolean(this.#config.tapoHistoryExportEmail && this.#config.tapoHistoryWorkerToken && this.#mailbox);
    let privateFailure: string | null = null;
    if (this.#privateClient) {
      try {
        const samples = await this.#privateClient.fetch(deviceId, sensorId, segmentFrom, segmentTo);
        const currentSensor = this.#database.getSensor(sensorId);
        const currentHouse = currentSensor ? this.#database.getHouse(currentSensor.houseId) : null;
        if (!currentSensor?.enabled || !this.#database.getMeasurementDefinition(metric)?.enabled
          || currentSensor.tpLinkDeviceId?.trim() !== deviceId || currentHouse?.timezone !== house.timezone
          || !hasLocalHouseAuthority(currentHouse)) {
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
        const staged = this.#database.completeTapoHistoryExportJobWithSamples(
          job.id,
          requestedSamples.map((sample) => stageMeasurement(sample, `private:${job.id}`)),
          { completedAt: this.#now().toISOString() },
        );
        this.#pendingConsumption.set(recoveryKey(sensorId, metric, from, to), {
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

    const currentSensor = this.#database.getSensor(sensorId);
    const currentHouse = currentSensor ? this.#database.getHouse(currentSensor.houseId) : null;
    if (!currentSensor?.enabled || !this.#database.getMeasurementDefinition(metric)?.enabled
      || currentSensor.tpLinkDeviceId?.trim() !== deviceId || currentHouse?.timezone !== house.timezone
      || !hasLocalHouseAuthority(currentHouse)) {
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
    const appDeviceName = this.#options.deviceNameFor?.(sensorId, deviceId)?.trim() ?? "";
    if (!appDeviceName) {
      return {
        state: "partial",
        samples: [],
        error: "Tapo app export is waiting for a unique discovered device alias; sensor display names are never guessed",
      };
    }
    const job = this.enqueue(sensorId, metric, segmentFrom, segmentTo, "appium", appDeviceName);
    return { state: "partial", samples: [], error: `Tapo app export job ${job.id} is ${job.status}` };
  }

  consumeRecovered(sensorId: string, metric: string, from: string, to: string): void {
    const key = recoveryKey(sensorId, metric, from, to);
    const pending = this.#pendingConsumption.get(key);
    if (!pending) return;
    this.#database.markTapoHistoryExportStagedSamplesConsumed(pending.jobId, pending.sampleIds, this.#now().toISOString());
    this.#pendingConsumption.delete(key);
  }

  listJobs(limit = 100): TapoHistoryExportJob[] {
    const now = this.#now();
    this.#database.expireExhaustedTapoHistoryExportLeases(
      now.toISOString(),
      new Date(now.getTime() - TAPO_TARGET_RECLAIM_GRACE_MS).toISOString(),
    );
    return this.#database.listTapoHistoryExportJobs({ limit });
  }

  claim(workerId: string, deploymentFingerprint: string): (TapoHistoryExportClaim & { serverNow: string }) | null {
    for (let skipped = 0; skipped < 100; skipped += 1) {
      const now = this.#now();
      const reclaimCutoff = new Date(now.getTime() - TAPO_TARGET_RECLAIM_GRACE_MS).toISOString();
      this.#database.expireExhaustedTapoHistoryExportLeases(now.toISOString(), reclaimCutoff);
      if (this.#database.countWaitingTapoHistoryExportEmails()
        >= (this.#config.tapoHistoryMaxPendingEmails ?? 1)) return null;
      const acceptanceRevision = this.acceptanceRevision();
      const renewalTarget = this.#database.tapoHistoryCanaryRenewalTarget(
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
        new Date(now.getTime() + Math.max(5 * 60_000, this.#config.tapoHistoryWorkerLeaseMs ?? 5 * 60_000)).toISOString(),
        ["appium"],
        reclaimCutoff,
      ] as const;
      // Always lease a runnable canary first. Ordinary work is selected only
      // when this exact deployment has a fresh approval for the candidate's
      // sensor/device alias/timezone/export-interval scope.
      const claim = this.#database.claimNextTapoHistoryExportJob(...claimArguments, {
        canaryOnly: true,
        deploymentFingerprint,
        acceptanceRevision,
        maxOutstandingAppium: this.#config.tapoHistoryMaxPendingEmails ?? 1,
      }) ?? this.#database.claimNextTapoHistoryExportJob(...claimArguments, {
        deploymentFingerprint,
        acceptanceRevision,
        requireApprovedTarget: true,
        approvalNotBefore: new Date(now.getTime() - TAPO_CANARY_APPROVAL_MAX_AGE_MS).toISOString(),
        requiredAcceptanceRevision: acceptanceRevision,
        maxOutstandingAppium: this.#config.tapoHistoryMaxPendingEmails ?? 1,
      });
      if (!claim) return null;
      if (this.targetAliasMatches(claim.job) && this.#config.tapoHistoryExportEmail) {
        const recipient = tapoExportRecipient(
          this.#config.tapoHistoryExportEmail,
          randomBytes(32).toString("base64url"),
          this.#config.tapoHistoryEmailTagPrefix,
        );
        const rotated = this.#database.rotateTapoHistoryExportRecipient(
          claim.job.id,
          claim.leaseToken,
          recipient,
          now.toISOString(),
        );
        if (rotated) return { job: rotated, leaseToken: claim.leaseToken, serverNow: now.toISOString() };
        return null;
      }
      this.#database.transitionTapoHistoryExportJob(claim.job.id, {
        status: "needs-attention",
        leaseToken: claim.leaseToken,
        at: now.toISOString(),
        attentionReason: "The live Tapo device alias or immutable device binding changed after this job was queued",
      });
    }
    return null;
  }

  heartbeat(jobId: string, leaseToken: string): { job: TapoHistoryExportJob; serverNow: string } | null {
    const now = this.#now();
    const current = this.#database.getTapoHistoryExportJob(jobId);
    if (current && !this.targetAliasMatches(current)) {
      this.#database.transitionTapoHistoryExportJob(jobId, {
        status: "needs-attention",
        leaseToken,
        at: now.toISOString(),
        attentionReason: "The live Tapo device alias or immutable device binding changed while automation was running",
      });
      return null;
    }
    const job = this.#database.heartbeatTapoHistoryExportJob(
      jobId, leaseToken, now.toISOString(),
      new Date(now.getTime() + Math.max(5 * 60_000, this.#config.tapoHistoryWorkerLeaseMs ?? 5 * 60_000)).toISOString(),
    );
    return job ? { job, serverNow: now.toISOString() } : null;
  }

  updateFromWorker(jobId: string, leaseToken: string, update: TapoWorkerStatusUpdate): TapoHistoryExportJob | null {
    const now = this.#now();
    const current = this.#database.getTapoHistoryExportJob(jobId);
    if (current && !this.targetAliasMatches(current)) {
      return this.#database.transitionTapoHistoryExportJob(jobId, {
        status: "needs-attention",
        leaseToken,
        at: now.toISOString(),
        attentionReason: "The live Tapo device alias or immutable device binding changed while automation was running",
      });
    }
    return this.#database.transitionTapoHistoryExportJob(jobId, {
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
  }

  retry(jobId: string): TapoHistoryExportJob | null {
    const now = this.#now();
    const current = this.#database.getTapoHistoryExportJob(jobId);
    const leaseFence = current?.leaseExpiresAt
      ? Date.parse(current.leaseExpiresAt) + TAPO_TARGET_RECLAIM_GRACE_MS
      : now.getTime();
    return this.#database.requeueTapoHistoryExportJob(
      jobId,
      new Date(Math.max(now.getTime(), leaseFence)).toISOString(),
      true,
    );
  }

  cancel(jobId: string): TapoHistoryExportJob | null {
    return this.#database.cancelTapoHistoryExportJob(jobId, this.#now().toISOString());
  }

  /** Records an explicit operator-requested historical interval for normal segmented recovery. */
  requestBackfill(sensorId: string, metric: "temperature" | "humidity", from: string, to: string): SensorDataGapRecord {
    if (!this.operational) {
      throw new TapoHistoryCanaryError(
        "TAPO_HISTORY_NOT_CONFIGURED",
        "Tapo history backfill requires a complete app/mailbox or private-adapter configuration",
      );
    }
    const sensor = this.#database.getSensor(sensorId);
    const house = sensor ? this.#database.getHouse(sensor.houseId) : null;
    if (!sensor?.enabled || !house || !hasLocalHouseAuthority(house) || !this.boundDeviceId(sensorId)) {
      throw new TapoHistoryCanaryError(
        "TAPO_BACKFILL_SENSOR_NOT_BOUND",
        "Backfill sensor must be enabled and have an immutable TP-Link device binding",
      );
    }
    const nowDate = this.#now();
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    const intervalMs = (this.#config.tapoHistoryExportIntervalMinutes ?? 15) * 60_000;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs
      || toMs - fromMs < 2 * intervalMs || toMs > nowDate.getTime() + 5 * 60_000
      || fromMs < nowDate.getTime() - 730 * 24 * 60 * 60_000
      || toMs - fromMs > 730 * 24 * 60 * 60_000) {
      throw new TapoHistoryCanaryError(
        "INVALID_TAPO_BACKFILL_RANGE",
        "Backfill must be within the most recent two years, span at least two export intervals, and not end in the future",
      );
    }
    const definition = this.#database.getMeasurementDefinition(metric);
    if (!definition?.enabled) {
      throw new TapoHistoryCanaryError("TAPO_BACKFILL_TARGET_DISABLED", "Backfill metric must be enabled");
    }
    const now = nowDate.toISOString();
    const gap = this.#database.noteHistoricalSensorDataGap(sensorId, metric, "tp-link", from, to, now);
    return this.#database.rearmSensorDataGapRecovery(gap.id, now, true) ?? gap;
  }

  /** Queues an isolated end-to-end acceptance job; its staged rows are never offered to gap recovery. */
  createCanary(sensorId: string, metric: "temperature" | "humidity", from: string, to: string): TapoHistoryExportJob {
    return this.createCanaryJob(sensorId, metric, from, to, false);
  }

  private createCanaryJob(sensorId: string, metric: "temperature" | "humidity", from: string, to: string, automaticRenewal: boolean): TapoHistoryExportJob {
    if (!this.enabled || !this.#config.tapoHistoryExportEmail || !this.#config.tapoHistoryWorkerToken || !this.#mailbox) {
      throw new TapoHistoryCanaryError(
        "TAPO_CANARY_NOT_CONFIGURED",
        "Canary requires enabled Tapo history, export email, worker token, and Gmail OAuth configuration",
      );
    }
    const sensor = this.#database.getSensor(sensorId);
    const deviceId = this.boundDeviceId(sensorId);
    const house = sensor ? this.#database.getHouse(sensor.houseId) : null;
    if (!sensor?.enabled || !house || !hasLocalHouseAuthority(house) || !deviceId) {
      throw new TapoHistoryCanaryError("TAPO_CANARY_SENSOR_NOT_BOUND", "Canary sensor needs an immutable TP-Link device binding");
    }
    if (!["temperature", "humidity"].every(
      (requiredMetric) => this.#database.getMeasurementDefinition(requiredMetric)?.enabled === true,
    )) {
      throw new TapoHistoryCanaryError(
        "TAPO_CANARY_METRIC_DISABLED",
        "Canary requires enabled temperature and humidity measurement definitions",
      );
    }
    const deviceName = this.#options.deviceNameFor?.(sensorId, deviceId)?.trim() ?? "";
    if (!deviceName) {
      throw new TapoHistoryCanaryError(
        "TAPO_CANARY_DEVICE_ALIAS_MISSING",
        "Canary is waiting for one unique live-discovered Tapo device alias",
      );
    }
    return this.enqueue(sensorId, metric, from, to, "appium", deviceName, true, automaticRenewal);
  }

  private enqueue(sensorId: string, metric: string, from: string, to: string, provider: TapoHistoryExportProvider, deviceName: string, canary = false, automaticRenewal = false): TapoHistoryExportJob {
    const sensor = this.#database.getSensor(sensorId);
    const deviceId = this.boundDeviceId(sensorId);
    if (!sensor || !deviceId) throw new Error("TP-Link sensor binding disappeared");
    const house = this.#database.getHouse(sensor.houseId);
    if (!house) throw new Error("TP-Link sensor house disappeared");
    if (!hasLocalHouseAuthority(house)) throw new Error("TP-Link history requires local Home authority");
    const reusable = !canary ? this.findJob(sensorId, deviceId, house.timezone, from, to, [
      "queued", "claimed", "running", "waiting-email", "needs-attention", "completed", "failed", "cancelled",
    ], provider, deviceName, this.#config.tapoHistoryExportIntervalMinutes ?? 15, metric) : null;
    if (reusable) return reusable;
    const intervalMinutes = this.#config.tapoHistoryExportIntervalMinutes ?? 15;
    const id = randomUUID();
    const requestIdentity = [
      provider, sensorId, deviceId, deviceName.normalize("NFKC"), house.timezone, metric, from, to, String(intervalMinutes),
      ...(canary ? [id] : []),
    ].join("\u0000");
    const dedupeKey = `${canary ? (automaticRenewal ? "canary:renewal" : "canary") : "automation"}:${createHash("sha256").update(requestIdentity).digest("hex")}`;
    const existing = this.#database.getTapoHistoryExportJobByDedupeKey(dedupeKey);
    if (existing) return existing;
    const correlationNonce = randomBytes(32).toString("base64url");
    const recipient = this.#config.tapoHistoryExportEmail
      ? tapoExportRecipient(this.#config.tapoHistoryExportEmail, correlationNonce, this.#config.tapoHistoryEmailTagPrefix)
      : null;
    const result = this.#database.enqueueTapoHistoryExportJob({
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
    }, this.#now().toISOString());
    return result.job;
  }

  private findJob(sensorId: string, expectedDeviceId: string, timeZone: string, from: string, to: string, statuses: TapoHistoryExportJobStatus[], provider?: TapoHistoryExportProvider, deviceName?: string, intervalMinutes?: number, metric?: string): TapoHistoryExportJob | null {
    const requestedFrom = Date.parse(from);
    const requestedTo = Date.parse(to);
    return this.#database.listTapoHistoryExportJobs({ sensorId, statuses, ...(provider ? { provider } : {}), limit: 1_000 })
      .find((job) => !job.dedupeKey.startsWith("canary:")
        && Date.parse(job.rangeStart) <= requestedFrom && Date.parse(job.rangeEnd) >= requestedTo
        && job.expectedDeviceId === expectedDeviceId
        && job.timeZone === timeZone
        && (job.provider !== "private-cloud" || metric === undefined || job.metric === metric)
        && (deviceName === undefined || job.deviceName === deviceName)
        && (intervalMinutes === undefined || job.intervalMinutes === intervalMinutes)) ?? null;
  }

  private boundDeviceId(sensorId: string): string | null {
    const direct = this.#database.getSensor(sensorId)?.tpLinkDeviceId?.trim();
    // Automated historical recovery requires a persisted direct binding.
    // Every job snapshots and revalidates this ID; legacy mutable map files are
    // intentionally excluded from the identity boundary.
    return direct || null;
  }

  private acceptanceRevision(): string {
    const mailboxCredentialProof = this.#config.tapoHistoryGmailRefreshToken && this.#config.tapoHistoryWorkerToken
      ? createHmac("sha256", this.#config.tapoHistoryWorkerToken)
        .update(this.#config.tapoHistoryGmailRefreshToken, "utf8").digest("hex")
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
      exportEmail: this.#config.tapoHistoryExportEmail?.trim().toLowerCase() ?? null,
      gmailAccountEmail: this.#config.tapoHistoryGmailAccountEmail?.trim().toLowerCase() ?? null,
      gmailClientId: this.#config.tapoHistoryGmailClientId?.trim() ?? null,
      mailboxCredentialProof,
    })).digest("hex");
  }

  private targetAliasMatches(job: TapoHistoryExportJob): boolean {
    const sensor = this.#database.getSensor(job.sensorId);
    const house = sensor ? this.#database.getHouse(sensor.houseId) : null;
    const definition = this.#database.getMeasurementDefinition(job.metric);
    const canaryDefinitionsEnabled = !job.canary || ["temperature", "humidity"]
      .every((metric) => this.#database.getMeasurementDefinition(metric)?.enabled === true);
    if (job.provider !== "appium" || !sensor || !sensor.enabled || !definition?.enabled
      || !canaryDefinitionsEnabled || !house || !hasLocalHouseAuthority(house)
      || sensor.tpLinkDeviceId?.trim() !== job.expectedDeviceId
      || house.timezone !== job.timeZone
      || job.acceptanceRevision !== this.acceptanceRevision()) return false;
    try {
      return (this.#options.deviceNameFor?.(job.sensorId, job.expectedDeviceId)?.trim() ?? "") === job.deviceName;
    } catch {
      return false;
    }
  }

  private recordMailboxSuccess(at = this.#now().toISOString()): void {
    this.#mailboxHealth.lastSuccessfulPollAt = at;
    this.#mailboxHealth.consecutiveFailures = 0;
    this.#mailboxHealth.lastErrorCode = null;
  }

  private recordMailboxFailure(error: unknown, at = this.#now().toISOString()): void {
    const code = error instanceof GmailSearchBudgetExceeded
      ? "budget_exhausted"
      : error instanceof GmailAuthenticationUnavailable
        ? "oauth_unavailable"
        : error instanceof Error && error.name
          ? error.name.replace(/[^a-z0-9_-]/giu, "_").toLowerCase().slice(0, 80)
          : "unknown_error";
    this.#mailboxHealth.lastErrorAt = at;
    this.#mailboxHealth.lastErrorCode = code;
    this.#mailboxHealth.consecutiveFailures += 1;
    if (error instanceof GmailSearchBudgetExceeded) this.#mailboxHealth.budgetExhaustions += 1;
  }

  private async pollMailbox(): Promise<void> {
    const maintenanceNow = this.#now();
    this.#database.expireExhaustedTapoHistoryExportLeases(
      maintenanceNow.toISOString(),
      new Date(maintenanceNow.getTime() - TAPO_TARGET_RECLAIM_GRACE_MS).toISOString(),
    );
    if (maintenanceNow.getTime() - this.#lastMaintenanceAt >= 24 * 60 * 60_000) {
      this.#database.pruneTapoHistoryExportHistory({
        consumedBefore: new Date(maintenanceNow.getTime() - CONSUMED_STAGE_RETENTION_MS).toISOString(),
        completedBefore: new Date(maintenanceNow.getTime() - EXPORT_JOB_RETENTION_MS).toISOString(),
        canaryBefore: new Date(maintenanceNow.getTime() - CANARY_JOB_RETENTION_MS).toISOString(),
      });
      this.#lastMaintenanceAt = maintenanceNow.getTime();
    }
    if (!this.#mailbox) return;
    const jobs = this.#database.listTapoHistoryExportJobs({ statuses: ["waiting-email"], oldestFirst: true, limit: 100 });
    const pollDeadlineAt = Date.now() + MAX_GMAIL_SEARCH_MS;
    const pollBudget = gmailSearchBudget(pollDeadlineAt);
    for (const job of jobs) {
      if (Date.now() >= pollDeadlineAt) break;
      if (!job.expectedRecipient) continue;
      const now = this.#now();
      const timeoutMs = Math.max(60_000, this.#config.tapoHistoryEmailTimeoutMs ?? 6 * 60 * 60_000);
      if (!job.submittedAt) {
        this.#database.transitionTapoHistoryExportJob(job.id, {
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
        const seen = new Set(this.#database.listTapoHistoryExportJobs({ limit: 1_000 })
          .flatMap((candidate) => candidate.mailboxMessageId ? [candidate.mailboxMessageId] : []));
        const search = await this.#mailbox.findCsv(job.expectedRecipient, seen, job.submittedAt, pollBudget);
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
            const sensor = this.#database.getSensor(job.sensorId);
            if (!sensor || !this.targetAliasMatches(job)) {
              throw new Error("Tapo export job device binding or unique live alias changed");
            }
            const parsed = parseTapoHistoryCsv(attachment.bytes, {
              sensorId: job.sensorId, timeZone: job.timeZone, from: job.from, to: job.to,
            });
            if (!job.canary && parsed.schemaSignature !== job.expectedSchemaSignature) {
              this.#database.revokeTapoHistoryCanaryApprovalsForJobTarget(job.id);
              const canaryEnd = this.#now().getTime() - 5 * 60_000;
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
                const live = this.#options.telemetryReader
                  ? (await this.#options.telemetryReader.measurementHistory({
                    sensorId: job.sensorId,
                    metric: canaryMetric,
                    from: job.from,
                    to: job.to,
                    limit: 20_000,
                  })).records
                  : this.#database.measurementHistory(
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
            const result = this.#database.completeTapoHistoryExportJobWithSamples(
              job.id,
              parsed.samples.map((sample) => stageMeasurement(sample, `gmail:${attachment.messageId}`)),
              {
                mailboxMessageId: attachment.messageId,
                completedAt: this.#now().toISOString(),
                expectedRecipient: job.expectedRecipient,
                expectedSubmittedAt: job.submittedAt,
                sourceArtifactSha256: createHash("sha256").update(attachment.bytes).digest("hex"),
                sourceArtifactBytes: attachment.bytes.byteLength,
                parserVersion: TAPO_HISTORY_CSV_PARSER_VERSION,
                sourceSchemaSignature: parsed.schemaSignature,
              },
            );
            if (job.canary) {
              this.#database.approveTapoHistoryDeploymentFromCanary(
                result.job.id,
                this.acceptanceRevision(),
                this.#now().toISOString(),
              );
            } else {
              this.#database.expediteSensorDataGapRecovery(
                job.sensorId, "tp-link", job.rangeStart, job.rangeEnd, this.#now().toISOString(),
              );
              this.#options.onHistoryReady?.(result.job);
            }
            completed = true;
            break;
          } catch (error) { attachmentError = safeError(error); }
        }
        if (!completed && attachmentError) {
          this.#database.transitionTapoHistoryExportJob(job.id, {
            status: "needs-attention",
            at: this.#now().toISOString(),
            expectedRecipient: job.expectedRecipient,
            expectedSubmittedAt: job.submittedAt,
            attentionReason: attachmentError,
          });
        } else if (!completed && search.rejectedCandidates > 0) {
          this.#database.transitionTapoHistoryExportJob(job.id, {
            status: "needs-attention",
            at: this.#now().toISOString(),
            expectedRecipient: job.expectedRecipient,
            expectedSubmittedAt: job.submittedAt,
            attentionReason: `Correlated Gmail messages contained ${search.rejectedCandidates} invalid or oversized CSV attachment(s)`,
          });
        } else if (!completed && emailDeadlineExpired && search.transientFailures === 0) {
          // A delivery deadline is meaningful only after a healthy Gmail list
          // and message scan. OAuth/network/individual-message failures pause
          // the deadline instead of burning another mobile export attempt.
          this.#database.transitionTapoHistoryExportJob(job.id, {
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
  }
}
