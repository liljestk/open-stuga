import type { House, MeasurementSample, OutdoorTemperatureSample, Sensor } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import {
  isThermalIsolationTemperatureSensor,
  runThermalIsolation,
  runThermalIsolationAsync,
  thermalIsolationScore,
} from "../src/analytics/thermal/isolation.js";
import { simulateThermalStep } from "../src/analytics/thermal/simulation.js";
import {
  buildHeatPumpExclusionWindow,
  filterHeatPumpAffectedSampleMap,
  type HeatPumpEvidencePoint,
} from "../src/analytics/heat-pump-evidence.js";

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

function onSecondIteration(
  samples: MeasurementSample[],
  callback: () => void,
): MeasurementSample[] {
  const instrumented = [...samples];
  let iterations = 0;
  Object.defineProperty(instrumented, Symbol.iterator, {
    configurable: true,
    value: function iterator(this: MeasurementSample[]) {
      iterations += 1;
      if (iterations === 2) callback();
      return Array.prototype[Symbol.iterator].call(this);
    },
  });
  return instrumented;
}

describe("whole-home thermal isolation comparison", () => {
  it("never treats a heat-pump projection as an ambient room sensor", () => {
    expect(isThermalIsolationTemperatureSensor({
      ...sensor("heat-pump", "ground", "slow", "Buffered room"),
      tags: ["equipment:heat-pump"],
    }, true)).toBe(false);
  });
  it("turns the fitted time constant into an interpretable 24-hour retention score", () => {
    expect(thermalIsolationScore(24)).toBeCloseTo(36.8, 1);
    expect(thermalIsolationScore(48)).toBeCloseTo(60.7, 1);
    expect(thermalIsolationScore(12)).toBeCloseTo(13.5, 1);
  });

  it("carries filtered heat-pump evidence into fit warnings and methodology", () => {
    const climate = syntheticSeries("climate", 48);
    const from = climate.indoor[0]!.timestamp;
    const to = climate.indoor.at(-1)!.timestamp;
    const expandedFrom = Date.parse(from) - 30 * 60_000;
    const expandedTo = Date.parse(to) + 5 * 60_000;
    const activeAt = Date.parse(from) + 72 * 3_600_000;
    const points: HeatPumpEvidencePoint[] = Array.from(
      { length: (expandedTo - expandedFrom) / (5 * 60_000) + 1 },
      (_, index) => {
        const time = expandedFrom + index * 5 * 60_000;
        return {
          connectionId: "wilfa",
          time,
          classification: time === activeAt ? "confirmed-active" : "off",
        };
      },
    );
    const window = buildHeatPumpExclusionWindow({
      from,
      to,
      connectionIds: ["wilfa"],
      points,
    });
    const filtered = filterHeatPumpAffectedSampleMap(
      new Map([["climate", climate.indoor]]),
      window,
    );

    const result = runThermalIsolation({
      house: {
        ...house,
        floors: [{ ...house.floors[0]!, rooms: [house.floors[0]!.rooms[0]!] }],
      },
      sensors: [sensor("climate", "ground", "slow", "Buffered room")],
      indoorSamplesBySensor: filtered.samplesBySensor,
      outdoorSamples: climate.outdoor,
      from,
      to,
      generatedAt: "2026-02-01T00:00:00.000Z",
      hvacExclusion: filtered.summary,
    });

    expect(filtered.summary.excludedSampleCount).toBeGreaterThan(0);
    expect(result.methodology.hvacExclusion).toEqual(filtered.summary);
    expect(result.entries.find((entry) => entry.scope.id === "sensor:climate")?.warnings)
      .toContain("HVAC_ACTIVE_OR_UNVERIFIED_PERIODS_EXCLUDED");
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
    expect(thermalIsolationScore(wholeHouse.metrics.effectiveTimeConstantHours!)).toBe(wholeHouse.score);
    expect(wholeHouse.metrics.halfResponseHours)
      .toBeCloseTo(wholeHouse.metrics.effectiveTimeConstantHours! * Math.log(2), 1);
    expect(result.insights.map((insight) => insight.code)).toEqual(expect.arrayContaining([
      "LOWEST_BUFFERING_ROOM",
      "FLOOR_CONTRAST",
      "ROOM_SENSOR_SPREAD",
    ]));
    expect(result.methodology.scoreMethod).toBe("modeled-24h-retention-v1");
  });

  it("excludes energy-only devices from temperature evidence and coverage", () => {
    const oneRoomHouse = {
      ...house,
      floors: [{ ...house.floors[0]!, rooms: [house.floors[0]!.rooms[0]!] }],
    };
    const climate = syntheticSeries("climate", 48);
    const sensors = [
      { ...sensor("climate", "ground", "slow", "Buffered room"), temperatureEntityId: "sensor.climate_temperature" },
      { ...sensor("plug-a", "ground", "slow", "Buffered room"), model: "Tapo P110" },
      { ...sensor("plug-b", "ground", "slow", "Buffered room"), model: "Tapo P115" },
    ];
    const result = runThermalIsolation({
      house: oneRoomHouse,
      sensors,
      indoorSamplesBySensor: new Map([["climate", climate.indoor]]),
      outdoorSamples: climate.outdoor,
      from: climate.indoor[0]!.timestamp,
      to: climate.indoor.at(-1)!.timestamp,
      generatedAt: "2026-02-01T00:00:00.000Z",
    });

    expect(result.entries.filter((entry) => entry.scope.type === "sensor").map((entry) => entry.scope.sensorIds[0]))
      .toEqual(["climate"]);
    expect(result.entries.find((entry) => entry.scope.type === "house")).toMatchObject({
      childCoveragePct: 100,
      sensorCount: 1,
      eligibleSensorCount: 1,
    });
    expect(result.insights.some((insight) => insight.code === "LIMITED_EVIDENCE")).toBe(false);
  });

  it("gives equal scores equal ranks and suppresses zero-difference comparisons", () => {
    const tieHouse = {
      ...house,
      floors: [
        { ...house.floors[0]!, rooms: [house.floors[0]!.rooms[0]!] },
        house.floors[1]!,
      ],
    };
    const first = syntheticSeries("first", 24);
    const second = syntheticSeries("second", 24);
    const result = runThermalIsolation({
      house: tieHouse,
      sensors: [
        sensor("first", "ground", "slow", "Buffered room"),
        sensor("second", "upper", "fast", "Responsive room"),
      ],
      indoorSamplesBySensor: new Map([
        ["first", first.indoor],
        ["second", second.indoor],
      ]),
      outdoorSamples: first.outdoor,
      from: first.indoor[0]!.timestamp,
      to: first.indoor.at(-1)!.timestamp,
      generatedAt: "2026-02-01T00:00:00.000Z",
    });

    for (const scopeType of ["sensor", "room", "floor"] as const) {
      expect(result.entries.filter((entry) => entry.scope.type === scopeType).map((entry) => entry.rank))
        .toEqual([1, 1]);
    }
    expect(result.insights.map((insight) => insight.code)).not.toContain("LOWEST_BUFFERING_ROOM");
    expect(result.insights.map((insight) => insight.code)).not.toContain("FLOOR_CONTRAST");
  });

  it("supports cancellation before starting the expensive asynchronous fit", async () => {
    const series = syntheticSeries("climate", 24);
    const controller = new AbortController();
    controller.abort();
    await expect(runThermalIsolationAsync({
      house,
      sensors: [sensor("climate", "ground", "slow", "Buffered room")],
      indoorSamplesBySensor: new Map([["climate", series.indoor]]),
      outdoorSamples: series.outdoor,
      from: series.indoor[0]!.timestamp,
      to: series.indoor.at(-1)!.timestamp,
    }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("honors cancellation while preparing aggregate spread evidence", async () => {
    const first = syntheticSeries("first", 24).indoor.slice(0, 8);
    const second = syntheticSeries("second", 48).indoor.slice(0, 8);
    const controller = new AbortController();
    let aggregationStarted = false;
    const instrumentedFirst = onSecondIteration(first, () => {
      aggregationStarted = true;
      controller.abort();
    });

    await expect(runThermalIsolationAsync({
      house,
      sensors: [
        sensor("first", "ground", "slow", "Buffered room"),
        sensor("second", "ground", "slow", "Buffered room"),
      ],
      indoorSamplesBySensor: new Map([
        ["first", instrumentedFirst],
        ["second", second],
      ]),
      outdoorSamples: [],
      from: first[0]!.timestamp,
      to: first.at(-1)!.timestamp,
    }, {
      signal: controller.signal,
      yieldEveryAggregationSamples: 1,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(aggregationStarted).toBe(true);
  });

  it("yields to unrelated event-loop work during aggregate spread preparation", async () => {
    const first = syntheticSeries("first", 24).indoor.slice(0, 8);
    const second = syntheticSeries("second", 48).indoor.slice(0, 8);
    let aggregationStarted = false;
    let observedAnotherTurn = false;
    const instrumentedFirst = onSecondIteration(first, () => {
      aggregationStarted = true;
      setImmediate(() => { observedAnotherTurn = true; });
    });

    await runThermalIsolationAsync({
      house,
      sensors: [
        sensor("first", "ground", "slow", "Buffered room"),
        sensor("second", "ground", "slow", "Buffered room"),
      ],
      indoorSamplesBySensor: new Map([
        ["first", instrumentedFirst],
        ["second", second],
      ]),
      outdoorSamples: [],
      from: first[0]!.timestamp,
      to: first.at(-1)!.timestamp,
    }, { yieldEveryAggregationSamples: 1 });

    expect(aggregationStarted).toBe(true);
    expect(observedAnotherTurn).toBe(true);
  });

  it("keeps cooperative isolation results identical to the synchronous model", async () => {
    const first = syntheticSeries("first", 24);
    const second = syntheticSeries("second", 48);
    const input = {
      house,
      sensors: [
        sensor("first", "ground", "slow", "Buffered room"),
        sensor("second", "upper", "fast", "Responsive room"),
      ],
      indoorSamplesBySensor: new Map([
        ["first", first.indoor],
        ["second", second.indoor],
      ]),
      outdoorSamples: first.outdoor,
      from: first.indoor[0]!.timestamp,
      to: first.indoor.at(-1)!.timestamp,
      generatedAt: "2026-02-01T00:00:00.000Z",
    };

    expect(await runThermalIsolationAsync(input)).toEqual(runThermalIsolation(input));
  });

  it("yields to the event loop between sensor fits", async () => {
    const first = syntheticSeries("first", 24);
    const second = syntheticSeries("second", 48);
    let observedAnotherTurn = false;
    const pending = runThermalIsolationAsync({
      house,
      sensors: [
        sensor("first", "ground", "slow", "Buffered room"),
        sensor("second", "upper", "fast", "Responsive room"),
      ],
      indoorSamplesBySensor: new Map([
        ["first", first.indoor],
        ["second", second.indoor],
      ]),
      outdoorSamples: first.outdoor,
      from: first.indoor[0]!.timestamp,
      to: first.indoor.at(-1)!.timestamp,
    });
    setImmediate(() => { observedAnotherTurn = true; });

    await pending;
    expect(observedAnotherTurn).toBe(true);
  });
});
