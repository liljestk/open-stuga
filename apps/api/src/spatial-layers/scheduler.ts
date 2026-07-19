import type { EngineHost } from "./engine-host.js";
import type { SpatialLayerStateStore } from "./state-store.js";
import type { SpatialDataPartition, SpatialScope } from "./types.js";

export interface SpatialSchedulerLogger {
  warn?(fields: Record<string, unknown>, message: string): void;
}

function bucketBoundary(timestamp: string, bucketSeconds: number): string {
  const epoch = Date.parse(timestamp);
  if (!Number.isFinite(epoch)) throw new TypeError("timestamp must be an ISO timestamp");
  return new Date(Math.ceil(epoch / (bucketSeconds * 1_000)) * bucketSeconds * 1_000).toISOString();
}

function retryAt(attempts: number): string {
  const delayMs = Math.min(5 * 60_000, 2 ** Math.min(8, attempts) * 1_000);
  return new Date(Date.now() + delayMs).toISOString();
}

export class SpatialLayerScheduler {
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking: Promise<void> | null = null;
  #closed = false;
  #lastPurgeAt = 0;

  constructor(readonly dependencies: {
    host: EngineHost;
    state: SpatialLayerStateStore;
    bucketSeconds?: 30 | 60;
    debounceMs?: number;
    intervalMs?: number;
    maximumBackfillMinutes?: number;
    maximumAttempts?: number;
    retentionDays?: number;
    now?: () => Date;
    logger?: SpatialSchedulerLogger;
  }) {}

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  initialize(): SpatialScope[] {
    const now = this.now().toISOString();
    const scopes = this.dependencies.host.ensureAllScopeDefaults(now);
    for (const scope of scopes) {
      const initialized = this.dependencies.state.getCheckpoint<boolean>(this.dependencies.host.partition, scope, "initial-inference-scheduled");
      if (initialized) continue;
      this.enqueueScope(scope, now, "initial", false);
      this.dependencies.state.putCheckpoint(this.dependencies.host.partition, scope, "initial-inference-scheduled", true, now);
    }
    return scopes;
  }

  enqueueScope(scope: SpatialScope, observedAt: string, reason = "measurement", allowReopen = true): void {
    if (this.#closed) return;
    const bucketAt = bucketBoundary(observedAt, this.dependencies.bucketSeconds ?? 60);
    const ageMinutes = (this.now().getTime() - Date.parse(bucketAt)) / 60_000;
    if (allowReopen && ageMinutes > (this.dependencies.maximumBackfillMinutes ?? 120)) return;
    const availableAt = new Date(Math.max(
      Date.parse(bucketAt),
      this.now().getTime() + (this.dependencies.debounceMs ?? 1_500),
    )).toISOString();
    this.dependencies.state.scheduleJob({
      partition: this.dependencies.host.partition,
      scope,
      bucketAt,
      reason,
      availableAt,
      allowReopen,
      now: this.now().toISOString(),
    });
  }

  wakeHouse(houseId: string, propertyId: string | null, observedAt: string, reason = "measurement"): void {
    this.enqueueScope({ kind: "house", id: houseId }, observedAt, reason, true);
    if (propertyId) this.enqueueScope({ kind: "property", id: propertyId }, observedAt, reason, true);
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
    if (this.now().getTime() - this.#lastPurgeAt >= 24 * 60 * 60_000) {
      const retentionDays = Math.max(1, Math.round(this.dependencies.retentionDays ?? 30));
      this.dependencies.state.purgeOperationalHistoryBefore(
        partition,
        new Date(this.now().getTime() - retentionDays * 86_400_000).toISOString(),
      );
      this.#lastPurgeAt = this.now().getTime();
    }
    const jobs = this.dependencies.state.claimDueJobs(partition, this.now().toISOString(), 10);
    for (const job of jobs) {
      if (!job.lockToken) continue;
      try {
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
        const message = error instanceof Error ? error.message : "Unknown scheduler error";
        this.dependencies.state.failJob(job.partition, job.id, job.lockToken, message, retryAt(job.attempts), this.dependencies.maximumAttempts ?? 5);
        this.dependencies.logger?.warn?.({
          scopeKind: job.scope.kind,
          scopeId: job.scope.id,
          dataMode: job.partition.dataMode,
          attempts: job.attempts,
        }, "Spatial inference job failed");
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
    // Host owns the active partition. A new checkpoint namespace causes fresh
    // initial jobs to be scheduled without exposing old demo jobs or snapshots.
    this.initialize();
    void this.tick();
  }
}
