import { serialize } from "node:v8";

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_TTL_MS = 60_000;
const ENTRY_OVERHEAD_BYTES = 96;

export type CacheClone<V> = false | ((value: V) => V);

export interface LruTtlCacheOptions<V> {
  /** Hard entry bound. The least-recently-used entry is evicted first. */
  maxEntries?: number;
  /**
   * Hard bound on estimated serialized bytes. This is deliberately an estimate,
   * not a claim about the JavaScript engine's heap accounting.
   */
  maxBytes?: number;
  defaultTtlMs?: number;
  defaultStaleWhileRevalidateMs?: number;
  /** A monotonic millisecond clock may be injected for tests. */
  now?: () => number;
  /**
   * Values are structured-cloned on write and read by default. Passing false is
   * an explicit contract that cached values are deeply immutable.
   */
  clone?: CacheClone<V>;
  /** Returns the estimated serialized size of a value, excluding key/entry overhead. */
  estimateValueSize?: (value: V) => number;
  /** Observes background refresh failures; exceptions from this callback are ignored. */
  onBackgroundError?: (error: unknown, key: string) => void;
}

export interface CacheSetOptions {
  /** Fresh lifetime. Zero creates an immediately-stale entry when stale time is non-zero. */
  ttlMs?: number;
  /** Additional lifetime during which stale data may be served while refreshing. */
  staleWhileRevalidateMs?: number;
}

export interface CacheGetOptions {
  /** Ordinary reads only return fresh entries unless this is explicitly enabled. */
  allowStale?: boolean;
}

export interface CacheLoadOptions extends CacheSetOptions {
  /** Return stale data immediately and refresh in the background. Defaults to true. */
  serveStale?: boolean;
  /** Cancels only this caller's wait. Shared work continues while another caller needs it. */
  signal?: AbortSignal;
}

export type CacheLoader<V> = (signal: AbortSignal) => V | Promise<V>;

export interface CacheStats {
  entries: number;
  estimatedBytes: number;
  maxEntries: number;
  maxBytes: number;
  inFlight: number;
  hits: number;
  staleHits: number;
  misses: number;
  sets: number;
  rejectedSets: number;
  evictions: number;
  expirations: number;
  invalidations: number;
  loadsStarted: number;
  loadsSucceeded: number;
  loadsFailed: number;
  loadsAborted: number;
  deduplicatedLoads: number;
}

interface Entry<V> {
  value: V;
  freshUntil: number;
  expiresAt: number;
  estimatedBytes: number;
}

interface Flight<V> {
  controller: AbortController;
  promise: Promise<V>;
  waiters: number;
  background: boolean;
  settled: boolean;
}

interface Counters {
  hits: number;
  staleHits: number;
  misses: number;
  sets: number;
  rejectedSets: number;
  evictions: number;
  expirations: number;
  invalidations: number;
  loadsStarted: number;
  loadsSucceeded: number;
  loadsFailed: number;
  loadsAborted: number;
  deduplicatedLoads: number;
}

