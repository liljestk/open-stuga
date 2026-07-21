import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { BoxSelect, Grid3X3, ImagePlus, MapPinPlus, MousePointer2, PenLine, Plus, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import { configuredPlanElementOpeningState, floorMetersPerPlanUnit, isAirflowPlanElement, wallLengthPlanUnits, type ConfiguredOpeningState, type Floor, type House, type ManualObservation, type MeasurementDefinition, type MeasurementSample, type PlanElement, type PlanElementKind, type Point, type Room, type Sensor, type UnitSystem, type Wall } from "@climate-twin/contracts";
import { clamp, round, type ViewMode } from "../domain";
import { useI18n, type TranslationKey } from "../i18n";
import { formatMeasurement, formatMeasurementDelta, measurementGradient, measurementLabel, measurementValue, toDisplayValue, type LatestMeasurements } from "../measurements";
import { energyDeviceMapStats, isEnergyDeviceSensor } from "../energyDeviceMap";
import { createCloudLobes, estimateFieldFlows, heatColor, interpolateHeat } from "../spatialField";
import { simulateFloorAirflow, type AirflowPoint2D, type ClimateSampleMatrix, type FloorAirflowEstimate } from "../airflowSimulation";
import { configuredSpatialMaxSampleAgeMs, isSpatialSampleFresh } from "../spatialFreshness";
import { cardinalDirection, normalizeDegrees, type PlanEdge } from "../outdoorContext";
import {
  formatOutdoorHumidity,
  formatOutdoorTemperature,
  formatOutdoorWindSpeed,
  OutdoorConditionsBadge,
  type OutdoorVisualizationState,
} from "./OutdoorConditionsBadge";
import { PlanElementDimensionFields } from "./PlanElementDimensionFields";
import { applyAirflowPlanElementPatch, PlanElementAirflowFields, type AirflowPlanElementPatch } from "./PlanElementAirflowFields";
import { applyFixturePlanElementPatch, PlanElementFixtureFields, type FixturePlanElementPatch } from "./PlanElementFixtureFields";
import { OpeningInventory } from "./OpeningInventory";
import { SpatialLayerOverlay2D } from "./SpatialLayerOverlay2D";
import type { SpatialLayerSnapshot, SpatialTopology } from "../spatialLayers";
import type { SensorCoverageAssessment } from "../experimentalSpatialLayers";
import { ExperimentalSensorCoverage2D } from "./ExperimentalSensorCoverage";
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
} from "../planElementGeometry";
import { chimneyPenetrationsForFloor, fireplaceChimneyDimensions } from "../architecturalGeometry";
import { MapInformationToggle, useMapInformationVisibility } from "./MapInformationToggle";

export { heatColor, interpolateHeat } from "../spatialField";
export { clampPlanElementWidth, defaultPlanElementWidth, planElementWidthBounds } from "../planElementGeometry";

