import type { MeasurementSample, OutdoorTemperatureSample } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import { buildHeatPumpExclusionWindow, filterHeatPumpAffectedSamples } from "../src/analytics/heat-pump-evidence.js";
import { calibrateMoistureResponse } from "../src/moisture-response-model.js";
import { runThermalSimulation, runThermalSimulationAsync } from "../src/thermal-simulation.js";
import { ClimateDatabase } from "../src/db.js";
import { DerivedAnalyticsComputer, derivedIdentity } from "../src/analytics/derived-artifacts/compute.js";
import type { HybridTelemetryReader } from "../src/timeseries/read-facade.js";

const START = Date.parse("2026-01-01T00:00:00.000Z");
const HOUR = 3_600_000;

function climate() {
  const indoor: MeasurementSample[] = [];
  const outdoor: OutdoorTemperatureSample[] = [];
  for (let step = 0; step <= 36 * 12; step += 1) {
    const timestamp = new Date(START + step * 5 * 60_000).toISOString();
    for (const [metric, value, canonicalUnit] of [
      ["temperature", 21 + Math.sin(step / 50), "°C"],
      ["humidity", 45 + 5 * Math.cos(step / 60), "%"],
    ] as const) indoor.push({ sensorId: "room", metric, value, canonicalUnit, timestamp, source: "api", quality: "good" });
    outdoor.push({ houseId: "home", locationKey: "test", timestamp,
      temperatureC: 5 + 4 * Math.sin(step / 30), source: "api", fetchedAt: timestamp,
      stationId: null, stationName: null, conditions: { relativeHumidityPercent: 65 + 10 * Math.cos(step / 45) },
    } as OutdoorTemperatureSample);
  }
  // A pump runs in the middle of otherwise densely sampled climate history.
  const window = buildHeatPumpExclusionWindow({
    from: new Date(START).toISOString(), to: new Date(START + 36 * HOUR).toISOString(),
    connectionIds: ["pump"],
    points: Array.from({ length: 36 * 12 + 9 }, (_, index) => {
      const time = START + (index - 7) * 5 * 60_000 + 2 * 60_000;
      return { connectionId: "pump", time,
        classification: time >= START + 18 * HOUR && time < START + 18.25 * HOUR
          ? "confirmed-active" as const : "off" as const };
    }),
  });
  return { indoor, outdoor, window, filtered: filterHeatPumpAffectedSamples(indoor, window) };
}

describe("passive model interval boundaries", () => {
  it("does not reconnect a pump exclusion into a 36-hour thermal calibration", async () => {
    const data = climate();
    expect(data.window.summary.evidenceState).toBe("partial");
    const input = {
      houseId: "home", sensorId: "room", roomLabel: "Test room",
      from: new Date(START).toISOString(), to: new Date(START + 36 * HOUR).toISOString(),
      indoorSamples: data.filtered.samples, outdoorSamples: data.outdoor, horizonHours: 0,
      hvacExclusion: data.filtered.summary, passiveIntervals: data.window.passiveIntervals,
    };
    for (const result of [runThermalSimulation(input), await runThermalSimulationAsync(input)]) {
      expect(result.calibration.status).toBe("insufficient-data");
      expect(result.calibration.quality.durationHours).toBeLessThan(18);
      expect(result.calibration.warnings).toContain("CALIBRATION_WINDOW_TOO_SHORT");
    }
  });

  it("does not reconnect a pump exclusion into a 36-hour moisture calibration", () => {
    const data = climate();
    const result = calibrateMoistureResponse(data.filtered.samples, data.outdoor, undefined, data.window.passiveIntervals);
    expect(result.status).toBe("insufficient-data");
    expect(result.quality.durationHours).toBeLessThan(18);
    expect(result.warnings).toContain("MOISTURE_WINDOW_TOO_SHORT");
  });

  it("excludes a five-minute average straddling the start of a pump exclusion", () => {
    const data = climate();
    const boundary = data.window.passiveIntervals[0]!.toMs;
    const bucketStart = Math.floor(boundary / (5 * 60_000)) * 5 * 60_000;
    const samples = [data.indoor[0]!, { ...data.indoor[0]!, timestamp: new Date(bucketStart).toISOString() }];
    const filtered = filterHeatPumpAffectedSamples(samples, data.window, 5 * 60_000);
    expect(filtered.samples).toEqual([samples[0]]);
    expect(filtered.summary.excludedSampleCount).toBe(1);
  });

  it.each(["thermal-isolation", "moisture-response"] as const)(
    "preserves exclusions through the saved %s calculation",
    async (kind) => {
      const data = climate();
      const db = new ClimateDatabase(":memory:", false);
      try {
        db.createHouse({ id: "home", name: "Test home", timezone: "UTC", floors: [{
          id: "floor", name: "Ground floor", width: 8, height: 8, elevation: 0, walls: [],
          rooms: [{ id: "living", name: "Living room", points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }, { x: 0, y: 8 }] }],
        }] });
        db.createSensor({ id: "room", houseId: "home", floorId: "floor", roomId: "living",
          name: "Room sensor", room: "Living room", model: "T310", x: 1, y: 1, z: 1,
          tags: [], enabled: true });
        const insert = db.db.prepare(`INSERT INTO heat_pump_state_history
          (connection_id, house_id, observed_at, received_at, state_json) VALUES (?, ?, ?, ?, ?)`);
        db.transaction(() => {
          for (let time = START - HOUR; time <= START + 169 * HOUR; time += 5 * 60_000) {
            const timestamp = new Date(time).toISOString();
            const active = time >= START + 18 * HOUR && time < START + 18.25 * HOUR;
            insert.run("pump", "home", timestamp, timestamp,
              JSON.stringify({ available: true, power: active, compressorFrequencyHz: active ? 30 : 0 }));
          }
        });
        const reader = {
          measurementCoverage: async () => ({ records: [
            { sensorId: "room", metric: "temperature" }, { sensorId: "room", metric: "humidity" },
          ] }),
          thermalMeasurementHistory: async () => ({ records: data.indoor }),
          outdoorTemperatureHistory: async () => ({ records: data.outdoor }),
        } as unknown as HybridTelemetryReader;
        const now = new Date(START + 7 * 24 * HOUR);
        const identity = derivedIdentity({ database: db, kind, houseId: "home", dataMode: "demo",
          windowDays: 7, now, heatPumpConnectionIds: ["pump"] });
        const result = await new DerivedAnalyticsComputer(db, reader, () => ["pump"]).compute({
          ...identity, status: "running", requestedAt: now.toISOString(), startedAt: now.toISOString(),
          completedAt: null, nextAttemptAt: null, attemptCount: 1, errorCode: null, errorMessage: null,
        });
        if (!("entries" in result)) throw new Error("Expected a comparison result");
        const sensor = result.entries.find((entry) => entry.scope.type === "sensor")!;
        expect(sensor.calibrationStatus).toBe("insufficient-data");
        expect(sensor.quality.durationHours).toBeLessThan(18);
        expect(result.methodology.hvacExclusion?.excludedSampleCount).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    },
  );
});
