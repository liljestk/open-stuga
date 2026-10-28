import {
  useEffect,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from "react";
import { type PlanElement, type Sensor } from "@climate-twin/contracts";
import { createClientUuid } from "../../clientUuid";
import {
  clampCameraOrbit,
  type CameraOrbit,
} from "../../spatial/volume";
import { applyAirflowPlanElementPatch } from "../PlanElementAirflowFields";
import { applyFixturePlanElementPatch } from "../PlanElementFixtureFields";
import {
  clampPlanElementHeight,
  clampPlanElementWidth,
  DEFAULT_CEILING_HEIGHT_METRES,
  defaultPlanElementHeight,
  defaultPlanElementWidth,
  defaultFireEscapeProjection,
  editablePlanElementWidthBounds,
  planElementHeightBounds,
  planElementWidthBounds,
} from "../../planElementGeometry";
import { projectedCloud } from "./sceneGeometry";
import type { SelectedElementPatch } from "./sceneGeometry";
import { useBuildingScenePart01 } from "./part-01";
export function useBuildingScenePart02(context: ReturnType<typeof useBuildingScenePart01>) {
  const { house, sensors, activeFloorId, editing, onFloorSelect, onSensorSelect, onFloorChange, t, camera, setCamera, selectedElementKey, setSelectedElementKey, addableOpeningKind, setOpeningEditorMessage, dragRef, suppressClickRef, floorModels, clouds, project } = context;
  const projectedClouds = (editing ? [] : clouds).map((cloud) => projectedCloud(cloud, project))
      .sort((a, b) => a.center.depth - b.center.depth);
  const renderedSensors = sensors.filter((sensor) => sensor.enabled).flatMap((sensor) => {
      const model = floorModels.find((item) => item.floor.id === sensor.floorId);
      if (!model) return [];
      const position = project(sensor);
      const anchor = project({ x: sensor.x, y: sensor.y, z: model.floor.elevation + .05 });
      return [{ sensor, model, position, anchor }];
    }).sort((a, b) => a.position.depth - b.position.depth);
  const orderedFloors = floorModels.map((model) => ({
      ...model,
      depth: project({ x: model.floor.width / 2, y: model.floor.height / 2, z: model.floor.elevation }).depth,
    })).sort((a, b) => a.depth - b.depth);
  const selectedElementFloor = selectedElementKey
      ? house.floors.find((floor) => floor.id === selectedElementKey.floorId) ?? null
      : null;
  const selectedElement = selectedElementFloor
      ? (selectedElementFloor.planElements ?? []).find((element) => element.id === selectedElementKey?.elementId) ?? null
      : null;
  useEffect(() => {
      if (!editing) setSelectedElementKey(null);
    }, [editing]);
  useEffect(() => {
      if (selectedElementKey && !selectedElement) setSelectedElementKey(null);
    }, [selectedElementKey, selectedElement]);
  const changeCamera = (patch: Partial<CameraOrbit>) => setCamera((current) => clampCameraOrbit({ ...current, ...patch }));
  const rotateCamera = (yaw: number, pitch: number) => setCamera((current) => clampCameraOrbit({
      ...current, yaw: current.yaw + yaw, pitch: current.pitch + pitch,
    }));
  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
      if (event.button !== 0) return;
      dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, camera, moved: false };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.hypot(dx, dy) > 4) drag.moved = true;
      suppressClickRef.current = drag.moved;
      setCamera(clampCameraOrbit({
        ...drag.camera,
        yaw: drag.camera.yaw - dx * .008,
        pitch: drag.camera.pitch - dy * .006,
      }));
    };
  const endPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
      if (dragRef.current?.pointerId !== event.pointerId) return;
      const moved = dragRef.current.moved;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      dragRef.current = null;
      if (moved) window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    };
  const onWheel = (event: WheelEvent<SVGSVGElement>) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      changeCamera({ zoom: camera.zoom * Math.exp(-event.deltaY * .0012) });
    };
  const activateFloor = (floorId: string) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      onFloorSelect(floorId);
    };
  const floorKeyDown = (event: KeyboardEvent<SVGGElement>, floorId: string) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onFloorSelect(floorId);
    };
  const selectSensor = (event: MouseEvent<SVGGElement> | KeyboardEvent<SVGGElement>, sensor: Sensor) => {
      event.stopPropagation();
      if ("key" in event && event.key !== "Enter" && event.key !== " ") return;
      if (!("key" in event) && suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      event.preventDefault();
      onFloorSelect(sensor.floorId);
      onSensorSelect(sensor.id, sensor.floorId);
    };
  const selectArchitecturalElement = (
      event: MouseEvent<SVGGElement> | KeyboardEvent<SVGGElement> | ReactPointerEvent<SVGGElement>,
      floorId: string,
      elementId: string,
    ) => {
      if (!editing) return;
      event.stopPropagation();
      if (event.type === "keydown" && "key" in event && event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.currentTarget.focus();
      onFloorSelect(floorId);
      setSelectedElementKey({ floorId, elementId });
    };
  const updateSelectedElement = (patch: SelectedElementPatch): boolean => {
      if (!selectedElementFloor || !selectedElement || !onFloorChange) return false;
      onFloorChange({
        ...selectedElementFloor,
        planElements: (selectedElementFloor.planElements ?? []).map((element): PlanElement => {
          if (element.id !== selectedElement.id) return element;
          if (element.kind === "fireplace" || element.kind === "fireEscape") {
            const next = applyFixturePlanElementPatch(element, patch);
            if (patch.width !== undefined) next.width = patch.width;
            if (patch.height !== undefined) {
              next.height = patch.height;
              if (next.kind === "fireEscape" && next.bottomOffsetM !== undefined) {
                next.bottomOffsetM = Math.min(next.bottomOffsetM,
                  Math.max(0, (selectedElementFloor.ceilingHeight ?? DEFAULT_CEILING_HEIGHT_METRES) - patch.height));
              }
            }
            return next;
          }
          const next = applyAirflowPlanElementPatch(element, patch);
          if (patch.width !== undefined) next.width = patch.width;
          if (patch.height !== undefined) {
            next.height = patch.height;
            if (next.bottomOffsetM !== undefined) {
              next.bottomOffsetM = Math.min(next.bottomOffsetM,
                Math.max(0, (selectedElementFloor.ceilingHeight ?? DEFAULT_CEILING_HEIGHT_METRES) - patch.height));
            }
          }
          return next;
        }),
      });
      return true;
    };
  const selectedWidthBounds = selectedElementFloor && selectedElement
      ? editablePlanElementWidthBounds(selectedElementFloor, selectedElement)
      : null;
  const selectedHeightBounds = selectedElementFloor && selectedElement
      ? planElementHeightBounds(selectedElementFloor, selectedElement.kind)
      : null;
  const updateSelectedWidth = (requestedWidth: number): boolean => {
      if (!selectedElementFloor || !selectedElement || !selectedWidthBounds) return false;
      const width = Math.max(selectedWidthBounds.min, Math.min(selectedWidthBounds.max,
        clampPlanElementWidth(selectedElementFloor, selectedElement.kind, requestedWidth)));
      return updateSelectedElement({ width });
    };
  const updateSelectedHeight = (requestedHeight: number): boolean => {
      if (!selectedElementFloor || !selectedElement) return false;
      return updateSelectedElement({ height: clampPlanElementHeight(selectedElementFloor, selectedElement.kind, requestedHeight) });
    };
  const deleteSelectedElement = () => {
      if (!selectedElementFloor || !selectedElement || !onFloorChange) return;
      onFloorChange({
        ...selectedElementFloor,
        planElements: (selectedElementFloor.planElements ?? []).filter((element) => element.id !== selectedElement.id),
      });
      setSelectedElementKey(null);
    };
  const addOpeningIn3d = () => {
      const floor = house.floors.find((candidate) => candidate.id === activeFloorId);
      if (!floor || !onFloorChange) return;
      const id = createClientUuid();
      const height = defaultPlanElementHeight(floor, addableOpeningKind);
      let element: PlanElement;
      if (addableOpeningKind === "vent") {
        const room = floor.rooms.find((candidate) => candidate.points.length >= 3);
        const position = room
          ? room.points.reduce((sum, point) => ({ x: sum.x + point.x / room.points.length, y: sum.y + point.y / room.points.length }), { x: 0, y: 0 })
          : { x: floor.width / 2, y: floor.height / 2 };
        element = { id, kind: "vent", position, rotationDegrees: 0, width: defaultPlanElementWidth(floor, "vent"), height, variant: "passive" };
      } else {
        const bounds = planElementWidthBounds(floor, addableOpeningKind);
        const candidates = floor.walls.map((wall) => ({ wall, length: Math.hypot(wall.to.x - wall.from.x, wall.to.y - wall.from.y) }))
          .filter((candidate) => candidate.length + 1e-9 >= bounds.min)
          .sort((a, b) => b.length - a.length);
        const candidate = candidates[0];
        if (!candidate) {
          setOpeningEditorMessage(t(floor.walls.length ? "twin.openingWallTooShort" : "opening.noWallIn3d"));
          return;
        }
        const { wall, length } = candidate;
        const width = Math.min(defaultPlanElementWidth(floor, addableOpeningKind), length * .8);
        const position = { x: (wall.from.x + wall.to.x) / 2, y: (wall.from.y + wall.to.y) / 2 };
        const rotationDegrees = (Math.atan2(wall.to.y - wall.from.y, wall.to.x - wall.from.x) * 180 / Math.PI + 360) % 360;
        element = addableOpeningKind === "door"
          ? { id, kind: "door", position, rotationDegrees, width, height, wallId: wall.id, variant: "interior" }
          : addableOpeningKind === "window"
            ? { id, kind: "window", position, rotationDegrees, width, height, wallId: wall.id, variant: "casement" }
            : {
              id, kind: "fireEscape", position, rotationDegrees, width, height, wallId: wall.id,
              variant: "ladder", projection: defaultFireEscapeProjection(floor, width),
            };
      }
      onFloorChange({ ...floor, planElements: [...(floor.planElements ?? []), element] });
      setSelectedElementKey({ floorId: floor.id, elementId: element.id });
      setOpeningEditorMessage(t("opening.addedIn3d"));
    };
  return Object.assign(context, { projectedClouds, renderedSensors, orderedFloors, selectedElementFloor, selectedElement, changeCamera, rotateCamera, onPointerDown, onPointerMove, endPointer, onWheel, activateFloor, floorKeyDown, selectSensor, selectArchitecturalElement, updateSelectedElement, selectedWidthBounds, selectedHeightBounds, updateSelectedWidth, updateSelectedHeight, deleteSelectedElement, addOpeningIn3d });
}