interface FloorPlanProps {
  floor: Floor;
  /** Whole-house context reveals chimney penetrations inherited from lower floors. */
  house?: House;
  sensors: Sensor[];
  samples: Record<string, MeasurementSample>;
  /** Metric-complete samples used by capability-specific markers such as energy plugs. */
  sensorMeasurements?: LatestMeasurements;
  energyDevicesVisible?: boolean;
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
  spatialLayerSnapshots?: readonly SpatialLayerSnapshot[];
  spatialLayerTopology?: SpatialTopology | null;
  experimentalAirflowEnabled?: boolean;
  experimentalAirflow?: FloorAirflowEstimate | null;
  experimentalSensorCoverage?: SensorCoverageAssessment | null;
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
const PLAN_ELEMENT_KINDS: PlanElementKind[] = ["door", "window", "fireplace", "vent", "fireEscape"];
const PLAN_VIEWPORT_MARGIN = 88;
const OUTDOOR_SHELL_OFFSET = 64;
const OUTDOOR_SHELL_CHIP_WIDTH = 164;
const OUTDOOR_SHELL_CHIP_HEIGHT = 54;
const OUTDOOR_SHELL_CHIP_GAP = 12;
const OUTDOOR_SHELL_CHIP_RIGHT_INSET = 8;

const GRID_DENSITY_MULTIPLIER: Record<FloorGridDensity, number> = {
  fine: .5,
  medium: 1,
  coarse: 2,
};

const GEOMETRY_EPSILON = 1e-8;

function outdoorWindwardEdgePath(edge: PlanEdge, width: number, height: number): string {
  const endInset = 30;
  const compassGap = 68;
  if (edge === "top" || edge === "bottom") {
    const y = edge === "top" ? -OUTDOOR_SHELL_OFFSET : height + OUTDOOR_SHELL_OFFSET;
    return `M${endInset} ${y}H${width / 2 - compassGap}M${width / 2 + compassGap} ${y}H${width - endInset}`;
  }
  const x = edge === "left" ? -OUTDOOR_SHELL_OFFSET : width + OUTDOOR_SHELL_OFFSET;
  return `M${x} ${endInset}V${height / 2 - compassGap}M${x} ${height / 2 + compassGap}V${height - endInset}`;
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

interface PlanElementPatch extends AirflowPlanElementPatch, FixturePlanElementPatch {
  position?: Point;
  rotationDegrees?: number;
  width?: number;
  height?: number;
  wallId?: string;
}

interface DeletedWallUndo {
  floorId: string;
  wall: Wall;
  wallIndex: number;
  openings: Array<{ element: PlanElement; index: number }>;
}

function PlanElementGlyph({ kind, width, state, projection }: { kind: PlanElementKind; width: number; state?: ConfiguredOpeningState | undefined; projection?: number | undefined }) {
  const half = width / 2;
  const depth = Math.max(18, Math.min(width * .55, 42));
  if (kind === "door") return (
    <g className="door-glyph">
      <line x1={-half} x2={half} className="plan-element-wall-cutout" />
      {state === "closed"
        ? <line x1={-half} y1="0" x2={half} y2="0" className="plan-element-stroke" />
        : <><line x1={-half} y1="0" x2={-half} y2={-width} className="plan-element-stroke" /><path d={`M${-half} ${-width}A${width} ${width} 0 0 1 ${half} 0`} className="plan-element-detail" /></>}
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
      {state === "open" && <line x1="0" y1="-5" x2={Math.min(half, 22)} y2="-20" className="plan-element-detail" />}
    </g>
  );
  if (kind === "fireplace") return (
    <g className="fireplace-glyph">
      <rect x={-half} y={-depth / 2} width={width} height={depth} rx="3" className="plan-element-body" />
      <path d={`M0 ${depth * .28}C${-width * .16} ${depth * .05} ${-width * .1} ${-depth * .25} 0 ${-depth * .34}C${width * .18} ${-depth * .08} ${width * .16} ${depth * .12} 0 ${depth * .28}Z`} className="plan-element-flame" />
    </g>
  );
  if (kind === "fireEscape") {
    const escapeDepth = Math.max(24, projection ?? width * .65);
    return <g className="fire-escape-glyph">
      <rect x={-half} y="0" width={width} height={escapeDepth} rx="2" className="plan-element-body" />
      {[-.32, -.1, .12, .34, .56, .78].map((offset) => <line key={offset} x1={-half * .72} x2={half * .72} y1={escapeDepth * (offset + .1)} y2={escapeDepth * (offset + .1)} className="plan-element-detail" />)}
      <line x1={-half * .78} x2={-half * .78} y1="0" y2={escapeDepth} className="plan-element-stroke" />
      <line x1={half * .78} x2={half * .78} y1="0" y2={escapeDepth} className="plan-element-stroke" />
    </g>;
  }
  const ventHeight = Math.max(18, Math.min(width * .45, 34));
  return (
    <g className="vent-glyph">
      <rect x={-half} y={-ventHeight / 2} width={width} height={ventHeight} rx="4" className="plan-element-body" />
      {[-.3, -.1, .1, .3].map((offset) => <line key={offset} x1={width * offset} x2={width * offset} y1={-ventHeight * .32} y2={ventHeight * .32} className="plan-element-detail" />)}
      {state === "closed" && <><line x1={-half * .7} y1={-ventHeight * .34} x2={half * .7} y2={ventHeight * .34} className="plan-element-stroke" /><line x1={half * .7} y1={-ventHeight * .34} x2={-half * .7} y2={ventHeight * .34} className="plan-element-stroke" /></>}
    </g>
  );
}

export function FloorPlan({
  floor, house, sensors, samples, climateSamples, observations, definition, colorDomain, units, viewMode, selectedSensorId, editing,
  observationPlacement, onSensorSelect, onSensorMove, onFloorChange, onObservationPoint, onCancelObservationPlacement,
  referenceTimeMs, maxSampleAgeMs,
  outdoor, spatialLayerSnapshots = [], spatialLayerTopology = null,
  experimentalAirflowEnabled = false, experimentalAirflow = null, experimentalSensorCoverage = null,
  sensorMeasurements = {}, energyDevicesVisible = true,
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
  const roomVertexRefs = useRef(new Map<string, SVGCircleElement>());
  const pendingRoomVertexFocus = useRef<{ roomId: string; pointIndex: number } | null>(null);
  const planElementRefs = useRef(new Map<string, SVGGElement>());
  const mapHelpId = useId();
  const mapInformationId = `map-information-${useId().replace(/:/g, "")}`;
  const roomNameErrorId = useId();
  const wallLengthErrorId = useId();
  const fieldId = `floor-field-${useId().replace(/:/g, "")}`;
  const [editorTool, setEditorTool] = useState<EditorTool>("select");
  const [wallStart, setWallStart] = useState<Point | null>(null);
  const [roomStart, setRoomStart] = useState<Point | null>(null);
  const [selectedWallId, setSelectedWallId] = useState<string | null>(null);
  const [wallLengthDraft, setWallLengthDraft] = useState("");
  const [wallLengthError, setWallLengthError] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [selectedPlanElementId, setSelectedPlanElementId] = useState<string | null>(null);
  const [planElementKind, setPlanElementKind] = useState<PlanElementKind>("door");
  const [placementError, setPlacementError] = useState<string | null>(null);
  const [roomNameError, setRoomNameError] = useState<string | null>(null);
  const [deletedWallUndo, setDeletedWallUndo] = useState<DeletedWallUndo | null>(null);
  const [undoMessage, setUndoMessage] = useState<string | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [gridDensity, setGridDensity] = useState<FloorGridDensity>("medium");
  const [addToolsOpen, setAddToolsOpen] = useState(false);
  const [editorOptionsOpen, setEditorOptionsOpen] = useState(false);
  const [keyboardPoint, setKeyboardPoint] = useState<Point>({ x: floor.width / 2, y: floor.height / 2 });
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const { expanded: mapInformationExpanded, setMapInformationExpanded } = useMapInformationVisibility();
  const renderScale = floorRenderScale(floor.width);
  const metresPerPlanUnit = floorMetersPerPlanUnit(floor, house);
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
  const chimneyPenetrations = chimneyPenetrationsForFloor(house, floor);
  const selectedWall = floor.walls.find((wall) => wall.id === selectedWallId) ?? null;
  const selectedRoom = floor.rooms.find((room) => room.id === selectedRoomId) ?? null;
  const selectedPlanElement = planElements.find((element) => element.id === selectedPlanElementId) ?? null;
  const selectedRoomSensorCount = selectedRoom
    ? sensors.filter((sensor) => sensor.roomId === selectedRoom.id).length
    : 0;

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
    setWallLengthDraft("");
    setWallLengthError(null);
    setSelectedRoomId(null);
    setSelectedPlanElementId(null);
    setPlacementError(null);
    setRoomNameError(null);
    setDeletedWallUndo(null);
    setUndoMessage(null);
    setAddToolsOpen(false);
    setEditorOptionsOpen(false);
    dragging.current = null;
    draggingElement.current = null;
    draggingRoomVertex.current = null;
    pendingRoomVertexFocus.current = null;
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
      setWallLengthDraft("");
      setWallLengthError(null);
      setSelectedRoomId(null);
      setSelectedPlanElementId(null);
      setPlacementError(null);
      setRoomNameError(null);
      setAddToolsOpen(false);
      setEditorOptionsOpen(false);
    }
  }, [editing, viewMode]);

  useEffect(() => {
    if (selectedWallId && !floor.walls.some((wall) => wall.id === selectedWallId)) setSelectedWallId(null);
  }, [floor.walls, selectedWallId]);

  useEffect(() => {
    setWallLengthError(null);
    if (!selectedWall || metresPerPlanUnit === null) {
      setWallLengthDraft("");
      return;
    }
    setWallLengthDraft(wallLengthInputValue(wallLengthPlanUnits(selectedWall) * metresPerPlanUnit));
  }, [selectedWall?.id, selectedWall?.from.x, selectedWall?.from.y, selectedWall?.to.x, selectedWall?.to.y, metresPerPlanUnit]);

  useEffect(() => {
    if (selectedRoomId && !floor.rooms.some((room) => room.id === selectedRoomId)) setSelectedRoomId(null);
  }, [floor.rooms, selectedRoomId]);

  useEffect(() => {
    const pending = pendingRoomVertexFocus.current;
    if (!pending) return;
    const handle = roomVertexRefs.current.get(`${pending.roomId}:${pending.pointIndex}`);
    if (!handle) return;
    pendingRoomVertexFocus.current = null;
    handle.focus();
  }, [floor.rooms]);

