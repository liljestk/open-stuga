import { describe, expect, it } from "vitest";
import type { MeasurementDefinition, MeasurementSample, Sensor } from "@climate-twin/contracts";
import { BUILTIN_MEASUREMENTS } from "../measurements";
import { floorRenderScale, interpolateHeat } from "./FloorPlan";

const sensors: Sensor[] = [
  { id: "cold", houseId: "home", floorId: "ground", name: "Cold", room: "A", model: "T310", x: 100, y: 100, z: 1, tags: [], enabled: true },
  { id: "warm", houseId: "home", floorId: "ground", name: "Warm", room: "B", model: "T310", x: 900, y: 500, z: 1, tags: [], enabled: true },
];

const temperature = BUILTIN_MEASUREMENTS.find((definition) => definition.id === "temperature")!;
const humidity = BUILTIN_MEASUREMENTS.find((definition) => definition.id === "humidity")!;

const sample = (sensorId: string, definition: MeasurementDefinition, value: number): MeasurementSample => ({
  sensorId, metric: definition.id, value, canonicalUnit: definition.unit,
  timestamp: "2026-07-14T08:00:00.000Z", source: "mock", quality: "good",
});

describe("interpolateHeat", () => {
  it("normalizes metre-based layouts into stable drawing units", () => {
    const scale = floorRenderScale(14);
    expect(scale).toBeCloseTo(71.43, 2);
    expect(14 * scale).toBeCloseTo(1000);
    expect(10 * scale).toBeGreaterThan(700);
  });

  it("creates a complete inverse-distance field that tracks sensor extremes", () => {
    const result = interpolateHeat(sensors, {
      cold: sample("cold", temperature, 18),
      warm: sample("warm", temperature, 26),
    }, temperature, 1000, 600);
    expect(result.cells.length).toBeGreaterThan(200);
    expect(result.min).toBeLessThan(18);
    expect(result.max).toBeGreaterThan(26);
    const nearCold = result.cells.reduce((best, cell) => Math.hypot(cell.x - 100, cell.y - 100) < Math.hypot(best.x - 100, best.y - 100) ? cell : best);
    const nearWarm = result.cells.reduce((best, cell) => Math.hypot(cell.x - 900, cell.y - 500) < Math.hypot(best.x - 900, best.y - 500) ? cell : best);
    expect(nearWarm.value).toBeGreaterThan(nearCold.value);
  });

  it("returns no fabricated field before sensors report", () => {
    const result = interpolateHeat(sensors, {}, humidity, 1000, 600);
    expect(result.cells).toEqual([]);
    expect(result.min).toBeLessThan(result.max);
  });

  it("never interpolates a measurement whose registry definition is non-spatial", () => {
    const custom: MeasurementDefinition = {
      id: "voc_index", labels: { en: "VOC index" }, unit: "index", precision: 0,
      validMin: 0, validMax: 500, displayMin: 0, displayMax: 500, interpolationDelta: 10,
      colorScale: "sequential", builtin: false, enabled: true,
      spatialInterpolation: false, forecastSupported: false,
    };
    const result = interpolateHeat(sensors, {
      cold: sample("cold", custom, 80),
      warm: sample("warm", custom, 140),
    }, custom, 1000, 600);

    expect(result.cells).toEqual([]);
    expect(result).toMatchObject({ min: 0, max: 500 });
  });
});
