import type { EngineHost } from "./engine-host.js";
import type { SpatialLayerStateStore } from "./state-store.js";
import type { SpatialInferenceJob } from "./state-store.js";
import type { SpatialDataPartition, SpatialInferenceSession, SpatialScope } from "./types.js";

export interface SpatialSchedulerLogger {
  warn?(fields: Record<string, unknown>, message: string): void;
}

function retryAt(attempts: number, now: Date): string {
  const delayMs = Math.min(5 * 60_000, 2 ** Math.min(8, attempts) * 1_000);
  return new Date(now.getTime() + delayMs).toISOString();
}

export interface SpatialInferenceAdmissionLease {
  release(): void | Promise<void>;
}

export interface SpatialInferenceAdmission {
  acquire(input: {
    job: SpatialInferenceJob;
    session: SpatialInferenceSession;
    now: string;
  }): Promise<SpatialInferenceAdmissionLease | null>;
}

const LOCAL_ADMISSION: SpatialInferenceAdmission = {
  async acquire() {
    return { release(): void {} };
  },
};

export class SpatialLayerScheduler {
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking: Promise<void> | null = null;
  #closed = false;
  readonly #initializedPartitions = new Set<string>();
  readonly #partitionScopes = new Map<string, SpatialScope[]>();

  constructor(readonly dependencies: {
    host: EngineHost;
    state: SpatialLayerStateStore;
    intervalMs?: number;
    maximumAttempts?: number;
    retentionDays?: number;
    admission?: SpatialInferenceAdmission;
    admissionRetryMs?: number;
    now?: () => Date;
    logger?: SpatialSchedulerLogger;
  }) {}

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  initialize(): SpatialScope[] {
    const now = this.now().toISOString();
    const partition = this.dependencies.host.partition;
    const partitionKey = `${partition.sourceDbId}:${partition.dataMode}`;
    if (this.#initializedPartitions.has(partitionKey)) {
      return (this.#partitionScopes.get(partitionKey) ?? []).map((scope) => ({ ...scope }));
    }
    const scopes = this.dependencies.host.ensureAllScopeDefaults(now);
    // Pre-session releases created ambient Home and Property work. It is
    // derived and safe to supersede; never let it spring back to life after
    // an upgrade.
    this.dependencies.state.cancelLegacyOutstandingJobs(partition, now);
    this.dependencies.state.recoverInterruptedSessionJobs(partition, now);
    this.#initializedPartitions.add(partitionKey);
    this.#partitionScopes.set(partitionKey, scopes.map((scope) => ({ ...scope })));
    for (const session of this.dependencies.state.expireInferenceSessions(partition, now)) {
      this.dependencies.host.cancelScope({ kind: "house", id: session.houseId });
    }
    return scopes;
  }

  enqueueScope(scope: SpatialScope, _observedAt: string, _reason = "measurement", _allowReopen = true): void {
    if (this.#closed || scope.kind !== "house") return;
    // The durable cadence timer owns all scheduling. Measurement and topology
    // notifications intentionally do no database work, and Property fan-out
    // is gone. The next session cadence consumes the newest retained inputs.
  }

  wakeHouse(houseId: string, _propertyId: string | null, observedAt: string, reason = "measurement"): void {
    this.enqueueScope({ kind: "house", id: houseId }, observedAt, reason, true);
  }

  startHouseSession(input: {
    houseId: string;
    durationMinutes?: number;
    cadenceMinutes?: number;
    createdBy?: string | null;
  }): SpatialInferenceSession {
    if (this.#closed) throw new Error("Spatial layer scheduler is closed");
    const now = this.now().toISOString();
    this.dependencies.host.ensureScopeDefaults({ kind: "house", id: input.houseId }, now);
    const session = this.dependencies.state.startInferenceSession({
      partition: this.dependencies.host.partition,
      houseId: input.houseId,
      ...(input.durationMinutes === undefined ? {} : { durationMinutes: input.durationMinutes }),
      ...(input.cadenceMinutes === undefined ? {} : { cadenceMinutes: input.cadenceMinutes }),
      ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
      now,
    });
    this.dependencies.state.scheduleDueInferenceSessions(this.dependencies.host.partition, now, 1, input.houseId);
    return this.dependencies.state.getInferenceSession(this.dependencies.host.partition, session.id)!;
  }

  stopHouseSession(houseId: string): SpatialInferenceSession | null {
    const stopped = this.dependencies.state.stopInferenceSession(
      this.dependencies.host.partition,
      houseId,
      this.now().toISOString(),
    );
    if (stopped) this.dependencies.host.cancelScope({ kind: "house", id: houseId });
    return stopped;
  }

  houseSession(houseId: string): SpatialInferenceSession | null {
    const now = this.now().toISOString();
    for (const session of this.dependencies.state.expireInferenceSessions(this.dependencies.host.partition, now)) {
      this.dependencies.host.cancelScope({ kind: "house", id: session.houseId });
    }
    return this.dependencies.state.latestInferenceSession(this.dependencies.host.partition, houseId);
  }

  /** Explicit low-priority maintenance hook; never runs on the API timer. */
  purgeOperationalHistory(): { snapshots: number; runs: number; jobs: number } {
    const retentionDays = Math.max(1, Math.round(this.dependencies.retentionDays ?? 30));
    return this.dependencies.state.purgeOperationalHistoryBefore(
      this.dependencies.host.partition,
      new Date(this.now().getTime() - retentionDays * 86_400_000).toISOString(),
    );
  }

  async tick(): Promise<void> {
    if (this.#closed) return;
    if (this.#ticking) return this.#ticking;
    this.#ticking = this.runTick().finally(() => { this.#ticking = null; });
    return this.#ticking;
  }

  private async runTick(): Promise<void> {
    this.initialize();
    const partition = this.dependencies.host.partition;
    const now = this.now().toISOString();
    let hasActiveSessions = this.dependencies.state.hasActiveInferenceSessions(partition);
    if (hasActiveSessions) {
      for (const session of this.dependencies.state.expireInferenceSessions(partition, now)) {
        this.dependencies.host.cancelScope({ kind: "house", id: session.houseId });
      }
      hasActiveSessions = this.dependencies.state.hasActiveInferenceSessions(partition);
      if (hasActiveSessions) this.dependencies.state.scheduleDueInferenceSessions(partition, now, 10);
    }
    // One scheduler-owned inference at a time is the safe local default. A
    // shared host governor can additionally withhold the admission lease.
    const jobs = hasActiveSessions
      ? this.dependencies.state.claimDueJobs(partition, this.now().toISOString(), 1)
      : [];
    for (const job of jobs) {
      if (!job.lockToken) continue;
      const session = job.sessionId ? this.dependencies.state.getInferenceSession(partition, job.sessionId) : null;
      if (!session || session.status !== "active" || session.houseId !== job.scope.id
          || Date.parse(session.expiresAt) <= this.now().getTime()) {
        if (job.sessionId) this.dependencies.state.cancelOutstandingJobsForSession(partition, job.sessionId, this.now().toISOString());
        else this.dependencies.state.cancelLegacyOutstandingJobs(partition, this.now().toISOString());
        continue;
      }
      let lease: SpatialInferenceAdmissionLease | null = null;
      try {
        lease = await (this.dependencies.admission ?? LOCAL_ADMISSION).acquire({
          job,
          session,
          now: this.now().toISOString(),
        });
      } catch (error) {
        this.dependencies.logger?.warn?.({
          scopeKind: job.scope.kind,
          scopeId: job.scope.id,
          error: error instanceof Error ? error.message : "Unknown admission error",
        }, "Spatial inference admission check failed");
      }
      if (!lease) {
        this.dependencies.state.deferJob(
          partition,
          job.id,
          job.lockToken,
          new Date(this.now().getTime() + Math.max(1_000, this.dependencies.admissionRetryMs ?? 15_000)).toISOString(),
          this.now().toISOString(),
        );
        continue;
      }
      let expiryTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        const admittedSession = job.sessionId ? this.dependencies.state.getInferenceSession(partition, job.sessionId) : null;
        expiryTimer = setTimeout(
          () => this.dependencies.host.cancelScope(job.scope),
          Math.max(0, Date.parse(admittedSession?.expiresAt ?? session.expiresAt) - this.now().getTime()),
        );
        expiryTimer.unref();
        if (!admittedSession || admittedSession.status !== "active"
            || Date.parse(admittedSession.expiresAt) <= this.now().getTime()) {
          if (job.sessionId) {
            this.dependencies.state.cancelOutstandingJobsForSession(partition, job.sessionId, this.now().toISOString());
          }
          continue;
        }
        // A mode activation cancels old jobs. Never run the old partition under the new host.
        const active = this.dependencies.host.partition;
        if (active.sourceDbId !== job.partition.sourceDbId || active.dataMode !== job.partition.dataMode) continue;
        const report = await this.dependencies.host.inferScope(job.scope, job.bucketAt);
        if (report.status === "failed") throw new Error(report.failures.map((failure) => `${failure.engineId}:${failure.code}`).join(", "));
        this.dependencies.state.completeJob(job.partition, job.id, job.lockToken, this.now().toISOString());
        this.dependencies.state.putCheckpoint(job.partition, job.scope, "watermark", {
          bucketAt: job.bucketAt,
          completedAt: this.now().toISOString(),
        }, this.now().toISOString());
      } catch (error) {
        const currentJob = this.dependencies.state.getJob(partition, job.id);
        const currentSession = job.sessionId ? this.dependencies.state.getInferenceSession(partition, job.sessionId) : null;
        if (currentSession?.status === "active" && Date.parse(currentSession.expiresAt) <= this.now().getTime()) {
          for (const expired of this.dependencies.state.expireInferenceSessions(partition, this.now().toISOString())) {
            this.dependencies.host.cancelScope({ kind: "house", id: expired.houseId });
          }
        }
        if (currentJob?.status === "cancelled" || currentSession?.status !== "active"
            || Date.parse(currentSession.expiresAt) <= this.now().getTime()) continue;
        const message = error instanceof Error ? error.message : "Unknown scheduler error";
        this.dependencies.state.failJob(
          job.partition,
          job.id,
          job.lockToken,
          message,
          retryAt(job.attempts, this.now()),
          this.dependencies.maximumAttempts ?? 5,
        );
        this.dependencies.logger?.warn?.({
          scopeKind: job.scope.kind,
          scopeId: job.scope.id,
          dataMode: job.partition.dataMode,
          attempts: job.attempts,
        }, "Spatial inference job failed");
      } finally {
        if (expiryTimer) clearTimeout(expiryTimer);
        try {
          await lease.release();
        } catch (error) {
          this.dependencies.logger?.warn?.({
            scopeKind: job.scope.kind,
            scopeId: job.scope.id,
            error: error instanceof Error ? error.message : "Unknown admission release error",
          }, "Spatial inference admission lease release failed");
        }
      }
    }
  }

  start(): void {
    if (this.#closed || this.#timer) return;
    this.initialize();
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), Math.max(250, this.dependencies.intervalMs ?? 2_000));
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#ticking;
  }

  handleDataModeActivated(_partition: SpatialDataPartition): void {
    // Sessions are partitioned with their telemetry source. Activating real
    // data never carries an old demo session or its derived jobs across.
    this.initialize();
    void this.tick();
  }
}
