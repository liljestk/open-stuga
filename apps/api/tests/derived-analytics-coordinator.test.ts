import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_VERSION, type ThermalIsolationResult } from "@climate-twin/contracts";
import { AnalyticsWorkLimiter } from "../src/analytics/work-limiter.js";
import { DerivedAnalyticsCoordinator } from "../src/analytics/derived-artifacts/coordinator.js";
import { canonicalWindowDays, lastCompleteDayCutoff } from "../src/analytics/derived-artifacts/compute.js";
import { ClimateDatabase } from "../src/db.js";
import { DataModeCoordinator } from "../src/services.js";
import type { HybridTelemetryReader } from "../src/timeseries/read-facade.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function database(path: string): ClimateDatabase {
  const value = new ClimateDatabase(path, false);
  value.createHouse({
    id: "home-a",
    name: "Home A",
    timezone: "UTC",
    floors: [{
      id: "floor-a", name: "Ground", width: 8, height: 8, elevation: 0, walls: [],
      rooms: [{
        id: "room-a", name: "Room A",
        points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }, { x: 0, y: 8 }],
      }],
    }],
  });
  value.createSensor({
    id: "sensor-a", houseId: "home-a", floorId: "floor-a", roomId: "room-a",
    room: "Room A", name: "Sensor A", model: "T310", x: 1, y: 1, z: 1,
    tags: [], enabled: true,
  });
  return value;
}

function result(generatedAt: string): ThermalIsolationResult {
  return {
    generatedAt,
    systemVersion: SYSTEM_VERSION,
    houseId: "home-a",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-08T00:00:00.000Z",
    entries: [],
    insights: [],
    methodology: {
      scoreMethod: "modeled-24h-retention-v1",
      aggregationMethod: "median-child-score-v1",
      interpretation: "Test",
      limitations: [],
    },
  };
}

const fakeTelemetryReader = {} as HybridTelemetryReader;

