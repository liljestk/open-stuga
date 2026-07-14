import type { House, HouseWeather, OutdoorConditions, Point } from "@climate-twin/contracts";

export type PlanEdge = "top" | "right" | "bottom" | "left";

/**
 * Weather values translated into the floor plan's coordinate system.
 *
 * SVG coordinates grow right/down. `sourceVector` points from the plan centre
 * toward the upwind side; `inwardVector` points in the direction the air moves.
 * Points are normalized to a 0..1 plan rectangle so renderers can scale them.
 */
export interface OutdoorBoundaryContext {
  conditions: OutdoorConditions;
  observedAt: string;
  stale: boolean;
  /** Meteorological bearing: the compass direction the wind comes from. */
  windFromDegrees: number | null;
  windFromCardinal: string | null;
  /** Wind-from bearing clockwise from the top of the floor plan. */
  planWindFromDegrees: number | null;
  sourceVector: Point | null;
  inwardVector: Point | null;
  windwardEdge: PlanEdge | null;
  sourcePoint: Point | null;
  inwardTarget: Point | null;
}

/** Normalize a finite angle to the half-open range [0, 360). */
export function normalizeDegrees(degrees: number): number {
  if (!Number.isFinite(degrees)) throw new RangeError("Angle must be finite");
  return ((degrees % 360) + 360) % 360;
}

/** Return the nearest eight-point compass direction for a bearing. */
export function cardinalDirection(degrees: number): "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW" {
  const labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
  return labels[Math.floor((normalizeDegrees(degrees) + 22.5) / 45) % labels.length]!;
}

/** Convert a true-north wind-from bearing to clockwise-from-plan-top. */
export function planRelativeWindFrom(windFromDegrees: number, planTopBearingDegrees: number): number {
  return normalizeDegrees(windFromDegrees - planTopBearingDegrees);
}

/** Unit vector from plan centre toward the meteorological source/upwind side. */
export function windSourceVector(planWindFromDegrees: number): Point {
  const radians = normalizeDegrees(planWindFromDegrees) * Math.PI / 180;
  return { x: Math.sin(radians), y: -Math.cos(radians) };
}

export function windwardPlanEdge(planWindFromDegrees: number): PlanEdge {
  const edges: readonly PlanEdge[] = ["top", "right", "bottom", "left"];
  return edges[Math.floor((normalizeDegrees(planWindFromDegrees) + 45) / 90) % edges.length]!;
}

/**
 * Build an incoming arrow against the facade side that most directly faces
 * the wind. Distances are fractions of the rectangle's shorter dimension, so
 * the vector keeps its angle on non-square floor plans.
 */
export function windPathOnRectangle(
  planWindFromDegrees: number,
  width: number,
  height: number,
  inset = 0.22,
  outset = 0,
): {
  sourcePoint: Point;
  inwardTarget: Point;
  windwardEdge: PlanEdge;
} {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new RangeError("Plan dimensions must be positive and finite");
  }
  if (!Number.isFinite(inset) || inset < 0 || inset > 0.5
    || !Number.isFinite(outset) || outset < 0 || outset > 0.5) {
    throw new RangeError("Inset and outset must be between 0 and 0.5");
  }

  const sourceVector = windSourceVector(planWindFromDegrees);
  const windwardEdge = windwardPlanEdge(planWindFromDegrees);
  const boundaryPoint = windwardEdge === "top"
    ? { x: width / 2, y: 0 }
    : windwardEdge === "right"
      ? { x: width, y: height / 2 }
      : windwardEdge === "bottom"
        ? { x: width / 2, y: height }
        : { x: 0, y: height / 2 };
  const scale = Math.min(width, height);
  return {
    sourcePoint: {
      x: boundaryPoint.x + sourceVector.x * outset * scale,
      y: boundaryPoint.y + sourceVector.y * outset * scale,
    },
    inwardTarget: {
      x: boundaryPoint.x - sourceVector.x * inset * scale,
      y: boundaryPoint.y - sourceVector.y * inset * scale,
    },
    windwardEdge,
  };
}

/**
 * Find a boundary source point and a short target inside a normalized plan.
 * `inset` is the arrow depth in normalized plan units.
 */
export function windPathOnUnitPlan(planWindFromDegrees: number, inset = 0.22): {
  sourcePoint: Point;
  inwardTarget: Point;
} {
  const { sourcePoint, inwardTarget } = windPathOnRectangle(planWindFromDegrees, 1, 1, inset);
  return { sourcePoint, inwardTarget };
}

export function createOutdoorBoundaryContext(
  house: House,
  weather: HouseWeather | null,
): OutdoorBoundaryContext | null {
  const conditions = weather?.current;
  if (!conditions) return null;

  const rawWindFrom = conditions.windDirectionDegrees;
  const windFromDegrees = typeof rawWindFrom === "number" && Number.isFinite(rawWindFrom)
    ? normalizeDegrees(rawWindFrom)
    : null;
  const hasOrientation = typeof house.orientationDegrees === "number" && Number.isFinite(house.orientationDegrees);
  const planWindFromDegrees = windFromDegrees !== null && hasOrientation
    ? planRelativeWindFrom(windFromDegrees, house.orientationDegrees!)
    : null;
  const sourceVector = planWindFromDegrees === null ? null : windSourceVector(planWindFromDegrees);
  const path = planWindFromDegrees === null ? null : windPathOnUnitPlan(planWindFromDegrees);

  return {
    conditions,
    observedAt: conditions.timestamp,
    stale: weather.stale,
    windFromDegrees,
    windFromCardinal: windFromDegrees === null ? null : cardinalDirection(windFromDegrees),
    planWindFromDegrees,
    sourceVector,
    inwardVector: sourceVector === null ? null : { x: -sourceVector.x, y: -sourceVector.y },
    windwardEdge: planWindFromDegrees === null ? null : windwardPlanEdge(planWindFromDegrees),
    sourcePoint: path?.sourcePoint ?? null,
    inwardTarget: path?.inwardTarget ?? null,
  };
}
