import { describe, expect, it } from "vitest";
import type { MeasurementSample, Sensor } from "@climate-twin/contracts";
import { createDemoState } from "./domain";
import { energyDeviceMapStats, isEnergyDeviceSensor } from "./energyDeviceMap";

function sensor(overrides: Partial<Sensor> = {}): Sensor {
  return {
    id: "plug-1", houseId: "house-1", floorId: "floor-1", name: "Desk plug", room: "Office",
    model: "HS110", x: 1, y: 2, z: .3, tags: [], enabled: true, ...overrides,
  };
}

function sample(metric: "power" | "energy", value: number): MeasurementSample {
  return {
    sensorId: "plug-1", metric, value, canonicalUnit: metric === "power" ? "W" : "kWh",
    timestamp: "2026-07-19T10:00:00.000Z", source: "tp-link", quality: "good",
  };
}

describe("energy device map markers", () => {
  it("recognizes telemetry and entity capabilities as well as newly placed TP-Link energy models", () => {
    expect(isEnergyDeviceSensor(sensor({ model: "climate sensor" }), { power: sample("power", 42) })).toBe(true);
    expect(isEnergyDeviceSensor(sensor({ model: "climate sensor", measurementEntityIds: { energy: "sensor.desk_energy" } }))).toBe(true);
    expect(isEnergyDeviceSensor(sensor({ model: "Tapo P110M" }))).toBe(true);
    expect(isEnergyDeviceSensor(sensor({ model: "climate sensor" }))).toBe(false);
  });

  it("formats current power and cumulative energy as compact marker stats", () => {
    const definitions = createDemoState().measurementDefinitions;
    expect(energyDeviceMapStats({ power: sample("power", 37.4), energy: sample("energy", 1.238) }, definitions, "metric").short)
      .toBe("37 W · 1.24 kWh");
  });
});
