import { describe, expect, it } from "vitest";
import { floorMetersPerPlanUnit, wallLengthMeters, wallLengthPlanUnits, type MeasurementDefinition, type MeasurementSample, type Sensor } from "@climate-twin/contracts";
import { BUILTIN_MEASUREMENTS } from "../measurements";
import {
  clampPlanElementHeight,
  defaultPlanElementHeight,
  planElementBottomOffset,
  planElementHeightBounds,
} from "../planElementGeometry";
import {
  clampPlanElementWidth,
  defaultFloorGridSize,
  defaultPlanElementWidth,
  floorGridSize,
  floorRenderScale,
  interpolateHeat,
  insertRoomVertex,
  isValidRoomPolygon,
  nearestWallOpeningPlacement,
  nearestWallPlacement,
  planElementWidthBounds,
  roomRectanglePoints,
  snapPointToGrid,
  wallLengthInputValue,
} from "./FloorPlan";

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

describe("physical floor-plan scale", () => {
  it("derives every physical wall length from one level calibration", () => {
    const wall = { id: "diagonal", from: { x: 1, y: 1 }, to: { x: 4, y: 5 } };
    const floor = { metersPerPlanUnit: .2 };
    expect(wallLengthPlanUnits(wall)).toBe(5);
    expect(floorMetersPerPlanUnit(floor)).toBe(.2);
    expect(wallLengthMeters(wall, floor)).toBe(1);
    expect(wallLengthInputValue(1.23456)).toBe("1.235");
    expect(floorMetersPerPlanUnit({}, { mapPlacement: { latitude: 60, longitude: 24, metersPerPlanUnit: .05 } })).toBe(.05);
  });
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

describe("floor-plan grid", () => {
  it("chooses useful grid sizes for both drawing-unit and metre-scale floors", () => {
    expect(defaultFloorGridSize({ width: 1000, height: 640 })).toBe(25);
    expect(defaultFloorGridSize({ width: 14, height: 10 })).toBe(.5);
    expect(floorGridSize({ width: 14, height: 10 }, "fine")).toBe(.25);
    expect(floorGridSize({ width: 14, height: 10 }, "coarse")).toBe(1);
  });

  it("snaps to exact grid intersections, clamps to boundaries, and avoids float noise", () => {
    expect(snapPointToGrid({ x: .26, y: .31 }, { width: 14, height: 10 }, .1)).toEqual({ x: .3, y: .3 });
    expect(snapPointToGrid({ x: 13.99, y: 9.99 }, { width: 14, height: 10 }, .5)).toEqual({ x: 14, y: 10 });
    expect(snapPointToGrid({ x: -1, y: 12 }, { width: 14, height: 10 }, .5)).toEqual({ x: 0, y: 10 });
  });

  it("creates normalized rectangular room polygons from either drag direction", () => {
    expect(roomRectanglePoints({ x: 8, y: 7 }, { x: 2, y: 3 })).toEqual([
      { x: 2, y: 3 }, { x: 8, y: 3 }, { x: 8, y: 7 }, { x: 2, y: 7 },
    ]);
  });

  it("keeps architectural symbol defaults independent of grid density and bounds edits", () => {
    const floor = { width: 14, height: 10 };
    expect(defaultPlanElementWidth(floor, "door")).toBe(.875);
    expect(defaultPlanElementWidth(floor, "window")).toBeCloseTo(1.16666666667, 10);
    expect(defaultPlanElementWidth(floor, "fireplace")).toBe(1);
    expect(defaultPlanElementWidth(floor, "vent")).toBe(.56);
    expect(defaultPlanElementWidth(floor, "fireEscape")).toBeCloseTo(1.16666666667, 10);
    expect(floorGridSize(floor, "fine")).not.toBe(floorGridSize(floor, "coarse"));

    const bounds = planElementWidthBounds(floor, "door");
    expect(clampPlanElementWidth(floor, "door", 0)).toBe(bounds.min);
    expect(clampPlanElementWidth(floor, "door", 100)).toBe(bounds.max);
    const calibratedDrawing = { width: 1000, height: 640, metersPerPlanUnit: .02 };
    expect(planElementWidthBounds(calibratedDrawing, "door").min * .02).toBeCloseTo(.6, 8);
    expect(planElementWidthBounds(calibratedDrawing, "window").min * .02).toBeCloseTo(.6, 8);
  });

  it("resolves stable metre-based heights for legacy elements and keeps them inside the ceiling", () => {
    const floor = { width: 14, height: 10, elevation: 0, ceilingHeight: 2.8, walls: [], rooms: [] };
    expect(defaultPlanElementHeight(floor, "door")).toBe(2.1);
    expect(defaultPlanElementHeight(floor, "window")).toBe(1.2);
    expect(defaultPlanElementHeight(floor, "fireplace")).toBe(1.25);
    const doorBounds = planElementHeightBounds(floor, "door");
    expect(doorBounds.min).toBe(.6);
    expect(clampPlanElementHeight(floor, "door", .6)).toBe(.6);
    expect(clampPlanElementHeight(floor, "door", 99)).toBe(doorBounds.max);
    expect(clampPlanElementHeight(floor, "door", 0)).toBe(doorBounds.min);
    expect(planElementBottomOffset(floor, {
      id: "legacy-window", kind: "window", wallId: "north", position: { x: 2, y: 0 }, rotationDegrees: 0,
    })).toBeCloseTo(.9);
  });

  it("rejects collapsed and self-intersecting room polygons", () => {
    expect(isValidRoomPolygon([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }])).toBe(true);
    expect(isValidRoomPolygon([{ x: 0, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }, { x: 4, y: 0 }])).toBe(false);
    expect(isValidRoomPolygon([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }])).toBe(false);
    expect(isValidRoomPolygon([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 0 }])).toBe(false);
  });

  it("inserts ordered edit points that can form a valid six-corner L-shaped room", () => {
    let points = roomRectanglePoints({ x: 0, y: 0 }, { x: 10, y: 10 });
    points = insertRoomVertex(points, 1);
    points = insertRoomVertex(points, 3);
    points[3] = { x: 5, y: 5 };

    expect(points).toEqual([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 },
      { x: 5, y: 5 }, { x: 5, y: 10 }, { x: 0, y: 10 },
    ]);
    expect(isValidRoomPolygon(points)).toBe(true);
  });

  it("projects openings to the closest wall and preserves its angle", () => {
    const walls = [
      { id: "horizontal", from: { x: 0, y: 2 }, to: { x: 10, y: 2 } },
      { id: "vertical", from: { x: 8, y: 0 }, to: { x: 8, y: 10 } },
    ];
    expect(nearestWallPlacement({ x: 4, y: 2.2 }, walls, 10)).toMatchObject({
      wallId: "horizontal", position: { x: 4, y: 2 }, rotationDegrees: 0,
    });
    expect(nearestWallPlacement({ x: 8.1, y: 6 }, walls, 10)).toMatchObject({
      wallId: "vertical", position: { x: 8, y: 6 }, rotationDegrees: 90,
    });
    expect(nearestWallPlacement({ x: 4, y: 9 }, walls, 10, 5)).toBeNull();
  });

  it("keeps an opening's full width inside a wall and distinguishes short walls", () => {
    const wall = { id: "wall", from: { x: 0, y: 2 }, to: { x: 10, y: 2 } };
    expect(nearestWallOpeningPlacement({ x: 0, y: 2 }, [wall], 10, 4)).toMatchObject({
      failure: null,
      placement: { wallId: "wall", position: { x: 2, y: 2 } },
    });
    expect(nearestWallOpeningPlacement({ x: 10, y: 2 }, [wall], 10, 4)).toMatchObject({
      failure: null,
      placement: { wallId: "wall", position: { x: 8, y: 2 } },
    });
    expect(nearestWallOpeningPlacement({ x: 1, y: 2 }, [{ ...wall, to: { x: 1, y: 2 } }], 10, 2)).toEqual({
      placement: null,
      failure: "wall-too-short",
    });
    expect(nearestWallOpeningPlacement({ x: 5, y: 20 }, [wall], 10, 2)).toEqual({
      placement: null,
      failure: "no-wall",
    });
  });
});
