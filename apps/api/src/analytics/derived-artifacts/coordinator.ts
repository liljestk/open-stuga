import { createHash } from "node:crypto";
import type {
  DataMode,
  DurableDerivedAnalyticsKind,
  DurableDerivedAnalyticsResponse,
} from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import type { HybridTelemetryReader } from "../../timeseries/read-facade.js";
import { zonedParts } from "../../daily-analytics-findings.js";
import type { AnalyticsLowPriorityLease, AnalyticsWorkLimiter } from "../work-limiter.js";
import {
  DERIVED_ANALYTICS_ALGORITHM_VERSIONS,
  DerivedAnalyticsComputer,
  derivedIdentity,
} from "./compute.js";
import { DerivedAnalyticsStore } from "./store.js";
import { DerivedAnalyticsDataModeError } from "./types.js";
import type { DerivedResult, StoredDerivedJob } from "./types.js";

const IDLE_POLL_MS = 60_000;
const BETWEEN_JOBS_MS = 30_000;
const STARTUP_GRACE_MS = 2 * 60_000;
const MAX_BACKGROUND_CANDIDATES = 256;

export interface DerivedAnalyticsCoordinatorOptions {
  now?: () => Date;
  compute?: (job: StoredDerivedJob, signal?: AbortSignal) => Promise<DerivedResult>;
  algorithmVersions?: Readonly<Record<DurableDerivedAnalyticsKind, string>>;
  admitLowPriority?: () => boolean | Promise<boolean>;
}

function stableNightMinute(houseId: string): number {
  const digest = createHash("sha256").update(houseId).digest();
  return 90 + digest.readUInt16BE(0) % 180;
}

export class DerivedAnalyticsCoordinator {
  readonly #database: ClimateDatabase;
  readonly #workLimiter: AnalyticsWorkLimiter;
  readonly #store: DerivedAnalyticsStore;
  readonly #now: () => Date;
  readonly #compute: (job: StoredDerivedJob, signal?: AbortSignal) => Promise<DerivedResult>;
  readonly #algorithmVersions: Readonly<Record<DurableDerivedAnalyticsKind, string>>;
  readonly #admitLowPriority: () => boolean | Promise<boolean>;
  readonly #explicitIdentities = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #controller: AbortController | null = null;
  #startupGuardUntil = 0;
  #started = false;
  #running = false;

  constructor(
    database: ClimateDatabase,
    telemetryReader: HybridTelemetryReader,
    workLimiter: AnalyticsWorkLimiter,
    options: DerivedAnalyticsCoordinatorOptions = {},
  ) {
    this.#database = database;
    this.#workLimiter = workLimiter;
    this.#store = new DerivedAnalyticsStore(database.db, (options.now?.() ?? new Date()).toISOString());
    this.#now = options.now ?? (() => new Date());
    const computer = new DerivedAnalyticsComputer(database, telemetryReader);
    this.#compute = options.compute ?? ((job, signal) => computer.compute(job, signal));
    this.#algorithmVersions = options.algorithmVersions ?? DERIVED_ANALYTICS_ALGORITHM_VERSIONS;
    this.#admitLowPriority = options.admitLowPriority ?? (() => true);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    // Appliance startup already has database reconciliation, integrations,
    // and health checks competing for a small CPU. Persisted analytics wait
    // through a fixed grace period; opening/refreshing a panel cannot shorten it.
    this.#startupGuardUntil = Date.now() + STARTUP_GRACE_MS;
    this.#schedule(STARTUP_GRACE_MS);
  }

  async stop(): Promise<void> {
    this.#started = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#controller?.abort(new DOMException("API is shutting down", "AbortError"));
    while (this.#running) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  /** Fence all demo-era work after the database's irreversible real-mode latch. */
  handleDataModeActivated(): void {
    const activeMode = this.#activeDataMode();
    this.#explicitIdentities.clear();
    this.#controller?.abort(new DOMException(
      "Derived analytics data mode changed",
      "AbortError",
    ));
    this.#store.purgeObsoleteDataMode(activeMode);
    this.wake();
  }

