import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { BoxSelect, Grid3X3, ImagePlus, MapPinPlus, MousePointer2, PenLine, Plus, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import { floorMetersPerPlanUnit, isAirflowPlanElement, wallLengthPlanUnits, type ConfiguredOpeningState, type Floor, type House, type ManualObservation, type MeasurementDefinition, type MeasurementSample, type OpeningStateObservation, type PlanElement, type PlanElementKind, type Point, type Room, type Sensor, type UnitSystem, type Wall } from "@climate-twin/contracts";
import { clamp, round, type ViewMode } from "../../../domain";
import { useI18n, type TranslationKey } from "../../../i18n";
import { formatMeasurement, formatMeasurementDelta, measurementGradient, measurementLabel, measurementValue, toDisplayValue, type LatestMeasurements } from "../../../measurements";
import { energyDeviceMapStats, isEnergyDeviceSensor } from "../../../energyDeviceMap";
import { createCloudLobes, estimateFieldFlows, heatColor, interpolateHeat } from "../../../spatialField";
import { simulateFloorAirflow, type AirflowPoint2D, type ClimateSampleMatrix, type FloorAirflowEstimate } from "../../../airflowSimulation";
import { configuredSpatialMaxSampleAgeMs, isSpatialSampleFresh } from "../../../spatialFreshness";
import { cardinalDirection, normalizeDegrees, windPathOnRectangle, type PlanEdge } from "../../../outdoorContext";
import {
  formatOutdoorHumidity,
  formatOutdoorTemperature,
  formatOutdoorWindSpeed,
  OutdoorConditionsBadge,
  type OutdoorVisualizationState,
} from "../../OutdoorConditionsBadge";
import { PlanElementDimensionFields } from "../../PlanElementDimensionFields";
import { applyAirflowPlanElementPatch, PlanElementAirflowFields, type AirflowPlanElementPatch } from "../../PlanElementAirflowFields";
import { applyFixturePlanElementPatch, PlanElementFixtureFields, type FixturePlanElementPatch } from "../../PlanElementFixtureFields";
import { OpeningInventory } from "../../OpeningInventory";
import { SpatialLayerOverlay2D } from "../../SpatialLayerOverlay2D";
import type { SpatialLayerSnapshot, SpatialTopology } from "../../../spatialLayers";
import type { SensorCoverageAssessment } from "../../../experimentalSpatialLayers";
import type { OutdoorInfluenceEstimate } from "../../../outdoorInfluence";
import { ExperimentalSensorCoverage2D } from "../../ExperimentalSensorCoverage";
import {
  clampPlanElementHeight,
  clampPlanElementWidth,
  DEFAULT_CEILING_HEIGHT_METRES,
  defaultPlanElementHeight,
  defaultPlanElementWidth,
  defaultFireEscapeProjection,
  editablePlanElementWidthBounds,
  effectivePlanElementHeight,
  isWallAttachedPlanElement,
  isWallOpening,
  planElementHeightBounds,
} from "../../../planElementGeometry";
import { chimneyPenetrationsForFloor, fireplaceChimneyDimensions } from "../../../architecturalGeometry";
import { MapInformationToggle, useMapInformationVisibility } from "../../MapInformationToggle";
import { effectiveOpeningState, openingStateCanChange, openingStateKey, openingStateObservationsForHouse } from "../../../openingState";

export { heatColor, interpolateHeat } from "../../../spatialField";

export { clampPlanElementWidth, defaultPlanElementWidth, planElementWidthBounds } from "../../../planElementGeometry";

export interface FloorPlanProps {
  floor: Floor;
  /** Whole-house context reveals chimney penetrations inherited from lower floors. */
  house?: House;
  sensors: Sensor[];
  samples: Record<string, MeasurementSample>;
  /** Metric-complete samples used by capability-specific markers such as energy plugs. */
  sensorMeasurements?: LatestMeasurements;
  climateSensorMarkersVisible?: boolean;
  energyDevicesVisible?: boolean;
  climateSamples?: ClimateSampleMatrix;
  observations: ManualObservation[];
  definition: MeasurementDefinition;
  colorDomain?: { min: number; max: number } | null;
  units: UnitSystem;
  viewMode: ViewMode;
  selectedSensorId: string | null;
  editing: boolean;
  /** Blob-backed floor-plan images are changed only by the authoritative Home. */
  allowBackgroundImageEditing?: boolean;
  observationPlacement: boolean;
  referenceTimeMs?: number;
  maxSampleAgeMs?: number;
  outdoor?: OutdoorVisualizationState;
  spatialLayerSnapshots?: readonly SpatialLayerSnapshot[];
  spatialLayerTopology?: SpatialTopology | null;
  experimentalAirflowEnabled?: boolean;
  experimentalAirflow?: FloorAirflowEstimate | null;
  experimentalSensorCoverage?: SensorCoverageAssessment | null;
  experimentalOutdoorInfluence?: OutdoorInfluenceEstimate | null;
  openingStateObservations?: readonly OpeningStateObservation[];
  pendingOpeningStateKeys?: ReadonlySet<string>;
  onOpeningStateChange?: (floorId: string, elementId: string, state: ConfiguredOpeningState) => void;
  onSensorSelect: (sensorId: string) => void;
  onSensorMove: (sensorId: string, point: Point) => void;
  onFloorChange: (floor: Floor) => void;
  onObservationPoint: (point: Point) => void;
  onCancelObservationPlacement: () => void;
}

export function floorRenderScale(floorWidth: number): number {
  return 1000 / Math.max(floorWidth, 1);
}

export function wallLengthInputValue(lengthMetres: number): string {
  return Number(lengthMetres.toFixed(3)).toString();
}

export function smoothAirflowPath(points: AirflowPoint2D[], scale: number): string {
  const rendered = points.map((point) => ({ x: point.x * scale, y: point.y * scale }));
  if (rendered.length < 2) return "";
  if (rendered.length === 2) return `M${rendered[0]!.x} ${rendered[0]!.y}L${rendered[1]!.x} ${rendered[1]!.y}`;
  let path = `M${rendered[0]!.x} ${rendered[0]!.y}`;
  for (let index = 1; index < rendered.length - 1; index += 1) {
    const current = rendered[index]!;
    const next = rendered[index + 1]!;
    path += `Q${current.x} ${current.y} ${(current.x + next.x) / 2} ${(current.y + next.y) / 2}`;
  }
  const last = rendered.at(-1)!;
  return `${path}L${last.x} ${last.y}`;
}

export type FloorGridDensity = "fine" | "medium" | "coarse";

export type EditorTool = "select" | "wall" | "room" | "element";

export const ROOM_KINDS = ["living", "dining", "kitchen", "bedroom", "bathroom", "office", "hall", "entry", "utility", "storage", "sauna", "garage", "other"] as const;

export const PLAN_ELEMENT_KINDS: PlanElementKind[] = ["door", "window", "fireplace", "vent", "fireEscape"];

export const PLAN_VIEWPORT_MARGIN = 88;

export const OUTDOOR_SHELL_OFFSET = 64;

export const OUTDOOR_SHELL_CHIP_WIDTH = 164;

export const OUTDOOR_SHELL_CHIP_HEIGHT = 54;

export const OUTDOOR_SHELL_CHIP_GAP = 12;

export const OUTDOOR_SHELL_CHIP_RIGHT_INSET = 8;

export const GRID_DENSITY_MULTIPLIER: Record<FloorGridDensity, number> = {
  fine: .5,
  medium: 1,
  coarse: 2,
};

export const GEOMETRY_EPSILON = 1e-8;

export function outdoorWindwardEdgePath(edge: PlanEdge, width: number, height: number): string {
  const endInset = 30;
  const compassGap = 68;
  if (edge === "top" || edge === "bottom") {
    const y = edge === "top" ? -OUTDOOR_SHELL_OFFSET : height + OUTDOOR_SHELL_OFFSET;
    return `M${endInset} ${y}H${width / 2 - compassGap}M${width / 2 + compassGap} ${y}H${width - endInset}`;
  }
  const x = edge === "left" ? -OUTDOOR_SHELL_OFFSET : width + OUTDOOR_SHELL_OFFSET;
  return `M${x} ${endInset}V${height / 2 - compassGap}M${x} ${height / 2 + compassGap}V${height - endInset}`;
}

export function outdoorWindBearingPath(planWindFromDegrees: number, width: number, height: number): string {
  const shellWidth = width + OUTDOOR_SHELL_OFFSET * 2;
  const shellHeight = height + OUTDOOR_SHELL_OFFSET * 2;
  const path = windPathOnRectangle(planWindFromDegrees, shellWidth, shellHeight, .035, .035);
  const translate = (point: Point) => ({
    x: point.x - OUTDOOR_SHELL_OFFSET,
    y: point.y - OUTDOOR_SHELL_OFFSET,
  });
  const source = translate(path.sourcePoint);
  const target = translate(path.inwardTarget);
  return `M${source.x.toFixed(2)} ${source.y.toFixed(2)}L${target.x.toFixed(2)} ${target.y.toFixed(2)}`;
}

/** Returns a scale-aware 1/2/2.5/5 grid step with roughly 32 cells across a floor. */
export function defaultFloorGridSize(floor: Pick<Floor, "width" | "height">): number {
  const target = Math.max(floor.width, floor.height) / 32;
  if (!Number.isFinite(target) || target <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const normalized = target / magnitude;
  const niceMultiplier = [1, 2, 2.5, 5, 10].reduce((best, candidate) => (
    Math.abs(candidate - normalized) < Math.abs(best - normalized) ? candidate : best
  ));
  return Number((niceMultiplier * magnitude).toPrecision(12));
}

export function floorGridSize(floor: Pick<Floor, "width" | "height">, density: FloorGridDensity = "medium"): number {
  return Number((defaultFloorGridSize(floor) * GRID_DENSITY_MULTIPLIER[density]).toPrecision(12));
}

/** Snaps in floor coordinates so the rendered grid and persisted geometry stay exactly aligned. */
export function snapPointToGrid(point: Point, floor: Pick<Floor, "width" | "height">, gridSize: number): Point {
  const snap = (value: number, maximum: number) => {
    if (!Number.isFinite(gridSize) || gridSize <= 0) return clamp(value, 0, maximum);
    const snapped = Number((Math.round(value / gridSize) * gridSize).toFixed(8));
    return clamp(snapped, 0, maximum);
  };
  return { x: snap(point.x, floor.width), y: snap(point.y, floor.height) };
}

export interface WallPlacement {
  position: Point;
  rotationDegrees: number;
  wallId: string;
  renderedDistance: number;
}

/** Projects a point onto the closest wall, using rendered pixels for a zoom-independent magnetism threshold. */
export function nearestWallPlacement(
  point: Point,
  walls: Wall[],
  renderScale: number,
  maxRenderedDistance = 40,
  openingWidth = 0,
): WallPlacement | null {
  let nearest: WallPlacement | null = null;
  for (const wall of walls) {
    const dx = wall.to.x - wall.from.x;
    const dy = wall.to.y - wall.from.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= 1e-12) continue;
    const length = Math.sqrt(lengthSquared);
    if (openingWidth > length + GEOMETRY_EPSILON) continue;
    const projectedProgress = clamp(((point.x - wall.from.x) * dx + (point.y - wall.from.y) * dy) / lengthSquared, 0, 1);
    const projectedPosition = { x: wall.from.x + dx * projectedProgress, y: wall.from.y + dy * projectedProgress };
    const renderedDistance = Math.hypot(point.x - projectedPosition.x, point.y - projectedPosition.y) * renderScale;
    if (renderedDistance > maxRenderedDistance || (nearest && nearest.renderedDistance <= renderedDistance)) continue;
    const endpointClearance = openingWidth <= 0 ? 0 : Math.min(.5, openingWidth / (2 * length));
    const progress = clamp(projectedProgress, endpointClearance, 1 - endpointClearance);
    const position = { x: wall.from.x + dx * progress, y: wall.from.y + dy * progress };
    nearest = {
      position,
      rotationDegrees: (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360,
      wallId: wall.id,
      renderedDistance,
    };
  }
  return nearest;
}

export type WallOpeningPlacementResult =
  | { placement: WallPlacement; failure: null }
  | { placement: null; failure: "no-wall" | "wall-too-short" };

/** Fits the full opening on a nearby wall and reports why placement failed. */
export function nearestWallOpeningPlacement(
  point: Point,
  walls: Wall[],
  renderScale: number,
  openingWidth: number,
  maxRenderedDistance = 40,
): WallOpeningPlacementResult {
  const placement = nearestWallPlacement(point, walls, renderScale, maxRenderedDistance, openingWidth);
  if (placement) return { placement, failure: null };
  const nearbyWall = nearestWallPlacement(point, walls, renderScale, maxRenderedDistance);
  return nearbyWall
    ? { placement: null, failure: "wall-too-short" }
    : { placement: null, failure: "no-wall" };
}

export function roomRectanglePoints(from: Point, to: Point): Point[] {
  return [
    { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y) },
    { x: Math.max(from.x, to.x), y: Math.min(from.y, to.y) },
    { x: Math.max(from.x, to.x), y: Math.max(from.y, to.y) },
    { x: Math.min(from.x, to.x), y: Math.max(from.y, to.y) },
  ];
}

/** Inserts a new editable corner halfway along an existing room edge. */
export function insertRoomVertex(points: Point[], edgeIndex: number): Point[] {
  if (points.length < 2 || !Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= points.length) return points;
  const from = points[edgeIndex]!;
  const to = points[(edgeIndex + 1) % points.length]!;
  return [
    ...points.slice(0, edgeIndex + 1),
    { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
    ...points.slice(edgeIndex + 1),
  ];
}

export function pointsEqual(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= GEOMETRY_EPSILON && Math.abs(a.y - b.y) <= GEOMETRY_EPSILON;
}

export function orientation(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

export function pointOnSegment(point: Point, from: Point, to: Point): boolean {
  return Math.abs(orientation(from, to, point)) <= GEOMETRY_EPSILON
    && point.x >= Math.min(from.x, to.x) - GEOMETRY_EPSILON
    && point.x <= Math.max(from.x, to.x) + GEOMETRY_EPSILON
    && point.y >= Math.min(from.y, to.y) - GEOMETRY_EPSILON
    && point.y <= Math.max(from.y, to.y) + GEOMETRY_EPSILON;
}

export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (((abC > GEOMETRY_EPSILON && abD < -GEOMETRY_EPSILON) || (abC < -GEOMETRY_EPSILON && abD > GEOMETRY_EPSILON))
    && ((cdA > GEOMETRY_EPSILON && cdB < -GEOMETRY_EPSILON) || (cdA < -GEOMETRY_EPSILON && cdB > GEOMETRY_EPSILON))) return true;
  return (Math.abs(abC) <= GEOMETRY_EPSILON && pointOnSegment(c, a, b))
    || (Math.abs(abD) <= GEOMETRY_EPSILON && pointOnSegment(d, a, b))
    || (Math.abs(cdA) <= GEOMETRY_EPSILON && pointOnSegment(a, c, d))
    || (Math.abs(cdB) <= GEOMETRY_EPSILON && pointOnSegment(b, c, d));
}

/** Rejects collapsed, duplicate, or self-intersecting room polygons. */
export function isValidRoomPolygon(points: Point[]): boolean {
  if (points.length < 3) return false;
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      if (pointsEqual(points[first]!, points[second]!)) return false;
    }
  }
  const doubledArea = points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length]!;
    return area + point.x * next.y - next.x * point.y;
  }, 0);
  if (Math.abs(doubledArea) <= GEOMETRY_EPSILON) return false;
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(points[first]!, points[firstNext]!, points[second]!, points[secondNext]!)) return false;
    }
  }
  return true;
}
