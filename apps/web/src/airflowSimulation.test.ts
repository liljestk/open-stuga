import { describe, expect, it } from "vitest";
import { resolvePlanElementOpeningState, type DoorPlanElement, type Floor, type House, type MeasurementSample, type OpeningStateObservation, type Sensor } from "@climate-twin/contracts";
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

describe("opening state resolution", () => {
  const boundDoor: DoorPlanElement = {
    id: "door", kind: "door", wallId: "wall", position: { x: 5, y: 0 }, rotationDegrees: 0,
    state: "closed", stateBinding: { provider: "tapo", externalId: "contact", connectionId: "hub-a" },
  };
  const observation = (overrides: Partial<OpeningStateObservation>): OpeningStateObservation => ({
    id: "observation", houseId: "house", floorId: "ground", elementId: "door", state: "open",
    source: "tapo", observedAt: timestamp, externalId: "contact", connectionId: "hub-a", ...overrides,
  });

  it("lets an explicit unknown reading mask an older open state", () => {
    const effective = resolvePlanElementOpeningState(boundDoor, [
      observation({ id: "open", observedAt: "2026-07-14T11:59:00.000Z" }),
      observation({ id: "unknown", state: "unknown" }),
    ], referenceTimeMs);
    expect(effective).toMatchObject({ state: "closed", openFraction: 0, source: "manual", assumed: false });
    expect(effective).not.toHaveProperty("observedAt");
  });

  it("requires provider identity and the configured connection", () => {
    const missingExternalId = observation({});
    delete missingExternalId.externalId;
    expect(resolvePlanElementOpeningState(boundDoor, [missingExternalId], referenceTimeMs).state).toBe("closed");
    expect(resolvePlanElementOpeningState(boundDoor, [observation({ connectionId: "hub-b" })], referenceTimeMs).state).toBe("closed");
    expect(resolvePlanElementOpeningState(boundDoor, [observation({})], referenceTimeMs).state).toBe("open");
  });

  it("keeps physically fixed variants invariant even with contradictory input", () => {
    const fixedWindow = {
      id: "door", kind: "window" as const, wallId: "wall", position: { x: 5, y: 0 }, rotationDegrees: 0,
      variant: "fixed" as const, state: "open" as const,
    };
    expect(resolvePlanElementOpeningState(fixedWindow, [observation({})], referenceTimeMs).state).toBe("closed");
    expect(resolvePlanElementOpeningState({ ...boundDoor, variant: "open-passage", state: "closed" }, [], referenceTimeMs).state).toBe("open");
  });
});

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
      id: "house", propertyId: "property-test", name: "House", timezone: "Europe/Helsinki", floors: [modelFloor],
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

  it("renders opposite low and high natural-convection paths only through an open door", () => {
    const rooms = [
      { id: "cool-room", name: "Cool", points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 70 }, { x: 0, y: 70 }] },
      { id: "warm-room", name: "Warm", points: [{ x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 70 }, { x: 50, y: 70 }] },
    ];
    const wall = { id: "divider", from: { x: 50, y: 0 }, to: { x: 50, y: 70 } };
    const sensors = [sensor("cool", 25, 35), sensor("warm", 75, 35)];
    const samples = climate(sensors, [{ temperature: 18, humidity: 45 }, { temperature: 25, humidity: 45 }]);
    const withDoor = (state: "open" | "closed"): Floor => floor({
      rooms, walls: [wall],
      planElements: [{ id: "connecting-door", kind: "door", wallId: wall.id, position: { x: 50, y: 35 }, rotationDegrees: 90, width: 12, height: 2.1, state }],
    });
    const houseFor = (modelFloor: Floor): House => ({
      id: "house", propertyId: "property-test", name: "House", timezone: "Europe/Helsinki", floors: [modelFloor], createdAt: timestamp, updatedAt: timestamp,
    });

    const closed = simulateBuildingAirflow({ house: houseFor(withDoor("closed")), sensors, samples, freshness });
    expect(closed.paths.some((path) => path.id.includes("counterflow"))).toBe(false);
    expect(closed.evidence.doorOpenings).toBe(0);

    const opened = simulateBuildingAirflow({ house: houseFor(withDoor("open")), sensors, samples, freshness });
    const counterflow = opened.paths.filter((path) => path.id.includes("counterflow"));
    expect(counterflow).toHaveLength(2);
    const low = counterflow.find((path) => path.id.endsWith("counterflow-low"))!;
    const high = counterflow.find((path) => path.id.endsWith("counterflow-high"))!;
    expect(low.points[0]!.x).toBeLessThan(50);
    expect(low.points.at(-1)!.x).toBeGreaterThan(50);
    expect(high.points[0]!.x).toBeGreaterThan(50);
    expect(high.points.at(-1)!.x).toBeLessThan(50);
    expect(low.points[0]!.z).toBeLessThan(high.points[0]!.z);
    expect(opened.evidence).toMatchObject({ doorOpenings: 1, counterflowOpenings: 1 });
  });

  it("uses fresh bound contact observations and falls back when they become stale", () => {
    const modelFloor = floor({
      rooms: [
        { id: "cool-room", name: "Cool", points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 70 }, { x: 0, y: 70 }] },
        { id: "warm-room", name: "Warm", points: [{ x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 70 }, { x: 50, y: 70 }] },
      ],
      walls: [{ id: "divider", from: { x: 50, y: 0 }, to: { x: 50, y: 70 } }],
      planElements: [{
        id: "sensor-door", kind: "door", wallId: "divider", position: { x: 50, y: 35 }, rotationDegrees: 90,
        width: 12, height: 2.1, state: "closed", stateBinding: { provider: "home-assistant", externalId: "binary_sensor.door" },
      }],
    });
    const sensors = [sensor("cool", 25, 35), sensor("warm", 75, 35)];
    const samples = climate(sensors, [{ temperature: 18, humidity: 45 }, { temperature: 25, humidity: 45 }]);
    const house: House = {
      id: "house", propertyId: "property-test", name: "House", timezone: "Europe/Helsinki", floors: [modelFloor], createdAt: timestamp, updatedAt: timestamp,
    };
    const observation = (observedAt: string): OpeningStateObservation => ({
      id: `state-${observedAt}`, houseId: "house", floorId: "ground", elementId: "sensor-door", state: "open",
      source: "home-assistant", externalId: "binary_sensor.door", observedAt,
    });

    const fresh = simulateBuildingAirflow({ house, sensors, samples, freshness, openingStateObservations: [observation(timestamp)] });
    expect(fresh.paths.filter((path) => path.id.includes("counterflow"))).toHaveLength(2);
    expect(fresh.evidence.doorOpenings).toBe(1);

    const stale = simulateBuildingAirflow({ house, sensors, samples, freshness, openingStateObservations: [observation("2026-07-14T11:44:00.000Z")] });
    expect(stale.paths.some((path) => path.id.includes("counterflow"))).toBe(false);
    expect(stale.evidence.doorOpenings).toBe(0);
  });

  it("uses only open mechanical vents as qualitative forcing evidence", () => {
    const sensors = [sensor("left", 25, 35), sensor("right", 75, 35)];
    const samples = climate(sensors, [{ temperature: 21, humidity: 45 }, { temperature: 21, humidity: 45 }]);
    const estimate = simulateFloorAirflow({
      floor: floor({ planElements: [{ id: "supply", kind: "vent", position: { x: 50, y: 35 }, rotationDegrees: 0, variant: "supply", state: "open", nominalFlowM3h: 80 }] }),
      sensors, samples, freshness,
    });
    expect(estimate.evidence.ventOpenings).toBe(1);
    expect(estimate.paths.length).toBeGreaterThan(0);
    const closed = simulateFloorAirflow({
      floor: floor({ planElements: [{ id: "supply", kind: "vent", position: { x: 50, y: 35 }, rotationDegrees: 0, variant: "supply", state: "closed", nominalFlowM3h: 80 }] }),
      sensors, samples, freshness,
    });
    expect(closed.evidence.ventOpenings).toBe(0);
    expect(closed.paths).toEqual([]);
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

  it("keeps sparse floor evidence visible in the building assessment when no path can be solved", () => {
    const modelFloor = floor();
    const onlySensor = sensor("only", 25, 35);
    const house: House = {
      id: "house", propertyId: "property-test", name: "House", timezone: "Europe/Helsinki", floors: [modelFloor],
      createdAt: timestamp, updatedAt: timestamp,
    };
    const estimate = simulateBuildingAirflow({
      house,
      sensors: [onlySensor],
      samples: climate([onlySensor], [{ temperature: 21, humidity: 46 }]),
      freshness,
    });

    expect(estimate.paths).toEqual([]);
    expect(estimate.evidence.temperatureSensors).toBe(1);
    expect(estimate.evidence.humiditySensors).toBe(1);
    expect(estimate.evidence.support).toBe("low");
  });
});