  read<Result extends DerivedResult>(input: {
    kind: DurableDerivedAnalyticsKind;
    houseId: string;
    dataMode: DataMode;
    windowDays?: number;
  }): DurableDerivedAnalyticsResponse<Result> {
    this.#assertActiveDataMode(input.dataMode);
    const now = this.#now();
    const identity = derivedIdentity({
      database: this.#database,
      ...input,
      now,
      algorithmVersions: this.#algorithmVersions,
    });
    const current = this.#store.artifactForIdentity(identity.identityKey);
    const latest = current ?? this.#store.latestArtifact(identity);
    const job = this.#store.job(identity.identityKey);
    const artifact = latest;
    const state = job?.status === "running"
      ? "refreshing"
      : job?.status === "failed"
        ? "failed"
        : job?.status === "pending"
          ? "queued"
          : current
          ? "ready"
          : "idle";
    const response: DurableDerivedAnalyticsResponse<Result> = {
      apiVersion: "1.0",
      kind: identity.kind,
      houseId: identity.houseId,
      dataMode: identity.dataMode,
      windowDays: identity.windowDays,
      cutoff: identity.cutoff,
      state,
      stale: artifact === null || artifact.identityKey !== identity.identityKey,
      result: (artifact?.result as Result | undefined) ?? null,
      artifact: artifact ? {
        id: artifact.id,
        generatedAt: artifact.generatedAt,
        cutoff: artifact.cutoff,
        algorithmVersion: artifact.algorithmVersion,
        evidenceVersion: artifact.evidenceVersion,
      } : null,
      job: job ? {
        requestedAt: job.requestedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        nextAttemptAt: job.nextAttemptAt,
        attemptCount: job.attemptCount,
        errorCode: job.errorCode,
        errorMessage: job.errorMessage,
      } : null,
    };
    // A second check also fences a one-way activation performed by another
    // process while this synchronous read assembled its response.
    this.#assertActiveDataMode(input.dataMode);
    return response;
  }

  refresh<Result extends DerivedResult>(input: {
    kind: DurableDerivedAnalyticsKind;
    houseId: string;
    dataMode: DataMode;
    windowDays?: number;
  }): DurableDerivedAnalyticsResponse<Result> {
    this.#assertActiveDataMode(input.dataMode);
    const now = this.#now();
    const identity = derivedIdentity({
      database: this.#database,
      ...input,
      now,
      algorithmVersions: this.#algorithmVersions,
    });
    const job = this.#store.enqueue(identity, now.toISOString(), true);
    this.#explicitIdentities.add(job.identityKey);
    this.wake();
    return this.read<Result>(input);
  }

  wake(): void {
    if (!this.#started || this.#running) return;
    this.#schedule(Math.max(0, this.#startupGuardUntil - Date.now()));
  }

  snapshot(): { pending: number; running: number; artifacts: number } {
    return this.#store.counts();
  }

  /** One claimed job, exposed for deterministic startup and persistence tests. */
  async drainOnce(): Promise<boolean> {
    if (this.#running) return false;
    this.#running = true;
    const controller = new AbortController();
    this.#controller = controller;
    let lease: AnalyticsLowPriorityLease | null = null;
    let job: StoredDerivedJob | null = null;
    try {
      lease = await this.#workLimiter.acquireLowPriority(
        "derived-background",
        this.#admitLowPriority,
        controller.signal,
      );
      if (!lease) return false;
      // Admission may be asynchronous. Never claim durable work through a
      // lease whose signal was canceled while the host gate was evaluating.
      controller.signal.throwIfAborted();
      job = this.#claimNext(this.#now());
      if (!job) return false;
      controller.signal.throwIfAborted();
      this.#assertActiveDataMode(job.dataMode);
      const result = await this.#compute(job, controller.signal);
      // A fitter can resolve after stop() or after a mode-boundary callback.
      // Check cancellation at the last possible point before durable publish.
      controller.signal.throwIfAborted();
      this.#assertActiveDataMode(job.dataMode);
      const generatedAt = this.#now().toISOString();
      this.#store.succeed(job, result, generatedAt);
    } catch (error) {
      if (job && controller.signal.aborted) {
        this.#store.interrupt(job, controller.signal.reason);
      } else if (job) this.#store.fail(job, error, this.#now().toISOString());
      else if (!controller.signal.aborted) throw error;
    } finally {
      if (job) {
        const updated = this.#store.job(job.identityKey);
        if (!updated || updated.status === "succeeded"
          || (updated.status === "failed" && updated.nextAttemptAt === null)) {
          this.#explicitIdentities.delete(job.identityKey);
        }
      }
      await lease?.release();
      if (this.#controller === controller) this.#controller = null;
      this.#running = false;
    }
    return job !== null;
  }

  #schedule(delayMs: number): void {
    if (!this.#started) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#tick();
    }, delayMs);
    this.#timer.unref?.();
  }

