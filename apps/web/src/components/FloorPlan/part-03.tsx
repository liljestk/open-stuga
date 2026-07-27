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
import { useFloorPlanPart02 } from "./part-02";
export function useFloorPlanPart03(context: ReturnType<typeof useFloorPlanPart02>) {
  const { floor, house, sensors, samples, climateSamples, observations, definition, colorDomain, units, viewMode, selectedSensorId, editing, observationPlacement, onSensorSelect, onSensorMove, onFloorChange, onObservationPoint, onCancelObservationPlacement, referenceTimeMs, maxSampleAgeMs, outdoor, spatialLayerSnapshots, spatialLayerTopology, experimentalAirflowEnabled, experimentalAirflow, experimentalSensorCoverage, openingStateObservations, pendingOpeningStateKeys, onOpeningStateChange, sensorMeasurements, energyDevicesVisible, allowBackgroundImageEditing, locale, t, houseOpeningStateObservations, metricLabel, svgRef, fileRef, roomNameInputRef, undoButtonRef, roomNameBeforeEdit, dragging, draggingElement, draggingRoomVertex, roomVertexRefs, pendingRoomVertexFocus, planElementRefs, mapHelpId, mapInformationId, roomNameErrorId, wallLengthErrorId, fieldId, editorTool, setEditorTool, wallStart, setWallStart, roomStart, setRoomStart, selectedWallId, setSelectedWallId, wallLengthDraft, setWallLengthDraft, wallLengthError, setWallLengthError, selectedRoomId, setSelectedRoomId, selectedPlanElementId, setSelectedPlanElementId, planElementKind, setPlanElementKind, placementError, setPlacementError, roomNameError, setRoomNameError, deletedWallUndo, setDeletedWallUndo, undoMessage, setUndoMessage, snapEnabled, setSnapEnabled, gridDensity, setGridDensity, addToolsOpen, setAddToolsOpen, editorOptionsOpen, setEditorOptionsOpen, keyboardPoint, setKeyboardPoint, placementAnnouncement, setPlacementAnnouncement, uploadError, setUploadError, reducedMotion, setReducedMotion, mapInformationExpanded, setMapInformationExpanded, renderScale, metresPerPlanUnit, placementCoordinateScale, placementCoordinateUnit, renderWidth, renderHeight, gridSize, renderedGridSize, viewportMargin, resolvedReferenceTimeMs, spatialFreshness, renderSensors, heat, visualDomain, clouds, gradientFlows, transform, layoutEditing, drawingWall, drawingRoom, placingElement, selectingLayout, keyboardPlacementActive, wallSelectionActive, roomSelectionActive, planElementSelectionActive, showMonitoringOverlays, planElements, chimneyPenetrations, selectedWall, selectedRoom, selectedPlanElement, selectedRoomSensorCount, roomName, pointFromEvent, placementPoint, clearLayoutSelection, chooseEditorTool, applyFloorChange, resetSelectedWallLengthDraft, commitSelectedWallLength, nextUnusedRoomName, addWall, deleteWall, undoLastDeletion, addRoom, updateRoom, addRoomVertex, commitRoomName } = context;
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
        setPlacementAnnouncement("");
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
          const next = useGrid ? snapPointToGrid(point, floor, gridSize) : point;
          setPlacementAnnouncement(`${floor.name}: x ${(next.x * placementCoordinateScale).toFixed(1)}${placementCoordinateUnit}, y ${(next.y * placementCoordinateScale).toFixed(1)}${placementCoordinateUnit}`);
          return next;
        });
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      setPlacementAnnouncement("");
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
  return Object.assign(context, { deleteRoom, resolveElementPlacement, placementFailureMessage, addPlanElement, updatePlanElement, movePlanElement, updatePlanElementWidth, updatePlanElementHeight, deletePlanElement, mapPointerDown, mapPointerMove, mapKeyDown });
}