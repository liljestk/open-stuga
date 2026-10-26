import { describe, expect, it } from "vitest";
import type { House, OutdoorTemperatureSample, Sensor, StaticParameter } from "@climate-twin/contracts";
import { energyResult } from "../src/analytics/home-performance/derive-support.js";
import { exposureResult, type HomePerformanceInput } from "../src/analytics/home-performance/model.js";
import { heatingRegression, studentT95 } from "../src/analytics/home-performance/energy-index.js";
import { analyticsPoint, analyticsSeries, climateSensor, energySensor, from, house, response } from "./home-performance-test-support.js";

const HOUR = 3_600_000;
const DAYS = 30;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

/** Thirty winter days: each day's outdoor level wanders, heating follows degree-hours below 17 °C on top of a base load. */
function energyInput(options: { slope: (day: number) => number; baseKwhPerDay: number; parameters?: StaticParameter[] }) {
  const next = random(7);
  const start = Date.parse(from);
  const energyPoints = [];
  const outdoor: OutdoorTemperatureSample[] = [];
  let level = -5;
  for (let hour = 0; hour < DAYS * 24; hour += 1) {
    if (hour % 24 === 0) level = Math.max(-25, Math.min(8, level + (next() - 0.5) * 8));
    const temperatureC = level + 3 * Math.sin((2 * Math.PI * (hour % 24 - 9)) / 24);
    const timestamp = new Date(start + hour * HOUR).toISOString();
    const day = Math.floor(hour / 24);
    const kwh = options.baseKwhPerDay / 24 + options.slope(day) * Math.max(0, 17 - temperatureC) + (next() - 0.5) * 0.2;
    energyPoints.push(analyticsPoint(timestamp, Math.max(0, kwh)));
    outdoor.push({
      houseId: house.id, locationKey: "home", timestamp, temperatureC, source: "fmi-observation",
      fetchedAt: timestamp, stationId: "station", stationName: "Station",
    });
  }
  return {
    house,
    sensors: [energySensor],
    energy: response([analyticsSeries(energySensor, "energy", energyPoints, "1h")], "1h"),
    outdoor,
    from,
    to: new Date(start + DAYS * 24 * HOUR).toISOString(),
    ...(options.parameters ? { parameters: options.parameters } : {}),
  } as unknown as HomePerformanceInput;
}

describe("home performance energy index", () => {
  it("separates a base load from the heating slope and gives the slope an interval", () => {
    const result = energyResult(energyInput({ slope: () => 0.08, baseKwhPerDay: 12 }));
    expect(result.indexMethod).toBe("regression");
    expect(result.heatingBaseTemperatureC).toBe(17);
    expect(result.energyPerHeatingDegreeHour).toBeCloseTo(0.08, 2);
    expect(result.baseLoadKwhPerDay).toBeGreaterThan(10);
    expect(result.baseLoadKwhPerDay).toBeLessThan(14);
    expect(result.heatingSlopeInterval!.low).toBeLessThan(0.08);
    expect(result.heatingSlopeInterval!.high).toBeGreaterThan(0.08);
    // The plain ratio would have folded the base load into the index.
    expect(result.energyKwh! / result.heatingDegreeHours).toBeGreaterThan(0.09);
    // A steady building shows no clear change between the halves.
    expect(result.comparisonInterval!.lowPercent).toBeLessThan(0);
    expect(result.comparisonInterval!.highPercent).toBeGreaterThan(0);
  });

  it("reports a worse second half with an interval that excludes no change", () => {
    const result = energyResult(energyInput({ slope: (day) => (day < 15 ? 0.08 : 0.12), baseKwhPerDay: 12 }));
    expect(result.comparisonChangePercent).toBeGreaterThan(30);
    expect(result.comparisonChangePercent).toBeLessThan(70);
    expect(result.comparisonInterval!.lowPercent).toBeGreaterThan(0);
  });

  it("uses the house's heating base temperature", () => {
    const parameters: StaticParameter[] = [{
      id: "base", houseId: house.id, scopeType: "house", scopeId: house.id,
      key: "heating-base-temperature", value: 20, unit: "°C", label: "Heating base",
    }];
    const result = energyResult(energyInput({ slope: () => 0.08, baseKwhPerDay: 12, parameters }));
    expect(result.heatingBaseTemperatureC).toBe(20);
    const standard = energyResult(energyInput({ slope: () => 0.08, baseKwhPerDay: 12 }));
    expect(result.heatingDegreeHours).toBeGreaterThan(standard.heatingDegreeHours);
  });

  it("needs a week of days with differing heating need before fitting", () => {
    const days = Array.from({ length: 6 }, (_, day) => ({ dayStart: day, energyKwh: 10 + day, degreeHours: 100 * day }));
    expect(heatingRegression(days)).toBeNull();
    expect(heatingRegression(days.concat({ dayStart: 6, energyKwh: 16, degreeHours: 600 }))).not.toBeNull();
    expect(heatingRegression(Array.from({ length: 10 }, (_, day) => ({ dayStart: day, energyKwh: 5, degreeHours: 0 })))).toBeNull();
    expect(studentT95(4)).toBeCloseTo(2.132, 2);
    expect(studentT95(28)).toBeCloseTo(1.701, 2);
  });
});

