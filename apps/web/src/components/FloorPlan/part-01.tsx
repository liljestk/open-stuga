import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { BoxSelect, Grid3X3, ImagePlus, MapPinPlus, MousePointer2, PenLine, Plus, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import { floorMetersPerPlanUnit, isAirflowPlanElement, wallLengthPlanUnits, type ConfiguredOpeningState, type Floor, type House, type ManualObservation, type MeasurementDefinition, type MeasurementSample, type OpeningStateObservation, type PlanElement, type PlanElementKind, type Point, type Room, type Sensor, type UnitSystem, type Wall } from "@climate-twin/contracts";
import { clamp, round, type ViewMode } from "../../domain";
import { useI18n, type TranslationKey } from "../../i18n";
import { formatMeasurement, formatMeasurementDelta, measurementGradient, measurementLabel, measurementValue, toDisplayValue, type LatestMeasurements } from "../../measurements";
import { energyDeviceMapStats, isEnergyDeviceSensor } from "../../energyDeviceMap";
import { createCloudLobes, estimateFieldFlows, heatColor, interpolateHeat } from "../../spatialField";
import { simulateFloorAirflow, type AirflowPoint2D, type ClimateSampleMatrix, type FloorAirflowEstimate } from "../../airflowSimulation";
import { configuredSpatialMaxSampleAgeMs, isSpatialSampleFresh } from "../../spatialFreshness";
import { cardinalDirection, normalizeDegrees, type PlanEdge } from "../../outdoorContext";
import {
  formatOutdoorHumidity,
  formatOutdoorTemperature,
  formatOutdoorWindSpeed,
  OutdoorConditionsBadge,
  type OutdoorVisualizationState,
} from "../OutdoorConditionsBadge";
import { PlanElementDimensionFields } from "../PlanElementDimensionFields";
import { applyAirflowPlanElementPatch, PlanElementAirflowFields, type AirflowPlanElementPatch } from "../PlanElementAirflowFields";
import { applyFixturePlanElementPatch, PlanElementFixtureFields, type FixturePlanElementPatch } from "../PlanElementFixtureFields";
import { OpeningInventory } from "../OpeningInventory";
import { SpatialLayerOverlay2D } from "../SpatialLayerOverlay2D";
import type { SpatialLayerSnapshot, SpatialTopology } from "../../spatialLayers";
import type { SensorCoverageAssessment } from "../../experimentalSpatialLayers";
import { ExperimentalSensorCoverage2D } from "../ExperimentalSensorCoverage";
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
} from "../../planElementGeometry";
import { chimneyPenetrationsForFloor, fireplaceChimneyDimensions } from "../../architecturalGeometry";
import { MapInformationToggle, useMapInformationVisibility } from "../MapInformationToggle";
import { effectiveOpeningState, openingStateCanChange, openingStateKey, openingStateObservationsForHouse } from "../../openingState";
import { GEOMETRY_EPSILON, GRID_DENSITY_MULTIPLIER, OUTDOOR_SHELL_CHIP_GAP, OUTDOOR_SHELL_CHIP_HEIGHT, OUTDOOR_SHELL_CHIP_RIGHT_INSET, OUTDOOR_SHELL_CHIP_WIDTH, OUTDOOR_SHELL_OFFSET, PLAN_ELEMENT_KINDS, PLAN_VIEWPORT_MARGIN, PlanElementGlyph, ROOM_KINDS, defaultFloorGridSize, floorGridSize, floorRenderScale, insertRoomVertex, isValidRoomPolygon, nearestWallOpeningPlacement, nearestWallPlacement, orientation, outdoorWindwardEdgePath, pointOnSegment, pointsEqual, roomRectanglePoints, segmentsIntersect, smoothAirflowPath, snapPointToGrid, wallLengthInputValue } from "./support";
import type { DeletedWallUndo, EditorTool, FloorGridDensity, FloorPlanProps, PlanElementPatch, WallOpeningPlacementResult, WallPlacement } from "./support";
export function useFloorPlanPart01(context: { floor: FloorPlanProps["floor"]; house: FloorPlanProps["house"]; sensors: FloorPlanProps["sensors"]; samples: FloorPlanProps["samples"]; climateSamples: FloorPlanProps["climateSamples"]; observations: FloorPlanProps["observations"]; definition: FloorPlanProps["definition"]; colorDomain: FloorPlanProps["colorDomain"]; units: FloorPlanProps["units"]; viewMode: FloorPlanProps["viewMode"]; selectedSensorId: FloorPlanProps["selectedSensorId"]; editing: FloorPlanProps["editing"]; observationPlacement: FloorPlanProps["observationPlacement"]; onSensorSelect: FloorPlanProps["onSensorSelect"]; onSensorMove: FloorPlanProps["onSensorMove"]; onFloorChange: FloorPlanProps["onFloorChange"]; onObservationPoint: FloorPlanProps["onObservationPoint"]; onCancelObservationPlacement: FloorPlanProps["onCancelObservationPlacement"]; referenceTimeMs: FloorPlanProps["referenceTimeMs"]; maxSampleAgeMs: FloorPlanProps["maxSampleAgeMs"]; outdoor: FloorPlanProps["outdoor"]; spatialLayerSnapshots: Exclude<FloorPlanProps["spatialLayerSnapshots"], undefined>; spatialLayerTopology: Exclude<FloorPlanProps["spatialLayerTopology"], undefined>; experimentalAirflowEnabled: Exclude<FloorPlanProps["experimentalAirflowEnabled"], undefined>; experimentalAirflow: Exclude<FloorPlanProps["experimentalAirflow"], undefined>; experimentalSensorCoverage: Exclude<FloorPlanProps["experimentalSensorCoverage"], undefined>; experimentalOutdoorInfluence: Exclude<FloorPlanProps["experimentalOutdoorInfluence"], undefined>; openingStateObservations: Exclude<FloorPlanProps["openingStateObservations"], undefined>; pendingOpeningStateKeys: Exclude<FloorPlanProps["pendingOpeningStateKeys"], undefined>; onOpeningStateChange: FloorPlanProps["onOpeningStateChange"]; sensorMeasurements: Exclude<FloorPlanProps["sensorMeasurements"], undefined>; climateSensorMarkersVisible: Exclude<FloorPlanProps["climateSensorMarkersVisible"], undefined>; energyDevicesVisible: Exclude<FloorPlanProps["energyDevicesVisible"], undefined>; allowBackgroundImageEditing: Exclude<FloorPlanProps["allowBackgroundImageEditing"], undefined> }) {
  const { floor, house, sensors, samples, climateSamples, observations, definition, colorDomain, units, viewMode, selectedSensorId, editing, observationPlacement, onSensorSelect, onSensorMove, onFloorChange, onObservationPoint, onCancelObservationPlacement, referenceTimeMs, maxSampleAgeMs, outdoor, spatialLayerSnapshots, spatialLayerTopology, experimentalAirflowEnabled, experimentalAirflow, experimentalSensorCoverage, experimentalOutdoorInfluence, openingStateObservations, pendingOpeningStateKeys, onOpeningStateChange, sensorMeasurements, climateSensorMarkersVisible, energyDevicesVisible, allowBackgroundImageEditing } = context;
  const { locale, t } = useI18n();
  const houseOpeningStateObservations = useMemo(
      () => openingStateObservationsForHouse(house?.id, openingStateObservations),
      [house?.id, openingStateObservations],
    );
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
  const [placementAnnouncement, setPlacementAnnouncement] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const { expanded: mapInformationExpanded, setMapInformationExpanded } = useMapInformationVisibility();
  const renderScale = floorRenderScale(floor.width);
  const metresPerPlanUnit = floorMetersPerPlanUnit(floor, house);
  const placementCoordinateScale = metresPerPlanUnit ?? 1;
  const placementCoordinateUnit = metresPerPlanUnit === null ? "" : " m";
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
  return Object.assign(context, { locale, t, houseOpeningStateObservations, metricLabel, svgRef, fileRef, roomNameInputRef, undoButtonRef, roomNameBeforeEdit, dragging, draggingElement, draggingRoomVertex, roomVertexRefs, pendingRoomVertexFocus, planElementRefs, mapHelpId, mapInformationId, roomNameErrorId, wallLengthErrorId, fieldId, editorTool, setEditorTool, wallStart, setWallStart, roomStart, setRoomStart, selectedWallId, setSelectedWallId, wallLengthDraft, setWallLengthDraft, wallLengthError, setWallLengthError, selectedRoomId, setSelectedRoomId, selectedPlanElementId, setSelectedPlanElementId, planElementKind, setPlanElementKind, placementError, setPlacementError, roomNameError, setRoomNameError, deletedWallUndo, setDeletedWallUndo, undoMessage, setUndoMessage, snapEnabled, setSnapEnabled, gridDensity, setGridDensity, addToolsOpen, setAddToolsOpen, editorOptionsOpen, setEditorOptionsOpen, keyboardPoint, setKeyboardPoint, placementAnnouncement, setPlacementAnnouncement, uploadError, setUploadError, reducedMotion, setReducedMotion, mapInformationExpanded, setMapInformationExpanded, renderScale, metresPerPlanUnit, placementCoordinateScale, placementCoordinateUnit, renderWidth, renderHeight, gridSize, renderedGridSize, viewportMargin, resolvedReferenceTimeMs, spatialFreshness, renderSensors, heat, visualDomain, clouds, gradientFlows, transform, layoutEditing, drawingWall, drawingRoom, placingElement, selectingLayout, keyboardPlacementActive, wallSelectionActive, roomSelectionActive, planElementSelectionActive, showMonitoringOverlays, planElements, chimneyPenetrations, selectedWall, selectedRoom, selectedPlanElement, selectedRoomSensorCount });
}
