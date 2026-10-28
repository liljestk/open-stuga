import type { Point } from "@climate-twin/contracts";
import { windPathOnRectangle, windSourceVector, type OutdoorBoundaryContext, type PlanEdge } from "./context";

export const MIN_ANIMATED_WIND_SPEED_MPS = 0.3;

interface RoundedRectangle {
  left: number;
  top: number;
  width: number;
  height: number;
  radius: number;
}

export interface OutdoorWindFlowGeometry {
  source: Point;
  sourceEdge: PlanEdge;
  windwardPath: string;
  incomingPaths: readonly string[];
  bypassPaths: readonly string[];
  labelRotation: number;
  particleCount: number;
  durationSeconds: number;
  motionSupported: boolean;
}

function roundedRectangleLength(rect: RoundedRectangle): number {
  return 2 * (rect.width + rect.height - 4 * rect.radius) + 2 * Math.PI * rect.radius;
}

function normalizeDistance(distance: number, perimeter: number): number {
  return ((distance % perimeter) + perimeter) % perimeter;
}

/** Clockwise point on a rounded rectangle, starting after its top-left corner. */
function roundedRectanglePoint(rect: RoundedRectangle, rawDistance: number): Point {
  const { left, top, width, height, radius } = rect;
  const right = left + width;
  const bottom = top + height;
  const horizontal = width - 2 * radius;
  const vertical = height - 2 * radius;
  const arc = Math.PI * radius / 2;
  const perimeter = roundedRectangleLength(rect);
  let distance = normalizeDistance(rawDistance, perimeter);

  if (distance <= horizontal) return { x: left + radius + distance, y: top };
  distance -= horizontal;
  if (distance <= arc) {
    const angle = -Math.PI / 2 + distance / radius;
    return { x: right - radius + Math.cos(angle) * radius, y: top + radius + Math.sin(angle) * radius };
  }
  distance -= arc;
  if (distance <= vertical) return { x: right, y: top + radius + distance };
  distance -= vertical;
  if (distance <= arc) {
    const angle = distance / radius;
    return { x: right - radius + Math.cos(angle) * radius, y: bottom - radius + Math.sin(angle) * radius };
  }
  distance -= arc;
  if (distance <= horizontal) return { x: right - radius - distance, y: bottom };
  distance -= horizontal;
  if (distance <= arc) {
    const angle = Math.PI / 2 + distance / radius;
    return { x: left + radius + Math.cos(angle) * radius, y: bottom - radius + Math.sin(angle) * radius };
  }
  distance -= arc;
  if (distance <= vertical) return { x: left, y: bottom - radius - distance };
  distance -= vertical;
  const angle = Math.PI + distance / radius;
  return { x: left + radius + Math.cos(angle) * radius, y: top + radius + Math.sin(angle) * radius };
}

function nearestRoundedRectangleDistance(rect: RoundedRectangle, target: Point): number {
  const perimeter = roundedRectangleLength(rect);
  const sampleCount = 360;
  let bestDistance = 0;
  let bestSquared = Number.POSITIVE_INFINITY;
  for (let index = 0; index < sampleCount; index += 1) {
    const distance = perimeter * index / sampleCount;
    const point = roundedRectanglePoint(rect, distance);
    const squared = (point.x - target.x) ** 2 + (point.y - target.y) ** 2;
    if (squared < bestSquared) {
      bestSquared = squared;
      bestDistance = distance;
    }
  }

  let step = perimeter / sampleCount;
  for (let pass = 0; pass < 8; pass += 1) {
    const candidates = [bestDistance - step, bestDistance, bestDistance + step];
    for (const distance of candidates) {
      const point = roundedRectanglePoint(rect, distance);
      const squared = (point.x - target.x) ** 2 + (point.y - target.y) ** 2;
      if (squared < bestSquared) {
        bestSquared = squared;
        bestDistance = distance;
      }
    }
    step /= 2;
  }
  return normalizeDistance(bestDistance, perimeter);
}

function sampledRoundedPath(
  rect: RoundedRectangle,
  startDistance: number,
  travelDistance: number,
  sampleCount: number,
): string {
  const points = Array.from({ length: sampleCount + 1 }, (_, index) => (
    roundedRectanglePoint(rect, startDistance + travelDistance * index / sampleCount)
  ));
  return points.map((point, index) => (
    `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`
  )).join("");
}

