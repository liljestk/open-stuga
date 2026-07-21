import { assertExpectedExportAddress } from "./address.js";
import { JobApiClient, LeaseLostError } from "./api-client.js";
import type { RunnerConfig } from "./config.js";
import {
  authenticationPlan,
  FlowEngine,
  FlowExecutionError,
  MAX_REPEAT_TAPS,
  type TapoFlowConfig,
} from "./flow.js";
import type { AttentionCode, ExportJob, JobStatusUpdate, RunnerLogger } from "./types.js";
import { AppiumClient, WebDriverError } from "./webdriver.js";

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function status(jobStatus: JobStatusUpdate["status"], detail: string): JobStatusUpdate {
  return { status: jobStatus, detail };
}

/** Server reclaim grace is larger than this maximum accepted Appium request. */
export const MAX_IN_FLIGHT_APPIUM_COMMAND_MS = 120_000;
export const LEASE_COMMAND_SAFETY_MARGIN_MS = MAX_IN_FLIGHT_APPIUM_COMMAND_MS + 5_000;

export class RunnerInfrastructureCircuitError extends Error {
  constructor() {
    super("Appium infrastructure circuit is open; exiting for the service restart policy");
    this.name = "RunnerInfrastructureCircuitError";
  }
}

const JOB_LOCAL_WEBDRIVER_CODES = new Set([
  "no such element",
  "ambiguous element",
  "invalid timezone",
]);

/** Finds infrastructure failures through the Error.cause chain. */
export function infrastructureWebDriverError(error: unknown): WebDriverError | undefined {
  const seen = new Set<unknown>();
  const flowWrapped = error instanceof FlowExecutionError;
  let candidate: unknown = error;
  while (candidate !== undefined && candidate !== null && !seen.has(candidate)) {
    seen.add(candidate);
    if (candidate instanceof WebDriverError) {
      if (JOB_LOCAL_WEBDRIVER_CODES.has(candidate.webdriverCode)) return undefined;
      // A WebDriver timeout inside a selector action is UI outcome. The same
      // code escaping reset/session/preflight is infrastructure failure.
      if (candidate.webdriverCode === "timeout" && flowWrapped) return undefined;
      return candidate;
    }
    candidate = candidate instanceof Error ? candidate.cause : undefined;
  }
  return undefined;
}

