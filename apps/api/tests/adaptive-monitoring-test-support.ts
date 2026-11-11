import type { AdaptiveFinding } from "@climate-twin/contracts";
import { ClimateDatabase } from "../src/db.js";
import { HybridTelemetryReader } from "../src/timeseries/read-facade.js";
import { AdaptiveMonitoringService } from "../src/analytics/adaptive-monitoring/service.js";
import type { AdaptiveHour, AdaptiveStoredStream } from "../src/analytics/adaptive-monitoring/evidence.js";
import { HOUR } from "../src/analytics/adaptive-monitoring/evidence.js";
import { house, sensor } from "./home-monitoring-test-support.js";

export const START = Date.parse("2026-01-01T00:00:00Z");
export function adaptiveFixture() {
  const database = new ClimateDatabase(":memory:");
  database.activateRealDataMode();
  const home = database.createHouse({ id: house.id, name: "Cedar cottage", timezone: "UTC", floors: house.floors });
  database.createSensor(sensor("sensor-one", "Bedroom", { temperatureEntityId: "sensor.example_temperature" }));
  let now = START;
  const service = new AdaptiveMonitoringService({ database, telemetryReader: new HybridTelemetryReader({ local: database }),
    now: () => now, canTrain: () => true });
  const settings = service.settings(home.id, { dataMode: "live", baseRevision: 0, mode: "shadow" }, "test-owner");
  const stream = service.store.streams(home.id, "live")[0]!;
  return { database, home, service, settings, stream, setNow(value: number) { now = value; } };
}
export function adaptiveHour(index: number, overrides: Partial<AdaptiveHour> = {}): AdaptiveHour {
  const time = START + index * HOUR;
  const expected = 20 + 0.003 * index + 2 * Math.sin(index * Math.PI / 12);
  const value = expected + Math.sin(index * 1.7) * 0.005;
  return { time, availableAt: time + 5 * 60_000, value, coverage: 1, sources: ["tp-link"],
    outdoor: 0, guarded: false, peer: null,
    predictions: { "daily-profile": { value: expected, madeAt: time - HOUR + 5 * 60_000, cutoff: time - HOUR } },
    persistence: value - 0.2, seasonal: value - 0.072,
    score: { expected, threshold: 1, residual: value - expected }, excluded: false, ...overrides };
}
export function qualifiedStream(stream: AdaptiveStoredStream): AdaptiveStoredStream {
  return { ...stream, runtime: { ...stream.runtime, selected: "daily-profile" }, stream: { ...stream.stream,
    state: "ready", evaluation: { model: "daily-profile", evaluatedAt: new Date(START + 28 * 24 * HOUR).toISOString(),
      trainingCutoff: new Date(START + 14 * 24 * HOUR).toISOString(), calibrationHours: 168, holdoutHours: 168,
      coverage: 1, mae: 0.005, baselineMae: 0.072, qualified: true, reason: "qualified" } } };
}

export function adaptiveFinding(f: Pick<ReturnType<typeof adaptiveFixture>, "home" | "stream">): AdaptiveFinding {
  return { id: "finding-one", revision: 1, houseId: f.home.id, propertyId: f.home.propertyId, sensorId: "sensor-one",
    sensorName: "Bedroom thermometer", floorId: f.stream.stream.floorId, room: "Bedroom", epoch: f.stream.stream.epoch,
    metric: "temperature", kind: "climate-departure", direction: "low", severity: "notice", state: "candidate",
    firstEvidenceAt: new Date(START).toISOString(), lastEvidenceAt: new Date(START).toISOString(),
    recordedAt: new Date(START).toISOString(), freshness: "fresh", observed: 18, expected: 21, low: 20, high: 22,
    unit: "°C", coverage: 1, sourceIds: ["sensor-one"], contextGaps: [], modelId: "model-one", review: null };
}
