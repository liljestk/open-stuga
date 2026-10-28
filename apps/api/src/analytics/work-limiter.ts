import { AsyncLocalStorage } from "node:async_hooks";
import { withSignal } from "@climate-twin/contracts";
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
  lowPriorityActive: number;
  queued: number;
  maxConcurrent: number;
  maxQueued: number;
  operations: Record<string, AnalyticsOperationStats>;
  caches: Record<string, CacheStats>;
}

export interface AnalyticsLowPriorityLease {
  release(): Promise<void>;
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
  priority: "foreground" | "low";
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
  /** Marks work running inside one of this limiter's slots. */
  readonly #slot = new AsyncLocalStorage<true>();
  #active = 0;
  #lowPriorityActive = 0;
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
    if (this.#slot.getStore()) return this.#runInHeldSlot(operation, task, signal);
    return this.#enqueue(operation, task, "foreground", signal);
  }

  /**
   * Uses the same bounded admission boundary as request work, but waits behind
   * every already-queued foreground operation. Durable analytics use this so a
   * nightly refresh cannot jump ahead of an API response.
   */
  runLowPriority<T>(
    operation: string,
    task: () => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.#slot.getStore()) return this.#runInHeldSlot(operation, task, signal);
    return this.#enqueue(operation, task, "low", signal);
  }

  /**
   * Work that already holds a slot runs nested work in that slot. Queueing it
   * would wait on capacity the caller itself occupies, and once every slot did
   * so (a projection or optimizer report asking for an energy summary) nothing
   * could finish until the requests were cancelled.
   */
  async #runInHeldSlot<T>(operation: string, task: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw abortReason(signal);
    const stats = this.#statsFor(operation);
    stats.started += 1;
    try {
      const value = await task();
      stats.succeeded += 1;
      return value;
    } catch (error) {
      if (isCancellation(error, signal)) stats.cancelled += 1;
      else stats.failed += 1;
      throw error;
    }
  }

  /**
   * Reserves the single background slot only after the queued work reaches the
   * front and the live host-admission check still passes. Spatial inference and
   * durable analytics share this lease so they can never run together.
   */
  acquireLowPriority(
    operation: string,
    admit: () => boolean | Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<AnalyticsLowPriorityLease | null> {
    let settle: ((lease: AnalyticsLowPriorityLease | null) => void) | null = null;
    let rejectAcquisition: ((error: unknown) => void) | null = null;
    let releaseHold: (() => void) | null = null;
    let settled = false;
    let denied = false;
    const acquired = new Promise<AnalyticsLowPriorityLease | null>((resolve, reject) => {
      settle = resolve;
      rejectAcquisition = reject;
    });
    const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
    const occupancy = this.#enqueue(operation, async () => {
      let admitted: boolean;
      try {
        admitted = await admit();
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal);
        throw error;
      }
      // Once a queued task starts, its queue abort listener is removed. The
      // admission callback may yield, so cancellation must be checked again
      // before exposing a lease that would otherwise hold background capacity.
      if (signal?.aborted) throw abortReason(signal);
      if (!admitted) {
        denied = true;
        return;
      }
      let released = false;
      settled = true;
      settle?.({
        release: async () => {
          if (!released) {
            released = true;
            releaseHold?.();
          }
          await occupancy;
        },
      });
      await hold;
    }, "low", signal);
    void occupancy.then(
      () => {
        if (!settled && denied) {
          settled = true;
          settle?.(null);
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          rejectAcquisition?.(error);
        }
      },
    );
    return acquired;
  }

  #enqueue<T>(
    operation: string,
    task: () => Promise<T> | T,
    priority: "foreground" | "low",
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
        ...withSignal(signal),
        cancelled: false,
        started: false,
        priority,
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
      if (priority === "foreground") {
        const firstLowPriority = this.#queue.findIndex((queued) => queued.priority === "low");
        if (firstLowPriority >= 0) this.#queue.splice(firstLowPriority, 0, item as QueueItem<unknown>);
        else this.#queue.push(item as QueueItem<unknown>);
      } else {
        this.#queue.push(item as QueueItem<unknown>);
      }
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
      lowPriorityActive: this.#lowPriorityActive,
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
      let index = 0;
      if (this.#lowPriorityActive > 0 && this.#queue[0]?.priority === "low") {
        index = this.#queue.findIndex((queued) => queued.priority === "foreground");
        if (index < 0) break;
      }
      const [item] = this.#queue.splice(index, 1);
      if (!item) break;
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
    if (item.priority === "low") this.#lowPriorityActive += 1;
    stats.active += 1;
    stats.started += 1;
    const startedAt = this.#readClock();
    const queueMs = Math.max(0, startedAt - item.enqueuedAt);
    stats.totalQueueMs += queueMs;
    stats.maxQueueMs = Math.max(stats.maxQueueMs, queueMs);
    let includeRunDuration = true;

    void Promise.resolve().then(() => this.#slot.run(true, item.task)).then(
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
      if (item.priority === "low") this.#lowPriorityActive -= 1;
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
