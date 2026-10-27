import { useMemo, type ChangeEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { type PlanElement, type Sensor } from "@climate-twin/contracts";
import { clamp } from "../../domain";
import { formatMeasurement } from "../../measurements";
import { simulateFloorAirflow } from "../../airflowSimulation";
import { normalizeDegrees } from "../../outdoorContext";
import {
  isWallAttachedPlanElement,
} from "../../planElementGeometry";
import { isValidRoomPolygon, snapPointToGrid } from "./support";
import { useFloorPlanPart03 } from "./part-03";
export function useFloorPlanPart04(context: ReturnType<typeof useFloorPlanPart03>) {
  const { floor, sensors, climateSamples, definition, units, viewMode, editing, onSensorSelect, onSensorMove, outdoor, experimentalAirflowEnabled, experimentalAirflow, t, houseOpeningStateObservations, dragging, draggingElement, draggingRoomVertex, setSelectedWallId, setSelectedRoomId, setSelectedPlanElementId, setPlacementError, snapEnabled, setPlacementAnnouncement, setUploadError, placementCoordinateScale, placementCoordinateUnit, gridSize, spatialFreshness, visualDomain, gradientFlows, layoutEditing, selectingLayout, wallSelectionActive, roomSelectionActive, planElementSelectionActive, pointFromEvent, placementPoint, clearLayoutSelection, applyFloorChange, deleteWall, updateRoom, addRoomVertex, deleteRoom, updatePlanElement, movePlanElement, deletePlanElement } = context;
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
  const outdoorContext = outdoor?.context ?? null;
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