function emptyCounters(): Counters {
  return {
    hits: 0,
    staleHits: 0,
    misses: 0,
    sets: 0,
    rejectedSets: 0,
    evictions: 0,
    expirations: 0,
    invalidations: 0,
    loadsStarted: 0,
    loadsSucceeded: 0,
    loadsFailed: 0,
    loadsAborted: 0,
    deduplicatedLoads: 0,
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeDuration(value: number, name: string): number {
  if ((Number.isFinite(value) && value >= 0) || value === Number.POSITIVE_INFINITY) return value;
  throw new RangeError(`${name} must be a non-negative finite number or Infinity`);
}

function deadline(start: number, duration: number): number {
  if (duration === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  const result = start + duration;
  return Number.isFinite(result) ? result : Number.POSITIVE_INFINITY;
}

function defaultValueSize(value: unknown): number {
  return serialize(value).byteLength;
}

function abortReason(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

/**
 * A process-local, dependency-free LRU cache for response DTOs and snapshots.
 *
 * Expiry is lazy: reads, writes, and sweep() remove expired entries. The cache
 * therefore allocates no timers and cannot keep a Node.js process alive.
 */
export class LruTtlCache<V> {
  readonly #entries = new Map<string, Entry<V>>();
  readonly #flights = new Map<string, Flight<V>>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #defaultTtlMs: number;
  readonly #defaultStaleWhileRevalidateMs: number;
  readonly #now: () => number;
  readonly #cloneValue: (value: V) => V;
  readonly #estimateValueSize: (value: V) => number;
  readonly #onBackgroundError: ((error: unknown, key: string) => void) | undefined;
  #estimatedBytes = 0;
  #counters = emptyCounters();

  constructor(options: LruTtlCacheOptions<V> = {}) {
    this.#maxEntries = positiveInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, "maxEntries");
    this.#maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, "maxBytes");
    this.#defaultTtlMs = nonNegativeDuration(options.defaultTtlMs ?? DEFAULT_TTL_MS, "defaultTtlMs");
    this.#defaultStaleWhileRevalidateMs = nonNegativeDuration(
      options.defaultStaleWhileRevalidateMs ?? 0,
      "defaultStaleWhileRevalidateMs",
    );
    this.#now = options.now ?? Date.now;
    this.#cloneValue = options.clone === false
      ? (value) => value
      : options.clone ?? ((value) => structuredClone(value));
    this.#estimateValueSize = options.estimateValueSize ?? defaultValueSize;
    this.#onBackgroundError = options.onBackgroundError;
  }

  get size(): number {
    return this.#entries.size;
  }

  get estimatedBytes(): number {
    return this.#estimatedBytes;
  }

  /** Returns a defensive copy of a fresh entry, or optionally a stale entry. */
  get(key: string, options: CacheGetOptions = {}): V | undefined {
    const now = this.#readClock();
    const entry = this.#readEntry(key, now, true);
    if (!entry) {
      this.#counters.misses += 1;
      return undefined;
    }
    if (now >= entry.freshUntil) {
      if (options.allowStale !== true) {
        this.#counters.misses += 1;
        return undefined;
      }
      this.#counters.staleHits += 1;
      return this.#cloneValue(entry.value);
    }
    this.#counters.hits += 1;
    return this.#cloneValue(entry.value);
  }

  /** Checks usability without changing LRU order or request counters. */
  has(key: string, options: CacheGetOptions = {}): boolean {
    const now = this.#readClock();
    const entry = this.#readEntry(key, now, false);
    return entry !== undefined && (now < entry.freshUntil || options.allowStale === true);
  }

  /**
   * Stores a defensive copy. Returns false only when the entry has no lifetime
   * or cannot fit inside the configured byte bound; an existing value is kept
   * when an oversized replacement is rejected.
   */
  set(key: string, value: V, options: CacheSetOptions = {}): boolean {
    const now = this.#readClock();
    const ttlMs = nonNegativeDuration(options.ttlMs ?? this.#defaultTtlMs, "ttlMs");
    const staleMs = nonNegativeDuration(
      options.staleWhileRevalidateMs ?? this.#defaultStaleWhileRevalidateMs,
      "staleWhileRevalidateMs",
    );

    if (ttlMs === 0 && staleMs === 0) {
      this.#deleteEntry(key);
      return false;
    }

    const storedValue = this.#cloneValue(value);
    const valueBytes = this.#estimateValueSize(storedValue);
    if (!Number.isSafeInteger(valueBytes) || valueBytes < 0) {
      throw new RangeError("estimateValueSize must return a non-negative safe integer");
    }
    const estimatedBytes = ENTRY_OVERHEAD_BYTES + Buffer.byteLength(key, "utf8") + valueBytes;
    if (estimatedBytes > this.#maxBytes) {
      this.#counters.rejectedSets += 1;
      return false;
    }

    this.#sweepExpired(now);
    this.#deleteEntry(key);
    const freshUntil = deadline(now, ttlMs);
    const expiresAt = deadline(freshUntil, staleMs);
    this.#entries.set(key, { value: storedValue, freshUntil, expiresAt, estimatedBytes });
    this.#estimatedBytes += estimatedBytes;
    this.#counters.sets += 1;
    this.#enforceBounds();
    return this.#entries.has(key);
  }

  /** Invalidates one key and cancels an in-progress load for the same key. */
  invalidate(key: string): boolean {
    const removed = this.#deleteEntry(key);
    if (removed) this.#counters.invalidations += 1;
    this.#cancelFlight(key);
    return removed;
  }

  /**
   * Invalidates literal prefix matches. Use delimited namespaces such as
   * `house:123:` to avoid unintentionally matching adjacent identifiers.
   */
  invalidatePrefix(prefix: string): number {
    let removed = 0;
    for (const key of this.#entries.keys()) {
      if (key.startsWith(prefix) && this.#deleteEntry(key)) removed += 1;
    }
    for (const key of this.#flights.keys()) {
      if (key.startsWith(prefix)) this.#cancelFlight(key);
    }
    this.#counters.invalidations += removed;
    return removed;
  }

  /** Invalidates every entry and aborts all loads. */
  clear(): number {
    const removed = this.#entries.size;
    this.#entries.clear();
    this.#estimatedBytes = 0;
    for (const key of [...this.#flights.keys()]) this.#cancelFlight(key);
    this.#counters.invalidations += removed;
    return removed;
  }

  /** Removes hard-expired entries and returns the number removed. */
  sweep(): number {
    return this.#sweepExpired(this.#readClock());
  }

  /**
   * Returns fresh data, serves stale data while revalidating, or performs one
   * shared load on a miss. The first load for a key defines that flight's loader
   * and TTL policy, so callers must include representation variants in the key.
   */
  async getOrLoad(key: string, loader: CacheLoader<V>, options: CacheLoadOptions = {}): Promise<V> {
    throwIfAborted(options.signal);
    const now = this.#readClock();
    const entry = this.#readEntry(key, now, true);

    if (entry && now < entry.freshUntil) {
      this.#counters.hits += 1;
      return this.#cloneValue(entry.value);
    }

    const serveStale = options.serveStale !== false;
    if (entry && serveStale) {
      this.#counters.staleHits += 1;
      const flight = this.#startOrJoinFlight(key, loader, options, true);
      void flight.promise.catch(() => undefined);
      return this.#cloneValue(entry.value);
    }

    this.#counters.misses += 1;
    const flight = this.#startOrJoinFlight(key, loader, options, false);
    const value = await this.#waitForFlight(flight, options.signal);
    return this.#cloneValue(value);
  }

  /** Primarily useful for graceful shutdown and deterministic tests. */
  async waitForIdle(): Promise<void> {
    while (this.#flights.size > 0) {
      const current = [...this.#flights.values()].map((flight) => flight.promise);
      await Promise.allSettled(current);
    }
  }

  stats(): Readonly<CacheStats> {
    return Object.freeze({
      entries: this.#entries.size,
      estimatedBytes: this.#estimatedBytes,
      maxEntries: this.#maxEntries,
      maxBytes: this.#maxBytes,
      inFlight: this.#flights.size,
      ...this.#counters,
    });
  }

  /** Resets event counters without changing entries, bytes, or active loads. */
  resetStats(): void {
    this.#counters = emptyCounters();
  }

  #readClock(): number {
    const now = this.#now();
    if (!Number.isFinite(now)) throw new RangeError("cache clock must return a finite millisecond value");
    return now;
  }

  #readEntry(key: string, now: number, touch: boolean): Entry<V> | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (now >= entry.expiresAt) {
      this.#deleteEntry(key);
      this.#counters.expirations += 1;
      return undefined;
    }
    if (touch) {
      this.#entries.delete(key);
      this.#entries.set(key, entry);
    }
    return entry;
  }

  #deleteEntry(key: string): boolean {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    this.#entries.delete(key);
    this.#estimatedBytes = Math.max(0, this.#estimatedBytes - entry.estimatedBytes);
    return true;
  }

  #sweepExpired(now: number): number {
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      if (now >= entry.expiresAt && this.#deleteEntry(key)) removed += 1;
    }
    this.#counters.expirations += removed;
    return removed;
  }

  #enforceBounds(): void {
    while (this.#entries.size > this.#maxEntries || this.#estimatedBytes > this.#maxBytes) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#deleteEntry(oldest);
      this.#counters.evictions += 1;
    }
  }

  #startOrJoinFlight(
    key: string,
    loader: CacheLoader<V>,
    options: CacheLoadOptions,
    background: boolean,
  ): Flight<V> {
    const existing = this.#flights.get(key);
    if (existing) {
      this.#counters.deduplicatedLoads += 1;
      return existing;
    }

    const controller = new AbortController();
    const flight: Flight<V> = {
      controller,
      promise: Promise.resolve(undefined as V),
      waiters: 0,
      background,
      settled: false,
    };
    this.#counters.loadsStarted += 1;
    flight.promise = (async () => {
      try {
        // The microtask boundary ensures the flight is registered before loader code runs.
        const value = await Promise.resolve().then(() => loader(controller.signal));
        throwIfAborted(controller.signal);
        if (this.#flights.get(key) !== flight) throw abortReason(controller.signal);
        this.set(key, value, {
          ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
          ...(options.staleWhileRevalidateMs !== undefined
            ? { staleWhileRevalidateMs: options.staleWhileRevalidateMs }
            : {}),
        });
        this.#counters.loadsSucceeded += 1;
        return value;
      } catch (error) {
        if (controller.signal.aborted) this.#counters.loadsAborted += 1;
        else this.#counters.loadsFailed += 1;
        if (flight.background && !controller.signal.aborted && this.#onBackgroundError) {
          try {
            this.#onBackgroundError(error, key);
          } catch {
            // Observability hooks must never change cache behavior.
          }
        }
        throw error;
      } finally {
        flight.settled = true;
        if (this.#flights.get(key) === flight) this.#flights.delete(key);
      }
    })();
    this.#flights.set(key, flight);
    return flight;
  }

  async #waitForFlight(flight: Flight<V>, signal?: AbortSignal): Promise<V> {
    throwIfAborted(signal);
    flight.waiters += 1;
    try {
      if (!signal) return await flight.promise;
      return await new Promise<V>((resolve, reject) => {
        let finished = false;
        const cleanup = (): void => signal.removeEventListener("abort", onAbort);
        const onAbort = (): void => {
          if (finished) return;
          finished = true;
          cleanup();
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        void flight.promise.then(
          (value) => {
            if (finished) return;
            finished = true;
            cleanup();
            resolve(value);
          },
          (error: unknown) => {
            if (finished) return;
            finished = true;
            cleanup();
            reject(error);
          },
        );
      });
    } finally {
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.background && !flight.settled) {
        flight.controller.abort(new DOMException("All cache load waiters aborted", "AbortError"));
      }
    }
  }

  #cancelFlight(key: string): void {
    const flight = this.#flights.get(key);
    if (!flight) return;
    this.#flights.delete(key);
    flight.controller.abort(new DOMException("Cache entry invalidated", "AbortError"));
    void flight.promise.catch(() => undefined);
  }
}
