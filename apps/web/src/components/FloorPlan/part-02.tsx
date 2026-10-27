import { useEffect } from "react";
import { wallLengthPlanUnits, type Floor, type Point, type Room, type Wall } from "@climate-twin/contracts";
import { clamp } from "../../domain";
import { createClientUuid } from "../../clientUuid";
import { type TranslationKey } from "../../i18n";
import {
  isWallAttachedPlanElement,
} from "../../planElementGeometry";
import { GEOMETRY_EPSILON, insertRoomVertex, isValidRoomPolygon, roomRectanglePoints, snapPointToGrid, wallLengthInputValue } from "./support";
import type { EditorTool } from "./support";
import { useFloorPlanPart01 } from "./part-01";
export function useFloorPlanPart02(context: ReturnType<typeof useFloorPlanPart01>) {
  const { floor, viewMode, editing, onFloorChange, locale, t, svgRef, roomNameInputRef, undoButtonRef, roomNameBeforeEdit, roomVertexRefs, pendingRoomVertexFocus, setEditorTool, setWallStart, setRoomStart, selectedWallId, setSelectedWallId, wallLengthDraft, setWallLengthDraft, setWallLengthError, selectedRoomId, setSelectedRoomId, selectedPlanElementId, setSelectedPlanElementId, setPlacementError, setRoomNameError, deletedWallUndo, setDeletedWallUndo, setUndoMessage, snapEnabled, setAddToolsOpen, setEditorOptionsOpen, setKeyboardPoint, setPlacementAnnouncement, renderScale, metresPerPlanUnit, gridSize, layoutEditing, selectingLayout, planElements, selectedWall, selectedRoom } = context;
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
      setPlacementAnnouncement("");
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
      const wall: Wall = { id: createClientUuid(), from, to };
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
        id: createClientUuid(),
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
  return Object.assign(context, { roomName, pointFromEvent, placementPoint, clearLayoutSelection, chooseEditorTool, applyFloorChange, resetSelectedWallLengthDraft, commitSelectedWallLength, nextUnusedRoomName, addWall, deleteWall, undoLastDeletion, addRoom, updateRoom, addRoomVertex, commitRoomName });
}
