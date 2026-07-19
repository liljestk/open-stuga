import { describe, expect, it } from "vitest";
import type { Floor } from "@climate-twin/contracts";
import { createDemoState } from "./domain";
import { chimneyPenetrationsForFloor, fireplaceChimneyTop, roofPeakZ, roofSurfaces } from "./architecturalGeometry";

describe("architectural geometry", () => {
  it("builds pitched roof surfaces above an attic knee wall", () => {
    const floor: Floor = {
      id: "attic", name: "Attic", type: "attic", width: 10, height: 8, elevation: 5.8, ceilingHeight: 2.4, wallHeight: 1,
      walls: [], rooms: [],
      roof: { style: "gable", pitchDegrees: 45, ridgeAxis: "x", overhang: .5, eavesHeight: 1 },
    };
    expect(roofPeakZ(floor)).toBeCloseTo(8.2, 8);
    expect(roofSurfaces(floor)).toHaveLength(2);
    expect(Math.max(...roofSurfaces(floor).flat().map((point) => point.z))).toBeCloseTo(8.2, 8);
  });

  it("projects a roof-reaching fireplace through every higher floor", () => {
    const state = createDemoState();
    const [ground, upper] = state.houses[0]!.floors;
    const fireplace = {
      id: "fireplace", kind: "fireplace" as const, position: { x: 4, y: 3 }, rotationDegrees: 0,
      width: 1, height: 1.2, verticalExtent: "roof" as const, chimneyHeightAboveRoof: .8,
    };
    const attic: Floor = {
      ...upper!, id: "attic", name: "Attic", type: "attic", elevation: 6, wallHeight: .9,
      roof: { style: "gable", pitchDegrees: 35, ridgeAxis: "x", overhang: .3, eavesHeight: .9 },
      planElements: [],
    };
    const house = {
      ...state.houses[0]!,
      floors: [{ ...ground!, planElements: [fireplace] }, upper!, attic],
    };

    expect(chimneyPenetrationsForFloor(house, upper!)).toEqual([expect.objectContaining({ sourceFloorId: ground!.id, element: fireplace })]);
    expect(chimneyPenetrationsForFloor(house, attic)).toHaveLength(1);
    expect(fireplaceChimneyTop(house, ground!, fireplace)).toBeCloseTo(roofPeakZ(attic) + .8, 8);
  });
});