describe("durable derived analytics coordinator", () => {
  it("falls back to immutable last-good when newer artifact rows are corrupt or oversized", async () => {
    const db = database(":memory:");
    const now = new Date("2026-08-08T12:00:00.000Z");
    const coordinator = new DerivedAnalyticsCoordinator(
      db,
      fakeTelemetryReader,
      new AnalyticsWorkLimiter({ maxConcurrent: 1 }),
      { now: () => now, compute: async () => result(now.toISOString()) },
    );
    coordinator.refresh({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    });
    await coordinator.drainOnce();
    const good = coordinator.read<ThermalIsolationResult>({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    });
    const copyArtifact = db.db.prepare(`INSERT INTO derived_analytics_artifacts (
        identity_key, kind, house_id, data_mode, window_days, cutoff,
        algorithm_version, evidence_version, generated_at, result_json
      ) SELECT identity_key, kind, house_id, data_mode, window_days, cutoff,
        algorithm_version, evidence_version, ?, ?
      FROM derived_analytics_artifacts WHERE id = ?`);
    copyArtifact.run(
      "2026-08-08T12:01:00.000Z",
      JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }),
      good.artifact!.id,
    );
    db.db.exec("PRAGMA ignore_check_constraints = ON");
    copyArtifact.run("2026-08-08T12:02:00.000Z", "{", good.artifact!.id);
    db.db.exec("PRAGMA ignore_check_constraints = OFF");

    expect(() => coordinator.read({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    })).not.toThrow();
    expect(coordinator.read<ThermalIsolationResult>({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    })).toMatchObject({
      state: "ready",
      stale: false,
      artifact: { id: good.artifact!.id },
      result: { generatedAt: now.toISOString() },
    });
    db.close();
  });

  it("invalidates late imported history but ignores routine samples after the evaluated cutoff", async () => {
    const db = database(":memory:");
    db.activateRealDataMode();
    const now = new Date("2026-08-08T12:00:00.000Z");
    const coordinator = new DerivedAnalyticsCoordinator(
      db,
      fakeTelemetryReader,
      new AnalyticsWorkLimiter({ maxConcurrent: 1 }),
      { now: () => now, compute: async () => result(now.toISOString()) },
    );
    coordinator.refresh({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "live", windowDays: 7,
    });
    await coordinator.drainOnce();
    const unit = db.getMeasurementDefinition("temperature")!.unit;
    db.insertMeasurementSamples([{
      sensorId: "sensor-a", metric: "temperature", value: 21, canonicalUnit: unit,
      timestamp: "2026-08-08T10:00:00.000Z", source: "api", quality: "good",
    }]);
    expect(coordinator.read({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "live", windowDays: 7,
    })).toMatchObject({ state: "ready", stale: false });

    db.insertMeasurementSamples([{
      sensorId: "sensor-a", metric: "temperature", value: 20, canonicalUnit: unit,
      timestamp: "2026-08-07T10:00:00.000Z", source: "import", quality: "good",
    }]);
    expect(coordinator.read({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "live", windowDays: 7,
    })).toMatchObject({ state: "idle", stale: true });
    expect(coordinator.snapshot()).toMatchObject({ pending: 0, artifacts: 1 });
    db.close();
  });

  it("guards appliance startup and drains persisted jobs only after explicit use or at night", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stugu-derived-startup-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "climate.sqlite");
    let now = new Date("2026-08-08T12:00:00.000Z");
    const initialDatabase = database(path);
    const initial = new DerivedAnalyticsCoordinator(
      initialDatabase,
      fakeTelemetryReader,
      new AnalyticsWorkLimiter({ maxConcurrent: 1 }),
      { now: () => now, compute: async () => result(now.toISOString()) },
    );
    initial.refresh({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    });
    initial.refresh({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 14,
    });
    initialDatabase.close();

    const reopened = new ClimateDatabase(path, false);
    const compute = vi.fn(async () => result(now.toISOString()));
    const restarted = new DerivedAnalyticsCoordinator(
      reopened,
      fakeTelemetryReader,
      new AnalyticsWorkLimiter({ maxConcurrent: 1 }),
      { now: () => now, compute },
    );
    expect(await restarted.drainOnce()).toBe(false);
    expect(compute).not.toHaveBeenCalled();

    // Only the authorized refresh endpoint promotes a coalesced identity.
    restarted.refresh({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    });
    expect(await restarted.drainOnce()).toBe(true);
    expect(compute).toHaveBeenCalledTimes(1);

    // The remaining persisted background identity becomes eligible during
    // every Home's stable, bounded 01:30-05:00 local maintenance window.
    now = new Date("2026-08-09T04:45:00.000Z");
    expect(await restarted.drainOnce()).toBe(true);
    expect(compute).toHaveBeenCalledTimes(2);
    reopened.close();
  });

  it("seeds only the canonical daily defaults in the stable Home night window", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-08-09T04:45:00.000Z");
    vi.setSystemTime(now);
    const db = database(":memory:");
    const coordinator = new DerivedAnalyticsCoordinator(
      db,
      fakeTelemetryReader,
      new AnalyticsWorkLimiter({ maxConcurrent: 1 }),
      { now: () => now, compute: async () => result(now.toISOString()) },
    );
    coordinator.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(db.db.prepare(`SELECT kind, window_days FROM derived_analytics_jobs
      ORDER BY kind`).all()).toEqual([
      { kind: "home-performance", window_days: 30 },
      { kind: "moisture-response", window_days: 7 },
      { kind: "thermal-isolation", window_days: 7 },
    ]);
    await coordinator.stop();
    db.close();
  });

  it("does not let an explicit wake shorten the appliance startup grace", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T12:00:00.000Z"));
    const db = database(":memory:");
    const now = new Date("2026-08-08T12:00:00.000Z");
    const compute = vi.fn(async () => result(now.toISOString()));
    const coordinator = new DerivedAnalyticsCoordinator(
      db,
      fakeTelemetryReader,
      new AnalyticsWorkLimiter({ maxConcurrent: 1 }),
      { now: () => now, compute },
    );
    coordinator.refresh({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    });
    coordinator.start();
    coordinator.wake();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(compute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(compute).toHaveBeenCalledTimes(1);
    await coordinator.stop();
    db.close();
  });

  it("preserves immutable last-good across restart and refresh failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stugu-derived-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "climate.sqlite");
    const now = new Date("2026-08-08T12:00:00.000Z");
    const firstDatabase = database(path);
    const compute = vi.fn(async () => result(now.toISOString()));
    const first = new DerivedAnalyticsCoordinator(
      firstDatabase,
      fakeTelemetryReader,
      new AnalyticsWorkLimiter({ maxConcurrent: 1 }),
      { now: () => now, compute },
    );

    for (let index = 0; index < 20; index += 1) {
      expect(first.read({
        kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
      }).state).toBe("idle");
    }
    expect(first.snapshot()).toEqual({ pending: 0, running: 0, artifacts: 0 });
    expect(compute).not.toHaveBeenCalled();
    expect(first.refresh({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    }).state).toBe("queued");
    await first.drainOnce();
    expect(first.read<ThermalIsolationResult>({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    }).result?.generatedAt).toBe(now.toISOString());
    firstDatabase.close();

    const reopened = new ClimateDatabase(path, false);
    const failed = new DerivedAnalyticsCoordinator(
      reopened,
      fakeTelemetryReader,
      new AnalyticsWorkLimiter({ maxConcurrent: 1 }),
      { now: () => now, compute: async () => { throw new Error("fit failed"); } },
    );
    const queued = failed.refresh<ThermalIsolationResult>({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    });
    expect(queued.result?.generatedAt).toBe(now.toISOString());
    await failed.drainOnce();
    const afterFailure = failed.read<ThermalIsolationResult>({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    });
    expect(afterFailure.state).toBe("failed");
    expect(afterFailure.result?.generatedAt).toBe(now.toISOString());
    expect(afterFailure.job?.errorMessage).toBe("fit failed");
    reopened.close();
  });

  it("resets the retry budget for every forced refresh lifecycle", async () => {
    const db = database(":memory:");
    const now = new Date("2026-08-08T12:00:00.000Z");
    let fail = false;
    const coordinator = new DerivedAnalyticsCoordinator(
      db,
      fakeTelemetryReader,
      new AnalyticsWorkLimiter({ maxConcurrent: 1 }),
      {
        now: () => now,
        compute: async () => {
          if (fail) throw new Error("transient fit failure");
          return result(now.toISOString());
        },
      },
    );
    const input = {
      kind: "thermal-isolation" as const,
      houseId: "home-a",
      dataMode: "demo" as const,
      windowDays: 7,
    };

    for (let cycle = 0; cycle < 3; cycle += 1) {
      coordinator.refresh(input);
      await coordinator.drainOnce();
      expect(coordinator.read(input).job?.attemptCount).toBe(1);
    }

    fail = true;
    coordinator.refresh(input);
    await coordinator.drainOnce();
    expect(coordinator.read(input).job).toMatchObject({
      attemptCount: 1,
      errorMessage: "transient fit failure",
      nextAttemptAt: expect.any(String),
    });
    db.close();
  });

  it.each([
    "HOME_PERFORMANCE_SCOPE_TOO_LARGE",
    "THERMAL_SCOPE_TOO_LARGE",
    "MOISTURE_SCOPE_TOO_LARGE",
    "DERIVED_ARTIFACT_TOO_LARGE",
  ])("does not retry deterministic failure %s", async (code) => {
    const db = database(":memory:");
    const now = new Date("2026-08-08T12:00:00.000Z");
    const compute = vi.fn(async () => {
      throw Object.assign(new Error("deterministic failure"), { code });
    });
    const coordinator = new DerivedAnalyticsCoordinator(
      db,
      fakeTelemetryReader,
      new AnalyticsWorkLimiter({ maxConcurrent: 1 }),
      { now: () => now, compute },
    );
    const input = {
      kind: "thermal-isolation" as const,
      houseId: "home-a",
      dataMode: "demo" as const,
      windowDays: 7,
    };

    coordinator.refresh(input);
    expect(await coordinator.drainOnce()).toBe(true);
    expect(coordinator.read(input)).toMatchObject({
      state: "failed",
      job: { errorCode: code, nextAttemptAt: null, attemptCount: 1 },
    });
    expect(await coordinator.drainOnce()).toBe(false);
    expect(compute).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("does not persist a fitter result that resolves after coordinator stop", async () => {
    const db = database(":memory:");
    const now = new Date("2026-08-08T12:00:00.000Z");
    let releaseCompute!: () => void;
    const computeReleased = new Promise<void>((resolve) => { releaseCompute = resolve; });
    let reportStarted!: () => void;
    const computeStarted = new Promise<void>((resolve) => { reportStarted = resolve; });
    let observedSignal: AbortSignal | undefined;
    const coordinator = new DerivedAnalyticsCoordinator(
      db,
      fakeTelemetryReader,
      new AnalyticsWorkLimiter({ maxConcurrent: 1 }),
      {
        now: () => now,
        compute: async (_job, signal) => {
          observedSignal = signal;
          reportStarted();
          // Deliberately ignore cancellation until returning to exercise the
          // coordinator's final publication fence.
          await computeReleased;
          return result(now.toISOString());
        },
      },
    );
    coordinator.refresh({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    });

    const draining = coordinator.drainOnce();
    await computeStarted;
    const stopping = coordinator.stop();
    expect(observedSignal?.aborted).toBe(true);
    releaseCompute();
    await Promise.all([draining, stopping]);

    expect(coordinator.snapshot()).toEqual({ pending: 1, running: 0, artifacts: 0 });
    expect(db.db.prepare(`SELECT status, started_at, error_code
      FROM derived_analytics_jobs`).get()).toEqual({
      status: "pending",
      started_at: null,
      error_code: "DERIVED_ANALYTICS_INTERRUPTED",
    });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM derived_analytics_artifacts").get())
      .toEqual({ count: 0 });
    db.close();
  });

  it("does not claim a live job when activation aborts delayed admission", async () => {
    const db = database(":memory:");
    const now = new Date("2026-08-08T12:00:00.000Z");
    let reportAdmissionStarted!: () => void;
    const admissionStarted = new Promise<void>((resolve) => {
      reportAdmissionStarted = resolve;
    });
    let releaseAdmission!: () => void;
    const admissionReleased = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let admissionCalls = 0;
    const compute = vi.fn(async () => result(now.toISOString()));
    const coordinator = new DerivedAnalyticsCoordinator(
      db,
      fakeTelemetryReader,
      new AnalyticsWorkLimiter({ maxConcurrent: 1 }),
      {
        now: () => now,
        compute,
        admitLowPriority: async () => {
          admissionCalls += 1;
          if (admissionCalls === 1) {
            reportAdmissionStarted();
            await admissionReleased;
          }
          return true;
        },
      },
    );
    const dataMode = new DataModeCoordinator(db);
    dataMode.onActivated(() => coordinator.handleDataModeActivated());
    coordinator.refresh({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    });

    const draining = coordinator.drainOnce();
    await admissionStarted;
    dataMode.activate();
    coordinator.refresh({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "live", windowDays: 7,
    });
    releaseAdmission();

    expect(await draining).toBe(false);
    expect(compute).not.toHaveBeenCalled();
    expect(coordinator.snapshot()).toEqual({ pending: 1, running: 0, artifacts: 0 });
    expect(coordinator.read({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "live", windowDays: 7,
    })).toMatchObject({ state: "queued", job: { startedAt: null, attemptCount: 0 } });

    expect(await coordinator.drainOnce()).toBe(true);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(coordinator.read({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "live", windowDays: 7,
    })).toMatchObject({ state: "ready", stale: false });
    db.close();
  });

  it("aborts active demo work and purges its durable state on real-mode activation", async () => {
    const db = database(":memory:");
    const now = new Date("2026-08-08T12:00:00.000Z");
    let releaseRefresh!: () => void;
    const refreshReleased = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let reportStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { reportStarted = resolve; });
    let calls = 0;
    let observedSignal: AbortSignal | undefined;
    const coordinator = new DerivedAnalyticsCoordinator(
      db,
      fakeTelemetryReader,
      new AnalyticsWorkLimiter({ maxConcurrent: 1 }),
      {
        now: () => now,
        compute: async (_job, signal) => {
          calls += 1;
          if (calls === 2) {
            observedSignal = signal;
            reportStarted();
            await refreshReleased;
          }
          return result(now.toISOString());
        },
      },
    );
    const dataMode = new DataModeCoordinator(db);
    dataMode.onActivated(() => coordinator.handleDataModeActivated());
    coordinator.refresh({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    });
    await coordinator.drainOnce();
    expect(coordinator.snapshot().artifacts).toBe(1);
    coordinator.refresh({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    });

    const draining = coordinator.drainOnce();
    await refreshStarted;
    dataMode.activate();
    expect(observedSignal?.aborted).toBe(true);
    releaseRefresh();
    await draining;

    expect(db.isRealDataMode()).toBe(true);
    expect(db.db.prepare(`SELECT COUNT(*) AS count FROM derived_analytics_jobs
      WHERE data_mode = 'demo'`).get()).toEqual({ count: 0 });
    expect(db.db.prepare(`SELECT COUNT(*) AS count FROM derived_analytics_artifacts
      WHERE data_mode = 'demo'`).get()).toEqual({ count: 0 });
    expect(() => coordinator.read({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    })).toThrow(/while live data is active/);

    coordinator.refresh({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "live", windowDays: 7,
    });
    expect(await coordinator.drainOnce()).toBe(true);
    expect(coordinator.read({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "live", windowDays: 7,
    })).toMatchObject({ state: "ready", stale: false });
    db.close();
  });

  it("rechecks data mode before publish even when activation notification is delayed", async () => {
    const db = database(":memory:");
    const now = new Date("2026-08-08T12:00:00.000Z");
    let releaseCompute!: () => void;
    const computeReleased = new Promise<void>((resolve) => { releaseCompute = resolve; });
    let reportStarted!: () => void;
    const computeStarted = new Promise<void>((resolve) => { reportStarted = resolve; });
    const coordinator = new DerivedAnalyticsCoordinator(
      db,
      fakeTelemetryReader,
      new AnalyticsWorkLimiter({ maxConcurrent: 1 }),
      {
        now: () => now,
        compute: async () => {
          reportStarted();
          await computeReleased;
          return result(now.toISOString());
        },
      },
    );
    coordinator.refresh({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    });

    const draining = coordinator.drainOnce();
    await computeStarted;
    // Simulate another process latching the shared SQLite database before this
    // process receives its DataModeCoordinator notification.
    db.activateRealDataMode();
    releaseCompute();
    await draining;

    expect(db.db.prepare("SELECT COUNT(*) AS count FROM derived_analytics_artifacts").get())
      .toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM derived_analytics_jobs").get())
      .toEqual({ count: 0 });
    db.close();
  });

  it("never claims a persisted job whose mode differs from the active database", async () => {
    const db = database(":memory:");
    const now = new Date("2026-08-08T12:00:00.000Z");
    const compute = vi.fn(async () => result(now.toISOString()));
    const coordinator = new DerivedAnalyticsCoordinator(
      db,
      fakeTelemetryReader,
      new AnalyticsWorkLimiter({ maxConcurrent: 1 }),
      { now: () => now, compute },
    );
    coordinator.refresh({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    });
    // Fault injection: emulate an external mode latch whose purge notification
    // has not yet been observed by this process.
    db.db.prepare(`INSERT INTO metadata(key, value) VALUES ('data_mode', 'real')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();

    expect(await coordinator.drainOnce()).toBe(false);
    expect(compute).not.toHaveBeenCalled();
    coordinator.handleDataModeActivated();
    expect(coordinator.snapshot()).toEqual({ pending: 0, running: 0, artifacts: 0 });
    db.close();
  });

  it("invalidates by algorithm and Home configuration while canonicalizing windows", async () => {
    const db = database(":memory:");
    const now = new Date("2026-08-08T19:30:00.000Z");
    const baseline = new DerivedAnalyticsCoordinator(
      db,
      fakeTelemetryReader,
      new AnalyticsWorkLimiter({ maxConcurrent: 1 }),
      { now: () => now, compute: async () => result(now.toISOString()) },
    );
    baseline.refresh({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    });
    await baseline.drainOnce();

    const changedAlgorithm = new DerivedAnalyticsCoordinator(
      db,
      fakeTelemetryReader,
      new AnalyticsWorkLimiter({ maxConcurrent: 1 }),
      {
        now: () => now,
        compute: async () => result(now.toISOString()),
        algorithmVersions: {
          "thermal-isolation": "thermal-isolation-v2-test",
          "moisture-response": "moisture-response-v1.0.0",
          "home-performance": "home-performance-v2.0.0",
        },
      },
    );
    const algorithmStale = changedAlgorithm.read<ThermalIsolationResult>({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    });
    expect(algorithmStale).toMatchObject({ state: "idle", stale: true });
    expect(algorithmStale.result).not.toBeNull();
    changedAlgorithm.refresh({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    });

    db.updateSensor("sensor-a", { enabled: false });
    const configStale = changedAlgorithm.read<ThermalIsolationResult>({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    });
    expect(configStale).toMatchObject({ state: "idle", stale: true });
    changedAlgorithm.refresh({
      kind: "thermal-isolation", houseId: "home-a", dataMode: "demo", windowDays: 7,
    });
    expect(changedAlgorithm.snapshot().pending).toBe(2);
    expect(canonicalWindowDays("thermal-isolation", undefined)).toBe(7);
    expect(() => canonicalWindowDays("thermal-isolation", 6)).toThrow(/1, 7, or 14/);
    expect(lastCompleteDayCutoff(now)).toBe("2026-08-08T00:00:00.000Z");
    expect(lastCompleteDayCutoff(now, "Europe/Helsinki")).toBe("2026-08-07T21:00:00.000Z");
    db.close();
  });
});