  useEffect(() => {
    if (selectedPlanElementId && !planElements.some((element) => element.id === selectedPlanElementId)) setSelectedPlanElementId(null);
  }, [planElements, selectedPlanElementId]);

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
    if (tool !== "select") setAddToolsOpen(false);
  };

  const applyFloorChange = (nextFloor: Floor) => {
    setDeletedWallUndo(null);
    setUndoMessage(null);
    onFloorChange(nextFloor);
  };

  const resetSelectedWallLengthDraft = () => {
    if (!selectedWall || metresPerPlanUnit === null) setWallLengthDraft("");
    else setWallLengthDraft(wallLengthInputValue(wallLengthPlanUnits(selectedWall) * metresPerPlanUnit));
    setWallLengthError(null);
  };

  const commitSelectedWallLength = () => {
    if (!selectedWall) return;
    const lengthMetres = Number(wallLengthDraft);
    const planLength = wallLengthPlanUnits(selectedWall);
    const nextScale = lengthMetres / planLength;
    if (!Number.isFinite(lengthMetres) || lengthMetres <= 0 || lengthMetres > 10_000 || planLength <= GEOMETRY_EPSILON
      || !Number.isFinite(nextScale) || nextScale > 10_000) {
      setWallLengthError(t("twin.wallLengthInvalid"));
      return;
    }
    setWallLengthError(null);
    setWallLengthDraft(wallLengthInputValue(lengthMetres));
    if (Math.abs((floor.metersPerPlanUnit ?? 0) - nextScale) <= GEOMETRY_EPSILON) return;
    applyFloorChange({ ...floor, metersPerPlanUnit: nextScale });
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
      isWallAttachedPlanElement(element) && element.wallId === wallId ? [{ element, index }] : []
    ));
    setDeletedWallUndo({ floorId: floor.id, wall: floor.walls[wallIndex]!, wallIndex, openings });
    setUndoMessage(t("twin.wallDeleted", { count: openings.length }));
    onFloorChange({
      ...floor,
      walls: floor.walls.filter((wall) => wall.id !== wallId),
      planElements: planElements.filter((element) => !isWallAttachedPlanElement(element) || element.wallId !== wallId),
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

  const addRoomVertex = (roomId: string, edgeIndex: number) => {
    const room = floor.rooms.find((candidate) => candidate.id === roomId);
    if (!room) return;
    const points = insertRoomVertex(room.points, edgeIndex);
    if (points === room.points || !isValidRoomPolygon(points)) {
      setPlacementError(t("twin.roomShapeInvalid"));
      return;
    }
    pendingRoomVertexFocus.current = { roomId, pointIndex: edgeIndex + 1 };
    updateRoom(roomId, { points });
    setPlacementError(null);
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
    if (sensors.some((sensor) => sensor.roomId === roomId)) return;
    applyFloorChange({ ...floor, rooms: floor.rooms.filter((room) => room.id !== roomId) });
    setSelectedRoomId(null);
  };

  const resolveElementPlacement = (kind: PlanElementKind, point: Point, width = defaultPlanElementWidth(floor, kind)) => {
    if (kind !== "door" && kind !== "window" && kind !== "fireEscape") {
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
    } else if (kind === "fireEscape") {
      const radians = rotationDegrees * Math.PI / 180;
      const projectionDirection = { x: -Math.sin(radians), y: Math.cos(radians) };
      const awayFromCenter = { x: wallPlacement.position.x - floor.width / 2, y: wallPlacement.position.y - floor.height / 2 };
      if (projectionDirection.x * awayFromCenter.x + projectionDirection.y * awayFromCenter.y < 0) rotationDegrees = (rotationDegrees + 180) % 360;
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
    if (planElementKind === "door") {
      if (!("wallId" in result.placement) || !result.placement.wallId) return false;
      element = { id, kind: "door", position: result.placement.position, rotationDegrees: result.placement.rotationDegrees, width, height: defaultPlanElementHeight(floor, "door"), wallId: result.placement.wallId, variant: "interior" };
    } else if (planElementKind === "window") {
      if (!("wallId" in result.placement) || !result.placement.wallId) return false;
      element = { id, kind: "window", position: result.placement.position, rotationDegrees: result.placement.rotationDegrees, width, height: defaultPlanElementHeight(floor, "window"), wallId: result.placement.wallId, variant: "casement" };
    } else if (planElementKind === "fireEscape") {
      if (!("wallId" in result.placement) || !result.placement.wallId) return false;
      element = {
        id, kind: "fireEscape", position: result.placement.position, rotationDegrees: result.placement.rotationDegrees,
        width, height: defaultPlanElementHeight(floor, "fireEscape"), wallId: result.placement.wallId,
        variant: "ladder", projection: defaultFireEscapeProjection(floor, width),
      };
    } else {
      element = planElementKind === "vent"
        ? { id, kind: "vent", position: result.placement.position, rotationDegrees: result.placement.rotationDegrees, width, height: defaultPlanElementHeight(floor, planElementKind), variant: "passive" }
        : { id, kind: "fireplace", position: result.placement.position, rotationDegrees: result.placement.rotationDegrees, width, height: defaultPlanElementHeight(floor, planElementKind) };
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
      if (element.kind === "fireplace" || element.kind === "fireEscape") {
        const next = applyFixturePlanElementPatch(element, patch);
        if (patch.position !== undefined) next.position = patch.position;
        if (patch.rotationDegrees !== undefined) next.rotationDegrees = patch.rotationDegrees;
        if (patch.width !== undefined) next.width = patch.width;
        if (patch.height !== undefined) {
          next.height = patch.height;
          if (next.kind === "fireEscape" && next.bottomOffsetM !== undefined) {
            next.bottomOffsetM = Math.min(next.bottomOffsetM,
              Math.max(0, (floor.ceilingHeight ?? DEFAULT_CEILING_HEIGHT_METRES) - patch.height));
          }
        }
        if (next.kind === "fireEscape" && patch.wallId !== undefined) next.wallId = patch.wallId;
        return next;
      }
      const next = applyAirflowPlanElementPatch(element, patch);
      if (patch.position !== undefined) next.position = patch.position;
      if (patch.rotationDegrees !== undefined) next.rotationDegrees = patch.rotationDegrees;
      if (patch.width !== undefined) next.width = patch.width;
      if (patch.height !== undefined) {
        next.height = patch.height;
        if (next.bottomOffsetM !== undefined) {
          next.bottomOffsetM = Math.min(next.bottomOffsetM,
            Math.max(0, (floor.ceilingHeight ?? DEFAULT_CEILING_HEIGHT_METRES) - patch.height));
        }
      }
      if (isWallOpening(next) && patch.wallId !== undefined) next.wallId = patch.wallId;
      return next;
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
    if (isWallAttachedPlanElement(element)) {
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
    if (!isWallAttachedPlanElement(element)) {
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

  const updatePlanElementHeight = (elementId: string, requestedHeight: number): boolean => {
    const element = planElements.find((candidate) => candidate.id === elementId);
    if (!element || !Number.isFinite(requestedHeight)) return false;
    updatePlanElement(element.id, { height: clampPlanElementHeight(floor, element.kind, requestedHeight) });
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

  const roomEdgeKeyDown = (event: KeyboardEvent<SVGGElement>, roomId: string, edgeIndex: number) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    addRoomVertex(roomId, edgeIndex);
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
      const step = isWallAttachedPlanElement(element) ? 180 : event.shiftKey ? -90 : 90;
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
  const airflow = useMemo(() => {
    if (!experimentalAirflowEnabled || layoutEditing) return null;
    if (experimentalAirflow) return experimentalAirflow;
    return climateSamples ? simulateFloorAirflow({
      floor,
      sensors,
      samples: climateSamples,
      freshness: spatialFreshness,
      outdoor: outdoorContext,
    }, 9) : null;
  }, [experimentalAirflowEnabled, experimentalAirflow, layoutEditing, climateSamples, floor, sensors, spatialFreshness, outdoorContext]);
  const airflowPaths = airflow?.paths ?? [];
  const activeGradientFlows = airflowPaths.length ? [] : gradientFlows;
  const hasMapInformation = clouds.length > 0 || airflowPaths.length > 0 || activeGradientFlows.length > 0
    || Boolean(experimentalSensorCoverage) || spatialLayerSnapshots.length > 0;
  const airflowSupport = airflow
    ? t(`spatial.airflow.support.${airflow.evidence.support}` as TranslationKey)
    : t("spatial.airflow.support.low");
  const airflowDriver = airflow?.evidence.windDriven
    ? t("spatial.airflow.driverBuoyancyWind")
    : t("spatial.airflow.driverBuoyancy");
  const airflowDescription = airflow ? t("spatial.airflow.description", {
    temperature: airflow.evidence.temperatureSensors,
    humidity: airflow.evidence.humiditySensors,
    tracer: airflow.evidence.tracerSensors,
    driver: airflowDriver,
  }) : "";
  const airflowAria = airflow ? t("spatial.airflow.aria", {
    support: airflowSupport,
    temperature: airflow.evidence.temperatureSensors,
    humidity: airflow.evidence.humiditySensors,
    tracer: airflow.evidence.tracerSensors,
  }) : "";
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
  const outdoorWindwardSide = outdoorContext?.windwardEdge
    ? t(`outdoor.edge.${outdoorContext.windwardEdge}` as TranslationKey)
    : null;
  const outdoorShellLabel = [
    t("outdoor.shellLabel"),
    outdoorTemperature && t("outdoor.temperatureAria", { value: outdoorTemperature }),
    outdoorHumidity && t("outdoor.humidityAria", { value: outdoorHumidity }),
    outdoorWindSpeed && t("outdoor.windSpeedAria", { value: outdoorWindSpeed }),
    outdoorWindDirection && t("outdoor.windFromAria", { value: outdoorWindDirection }),
    outdoorWindwardSide && t("outdoor.windwardAria", { edge: outdoorWindwardSide }),
  ].filter(Boolean).join(". ");
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
  const selectedElementWidthBounds = selectedPlanElement ? editablePlanElementWidthBounds(floor, selectedPlanElement) : null;
  const selectedElementHeightBounds = selectedPlanElement ? planElementHeightBounds(floor, selectedPlanElement.kind) : null;
  const selectedElementRotation = selectedPlanElement ? Math.round(normalizeDegrees(selectedPlanElement.rotationDegrees)) % 360 : 0;
  const selectedElementHasCardinalRotation = [0, 90, 180, 270].includes(selectedElementRotation);
  const wallPreview = wallStart ? (() => {
    const coordinates = {
      x1: wallStart.x * renderScale,
      y1: wallStart.y * renderScale,
      x2: keyboardPoint.x * renderScale,
      y2: keyboardPoint.y * renderScale,
    };
    const planLength = Math.hypot(keyboardPoint.x - wallStart.x, keyboardPoint.y - wallStart.y);
    const physicalLength = metresPerPlanUnit === null ? null : planLength * metresPerPlanUnit;
    const dimensionLabel = physicalLength === null
      ? t("twin.wallLengthPlanUnits", { length: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(planLength) })
      : t("twin.wallLengthMetres", { length: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(physicalLength) });
    const midpoint = { x: (coordinates.x1 + coordinates.x2) / 2, y: (coordinates.y1 + coordinates.y2) / 2 };
    const angle = Math.atan2(coordinates.y2 - coordinates.y1, coordinates.x2 - coordinates.x1) * 180 / Math.PI;
    const readableAngle = angle > 90 || angle < -90 ? angle + 180 : angle;
    return { coordinates, dimensionLabel, midpoint, physicalLength, readableAngle, start: wallStart };
  })() : null;
  const editorHint = placementError ?? undoMessage
    ?? (selectedWallId
      ? t("twin.wallSelected")
      : selectedRoom
        ? t("twin.roomSelected")
        : selectedPlanElement
          ? t(isWallAttachedPlanElement(selectedPlanElement) ? "twin.elementSelected" : "twin.fixtureSelected", {
            element: t(`planElement.${selectedPlanElement.kind}` as TranslationKey),
            degrees: selectedElementRotation,
          })
          : drawingWall
            ? wallStart ? t("twin.wallEnd") : t("twin.wallStart")
            : drawingRoom
              ? roomStart ? t("twin.roomEnd") : t("twin.roomStart")
              : placingElement
                ? t(planElementKind === "door" || planElementKind === "window" || planElementKind === "fireEscape" ? "twin.openingPlacement" : "twin.elementPlacement", { element: t(`planElement.${planElementKind}` as TranslationKey) })
                : `${t("twin.dragHint")} ${snapEnabled ? t("twin.snapOnHint") : t("twin.snapOffHint")}`);

  return (
    <div className="floor-plan-wrap">
      {editing && (
        <div className="editor-toolbar" role="toolbar" aria-label={t("twin.editTools")}>
          <div className="editor-mode-tools" role="group" aria-label={t("twin.editMode")}>
            <button type="button" className={selectingLayout ? "tool-button active" : "tool-button"} aria-pressed={selectingLayout} disabled={viewMode !== "plan"} onClick={() => chooseEditorTool("select")}>
              <MousePointer2 size={16} aria-hidden="true" />{t("twin.selectMove")}
            </button>
            <details open={addToolsOpen} className="editor-tool-disclosure editor-add-tools">
              <summary className="tool-button" onClick={(event) => { event.preventDefault(); setEditorOptionsOpen(false); setAddToolsOpen((value) => !value); }}><Plus size={16} aria-hidden="true" />{t("common.add")}</summary>
              <div hidden={!addToolsOpen} className="editor-disclosure-content" role="group" aria-label={t("common.add")}>
                <button type="button" className={drawingWall ? "tool-button active" : "tool-button"} aria-pressed={drawingWall} disabled={viewMode !== "plan"} onClick={() => chooseEditorTool("wall")}>
                  <PenLine size={16} aria-hidden="true" />{t("twin.drawWall")}
                </button>
                <button type="button" className={drawingRoom ? "tool-button active" : "tool-button"} aria-pressed={drawingRoom} disabled={viewMode !== "plan"} onClick={() => chooseEditorTool("room")}>
                  <BoxSelect size={16} aria-hidden="true" />{t("twin.addRoom")}
                </button>
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
              </div>
            </details>
          </div>
          <OpeningInventory
            floors={[floor]}
            selected={selectedPlanElementId ? { floorId: floor.id, elementId: selectedPlanElementId } : null}
            onSelect={(_floorId, elementId) => { chooseEditorTool("select"); setSelectedPlanElementId(elementId); window.setTimeout(() => planElementRefs.current.get(elementId)?.focus(), 0); }}
          />
          {deletedWallUndo && <button ref={undoButtonRef} type="button" className="tool-button" aria-keyshortcuts="Control+Z Meta+Z" onClick={undoLastDeletion}>{t("common.undo")}</button>}
          {selectedWall && (
            <div className="editor-properties wall-properties" role="group" aria-label={t("twin.wallProperties")}>
              <strong>{t("twin.wallProperties")}</strong>
              <label>
                <span>{t("twin.wallLength")}</span>
                <span className="input-suffix"><input
                  type="number"
                  min="0.01"
                  max="10000"
                  step="0.01"
                  inputMode="decimal"
                  value={wallLengthDraft}
                  placeholder={t("twin.wallLengthPlaceholder")}
                  aria-label={t("twin.wallLength")}
                  aria-invalid={wallLengthError ? true : undefined}
                  aria-describedby={wallLengthError ? wallLengthErrorId : undefined}
                  onChange={(event) => { setWallLengthDraft(event.currentTarget.value); setWallLengthError(null); }}
                  onBlur={commitSelectedWallLength}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
                    if (event.key === "Escape") { event.preventDefault(); resetSelectedWallLengthDraft(); }
                  }}
                /><span>m</span></span>
              </label>
              <span className="editor-properties-note">{t(metresPerPlanUnit === null ? "twin.wallLengthCalibrationHelp" : "twin.wallLengthScaleHelp")}</span>
              {wallLengthError && <span id={wallLengthErrorId} className="editor-field-error" role="alert">{wallLengthError}</span>}
            </div>
          )}
          {selectedRoom && (
            <div className="editor-properties" role="group" aria-label={t("twin.roomProperties")}>
              <strong>{t("twin.roomProperties")}</strong>
              <label><span>{t("twin.roomName")}</span><input ref={roomNameInputRef} required value={selectedRoom.name} aria-invalid={roomNameError ? true : undefined} aria-describedby={roomNameError ? roomNameErrorId : undefined} onFocus={() => { roomNameBeforeEdit.current = selectedRoom.name; }} onChange={(event) => { setRoomNameError(null); updateRoom(selectedRoom.id, { name: event.target.value }); }} onBlur={(event) => commitRoomName(selectedRoom.id, event.currentTarget.value)} /></label>
              <label><span>{t("twin.roomType")}</span><select value={selectedRoom.kind ?? "other"} onChange={(event) => updateRoom(selectedRoom.id, { kind: event.target.value })}>{selectedRoom.kind && !ROOM_KINDS.some((kind) => kind === selectedRoom.kind) && <option value={selectedRoom.kind}>{selectedRoom.kind}</option>}{ROOM_KINDS.map((kind) => <option key={kind} value={kind}>{roomName(kind, kind)}</option>)}</select></label>
              {roomNameError && <span id={roomNameErrorId} className="editor-field-error" role="alert">{roomNameError}</span>}
              {selectedRoomSensorCount > 0 && <span className="editor-properties-note">{t("twin.roomAssignmentsManaged", { count: selectedRoomSensorCount })}</span>}
            </div>
          )}
          {selectedPlanElement && (
            <div className="editor-properties" role="group" aria-label={t("twin.elementProperties")}>
              <strong>{t(`planElement.${selectedPlanElement.kind}` as TranslationKey)}</strong>
              {selectedElementWidthBounds && selectedElementHeightBounds && <PlanElementDimensionFields
                widthLabel={t("twin.elementWidth")}
                heightLabel={t("twin.elementHeight")}
                planUnitLabel={t("twin.planUnit")}
                metreLabel="m"
                width={selectedPlanElement.width ?? defaultPlanElementWidth(floor, selectedPlanElement.kind)}
                height={effectivePlanElementHeight(floor, selectedPlanElement)}
                widthBounds={selectedElementWidthBounds}
                heightBounds={selectedElementHeightBounds}
                onWidthChange={(value) => updatePlanElementWidth(selectedPlanElement.id, value)}
                onHeightChange={(value) => updatePlanElementHeight(selectedPlanElement.id, value)}
              />}
              {isAirflowPlanElement(selectedPlanElement) && <PlanElementAirflowFields floor={floor} element={selectedPlanElement} onChange={(patch) => updatePlanElement(selectedPlanElement.id, patch)} />}
              {(selectedPlanElement.kind === "fireplace" || selectedPlanElement.kind === "fireEscape") && <PlanElementFixtureFields floor={floor} element={selectedPlanElement} planUnitLabel={t("twin.planUnit")} onChange={(patch) => updatePlanElement(selectedPlanElement.id, patch)} />}
              {!isWallAttachedPlanElement(selectedPlanElement) && <label><span>{t("twin.elementRotation")}</span><select value={selectedElementRotation} onChange={(event) => updatePlanElement(selectedPlanElement.id, { rotationDegrees: Number(event.currentTarget.value) })}>{!selectedElementHasCardinalRotation && <option value={selectedElementRotation}>{selectedElementRotation}°</option>}{[0, 90, 180, 270].map((degrees) => <option key={degrees} value={degrees}>{degrees}°</option>)}</select></label>}
              {isWallAttachedPlanElement(selectedPlanElement)
                ? <button type="button" className="tool-button" onClick={() => updatePlanElement(selectedPlanElement.id, { rotationDegrees: normalizeDegrees(selectedPlanElement.rotationDegrees + 180) })}><RotateCw size={16} aria-hidden="true" />{t("twin.flipElement")}</button>
                : <>
                  <button type="button" className="tool-button" aria-keyshortcuts="Shift+R" onClick={() => updatePlanElement(selectedPlanElement.id, { rotationDegrees: normalizeDegrees(selectedPlanElement.rotationDegrees - 90) })}><RotateCcw size={16} aria-hidden="true" />{t("twin.rotateElementLeft")}</button>
                  <button type="button" className="tool-button" aria-keyshortcuts="R" onClick={() => updatePlanElement(selectedPlanElement.id, { rotationDegrees: normalizeDegrees(selectedPlanElement.rotationDegrees + 90) })}><RotateCw size={16} aria-hidden="true" />{t("twin.rotateElementRight")}</button>
                </>}
            </div>
          )}
          <details open={editorOptionsOpen} className="editor-tool-disclosure editor-options">
            <summary className="tool-button" onClick={(event) => { event.preventDefault(); setAddToolsOpen(false); setEditorOptionsOpen((value) => !value); }}><Grid3X3 size={16} aria-hidden="true" />{t("twin.editorOptions")}</summary>
            <div hidden={!editorOptionsOpen} className="editor-disclosure-content" role="group" aria-label={t("twin.editorOptions")}>
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
              <button type="button" className="tool-button" onClick={() => fileRef.current?.click()}><ImagePlus size={16} aria-hidden="true" />{t("twin.uploadPlan")}</button>
              <input ref={fileRef} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" onChange={uploadBackground} aria-label={t("twin.uploadPlan")} />
              {floor.backgroundImage && <button type="button" className="tool-button danger-tool" onClick={() => { const { backgroundImage: _, ...rest } = floor; applyFloorChange(rest); }}><Trash2 size={16} aria-hidden="true" />{t("twin.removePlan")}</button>}
              {selectedWallId && <button type="button" className="tool-button danger-tool" disabled={viewMode !== "plan"} onClick={() => deleteWall()}><Trash2 size={16} aria-hidden="true" />{t("twin.deleteWall")}</button>}
              {selectedRoom && <button type="button" className="tool-button danger-tool" onClick={() => deleteRoom()} disabled={selectedRoomSensorCount > 0}><Trash2 size={16} aria-hidden="true" />{t("twin.deleteRoom")}</button>}
              {selectedPlanElement && <button type="button" className="tool-button danger-tool" onClick={() => deletePlanElement()}><Trash2 size={16} aria-hidden="true" />{t("twin.deleteElement")}</button>}
            </div>
          </details>
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
            : spatialLayerSnapshots.length || experimentalSensorCoverage || experimentalAirflowEnabled
              ? t("spatial.mapDescription")
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
                {outdoorContext.windwardEdge && (
                  <path
                    d={outdoorWindwardEdgePath(outdoorContext.windwardEdge, renderWidth, renderHeight)}
                    className="outdoor-shell-windward-edge"
                    data-windward-edge={outdoorContext.windwardEdge}
                    aria-hidden="true"
                  />
                )}
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
            {showMonitoringOverlays && experimentalSensorCoverage && (
              <ExperimentalSensorCoverage2D floor={floor} assessment={experimentalSensorCoverage} scale={renderScale} />
            )}
            {layoutEditing && <rect data-testid="floor-snap-grid" x="0" y="0" width={renderWidth} height={renderHeight} rx="20" fill={`url(#${fieldId}-grid-major)`} className="plan-grid" aria-hidden="true" />}
            {floor.roof && <g className={`plan-roof-overlay ${floor.roof.style}`} role="img" aria-label={t("twin.roofOverlay", { style: t(`roofStyle.${floor.roof.style}` as TranslationKey) })}>
              <rect x={-floor.roof.overhang * renderScale} y={-floor.roof.overhang * renderScale} width={renderWidth + floor.roof.overhang * renderScale * 2} height={renderHeight + floor.roof.overhang * renderScale * 2} rx="5" className="plan-roof-eaves" />
              {floor.roof.style !== "flat" && (floor.roof.ridgeAxis === "x"
                ? <line x1="0" y1={renderHeight / 2} x2={renderWidth} y2={renderHeight / 2} className="plan-roof-ridge" />
                : <line x1={renderWidth / 2} y1="0" x2={renderWidth / 2} y2={renderHeight} className="plan-roof-ridge" />)}
              {floor.roof.style === "hip" && (floor.roof.ridgeAxis === "x" ? <>
                <line x1={-floor.roof.overhang * renderScale} y1={-floor.roof.overhang * renderScale} x2={renderHeight / 2} y2={renderHeight / 2} className="plan-roof-hip" />
                <line x1={-floor.roof.overhang * renderScale} y1={renderHeight + floor.roof.overhang * renderScale} x2={renderHeight / 2} y2={renderHeight / 2} className="plan-roof-hip" />
                <line x1={renderWidth + floor.roof.overhang * renderScale} y1={-floor.roof.overhang * renderScale} x2={renderWidth - renderHeight / 2} y2={renderHeight / 2} className="plan-roof-hip" />
                <line x1={renderWidth + floor.roof.overhang * renderScale} y1={renderHeight + floor.roof.overhang * renderScale} x2={renderWidth - renderHeight / 2} y2={renderHeight / 2} className="plan-roof-hip" />
              </> : <>
                <line x1={-floor.roof.overhang * renderScale} y1={-floor.roof.overhang * renderScale} x2={renderWidth / 2} y2={renderWidth / 2} className="plan-roof-hip" />
                <line x1={renderWidth + floor.roof.overhang * renderScale} y1={-floor.roof.overhang * renderScale} x2={renderWidth / 2} y2={renderWidth / 2} className="plan-roof-hip" />
                <line x1={-floor.roof.overhang * renderScale} y1={renderHeight + floor.roof.overhang * renderScale} x2={renderWidth / 2} y2={renderHeight - renderWidth / 2} className="plan-roof-hip" />
                <line x1={renderWidth + floor.roof.overhang * renderScale} y1={renderHeight + floor.roof.overhang * renderScale} x2={renderWidth / 2} y2={renderHeight - renderWidth / 2} className="plan-roof-hip" />
              </>)}
            </g>}
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
                const planLength = wallLengthPlanUnits(wall);
                const physicalLength = metresPerPlanUnit === null ? null : planLength * metresPerPlanUnit;
                const dimensionLabel = physicalLength === null
                  ? t("twin.wallLengthPlanUnits", { length: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(planLength) })
                  : t("twin.wallLengthMetres", { length: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(physicalLength) });
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
                const angle = Math.atan2(coordinates.y2 - coordinates.y1, coordinates.x2 - coordinates.x1) * 180 / Math.PI;
                const readableAngle = angle > 90 || angle < -90 ? angle + 180 : angle;
                const midpoint = { x: (coordinates.x1 + coordinates.x2) / 2, y: (coordinates.y1 + coordinates.y2) / 2 };
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
                    {layoutEditing && <text
                      x={midpoint.x}
                      y={midpoint.y - 17}
                      transform={`rotate(${readableAngle} ${midpoint.x} ${midpoint.y})`}
                      className={`wall-length-label ${physicalLength === null ? "uncalibrated" : "calibrated"}`}
                      textAnchor="middle"
                      dominantBaseline="central"
                      aria-hidden="true"
                    >{dimensionLabel}</text>}
                  </g>
                );
              })}
              {wallPreview && (
                <g className="wall-preview-group" aria-hidden="true">
                  <line {...wallPreview.coordinates} className="wall-preview" />
                  <text
                    x={wallPreview.midpoint.x}
                    y={wallPreview.midpoint.y - 17}
                    transform={`rotate(${wallPreview.readableAngle} ${wallPreview.midpoint.x} ${wallPreview.midpoint.y})`}
                    className={`wall-length-label wall-preview-length ${wallPreview.physicalLength === null ? "uncalibrated" : "calibrated"}`}
                    textAnchor="middle"
                    dominantBaseline="central"
                  >{wallPreview.dimensionLabel}</text>
                  <circle cx={wallPreview.start.x * renderScale} cy={wallPreview.start.y * renderScale} r="8" className="wall-start" />
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
            {showMonitoringOverlays && spatialLayerSnapshots.length > 0 && (
              <SpatialLayerOverlay2D floor={floor} snapshots={spatialLayerSnapshots} topology={spatialLayerTopology} scale={renderScale} />
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
              {observations.filter((item) => item.x != null && item.y != null).map((item) => {
                const status = item.status ?? "open";
                const label = `${t(`observations.${item.kind === "note" ? "noteKind" : item.kind}`)}: ${item.note} (${t(`observations.status.${status}`)})`;
                return (
                  <g key={item.id} transform={`translate(${item.x! * renderScale} ${item.y! * renderScale})`} className={`observation-marker ${item.severity} ${status}`} role="img" aria-label={label}>
                    <title>{label}</title>
                    <path d="M0-18C-10-18-17-11-17-2C-17 10 0 23 0 23S17 10 17-2C17-11 10-18 0-18Z" />
                    {status === "resolved" ? <path className="observation-resolution-check" d="m-6-3 4 5 8-10" /> : <circle cy="-3" r="5" />}
                  </g>
                );
              })}
            </g>}
            {selectedRoom && roomSelectionActive && (
              <g className="room-handles" role="group" aria-label={t("twin.roomCorners", { name: selectedRoom.name })}>
                {selectedRoom.points.map((point, edgeIndex) => {
                  const nextIndex = (edgeIndex + 1) % selectedRoom.points.length;
                  const next = selectedRoom.points[nextIndex]!;
                  const x = (point.x + next.x) / 2 * renderScale;
                  const y = (point.y + next.y) / 2 * renderScale;
                  const label = t("twin.addRoomCornerAria", {
                    name: selectedRoom.name,
                    start: edgeIndex + 1,
                    end: nextIndex + 1,
                  });
                  return (
                    <g
                      key={`edge-${edgeIndex}`}
                      transform={`translate(${x} ${y})`}
                      className="room-edge-handle"
                      role="button"
                      tabIndex={0}
                      aria-label={label}
                      onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
                      onClick={(event) => { event.preventDefault(); event.stopPropagation(); addRoomVertex(selectedRoom.id, edgeIndex); }}
                      onKeyDown={(event) => roomEdgeKeyDown(event, selectedRoom.id, edgeIndex)}
                    >
                      <title>{label}</title>
                      <circle r="20" className="room-edge-hit-target" />
                      <circle r="16" className="room-edge-add" />
                      <path d="M-8 0H8M0-8V8" />
                    </g>
                  );
                })}
                {selectedRoom.points.map((point, pointIndex) => (
                  <circle
                    key={pointIndex}
                    ref={(node) => {
                      const key = `${selectedRoom.id}:${pointIndex}`;
                      if (node) roomVertexRefs.current.set(key, node);
                      else roomVertexRefs.current.delete(key);
                    }}
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
              {sensors.filter((sensor) => sensor.enabled).flatMap((sensor) => {
                const measurements = sensorMeasurements[sensor.id] ?? {};
                const energyDevice = isEnergyDeviceSensor(sensor, measurements);
                if (energyDevice && !energyDevicesVisible && !editing) return [];
                const energyStats = energyDeviceMapStats(measurements, [definition], units);
                const sample = energyDevice ? energyStats.power ?? energyStats.energy ?? undefined : samples[sensor.id];
                const quality = !sample
                  ? null
                  : isSpatialSampleFresh(sample, spatialFreshness)
                    ? sample.quality
                    : "stale";
                const value = energyDevice || quality === "stale" ? undefined : measurementValue(sample, definition.id);
                const qualityLabel = quality === "stale"
                  ? t("building.statusStale")
                  : quality === "estimated"
                    ? t("building.statusEstimated")
                    : null;
                const selected = sensor.id === selectedSensorId;
                const markerValue = energyDevice
                  ? energyStats.short ?? t("twin.noEnergyStats")
                  : value == null ? t("common.noData") : formatMeasurement(value, definition, units);
                return (
                  <g
                    key={sensor.id}
                    transform={`translate(${sensor.x * renderScale} ${sensor.y * renderScale})`}
                    className={`sensor-marker ${energyDevice ? "energy-device" : ""} ${selected ? "selected" : ""} ${layoutEditing && selectingLayout ? "movable" : ""} ${quality ?? ""}`}
                    data-map-layer={energyDevice ? "energy-devices" : "sensors"}
                    role="button"
                    tabIndex={0}
                    aria-label={`${sensor.name}, ${energyDevice ? t("twin.energyDevice") : metricLabel}, ${markerValue}${qualityLabel ? `, ${qualityLabel}` : ""}`}
                    aria-pressed={selected}
                    onPointerDown={(event) => startSensorDrag(event, sensor.id)}
                    onPointerMove={(event) => moveSensor(event, sensor.id)}
                    onPointerUp={() => { dragging.current = null; }}
                    onPointerCancel={() => { dragging.current = null; }}
                    onLostPointerCapture={() => { dragging.current = null; }}
                    onKeyDown={(event) => sensorKeyDown(event, sensor)}
                  >
                    <circle r="56" className="sensor-hit-target" />
                    <circle r="28" className="sensor-halo" />
                    <circle r="21" className="sensor-core" filter={`url(#${fieldId}-sensor-shadow)`} />
                    {energyDevice
                      ? <path d="M3-16L-9 2H-2L-6 16L10-6H3Z" className="sensor-energy-glyph" aria-hidden="true" />
                      : <><circle r="4" cy="-6" className="sensor-dot" /><text y="9" textAnchor="middle" className="sensor-value">{value == null ? "—" : toDisplayValue(value, definition, units).toFixed(definition.precision)}</text></>}
                    {energyDevice && <text y="43" textAnchor="middle" className="sensor-energy-stats">{energyStats.short ?? "—"}</text>}
                    <text y={energyDevice ? 58 : 45} textAnchor="middle" className="sensor-label">{sensor.name}</text>
                  </g>
                );
              })}
            </g>
            <g className="plan-elements">
              {chimneyPenetrations.map(({ sourceFloorId, element }) => {
                const dimensions = fireplaceChimneyDimensions(floor, element);
                const width = Math.max(28, dimensions.width * renderScale);
                const depth = Math.max(20, dimensions.depth * renderScale);
                return <g key={`${sourceFloorId}:${element.id}`} transform={`translate(${element.position.x * renderScale} ${element.position.y * renderScale}) rotate(${element.rotationDegrees})`} className="chimney-penetration" role="img" aria-label={t("twin.chimneyPenetration")}>
                  <rect x={-width / 2} y={-depth / 2} width={width} height={depth} rx="2" />
                  <line x1={-width / 2} y1={-depth / 2} x2={width / 2} y2={depth / 2} />
                  <line x1={width / 2} y1={-depth / 2} x2={-width / 2} y2={depth / 2} />
                </g>;
              })}
              {planElements.map((element, index) => {
                const selected = element.id === selectedPlanElementId;
                const openingState = isAirflowPlanElement(element) ? configuredPlanElementOpeningState(element) : null;
                const symbolWidth = Math.max(28, (element.width ?? defaultPlanElementWidth(floor, element.kind)) * renderScale);
                const baseLabel = t("twin.elementAria", {
                  element: t(`planElement.${element.kind}` as TranslationKey),
                  number: index + 1,
                });
                const label = openingState ? `${baseLabel}, ${t(`opening.state.${openingState.state}` as TranslationKey)}` : baseLabel;
                const glyphHeight = element.kind === "door"
                  ? symbolWidth
                  : element.kind === "window"
                    ? 20
                    : element.kind === "fireEscape"
                      ? Math.max(24, (element.projection ?? defaultFireEscapeProjection(floor, element.width ?? defaultPlanElementWidth(floor, "fireEscape"))) * renderScale)
                      : Math.max(18, Math.min(symbolWidth * (element.kind === "vent" ? .45 : .55), 42));
                const glyphTop = element.kind === "door" ? -symbolWidth : element.kind === "fireEscape" ? 0 : -glyphHeight / 2;
                return (
                  <g
                    key={element.id}
                    ref={(node) => { if (node) planElementRefs.current.set(element.id, node); else planElementRefs.current.delete(element.id); }}
                    transform={`translate(${element.position.x * renderScale} ${element.position.y * renderScale}) rotate(${element.rotationDegrees})`}
                    className={`plan-element ${element.kind} ${openingState ? `opening-${openingState.state}` : ""} ${selected ? "selected" : ""}`}
                    data-opening-state={openingState?.state}
                    role={planElementSelectionActive ? "button" : "img"}
                    tabIndex={planElementSelectionActive ? 0 : undefined}
                    aria-label={label}
                    aria-pressed={planElementSelectionActive ? selected : undefined}
                    aria-keyshortcuts={planElementSelectionActive ? isWallAttachedPlanElement(element) ? "R Delete Backspace" : "R Shift+R Delete Backspace" : undefined}
                    onPointerDown={planElementSelectionActive ? (event) => planElementPointerDown(event, element.id) : undefined}
                    onPointerMove={planElementSelectionActive ? (event) => planElementPointerMove(event, element.id) : undefined}
                    onPointerUp={() => { draggingElement.current = null; }}
                    onPointerCancel={() => { draggingElement.current = null; }}
                    onLostPointerCapture={() => { draggingElement.current = null; }}
                    onKeyDown={planElementSelectionActive ? (event) => planElementKeyDown(event, element) : undefined}
                  >
                    <rect x={-symbolWidth / 2 - 12} y={glyphTop - 12} width={symbolWidth + 24} height={glyphHeight + 24} className="plan-element-hit-target" />
                    {selected && <rect x={-symbolWidth / 2 - 9} y={glyphTop - 9} width={symbolWidth + 18} height={glyphHeight + 18} rx="8" className="plan-element-selection" />}
                    <PlanElementGlyph kind={element.kind} width={symbolWidth} state={openingState?.state} projection={element.kind === "fireEscape" ? (element.projection ?? defaultFireEscapeProjection(floor, element.width ?? defaultPlanElementWidth(floor, "fireEscape"))) * renderScale : undefined} />
                  </g>
                );
              })}
              {placingElement && elementPreviewPlacement && (
                <g
                  transform={`translate(${elementPreviewPlacement.position.x * renderScale} ${elementPreviewPlacement.position.y * renderScale}) rotate(${elementPreviewPlacement.rotationDegrees})`}
                  className="plan-element preview"
                  aria-hidden="true"
                >
                  <PlanElementGlyph kind={planElementKind} width={Math.max(28, defaultPlanElementWidth(floor, planElementKind) * renderScale)} state={planElementKind === "vent" ? "open" : planElementKind === "door" || planElementKind === "window" ? "closed" : undefined} />
                </g>
              )}
            </g>
          </g>
        </svg>
        {showMonitoringOverlays && outdoor && <OutdoorConditionsBadge outdoor={outdoor} units={units} showCompass />}
        {showMonitoringOverlays && hasMapInformation && <MapInformationToggle
          controls={mapInformationId}
          expanded={mapInformationExpanded}
          onExpandedChange={setMapInformationExpanded}
        />}
        {showMonitoringOverlays && hasMapInformation && mapInformationExpanded && <div id={mapInformationId} className="map-information-content">
          {clouds.length > 0 && <div className="heat-legend" aria-label={`${t("twin.estimatedField", { metric: metricLabel })}: ${legendMin} – ${legendMax}`}>
            <strong className="heat-legend-title">{t("twin.estimatedField", { metric: metricLabel })}</strong>
            <span>{t("twin.heatLegendLow")}</span>
            <span className="heat-gradient" style={{ background: measurementGradient(definition) }} aria-hidden="true" />
            <span>{t("twin.heatLegendHigh")}</span>
            <strong>{legendMin}</strong><strong>{legendMax}</strong>
          </div>}
          {(airflowPaths.length > 0 || activeGradientFlows.length > 0 || experimentalSensorCoverage || spatialLayerSnapshots.length > 0) && <div className="map-layer-legends">
            {airflowPaths.length > 0 && <div className="flow-legend simulated-flow-legend experimental-layer-legend"><span className="flow-sample simulated" aria-hidden="true">↝</span><span><strong>{t("spatial.airflow.title")}</strong><small>{airflowDescription}</small></span></div>}
            {airflowPaths.length === 0 && activeGradientFlows.length > 0 && <div className="flow-legend"><span className="flow-sample" aria-hidden="true">→</span><span><strong>{t("twin.flow")}</strong><small>{t("twin.flowDescription")}</small></span></div>}
            {experimentalSensorCoverage && <div className="flow-legend coverage-layer-legend"><span className="flow-sample coverage" aria-hidden="true">◎</span><span><strong>{t("spatial.coverage.title")}</strong><small>{t("spatial.coverage.legend", { support: Math.round(experimentalSensorCoverage.coverageScore * 100) })}</small></span></div>}
            {spatialLayerSnapshots.length > 0 && <div className="flow-legend spatial-layer-legend"><span className="flow-sample" aria-hidden="true">⇢</span><span><strong>{t("spatial.title")}</strong><small>{t("spatial.inferenceDisclaimer")}</small></span></div>}
          </div>}
        </div>}
      </div>
      <span id={mapHelpId} className="sr-only">{t("twin.keyboardPlacement")}</span>
    </div>
  );
}
