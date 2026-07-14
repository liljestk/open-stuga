import { describe, expect, it } from "vitest";
import type { Floor, House, MeasurementSample, Sensor } from "@climate-twin/contracts";
import {
  relativeHumidityToSpecificHumidity,
  simulateBuildingAirflow,
  simulateFloorAirflow,
  specificHumidityToRelativeHumidity,
  type ClimateSampleMatrix,
} from "./airflowSimulation";

const timestamp = "2026-07-14T12:00:00.000Z";
const referenceTimeMs = Date.parse(timestamp);

function floor(overrides: Partial<Floor> = {}): Floor {
  return {
    id: "ground",
    name: "Ground",
    width: 100,
    height: 70,
    elevation: 0,
    ceilingHeight: 2.8,
    rooms: [{ id: "all", name: "Room", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 70 }, { x: 0, y: 70 }] }],
    walls: [],
    planElements: [],
    ...overrides,
  };
}

function sensor(id: string, x: number, y: number, z = 1.2): Sensor {
  return { id, houseId: "house", floorId: "ground", name: id, room: "Room", model: "test", x, y, z, tags: [], enabled: true };
}

function sample(sensorId: string, metric: string, value: number, quality: MeasurementSample["quality"] = "good"): MeasurementSample {
  return { sensorId, metric, value, canonicalUnit: metric === "temperature" ? "°C" : metric === "humidity" ? "%" : "ppm", timestamp, source: "api", quality };
}

function climate(sensors: Sensor[], values: Array<{ temperature: number; humidity: number; co2?: number }>): ClimateSampleMatrix {
  return Object.fromEntries(sensors.map((item, index) => {
    const value = values[index]!;
    return [item.id, {
      temperature: sample(item.id, "temperature", value.temperature),
      humidity: sample(item.id, "humidity", value.humidity),
      ...(value.co2 === undefined ? {} : { co2: sample(item.id, "co2", value.co2) }),
    }];
  }));
}

const freshness = { referenceTimeMs, maxSampleAgeMs: 15 * 60_000 };

describe("sensor-constrained airflow approximation", () => {
  it("round-trips relative humidity through specific humidity", () => {
    const q = relativeHumidityToSpecificHumidity(22, 57, 1007);
    expect(q).toBeGreaterThan(0);
    expect(specificHumidityToRelativeHumidity(22, q, 1007)).toBeCloseTo(57, 8);
  });

  it("does not invent motion for a uniform closed room", () => {
    const sensors = [sensor("left", 25, 35), sensor("right", 75, 35)];
    const estimate = simulateFloorAirflow({
      floor: floor(), sensors, samples: climate(sensors, [
        { temperature: 21, humidity: 45, co2: 420 },
        { temperature: 21, humidity: 45, co2: 2_100 },
      ]), freshness,
    });
    expect(estimate.paths).toEqual([]);
    expect(estimate.evidence.temperatureSensors).toBe(2);
  });

  it("creates one shared 2D/3D flow from temperature and water-vapour buoyancy", () => {
    const modelFloor = floor();
    const sensors = [
      sensor("cool", 18, 18, .7),
      sensor("warm", 78, 20, 1.1),
      sensor("moist", 50, 55, 1.8),
    ];
    const samples = climate(sensors, [
      { temperature: 18.5, humidity: 38, co2: 520 },
      { temperature: 24.8, humidity: 47, co2: 740 },
      { temperature: 22.6, humidity: 76, co2: 1_150 },
    ]);
    const plan = simulateFloorAirflow({ floor: modelFloor, sensors, samples, freshness });
    const house: House = {
      id: "house", name: "House", timezone: "Europe/Helsinki", floors: [modelFloor],
      createdAt: timestamp, updatedAt: timestamp,
    };
    const volume = simulateBuildingAirflow({ house, sensors, samples, freshness });

    expect(plan.paths.length).toBeGreaterThan(0);
    expect(volume.paths.length).toBeGreaterThan(0);
    expect(volume.paths.some((path) => path.hasVerticalComponent)).toBe(true);
    expect(plan.evidence.humiditySensors).toBe(3);
    expect(plan.evidence.tracerSensors).toBe(3);
    expect(Number.isFinite(plan.evidence.divergenceRms)).toBe(true);
    expect(plan.evidence.divergenceRms).toBeLessThan(1);
    plan.paths.forEach((path) => {
      expect(path.points.length).toBeGreaterThanOrEqual(4);
      expect(path.relativeSpeed).toBeGreaterThan(0);
      expect(path.support).toBeGreaterThan(0);
    });
  });

  it("never traces a path through a closed wall", () => {
    const divided = floor({
      walls: [{ id: "divider", from: { x: 50, y: 0 }, to: { x: 50, y: 70 } }],
      rooms: [
        { id: "left-room", name: "Left", points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 70 }, { x: 0, y: 70 }] },
        { id: "right-room", name: "Right", points: [{ x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 70 }, { x: 50, y: 70 }] },
      ],
    });
    const sensors = [sensor("left", 20, 20), sensor("right", 80, 45), sensor("right-two", 68, 18)];
    const estimate = simulateFloorAirflow({
      floor: divided,
      sensors,
      samples: climate(sensors, [
        { temperature: 18, humidity: 42 },
        { temperature: 25, humidity: 62 },
        { temperature: 23, humidity: 55 },
      ]),
      freshness,
    }, 12);
    expect(estimate.paths.length).toBeGreaterThan(0);
    estimate.paths.forEach((path) => {
      path.points.slice(1).forEach((point, index) => {
        const previous = path.points[index]!;
        expect((previous.x < 50 && point.x > 50) || (previous.x > 50 && point.x < 50)).toBe(false);
      });
    });
  });

  it("rejects stale temperature anchors before solving", () => {
    const sensors = [sensor("left", 25, 35), sensor("right", 75, 35)];
    const samples = climate(sensors, [
      { temperature: 19, humidity: 45 },
      { temperature: 25, humidity: 55 },
    ]);
    samples.right!.temperature = { ...samples.right!.temperature!, timestamp: "2026-07-14T10:00:00.000Z" };
    const estimate = simulateFloorAirflow({ floor: floor(), sensors, samples, freshness });
    expect(estimate.paths).toEqual([]);
    expect(estimate.evidence.temperatureSensors).toBe(1);
  });
});
