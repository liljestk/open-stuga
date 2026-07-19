import type { Floor, House, PlanElement, RoofDesign } from "@climate-twin/contracts";
import { DEFAULT_CEILING_HEIGHT_METRES, effectivePlanElementHeight } from "./planElementGeometry";

export const DEFAULT_ROOF_DESIGN: RoofDesign = {
  style: "gable",
  pitchDegrees: 35,
  ridgeAxis: "x",
  overhang: .35,
  eavesHeight: .9,
};

export function roofRun(floor: Floor): number {
  if (!floor.roof || floor.roof.style === "flat") return 0;
  const crossSpan = floor.roof.ridgeAxis === "x" ? floor.height : floor.width;
  return floor.roof.style === "shed"
    ? crossSpan + floor.roof.overhang * 2
    : crossSpan / 2 + floor.roof.overhang;
}

export function roofEavesZ(floor: Floor): number {
  if (!floor.roof) return floor.elevation + (floor.wallHeight ?? floor.ceilingHeight ?? DEFAULT_CEILING_HEIGHT_METRES);
  if (floor.roof.style === "flat") {
    return floor.elevation + Math.max(floor.wallHeight ?? 0, floor.ceilingHeight ?? DEFAULT_CEILING_HEIGHT_METRES);
  }
  return floor.elevation + (floor.wallHeight ?? floor.roof.eavesHeight);
}

export function roofPeakZ(floor: Floor): number {
  if (!floor.roof) return floor.elevation + (floor.ceilingHeight ?? DEFAULT_CEILING_HEIGHT_METRES);
  const geometricRise = Math.tan(floor.roof.pitchDegrees * Math.PI / 180) * roofRun(floor);
  const wallHeight = roofEavesZ(floor) - floor.elevation;
  const physicalRise = floor.ceilingHeight === undefined ? null : Math.max(0, floor.ceilingHeight - wallHeight);
  const rise = physicalRise === null ? geometricRise : Math.min(geometricRise, physicalRise);
  return roofEavesZ(floor) + rise;
}

export interface RoofPoint3D { x: number; y: number; z: number }

/** World-space roof faces shared by the 3D renderer and geometry tests. */
export function roofSurfaces(floor: Floor): RoofPoint3D[][] {
  const roof = floor.roof;
  if (!roof) return [];
  const x0 = -roof.overhang;
  const x1 = floor.width + roof.overhang;
  const y0 = -roof.overhang;
  const y1 = floor.height + roof.overhang;
  const eaves = roofEavesZ(floor);
  const peak = roofPeakZ(floor);
  if (roof.style === "flat") return [[
    { x: x0, y: y0, z: eaves }, { x: x1, y: y0, z: eaves },
    { x: x1, y: y1, z: eaves }, { x: x0, y: y1, z: eaves },
  ]];
  if (roof.style === "shed") {
    return roof.ridgeAxis === "x" ? [[
      { x: x0, y: y0, z: eaves }, { x: x1, y: y0, z: eaves },
      { x: x1, y: y1, z: peak }, { x: x0, y: y1, z: peak },
    ]] : [[
      { x: x0, y: y0, z: eaves }, { x: x1, y: y0, z: peak },
      { x: x1, y: y1, z: peak }, { x: x0, y: y1, z: eaves },
    ]];
  }
  if (roof.ridgeAxis === "x") {
    const middle = (y0 + y1) / 2;
    if (roof.style === "gable") return [
      [{ x: x0, y: y0, z: eaves }, { x: x1, y: y0, z: eaves }, { x: x1, y: middle, z: peak }, { x: x0, y: middle, z: peak }],
      [{ x: x0, y: middle, z: peak }, { x: x1, y: middle, z: peak }, { x: x1, y: y1, z: eaves }, { x: x0, y: y1, z: eaves }],
    ];
    const inset = Math.min((y1 - y0) / 2, (x1 - x0) / 2);
    const ridge0 = x0 + inset;
    const ridge1 = x1 - inset;
    return [
      [{ x: x0, y: y0, z: eaves }, { x: x1, y: y0, z: eaves }, { x: ridge1, y: middle, z: peak }, { x: ridge0, y: middle, z: peak }],
      [{ x: x0, y: y1, z: eaves }, { x: ridge0, y: middle, z: peak }, { x: ridge1, y: middle, z: peak }, { x: x1, y: y1, z: eaves }],
      [{ x: x0, y: y0, z: eaves }, { x: ridge0, y: middle, z: peak }, { x: x0, y: y1, z: eaves }],
      [{ x: x1, y: y0, z: eaves }, { x: x1, y: y1, z: eaves }, { x: ridge1, y: middle, z: peak }],
    ];
  }
  const middle = (x0 + x1) / 2;
  if (roof.style === "gable") return [
    [{ x: x0, y: y0, z: eaves }, { x: middle, y: y0, z: peak }, { x: middle, y: y1, z: peak }, { x: x0, y: y1, z: eaves }],
    [{ x: middle, y: y0, z: peak }, { x: x1, y: y0, z: eaves }, { x: x1, y: y1, z: eaves }, { x: middle, y: y1, z: peak }],
  ];
  const inset = Math.min((x1 - x0) / 2, (y1 - y0) / 2);
  const ridge0 = y0 + inset;
  const ridge1 = y1 - inset;
  return [
    [{ x: x0, y: y0, z: eaves }, { x: middle, y: ridge0, z: peak }, { x: middle, y: ridge1, z: peak }, { x: x0, y: y1, z: eaves }],
    [{ x: x1, y: y0, z: eaves }, { x: x1, y: y1, z: eaves }, { x: middle, y: ridge1, z: peak }, { x: middle, y: ridge0, z: peak }],
    [{ x: x0, y: y0, z: eaves }, { x: x1, y: y0, z: eaves }, { x: middle, y: ridge0, z: peak }],
    [{ x: x0, y: y1, z: eaves }, { x: middle, y: ridge1, z: peak }, { x: x1, y: y1, z: eaves }],
  ];
}

export function isRoofSpanningFireplace(element: PlanElement): element is PlanElement & { kind: "fireplace"; verticalExtent: "roof" } {
  return element.kind === "fireplace" && element.verticalExtent === "roof";
}

export function fireplaceChimneyTop(house: House, sourceFloor: Floor, element: PlanElement): number {
  const higherStructure = house.floors
    .filter((floor) => floor.elevation >= sourceFloor.elevation)
    .map((floor) => floor.roof
      ? roofPeakZ(floor)
      : floor.elevation + (floor.wallHeight ?? floor.ceilingHeight ?? DEFAULT_CEILING_HEIGHT_METRES));
  const clearance = element.kind === "fireplace" ? (element.chimneyHeightAboveRoof ?? .6) : 0;
  return Math.max(
    sourceFloor.elevation + effectivePlanElementHeight(sourceFloor, element),
    ...higherStructure,
  ) + clearance;
}

export interface ChimneyPenetration {
  sourceFloorId: string;
  element: PlanElement & { kind: "fireplace" };
}

/** Fireplaces originating below this floor that occupy its plan as a chimney shaft. */
export function chimneyPenetrationsForFloor(house: House | undefined, floor: Floor): ChimneyPenetration[] {
  if (!house) return [];
  return house.floors.flatMap((sourceFloor) => {
    if (sourceFloor.elevation >= floor.elevation) return [];
    return (sourceFloor.planElements ?? []).flatMap((element) => (
      isRoofSpanningFireplace(element) && element.kind === "fireplace"
        ? [{ sourceFloorId: sourceFloor.id, element }]
        : []
    ));
  });
}
