import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdaptiveEvidenceScope, OutdoorTemperatureSource } from "@climate-twin/contracts";
import { readAdaptiveWeather } from "../src/analytics/adaptive-monitoring/weather-evidence.js";
import { HOUR_MS } from "../src/analytics/forecast/models.js";
import { ClimateDatabase, outdoorLocationKey } from "../src/db.js";

const interval = 5 * 60_000;
const location = { latitude: 60.25, longitude: 24.75 };
const scope: AdaptiveEvidenceScope = {
  houseId: "house-main", sensorId: "hour-target", dataMode: "live", metric: "temperature", purpose: "climate",
};

interface ReadingOptions {
  recordedAt?: number | null;
  source?: string;
  value?: number;
  unit?: string;
  quality?: string;
}

describe("Adaptive Home closed-hour snapshots", () => {
  let database: ClimateDatabase;
  let epochId: string;
  let hour: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    database = new ClimateDatabase(":memory:");
    database.activateRealDataMode();
    database.updateHouse(scope.houseId, { location });
    database.createSensor({
      id: scope.sensorId, houseId: scope.houseId, floorId: database.getHouse(scope.houseId)!.floors[0]!.id,
      name: "Fixture", room: "", model: "Test", x: 1, y: 1, z: 1, tags: [], enabled: true,
    });
    database.changeAdaptiveMonitoringSettings({
      houseId: scope.houseId, actorUserId: "test-owner",
      change: { action: "set-mode", dataMode: "live", baseRevision: 0, mode: "shadow" },
    });
    epochId = database.ensureAdaptiveEvidenceEpoch(scope)!.id;
    hour = Math.ceil(Date.now() / HOUR_MS) * HOUR_MS + 3 * HOUR_MS;
    vi.setSystemTime(hour + HOUR_MS + 1_000);
  });
  afterEach(() => {
    database.db.close();
    vi.useRealTimers();
  });

  function addReading(time: number, options: ReadingOptions = {}) {
    const timestamp = new Date(time).toISOString();
    const recorded = options.recordedAt === null ? null : new Date(options.recordedAt ?? time + 10).toISOString();
    database.db.prepare(`INSERT INTO measurement_samples
      (sensor_id, metric, value, canonical_unit, timestamp, source, quality, data_mode, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(scope.sensorId, scope.metric, options.value ?? 20,
        options.unit ?? database.getMeasurementDefinition(scope.metric)!.unit, timestamp, options.source ?? "api",
        options.quality ?? "good", scope.dataMode, recorded);
  }

  function priorCadence(source = "api") {
    for (let index = 24; index > 0; index--) addReading(hour - index * interval, { source });
  }

  function capture(at = hour) {
    return database.captureAdaptiveHour({ scope, epochId, hour: at });
  }

  it("seals only recorded, same-location current weather and fences the prediction cutoff", () => {
    const weather = (minutes: number, source: OutdoorTemperatureSource, temperatureC: number, locationKey = outdoorLocationKey(location)) =>
      database.upsertOutdoorTemperatureSample({
        houseId: scope.houseId, locationKey, timestamp: new Date(hour + minutes * 60_000).toISOString(),
        fetchedAt: new Date(hour + 59 * 60_000).toISOString(), temperatureC, source,
        stationId: source === "fmi-observation" ? "synthetic-station" : null, stationName: null,
      });
    const sealedAt = Date.now();
    weather(10, "fmi-observation", 3);
    weather(55, "fmi-backfill", 16);
    weather(56, "open-meteo-current", 20, "old-location");
    weather(57, "api", 30);
    weather(58, "open-meteo-current", 50);
    database.db.prepare("UPDATE outdoor_temperature_samples SET recorded_at = NULL WHERE temperature_c = 50").run();
    expect(capture().status).toBe("sealed");
    const epoch = database.readAdaptiveEvidenceEpoch(scope)!;
    const window = { from: hour, to: hour + HOUR_MS };
    expect(readAdaptiveWeather(database, epoch, { ...window, knownAt: sealedAt - 1 })).toEqual([]);
    expect(readAdaptiveWeather(database, epoch, { ...window, knownAt: sealedAt }))
      .toEqual([{ time: hour, availableAt: sealedAt, value: 3 }]);
    vi.setSystemTime(sealedAt + 5_000);
    weather(10, "fmi-observation", 8);
    weather(59, "fmi-observation", 9);
    expect(capture().status).toBe("sealed");
    expect(readAdaptiveWeather(database, epoch, { ...window, knownAt: Date.now() }))
      .toEqual([{ time: hour, availableAt: sealedAt, value: 3 }]);
    expect(() => database.db.prepare("UPDATE adaptive_weather_hours SET temperature_c = 2").run()).toThrow("immutable");
    vi.setSystemTime(sealedAt + 91 * 24 * HOUR_MS);
    database.pruneAdaptiveHours();
    expect(database.db.prepare("SELECT count(*) AS count FROM adaptive_weather_hours").get()).toEqual({ count: 0 });
  });

  it("seals observations at the transaction's capture time and preserves them after a late write", () => {
    priorCadence();
    for (let slot = 0; slot < 10; slot++) addReading(hour + slot * interval);
    addReading(hour + 11 * interval, { value: 40, recordedAt: Date.now() + 60_000 });
    addReading(hour + HOUR_MS, { value: 40 });
    const sealedAt = Date.now();
    const result = capture();
    expect(result).toMatchObject({
      status: "sealed",
      capture: { capturedAt: sealedAt, outcome: { source: "api", reason: null, evidence: {
        epochId, time: hour, availableAt: sealedAt, value: 20, source: "observed", archiveComplete: true,
      } } },
    });
    addReading(hour + 10 * interval, { value: 40, recordedAt: sealedAt + 2_000 });
    vi.setSystemTime(sealedAt + 120_000);
    expect(capture()).toEqual(result);
    expect(database.readAdaptiveHours({ scope, epochId, from: hour, to: hour + HOUR_MS }))
      .toEqual(result.status === "sealed" ? [result.capture] : []);
  });

  it("counts occupied reporting slots and excludes unverified, estimated, stale, imported, and invalid readings", () => {
    priorCadence();
    for (let index = 0; index < 14; index++) addReading(hour + index * 1_000);
    addReading(hour + interval, { recordedAt: null });
    addReading(hour + 4 * interval, { quality: "estimated" });
    addReading(hour + 5 * interval, { quality: "stale" });
    addReading(hour + 6 * interval, { source: "import" });
    addReading(hour + 7 * interval, { value: 900 });
    addReading(hour + 8 * interval, { unit: "F" });
    addReading(hour + 9 * interval, { recordedAt: hour });
    expect(capture()).toMatchObject({
      status: "sealed", capture: { outcome: { reason: "low-coverage", coverage: 1 / 12, evidence: null } },
    });
    addReading(hour + 10 * interval);
    expect(capture()).toMatchObject({ capture: { outcome: { coverage: 1 / 12 } } });
  });

  it("withholds hours with unknown cadence and does not blend distinct producers", () => {
    addReading(hour);
    expect(capture()).toMatchObject({ capture: { outcome: { reason: "unknown-cadence", evidence: null } } });
    vi.setSystemTime(hour + 2 * HOUR_MS + 1_000);
    addReading(hour + HOUR_MS, { source: "api" });
    addReading(hour + HOUR_MS, { source: "tp-link" });
    expect(capture(hour + HOUR_MS)).toMatchObject({ capture: { outcome: { reason: "source-conflict" } } });
  });

  it("pins a qualified producer to its epoch and refuses to capture through an obsolete epoch", () => {
    priorCadence();
    for (let slot = 0; slot < 12; slot++) addReading(hour + slot * interval);
    expect(capture()).toMatchObject({ capture: { outcome: { source: "api", reason: null } } });
    vi.setSystemTime(hour + 2 * HOUR_MS + 1_000);
    for (let slot = 0; slot < 12; slot++) addReading(hour + HOUR_MS + slot * interval, { source: "tp-link" });
    expect(capture(hour + HOUR_MS)).toMatchObject({ capture: { outcome: { reason: "source-conflict", evidence: null } } });
    database.updateSensor(scope.sensorId, { x: 2 });
    expect(capture()).toEqual({ status: "epoch-changed" });
  });

  it("excludes pruned and out-of-window hours and removes sealed evidence after retention", () => {
    priorCadence();
    addReading(hour);
    addReading(hour + HOUR_MS);
    expect(capture(hour + HOUR_MS)).toEqual({ status: "outside-capture-window" });
    expect(capture(hour + 1)).toEqual({ status: "outside-capture-window" });
    database.purgeReadingsBefore(new Date(hour + HOUR_MS).toISOString());
    expect(capture()).toEqual({ status: "local-history-incomplete" });
    vi.setSystemTime(hour + 4 * HOUR_MS);
    expect(capture(hour + 2 * HOUR_MS)).toMatchObject({ capture: { outcome: { reason: "missing" } } });
    vi.setSystemTime(hour + 91 * 24 * HOUR_MS);
    expect(database.pruneAdaptiveHours()).toBe(1);
    expect(capture(hour + 2 * HOUR_MS)).toEqual({ status: "outside-capture-window" });
  });
});
