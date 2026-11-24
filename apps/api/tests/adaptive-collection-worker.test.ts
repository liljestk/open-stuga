import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataMode } from "@climate-twin/contracts";
import { AdaptiveCollectionWorker } from "../src/analytics/adaptive-monitoring/collection-worker.js";
import { HOUR_MS } from "../src/analytics/forecast/models.js";
import { AnalyticsWorkLimiter, BACKGROUND_ANALYTICS_STARTUP_GRACE_MS } from "../src/analytics/work-limiter.js";
import { ClimateDatabase } from "../src/db.js";

const homeId = "adaptive-collection-home";

describe("Adaptive Home shadow collection", () => {
  let database: ClimateDatabase;
  let limiter: AnalyticsWorkLimiter;
  let worker: AdaptiveCollectionWorker;
  let admit: ReturnType<typeof vi.fn<() => boolean>>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    database = new ClimateDatabase(":memory:");
    limiter = new AnalyticsWorkLimiter({ maxConcurrent: 1, maxQueued: 4 });
    admit = vi.fn(() => true);
    worker = new AdaptiveCollectionWorker({ database, limiter, admit });
  });
  afterEach(async () => {
    await worker.stop();
    database.close();
    vi.useRealTimers();
  });

  function createHome(id = homeId) {
    const floors = database.getHouse("house-main")!.floors;
    database.createHouse({ id, name: id, timezone: "UTC", floors });
  }

  function addStream(id: string, houseId = homeId) {
    const floorId = database.getHouse(houseId)!.floors[0]!.id;
    database.createSensor({
      id, houseId, floorId, name: id, room: "", x: 1, y: 1, z: 1, model: "Test", enabled: true, tags: [],
      temperatureEntityId: `sensor.${id}`,
    });
  }

  function enable(dataMode: DataMode, houseId = homeId) {
    database.changeAdaptiveMonitoringSettings({
      houseId, actorUserId: "test-owner", change: { action: "set-mode", mode: "shadow", dataMode, baseRevision: 0 },
    });
  }

  function captured() {
    return database.db.prepare("SELECT COUNT(*) AS count, min(hour) AS first, max(hour) AS last FROM adaptive_hourly_evidence")
      .get() as { count: number; first: number | null; last: number | null };
  }

  it("waits for startup grace, skips Homes without opt-in and obeys host admission", async () => {
    database.activateRealDataMode();
    createHome();
    addStream("collector-target");
    worker.start();
    await vi.advanceTimersByTimeAsync(BACKGROUND_ANALYTICS_STARTUP_GRACE_MS - 1);
    expect(admit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(admit).not.toHaveBeenCalled();
    enable("live");
    admit.mockReturnValue(false);
    await worker.runOnce();
    expect(admit).toHaveBeenCalledTimes(1);
    expect(worker.status()).toMatchObject({ state: "paused", reason: "host-pressure", streams: 0 });
    expect(captured().count).toBe(0);
    admit.mockReturnValue(true);
    vi.setSystemTime(Date.now() + 3 * HOUR_MS);
    await worker.runOnce();
    expect(worker.status()).toMatchObject({ state: "idle", streams: 1, gaps: expect.any(Number) });
    expect(captured().count).toBeGreaterThan(0);
  });

  it("rotates across Homes, resumes durable progress and caps each catch-up pass", async () => {
    database.activateRealDataMode();
    createHome();
    createHome("next-home");
    for (let index = 0; index < 32; index++) addStream(`stream-${index.toString().padStart(2, "0")}`);
    addStream("next-home-stream", "next-home");
    enable("live");
    enable("live", "next-home");
    vi.setSystemTime(Date.now() + 80 * HOUR_MS);
    await worker.runOnce();
    expect(worker.status()).toMatchObject({ streams: 32, gaps: 128, unavailableHours: 0 });
    expect(captured().count).toBe(128);
    expect(captured().first).toBeGreaterThanOrEqual(Date.now() - 49 * HOUR_MS);
    expect(database.db.prepare("SELECT house_id FROM adaptive_collection_cursors WHERE data_mode = 'live'").get())
      .toEqual({ house_id: homeId });
    const next = new AdaptiveCollectionWorker({ database, limiter, admit });
    await next.runOnce();
    await next.stop();
    expect(database.db.prepare(`SELECT count(*) AS count FROM adaptive_hourly_evidence evidence
      JOIN adaptive_evidence_epochs epoch ON epoch.id = evidence.epoch_id WHERE epoch.house_id = 'next-home'`).get())
      .toEqual({ count: 4 });
    expect(captured().count).toBe(256);
    expect(captured().last).toBeLessThan(Math.floor(Date.now() / HOUR_MS) * HOUR_MS);
  });

  it("cancels queued work on shutdown and fences a demo pass after live activation", async () => {
    createHome();
    addStream("demo-stream");
    enable("demo");
    vi.setSystemTime(Date.now() + 3 * HOUR_MS);
    const lease = await limiter.acquireLowPriority("test-blocker", () => true);
    try {
      const pending = worker.runOnce();
      expect(limiter.snapshot().queued).toBe(1);
      await worker.stop();
      await pending;
      expect(worker.status().state).toBe("stopped");
      const queuedDemo = worker.runOnce();
      expect(limiter.snapshot().queued).toBe(1);
      database.activateRealDataMode();
      await lease!.release();
      await queuedDemo;
      expect(captured().count).toBe(0);
      expect(database.db.prepare("SELECT count(*) AS count FROM adaptive_collection_cursors").get()).toEqual({ count: 0 });
    } finally {
      await lease?.release();
    }
  });

  it("releases governor capacity when shutdown interrupts a pending host sample", async () => {
    createHome();
    addStream("slow-admission");
    enable("demo");
    let admissionStarted!: () => void;
    const started = new Promise<void>((resolve) => { admissionStarted = resolve; });
    let allow!: (allowed: boolean) => void;
    const admission = new Promise<boolean>((resolve) => { allow = resolve; });
    const waiting = new AdaptiveCollectionWorker({
      database, limiter, admit: () => { admissionStarted(); return admission; },
    });
    const run = waiting.runOnce();
    await started;
    await waiting.stop();
    allow(true);
    await run;
    expect(limiter.snapshot()).toMatchObject({ active: 0, lowPriorityActive: 0, queued: 0 });
    expect(captured().count).toBe(0);
  });
});
