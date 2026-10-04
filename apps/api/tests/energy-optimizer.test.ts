import type { MeasurementSample, PropertyElectricityPricePoint, Sensor } from "@climate-twin/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ClimateDatabase } from "../src/db.js";
import { EnergyOptimizer } from "../src/energy-optimizer.js";
import { propertyPowerProfile } from "../src/energy-optimizer-power.js";
import { HybridTelemetryReader, type LocalTelemetryReader } from "../src/timeseries/read-facade.js";

const FROM = Date.parse("2026-09-01T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const sensor = (id: string, role: Sensor["energyMeterRole"] = "standalone", houseId = "home"): Sensor => ({
  id, houseId, enabled: true, energyMeterRole: role, measurementEntityIds: { power: `sensor.${id}_power` },
} as Sensor);
const sample = (sensorId: string, minute: number, value: number): MeasurementSample => ({
  sensorId, metric: "power", canonicalUnit: "W", timestamp: new Date(FROM + minute * MINUTE).toISOString(),
  value, source: "api", quality: "good",
});
const steady = (sensorId: string, watts: number, step = 10) => (
  Array.from({ length: Math.ceil(60 / step) }, (_, index) => sample(sensorId, index * step, watts))
);
const price = (startMinutes: number, endMinutes: number, cents: number): PropertyElectricityPricePoint => ({
  propertyId: "property", startAt: new Date(FROM + startMinutes * MINUTE).toISOString(),
  endAt: new Date(FROM + endMinutes * MINUTE).toISOString(),
  effectivePriceCentsPerKwh: cents, effectivePriceEurPerKwh: cents / 100,
} as PropertyElectricityPricePoint);

function optimizer(prices: PropertyElectricityPricePoint[], sensors: Sensor[] = [], samples: MeasurementSample[] = []) {
  const database = {
    getProperty: () => ({ id: "property" }),
    listHouses: () => [...new Set(sensors.map((item) => item.houseId))].map((id) => ({ id })),
    listSensors: (houseId: string) => sensors.filter((item) => item.houseId === houseId),
    getSensor: (id: string) => sensors.find((item) => item.id === id),
  } as unknown as ClimateDatabase;
  const measurementWindow = vi.fn(async () => ({ records: samples }));
  const reader = Object.assign(new HybridTelemetryReader({ local: {
    isRealDataMode: () => false,
  } as LocalTelemetryReader }), {
    electricityPriceHistory: async () => ({ records: prices }),
    measurementWindow,
    measurementCoverage: async () => ({ complete: true, records: [] }),
  });
  return { service: new EnergyOptimizer(database, reader), measurementWindow };
}

describe("Property optimizer power", () => {
  it("sums simultaneous independent meters regardless of reporting cadence", () => {
    const profile = propertyPowerProfile([sensor("fast"), sensor("heartbeat")], [
      ...steady("fast", 200, 1), ...steady("heartbeat", 200, 11),
    ], FROM, FROM + HOUR);
    expect(profile).toEqual({ baseline: 400, peak: 400 });
  });

  it("weights a frequently reported short spike by elapsed time", () => {
    const samples = [
      ...steady("meter", 100).filter((item) => Date.parse(item.timestamp) < FROM + 55 * MINUTE),
      ...Array.from({ length: 60 }, (_, index) => sample("meter", 55 + index / 60, 1_000)),
      sample("meter", 56, 100),
    ];
    expect(propertyPowerProfile([sensor("meter")], samples, FROM, FROM + HOUR))
      .toEqual({ baseline: 100, peak: 100 });
  });

  it("selects one whole-Home meter per Home and excludes submeters", () => {
    const sensors = [sensor("main", "whole_home"), sensor("sub", "submeter"),
      sensor("second", "whole_home", "second-home")];
    expect(propertyPowerProfile(sensors, [
      ...steady("main", 400), ...steady("sub", 200), ...steady("second", 100),
    ], FROM, FROM + HOUR)).toEqual({ baseline: 500, peak: 500 });
  });

  it("does not substitute a submeter when the whole-Home meter is unavailable", () => {
    expect(propertyPowerProfile([sensor("main", "whole_home"), sensor("sub", "submeter")],
      steady("sub", 200), FROM, FROM + HOUR)).toEqual({ baseline: null, peak: null });
    expect(propertyPowerProfile([sensor("sub", "submeter")], steady("sub", 200), FROM, FROM + HOUR))
      .toEqual({ baseline: null, peak: null });
  });

  it("requires overlapping non-stale evidence for every selected meter", () => {
    expect(propertyPowerProfile([sensor("early"), sensor("late")], [
      sample("early", 0, 200), sample("late", 30, 300),
    ], FROM, FROM + HOUR)).toEqual({ baseline: null, peak: null });
    expect(propertyPowerProfile([sensor("fresh"), sensor("stale")], [
      ...steady("fresh", 200), ...steady("stale", 300).map((item) => ({ ...item, quality: "stale" as const })),
    ], FROM, FROM + HOUR)).toEqual({ baseline: null, peak: null });
  });

  it("reads power only with a bounded predecessor window and uses the Property total", async () => {
    const setup = optimizer([], [sensor("first"), sensor("second")], [
      ...steady("first", 200), ...steady("second", 200),
    ]);
    const report = await setup.service.report("property", 2, new Date(FROM + HOUR));
    expect(report).toMatchObject({ baselinePowerWatts: 400, peakPowerWatts: 400 });
    expect(setup.measurementWindow).toHaveBeenCalledWith(expect.objectContaining({
      metrics: ["power"], from: new Date(FROM + HOUR - 24 * HOUR - 15 * MINUTE).toISOString(),
      limit: 200_000,
    }));
  });
});

describe("Property optimizer price windows", () => {
  it("does not suggest a continuous window across a missing price interval", async () => {
    const { service } = optimizer([price(0, 60, 10), price(120, 180, 20)]);
    expect((await service.report("property", 3, new Date(FROM))).suggestedWindows).toEqual([]);
  });

  it("weights different interval lengths and clips to the requested duration", async () => {
    const { service } = optimizer([price(0, 15, 0), price(15, 120, 20)]);
    const report = await service.report("property", 2, new Date(FROM));
    expect(report.averagePriceCentsPerKwh).toBe(17.5);
    expect(report.suggestedWindows).toEqual([expect.objectContaining({ averagePriceCentsPerKwh: 17.5 })]);
  });

  it("begins the current interval at now, never at a past start time", async () => {
    const { service } = optimizer([price(-30, 30, 10), price(30, 90, 20)]);
    const report = await service.report("property", 1, new Date(FROM));
    expect(report.suggestedWindows[0]).toMatchObject({
      startAt: new Date(FROM).toISOString(), endAt: new Date(FROM + HOUR).toISOString(),
      averagePriceCentsPerKwh: 15,
    });
  });

  it("does not rank a less negative, more expensive interval as best", async () => {
    const { service } = optimizer([price(0, 60, -12), price(60, 120, -8)]);
    const report = await service.report("property", 1, new Date(FROM));
    expect(report.suggestedWindows).toEqual([
      expect.objectContaining({ averagePriceCentsPerKwh: -12, rank: "good" }),
      expect.objectContaining({ averagePriceCentsPerKwh: -8, rank: "expensive" }),
    ]);
  });
});
