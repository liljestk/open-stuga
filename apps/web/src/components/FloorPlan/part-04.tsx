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
import { useFloorPlanPart03 } from "./part-03";
export function useFloorPlanPart04(context: ReturnType<typeof useFloorPlanPart03>) {
  const { floor, house, sensors, samples, climateSamples, observations, definition, colorDomain, units, viewMode, selectedSensorId, editing, observationPlacement, onSensorSelect, onSensorMove, onFloorChange, onObservationPoint, onCancelObservationPlacement, referenceTimeMs, maxSampleAgeMs, outdoor, spatialLayerSnapshots, spatialLayerTopology, experimentalAirflowEnabled, experimentalAirflow, experimentalSensorCoverage, openingStateObservations, pendingOpeningStateKeys, onOpeningStateChange, sensorMeasurements, energyDevicesVisible, allowBackgroundImageEditing, locale, t, houseOpeningStateObservations, metricLabel, svgRef, fileRef, roomNameInputRef, undoButtonRef, roomNameBeforeEdit, dragging, draggingElement, draggingRoomVertex, roomVertexRefs, pendingRoomVertexFocus, planElementRefs, mapHelpId, mapInformationId, roomNameErrorId, wallLengthErrorId, fieldId, editorTool, setEditorTool, wallStart, setWallStart, roomStart, setRoomStart, selectedWallId, setSelectedWallId, wallLengthDraft, setWallLengthDraft, wallLengthError, setWallLengthError, selectedRoomId, setSelectedRoomId, selectedPlanElementId, setSelectedPlanElementId, planElementKind, setPlanElementKind, placementError, setPlacementError, roomNameError, setRoomNameError, deletedWallUndo, setDeletedWallUndo, undoMessage, setUndoMessage, snapEnabled, setSnapEnabled, gridDensity, setGridDensity, addToolsOpen, setAddToolsOpen, editorOptionsOpen, setEditorOptionsOpen, keyboardPoint, setKeyboardPoint, placementAnnouncement, setPlacementAnnouncement, uploadError, setUploadError, reducedMotion, setReducedMotion, mapInformationExpanded, setMapInformationExpanded, renderScale, metresPerPlanUnit, placementCoordinateScale, placementCoordinateUnit, renderWidth, renderHeight, gridSize, renderedGridSize, viewportMargin, resolvedReferenceTimeMs, spatialFreshness, renderSensors, heat, visualDomain, clouds, gradientFlows, transform, layoutEditing, drawingWall, drawingRoom, placingElement, selectingLayout, keyboardPlacementActive, wallSelectionActive, roomSelectionActive, planElementSelectionActive, showMonitoringOverlays, planElements, chimneyPenetrations, selectedWall, selectedRoom, selectedPlanElement, selectedRoomSensorCount, roomName, pointFromEvent, placementPoint, clearLayoutSelection, chooseEditorTool, applyFloorChange, resetSelectedWallLengthDraft, commitSelectedWallLength, nextUnusedRoomName, addWall, deleteWall, undoLastDeletion, addRoom, updateRoom, addRoomVertex, commitRoomName, deleteRoom, resolveElementPlacement, placementFailureMessage, addPlanElement, updatePlanElement, movePlanElement, updatePlanElementWidth, updatePlanElementHeight, deletePlanElement, mapPointerDown, mapPointerMove, mapKeyDown } = context;
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
      const next = useGrid ? snapPointToGrid(point, floor, gridSize) : point;
      onSensorMove(sensor.id, next);
      setPlacementAnnouncement(`${sensor.name}, ${floor.name}: x ${(next.x * placementCoordinateScale).toFixed(1)}${placementCoordinateUnit}, y ${(next.y * placementCoordinateScale).toFixed(1)}${placementCoordinateUnit}`);
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
        openingStateObservations: houseOpeningStateObservations,
      }, 9) : null;
    }, [experimentalAirflowEnabled, experimentalAirflow, layoutEditing, climateSamples, floor, sensors, spatialFreshness, outdoorContext, houseOpeningStateObservations]);
  const airflowPaths = airflow?.paths ?? [];
  const activeGradientFlows = airflowPaths.length ? [] : gradientFlows;
  return Object.assign(context, { wallPointerDown, wallKeyDown, roomPointerDown, roomKeyDown, roomVertexPointerDown, roomEdgeKeyDown, moveRoomVertex, roomVertexKeyDown, planElementPointerDown, planElementPointerMove, planElementKeyDown, startSensorDrag, moveSensor, sensorKeyDown, uploadBackground, legendMin, legendMax, outdoorContext, airflow, airflowPaths, activeGradientFlows });
}