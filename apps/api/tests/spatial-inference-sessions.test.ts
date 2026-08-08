import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SpatialLayerEngineRegistry, type SpatialLayerEngine } from "@climate-twin/spatial-layers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalyticsWorkLimiter } from "../src/analytics/work-limiter.js";
import type { EngineHost } from "../src/spatial-layers/engine-host.js";
import {
  SpatialLayerScheduler,
  SpatialLayerStateStore,
  type SpatialInferenceAdmission,
} from "../src/spatial-layers/index.js";
import {
  coreDatabases,
  partition,
  runtimes,
  scope,
  seededRuntime,
  temporaryDirectories,
} from "./spatial-layersTestSupport.js";

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  for (const database of coreDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("timed spatial inference sessions", () => {
  it("stays dormant without a session and never fans Home wakes out to Property", async () => {
    const { runtime, core } = seededRuntime();
    const house = core.listHouses()[0]!;
    const purge = vi.spyOn(runtime.state, "purgeOperationalHistoryBefore");
    const schedule = vi.spyOn(runtime.state, "scheduleDueInferenceSessions");

    runtime.scheduler.initialize();
    runtime.scheduler.wakeHouse(house.id, house.propertyId, new Date().toISOString());
    runtime.scheduler.enqueueScope({ kind: "property", id: house.propertyId }, new Date().toISOString(), "topology-changed");
    await runtime.scheduler.tick();

    expect(runtime.state.db.prepare("SELECT scope_kind, scope_id FROM spatial_inference_jobs").all()).toEqual([]);
    expect(purge).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("persists one immediate job, coalesces missed cadence buckets, and cancels on stop or expiry", () => {
    const store = new SpatialLayerStateStore(":memory:");
    const startedAt = "2026-08-08T09:00:00.000Z";
    const session = store.startInferenceSession({
      partition,
      houseId: scope.id,
      durationMinutes: 60,
      cadenceMinutes: 10,
      now: startedAt,
      createdBy: "owner-test",
    });

    const immediate = store.scheduleDueInferenceSessions(partition, startedAt);
    expect(immediate).toEqual([
      expect.objectContaining({
        scope,
        reason: "session-started",
        sessionId: session.id,
        bucketAt: startedAt,
      }),
    ]);
    expect(store.scheduleDueInferenceSessions(partition, startedAt)).toEqual([]);
    expect(store.scheduleDueInferenceSessions(partition, "2026-08-08T09:35:00.000Z")).toEqual([
      expect.objectContaining({ id: immediate[0]!.id, reason: "session-cadence", bucketAt: "2026-08-08T09:35:00.000Z" }),
    ]);
    expect(store.getInferenceSession(partition, session.id)).toMatchObject({
      nextRunAt: "2026-08-08T09:40:00.000Z",
      lastScheduledAt: "2026-08-08T09:35:00.000Z",
    });
    expect(store.db.prepare("SELECT DISTINCT scope_kind FROM spatial_inference_jobs").all()).toEqual([
      { scope_kind: "house" },
    ]);
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM spatial_inference_jobs").get()).toEqual({ count: 1 });

    expect(store.stopInferenceSession(partition, scope.id, "2026-08-08T09:36:00.000Z")).toMatchObject({
      status: "stopped",
      stoppedAt: "2026-08-08T09:36:00.000Z",
    });
    expect(store.db.prepare("SELECT DISTINCT status FROM spatial_inference_jobs").all()).toEqual([
      { status: "cancelled" },
    ]);

    const expiring = store.startInferenceSession({
      partition,
      houseId: scope.id,
      durationMinutes: 15,
      cadenceMinutes: 5,
      now: "2026-08-08T10:00:00.000Z",
    });
    store.scheduleDueInferenceSessions(partition, "2026-08-08T10:00:00.000Z");
    expect(store.expireInferenceSessions(partition, "2026-08-08T10:15:00.000Z")).toEqual([
      expect.objectContaining({ id: expiring.id, status: "expired" }),
    ]);
    expect(store.getInferenceSession(partition, expiring.id)?.status).toBe("expired");
    store.close();
  });

  it("does not reclaim a terminal failed job", () => {
    const store = new SpatialLayerStateStore(":memory:");
    const now = "2026-08-08T09:00:00.000Z";
    store.startInferenceSession({ partition, houseId: scope.id, now });
    store.scheduleDueInferenceSessions(partition, now);
    const claimed = store.claimDueJobs(partition, now, 1)[0]!;

    expect(store.failJob(partition, claimed.id, claimed.lockToken!, "terminal", now, 1)).toBe(true);
    expect(store.getJob(partition, claimed.id)?.status).toBe("failed");
    expect(store.claimDueJobs(partition, "2026-08-08T09:30:00.000Z", 1)).toEqual([]);
    store.close();
  });

  it("migrates legacy job rows and cancels their ambient queue at scheduler cutover", () => {
    const directory = mkdtempSync(join(tmpdir(), "stugu-spatial-cutover-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "legacy-spatial.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE spatial_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO spatial_metadata(key, value) VALUES ('schema_version', '1');
      CREATE TABLE spatial_inference_jobs (
        source_db_id TEXT NOT NULL,
        data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'real')),
        id TEXT NOT NULL,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('house', 'property')),
        scope_id TEXT NOT NULL,
        bucket_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
        reason TEXT NOT NULL,
        available_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        lock_token TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(source_db_id, data_mode, id),
        UNIQUE(source_db_id, data_mode, scope_kind, scope_id, bucket_at)
      );
      INSERT INTO spatial_inference_jobs VALUES (
        'core-test', 'demo', 'legacy-job', 'property', 'property-test',
        '2026-08-08T09:00:00.000Z', 'pending', 'measurement',
        '2026-08-08T09:00:00.000Z', 0, NULL, NULL,
        '2026-08-08T09:00:00.000Z', '2026-08-08T09:00:00.000Z'
      );
    `);
    legacy.close();

    const store = new SpatialLayerStateStore(path);
    expect((store.db.prepare("PRAGMA table_info(spatial_inference_jobs)").all() as Array<{ name: string }>)
      .some((column) => column.name === "session_id")).toBe(true);
    const host = {
      partition,
      ensureAllScopeDefaults: () => [scope],
      cancelScope: vi.fn(),
    } as unknown as EngineHost;
    new SpatialLayerScheduler({ host, state: store, now: () => new Date("2026-08-08T09:01:00.000Z") }).initialize();

    expect(store.getJob(partition, "legacy-job")).toMatchObject({
      status: "cancelled",
      sessionId: null,
    });
    expect(store.db.prepare("SELECT value FROM spatial_metadata WHERE key = 'schema_version'").get()).toEqual({ value: "2" });
    store.close();
  });

  it("defers without consuming an attempt when host admission is unavailable", async () => {
    const store = new SpatialLayerStateStore(":memory:");
    let now = new Date("2026-08-08T09:00:00.000Z");
    let allowed = false;
    const release = vi.fn();
    const admission: SpatialInferenceAdmission = {
      async acquire() {
        return allowed ? { release } : null;
      },
    };
    const inferScope = vi.fn(async () => ({
      scope,
      bucketAt: now.toISOString(),
      status: "succeeded" as const,
      snapshots: [],
      failures: [],
    }));
    const host = {
      partition,
      ensureAllScopeDefaults: () => [scope],
      ensureScopeDefaults: () => ({ configuration: {}, assignments: [] }),
      cancelScope: vi.fn(),
      inferScope,
    } as unknown as EngineHost;
    const scheduler = new SpatialLayerScheduler({
      host,
      state: store,
      admission,
      admissionRetryMs: 15_000,
      now: () => now,
    });

    const session = scheduler.startHouseSession({ houseId: scope.id });
    await scheduler.tick();
    const deferred = store.db.prepare("SELECT id FROM spatial_inference_jobs WHERE session_id = ?").get(session.id) as { id: string };
    expect(store.getJob(partition, deferred.id)).toMatchObject({ status: "pending", attempts: 0 });
    expect(inferScope).not.toHaveBeenCalled();

    allowed = true;
    now = new Date("2026-08-08T09:00:15.000Z");
    await scheduler.tick();
    expect(store.getJob(partition, deferred.id)?.status).toBe("done");
    expect(inferScope).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();

    await scheduler.stop();
    store.close();
  });

  it("releases the shared governor lease when the post-admission session refresh fails", async () => {
    const store = new SpatialLayerStateStore(":memory:");
    const now = new Date("2026-08-08T09:00:00.000Z");
    const limiter = new AnalyticsWorkLimiter({ maxConcurrent: 2, maxQueued: 4 });
    const release = vi.fn();
    let queuedWork: Promise<string> | null = null;
    const admission: SpatialInferenceAdmission = {
      async acquire() {
        const governorLease = await limiter.acquireLowPriority("spatial-inference", () => true);
        if (!governorLease) return null;
        queuedWork = limiter.runLowPriority("queued-derived-work", () => "continued");
        return {
          async release() {
            release();
            await governorLease.release();
          },
        };
      },
    };
    const inferScope = vi.fn(async () => ({
      scope,
      bucketAt: now.toISOString(),
      status: "succeeded" as const,
      snapshots: [],
      failures: [],
    }));
    const host = {
      partition,
      ensureAllScopeDefaults: () => [scope],
      ensureScopeDefaults: () => ({ configuration: {}, assignments: [] }),
      cancelScope: vi.fn(),
      inferScope,
    } as unknown as EngineHost;
    const scheduler = new SpatialLayerScheduler({ host, state: store, admission, now: () => now });
    scheduler.startHouseSession({ houseId: scope.id });

    const readSession = store.getInferenceSession.bind(store);
    let sessionLookups = 0;
    vi.spyOn(store, "getInferenceSession").mockImplementation((...args) => {
      sessionLookups += 1;
      if (sessionLookups === 2) throw new Error("simulated post-admission state failure");
      return readSession(...args);
    });

    await scheduler.tick();
    expect(release).toHaveBeenCalledOnce();
    expect(queuedWork).not.toBeNull();
    await expect(queuedWork!).resolves.toBe("continued");
    expect(limiter.snapshot()).toMatchObject({ active: 0, lowPriorityActive: 0, queued: 0 });
    expect(inferScope).not.toHaveBeenCalled();

    await scheduler.stop();
    store.close();
  });

  it("cancels in-flight inference when the Home session stops", async () => {
    let began: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const blocking: SpatialLayerEngine = {
      manifest: {
        id: "climate-scalars",
        version: "1.0.0",
        maturity: "stable",
        title: "Blocking test",
        description: "Blocking test",
        supportedScopes: ["house"],
        requiredMetrics: [],
        producedLayerIds: ["test.blocking"],
      },
      infer() {
        began?.();
        return new Promise(() => undefined);
      },
    };
    const { runtime, core } = seededRuntime(new SpatialLayerEngineRegistry().register(blocking));
    const house = core.listHouses()[0]!;
    const houseScope = { kind: "house" as const, id: house.id };
    runtime.scheduler.startHouseSession({ houseId: house.id });

    const tick = runtime.scheduler.tick();
    await started;
    expect(runtime.scheduler.stopHouseSession(house.id)?.status).toBe("stopped");
    await tick;

    expect(runtime.state.currentSnapshots(runtime.host.partition, houseScope)).toEqual([]);
    expect(runtime.state.latestRun(runtime.host.partition, houseScope, "climate-scalars")).toMatchObject({
      status: "skipped",
      errorCode: "ENGINE_ABORTED",
    });
    expect(runtime.state.db.prepare("SELECT DISTINCT status FROM spatial_inference_jobs").all()).toEqual([
      { status: "cancelled" },
    ]);
  });

  it("keeps sessions durable across a state-store restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "stugu-spatial-session-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "spatial.sqlite");
    const first = new SpatialLayerStateStore(path);
    const session = first.startInferenceSession({
      partition,
      houseId: scope.id,
      durationMinutes: 60,
      cadenceMinutes: 10,
      now: "2026-08-08T09:00:00.000Z",
    });
    const scheduled = first.scheduleDueInferenceSessions(partition, "2026-08-08T09:00:00.000Z")[0]!;
    expect(first.claimDueJobs(partition, "2026-08-08T09:00:00.000Z", 1)[0]?.id).toBe(scheduled.id);
    first.startRun({
      partition,
      scope,
      engineId: "climate-scalars",
      engineVersion: "1.0.0",
      bucketAt: "2026-08-08T09:00:00.000Z",
      configVersion: 1,
      startedAt: "2026-08-08T09:00:00.000Z",
    });
    const persistedSession = first.getInferenceSession(partition, session.id);
    first.close();

    const reopened = new SpatialLayerStateStore(path);
    expect(reopened.latestInferenceSession(partition, scope.id)).toEqual(persistedSession);
    const host = {
      partition,
      ensureAllScopeDefaults: () => [scope],
      cancelScope: vi.fn(),
    } as unknown as EngineHost;
    new SpatialLayerScheduler({ host, state: reopened, now: () => new Date("2026-08-08T09:01:00.000Z") }).initialize();
    expect(reopened.getJob(partition, scheduled.id)).toMatchObject({
      status: "pending",
      lockToken: null,
      availableAt: "2026-08-08T09:01:00.000Z",
    });
    expect(reopened.latestRun(partition, scope, "climate-scalars")).toMatchObject({
      status: "failed",
      finishedAt: "2026-08-08T09:01:00.000Z",
      errorCode: "ENGINE_INTERRUPTED",
    });
    reopened.close();
  });
});