function sourceEdge(source: Point, rect: RoundedRectangle): PlanEdge {
  const top: [PlanEdge, number] = ["top", Math.abs(source.y - rect.top)];
  const others: Array<[PlanEdge, number]> = [
    ["right", Math.abs(source.x - (rect.left + rect.width))],
    ["bottom", Math.abs(source.y - (rect.top + rect.height))],
    ["left", Math.abs(source.x - rect.left)],
  ];
  return others.reduce((best, candidate) => candidate[1] < best[1] ? candidate : best, top)[0];
}

function windParticleCount(windSpeedMps: number | null): number {
  if (windSpeedMps === null || windSpeedMps < MIN_ANIMATED_WIND_SPEED_MPS) return 0;
  if (windSpeedMps < 3) return 1;
  if (windSpeedMps < 8) return 2;
  return 3;
}

export function createOutdoorWindFlowGeometry(
  context: OutdoorBoundaryContext,
  width: number,
  height: number,
  shellOffset: number,
): OutdoorWindFlowGeometry | null {
  if (context.planWindFromDegrees === null || width <= 0 || height <= 0) return null;
  const rect: RoundedRectangle = {
    left: -shellOffset,
    top: -shellOffset,
    width: width + shellOffset * 2,
    height: height + shellOffset * 2,
    radius: Math.min(32, (width + shellOffset * 2) / 2, (height + shellOffset * 2) / 2),
  };
  const sharpPath = windPathOnRectangle(context.planWindFromDegrees, rect.width, rect.height);
  const sharpSource = {
    x: sharpPath.sourcePoint.x + rect.left,
    y: sharpPath.sourcePoint.y + rect.top,
  };
  const perimeter = roundedRectangleLength(rect);
  const sourceDistance = nearestRoundedRectangleDistance(rect, sharpSource);
  const source = roundedRectanglePoint(rect, sourceDistance);
  const segmentLength = Math.min(perimeter * .14, Math.max(150, Math.min(width, height) * .7));
  const windwardPath = sampledRoundedPath(rect, sourceDistance - segmentLength / 2, segmentLength, 24);
  const sourceVector = windSourceVector(context.planWindFromDegrees);
  const inwardVector = { x: -sourceVector.x, y: -sourceVector.y };
  const tangent = { x: -sourceVector.y, y: sourceVector.x };
  const incomingPaths = [-18, 0, 18].map((lane) => {
    const start = {
      x: source.x + sourceVector.x * 58 + tangent.x * lane,
      y: source.y + sourceVector.y * 58 + tangent.y * lane,
    };
    const end = {
      x: source.x + inwardVector.x * 3 + tangent.x * lane * .14,
      y: source.y + inwardVector.y * 3 + tangent.y * lane * .14,
    };
    const control = {
      x: (start.x + end.x) / 2 + tangent.x * lane * .08,
      y: (start.y + end.y) / 2 + tangent.y * lane * .08,
    };
    return `M${start.x.toFixed(2)} ${start.y.toFixed(2)}Q${control.x.toFixed(2)} ${control.y.toFixed(2)} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
  });
  const bypassLength = Math.min(perimeter * .26, Math.max(260, Math.min(width, height) * .9));
  const bypassPaths = [
    sampledRoundedPath(rect, sourceDistance, bypassLength, 30),
    sampledRoundedPath(rect, sourceDistance, -bypassLength, 30),
  ];
  const rawWindSpeed = context.conditions.windSpeedMps;
  const windSpeedMps = typeof rawWindSpeed === "number" && Number.isFinite(rawWindSpeed) ? rawWindSpeed : null;
  const particleCount = windParticleCount(windSpeedMps);
  const edge = sourceEdge(source, rect);

  return {
    source,
    sourceEdge: edge,
    windwardPath,
    incomingPaths,
    bypassPaths,
    labelRotation: edge === "left" || edge === "right" ? 90 : 0,
    particleCount,
    durationSeconds: 4.2,
    motionSupported: !context.stale && particleCount > 0,
  };
}