  async #tick(): Promise<void> {
    if (!this.#started) return;
    let ran = false;
    try {
      this.#enqueueNightlyWork();
      ran = await this.drainOnce();
    } catch {
      // A transient SQLite/time-zone failure must not silently stop the daily
      // scheduler. The next bounded poll retries; job failures remain durable.
    } finally {
      this.#schedule(ran ? BETWEEN_JOBS_MS : IDLE_POLL_MS);
    }
  }

  #claimNext(now: Date): StoredDerivedJob | null {
    const nowIso = now.toISOString();
    const dataMode = this.#activeDataMode();
    for (const identityKey of this.#explicitIdentities) {
      const current = this.#store.job(identityKey);
      if (!current || current.dataMode !== dataMode || current.status === "succeeded"
        || (current.status === "failed" && current.nextAttemptAt === null)) {
        this.#explicitIdentities.delete(identityKey);
        continue;
      }
      const claimed = this.#store.claimIdentity(identityKey, nowIso, dataMode);
      if (claimed) return claimed;
    }
    const scheduled = this.#store.claimable(nowIso, MAX_BACKGROUND_CANDIDATES, dataMode)
      .find((candidate) => this.#insideBackgroundWindow(candidate, now));
    return scheduled
      ? this.#store.claimIdentity(scheduled.identityKey, nowIso, dataMode)
      : null;
  }

  #insideBackgroundWindow(job: StoredDerivedJob, now: Date): boolean {
    const house = this.#database.getHouse(job.houseId);
    if (!house) return false;
    const local = zonedParts(now.getTime(), house.timezone);
    const minute = local[3] * 60 + local[4];
    return minute >= stableNightMinute(house.id) && minute < 5 * 60;
  }

  #enqueueNightlyWork(): void {
    const now = this.#now();
    const dataMode = this.#activeDataMode();
    for (const house of this.#database.listHouses()) {
      const local = zonedParts(now.getTime(), house.timezone);
      const minute = local[3] * 60 + local[4];
      const scheduled = stableNightMinute(house.id);
      if (minute < scheduled || minute >= 5 * 60) continue;
      for (const kind of [
        "thermal-isolation",
        "moisture-response",
        "home-performance",
      ] as const) {
        const windowDays = kind === "home-performance" ? 30 : 7;
        const identity = derivedIdentity({
          database: this.#database,
          kind,
          houseId: house.id,
          dataMode,
          windowDays,
          now,
          algorithmVersions: this.#algorithmVersions,
        });
        const current = this.#store.latestArtifact(identity);
        if (current?.identityKey === identity.identityKey) continue;
        this.#store.enqueue(identity, now.toISOString());
      }
    }
  }

  #activeDataMode(): DataMode {
    return this.#database.isRealDataMode() ? "live" : "demo";
  }

  #assertActiveDataMode(requestedMode: DataMode): void {
    const activeMode = this.#activeDataMode();
    if (requestedMode !== activeMode) {
      throw new DerivedAnalyticsDataModeError(requestedMode, activeMode);
    }
  }
}
