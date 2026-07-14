import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { BoxSelect, Grid3X3, ImagePlus, MapPinPlus, MousePointer2, PenLine, Plus, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import type { Floor, ManualObservation, MeasurementDefinition, MeasurementSample, PlanElement, PlanElementKind, Point, Room, Sensor, UnitSystem, Wall } from "@climate-twin/contracts";
import { clamp, round, type ViewMode } from "../domain";
import { useI18n, type TranslationKey } from "../i18n";
import { formatMeasurement, formatMeasurementDelta, measurementGradient, measurementLabel, measurementValue, toDisplayValue } from "../measurements";
import { createCloudLobes, estimateFieldFlows, heatColor, interpolateHeat } from "../spatialField";
import { simulateFloorAirflow, type AirflowPoint2D, type ClimateSampleMatrix } from "../airflowSimulation";
import { configuredSpatialMaxSampleAgeMs, isSpatialSampleFresh } from "../spatialFreshness";
import { cardinalDirection, normalizeDegrees, windPathOnRectangle } from "../outdoorContext";
import {
  formatOutdoorHumidity,
  formatOutdoorTemperature,
  formatOutdoorWindSpeed,
  OutdoorConditionsBadge,
  type OutdoorVisualizationState,
} from "./OutdoorConditionsBadge";

export { heatColor, interpolateHeat } from "../spatialField";

interface FloorPlanProps {
  floor: Floor;
  sensors: Sensor[];
  samples: Record<string, MeasurementSample>;
  climateSamples?: ClimateSampleMatrix;
  observations: ManualObservation[];
  definition: MeasurementDefinition;
  colorDomain?: { min: number; max: number } | null;
  units: UnitSystem;
  viewMode: ViewMode;
  selectedSensorId: string | null;
  editing: boolean;
  observationPlacement: boolean;
  referenceTimeMs?: number;
  maxSampleAgeMs?: number;
  outdoor?: OutdoorVisualizationState;
  onSensorSelect: (sensorId: string) => void;
  onSensorMove: (sensorId: string, point: Point) => void;
  onFloorChange: (floor: Floor) => void;
  onObservationPoint: (point: Point) => void;
  onCancelObservationPlacement: () => void;
}

export function floorRenderScale(floorWidth: number): number {
  return 1000 / Math.max(floorWidth, 1);
}

function smoothAirflowPath(points: AirflowPoint2D[], scale: number): string {
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
type EditorTool = "select" | "wall" | "room" | "element";

const ROOM_KINDS = ["living", "dining", "kitchen", "bedroom", "bathroom", "office", "hall", "entry", "utility", "storage", "sauna", "garage", "other"] as const;
const PLAN_ELEMENT_KINDS: PlanElementKind[] = ["door", "window", "fireplace", "vent"];
const PLAN_VIEWPORT_MARGIN = 88;
const OUTDOOR_SHELL_OFFSET = 64;
const OUTDOOR_WIND_OUTSET = .085;
const OUTDOOR_SHELL_CHIP_WIDTH = 164;
const OUTDOOR_SHELL_CHIP_HEIGHT = 54;
const OUTDOOR_SHELL_CHIP_GAP = 12;
const OUTDOOR_SHELL_CHIP_RIGHT_INSET = 8;

const GRID_DENSITY_MULTIPLIER: Record<FloorGridDensity, number> = {
  fine: .5,
  medium: 1,
  coarse: 2,
};

const PLAN_ELEMENT_WIDTHS: Record<PlanElementKind, { spanDivisor: number; minFactor: number; maxFactor: number }> = {
  door: { spanDivisor: 16, minFactor: .55, maxFactor: 1.8 },
  window: { spanDivisor: 12, minFactor: .4, maxFactor: 2.5 },
  fireplace: { spanDivisor: 14, minFactor: .5, maxFactor: 2 },
  vent: { spanDivisor: 25, minFactor: .35, maxFactor: 2 },
};

const GEOMETRY_EPSILON = 1e-8;

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

/** Architectural defaults stay stable while the user changes grid density. */
export function defaultPlanElementWidth(floor: Pick<Floor, "width" | "height">, kind: PlanElementKind): number {
  const span = Math.max(floor.width, floor.height, GEOMETRY_EPSILON);
  return Number((span / PLAN_ELEMENT_WIDTHS[kind].spanDivisor).toPrecision(12));
}

export function planElementWidthBounds(floor: Pick<Floor, "width" | "height">, kind: PlanElementKind) {
  const defaultWidth = defaultPlanElementWidth(floor, kind);
  const config = PLAN_ELEMENT_WIDTHS[kind];
  return {
    min: Number((defaultWidth * config.minFactor).toPrecision(12)),
    max: Number((defaultWidth * config.maxFactor).toPrecision(12)),
    step: Number((defaultWidth / 10).toPrecision(12)),
  };
}

export function clampPlanElementWidth(floor: Pick<Floor, "width" | "height">, kind: PlanElementKind, width: number): number {
  const bounds = planElementWidthBounds(floor, kind);
  return Number(clamp(Number.isFinite(width) ? width : defaultPlanElementWidth(floor, kind), bounds.min, bounds.max).toPrecision(12));
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

function pointsEqual(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= GEOMETRY_EPSILON && Math.abs(a.y - b.y) <= GEOMETRY_EPSILON;
}

function orientation(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(point: Point, from: Point, to: Point): boolean {
  return Math.abs(orientation(from, to, point)) <= GEOMETRY_EPSILON
    && point.x >= Math.min(from.x, to.x) - GEOMETRY_EPSILON
    && point.x <= Math.max(from.x, to.x) + GEOMETRY_EPSILON
    && point.y >= Math.min(from.y, to.y) - GEOMETRY_EPSILON
    && point.y <= Math.max(from.y, to.y) + GEOMETRY_EPSILON;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
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

function isWallOpening(element: PlanElement): element is Extract<PlanElement, { kind: "door" | "window" }> {
  return element.kind === "door" || element.kind === "window";
}

interface PlanElementPatch {
  position?: Point;
  rotationDegrees?: number;
  width?: number;
  wallId?: string;
}

interface DeletedWallUndo {
  floorId: string;
  wall: Wall;
  wallIndex: number;
  openings: Array<{ element: PlanElement; index: number }>;
}

function PlanElementGlyph({ kind, width }: { kind: PlanElementKind; width: number }) {
  const half = width / 2;
  const depth = Math.max(18, Math.min(width * .55, 42));
  if (kind === "door") return (
    <g className="door-glyph">
      <line x1={-half} x2={half} className="plan-element-wall-cutout" />
      <line x1={-half} y1="0" x2={-half} y2={-width} className="plan-element-stroke" />
      <path d={`M${-half} ${-width}A${width} ${width} 0 0 1 ${half} 0`} className="plan-element-detail" />
      <circle cx={-half} r="4" className="plan-element-fill" />
    </g>
  );
  if (kind === "window") return (
    <g className="window-glyph">
      <line x1={-half} x2={half} className="plan-element-wall-cutout" />
      <line x1={-half} x2={half} y1="-5" y2="-5" className="plan-element-stroke" />
      <line x1={-half} x2={half} y1="5" y2="5" className="plan-element-stroke" />
      <line x1={-half} x2={-half} y1="-9" y2="9" className="plan-element-detail" />
      <line x1={half} x2={half} y1="-9" y2="9" className="plan-element-detail" />
    </g>
  );
  if (kind === "fireplace") return (
    <g className="fireplace-glyph">
      <rect x={-half} y={-depth / 2} width={width} height={depth} rx="3" className="plan-element-body" />
      <path d={`M0 ${depth * .28}C${-width * .16} ${depth * .05} ${-width * .1} ${-depth * .25} 0 ${-depth * .34}C${width * .18} ${-depth * .08} ${width * .16} ${depth * .12} 0 ${depth * .28}Z`} className="plan-element-flame" />
    </g>
  );
  const ventHeight = Math.max(18, Math.min(width * .45, 34));
  return (
    <g className="vent-glyph">
      <rect x={-half} y={-ventHeight / 2} width={width} height={ventHeight} rx="4" className="plan-element-body" />
      {[-.3, -.1, .1, .3].map((offset) => <line key={offset} x1={width * offset} x2={width * offset} y1={-ventHeight * .32} y2={ventHeight * .32} className="plan-element-detail" />)}
    </g>
  );
}

export function FloorPlan({
  floor, sensors, samples, climateSamples, observations, definition, colorDomain, units, viewMode, selectedSensorId, editing,
  observationPlacement, onSensorSelect, onSensorMove, onFloorChange, onObservationPoint, onCancelObservationPlacement,
  referenceTimeMs, maxSampleAgeMs,
  outdoor,
}: FloorPlanProps) {
  const { locale, t } = useI18n();
  const metricLabel = measurementLabel(definition, locale);
  const svgRef = useRef<SVGSVGElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const roomNameInputRef = useRef<HTMLInputElement>(null);
  const undoButtonRef = useRef<HTMLButtonElement>(null);
  const roomNameBeforeEdit = useRef<string | null>(null);
  const dragging = useRef<string | null>(null);
  const draggingElement = useRef<string | null>(null);
  const draggingRoomVertex = useRef<{ roomId: string; pointIndex: number } | null>(null);
  const planElementRefs = useRef(new Map<string, SVGGElement>());
  const mapHelpId = useId();
  const roomNameErrorId = useId();
  const fieldId = `floor-field-${useId().replace(/:/g, "")}`;
  const [editorTool, setEditorTool] = useState<EditorTool>("select");
  const [wallStart, setWallStart] = useState<Point | null>(null);
  const [roomStart, setRoomStart] = useState<Point | null>(null);
  const [selectedWallId, setSelectedWallId] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [selectedPlanElementId, setSelectedPlanElementId] = useState<string | null>(null);
  const [elementWidthDraft, setElementWidthDraft] = useState("");
  const [planElementKind, setPlanElementKind] = useState<PlanElementKind>("door");
  const [placementError, setPlacementError] = useState<string | null>(null);
  const [roomNameError, setRoomNameError] = useState<string | null>(null);
  const [deletedWallUndo, setDeletedWallUndo] = useState<DeletedWallUndo | null>(null);
  const [undoMessage, setUndoMessage] = useState<string | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [gridDensity, setGridDensity] = useState<FloorGridDensity>("medium");
  const [keyboardPoint, setKeyboardPoint] = useState<Point>({ x: floor.width / 2, y: floor.height / 2 });
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const renderScale = floorRenderScale(floor.width);
  const renderWidth = floor.width * renderScale;
  const renderHeight = floor.height * renderScale;
  const gridSize = floorGridSize(floor, gridDensity);
  const renderedGridSize = gridSize * renderScale;
  const viewportMargin = viewMode === "plan" ? Math.max(PLAN_VIEWPORT_MARGIN, renderedGridSize * 3 + 24) : 0;
  const resolvedReferenceTimeMs = referenceTimeMs ?? Date.now();
  const spatialFreshness = useMemo(() => ({
    referenceTimeMs: resolvedReferenceTimeMs,
    maxSampleAgeMs: maxSampleAgeMs ?? configuredSpatialMaxSampleAgeMs(),
  }), [resolvedReferenceTimeMs, maxSampleAgeMs]);
  const renderSensors = useMemo(() => sensors.map((sensor) => ({ ...sensor, x: sensor.x * renderScale, y: sensor.y * renderScale })), [sensors, renderScale]);
  const heat = useMemo(
    () => interpolateHeat(renderSensors, samples, definition, renderWidth, renderHeight, 25, spatialFreshness),
    [renderSensors, samples, definition, renderWidth, renderHeight, spatialFreshness],
  );
  const visualDomain = colorDomain ?? heat;
  const clouds = useMemo(() => createCloudLobes(heat, definition, 11, visualDomain), [heat, definition, visualDomain.min, visualDomain.max]);
  const gradientFlows = useMemo(() => estimateFieldFlows(heat, definition, 7), [heat, definition]);
  const transform = viewMode === "isometric" ? `translate(${renderWidth * .15} ${renderHeight * .02}) skewY(-12) scale(.82 .88)` : undefined;
  const layoutEditing = editing && viewMode === "plan";
  const drawingWall = editorTool === "wall";
  const drawingRoom = editorTool === "room";
  const placingElement = editorTool === "element";
  const selectingLayout = editorTool === "select";
  const keyboardPlacementActive = viewMode === "plan" && (observationPlacement || (layoutEditing && !selectingLayout));
  const wallSelectionActive = layoutEditing && selectingLayout;
  const roomSelectionActive = layoutEditing && selectingLayout;
  const planElementSelectionActive = layoutEditing && selectingLayout;
  const showMonitoringOverlays = !layoutEditing;
  const planElements = floor.planElements ?? [];
  const selectedRoom = floor.rooms.find((room) => room.id === selectedRoomId) ?? null;
  const selectedPlanElement = planElements.find((element) => element.id === selectedPlanElementId) ?? null;
  const selectedRoomSensorCount = selectedRoom ? sensors.filter((sensor) => sensor.room === selectedRoom.name).length : 0;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (!keyboardPlacementActive) return;
    const selected = sensors.find((sensor) => sensor.id === selectedSensorId);
    const startingPoint = selected ? { x: selected.x, y: selected.y } : { x: floor.width / 2, y: floor.height / 2 };
    setKeyboardPoint(layoutEditing && snapEnabled ? snapPointToGrid(startingPoint, floor, gridSize) : startingPoint);
    const timer = window.setTimeout(() => svgRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [keyboardPlacementActive, floor.id]);

  useEffect(() => {
    setEditorTool("select");
    setWallStart(null);
    setRoomStart(null);
    setSelectedWallId(null);
    setSelectedRoomId(null);
    setSelectedPlanElementId(null);
    setPlacementError(null);
    setRoomNameError(null);
    setDeletedWallUndo(null);
    setUndoMessage(null);
    dragging.current = null;
    draggingElement.current = null;
    draggingRoomVertex.current = null;
  }, [floor.id]);

  useEffect(() => {
    setRoomNameError(null);
    if (!selectedRoom) return;
    const timer = window.setTimeout(() => roomNameInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [selectedRoom?.id]);

  useEffect(() => {
    if (!editing || viewMode !== "plan") {
      setEditorTool("select");
      setWallStart(null);
      setRoomStart(null);
      setSelectedWallId(null);
      setSelectedRoomId(null);
      setSelectedPlanElementId(null);
      setPlacementError(null);
      setRoomNameError(null);
    }
  }, [editing, viewMode]);

  useEffect(() => {
    if (selectedWallId && !floor.walls.some((wall) => wall.id === selectedWallId)) setSelectedWallId(null);
  }, [floor.walls, selectedWallId]);

  useEffect(() => {
    if (selectedRoomId && !floor.rooms.some((room) => room.id === selectedRoomId)) setSelectedRoomId(null);
  }, [floor.rooms, selectedRoomId]);

  useEffect(() => {
    if (selectedPlanElementId && !planElements.some((element) => element.id === selectedPlanElementId)) setSelectedPlanElementId(null);
  }, [planElements, selectedPlanElementId]);

  useEffect(() => {
    setElementWidthDraft(selectedPlanElement
      ? String(selectedPlanElement.width ?? defaultPlanElementWidth(floor, selectedPlanElement.kind))
      : "");
  }, [selectedPlanElement?.id, selectedPlanElement?.width, floor.width, floor.height]);

  useEffect(() => {
    if (layoutEditing && !selectingLayout && snapEnabled) {
      setKeyboardPoint((point) => snapPointToGrid(point, floor, gridSize));
      setWallStart((point) => point ? snapPointToGrid(point, floor, gridSize) : null);
      setRoomStart((point) => point ? snapPointToGrid(point, floor, gridSize) : null);
    }
  }, [layoutEditing, selectingLayout, snapEnabled, gridSize, floor.width, floor.height]);

  const roomName = (kind: string | undefined, fallback: string) => {
    const key = `room.${kind ?? ""}` as TranslationKey;
    const translated = t(key);
    return translated === key ? fallback : translated;
  };

  const pointFromEvent = (clientX: number, clientY: number): Point => {
    const svg = svgRef.current!;
    const matrix = svg.getScreenCTM();
    if (matrix) {
      const screenPoint = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
      return {
        x: clamp(screenPoint.x / renderScale, 0, floor.width),
        y: clamp(screenPoint.y / renderScale, 0, floor.height),
      };
    }
    const bounds = svg.getBoundingClientRect();
    return {
      x: clamp((clientX - bounds.left) / bounds.width * floor.width, 0, floor.width),
      y: clamp((clientY - bounds.top) / bounds.height * floor.height, 0, floor.height),
    };
  };

  const placementPoint = (point: Point, bypassSnap = false): Point => (
    snapEnabled && !bypassSnap ? snapPointToGrid(point, floor, gridSize) : point
  );

  const clearLayoutSelection = () => {
    setSelectedWallId(null);
    setSelectedRoomId(null);
    setSelectedPlanElementId(null);
  };

  const chooseEditorTool = (tool: EditorTool) => {
    setEditorTool(tool);
    setWallStart(null);
    setRoomStart(null);
    setPlacementError(null);
    if (tool !== "select") clearLayoutSelection();
  };

  const applyFloorChange = (nextFloor: Floor) => {
    setDeletedWallUndo(null);
    setUndoMessage(null);
    onFloorChange(nextFloor);
  };

  const nextUnusedRoomName = () => {
    const existingNames = new Set(floor.rooms.map((room) => room.name.trim().toLocaleLowerCase(locale)));
    let number = 1;
    while (existingNames.has(t("twin.defaultRoomName", { number }).toLocaleLowerCase(locale))) number += 1;
    return t("twin.defaultRoomName", { number });
  };

  const addWall = (from: Point, to: Point): boolean => {
    if (Math.abs(from.x - to.x) < 1e-8 && Math.abs(from.y - to.y) < 1e-8) return false;
    const wall: Wall = { id: crypto.randomUUID(), from, to };
    applyFloorChange({ ...floor, walls: [...floor.walls, wall] });
    return true;
  };

  const deleteWall = (wallId: string | null = selectedWallId, focusUndo = false) => {
    const wallIndex = wallId ? floor.walls.findIndex((wall) => wall.id === wallId) : -1;
    if (!wallId || wallIndex < 0) return;
    const openings = planElements.flatMap((element, index) => (
      isWallOpening(element) && element.wallId === wallId ? [{ element, index }] : []
    ));
    setDeletedWallUndo({ floorId: floor.id, wall: floor.walls[wallIndex]!, wallIndex, openings });
    setUndoMessage(t("twin.wallDeleted", { count: openings.length }));
    onFloorChange({
      ...floor,
      walls: floor.walls.filter((wall) => wall.id !== wallId),
      planElements: planElements.filter((element) => !isWallOpening(element) || element.wallId !== wallId),
    });
    setSelectedWallId(null);
    if (focusUndo) window.setTimeout(() => undoButtonRef.current?.focus(), 0);
  };

  const undoLastDeletion = () => {
    if (!deletedWallUndo || deletedWallUndo.floorId !== floor.id) return;
    const walls = [...floor.walls];
    if (!walls.some((wall) => wall.id === deletedWallUndo.wall.id)) {
      walls.splice(Math.min(deletedWallUndo.wallIndex, walls.length), 0, deletedWallUndo.wall);
    }
    const restoredElements = [...planElements];
    for (const opening of [...deletedWallUndo.openings].sort((left, right) => left.index - right.index)) {
      if (restoredElements.some((element) => element.id === opening.element.id)) continue;
      restoredElements.splice(Math.min(opening.index, restoredElements.length), 0, opening.element);
    }
    onFloorChange({ ...floor, walls, planElements: restoredElements });
    setDeletedWallUndo(null);
    setUndoMessage(null);
    clearLayoutSelection();
  };

  useEffect(() => {
    if (!layoutEditing || !deletedWallUndo) return;
    const undoShortcut = (event: globalThis.KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.shiftKey || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      undoLastDeletion();
    };
    document.addEventListener("keydown", undoShortcut);
    return () => document.removeEventListener("keydown", undoShortcut);
  }, [layoutEditing, deletedWallUndo, floor, planElements]);

  const addRoom = (from: Point, to: Point): boolean => {
    if (Math.abs(from.x - to.x) < 1e-8 || Math.abs(from.y - to.y) < 1e-8) {
      setPlacementError(t("twin.roomTooSmall"));
      return false;
    }
    const room: Room = {
      id: crypto.randomUUID(),
      name: nextUnusedRoomName(),
      kind: "other",
      points: roomRectanglePoints(from, to),
    };
    applyFloorChange({ ...floor, rooms: [...floor.rooms, room] });
    setSelectedRoomId(room.id);
    setEditorTool("select");
    setPlacementError(null);
    return true;
  };

  const updateRoom = (roomId: string, patch: Partial<Pick<Room, "name" | "kind" | "points">>) => {
    applyFloorChange({ ...floor, rooms: floor.rooms.map((room) => room.id === roomId ? { ...room, ...patch } : room) });
  };

  const commitRoomName = (roomId: string, rawName: string) => {
    const room = floor.rooms.find((candidate) => candidate.id === roomId);
    if (!room) return;
    const previousName = roomNameBeforeEdit.current ?? room.name;
    const nextName = rawName.trim() || nextUnusedRoomName();
    const normalizedName = nextName.toLocaleLowerCase(locale);
    const duplicate = floor.rooms.some((candidate) => candidate.id !== roomId
      && candidate.name.trim().toLocaleLowerCase(locale) === normalizedName);
    if (duplicate) {
      if (room.name !== previousName) updateRoom(roomId, { name: previousName });
      setRoomNameError(t("twin.roomNameDuplicate", { name: nextName }));
      roomNameBeforeEdit.current = null;
      return;
    }
    if (room.name !== nextName) updateRoom(roomId, { name: nextName });
    setRoomNameError(null);
    roomNameBeforeEdit.current = null;
  };

  const deleteRoom = (roomId: string | null = selectedRoomId) => {
    if (!roomId) return;
    applyFloorChange({ ...floor, rooms: floor.rooms.filter((room) => room.id !== roomId) });
    setSelectedRoomId(null);
  };

  const resolveElementPlacement = (kind: PlanElementKind, point: Point, width = defaultPlanElementWidth(floor, kind)) => {
    if (kind !== "door" && kind !== "window") {
      return { placement: { position: point, rotationDegrees: 0 }, failure: null } as const;
    }
    const result = nearestWallOpeningPlacement(point, floor.walls, renderScale, width);
    if (!result.placement) return result;
    const wallPlacement = result.placement;
    let rotationDegrees = wallPlacement.rotationDegrees;
    if (kind === "door") {
      const radians = rotationDegrees * Math.PI / 180;
      const swingDirection = { x: Math.sin(radians), y: -Math.cos(radians) };
      const towardCenter = { x: floor.width / 2 - wallPlacement.position.x, y: floor.height / 2 - wallPlacement.position.y };
      if (swingDirection.x * towardCenter.x + swingDirection.y * towardCenter.y < 0) rotationDegrees = (rotationDegrees + 180) % 360;
    }
    return { placement: {
      position: wallPlacement.position,
      rotationDegrees,
      wallId: wallPlacement.wallId,
    }, failure: null } as const;
  };

  const placementFailureMessage = (failure: "no-wall" | "wall-too-short") => (
    t(failure === "wall-too-short" ? "twin.openingWallTooShort" : "twin.openingNeedsWall")
  );

  const addPlanElement = (point: Point): boolean => {
    const width = defaultPlanElementWidth(floor, planElementKind);
    const result = resolveElementPlacement(planElementKind, point, width);
    if (!result.placement) {
      setPlacementError(placementFailureMessage(result.failure));
      return false;
    }
    const id = crypto.randomUUID();
    let element: PlanElement;
    if (planElementKind === "door" || planElementKind === "window") {
      if (!("wallId" in result.placement) || !result.placement.wallId) return false;
      element = { id, kind: planElementKind, position: result.placement.position, rotationDegrees: result.placement.rotationDegrees, width, wallId: result.placement.wallId };
    } else {
      element = { id, kind: planElementKind, position: result.placement.position, rotationDegrees: result.placement.rotationDegrees, width };
    }
    applyFloorChange({ ...floor, planElements: [...planElements, element] });
    setSelectedPlanElementId(element.id);
    setEditorTool("select");
    setPlacementError(null);
    window.setTimeout(() => planElementRefs.current.get(element.id)?.focus(), 0);
    return true;
  };

  const updatePlanElement = (elementId: string, patch: PlanElementPatch) => {
    applyFloorChange({ ...floor, planElements: planElements.map((element): PlanElement => {
      if (element.id !== elementId) return element;
      if (isWallOpening(element)) return { ...element, ...patch, wallId: patch.wallId ?? element.wallId };
      const { wallId: _wallId, ...fixturePatch } = patch;
      return { ...element, ...fixturePatch };
    }) });
  };

  const movePlanElement = (elementId: string, rawPoint: Point, bypassSnap = false) => {
    const element = planElements.find((candidate) => candidate.id === elementId);
    if (!element) return;
    const point = placementPoint(rawPoint, bypassSnap);
    const width = element.width ?? defaultPlanElementWidth(floor, element.kind);
    const result = resolveElementPlacement(element.kind, point, width);
    if (!result.placement) {
      setPlacementError(placementFailureMessage(result.failure));
      return;
    }
    const placement = result.placement;
    let rotationDegrees = element.rotationDegrees;
    if (isWallOpening(element)) {
      const defaultAtCurrentPosition = resolveElementPlacement(element.kind, element.position, width).placement;
      const attachedOffset = defaultAtCurrentPosition
        ? (element.rotationDegrees - defaultAtCurrentPosition.rotationDegrees + 360) % 360
        : 0;
      rotationDegrees = (placement.rotationDegrees + (attachedOffset >= 90 && attachedOffset <= 270 ? 180 : 0)) % 360;
    }
    const patch: PlanElementPatch = {
      position: placement.position,
      rotationDegrees,
    };
    if ("wallId" in placement && placement.wallId) patch.wallId = placement.wallId;
    updatePlanElement(elementId, patch);
    setPlacementError(null);
  };

  const updatePlanElementWidth = (elementId: string, requestedWidth: number): boolean => {
    const element = planElements.find((candidate) => candidate.id === elementId);
    if (!element || !Number.isFinite(requestedWidth)) return false;
    const width = clampPlanElementWidth(floor, element.kind, requestedWidth);
    if (!isWallOpening(element)) {
      updatePlanElement(element.id, { width });
      setPlacementError(null);
      return true;
    }
    const attachedWall = floor.walls.find((wall) => wall.id === element.wallId);
    const result = nearestWallOpeningPlacement(element.position, attachedWall ? [attachedWall] : [], renderScale, width, Number.POSITIVE_INFINITY);
    if (!result.placement) {
      setPlacementError(placementFailureMessage(result.failure));
      return false;
    }
    const offset = (element.rotationDegrees - result.placement.rotationDegrees + 360) % 360;
    updatePlanElement(element.id, {
      width,
      position: result.placement.position,
      rotationDegrees: (result.placement.rotationDegrees + (offset >= 90 && offset <= 270 ? 180 : 0)) % 360,
      wallId: result.placement.wallId,
    });
    setPlacementError(null);
    return true;
  };

  const deletePlanElement = (elementId: string | null = selectedPlanElementId) => {
    if (!elementId) return;
    applyFloorChange({ ...floor, planElements: planElements.filter((element) => element.id !== elementId) });
    setSelectedPlanElementId(null);
  };

  const mapPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (viewMode !== "plan") return;
    const rawPoint = pointFromEvent(event.clientX, event.clientY);
    if (observationPlacement) {
      setKeyboardPoint(rawPoint);
      onObservationPoint(rawPoint);
      return;
    }
    if (!editing) return;
    if (selectingLayout) {
      clearLayoutSelection();
      return;
    }
    const point = placementPoint(rawPoint, event.altKey);
    setKeyboardPoint(point);
    if (drawingWall) {
      if (!wallStart) {
        setWallStart(point);
        return;
      }
      if (addWall(wallStart, point)) setWallStart(null);
      return;
    }
    if (drawingRoom) {
      if (!roomStart) {
        setRoomStart(point);
        setPlacementError(null);
        return;
      }
      if (addRoom(roomStart, point)) setRoomStart(null);
      return;
    }
    if (placingElement) addPlanElement(point);
  };

  const mapPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!layoutEditing || selectingLayout) return;
    setKeyboardPoint(placementPoint(pointFromEvent(event.clientX, event.clientY), event.altKey));
    if (placementError) setPlacementError(null);
  };

  const mapKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!keyboardPlacementActive) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (observationPlacement) {
        onCancelObservationPlacement();
      } else if (wallStart) {
        setWallStart(null);
      } else if (roomStart) {
        setRoomStart(null);
      } else {
        chooseEditorTool("select");
      }
      setPlacementError(null);
      return;
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const multiplier = event.shiftKey ? 5 : 1;
      const useGrid = layoutEditing && snapEnabled && !event.altKey;
      const xStep = (useGrid ? gridSize : floor.width / 100) * multiplier;
      const yStep = (useGrid ? gridSize : floor.height / 100) * multiplier;
      setKeyboardPoint((current) => {
        const point = {
          x: clamp(current.x + (event.key === "ArrowRight" ? xStep : event.key === "ArrowLeft" ? -xStep : 0), 0, floor.width),
          y: clamp(current.y + (event.key === "ArrowDown" ? yStep : event.key === "ArrowUp" ? -yStep : 0), 0, floor.height),
        };
        return useGrid ? snapPointToGrid(point, floor, gridSize) : point;
      });
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (observationPlacement) {
      onObservationPoint(keyboardPoint);
      return;
    }
    if (drawingWall) {
      if (!wallStart) setWallStart(keyboardPoint);
      else if (addWall(wallStart, keyboardPoint)) setWallStart(null);
    } else if (drawingRoom) {
      if (!roomStart) setRoomStart(keyboardPoint);
      else if (addRoom(roomStart, keyboardPoint)) setRoomStart(null);
    } else if (placingElement) {
      addPlanElement(keyboardPoint);
    }
  };

  const wallPointerDown = (event: ReactPointerEvent<SVGGElement>, wallId: string) => {
    if (!wallSelectionActive) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedWallId(wallId);
    setSelectedRoomId(null);
    setSelectedPlanElementId(null);
    event.currentTarget.focus();
  };

  const wallKeyDown = (event: KeyboardEvent<SVGGElement>, wallId: string) => {
    if (!wallSelectionActive) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setSelectedWallId(null);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
      deleteWall(wallId, true);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      setSelectedWallId(wallId);
    }
  };

  const roomPointerDown = (event: ReactPointerEvent<SVGGElement>, roomId: string) => {
    if (!roomSelectionActive) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedRoomId(roomId);
    setSelectedWallId(null);
    setSelectedPlanElementId(null);
    event.currentTarget.focus();
  };

  const roomKeyDown = (event: KeyboardEvent<SVGGElement>, roomId: string) => {
    if (!roomSelectionActive) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setSelectedRoomId(null);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
      deleteRoom(roomId);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      setSelectedRoomId(roomId);
    }
  };

  const roomVertexPointerDown = (event: ReactPointerEvent<SVGCircleElement>, roomId: string, pointIndex: number) => {
    event.preventDefault();
    event.stopPropagation();
    draggingRoomVertex.current = { roomId, pointIndex };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveRoomVertex = (event: ReactPointerEvent<SVGCircleElement>, roomId: string, pointIndex: number) => {
    const active = draggingRoomVertex.current;
    if (!active || active.roomId !== roomId || active.pointIndex !== pointIndex) return;
    const room = floor.rooms.find((candidate) => candidate.id === roomId);
    if (!room) return;
    const points = room.points.map((point, index) => index === pointIndex
      ? placementPoint(pointFromEvent(event.clientX, event.clientY), event.altKey)
      : point);
    if (!isValidRoomPolygon(points)) {
      setPlacementError(t("twin.roomShapeInvalid"));
      return;
    }
    updateRoom(roomId, { points });
    setPlacementError(null);
  };

  const roomVertexKeyDown = (event: KeyboardEvent<SVGCircleElement>, roomId: string, pointIndex: number) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    const room = floor.rooms.find((candidate) => candidate.id === roomId);
    const point = room?.points[pointIndex];
    if (!room || !point) return;
    event.preventDefault();
    event.stopPropagation();
    const multiplier = event.shiftKey ? 5 : 1;
    const useGrid = snapEnabled && !event.altKey;
    const xDistance = (useGrid ? gridSize : floor.width / 100) * multiplier;
    const yDistance = (useGrid ? gridSize : floor.height / 100) * multiplier;
    const nextPoint = {
      x: clamp(point.x + (event.key === "ArrowRight" ? xDistance : event.key === "ArrowLeft" ? -xDistance : 0), 0, floor.width),
      y: clamp(point.y + (event.key === "ArrowDown" ? yDistance : event.key === "ArrowUp" ? -yDistance : 0), 0, floor.height),
    };
    const points = room.points.map((candidate, index) => index === pointIndex
      ? (useGrid ? snapPointToGrid(nextPoint, floor, gridSize) : nextPoint)
      : candidate);
    if (!isValidRoomPolygon(points)) {
      setPlacementError(t("twin.roomShapeInvalid"));
      return;
    }
    updateRoom(roomId, { points });
    setPlacementError(null);
  };

  const planElementPointerDown = (event: ReactPointerEvent<SVGGElement>, elementId: string) => {
    if (!planElementSelectionActive) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedPlanElementId(elementId);
    setSelectedWallId(null);
    setSelectedRoomId(null);
    draggingElement.current = elementId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus();
  };

  const planElementPointerMove = (event: ReactPointerEvent<SVGGElement>, elementId: string) => {
    if (draggingElement.current !== elementId) return;
    movePlanElement(elementId, pointFromEvent(event.clientX, event.clientY), event.altKey);
  };

  const planElementKeyDown = (event: KeyboardEvent<SVGGElement>, element: PlanElement) => {
    if (!planElementSelectionActive) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setSelectedPlanElementId(null);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
      deletePlanElement(element.id);
      return;
    }
    if (event.key.toLowerCase() === "r") {
      event.preventDefault();
      event.stopPropagation();
      const step = isWallOpening(element) ? 180 : event.shiftKey ? -90 : 90;
      updatePlanElement(element.id, { rotationDegrees: normalizeDegrees(element.rotationDegrees + step) });
      return;
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const multiplier = event.shiftKey ? 5 : 1;
      const useGrid = snapEnabled && !event.altKey;
      const xDistance = (useGrid ? gridSize : floor.width / 100) * multiplier;
      const yDistance = (useGrid ? gridSize : floor.height / 100) * multiplier;
      movePlanElement(element.id, {
        x: clamp(element.position.x + (event.key === "ArrowRight" ? xDistance : event.key === "ArrowLeft" ? -xDistance : 0), 0, floor.width),
        y: clamp(element.position.y + (event.key === "ArrowDown" ? yDistance : event.key === "ArrowUp" ? -yDistance : 0), 0, floor.height),
      }, event.altKey);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      setSelectedPlanElementId(element.id);
    }
  };

  const startSensorDrag = (event: ReactPointerEvent<SVGGElement>, sensorId: string) => {
    if (layoutEditing && !selectingLayout) return;
    event.stopPropagation();
    clearLayoutSelection();
    onSensorSelect(sensorId);
    if (!editing || viewMode !== "plan") return;
    dragging.current = sensorId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveSensor = (event: ReactPointerEvent<SVGGElement>, sensorId: string) => {
    if (dragging.current !== sensorId) return;
    onSensorMove(sensorId, placementPoint(pointFromEvent(event.clientX, event.clientY), event.altKey));
  };

  const sensorKeyDown = (event: KeyboardEvent<SVGGElement>, sensor: Sensor) => {
    if (layoutEditing && !selectingLayout) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      clearLayoutSelection();
      onSensorSelect(sensor.id);
      return;
    }
    if (!editing || viewMode !== "plan" || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const multiplier = event.shiftKey ? 5 : 1;
    const useGrid = snapEnabled && !event.altKey;
    const xDistance = (useGrid ? gridSize : floor.width / 100) * multiplier;
    const yDistance = (useGrid ? gridSize : floor.height / 100) * multiplier;
    const point = {
      x: clamp(sensor.x + (event.key === "ArrowRight" ? xDistance : event.key === "ArrowLeft" ? -xDistance : 0), 0, floor.width),
      y: clamp(sensor.y + (event.key === "ArrowDown" ? yDistance : event.key === "ArrowUp" ? -yDistance : 0), 0, floor.height),
    };
    onSensorMove(sensor.id, useGrid ? snapPointToGrid(point, floor, gridSize) : point);
  };

  const uploadBackground = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setUploadError(null);
    if (!file) return;
    if (!file.type.match(/^image\/(png|jpe?g|webp)$/)) {
      setUploadError(t("twin.uploadInvalid"));
      event.target.value = "";
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setUploadError(t("twin.uploadTooLarge"));
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => applyFloorChange({ ...floor, backgroundImage: String(reader.result) }));
    reader.addEventListener("error", () => setUploadError(t("twin.uploadInvalid")));
    reader.readAsDataURL(file);
    event.target.value = "";
  };

  const legendMin = formatMeasurement(visualDomain.min, definition, units);
  const legendMax = formatMeasurement(visualDomain.max, definition, units);
  const outdoorContext = !outdoor?.replayActive ? outdoor?.context ?? null : null;
  const airflow = useMemo(() => climateSamples ? simulateFloorAirflow({
    floor,
    sensors,
    samples: climateSamples,
    freshness: spatialFreshness,
    outdoor: outdoorContext,
  }, 9) : null, [climateSamples, floor, sensors, spatialFreshness, outdoorContext]);
  const airflowPaths = airflow?.paths ?? [];
  const activeGradientFlows = airflowPaths.length ? [] : gradientFlows;
  const airflowSupport = airflow
    ? t(`twin.airflowSupport.${airflow.evidence.support}` as TranslationKey)
    : t("twin.airflowSupport.low");
  const airflowDriver = airflow?.evidence.windDriven
    ? t("twin.airflowDriverBuoyancyWind")
    : t("twin.airflowDriverBuoyancy");
  const airflowDescription = airflow ? t("twin.airflowDescription", {
    temperature: airflow.evidence.temperatureSensors,
    humidity: airflow.evidence.humiditySensors,
    tracer: airflow.evidence.tracerSensors,
    driver: airflowDriver,
  }) : "";
  const airflowAria = airflow ? t("twin.airflowAria", {
    support: airflowSupport,
    temperature: airflow.evidence.temperatureSensors,
    humidity: airflow.evidence.humiditySensors,
    tracer: airflow.evidence.tracerSensors,
  }) : "";
  const centeredOutdoorPath = outdoorContext?.planWindFromDegrees === null || outdoorContext?.planWindFromDegrees === undefined
    ? null
    : windPathOnRectangle(outdoorContext.planWindFromDegrees, renderWidth, renderHeight, .035, OUTDOOR_WIND_OUTSET);
  const outdoorPath = centeredOutdoorPath === null ? null : (() => {
    const alongEdge = centeredOutdoorPath.windwardEdge === "top" || centeredOutdoorPath.windwardEdge === "bottom"
      ? { x: renderWidth * .12, y: 0 }
      : { x: 0, y: renderHeight * .12 };
    return {
      ...centeredOutdoorPath,
      sourcePoint: {
        x: centeredOutdoorPath.sourcePoint.x + alongEdge.x,
        y: centeredOutdoorPath.sourcePoint.y + alongEdge.y,
      },
      inwardTarget: {
        x: centeredOutdoorPath.inwardTarget.x + alongEdge.x,
        y: centeredOutdoorPath.inwardTarget.y + alongEdge.y,
      },
    };
  })();
  const outdoorArrowLabel = outdoorContext?.windFromCardinal && outdoorContext.windFromDegrees !== null && outdoorContext.windwardEdge
    ? t("outdoor.windArrowAria", {
      direction: t(`outdoor.cardinal.${outdoorContext.windFromCardinal}` as TranslationKey),
      degrees: Math.round(outdoorContext.windFromDegrees),
      edge: t(`outdoor.edge.${outdoorContext.windwardEdge}` as TranslationKey),
    })
    : null;
  const outdoorTemperature = outdoorContext
    ? formatOutdoorTemperature(outdoorContext.conditions.temperatureC, units, locale)
    : null;
  const outdoorHumidity = outdoorContext
    ? formatOutdoorHumidity(outdoorContext.conditions.relativeHumidityPercent, locale)
    : null;
  const outdoorTemperatureColor = outdoor?.conditionColors?.temperature;
  const outdoorHumidityColor = outdoor?.conditionColors?.humidity;
  const activeOutdoorColor = definition.id === "temperature"
    ? outdoorTemperatureColor
    : definition.id === "humidity"
      ? outdoorHumidityColor
      : undefined;
  const activeOutdoorStyle = activeOutdoorColor
    ? ({ "--outdoor-active-color": activeOutdoorColor } as CSSProperties)
    : undefined;
  const outdoorTemperatureStyle = outdoorTemperatureColor
    ? ({ "--outdoor-condition-color": outdoorTemperatureColor } as CSSProperties)
    : undefined;
  const outdoorHumidityStyle = outdoorHumidityColor
    ? ({ "--outdoor-condition-color": outdoorHumidityColor } as CSSProperties)
    : undefined;
  const outdoorWindSpeed = outdoorContext
    ? formatOutdoorWindSpeed(outdoorContext.conditions.windSpeedMps, units, locale)
    : null;
  const outdoorWindDirection = outdoorContext?.windFromCardinal && outdoorContext.windFromDegrees !== null
    ? `${t(`outdoor.cardinal.${outdoorContext.windFromCardinal}` as TranslationKey)} ${Math.round(outdoorContext.windFromDegrees)}°`
    : null;
  const outdoorShellLabel = [
    t("outdoor.shellLabel"),
    outdoorTemperature && t("outdoor.temperatureAria", { value: outdoorTemperature }),
    outdoorHumidity && t("outdoor.humidityAria", { value: outdoorHumidity }),
    outdoorWindSpeed && t("outdoor.windSpeedAria", { value: outdoorWindSpeed }),
    outdoorWindDirection && t("outdoor.windFromAria", { value: outdoorWindDirection }),
  ].filter(Boolean).join(". ");
  const outdoorWindLabelPosition = outdoorPath ? (() => {
    if (outdoorPath.windwardEdge === "top") return { x: outdoorPath.sourcePoint.x, y: -76, textAnchor: "middle" as const };
    if (outdoorPath.windwardEdge === "bottom") return { x: outdoorPath.sourcePoint.x, y: renderHeight + 79, textAnchor: "middle" as const };
    if (outdoorPath.windwardEdge === "left") return { x: -49, y: outdoorPath.sourcePoint.y - 18, textAnchor: "start" as const };
    return { x: renderWidth + 49, y: outdoorPath.sourcePoint.y - 18, textAnchor: "end" as const };
  })() : null;
  const edgeLabels = outdoor?.orientationDegrees === undefined ? [] : ([
    { edge: "top", x: renderWidth / 2, y: -28, bearing: outdoor.orientationDegrees },
    { edge: "right", x: renderWidth + 34, y: renderHeight / 2, bearing: outdoor.orientationDegrees + 90 },
    { edge: "bottom", x: renderWidth / 2, y: renderHeight + 36, bearing: outdoor.orientationDegrees + 180 },
    { edge: "left", x: -34, y: renderHeight / 2, bearing: outdoor.orientationDegrees + 270 },
  ] as const).map((item) => {
    const bearing = normalizeDegrees(item.bearing);
    return { ...item, bearing, cardinal: cardinalDirection(bearing) };
  });
  const elementPreviewPlacement = placingElement
    ? resolveElementPlacement(planElementKind, keyboardPoint, defaultPlanElementWidth(floor, planElementKind)).placement
    : null;
  const selectedElementWidthBounds = selectedPlanElement ? planElementWidthBounds(floor, selectedPlanElement.kind) : null;
  const selectedElementRotation = selectedPlanElement ? Math.round(normalizeDegrees(selectedPlanElement.rotationDegrees)) % 360 : 0;
  const selectedElementHasCardinalRotation = [0, 90, 180, 270].includes(selectedElementRotation);
  const editorHint = placementError ?? undoMessage
    ?? (selectedWallId
      ? t("twin.wallSelected")
      : selectedRoom
        ? t("twin.roomSelected")
        : selectedPlanElement
          ? t(isWallOpening(selectedPlanElement) ? "twin.elementSelected" : "twin.fixtureSelected", {
            element: t(`planElement.${selectedPlanElement.kind}` as TranslationKey),
            degrees: selectedElementRotation,
          })
          : drawingWall
            ? wallStart ? t("twin.wallEnd") : t("twin.wallStart")
            : drawingRoom
              ? roomStart ? t("twin.roomEnd") : t("twin.roomStart")
              : placingElement
                ? t(planElementKind === "door" || planElementKind === "window" ? "twin.openingPlacement" : "twin.elementPlacement", { element: t(`planElement.${planElementKind}` as TranslationKey) })
                : `${t("twin.dragHint")} ${snapEnabled ? t("twin.snapOnHint") : t("twin.snapOffHint")}`);

  return (
    <div className="floor-plan-wrap">
      {editing && (
        <div className="editor-toolbar" role="toolbar" aria-label={t("twin.editTools")}>
          <div className="editor-mode-tools" role="group" aria-label={t("twin.editMode")}>
            <button type="button" className={selectingLayout ? "tool-button active" : "tool-button"} aria-pressed={selectingLayout} disabled={viewMode !== "plan"} onClick={() => chooseEditorTool("select")}>
              <MousePointer2 size={16} aria-hidden="true" />{t("twin.selectMove")}
            </button>
            <button type="button" className={drawingWall ? "tool-button active" : "tool-button"} aria-pressed={drawingWall} disabled={viewMode !== "plan"} onClick={() => chooseEditorTool("wall")}>
              <PenLine size={16} aria-hidden="true" />{t("twin.drawWall")}
            </button>
            <button type="button" className={drawingRoom ? "tool-button active" : "tool-button"} aria-pressed={drawingRoom} disabled={viewMode !== "plan"} onClick={() => chooseEditorTool("room")}>
              <BoxSelect size={16} aria-hidden="true" />{t("twin.addRoom")}
            </button>
          </div>
          <div className="element-palette" role="group" aria-label={t("twin.planElements")}>
            <label className="grid-size-control">
              <span>{t("twin.planElement")}</span>
              <select value={planElementKind} disabled={viewMode !== "plan"} aria-label={t("twin.planElement")} onChange={(event) => setPlanElementKind(event.target.value as PlanElementKind)}>
                {PLAN_ELEMENT_KINDS.map((kind) => <option key={kind} value={kind}>{t(`planElement.${kind}` as TranslationKey)}</option>)}
              </select>
            </label>
            <button type="button" className={placingElement ? "tool-button active" : "tool-button"} aria-pressed={placingElement} disabled={viewMode !== "plan"} onClick={() => chooseEditorTool("element")}>
              <Plus size={16} aria-hidden="true" />{t("twin.placeElement")}
            </button>
          </div>
          <button type="button" className={snapEnabled ? "tool-button active" : "tool-button"} aria-pressed={snapEnabled} disabled={viewMode !== "plan"} title={t("twin.snapBypass")} onClick={() => setSnapEnabled((value) => !value)}>
            <Grid3X3 size={16} aria-hidden="true" />{t("twin.snapToGrid")}
          </button>
          <label className="grid-size-control">
            <span>{t("twin.gridSize")}</span>
            <select value={gridDensity} disabled={viewMode !== "plan"} aria-label={t("twin.gridSize")} onChange={(event) => setGridDensity(event.target.value as FloorGridDensity)}>
              <option value="fine">{t("twin.gridFine")}</option>
              <option value="medium">{t("twin.gridMedium")}</option>
              <option value="coarse">{t("twin.gridCoarse")}</option>
            </select>
          </label>
          <button type="button" className="tool-button danger-tool" disabled={!selectedWallId || viewMode !== "plan"} onClick={() => deleteWall()}>
            <Trash2 size={16} aria-hidden="true" />{t("twin.deleteWall")}
          </button>
          {deletedWallUndo && <button ref={undoButtonRef} type="button" className="tool-button" aria-keyshortcuts="Control+Z Meta+Z" onClick={undoLastDeletion}>{t("common.undo")}</button>}
          <button type="button" className="tool-button" onClick={() => fileRef.current?.click()}><ImagePlus size={16} aria-hidden="true" />{t("twin.uploadPlan")}</button>
          <input ref={fileRef} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" onChange={uploadBackground} aria-label={t("twin.uploadPlan")} />
          {floor.backgroundImage && <button type="button" className="tool-button" onClick={() => { const { backgroundImage: _, ...rest } = floor; applyFloorChange(rest); }}><Trash2 size={16} aria-hidden="true" />{t("twin.removePlan")}</button>}
          {selectedRoom && (
            <div className="editor-properties" role="group" aria-label={t("twin.roomProperties")}>
              <strong>{t("twin.roomProperties")}</strong>
              <label><span>{t("twin.roomName")}</span><input ref={roomNameInputRef} required value={selectedRoom.name} aria-invalid={roomNameError ? true : undefined} aria-describedby={roomNameError ? roomNameErrorId : undefined} onFocus={() => { roomNameBeforeEdit.current = selectedRoom.name; }} onChange={(event) => { setRoomNameError(null); updateRoom(selectedRoom.id, { name: event.target.value }); }} onBlur={(event) => commitRoomName(selectedRoom.id, event.currentTarget.value)} /></label>
              <label><span>{t("twin.roomType")}</span><select value={selectedRoom.kind ?? "other"} onChange={(event) => updateRoom(selectedRoom.id, { kind: event.target.value })}>{selectedRoom.kind && !ROOM_KINDS.some((kind) => kind === selectedRoom.kind) && <option value={selectedRoom.kind}>{selectedRoom.kind}</option>}{ROOM_KINDS.map((kind) => <option key={kind} value={kind}>{roomName(kind, kind)}</option>)}</select></label>
              <button type="button" className="tool-button danger-tool" onClick={() => deleteRoom()}><Trash2 size={16} aria-hidden="true" />{t("twin.deleteRoom")}</button>
              {roomNameError && <span id={roomNameErrorId} className="editor-field-error" role="alert">{roomNameError}</span>}
              {selectedRoomSensorCount > 0 && <span className="editor-properties-note">{t("twin.roomAssignmentsManaged", { count: selectedRoomSensorCount })}</span>}
            </div>
          )}
          {selectedPlanElement && (
            <div className="editor-properties" role="group" aria-label={t("twin.elementProperties")}>
              <strong>{t(`planElement.${selectedPlanElement.kind}` as TranslationKey)}</strong>
              {selectedElementWidthBounds && <label><span>{t("twin.elementWidth")}</span><input type="number" min={selectedElementWidthBounds.min} max={selectedElementWidthBounds.max} step={selectedElementWidthBounds.step} value={elementWidthDraft} onChange={(event) => {
                const value = event.currentTarget.value;
                const number = event.currentTarget.valueAsNumber;
                setElementWidthDraft(value);
                if (Number.isFinite(number) && number >= selectedElementWidthBounds.min && number <= selectedElementWidthBounds.max) updatePlanElementWidth(selectedPlanElement.id, number);
              }} onBlur={(event) => {
                const number = event.currentTarget.valueAsNumber;
                if (!Number.isFinite(number) || !updatePlanElementWidth(selectedPlanElement.id, number)) {
                  setElementWidthDraft(String(selectedPlanElement.width ?? defaultPlanElementWidth(floor, selectedPlanElement.kind)));
                }
              }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>}
              {!isWallOpening(selectedPlanElement) && <label><span>{t("twin.elementRotation")}</span><select value={selectedElementRotation} onChange={(event) => updatePlanElement(selectedPlanElement.id, { rotationDegrees: Number(event.currentTarget.value) })}>{!selectedElementHasCardinalRotation && <option value={selectedElementRotation}>{selectedElementRotation}°</option>}{[0, 90, 180, 270].map((degrees) => <option key={degrees} value={degrees}>{degrees}°</option>)}</select></label>}
              {isWallOpening(selectedPlanElement)
                ? <button type="button" className="tool-button" onClick={() => updatePlanElement(selectedPlanElement.id, { rotationDegrees: normalizeDegrees(selectedPlanElement.rotationDegrees + 180) })}><RotateCw size={16} aria-hidden="true" />{t("twin.flipElement")}</button>
                : <>
                  <button type="button" className="tool-button" aria-keyshortcuts="Shift+R" onClick={() => updatePlanElement(selectedPlanElement.id, { rotationDegrees: normalizeDegrees(selectedPlanElement.rotationDegrees - 90) })}><RotateCcw size={16} aria-hidden="true" />{t("twin.rotateElementLeft")}</button>
                  <button type="button" className="tool-button" aria-keyshortcuts="R" onClick={() => updatePlanElement(selectedPlanElement.id, { rotationDegrees: normalizeDegrees(selectedPlanElement.rotationDegrees + 90) })}><RotateCw size={16} aria-hidden="true" />{t("twin.rotateElementRight")}</button>
                </>}
              <button type="button" className="tool-button danger-tool" onClick={() => deletePlanElement()}><Trash2 size={16} aria-hidden="true" />{t("twin.deleteElement")}</button>
            </div>
          )}
          <span className="editor-hint" role="status" aria-live="polite">{editorHint}</span>
          {uploadError && <span className="editor-error" role="alert">{uploadError}</span>}
        </div>
      )}
      {observationPlacement && <div className="placement-banner" role="status"><MapPinPlus size={17} aria-hidden="true" /><span>{t("observations.locationHint")}<small>{t("twin.keyboardPlacement")}</small></span></div>}
      <div className={`plan-stage ${viewMode === "isometric" ? "isometric" : ""}`}>
        <svg
          ref={svgRef}
          className={`floor-plan ${layoutEditing || observationPlacement ? "direct-manipulation" : "monitoring"}`}
          viewBox={`${-viewportMargin} ${-viewportMargin} ${renderWidth + viewportMargin * 2} ${renderHeight + viewportMargin * 2}`}
          role="group"
          aria-label={layoutEditing ? t("twin.ariaEditMap", { floor: floor.name }) : t("twin.ariaMap", { metric: metricLabel, floor: floor.name })}
          aria-describedby={keyboardPlacementActive ? mapHelpId : undefined}
          tabIndex={keyboardPlacementActive ? 0 : undefined}
          onPointerDown={mapPointerDown}
          onPointerMove={mapPointerMove}
          onKeyDown={mapKeyDown}
        >
          <desc>{layoutEditing
            ? t("twin.editMapDescription")
            : airflowPaths.length
              ? t("twin.airflowMapDescription", { metric: metricLabel })
              : clouds.length
              ? t("twin.estimatedFieldDescription", { metric: metricLabel })
              : definition.spatialInterpolation
                ? t("twin.estimateUnavailable", { metric: metricLabel })
                : t("building.noSpatial", { metric: metricLabel })}</desc>
          <defs>
            <clipPath id={`${fieldId}-clip`}><rect x="0" y="0" width={renderWidth} height={renderHeight} rx="20" /></clipPath>
            <filter id={`${fieldId}-soften`} x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="7" /></filter>
            <marker id={`${fieldId}-arrow`} markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0L9 4.5L0 9Z" className="flow-arrow-head" /></marker>
            <marker id={`${fieldId}-airflow-arrow`} markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0L9 4.5L0 9Z" className="simulated-flow-arrow-head" /></marker>
            <marker id={`${fieldId}-outdoor-arrow`} markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L12 6L0 12Z" className="outdoor-wind-arrow-head" /></marker>
            <filter id={`${fieldId}-sensor-shadow`} x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="5" stdDeviation="6" floodOpacity=".22" /></filter>
            <pattern id={`${fieldId}-grid-minor`} width={renderedGridSize} height={renderedGridSize} patternUnits="userSpaceOnUse">
              <path d={`M${renderedGridSize} 0H0V${renderedGridSize}`} className="plan-grid-minor-line" />
            </pattern>
            <pattern id={`${fieldId}-grid-major`} width={renderedGridSize * 5} height={renderedGridSize * 5} patternUnits="userSpaceOnUse">
              <rect width={renderedGridSize * 5} height={renderedGridSize * 5} fill={`url(#${fieldId}-grid-minor)`} />
              <path d={`M${renderedGridSize * 5} 0H0V${renderedGridSize * 5}`} className="plan-grid-major-line" />
            </pattern>
            {clouds.map((cloud) => (
              <radialGradient key={`${cloud.id}-gradient`} id={`${fieldId}-${cloud.id}`}>
                <stop offset="0" stopColor={cloud.color} stopOpacity={Math.min(.82, cloud.opacity + .34)} />
                <stop offset="52%" stopColor={cloud.color} stopOpacity={cloud.opacity} />
                <stop offset="100%" stopColor={cloud.color} stopOpacity="0" />
              </radialGradient>
            ))}
          </defs>
          <g transform={transform} className="plan-transform">
            {showMonitoringOverlays && viewMode === "plan" && outdoorContext && (
              <g className={`outdoor-shell ${activeOutdoorColor ? "compared" : ""} ${outdoorContext.stale ? "stale" : ""}`} style={activeOutdoorStyle} role="img" aria-label={outdoorShellLabel}>
                <rect
                  x={-OUTDOOR_SHELL_OFFSET}
                  y={-OUTDOOR_SHELL_OFFSET}
                  width={renderWidth + OUTDOOR_SHELL_OFFSET * 2}
                  height={renderHeight + OUTDOOR_SHELL_OFFSET * 2}
                  rx="32"
                  className="outdoor-shell-halo"
                />
                <rect
                  x={-OUTDOOR_SHELL_OFFSET}
                  y={-OUTDOOR_SHELL_OFFSET}
                  width={renderWidth + OUTDOOR_SHELL_OFFSET * 2}
                  height={renderHeight + OUTDOOR_SHELL_OFFSET * 2}
                  rx="32"
                  className="outdoor-shell-border"
                />
                <text x={-45} y={renderHeight * .72} transform={`rotate(-90 -45 ${renderHeight * .72})`} className="outdoor-shell-name">
                  {t("outdoor.shellLabel")}
                </text>
                <g transform={`translate(${renderWidth - OUTDOOR_SHELL_CHIP_RIGHT_INSET - OUTDOOR_SHELL_CHIP_WIDTH * 2 - OUTDOOR_SHELL_CHIP_GAP} ${-OUTDOOR_SHELL_OFFSET})`} className={`outdoor-shell-chip outdoor-temperature-chip ${outdoorTemperatureColor ? "condition-color" : ""}`} style={outdoorTemperatureStyle}>
                  <rect width={OUTDOOR_SHELL_CHIP_WIDTH} height={OUTDOOR_SHELL_CHIP_HEIGHT} x="0" y={-OUTDOOR_SHELL_CHIP_HEIGHT / 2} rx={OUTDOOR_SHELL_CHIP_HEIGHT / 2} />
                  <text x={OUTDOOR_SHELL_CHIP_WIDTH / 2} y="-8" textAnchor="middle"><tspan className="outdoor-shell-chip-label">{t("outdoor.shellTemperature")}</tspan></text>
                  <text x={OUTDOOR_SHELL_CHIP_WIDTH / 2} y="15" textAnchor="middle"><tspan className="outdoor-shell-chip-value">{outdoorTemperature ?? t("common.noData")}</tspan></text>
                </g>
                <g transform={`translate(${renderWidth - OUTDOOR_SHELL_CHIP_RIGHT_INSET - OUTDOOR_SHELL_CHIP_WIDTH} ${-OUTDOOR_SHELL_OFFSET})`} className={`outdoor-shell-chip outdoor-humidity-chip ${outdoorHumidityColor ? "condition-color" : ""}`} style={outdoorHumidityStyle}>
                  <rect width={OUTDOOR_SHELL_CHIP_WIDTH} height={OUTDOOR_SHELL_CHIP_HEIGHT} x="0" y={-OUTDOOR_SHELL_CHIP_HEIGHT / 2} rx={OUTDOOR_SHELL_CHIP_HEIGHT / 2} />
                  <text x={OUTDOOR_SHELL_CHIP_WIDTH / 2} y="-8" textAnchor="middle"><tspan className="outdoor-shell-chip-label">{t("outdoor.shellHumidity")}</tspan></text>
                  <text x={OUTDOOR_SHELL_CHIP_WIDTH / 2} y="15" textAnchor="middle"><tspan className="outdoor-shell-chip-value">{outdoorHumidity ?? t("common.noData")}</tspan></text>
                </g>
              </g>
            )}
            <rect x="0" y="0" width={renderWidth} height={renderHeight} rx="20" className="plan-base" />
            {viewMode === "isometric" && <path d={`M0 ${renderHeight} L${renderWidth} ${renderHeight} L${renderWidth} ${renderHeight + 38} L0 ${renderHeight + 38}Z`} className="floor-edge" />}
            {floor.backgroundImage && <image href={floor.backgroundImage} x="0" y="0" width={renderWidth} height={renderHeight} preserveAspectRatio="xMidYMid slice" className="plan-background" />}
            {showMonitoringOverlays && (
              <g filter={`url(#${fieldId}-soften)`} clipPath={`url(#${fieldId}-clip)`} className="heat-field heat-clouds" aria-hidden="true">
                {clouds.map((cloud) => <ellipse key={cloud.id} cx={cloud.x} cy={cloud.y} rx={cloud.rx} ry={cloud.ry} fill={`url(#${fieldId}-${cloud.id})`} className={`heat-cloud-lobe ${cloud.level}`} />)}
              </g>
            )}
            {layoutEditing && <rect data-testid="floor-snap-grid" x="0" y="0" width={renderWidth} height={renderHeight} rx="20" fill={`url(#${fieldId}-grid-major)`} className="plan-grid" aria-hidden="true" />}
            <g className={`rooms ${layoutEditing ? "editable" : ""}`}>
              {floor.rooms.filter((room) => room.points.length >= 3).map((room) => {
                const selected = room.id === selectedRoomId;
                const centerX = room.points.reduce((sum, point) => sum + point.x, 0) / room.points.length * renderScale;
                const centerY = room.points.reduce((sum, point) => sum + point.y, 0) / room.points.length * renderScale;
                const renderedPoints = room.points.map((point) => `${point.x * renderScale},${point.y * renderScale}`).join(" ");
                return (
                  <g
                    key={room.id}
                    className={`room-zone ${selected ? "selected" : ""}`}
                    role={roomSelectionActive ? "button" : "img"}
                    tabIndex={roomSelectionActive ? 0 : undefined}
                    aria-label={t("twin.roomAria", { name: room.name })}
                    aria-pressed={roomSelectionActive ? selected : undefined}
                    onPointerDown={roomSelectionActive ? (event) => roomPointerDown(event, room.id) : undefined}
                    onKeyDown={roomSelectionActive ? (event) => roomKeyDown(event, room.id) : undefined}
                  >
                    {layoutEditing && <polygon points={renderedPoints} className="room-zone-area" />}
                    <text x={centerX} y={centerY} textAnchor="middle">{room.name}</text>
                  </g>
                );
              })}
              {roomStart && (
                <g className="room-preview" aria-hidden="true">
                  <polygon points={roomRectanglePoints(roomStart, keyboardPoint).map((point) => `${point.x * renderScale},${point.y * renderScale}`).join(" ")} />
                  <circle cx={roomStart.x * renderScale} cy={roomStart.y * renderScale} r="8" />
                </g>
              )}
            </g>
            <g className="walls" aria-hidden={wallSelectionActive ? undefined : true}>
              {floor.walls.map((wall, index) => {
                const selected = wall.id === selectedWallId;
                const wallLabel = t("twin.wallAria", { number: index + 1 });
                const coordinates = {
                  x1: wall.from.x * renderScale,
                  y1: wall.from.y * renderScale,
                  x2: wall.to.x * renderScale,
                  y2: wall.to.y * renderScale,
                };
                const focusBounds = {
                  x: Math.min(coordinates.x1, coordinates.x2) - 14,
                  y: Math.min(coordinates.y1, coordinates.y2) - 14,
                  width: Math.max(Math.abs(coordinates.x2 - coordinates.x1), 1) + 28,
                  height: Math.max(Math.abs(coordinates.y2 - coordinates.y1), 1) + 28,
                };
                return (
                  <g
                    key={wall.id}
                    className={`wall-segment-group ${selected ? "selected" : ""}`}
                    role={wallSelectionActive ? "button" : undefined}
                    tabIndex={wallSelectionActive ? 0 : undefined}
                    aria-label={wallSelectionActive ? wallLabel : undefined}
                    aria-pressed={wallSelectionActive ? selected : undefined}
                    onPointerDown={wallSelectionActive ? (event) => wallPointerDown(event, wall.id) : undefined}
                    onKeyDown={wallSelectionActive ? (event) => wallKeyDown(event, wall.id) : undefined}
                  >
                    {wallSelectionActive && <rect {...focusBounds} className="wall-focus-bounds" aria-hidden="true" />}
                    {wallSelectionActive && <line {...coordinates} className="wall-hit-target" />}
                    <line {...coordinates} className="wall-segment" />
                  </g>
                );
              })}
              {wallStart && <line x1={wallStart.x * renderScale} y1={wallStart.y * renderScale} x2={keyboardPoint.x * renderScale} y2={keyboardPoint.y * renderScale} className="wall-preview" />}
              {wallStart && <circle cx={wallStart.x * renderScale} cy={wallStart.y * renderScale} r="8" className="wall-start" />}
            </g>
            <g className="plan-elements">
              {planElements.map((element, index) => {
                const selected = element.id === selectedPlanElementId;
                const symbolWidth = Math.max(28, (element.width ?? defaultPlanElementWidth(floor, element.kind)) * renderScale);
                const label = t("twin.elementAria", {
                  element: t(`planElement.${element.kind}` as TranslationKey),
                  number: index + 1,
                });
                const glyphHeight = element.kind === "door"
                  ? symbolWidth
                  : element.kind === "window"
                    ? 20
                    : Math.max(18, Math.min(symbolWidth * (element.kind === "vent" ? .45 : .55), 42));
                const glyphTop = element.kind === "door" ? -symbolWidth : -glyphHeight / 2;
                return (
                  <g
                    key={element.id}
                    ref={(node) => { if (node) planElementRefs.current.set(element.id, node); else planElementRefs.current.delete(element.id); }}
                    transform={`translate(${element.position.x * renderScale} ${element.position.y * renderScale}) rotate(${element.rotationDegrees})`}
                    className={`plan-element ${element.kind} ${selected ? "selected" : ""}`}
                    role={planElementSelectionActive ? "button" : "img"}
                    tabIndex={planElementSelectionActive ? 0 : undefined}
                    aria-label={label}
                    aria-pressed={planElementSelectionActive ? selected : undefined}
                    aria-keyshortcuts={planElementSelectionActive ? isWallOpening(element) ? "R Delete Backspace" : "R Shift+R Delete Backspace" : undefined}
                    onPointerDown={planElementSelectionActive ? (event) => planElementPointerDown(event, element.id) : undefined}
                    onPointerMove={planElementSelectionActive ? (event) => planElementPointerMove(event, element.id) : undefined}
                    onPointerUp={() => { draggingElement.current = null; }}
                    onPointerCancel={() => { draggingElement.current = null; }}
                    onLostPointerCapture={() => { draggingElement.current = null; }}
                    onKeyDown={planElementSelectionActive ? (event) => planElementKeyDown(event, element) : undefined}
                  >
                    <rect x={-symbolWidth / 2 - 12} y={glyphTop - 12} width={symbolWidth + 24} height={glyphHeight + 24} className="plan-element-hit-target" />
                    {selected && <rect x={-symbolWidth / 2 - 9} y={glyphTop - 9} width={symbolWidth + 18} height={glyphHeight + 18} rx="8" className="plan-element-selection" />}
                    <PlanElementGlyph kind={element.kind} width={symbolWidth} />
                  </g>
                );
              })}
              {placingElement && elementPreviewPlacement && (
                <g
                  transform={`translate(${elementPreviewPlacement.position.x * renderScale} ${elementPreviewPlacement.position.y * renderScale}) rotate(${elementPreviewPlacement.rotationDegrees})`}
                  className="plan-element preview"
                  aria-hidden="true"
                >
                  <PlanElementGlyph kind={planElementKind} width={Math.max(28, defaultPlanElementWidth(floor, planElementKind) * renderScale)} />
                </g>
              )}
            </g>
            {showMonitoringOverlays && edgeLabels.length > 0 && (
              <g className="outdoor-edge-labels" aria-hidden="true">
                {edgeLabels.map((item) => (
                  <text key={item.edge} x={item.x} y={item.y} textAnchor="middle" dominantBaseline="middle" data-plan-edge={item.edge}>
                    {t(`outdoor.cardinal.${item.cardinal}` as TranslationKey)} {Math.round(item.bearing)}°
                  </text>
                ))}
              </g>
            )}
            {showMonitoringOverlays && outdoorPath && outdoorArrowLabel && (
              <g
                className="outdoor-wind-vector floor-outdoor-wind"
                role="img"
                aria-label={outdoorArrowLabel}
                data-windward-edge={outdoorContext?.windwardEdge ?? undefined}
                data-plan-wind-from={outdoorContext?.planWindFromDegrees?.toFixed(2)}
              >
                <title>{outdoorArrowLabel}</title>
                <circle cx={outdoorPath.sourcePoint.x} cy={outdoorPath.sourcePoint.y} r="14" className="outdoor-wind-source-halo" />
                <circle cx={outdoorPath.sourcePoint.x} cy={outdoorPath.sourcePoint.y} r="8" className="outdoor-wind-source" />
                <path d={`M${outdoorPath.sourcePoint.x} ${outdoorPath.sourcePoint.y}L${outdoorPath.inwardTarget.x} ${outdoorPath.inwardTarget.y}`} className="outdoor-wind-path" markerEnd={`url(#${fieldId}-outdoor-arrow)`} />
                {outdoorWindLabelPosition && (
                  <text x={outdoorWindLabelPosition.x} y={outdoorWindLabelPosition.y} textAnchor={outdoorWindLabelPosition.textAnchor} className="outdoor-wind-label">
                    <tspan className="outdoor-wind-label-source">{t("outdoor.shellWind")}</tspan>
                    <tspan>{` · ${outdoorWindSpeed ?? t("common.noData")}${outdoorWindDirection ? ` · ${outdoorWindDirection}` : ""}`}</tspan>
                  </text>
                )}
              </g>
            )}
            {showMonitoringOverlays && airflowPaths.length > 0 && (
              <g className="flow-layer simulated-airflow-layer" role="img" aria-label={airflowAria}>
                <title>{airflowAria}</title>
                {airflowPaths.map((flow) => {
                  const path = smoothAirflowPath(flow.points, renderScale);
                  const midpoint = flow.points[Math.floor(flow.points.length / 2)]!;
                  const verticalCue = flow.verticalTendency > .13 ? "↑" : flow.verticalTendency < -.13 ? "↓" : "";
                  return (
                    <g
                      key={flow.id}
                      aria-hidden="true"
                      data-relative-speed={flow.relativeSpeed.toFixed(3)}
                      data-support={flow.support.toFixed(3)}
                      data-vertical={flow.verticalTendency.toFixed(3)}
                    >
                      <path d={path} className="flow-path simulated-flow-path" markerEnd={`url(#${fieldId}-airflow-arrow)`} />
                      {!reducedMotion && <circle r="5" className="flow-particle simulated-flow-particle"><animateMotion dur="3.4s" repeatCount="indefinite" path={path} /></circle>}
                      {verticalCue && <text x={midpoint.x * renderScale} y={midpoint.y * renderScale - 12} textAnchor="middle" className="airflow-vertical-cue" aria-hidden="true">{verticalCue}</text>}
                    </g>
                  );
                })}
              </g>
            )}
            {showMonitoringOverlays && activeGradientFlows.length > 0 && <g className="flow-layer gradient-flow-layer" aria-label={t("twin.flow")}>
              {activeGradientFlows.map(({ id, from, to, difference }, index) => {
                const fromX = from.x;
                const fromY = from.y;
                const toX = to.x;
                const toY = to.y;
                const distance = Math.max(1, Math.hypot(toX - fromX, toY - fromY));
                const bend = Math.min(34, distance * .13) * (index % 2 ? 1 : -1);
                const curveX = (fromX + toX) / 2 - (toY - fromY) / distance * bend;
                const curveY = (fromY + toY) / 2 + (toX - fromX) / distance * bend;
                const path = `M${fromX} ${fromY} Q${curveX} ${curveY} ${toX} ${toY}`;
                const label = t("twin.gradientAria", {
                  from: formatMeasurement(from.value, definition, units),
                  to: formatMeasurement(to.value, definition, units),
                  difference: formatMeasurementDelta(difference, definition, units),
                });
                return (
                  <g key={id} role="img" aria-label={label}>
                    <title>{label}</title>
                    <path d={path} className="flow-path" markerEnd={`url(#${fieldId}-arrow)`} />
                    {!reducedMotion && <circle r="5" className="flow-particle"><animateMotion dur={`${2.8 + index * .32}s`} repeatCount="indefinite" path={path} /></circle>}
                  </g>
                );
              })}
            </g>}
            {showMonitoringOverlays && <g className="observations-layer">
              {observations.filter((item) => item.x != null && item.y != null).map((item) => (
                <g key={item.id} transform={`translate(${item.x! * renderScale} ${item.y! * renderScale})`} className={`observation-marker ${item.severity}`} aria-label={`${t(`observations.${item.kind === "note" ? "noteKind" : item.kind}`)}: ${item.note}`}>
                  <path d="M0-18C-10-18-17-11-17-2C-17 10 0 23 0 23S17 10 17-2C17-11 10-18 0-18Z" />
                  <circle cy="-3" r="5" />
                </g>
              ))}
            </g>}
            {selectedRoom && roomSelectionActive && (
              <g className="room-handles" aria-label={t("twin.roomCorners", { name: selectedRoom.name })}>
                {selectedRoom.points.map((point, pointIndex) => (
                  <circle
                    key={pointIndex}
                    cx={point.x * renderScale}
                    cy={point.y * renderScale}
                    r="9"
                    className="room-vertex-handle"
                    role="button"
                    tabIndex={0}
                    aria-label={t("twin.roomCornerAria", { name: selectedRoom.name, number: pointIndex + 1 })}
                    onPointerDown={(event) => roomVertexPointerDown(event, selectedRoom.id, pointIndex)}
                    onPointerMove={(event) => moveRoomVertex(event, selectedRoom.id, pointIndex)}
                    onPointerUp={() => { draggingRoomVertex.current = null; }}
                    onPointerCancel={() => { draggingRoomVertex.current = null; }}
                    onLostPointerCapture={() => { draggingRoomVertex.current = null; }}
                    onKeyDown={(event) => roomVertexKeyDown(event, selectedRoom.id, pointIndex)}
                  />
                ))}
              </g>
            )}
            {keyboardPlacementActive && (
              <g transform={`translate(${keyboardPoint.x * renderScale} ${keyboardPoint.y * renderScale})`} className="placement-cursor" aria-hidden="true">
                <circle r="15" />
                <line x1="-22" x2="22" y1="0" y2="0" />
                <line x1="0" x2="0" y1="-22" y2="22" />
              </g>
            )}
            <g className="sensors-layer">
              {sensors.filter((sensor) => sensor.enabled).map((sensor) => {
                const sample = samples[sensor.id];
                const quality = !sample
                  ? null
                  : isSpatialSampleFresh(sample, spatialFreshness)
                    ? sample.quality
                    : "stale";
                const value = quality === "stale" ? undefined : measurementValue(sample, definition.id);
                const qualityLabel = quality === "stale"
                  ? t("building.statusStale")
                  : quality === "estimated"
                    ? t("building.statusEstimated")
                    : null;
                const selected = sensor.id === selectedSensorId;
                return (
                  <g
                    key={sensor.id}
                    transform={`translate(${sensor.x * renderScale} ${sensor.y * renderScale})`}
                    className={`sensor-marker ${selected ? "selected" : ""} ${layoutEditing && selectingLayout ? "movable" : ""} ${quality ?? ""}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${sensor.name}, ${metricLabel}, ${value == null ? t("common.noData") : formatMeasurement(value, definition, units)}${qualityLabel ? `, ${qualityLabel}` : ""}`}
                    aria-pressed={selected}
                    onPointerDown={(event) => startSensorDrag(event, sensor.id)}
                    onPointerMove={(event) => moveSensor(event, sensor.id)}
                    onPointerUp={() => { dragging.current = null; }}
                    onPointerCancel={() => { dragging.current = null; }}
                    onLostPointerCapture={() => { dragging.current = null; }}
                    onKeyDown={(event) => sensorKeyDown(event, sensor)}
                  >
                    <circle r="28" className="sensor-halo" />
                    <circle r="21" className="sensor-core" filter={`url(#${fieldId}-sensor-shadow)`} />
                    <circle r="4" cy="-6" className="sensor-dot" />
                    <text y="9" textAnchor="middle" className="sensor-value">{value == null ? "—" : toDisplayValue(value, definition, units).toFixed(definition.precision)}</text>
                    <text y="45" textAnchor="middle" className="sensor-label">{sensor.name}</text>
                  </g>
                );
              })}
            </g>
          </g>
        </svg>
        {showMonitoringOverlays && outdoor && <OutdoorConditionsBadge outdoor={outdoor} units={units} showCompass />}
        {showMonitoringOverlays && clouds.length > 0 && <div className="heat-legend" aria-label={`${t("twin.estimatedField", { metric: metricLabel })}: ${legendMin} – ${legendMax}`}>
          <strong className="heat-legend-title">{t("twin.estimatedField", { metric: metricLabel })}</strong>
          <span>{t("twin.heatLegendLow")}</span>
          <span className="heat-gradient" style={{ background: measurementGradient(definition) }} aria-hidden="true" />
          <span>{t("twin.heatLegendHigh")}</span>
          <strong>{legendMin}</strong><strong>{legendMax}</strong>
        </div>}
        {showMonitoringOverlays && airflowPaths.length > 0 && <div className="flow-legend simulated-flow-legend"><span className="flow-sample simulated" aria-hidden="true">↝</span><span><strong>{t("twin.airflow")}</strong><small>{airflowDescription}</small></span></div>}
        {showMonitoringOverlays && airflowPaths.length === 0 && activeGradientFlows.length > 0 && <div className="flow-legend"><span className="flow-sample" aria-hidden="true">→</span><span><strong>{t("twin.flow")}</strong><small>{t("twin.flowDescription")}</small></span></div>}
      </div>
      <span id={mapHelpId} className="sr-only">{t("twin.keyboardPlacement")}</span>
    </div>
  );
}