describe("home performance comfort bands", () => {
  const rooms = [
    { id: "living", name: "Living room", kind: "living" },
    { id: "sauna", name: "Sauna", kind: "sauna" },
    { id: "bedroom", name: "Bedroom", kind: "bedroom" },
    { id: "office", name: "Office", kind: "office" },
  ];
  const comfortHouse: House = {
    ...house,
    floors: [{ ...house.floors[0]!, rooms: rooms.map((room) => ({ ...room, points: house.floors[0]!.rooms[0]!.points })) }],
  };
  const sensorIn = (room: (typeof rooms)[number]): Sensor => ({
    ...climateSensor, id: `sensor-${room.id}`, roomId: room.id, room: room.name, name: `${room.name} sensor`,
  });
  const temperatures: Record<string, number> = { living: 21, sauna: 80, bedroom: 17, office: 17 };
  const input = (parameters: StaticParameter[] = []) => ({
    house: comfortHouse,
    sensors: rooms.map(sensorIn),
    climate: response(rooms.map((room) => analyticsSeries(sensorIn(room), "temperature",
      Array.from({ length: 48 }, (_, index) => analyticsPoint(new Date(Date.parse(from) + index * HOUR).toISOString(), temperatures[room.id]!)),
      "1h")), "1h"),
    parameters,
  }) as unknown as HomePerformanceInput;

  it("leaves saunas out and judges each room against its kind's band", () => {
    const exposure = exposureResult(input());
    expect(exposure.excludedRooms).toEqual(["Sauna"]);
    expect(exposure.rooms.map((room) => room.label)).not.toContain("Sauna");
    const bedroom = exposure.rooms.find((room) => room.label === "Bedroom")!;
    const office = exposure.rooms.find((room) => room.label === "Office")!;
    expect(bedroom).toMatchObject({ comfortTemperatureLowC: 16, comfortTemperatureHighC: 23, temperatureDegreeHours: 0 });
    expect(office).toMatchObject({ comfortTemperatureLowC: 18, temperatureDegreeHours: 48 });
    // Only the office is outside its band; the sauna's 80 °C no longer dominates the home.
    expect(exposure.temperatureDegreeHours).toBe(48);
  });

  it("lets room parameters override a band or exclude a room", () => {
    const parameter = (scopeId: string, key: string, value: number | boolean): StaticParameter => ({
      id: `${scopeId}-${key}`, houseId: house.id, scopeType: "room", scopeId, key, value, unit: null, label: key,
    });
    const exposure = exposureResult(input([
      parameter("office", "comfort-temperature-low", 16),
      parameter("living", "comfort-excluded", true),
    ]));
    expect(exposure.excludedRooms).toEqual(["Living room", "Sauna"]);
    expect(exposure.rooms.find((room) => room.label === "Office")).toMatchObject({ comfortTemperatureLowC: 16, temperatureDegreeHours: 0 });
  });
});
