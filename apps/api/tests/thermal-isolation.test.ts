import type { House, MeasurementSample, OutdoorTemperatureSample, Sensor } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import { runThermalIsolation, thermalIsolationScore } from "../src/thermal-isolation.js";
import { simulateThermalStep } from "../src/thermal-simulation.js";

const house: Pick<House, "id" | "name" | "floors"> = {
  id: "house-test",
  name: "Test home",
  floors: [
    {
      id: "ground",
      name: "Ground floor",
      width: 10,
      height: 10,
      elevation: 0,
      walls: [],
      rooms: [
        { id: "slow", name: "Buffered room", points: [] },
        { id: "empty", name: "Unmonitored room", points: [] },
      ],
    },
    {
      id: "upper",
      name: "Upper floor",
      width: 10,
      height: 10,
      elevation: 3,
      walls: [],
      rooms: [{ id: "fast", name: "Responsive room", points: [] }],
    },
  ],
};

function sensor(id: string, floorId: string, roomId: string, room: string): Sensor {
  return {
    id,
    houseId: house.id,
    floorId,
    roomId,
    room,
    name: id,
    model: "Synthetic",
    x: 1,
    y: 1,
    z: 1.2,
    tags: [],
    enabled: true,
  };
}

function syntheticSeries(
  sensorId: string,
  tauHours: number,
  offsetC = 0,
): { indoor: MeasurementSample[]; outdoor: OutdoorTemperatureSample[] } {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  const stepHours = 0.25;
  const steps = 8 * 24 / stepHours;
  let indoorC = 20 + offsetC;
  const indoor: MeasurementSample[] = [];
  const outdoor: OutdoorTemperatureSample[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const timestamp = new Date(start + step * stepHours * 3_600_000).toISOString();
    const outdoorC = 2 + 7 * Math.sin(step / 23) + 2 * Math.cos(step / 9);
    indoor.push({
      sensorId,
      metric: "temperature",
      value: indoorC,
      canonicalUnit: "°C",
      timestamp,
      source: "api",
      quality: "good",
    });
    outdoor.push({
      houseId: house.id,
      locationKey: "test-location",
      timestamp,
      temperatureC: outdoorC,
      source: "api",
      fetchedAt: timestamp,
      stationId: null,
      stationName: null,
    });
    indoorC = simulateThermalStep(indoorC, outdoorC, stepHours, tauHours, 18 + offsetC);
  }
  return { indoor, outdoor };
}

describe("whole-home thermal isolation comparison", () => {
  it("turns the fitted time constant into an interpretable 24-hour retention score", () => {
    expect(thermalIsolationScore(24)).toBeCloseTo(36.8, 1);
    expect(thermalIsolationScore(48)).toBeCloseTo(60.7, 1);
    expect(thermalIsolationScore(12)).toBeCloseTo(13.5, 1);
  });

  it("ranks rooms, rolls medians through floors and the house, and preserves missing evidence", () => {
    const slowA = syntheticSeries("slow-a", 48);
    const slowB = syntheticSeries("slow-b", 48, 1.2);
    const fast = syntheticSeries("fast", 12);
    const sensors = [
      sensor("slow-a", "ground", "slow", "Buffered room"),
      sensor("slow-b", "ground", "slow", "Buffered room"),
      sensor("fast", "upper", "fast", "Responsive room"),
    ];
    const result = runThermalIsolation({
      house,
      sensors,
      indoorSamplesBySensor: new Map([
        ["slow-a", slowA.indoor],
        ["slow-b", slowB.indoor],
        ["fast", fast.indoor],
      ]),
      outdoorSamples: slowA.outdoor,
      from: slowA.indoor[0]!.timestamp,
      to: slowA.indoor.at(-1)!.timestamp,
      generatedAt: "2026-02-01T00:00:00.000Z",
    });

    const buffered = result.entries.find((entry) => entry.scope.id === "room:ground:slow")!;
    const responsive = result.entries.find((entry) => entry.scope.id === "room:upper:fast")!;
    const unmonitored = result.entries.find((entry) => entry.scope.id === "room:ground:empty")!;
    const ground = result.entries.find((entry) => entry.scope.id === "floor:ground")!;
    const upper = result.entries.find((entry) => entry.scope.id === "floor:upper")!;
    const wholeHouse = result.entries.find((entry) => entry.scope.type === "house")!;

    expect(buffered.score).toBeGreaterThan(responsive.score!);
    expect(buffered.rank).toBe(1);
    expect(responsive.rank).toBe(2);
    expect(buffered.metrics.p90TemperatureSpreadC).toBeCloseTo(1.2, 1);
    expect(unmonitored.score).toBeNull();
    expect(unmonitored.warnings).toContain("NO_TEMPERATURE_SENSOR");
    expect(ground.score).toBeCloseTo(buffered.score!, 1);
    expect(upper.score).toBeCloseTo(responsive.score!, 1);
    expect(wholeHouse.score).toBeCloseTo((ground.score! + upper.score!) / 2, 1);
    expect(result.insights.map((insight) => insight.code)).toEqual(expect.arrayContaining([
      "LOWEST_BUFFERING_ROOM",
      "FLOOR_CONTRAST",
      "ROOM_SENSOR_SPREAD",
    ]));
    expect(result.methodology.scoreMethod).toBe("modeled-24h-retention-v1");
  });
});
