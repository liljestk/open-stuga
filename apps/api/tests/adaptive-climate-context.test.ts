import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdaptiveEvidenceEpoch, OpeningState } from "@climate-twin/contracts";
import { AdaptiveClimateContext } from "../src/analytics/adaptive-monitoring/climate-context.js";
import { AdaptiveClimateDetector } from "../src/analytics/adaptive-monitoring/climate-detector.js";
import { HOUR_MS, hourStart } from "../src/analytics/forecast/models.js";
import { ClimateDatabase } from "../src/db.js";

const houseId = "context-home";
const scope = { houseId, sensorId: "context-thermometer", dataMode: "live", metric: "temperature", purpose: "climate" } as const;

describe("Adaptive Home recorded context guards", () => {
  let database: ClimateDatabase;
  let epoch: AdaptiveEvidenceEpoch;
  let hour: number;
  let context: AdaptiveClimateContext;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    database = new ClimateDatabase(":memory:");
    database.createHouse({
      id: houseId, name: "Context fixture", timezone: "UTC",
      floors: [{
        id: "ground", name: "Ground", type: "ground", width: 10, height: 8, elevation: 0,
        walls: [{ id: "wall", from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }],
        rooms: [], planElements: [{ id: "door", kind: "door", variant: "exterior", wallId: "wall",
          position: { x: 2, y: 0 }, rotationDegrees: 0, width: 1, state: "closed" }],
      }],
    });
    database.activateRealDataMode();
    database.createSensor({ id: scope.sensorId, houseId, floorId: "ground", name: "Fixture",
      room: "", x: 1, y: 1, z: 1, tags: [], enabled: true, model: "Test" });
    database.changeAdaptiveMonitoringSettings({ houseId, actorUserId: "test-owner",
      change: { action: "set-mode", mode: "shadow", dataMode: "live", baseRevision: 0 } });
    epoch = database.ensureAdaptiveEvidenceEpoch(scope)!;
    hour = hourStart(Date.now()) + 2 * HOUR_MS;
    context = new AdaptiveClimateContext(database);
  });
  afterEach(() => {
    database.close();
    vi.useRealTimers();
  });

  function opening(id: string, state: OpeningState, observedAt: number, recordedAt: number) {
    vi.setSystemTime(recordedAt);
    database.recordOpeningStateObservation(houseId, {
      id, floorId: "ground", elementId: "door", state, source: "manual",
      observedAt: new Date(observedAt).toISOString(),
    });
  }

  function state(observedAt: number, { power, available = true, receivedAt = observedAt + 1_000, verified = true }: {
    power: boolean; available?: boolean; receivedAt?: number; verified?: boolean;
  }) {
    const recorded = new Date(receivedAt).toISOString();
    database.db.prepare(`INSERT INTO heat_pump_state_history
      (connection_id, house_id, observed_at, received_at, state_json, adaptive_context_at)
      VALUES ('test-heat', ?, ?, ?, ?, ?)`).run(houseId, new Date(observedAt).toISOString(), recorded,
      JSON.stringify({ available, power, selectedMode: "heat", targetTemperatureC: 20 }), verified ? recorded : null);
  }

  it("uses a recorded opening change for two full hours and excludes it before it was available", () => {
    opening("closed", "closed", hour - HOUR_MS, hour - HOUR_MS + 1_000);
    const event = hour - 10_000;
    const recordedAt = hour + 2_000;
    opening("opened", "open", event, recordedAt);
    expect(context.forHour(epoch, { hour, knownAt: recordedAt - 1 })).toBeNull();
    const guard = { reason: "opening-state-change", sourceId: "opened", occurredAt: event, availableAt: recordedAt, until: hour + 2 * HOUR_MS };
    expect(context.forHour(epoch, { hour, knownAt: recordedAt })).toEqual(guard);
    expect(context.forHour(epoch, { hour: hour + HOUR_MS, knownAt: hour + 2 * HOUR_MS })).toEqual(guard);
    expect(context.forHour(epoch, { hour: hour + 2 * HOUR_MS, knownAt: hour + 3 * HOUR_MS })).toBeNull();
    expect(context.forHour({ ...epoch, dataMode: "demo" }, { hour, knownAt: recordedAt })).toBeNull();
    expect(context.forHour({ ...epoch, houseId: "house-main" }, { hour, knownAt: recordedAt })).toBeNull();
  });

  it("requires two nearby known heating settings instead of treating an outage or legacy row as a change", () => {
    state(hour - 8 * 60_000, { power: false, verified: false });
    state(hour - 7 * 60_000, { power: true });
    state(hour - 6 * 60_000, { power: false, available: false });
    state(hour - 5 * 60_000, { power: false });
    expect(context.forHour(epoch, { hour, knownAt: hour })).toBeNull();
    state(hour - 2 * 60_000, { power: true, receivedAt: hour + 4_000 });
    expect(context.forHour(epoch, { hour, knownAt: hour })).toBeNull();
    expect(context.forHour(epoch, { hour, knownAt: hour + 4_000 })).toMatchObject({
      reason: "heating-setting-change", sourceId: "test-heat", until: hour + 2 * HOUR_MS,
    });
  });

  it("stores the guard with the detector decision and keeps the guarded error out of calibration", () => {
    opening("closed", "closed", hour - HOUR_MS, hour - HOUR_MS + 1_000);
    opening("opened", "open", hour - 1_000, hour);
    database.db.prepare(`INSERT INTO adaptive_climate_artifacts
      (epoch_id, algorithm_version, evaluated_through, recorded_at, input_digest, report_json) VALUES (?, 'test', ?, ?, '', '{}')`)
      .run(epoch.id, hour - HOUR_MS, hour - HOUR_MS);
    database.db.prepare(`INSERT INTO adaptive_climate_predictions
      (epoch_id, target_hour, issued_at, recorded_at, artifact_version, artifact_cutoff, input_digest, prediction)
      VALUES (?, ?, ?, ?, 'test', ?, '', 20)`).run(epoch.id, hour, hour - 20_000, hour - 20_000, hour - HOUR_MS);
    const capturedAt = hour + HOUR_MS + 500;
    database.db.prepare(`INSERT INTO adaptive_climate_outcomes
      (epoch_id, target_hour, scored_at, observed_at, observed) VALUES (?, ?, ?, ?, 23)`)
      .run(epoch.id, hour, capturedAt, capturedAt);
    database.transaction(() => new AdaptiveClimateDetector(database).advance(epoch, capturedAt));
    const decision = database.db.prepare(`SELECT admitted, reason, context_guard_json
      FROM adaptive_climate_detector_hours WHERE epoch_id = ?`).get(epoch.id);
    expect(decision).toMatchObject({ admitted: 0, reason: "context-guard" });
    expect(JSON.parse(String(decision?.context_guard_json))).toMatchObject({ sourceId: "opened", until: hour + 2 * HOUR_MS });
  });
});
