import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdaptiveClimateDetector } from "../src/analytics/adaptive-monitoring/climate-detector.js";
import { CausalClimatePredictor } from "../src/analytics/adaptive-monitoring/climate-prediction.js";
import { detectProspectiveDeparture, initialDetectorState } from "../src/analytics/adaptive-monitoring/prospective-departure.js";
import { HOUR_MS, hourStart } from "../src/analytics/forecast/models.js";
import { ClimateDatabase } from "../src/db.js";

const scope = { houseId: "house-main", sensorId: "detector-fixture", dataMode: "demo", metric: "temperature", purpose: "climate" } as const;

describe("Adaptive Home shadow climate departures", () => {
  let database: ClimateDatabase;
  let epoch: NonNullable<ReturnType<ClimateDatabase["ensureAdaptiveEvidenceEpoch"]>>;
  let start: number;

  beforeEach(() => {
    database = new ClimateDatabase(":memory:");
    database.createSensor({
      id: scope.sensorId, houseId: scope.houseId, floorId: database.getHouse(scope.houseId)!.floors[0]!.id,
      name: "Fixture", room: "", x: 1, y: 1, z: 1, tags: [], enabled: true, model: "Test", temperatureEntityId: "sensor.fixture",
    });
    database.changeAdaptiveMonitoringSettings({ houseId: scope.houseId, actorUserId: "test-owner",
      change: { action: "set-mode", mode: "shadow", baseRevision: 0, dataMode: "demo" } });
    epoch = database.ensureAdaptiveEvidenceEpoch(scope)!;
    start = hourStart(Date.now()) + 2 * HOUR_MS;
    database.db.prepare(`INSERT INTO adaptive_climate_artifacts
      (epoch_id, algorithm_version, evaluated_through, recorded_at, input_digest, report_json) VALUES (?, 'test', ?, ?, '', '{}')`)
      .run(epoch.id, start - HOUR_MS, start - HOUR_MS);
  });
  afterEach(() => database.close());

  function recordOutcome(index: number, observed: number | null, frozenAt: number | null = null) {
    const hour = start + index * HOUR_MS;
    const issuedAt = hour - 10_000;
    const decidedAt = hour + HOUR_MS + 1_000;
    database.db.prepare(`INSERT INTO adaptive_climate_predictions
      (epoch_id, target_hour, issued_at, recorded_at, artifact_version, artifact_cutoff, input_digest, prediction, frozen_at)
      VALUES (?, ?, ?, ?, 'test', ?, '', 20, ?)`).run(epoch.id, hour, issuedAt, issuedAt, start - HOUR_MS, frozenAt);
    database.db.prepare(`INSERT INTO adaptive_climate_outcomes
      (epoch_id, target_hour, scored_at, observed_at, observed, gap_reason) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(epoch.id, hour, decidedAt, decidedAt, observed, observed === null ? "missing" : null);
    const detector = new AdaptiveClimateDetector(database);
    return database.transaction(() => detector.advance(epoch, decidedAt));
  }

  function episodeStates() {
    return database.db.prepare("SELECT state FROM adaptive_climate_episode_revisions ORDER BY revision").all().map((row) => row.state);
  }

  it("freezes the first breach, persists candidate and stale revisions, and requires three consecutive recovery hours", () => {
    for (let index = 0; index <= 120; index++) recordOutcome(index, 20);
    const first = recordOutcome(121, 23);
    const freeze = first.frozen!.issuedAt;
    expect(first.frozen?.calibration.count).toBe(120);
    expect(episodeStates()).toEqual([]);
    recordOutcome(122, 23);
    expect(episodeStates()).toEqual(["candidate"]);
    recordOutcome(123, null, freeze);
    expect(episodeStates()).toEqual(["candidate", "stale"]);
    recordOutcome(124, 20, freeze);
    recordOutcome(125, 20, freeze);
    expect(episodeStates()).toEqual(["candidate", "stale", "candidate"]);
    expect(recordOutcome(126, 20, freeze).frozen).toBeNull();
    expect(episodeStates()).toEqual(["candidate", "stale", "candidate", "resolved"]);
    expect(database.db.prepare(`SELECT count(*) AS count FROM adaptive_climate_detector_hours
      WHERE epoch_id = ? AND target_hour >= ? AND admitted = 1`).get(epoch.id, start + 121 * HOUR_MS)).toEqual({ count: 0 });
    database.transaction(() => new AdaptiveClimateDetector(database).advance(epoch, start + 127 * HOUR_MS + 1_000));
    expect(episodeStates()).toEqual(["candidate", "stale", "candidate", "resolved"]);
    database.activateRealDataMode();
    expect(episodeStates()).toEqual([]);
  });

  it("expires a frozen model and does not let calibration use errors admitted after issue", () => {
    const issuedAt = start + 121 * HOUR_MS;
    const history = Array.from({ length: 120 }, (_, index) => ({
      time: start + index * HOUR_MS, error: 0, availableAt: index === 119 ? issuedAt + 1 : issuedAt - 1,
    }));
    const cold = detectProspectiveDeparture({
      state: initialDetectorState(), sample: { hour: issuedAt, issuedAt, frozenAt: null, error: 3, issue: null },
      history, metric: "temperature", now: issuedAt + HOUR_MS,
    });
    expect(cold).toMatchObject({ reason: "insufficient-calibration", calibration: null });
    for (let index = 0; index <= 120; index++) recordOutcome(index, 20);
    recordOutcome(121, 23);
    recordOutcome(122, 23);
    const expired = database.transaction(() => new AdaptiveClimateDetector(database).advance(epoch, start + (121 + 240) * HOUR_MS));
    expect(expired.expired).toBe(true);
    expect(episodeStates()).toEqual(["candidate", "expired"]);
  });

  it("projects the frozen pre-breach state without learning post-breach readings", () => {
    const cutoff = start + 72 * HOUR_MS + 1_000;
    const targetHour = start + 85 * HOUR_MS;
    const points = Array.from({ length: 85 }, (_, index) => {
      const time = start + index * HOUR_MS;
      return [time, { time, availableAt: time + HOUR_MS, value: 20, coverage: 1, quality: "good",
        source: "demo", epochId: epoch.id, archiveComplete: true }] as const;
    });
    const changed = new Map(points.map(([time, point]) => [time, point.availableAt > cutoff ? { ...point, value: 40 } : point]));
    const profile = { kind: "daily-profile", parameters: { alpha: 0.05, beta: 0, gamma: 0.2, decay: 0.7, shortBlend: 0, longBlend: 0 } } as const;
    const ordinary = new CausalClimatePredictor({ target: new Map(points), outdoor: new Map() }, profile);
    const drifted = new CausalClimatePredictor({ target: changed, outdoor: new Map() }, profile);
    expect(drifted.predict(targetHour)).not.toBe(ordinary.predict(targetHour));
    expect(drifted.predictFrozen(targetHour, cutoff)).toBe(20);
    expect(drifted.predictFrozen(targetHour, cutoff)).toBe(ordinary.predictFrozen(targetHour, cutoff));
  });
});
