import type { Floor, PlanElement, PlanElementKind, Wall } from "@climate-twin/contracts";
import { clamp } from "./domain";

export const DEFAULT_CEILING_HEIGHT_METRES = 2.8;

const WIDTH_CONFIG: Record<PlanElementKind, { spanDivisor: number; minFactor: number; maxFactor: number }> = {
  door: { spanDivisor: 16, minFactor: .55, maxFactor: 1.8 },
  window: { spanDivisor: 12, minFactor: .4, maxFactor: 2.5 },
  fireplace: { spanDivisor: 14, minFactor: .5, maxFactor: 2 },
  vent: { spanDivisor: 25, minFactor: .35, maxFactor: 2 },
};

const GEOMETRY_EPSILON = 1e-8;

export interface DimensionBounds {
  min: number;
  max: number;
  step: number;
}

export function isWallOpening(element: PlanElement): element is Extract<PlanElement, { kind: "door" | "window" }> {
  return element.kind === "door" || element.kind === "window";
}

/** Architectural width defaults are expressed in the floor plan's local x/y units. */
export function defaultPlanElementWidth(floor: Pick<Floor, "width" | "height">, kind: PlanElementKind): number {
  const span = Math.max(floor.width, floor.height, GEOMETRY_EPSILON);
  return Number((span / WIDTH_CONFIG[kind].spanDivisor).toPrecision(12));
}

export function planElementWidthBounds(floor: Pick<Floor, "width" | "height">, kind: PlanElementKind): DimensionBounds {
  const defaultWidth = defaultPlanElementWidth(floor, kind);
  const config = WIDTH_CONFIG[kind];
  return {
    min: Number((defaultWidth * config.minFactor).toPrecision(12)),
    max: Number((defaultWidth * config.maxFactor).toPrecision(12)),
    step: Number((defaultWidth / 10).toPrecision(12)),
  };
}

export function clampPlanElementWidth(
  floor: Pick<Floor, "width" | "height">,
  kind: PlanElementKind,
  width: number,
): number {
  const bounds = planElementWidthBounds(floor, kind);
  return Number(clamp(Number.isFinite(width) ? width : defaultPlanElementWidth(floor, kind), bounds.min, bounds.max).toPrecision(12));
}

function distanceAlongWall(position: PlanElement["position"], wall: Wall) {
  const dx = wall.to.x - wall.from.x;
  const dy = wall.to.y - wall.from.y;
  const length = Math.hypot(dx, dy);
  if (length <= GEOMETRY_EPSILON) return null;
  const progress = clamp(((position.x - wall.from.x) * dx + (position.y - wall.from.y) * dy) / (length * length), 0, 1);
  return { length, distanceFromStart: progress * length, distanceFromEnd: (1 - progress) * length };
}

/** Narrows a wall opening's live slider to widths that still fit at its current position. */
export function editablePlanElementWidthBounds(floor: Floor, element: PlanElement): DimensionBounds {
  const bounds = planElementWidthBounds(floor, element.kind);
  if (!isWallOpening(element)) return bounds;
  const wall = floor.walls.find((candidate) => candidate.id === element.wallId);
  const distances = wall ? distanceAlongWall(element.position, wall) : null;
  if (!distances) return bounds;
  const available = Math.max(GEOMETRY_EPSILON, 2 * Math.min(distances.distanceFromStart, distances.distanceFromEnd));
  const max = Math.min(bounds.max, available);
  return {
    min: Math.min(bounds.min, max),
    max,
    step: Math.min(bounds.step, Math.max(max / 10, GEOMETRY_EPSILON)),
  };
}

function ceilingHeight(floor: Pick<Floor, "ceilingHeight">): number {
  return Math.max(.2, floor.ceilingHeight ?? DEFAULT_CEILING_HEIGHT_METRES);
}

/** Vertical dimensions are stored in metres, matching Floor.elevation and ceilingHeight. */
export function planElementHeightBounds(
  floor: Pick<Floor, "ceilingHeight">,
  kind: PlanElementKind,
): DimensionBounds {
  const ceiling = ceilingHeight(floor);
  const configured = {
    door: { min: 1.6, max: ceiling, step: .05 },
    window: { min: .3, max: Math.max(.3, ceiling - .2), step: .05 },
    fireplace: { min: .4, max: ceiling, step: .05 },
    vent: { min: .1, max: Math.min(.8, ceiling), step: .05 },
  }[kind];
  const max = Math.max(.05, configured.max);
  return { min: Math.min(configured.min, max), max, step: configured.step };
}

export function defaultPlanElementHeight(
  floor: Pick<Floor, "ceilingHeight">,
  kind: PlanElementKind,
): number {
  const bounds = planElementHeightBounds(floor, kind);
  const preferred = { door: 2.1, window: 1.2, fireplace: 1.25, vent: .3 }[kind];
  return Number(clamp(preferred, bounds.min, bounds.max).toFixed(2));
}

export function clampPlanElementHeight(
  floor: Pick<Floor, "ceilingHeight">,
  kind: PlanElementKind,
  height: number,
): number {
  const bounds = planElementHeightBounds(floor, kind);
  return Number(clamp(Number.isFinite(height) ? height : defaultPlanElementHeight(floor, kind), bounds.min, bounds.max).toFixed(2));
}

export function effectivePlanElementHeight(floor: Pick<Floor, "ceilingHeight">, element: PlanElement): number {
  return clampPlanElementHeight(floor, element.kind, element.height ?? defaultPlanElementHeight(floor, element.kind));
}

export function defaultPlanElementBottomOffset(floor: Pick<Floor, "ceilingHeight">, element: PlanElement): number {
  const ceiling = ceilingHeight(floor);
  const height = effectivePlanElementHeight(floor, element);
  if (element.kind === "window") return Math.max(0, Math.min(ceiling - height, Math.min(.9, ceiling * .34)));
  if (element.kind === "vent") return Math.max(0, ceiling - height - .15);
  return 0;
}

/** Base offset above the floor plane, with a kind-specific default and a safe vertical clamp. */
export function planElementBottomOffset(floor: Pick<Floor, "ceilingHeight">, element: PlanElement): number {
  const ceiling = ceilingHeight(floor);
  const height = effectivePlanElementHeight(floor, element);
  const configured = element.kind === "fireplace" ? undefined : element.bottomOffsetM;
  return Number(clamp(configured ?? defaultPlanElementBottomOffset(floor, element), 0, Math.max(0, ceiling - height)).toFixed(2));
}
