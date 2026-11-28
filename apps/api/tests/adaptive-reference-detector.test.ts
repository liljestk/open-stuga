import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdaptiveEvidenceScope } from "@climate-twin/contracts";
import { AdaptiveCollectionWorker } from "../src/analytics/adaptive-monitoring/collection-worker.js";
import { adaptiveQualificationWindow } from "../src/analytics/adaptive-monitoring/evidence.js";
import { assessReferenceDay, pairTemperatures, qualifyReferencePairs } from "../src/analytics/adaptive-monitoring/reference-policy.js";
import { HOUR_MS } from "../src/analytics/forecast/models.js";
import { AnalyticsWorkLimiter } from "../src/analytics/work-limiter.js";
import { ClimateDatabase } from "../src/db.js";

const scope: AdaptiveEvidenceScope = { houseId: "house-main", sensorId: "comparison-target",
  dataMode: "demo", metric: "temperature", purpose: "climate" };
const peerIds = ["comparison-peer-a", "comparison-peer-b"];

describe("Adaptive Home temperature reference comparison", () => {
  let database: ClimateDatabase;
  let worker: AdaptiveCollectionWorker;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    database = new ClimateDatabase(":memory:");
    worker = new AdaptiveCollectionWorker({
      database, limiter: new AnalyticsWorkLimiter({ maxConcurrent: 1, maxQueued: 4 }), admit: () => true,
    });
  });
  afterEach(async () => {
    await worker.stop();
    database.close();
    vi.useRealTimers();
  });

  it("qualifies an approved group, preserves stale episodes during peer disagreement, and resolves on a good day", async () => {
    const ids = [scope.sensorId, ...peerIds];
    const floorId = database.getHouse(scope.houseId)!.floors[0]!.id;
    for (const id of ids) database.createSensor({
      id, houseId: scope.houseId, floorId, name: id, room: "", x: 1, y: 1, z: 1, tags: [], enabled: true, model: "Test",
      temperatureEntityId: `sensor.${id}`,
    });
    const write = { houseId: scope.houseId, actorUserId: "test-owner" };
    database.changeAdaptiveMonitoringSettings({ ...write, change: { action: "set-mode", mode: "shadow", dataMode: "demo", baseRevision: 0 } });
    database.changeAdaptiveMonitoringSettings({ ...write, change: {
      action: "set-reference-groups", dataMode: "demo", baseRevision: 1,
      referenceGroups: [{ targetSensorId: scope.sensorId, kind: "peers", referenceSensorIds: peerIds, placement: "Same shelf" }],
    } });
    const epoch = database.ensureAdaptiveEvidenceEpoch({ ...scope, purpose: "sensor-comparison" })!;
    const epochs = ids.map((sensorId) => database.ensureAdaptiveEvidenceEpoch({ ...scope, sensorId })!.id);
    const window = adaptiveQualificationWindow(Date.parse(epoch.effectiveAt));
    const insert = database.db.prepare(`INSERT INTO adaptive_hourly_evidence
      (epoch_id, hour, captured_at, value, coverage, observation_source) VALUES (?, ?, ?, ?, 1, 'mock')`);
    const append = (hour: number, values: number[], availableAt = hour + HOUR_MS + 2_000) => values.forEach((value, index) =>
      insert.run(epochs[index]!, hour, availableAt, value));
    for (let hour = window.from; hour < window.to; hour += HOUR_MS) append(hour, [21, 19.5, 20.5]);
    vi.setSystemTime(window.to + 5_000);
    await worker.runOnce();
    expect(worker.status().referenceQualifications).toBe(1);
    const artifact = database.db.prepare("SELECT result_json FROM adaptive_reference_artifacts WHERE epoch_id = ?").get(epoch.id);
    expect(JSON.parse(String(artifact?.result_json))).toMatchObject({
      references: peerIds, calibration: { offset: 1, peerSpreadLimit: 1, pairedHours: 167 },
    });
    const readEpisodes = () => database.db.prepare(`SELECT direction, state FROM adaptive_reference_episode_revisions
      WHERE epoch_id = ? ORDER BY revision`).all(epoch.id);
    const liveStart = window.to + HOUR_MS;
    for (let index = 0; index < 24; index++) append(liveStart + index * HOUR_MS, [23, 19.5, 20.5]);
    vi.setSystemTime(liveStart + 24 * HOUR_MS + 5_000);
    for (let pass = 0; pass < 3; pass++) await worker.runOnce();
    expect(readEpisodes()).toEqual([{ direction: "higher", state: "candidate" }]);
    const disagreement = liveStart + 24 * HOUR_MS;
    append(disagreement, [23, 19.5, 26]);
    vi.setSystemTime(disagreement + HOUR_MS + 5_000);
    await worker.runOnce();
    expect(readEpisodes().at(-1)).toEqual({ direction: "higher", state: "stale" });
    expect(database.db.prepare("SELECT reason FROM adaptive_reference_decisions WHERE epoch_id = ? AND target_hour = ?")
      .get(epoch.id, disagreement)).toEqual({ reason: "peer-disagreement" });
    for (let index = 1; index <= 24; index++) append(disagreement + index * HOUR_MS, [21, 19.5, 20.5]);
    vi.setSystemTime(disagreement + 25 * HOUR_MS + 5_000);
    for (let pass = 0; pass < 4; pass++) await worker.runOnce();
    expect(readEpisodes().at(-1)).toEqual({ direction: "higher", state: "resolved" });
    const prior = readEpisodes();
    await worker.runOnce();
    expect(readEpisodes()).toEqual(prior);
    const lateHour = disagreement + 25 * HOUR_MS;
    append(lateHour, [23, 19.5, 20.5], lateHour + 4 * HOUR_MS);
    vi.setSystemTime(lateHour + 4 * HOUR_MS + 1_000);
    await worker.runOnce();
    expect(database.db.prepare("SELECT pair_offset, reason FROM adaptive_reference_decisions WHERE epoch_id = ? AND target_hour = ?")
      .get(epoch.id, lateHour)).toEqual({ pair_offset: null, reason: "missing-pair" });
    database.activateRealDataMode();
    expect(readEpisodes()).toEqual([]);
  });

  it("requires coverage in every block and will not count late data as if it were known in calibration", () => {
    const pairs = Array.from({ length: 672 }, (_, index) => pairTemperatures({
      hour: index * HOUR_MS, availableAt: (index + 1) * HOUR_MS, target: 21, references: [20],
    }));
    expect(qualifyReferencePairs(pairs, 0).calibration).toMatchObject({ offset: 1, threshold: 0.7, pairedHours: 168 });
    for (const pair of pairs.slice(336, 378)) pair.availableAt += 168 * HOUR_MS;
    expect(qualifyReferencePairs(pairs, 0)).toEqual({ calibration: null, usableHours: [168, 168, 126, 168] });
  });

  it("requires at least 18 pairs, a fresh pair and no gap longer than two hours", () => {
    const calibration = { offset: 0, scale: 0, threshold: 0.7, peerSpreadLimit: 0, pairedHours: 140, holdoutCoverage: 1 };
    const hour = 23 * HOUR_MS;
    const complete = Array.from({ length: 24 }, (_, index) => ({
      hour: index * HOUR_MS, availableAt: (index + 1) * HOUR_MS, offset: 1.2, spread: 0,
    }));
    const gapped = complete.filter(({ hour: time }) => time < 8 * HOUR_MS || time >= 11 * HOUR_MS);
    expect(assessReferenceDay({ hour, calibration, active: null, pairs: complete })).toMatchObject({ state: "candidate", direction: "higher" });
    expect(assessReferenceDay({ hour, calibration, active: "higher", pairs: gapped })).toMatchObject({ state: "stale" });
    expect(assessReferenceDay({ hour, calibration, active: "higher", pairs: complete.slice(0, -1) })).toMatchObject({ state: "stale" });
  });
});
