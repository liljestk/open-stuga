import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataMode } from "@climate-twin/contracts";
import { AdaptiveCollectionWorker } from "../src/analytics/adaptive-monitoring/collection-worker.js";
import { AdaptiveClimateArtifacts } from "../src/analytics/adaptive-monitoring/climate-artifacts.js";
import { AdaptiveClimateLedger } from "../src/analytics/adaptive-monitoring/climate-ledger.js";
import { adaptiveQualificationWindow } from "../src/analytics/adaptive-monitoring/evidence.js";
import { qualifyAdaptiveClimateModel, type QualificationInput } from "../src/analytics/adaptive-monitoring/climate-qualification.js";
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

  it("automatically evaluates a mature cohort once and preserves the report across worker restarts", async () => {
    createHome();
    addStream("model-target");
    enable("demo");
    const scope = { houseId: homeId, sensorId: "model-target", dataMode: "demo", metric: "temperature", purpose: "climate" } as const;
    const epoch = database.ensureAdaptiveEvidenceEpoch(scope)!;
    const window = adaptiveQualificationWindow(Date.parse(epoch.effectiveAt));
    const insert = database.db.prepare(`INSERT INTO adaptive_hourly_evidence
      (epoch_id, hour, captured_at, value, coverage, observation_source) VALUES (?, ?, ?, ?, 1, 'mock')`);
    for (let time = window.from; time < window.to; time += HOUR_MS) {
      const index = (time - window.from) / HOUR_MS;
      insert.run(epoch.id, time, time + HOUR_MS + 2_000, 18 + index / 48 + 4 * Math.sin(index * Math.PI / 12));
    }
    vi.setSystemTime(window.to - 1);
    await worker.runOnce();
    const artifacts = new AdaptiveClimateArtifacts(database);
    expect(artifacts.read(scope)).toBeNull();
    const target = window.to + HOUR_MS;
    const ledger = new AdaptiveClimateLedger(database, artifacts);
    const targetWindow = { from: target, to: target + HOUR_MS };
    expect(ledger.read(scope, targetWindow)).toEqual([]);
    vi.setSystemTime(window.to + 5_000);
    await worker.runOnce();
    const stored = artifacts.read(scope);
    expect(worker.status().qualifications).toBe(1);
    expect(stored).toMatchObject({
      epochId: epoch.id, evaluatedThrough: window.to, inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      report: { state: "technical-pass", advisoryEligible: false },
    });
    const [prediction] = ledger.read(scope, targetWindow);
    expect(prediction).toMatchObject({
      target_hour: target, issued_at: Date.now(), recorded_at: Date.now(), artifact_cutoff: window.to,
      persistence: expect.any(Number), seasonal: expect.any(Number), prediction: expect.any(Number), observed: null,
    });
    const restarted = new AdaptiveCollectionWorker({ database, limiter, admit });
    await restarted.runOnce();
    await restarted.stop();
    expect(restarted.status().qualifications).toBe(0);
    expect(artifacts.read(scope)).toEqual(stored);
    expect(ledger.read(scope, targetWindow)).toEqual([prediction]);
    vi.setSystemTime(target + HOUR_MS - 1);
    expect(ledger.advance(epoch).outcomes).toBe(0);
    const availableAt = target + HOUR_MS + 2_000;
    vi.setSystemTime(availableAt);
    insert.run(epoch.id, target, availableAt, 22.5);
    await worker.runOnce();
    const [scored] = ledger.read(scope, targetWindow);
    expect(scored).toMatchObject({ ...prediction, scored_at: availableAt, observed_at: availableAt, observed: 22.5, gap_reason: null });
    expect(ledger.advance(epoch).outcomes).toBe(0);
    expect(ledger.read(scope, targetWindow)).toEqual([scored]);
    const nextHour = target + HOUR_MS;
    const gapAt = nextHour + HOUR_MS + 2_000;
    vi.setSystemTime(gapAt);
    database.db.prepare(`INSERT INTO adaptive_hourly_evidence
      (epoch_id, hour, captured_at, coverage, gap_reason) VALUES (?, ?, ?, 0, 'missing')`)
      .run(epoch.id, nextHour, gapAt);
    expect(ledger.advance(epoch).outcomes).toBe(1);
    expect(ledger.read(scope, { from: nextHour, to: nextHour + HOUR_MS })).toMatchObject([
      { observed: null, observed_at: gapAt, gap_reason: "missing" },
    ]);
    expect(() => database.db.prepare("UPDATE adaptive_climate_predictions SET prediction = 0").run()).toThrow("immutable");
    expect(() => database.db.prepare("UPDATE adaptive_climate_outcomes SET observed = 0").run()).toThrow("immutable");
    database.activateRealDataMode();
    expect(database.db.prepare("SELECT count(*) AS count FROM adaptive_climate_artifacts").get()).toEqual({ count: 0 });
    expect(database.db.prepare("SELECT count(*) AS count FROM adaptive_climate_predictions").get()).toEqual({ count: 0 });
    expect(database.db.prepare("SELECT count(*) AS count FROM adaptive_climate_outcomes").get()).toEqual({ count: 0 });
  });

  it("discards a calculation whose epoch changes before publication and can evaluate a new cohort after low coverage", async () => {
    createHome();
    addStream("changed-target");
    enable("demo");
    const scope = { houseId: homeId, sensorId: "changed-target", dataMode: "demo", metric: "temperature", purpose: "climate" } as const;
    const old = database.ensureAdaptiveEvidenceEpoch(scope)!;
    vi.setSystemTime(adaptiveQualificationWindow(Date.parse(old.effectiveAt)).to);
    const staleWriter = new AdaptiveClimateArtifacts(database, async (input: QualificationInput) => {
      database.updateSensor(scope.sensorId, { x: 2 });
      return qualifyAdaptiveClimateModel(input);
    });
    const signal = new AbortController().signal;
    expect(await staleWriter.evaluate(old, signal)).toBe(false);
    expect(staleWriter.read(scope)).toBeNull();
    const epoch = database.ensureAdaptiveEvidenceEpoch(scope)!;
    const window = adaptiveQualificationWindow(Date.parse(epoch.effectiveAt));
    const artifacts = new AdaptiveClimateArtifacts(database);
    vi.setSystemTime(window.to);
    expect(await artifacts.evaluate(epoch, signal)).toBe(true);
    expect(artifacts.read(scope)?.report.state).toBe("collecting");
    vi.setSystemTime(window.to + (window.to - window.from));
    expect(await artifacts.evaluate(epoch, signal)).toBe(true);
    expect(artifacts.read(scope)?.evaluatedThrough).toBe(Date.now());
    expect(await artifacts.evaluate(epoch, signal)).toBe(false);
  });

  it("qualifies the thermal candidate from sealed live weather and issues a prospective prediction", async () => {
    database.activateRealDataMode();
    createHome();
    addStream("weather-target");
    enable("live");
    const scope = { houseId: homeId, sensorId: "weather-target", dataMode: "live", metric: "temperature", purpose: "climate" } as const;
    const epoch = database.ensureAdaptiveEvidenceEpoch(scope)!;
    const window = adaptiveQualificationWindow(Date.parse(epoch.effectiveAt));
    const insert = database.db.prepare(`INSERT INTO adaptive_hourly_evidence
      (epoch_id, hour, captured_at, value, coverage, observation_source) VALUES (?, ?, ?, ?, 1, 'api')`);
    const weather = database.db.prepare(`INSERT INTO adaptive_weather_hours
      (epoch_id, hour, temperature_c, observed_at, fetched_at, recorded_at, source) VALUES (?, ?, ?, ?, ?, ?, 'open-meteo-current')`);
    let inside = 17;
    for (let time = window.from; time < window.to; time += HOUR_MS) {
      const index = (time - window.from) / HOUR_MS;
      const outside = 5 + 9 * Math.sin(index / 26) + 3 * Math.sin(index / 11);
      const stamp = new Date(time).toISOString();
      insert.run(epoch.id, time, time + HOUR_MS + 2_000, inside);
      weather.run(epoch.id, time, outside, stamp, stamp, stamp);
      inside = 0.85 * inside + 0.15 * (outside + 12);
    }
    const issued = window.to + 5_000;
    vi.setSystemTime(issued);
    await worker.runOnce();
    const artifacts = new AdaptiveClimateArtifacts(database);
    expect(artifacts.read(scope)).toMatchObject({
      basis: "sqlite-sealed-indoor-and-weather",
      report: { state: "technical-pass", candidates: [expect.objectContaining({ policy: expect.objectContaining({ kind: "thermal-relaxation" }) }), expect.anything()] },
    });
    const ledger = new AdaptiveClimateLedger(database, artifacts);
    expect(ledger.read(scope, { from: window.to + HOUR_MS, to: window.to + 2 * HOUR_MS })).toMatchObject([
      { issued_at: issued, target_hour: window.to + HOUR_MS, prediction: expect.any(Number), observed: null },
    ]);
  });
});
