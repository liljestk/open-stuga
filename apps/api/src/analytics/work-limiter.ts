import type { CacheStats } from "../cache.js";

export class AnalyticsCapacityError extends Error {
  readonly code = "ANALYTICS_BUSY";
  readonly retryAfterSeconds = 1;

  constructor() {
    super("Analytics capacity is temporarily full; retry shortly");
    this.name = "AnalyticsCapacityError";
  }
}

interface MutableOperationStats {
  active: number;
  queued: number;
  started: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  rejected: number;
  totalQueueMs: number;
  maxQueueMs: number;
  totalRunMs: number;
  maxRunMs: number;
}

export interface AnalyticsOperationStats {
  active: number;
  queued: number;
  started: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  rejected: number;
  averageQueueMs: number;
  maxQueueMs: number;
  averageRunMs: number;
  maxRunMs: number;
}

export interface AnalyticsCoordinatorStats {
  active: number;
  queued: number;
  maxConcurrent: number;
  maxQueued: number;
  operations: Record<string, AnalyticsOperationStats>;
  caches: Record<string, CacheStats>;
}

interface QueueItem<T> {
  operation: string;
  enqueuedAt: number;
  task: () => Promise<T> | T;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  cancelled: boolean;
  started: boolean;
}

function emptyStats(): MutableOperationStats {
  return {
    active: 0,
    queued: 0,
    started: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    rejected: 0,
    totalQueueMs: 0,
    maxQueueMs: 0,
    totalRunMs: 0,
    maxRunMs: 0,
  };
}

function abortReason(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

/**
 * One process-wide admission boundary for CPU/database-heavy request work.
 * It deliberately bounds both active work and the waiting queue so load sheds
 * predictably instead of consuming every PostgreSQL connection and heap slot.
 */
export class AnalyticsWorkLimiter {
  readonly #maxConcurrent: number;
  readonly #maxQueued: number;
  readonly #now: () => number;
  readonly #queue: Array<QueueItem<unknown>> = [];
  readonly #operations = new Map<string, MutableOperationStats>();
  readonly #caches = new Map<string, () => CacheStats>();
  #active = 0;
  #queued = 0;

  constructor(options: {
    maxConcurrent?: number;
    maxQueued?: number;
    now?: () => number;
  } = {}) {
    this.#maxConcurrent = this.#positiveInteger(options.maxConcurrent ?? 2, "maxConcurrent");
    this.#maxQueued = this.#positiveInteger(options.maxQueued ?? 32, "maxQueued");
    this.#now = options.now ?? Date.now;
  }

  run<T>(
    operation: string,
    task: () => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!operation.trim()) throw new RangeError("operation is required");
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const stats = this.#statsFor(operation);
    if (this.#active >= this.#maxConcurrent && this.#queued >= this.#maxQueued) {
      stats.rejected += 1;
      return Promise.reject(new AnalyticsCapacityError());
    }

    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = {
        operation,
        enqueuedAt: this.#readClock(),
        task,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        cancelled: false,
        started: false,
      };
      if (signal) {
        item.abortListener = () => {
          if (item.started || item.cancelled) return;
          item.cancelled = true;
          this.#queued -= 1;
          stats.queued -= 1;
          stats.cancelled += 1;
          const queueIndex = this.#queue.indexOf(item as QueueItem<unknown>);
          if (queueIndex >= 0) this.#queue.splice(queueIndex, 1);
          reject(abortReason(signal));
          this.#drain();
        };
        signal.addEventListener("abort", item.abortListener, { once: true });
      }
      this.#queue.push(item as QueueItem<unknown>);
      this.#queued += 1;
      stats.queued += 1;
      this.#drain();
    });
  }

  registerCache(name: string, stats: () => CacheStats): () => void {
    if (!name.trim()) throw new RangeError("cache name is required");
    this.#caches.set(name, stats);
    return () => {
      if (this.#caches.get(name) === stats) this.#caches.delete(name);
    };
  }

  snapshot(): AnalyticsCoordinatorStats {
    return {
      active: this.#active,
      queued: this.#queued,
      maxConcurrent: this.#maxConcurrent,
      maxQueued: this.#maxQueued,
      operations: Object.fromEntries([...this.#operations.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, stats]) => [name, {
          active: stats.active,
          queued: stats.queued,
          started: stats.started,
          succeeded: stats.succeeded,
          failed: stats.failed,
          cancelled: stats.cancelled,
          rejected: stats.rejected,
          averageQueueMs: stats.started === 0 ? 0 : stats.totalQueueMs / stats.started,
          maxQueueMs: stats.maxQueueMs,
          averageRunMs: stats.succeeded + stats.failed === 0
            ? 0
            : stats.totalRunMs / (stats.succeeded + stats.failed),
          maxRunMs: stats.maxRunMs,
        }])),
      caches: Object.fromEntries([...this.#caches.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, stats]) => [name, stats()])),
    };
  }

  #drain(): void {
    while (this.#active < this.#maxConcurrent && this.#queue.length > 0) {
      const item = this.#queue.shift()!;
      if (item.cancelled) {
        if (item.abortListener && item.signal) {
          item.signal.removeEventListener("abort", item.abortListener);
        }
        continue;
      }
      this.#start(item);
    }
  }

  #start(item: QueueItem<unknown>): void {
    item.started = true;
    if (item.abortListener && item.signal) {
      item.signal.removeEventListener("abort", item.abortListener);
    }
    const stats = this.#statsFor(item.operation);
    this.#queued -= 1;
    stats.queued -= 1;
    this.#active += 1;
    stats.active += 1;
    stats.started += 1;
    const startedAt = this.#readClock();
    const queueMs = Math.max(0, startedAt - item.enqueuedAt);
    stats.totalQueueMs += queueMs;
    stats.maxQueueMs = Math.max(stats.maxQueueMs, queueMs);
    let includeRunDuration = true;

    void Promise.resolve().then(item.task).then(
      (value) => {
        stats.succeeded += 1;
        item.resolve(value);
      },
      (error: unknown) => {
        if (isCancellation(error, item.signal)) {
          stats.cancelled += 1;
          includeRunDuration = false;
        } else {
          stats.failed += 1;
        }
        item.reject(error);
      },
    ).finally(() => {
      const runMs = Math.max(0, this.#readClock() - startedAt);
      if (includeRunDuration) {
        stats.totalRunMs += runMs;
        stats.maxRunMs = Math.max(stats.maxRunMs, runMs);
      }
      stats.active -= 1;
      this.#active -= 1;
      this.#drain();
    });
  }

  #statsFor(operation: string): MutableOperationStats {
    const current = this.#operations.get(operation);
    if (current) return current;
    const created = emptyStats();
    this.#operations.set(operation, created);
    return created;
  }

  #readClock(): number {
    const value = this.#now();
    if (!Number.isFinite(value)) throw new RangeError("analytics clock must be finite");
    return value;
  }

  #positiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
    return value;
  }
}
