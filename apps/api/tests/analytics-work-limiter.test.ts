import { describe, expect, it, vi } from "vitest";
import {
  AnalyticsCapacityError,
  AnalyticsWorkLimiter,
} from "../src/analytics/work-limiter.js";
import { hostAllowsBackgroundWork } from "../src/analytics/background-admission.js";
import type { HostSystemHealth } from "@climate-twin/contracts";

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

  it("reports aborted active work as cancelled instead of failed", async () => {
    let now = 0;
    const limiter = new AnalyticsWorkLimiter({ now: () => now });
    const controller = new AbortController();
    let rejectTask!: (error: unknown) => void;
    const task = limiter.run("energy-summary", () => new Promise<void>((_resolve, reject) => {
      rejectTask = reject;
    }), controller.signal);
    await Promise.resolve();

    now = 25;
    controller.abort();
    rejectTask(controller.signal.reason);
    await expect(task).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();

    expect(limiter.snapshot().operations["energy-summary"]).toMatchObject({
      started: 1,
      succeeded: 0,
      failed: 0,
      cancelled: 1,
      averageRunMs: 0,
      maxRunMs: 0,
    });
  });

  it("admits foreground work before queued low-priority refreshes", async () => {
    const limiter = new AnalyticsWorkLimiter({ maxConcurrent: 1, maxQueued: 3 });
    const order: string[] = [];
    let release!: () => void;
    const active = limiter.run("active", () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const low = limiter.runLowPriority("daily-derived", () => { order.push("low"); });
    const foreground = limiter.run("api-query", () => { order.push("foreground"); });
    await Promise.resolve();
    release();
    await active;
    await foreground;
    await low;
    expect(order).toEqual(["foreground", "low"]);
  });

  it("shares one background lease while preserving a foreground slot", async () => {
    const limiter = new AnalyticsWorkLimiter({ maxConcurrent: 2, maxQueued: 4 });
    const first = await limiter.acquireLowPriority("derived", () => true);
    expect(first).not.toBeNull();
    let secondAdmissionChecks = 0;
    const secondPromise = limiter.acquireLowPriority("spatial", () => {
      secondAdmissionChecks += 1;
      return true;
    });
    await Promise.resolve();
    expect(secondAdmissionChecks).toBe(0);
    await expect(limiter.run("foreground", () => "ready")).resolves.toBe("ready");
    await first?.release();
    const second = await secondPromise;
    expect(secondAdmissionChecks).toBe(1);
    expect(limiter.snapshot().lowPriorityActive).toBe(1);
    await second?.release();
    expect(limiter.snapshot().lowPriorityActive).toBe(0);
  });

  it("checks current host state when a background lease reaches the front", async () => {
    const limiter = new AnalyticsWorkLimiter({ maxConcurrent: 1 });
    const lease = await limiter.acquireLowPriority("derived", () => false);
    expect(lease).toBeNull();
    expect(limiter.snapshot()).toMatchObject({ active: 0, lowPriorityActive: 0, queued: 0 });

    const healthy = {
      cpu: {
        state: "healthy",
        usagePercent: 20,
        processUsagePercent: 10,
        eventLoop: { state: "healthy" },
      },
      memory: { state: "healthy" },
      storage: { state: "healthy" },
      database: {
        state: "healthy",
        telemetry: {
          enabled: true,
          state: "healthy",
          pool: { waiting: 0 },
          queries: { active: 0 },
        },
      },
    } as HostSystemHealth;
    expect(hostAllowsBackgroundWork(healthy)).toBe(true);
    expect(hostAllowsBackgroundWork({
      ...healthy,
      cpu: { ...healthy.cpu, processUsagePercent: 50 },
    })).toBe(false);
    expect(hostAllowsBackgroundWork({
      ...healthy,
      database: {
        ...healthy.database,
        telemetry: { ...healthy.database.telemetry, queries: { ...healthy.database.telemetry.queries!, active: 1 } },
      },
    })).toBe(false);
  });

  it("does not grant a background lease canceled during async admission", async () => {
    const limiter = new AnalyticsWorkLimiter({ maxConcurrent: 1 });
    const controller = new AbortController();
    let reportAdmissionStarted!: () => void;
    const admissionStarted = new Promise<void>((resolve) => {
      reportAdmissionStarted = resolve;
    });
    let releaseAdmission!: (admitted: boolean) => void;
    const admissionReleased = new Promise<boolean>((resolve) => {
      releaseAdmission = resolve;
    });
    const acquisition = limiter.acquireLowPriority("derived", async () => {
      reportAdmissionStarted();
      return admissionReleased;
    }, controller.signal);

    await admissionStarted;
    controller.abort(new DOMException("mode changed", "AbortError"));
    releaseAdmission(true);

    await expect(acquisition).rejects.toMatchObject({ name: "AbortError" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(limiter.snapshot()).toMatchObject({
      active: 0,
      lowPriorityActive: 0,
      queued: 0,
      operations: {
        derived: { started: 1, succeeded: 0, failed: 0, cancelled: 1 },
      },
    });
  });
});
