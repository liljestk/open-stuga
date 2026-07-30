import { describe, expect, it, vi } from "vitest";
import {
  AnalyticsCapacityError,
  AnalyticsWorkLimiter,
} from "../src/analytics/work-limiter.js";

describe("AnalyticsWorkLimiter", () => {
  it("bounds active work, queues fairly, and reports timings", async () => {
    let now = 0;
    const limiter = new AnalyticsWorkLimiter({
      maxConcurrent: 1,
      maxQueued: 2,
      now: () => now,
    });
    let release!: () => void;
    const first = limiter.run("home-performance", () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    await Promise.resolve();
    now = 5;
    const secondTask = vi.fn(() => "second");
    const second = limiter.run("energy-summary", secondTask);

    expect(secondTask).not.toHaveBeenCalled();
    now = 15;
    release();
    await first;
    await expect(second).resolves.toBe("second");

    const snapshot = limiter.snapshot();
    expect(snapshot.active).toBe(0);
    expect(snapshot.queued).toBe(0);
    expect(snapshot.operations["energy-summary"]).toMatchObject({
      started: 1,
      succeeded: 1,
      averageQueueMs: 10,
    });
  });

  it("rejects overflow and removes an aborted queued operation", async () => {
    const limiter = new AnalyticsWorkLimiter({ maxConcurrent: 1, maxQueued: 1 });
    let release!: () => void;
    const first = limiter.run("first", () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const controller = new AbortController();
    const queued = limiter.run("queued", () => undefined, controller.signal);
    await expect(limiter.run("overflow", () => undefined)).rejects.toBeInstanceOf(
      AnalyticsCapacityError,
    );

    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    release();
    await first;
    expect(limiter.snapshot().operations.queued?.cancelled).toBe(1);
  });
});
