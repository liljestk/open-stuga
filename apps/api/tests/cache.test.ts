import { describe, expect, it, vi } from "vitest";
import { LruTtlCache } from "../src/cache.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("LruTtlCache", () => {
  it("bounds entries with LRU eviction and exposes entry/memory statistics", () => {
    const cache = new LruTtlCache<{ value: number }>({
      maxEntries: 2,
      maxBytes: 10_000,
      estimateValueSize: () => 10,
    });

    cache.set("a", { value: 1 });
    cache.set("b", { value: 2 });
    expect(cache.get("a")).toEqual({ value: 1 });
    cache.set("c", { value: 3 });

    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(cache.stats()).toMatchObject({ entries: 2, evictions: 1, hits: 1 });
    expect(cache.stats().estimatedBytes).toBeGreaterThan(0);
    expect(cache.stats().estimatedBytes).toBeLessThanOrEqual(cache.stats().maxBytes);
  });

  it("enforces the byte bound and preserves an existing entry when a replacement is too large", () => {
    const cache = new LruTtlCache<string>({
      maxBytes: 210,
      estimateValueSize: (value) => value.length,
      clone: false,
    });

    expect(cache.set("first", "small")).toBe(true);
    expect(cache.set("second", "small")).toBe(true);
    expect(cache.has("first")).toBe(false);
    expect(cache.has("second")).toBe(true);
    expect(cache.set("second", "x".repeat(1_000))).toBe(false);
    expect(cache.get("second")).toBe("small");
    expect(cache.stats()).toMatchObject({ entries: 1, evictions: 1, rejectedSets: 1 });
  });

  it("uses an injected clock for fresh, stale, and hard-expired lifetimes", () => {
    let now = 1_000;
    const cache = new LruTtlCache<{ sample: number }>({ now: () => now });
    cache.set("sensor", { sample: 42 }, { ttlMs: 10, staleWhileRevalidateMs: 20 });

    now = 1_009;
    expect(cache.get("sensor")).toEqual({ sample: 42 });
    now = 1_010;
    expect(cache.get("sensor")).toBeUndefined();
    expect(cache.get("sensor", { allowStale: true })).toEqual({ sample: 42 });
    now = 1_030;
    expect(cache.get("sensor", { allowStale: true })).toBeUndefined();
    expect(cache.stats()).toMatchObject({ entries: 0, hits: 1, staleHits: 1, misses: 2, expirations: 1 });
  });

  it("defensively clones values on writes and reads by default", () => {
    const cache = new LruTtlCache<{ nested: { value: number } }>();
    const source = { nested: { value: 1 } };
    cache.set("dto", source);
    source.nested.value = 2;

    const first = cache.get("dto");
    expect(first).toEqual({ nested: { value: 1 } });
    if (first) first.nested.value = 3;
    expect(cache.get("dto")).toEqual({ nested: { value: 1 } });
  });

  it("serves stale data immediately and single-flights one background revalidation", async () => {
    let now = 0;
    const refresh = deferred<{ revision: number }>();
    const loader = vi.fn(() => refresh.promise);
    const cache = new LruTtlCache<{ revision: number }>({ now: () => now });
    cache.set("weather:house-1", { revision: 1 }, { ttlMs: 10, staleWhileRevalidateMs: 100 });
    now = 11;

    await expect(cache.getOrLoad("weather:house-1", loader)).resolves.toEqual({ revision: 1 });
    await expect(cache.getOrLoad("weather:house-1", loader)).resolves.toEqual({ revision: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ staleHits: 2, loadsStarted: 1, deduplicatedLoads: 1, inFlight: 1 });

    refresh.resolve({ revision: 2 });
    await cache.waitForIdle();
    expect(cache.get("weather:house-1")).toEqual({ revision: 2 });
    expect(cache.stats()).toMatchObject({ loadsSucceeded: 1, inFlight: 0 });
  });

  it("single-flights misses and lets one caller abort without cancelling another waiter", async () => {
    const result = deferred<{ value: number }>();
    const firstLoader = vi.fn(() => result.promise);
    const unusedLoader = vi.fn(() => Promise.resolve({ value: -1 }));
    const cache = new LruTtlCache<{ value: number }>();
    const abort = new AbortController();

    const first = cache.getOrLoad("latest:house-1", firstLoader, { signal: abort.signal });
    const second = cache.getOrLoad("latest:house-1", unusedLoader);
    abort.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(firstLoader).toHaveBeenCalledTimes(1);
    expect(unusedLoader).not.toHaveBeenCalled();
    result.resolve({ value: 7 });
    await expect(second).resolves.toEqual({ value: 7 });
    expect(cache.get("latest:house-1")).toEqual({ value: 7 });
    expect(cache.stats()).toMatchObject({ loadsStarted: 1, loadsSucceeded: 1, deduplicatedLoads: 1 });
  });

  it("aborts the underlying load when every waiting caller has aborted", async () => {
    const observedAbort = deferred<void>();
    const cache = new LruTtlCache<number>();
    const caller = new AbortController();
    const loader = vi.fn((signal: AbortSignal) => new Promise<number>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        observedAbort.resolve();
        reject(signal.reason);
      }, { once: true });
    }));

    const pending = cache.getOrLoad("slow", loader, { signal: caller.signal });
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await observedAbort.promise;
    await cache.waitForIdle();
    expect(cache.stats()).toMatchObject({ loadsStarted: 1, loadsAborted: 1, inFlight: 0 });
  });

  it("invalidates individual keys and literal prefixes, including active flights", async () => {
    const cache = new LruTtlCache<number>();
    cache.set("house:1:weather", 1);
    cache.set("house:1:latest", 2);
    cache.set("house:10:latest", 3);

    expect(cache.invalidate("house:1:weather")).toBe(true);
    expect(cache.invalidatePrefix("house:1:")).toBe(1);
    expect(cache.has("house:10:latest")).toBe(true);

    const started = deferred<void>();
    const loader = (signal: AbortSignal): Promise<number> => {
      started.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const pending = cache.getOrLoad("house:1:openapi", loader);
    await started.promise;
    cache.invalidatePrefix("house:1:");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cache.stats()).toMatchObject({ entries: 1, invalidations: 2, loadsAborted: 1 });
  });

  it("retains stale data after a failed background refresh and reports the error", async () => {
    let now = 0;
    const onBackgroundError = vi.fn();
    const cache = new LruTtlCache<string>({ now: () => now, onBackgroundError });
    cache.set("electricity:fi", "old", { ttlMs: 1, staleWhileRevalidateMs: 100 });
    now = 2;

    await expect(cache.getOrLoad("electricity:fi", async () => {
      throw new Error("upstream unavailable");
    })).resolves.toBe("old");
    await cache.waitForIdle();

    expect(cache.get("electricity:fi", { allowStale: true })).toBe("old");
    expect(onBackgroundError).toHaveBeenCalledWith(expect.objectContaining({ message: "upstream unavailable" }), "electricity:fi");
    expect(cache.stats()).toMatchObject({ loadsFailed: 1 });
  });

  it("can sweep expired entries without allocating expiry timers", () => {
    let now = 0;
    const cache = new LruTtlCache<number>({ now: () => now });
    cache.set("a", 1, { ttlMs: 5 });
    cache.set("b", 2, { ttlMs: 10 });
    now = 6;

    expect(cache.sweep()).toBe(1);
    expect(cache.stats()).toMatchObject({ entries: 1, expirations: 1 });
  });
});