/** Fails closed before lease expiry, using a TTL measured by the API clock. */
export class LeaseWatchdog {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly controller: AbortController) {}

  arm(leaseTtlMs: number, safetyMarginMs = LEASE_COMMAND_SAFETY_MARGIN_MS): void {
    this.clear();
    const delayMs = leaseTtlMs - safetyMarginMs;
    if (!Number.isFinite(leaseTtlMs) || !Number.isFinite(safetyMarginMs) || delayMs <= 0) {
      this.controller.abort(new Error("job lease entered the Appium command safety margin"));
      return;
    }
    this.timer = setTimeout(() => {
      this.controller.abort(new Error("job lease entered the Appium command safety margin"));
    }, Math.min(delayMs, 2_147_483_647));
    this.timer.unref();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export function calendarDate(timestamp: string, timeZone: string): string {
  const value = new Date(timestamp);
  if (!Number.isFinite(value.getTime())) throw new Error("Export job contains an invalid date-time range");
  const parts = new Intl.DateTimeFormat("en", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function calendarDateParts(timestamp: string, timeZone: string): { year: string; month: string; day: string } {
  const [year, month, day] = calendarDate(timestamp, timeZone).split("-");
  return { year: year!, month: month!, day: day! };
}

function calendarMonthIndex(timestamp: string, timeZone: string): number {
  const parts = calendarDateParts(timestamp, timeZone);
  return Number(parts.year) * 12 + Number(parts.month) - 1;
}

export function dateNavigationVariables(
  job: Pick<ExportJob, "from" | "to" | "serverNow" | "timeZone">,
): Record<"FROM_MONTHS_BEFORE_CURRENT" | "TO_MONTHS_BEFORE_CURRENT" | "MONTHS_FROM_FROM_TO", string> {
  const current = calendarMonthIndex(job.serverNow, job.timeZone);
  const from = calendarMonthIndex(job.from, job.timeZone);
  const to = calendarMonthIndex(job.to, job.timeZone);
  const distances = {
    FROM_MONTHS_BEFORE_CURRENT: current - from,
    TO_MONTHS_BEFORE_CURRENT: current - to,
    MONTHS_FROM_FROM_TO: to - from,
  };
  for (const [name, value] of Object.entries(distances)) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_REPEAT_TAPS) {
      throw new Error(`${name} is outside the safe 0-${MAX_REPEAT_TAPS} month picker range`);
    }
  }
  return {
    FROM_MONTHS_BEFORE_CURRENT: String(distances.FROM_MONTHS_BEFORE_CURRENT),
    TO_MONTHS_BEFORE_CURRENT: String(distances.TO_MONTHS_BEFORE_CURRENT),
    MONTHS_FROM_FROM_TO: String(distances.MONTHS_FROM_FROM_TO),
  };
}

export class TapoExportWorker {
  private readonly flow: FlowEngine;
  private authenticationCircuitOpen = false;
  private infrastructureCircuitOpen = false;
  private sharedFlowCircuitOpen = false;

  constructor(
    private readonly config: RunnerConfig,
    private readonly api: JobApiClient,
    private readonly appium: AppiumClient,
    private readonly flowConfig: TapoFlowConfig,
    private readonly logger: RunnerLogger,
  ) {
    this.flow = new FlowEngine(appium, flowConfig, config.defaultActionTimeoutMs);
  }

  async run(signal: AbortSignal): Promise<void> {
    this.logger.info("Tapo export worker started", {
      workerId: this.config.workerId,
      workerLabel: this.config.workerLabel,
      deploymentFingerprint: this.config.deploymentFingerprint,
    });
    await this.appium.pruneArtifacts(this.config.artifactRetentionMs).catch((error) => {
      this.logger.warn("Unable to prune expired Appium diagnostics", { error: this.publicError(error) });
    });
    while (!signal.aborted && !this.anyCircuitOpen()) {
      // Appium health/version is checked before the queue is touched. An
      // unavailable target therefore consumes no job attempt or lease.
      try {
        await this.appium.assertSensitiveInputSupported(signal);
        await this.appium.assertTargetSessionStateSafe(signal);
      } catch (error) {
        if (signal.aborted) break;
        this.openInfrastructureCircuit("Appium preflight failed", error);
        break;
      }
      try {
        const job = await this.api.claim();
        if (job) {
          // Deliberately awaited: a worker never drives two app flows concurrently.
          await this.processJob(job, signal);
          await this.appium.pruneArtifacts(this.config.artifactRetentionMs).catch(() => undefined);
          if (this.anyCircuitOpen()) break;
          continue;
        }
      } catch (error) {
        if (signal.aborted) break;
        this.logger.error("Unable to claim Tapo export job", { error: this.publicError(error) });
      }
      try {
        await delay(this.config.pollIntervalMs, signal);
      } catch {
        break;
      }
    }
    this.logger.info("Tapo export worker stopped", { workerId: this.config.workerId });
    if (this.infrastructureCircuitOpen && !signal.aborted) {
      // Docker uses restart:on-failure. A non-zero process exit lets a repaired
      // Appium/device target recover automatically, while the next process
      // still preflights before it can claim anything.
      throw new RunnerInfrastructureCircuitError();
    }
  }

  private async processJob(job: ExportJob, runnerSignal: AbortSignal): Promise<void> {
    const leaseAbort = new AbortController();
    const leaseWatchdog = new LeaseWatchdog(leaseAbort);
    leaseWatchdog.arm(job.leaseTtlMs);
    const jobSignal = AbortSignal.any([runnerSignal, leaseAbort.signal]);
    let heartbeat: Promise<void> | undefined;
    this.logger.info("Claimed Tapo export job", {
      jobId: job.id,
      deviceId: job.deviceId,
      attemptCount: job.attemptCount,
      leaseExpiresAt: job.leaseExpiresAt,
    });

    try {
      await this.api.updateStatus(job, status("running", "Android export automation started"), jobSignal);
      jobSignal.throwIfAborted();
      heartbeat = this.heartbeatLoop(job, jobSignal, leaseAbort, leaseWatchdog);
      let exportEmail: string;
      try {
        exportEmail = assertExpectedExportAddress(this.config.exportEmail, job.expectedRecipient);
      } catch {
        this.openSharedFlowCircuit("configuration_error", undefined, "API and runner export mailboxes differ");
        await this.attention(
          job,
          "configuration_error",
          "The job recipient is not a plus-address alias of the configured export mailbox",
          "invalid-recipient",
          jobSignal,
        );
        return;
      }
      const deviceProof = this.flowConfig.deviceProofs[job.deviceId]?.trim();
      if (!deviceProof) {
        await this.attention(
          job,
          "configuration_error",
          "No immutable on-screen device proof is configured for this Tapo device id",
          "missing-device-proof",
          jobSignal,
        );
        return;
      }
      // Validate all server-derived dates/counts before mutating Appium or the
      // Tapo app. Unsafe ranges fail without touching the target.
      const variables = this.variables(job, exportEmail, deviceProof);
      // Every attempt begins from a fresh Appium session. Combined with the
      // API reclaim grace, this drains any prior target queue before new input.
      await this.appium.resetSession(jobSignal);
      await this.appium.ensureSession(jobSignal, job.timeZone);
      if (this.flowConfig.restartAppBeforeJob) {
        await this.appium.terminateApp(this.flowConfig.appPackage, jobSignal);
      }
      await this.appium.activateApp(this.flowConfig.appPackage, jobSignal);
      if (this.flowConfig.flows.prepare) {
        await this.flow.execute(this.flowConfig.flows.prepare, variables, jobSignal);
      }

      const initialState = await this.flow.detectUiState(jobSignal);
      const canAutoLogin = Boolean(
        this.config.tapoUsername &&
        this.config.tapoPassword &&
        this.config.appiumLogsHardened &&
        this.flowConfig.flows.login &&
        this.flowConfig.flows.login.length > 0,
      );
      const plan = authenticationPlan(initialState, canAutoLogin);
      if (plan === "needs_two_factor") {
        this.openAuthenticationCircuit("Tapo is waiting for account verification");
        await this.attention(job, "two_factor_required", "Tapo is waiting for account verification", "two-factor", jobSignal);
        return;
      }
      if (plan === "needs_login") {
        this.openAuthenticationCircuit("Tapo login is required but unattended login is not configured");
        await this.attention(job, "login_required", "Tapo login is required and automatic login is not fully configured", "login", jobSignal);
        return;
      }
      if (plan === "needs_ui_review") {
        this.openAuthenticationCircuit("Tapo authentication state could not be established");
        await this.attention(job, "ui_drift", "The configured Tapo UI signals do not match the current screen", "unknown-ui", jobSignal);
        return;
      }
      if (plan === "auto_login") {
        try {
          await this.flow.execute(this.flowConfig.flows.login ?? [], variables, jobSignal);
        } catch (error) {
          this.openAuthenticationCircuit("Automatic Tapo login flow failed");
          throw error;
        }
        const afterLogin = await this.flow.detectUiState(jobSignal);
        if (afterLogin === "two_factor") {
          this.openAuthenticationCircuit("Tapo requested account verification after automatic login");
          await this.attention(job, "two_factor_required", "Tapo requested account verification after login", "two-factor", jobSignal);
          return;
        }
        if (afterLogin !== "authenticated") {
          this.openAuthenticationCircuit("Automatic Tapo login did not establish an authenticated session");
          await this.attention(job, "ui_drift", "Automatic login did not reach the configured authenticated screen", "login-result", jobSignal);
          return;
        }
      }

      await this.flow.execute(this.flowConfig.flows.export, variables, jobSignal);
      const completed = status("waiting-email", "Tapo accepted the historical export request");
      await this.api.updateStatus(job, completed, jobSignal);
      this.logger.info("Tapo export request submitted", { jobId: job.id, deviceId: job.deviceId });
    } catch (error) {
      if (error instanceof LeaseLostError || leaseAbort.signal.aborted) {
        this.logger.warn("Stopped work after losing the job lease", { jobId: job.id });
        return;
      }
      if (runnerSignal.aborted) {
        this.logger.warn("Worker shutdown interrupted a job; its lease will expire", { jobId: job.id });
        return;
      }
      const infrastructure = infrastructureWebDriverError(error);
      if (infrastructure) {
        this.openInfrastructureCircuit("Claimed job encountered an Appium infrastructure failure", infrastructure);
      }
      if (error instanceof FlowExecutionError
        && (error.failureCode === "ui_drift" || error.failureCode === "configuration_error")) {
        this.openSharedFlowCircuit(error.failureCode, error.actionIndex);
      }
      await this.reportFailure(job, error, jobSignal);
    } finally {
      leaseWatchdog.clear();
      leaseAbort.abort(new Error("job finished"));
      if (heartbeat) await heartbeat.catch(() => undefined);
    }
  }

  private async heartbeatLoop(
    job: ExportJob,
    signal: AbortSignal,
    leaseAbort: AbortController,
    leaseWatchdog: LeaseWatchdog,
  ): Promise<void> {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        await delay(this.config.heartbeatIntervalMs, signal);
        const renewed = await this.api.heartbeat(job, signal);
        job.leaseExpiresAt = renewed.leaseExpiresAt;
        job.leaseTtlMs = renewed.leaseTtlMs;
        leaseWatchdog.arm(renewed.leaseTtlMs);
        consecutiveFailures = 0;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof LeaseLostError) {
          leaseAbort.abort(error);
          return;
        }
        consecutiveFailures += 1;
        this.logger.warn("Tapo export job heartbeat failed", {
          jobId: job.id,
          consecutiveFailures,
          error: this.publicError(error),
        });
        if (consecutiveFailures >= 3) {
          leaseAbort.abort(new Error("heartbeat failed three times"));
          return;
        }
      }
    }
  }

  private variables(job: ExportJob, exportEmail: string, deviceProof: string): Record<string, string> {
    const intervalLabel = this.flowConfig.intervalLabels[String(job.intervalMinutes)];
    if (!intervalLabel) throw new Error(`Flow has no pinned-locale label for ${job.intervalMinutes} minutes`);
    const from = calendarDateParts(job.from, job.timeZone);
    const to = calendarDateParts(job.to, job.timeZone);
    return {
      JOB_ID: job.id,
      DEVICE_ID: job.deviceId,
      DEVICE_NAME: job.deviceName,
      DEVICE_PROOF: deviceProof,
      FROM_ISO: job.from,
      TO_ISO: job.to,
      FROM_DATE: calendarDate(job.from, job.timeZone),
      TO_DATE: calendarDate(job.to, job.timeZone),
      FROM_YEAR: from.year,
      FROM_MONTH: from.month,
      FROM_DAY: from.day,
      TO_YEAR: to.year,
      TO_MONTH: to.month,
      TO_DAY: to.day,
      ...dateNavigationVariables(job),
      TIME_ZONE: job.timeZone,
      INTERVAL_MINUTES: String(job.intervalMinutes),
      INTERVAL_LABEL: intervalLabel,
      EXPORT_EMAIL: exportEmail,
      TAPO_USERNAME: this.config.tapoUsername ?? "",
      TAPO_PASSWORD: this.config.tapoPassword ?? "",
    };
  }

  private async attention(
    job: ExportJob,
    code: AttentionCode,
    message: string,
    artifactLabel: string,
    signal: AbortSignal,
  ): Promise<void> {
    const artifactPath = await this.saveDiagnostic(`${job.id}-${artifactLabel}`, signal);
    const diagnostic = artifactPath ? `; screenshot=${artifactPath}` : "";
    const update = status("needs-attention", `${code}: ${message}${diagnostic}`);
    await this.api.updateStatus(job, update, signal);
    this.logger.warn("Tapo export job needs attention", { jobId: job.id, code, artifactPath });
  }

  private async reportFailure(job: ExportJob, error: unknown, signal: AbortSignal): Promise<void> {
    if (error instanceof FlowExecutionError) {
      await this.attention(
        job,
        error.failureCode,
        `Configured Tapo flow failed at action ${error.actionIndex + 1}`,
        `flow-${error.actionIndex + 1}`,
        signal,
      );
      return;
    }

    const code = error instanceof WebDriverError && error.webdriverCode === "appium unavailable"
      ? "appium_unavailable"
      : "automation_failed";
    const update = status("failed", `${code}: Tapo export automation failed before the request was confirmed`);
    try {
      await this.api.updateStatus(job, update, signal);
    } catch (statusError) {
      this.logger.error("Could not report Tapo export job failure", {
        jobId: job.id,
        error: this.publicError(statusError),
      });
    }
    this.logger.error("Tapo export automation failed", { jobId: job.id, error: this.publicError(error) });
  }

  private async saveDiagnostic(label: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      return await this.appium.saveScreenshot(label, signal);
    } catch (error) {
      const infrastructure = infrastructureWebDriverError(error);
      if (infrastructure) {
        this.openInfrastructureCircuit("Appium diagnostic command failed", infrastructure);
      }
      this.logger.warn("Unable to save Appium diagnostic screenshot", { error: this.publicError(error) });
      return undefined;
    }
  }

  private openAuthenticationCircuit(reason: string): void {
    if (this.authenticationCircuitOpen) return;
    this.authenticationCircuitOpen = true;
    this.logger.error("Tapo authentication circuit opened; claims are paused until the runner is restarted", { reason });
  }

  private openInfrastructureCircuit(reason: string, error: unknown): void {
    if (this.infrastructureCircuitOpen) return;
    this.infrastructureCircuitOpen = true;
    this.logger.error("Appium infrastructure circuit opened; claims are paused until the runner is restarted", {
      reason,
      error: this.publicError(error),
    });
  }

  private openSharedFlowCircuit(
    code: "ui_drift" | "configuration_error",
    actionIndex?: number,
    reason?: string,
  ): void {
    if (this.sharedFlowCircuitOpen) return;
    this.sharedFlowCircuitOpen = true;
    this.logger.error("Tapo shared-flow circuit opened; claims are paused until the runner is restarted", {
      code,
      ...(actionIndex === undefined ? {} : { action: actionIndex + 1 }),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  private anyCircuitOpen(): boolean {
    return this.authenticationCircuitOpen || this.infrastructureCircuitOpen || this.sharedFlowCircuitOpen;
  }

  private publicError(error: unknown): string {
    let message = error instanceof Error ? error.message : "unknown error";
    for (const sensitive of [this.config.tapoUsername, this.config.tapoPassword, this.config.apiToken]) {
      if (sensitive) message = message.replaceAll(sensitive, "[redacted]");
    }
    return message.slice(0, 500);
  }
}
