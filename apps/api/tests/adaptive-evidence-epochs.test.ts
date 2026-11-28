import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdaptiveEvidenceScope, AdaptiveSettingsChange } from "@climate-twin/contracts";
import { ClimateDatabase } from "../src/db.js";

const houseId = "house-main";
const target = "epoch-target";
const reference = "epoch-reference";
const climate: AdaptiveEvidenceScope = { houseId, dataMode: "demo", sensorId: target, metric: "temperature", purpose: "climate" };
const comparison: AdaptiveEvidenceScope = { ...climate, purpose: "sensor-comparison" };

describe("Adaptive Home evidence epochs", () => {
  let database: ClimateDatabase;
  beforeEach(() => {
    database = new ClimateDatabase(":memory:");
    const floorId = database.getHouse(houseId)!.floors[0]!.id;
    for (const id of [target, reference]) {
      database.createSensor({
        id, houseId, floorId, name: id, room: "", x: 1, y: 1, z: 1, tags: [], model: "Test", enabled: true,
        measurementEntityIds: { temperature: `sensor.${id}_temperature`, humidity: `sensor.${id}_humidity` },
      });
    }
  });
  afterEach(() => database.db.close());

  function changeSettings(change: AdaptiveSettingsChange) {
    return database.changeAdaptiveMonitoringSettings({ houseId, actorUserId: "test-owner", change });
  }

  function enable() {
    return changeSettings({ action: "set-mode", mode: "shadow", baseRevision: 0, dataMode: "demo" });
  }

  it("starts prospective epochs only after opt-in and reuses the durable epoch for unchanged configuration", () => {
    expect(database.ensureAdaptiveEvidenceEpoch(climate)).toBeNull();
    const settings = enable();
    expect(database.readAdaptiveEvidenceEpoch(climate)).toBeNull();
    const first = database.ensureAdaptiveEvidenceEpoch(climate)!;
    expect(first).toMatchObject({ ...climate, baselineId: settings.baseline!.id, effectiveAt: settings.baseline!.startedAt });
    expect(Date.parse(first.recordedAt)).toBeGreaterThanOrEqual(Date.parse(first.effectiveAt));
    database.updateSensor(target, { name: "Display name only" });
    database.updateHouse(houseId, { name: "Display name only" });
    expect(database.ensureAdaptiveEvidenceEpoch(climate)).toEqual(first);
    expect(database.readAdaptiveEvidenceEpoch(climate)).toEqual(first);
  });

  it("invalidates a moved-and-returned sensor and isolates unrelated metric binding changes", () => {
    enable();
    const humidity = { ...climate, metric: "humidity" } as const;
    const saved = database.ensureAdaptiveEvidenceEpoch(climate)!;
    const savedHumidity = database.ensureAdaptiveEvidenceEpoch(humidity)!;
    database.updateSensor(target, { measurementEntityIds: {
      temperature: "sensor.replacement", humidity: `sensor.${target}_humidity`,
    } });
    expect(database.readAdaptiveEvidenceEpoch(climate)).toBeNull();
    expect(database.readAdaptiveEvidenceEpoch(humidity)).toEqual(savedHumidity);
    const rebound = database.ensureAdaptiveEvidenceEpoch(climate)!;
    database.updateSensor(target, { x: 2 });
    database.updateSensor(target, { x: 1 });
    expect(database.readAdaptiveEvidenceEpoch(climate)).toBeNull();
    const moved = database.ensureAdaptiveEvidenceEpoch(climate)!;
    expect(new Set([saved.id, rebound.id, moved.id]).size).toBe(3);
    expect(Date.parse(moved.effectiveAt)).toBeGreaterThanOrEqual(Date.parse(rebound.effectiveAt));
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM adaptive_evidence_epochs").get()).toEqual({ count: 4 });
  });

  it("tracks comparison dependencies without invalidating a climate epoch when only a peer changes", () => {
    enable();
    expect(database.ensureAdaptiveEvidenceEpoch(comparison)).toBeNull();
    const approve: AdaptiveSettingsChange = {
      action: "set-reference-groups", baseRevision: 1, dataMode: "demo",
      referenceGroups: [{
        targetSensorId: target, kind: "reference-thermometer", referenceSensorIds: [reference], placement: "Same shelf",
      }],
    };
    changeSettings(approve);
    const currentClimate = database.ensureAdaptiveEvidenceEpoch(climate);
    const first = database.ensureAdaptiveEvidenceEpoch(comparison)!;
    database.updateSensor(reference, { z: 1.3 });
    expect(database.readAdaptiveEvidenceEpoch(comparison)).toBeNull();
    expect(database.readAdaptiveEvidenceEpoch(climate)).toEqual(currentClimate);
    expect(database.ensureAdaptiveEvidenceEpoch(comparison)).toBeNull();
    changeSettings(approve);
    expect(database.ensureAdaptiveEvidenceEpoch(comparison)).toBeNull();
    changeSettings({ ...approve, baseRevision: 2 });
    expect(database.ensureAdaptiveEvidenceEpoch(comparison)!.id).not.toBe(first.id);
    database.updateSensor(reference, { enabled: false });
    expect(database.ensureAdaptiveEvidenceEpoch(comparison)).toBeNull();
  });

  it("tracks relevant weather, metric semantics and explicit baseline resets", () => {
    enable();
    const humidity = { ...climate, metric: "humidity" } as const;
    const humid = database.ensureAdaptiveEvidenceEpoch(humidity)!;
    database.ensureAdaptiveEvidenceEpoch(climate);
    database.updateHouse(houseId, { location: { latitude: 64, longitude: 26, source: "manual" } });
    expect(database.readAdaptiveEvidenceEpoch(climate)).toBeNull();
    expect(database.readAdaptiveEvidenceEpoch(humidity)).toEqual(humid);
    const temperature = database.ensureAdaptiveEvidenceEpoch(climate)!;
    database.updateHouse(houseId, { location: { latitude: 64, longitude: 26, label: "Display label", source: "manual" } });
    expect(database.readAdaptiveEvidenceEpoch(climate)).toEqual(temperature);
    database.updateMeasurementDefinition("temperature", { validMin: -98 });
    expect(database.readAdaptiveEvidenceEpoch(climate)).toBeNull();
    const updatedMetric = database.ensureAdaptiveEvidenceEpoch(climate)!;
    const reset = changeSettings({ action: "reset-baseline", baseRevision: 1, dataMode: "demo", reason: "Recalibrated" });
    expect(database.readAdaptiveEvidenceEpoch(climate)).toBeNull();
    expect(database.ensureAdaptiveEvidenceEpoch(climate)).toMatchObject({ baselineId: reset.baseline!.id });
    expect(database.ensureAdaptiveEvidenceEpoch(climate)!.id).not.toBe(updatedMetric.id);
  });

  it("does not backdate an epoch to consent from before configuration tracking", () => {
    enable();
    database.db.prepare("UPDATE adaptive_settings_revisions SET baseline_started_at = ? WHERE house_id = ?")
      .run("2020-01-01T00:00:00.000Z", houseId);
    // A sensor already present at upgrade has no observed configuration changes yet.
    database.db.prepare("DELETE FROM adaptive_configuration_generations").run();
    const trackedFrom = new Date().toISOString();
    database.db.prepare("UPDATE metadata SET value = ? WHERE key = 'adaptive_evidence_observed_from'").run(trackedFrom);
    expect(database.ensureAdaptiveEvidenceEpoch(climate)).toMatchObject({ effectiveAt: trackedFrom });
  });

  it("removes epochs on authority and data-mode transitions", () => {
    enable();
    database.ensureAdaptiveEvidenceEpoch(climate);
    database.db.prepare("UPDATE houses SET stugby_json = ? WHERE id = ?").run(
      JSON.stringify({ ownership: "shared", syncState: "active" }), houseId,
    );
    database.purgeSharedHomeLocalState(houseId);
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM adaptive_evidence_epochs").get()).toEqual({ count: 0 });
    expect(() => database.ensureAdaptiveEvidenceEpoch(climate)).toThrow("Active local Home not found");
    database.setHouseStugubyLink(houseId, null);
    changeSettings({ action: "set-mode", mode: "shadow", baseRevision: 2, dataMode: "demo" });
    expect(database.ensureAdaptiveEvidenceEpoch(climate)).not.toBeNull();
    database.activateRealDataMode();
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM adaptive_evidence_epochs").get()).toEqual({ count: 0 });
    expect(() => database.ensureAdaptiveEvidenceEpoch(climate)).toThrow("This local database is in live mode");
  });
});
