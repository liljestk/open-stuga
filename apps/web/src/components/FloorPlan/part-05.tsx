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
import { useFloorPlanPart04 } from "./part-04";
export function useFloorPlanPart05(context: ReturnType<typeof useFloorPlanPart04>) {
  const { floor, house, sensors, samples, climateSamples, observations, definition, colorDomain, units, viewMode, selectedSensorId, editing, observationPlacement, onSensorSelect, onSensorMove, onFloorChange, onObservationPoint, onCancelObservationPlacement, referenceTimeMs, maxSampleAgeMs, outdoor, spatialLayerSnapshots, spatialLayerTopology, experimentalAirflowEnabled, experimentalAirflow, experimentalSensorCoverage, experimentalOutdoorInfluence, openingStateObservations, pendingOpeningStateKeys, onOpeningStateChange, sensorMeasurements, energyDevicesVisible, allowBackgroundImageEditing, locale, t, houseOpeningStateObservations, metricLabel, svgRef, fileRef, roomNameInputRef, undoButtonRef, roomNameBeforeEdit, dragging, draggingElement, draggingRoomVertex, roomVertexRefs, pendingRoomVertexFocus, planElementRefs, mapHelpId, mapInformationId, roomNameErrorId, wallLengthErrorId, fieldId, editorTool, setEditorTool, wallStart, setWallStart, roomStart, setRoomStart, selectedWallId, setSelectedWallId, wallLengthDraft, setWallLengthDraft, wallLengthError, setWallLengthError, selectedRoomId, setSelectedRoomId, selectedPlanElementId, setSelectedPlanElementId, planElementKind, setPlanElementKind, placementError, setPlacementError, roomNameError, setRoomNameError, deletedWallUndo, setDeletedWallUndo, undoMessage, setUndoMessage, snapEnabled, setSnapEnabled, gridDensity, setGridDensity, addToolsOpen, setAddToolsOpen, editorOptionsOpen, setEditorOptionsOpen, keyboardPoint, setKeyboardPoint, placementAnnouncement, setPlacementAnnouncement, uploadError, setUploadError, reducedMotion, setReducedMotion, mapInformationExpanded, setMapInformationExpanded, renderScale, metresPerPlanUnit, placementCoordinateScale, placementCoordinateUnit, renderWidth, renderHeight, gridSize, renderedGridSize, viewportMargin, resolvedReferenceTimeMs, spatialFreshness, renderSensors, heat, visualDomain, clouds, gradientFlows, transform, layoutEditing, drawingWall, drawingRoom, placingElement, selectingLayout, keyboardPlacementActive, wallSelectionActive, roomSelectionActive, planElementSelectionActive, showMonitoringOverlays, planElements, chimneyPenetrations, selectedWall, selectedRoom, selectedPlanElement, selectedRoomSensorCount, roomName, pointFromEvent, placementPoint, clearLayoutSelection, chooseEditorTool, applyFloorChange, resetSelectedWallLengthDraft, commitSelectedWallLength, nextUnusedRoomName, addWall, deleteWall, undoLastDeletion, addRoom, updateRoom, addRoomVertex, commitRoomName, deleteRoom, resolveElementPlacement, placementFailureMessage, addPlanElement, updatePlanElement, movePlanElement, updatePlanElementWidth, updatePlanElementHeight, deletePlanElement, mapPointerDown, mapPointerMove, mapKeyDown, wallPointerDown, wallKeyDown, roomPointerDown, roomKeyDown, roomVertexPointerDown, roomEdgeKeyDown, moveRoomVertex, roomVertexKeyDown, planElementPointerDown, planElementPointerMove, planElementKeyDown, startSensorDrag, moveSensor, sensorKeyDown, uploadBackground, legendMin, legendMax, outdoorContext, airflow, airflowPaths, activeGradientFlows } = context;
  const hasOutdoorWindCue = outdoorContext?.planWindFromDegrees != null && outdoorContext.windFromDegrees != null;
  const hasMapInformation = clouds.length > 0 || airflowPaths.length > 0 || activeGradientFlows.length > 0
      || hasOutdoorWindCue || Boolean(experimentalSensorCoverage) || Boolean(experimentalOutdoorInfluence) || spatialLayerSnapshots.length > 0;
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
  return Object.assign(context, { hasOutdoorWindCue, hasMapInformation, airflowSupport, airflowDriver, airflowDescription, airflowAria, outdoorTemperature, outdoorHumidity, outdoorTemperatureColor, outdoorHumidityColor, activeOutdoorColor, activeOutdoorStyle, outdoorTemperatureStyle, outdoorHumidityStyle, outdoorWindSpeed, outdoorWindDirection, outdoorWindwardSide, outdoorShellLabel, edgeLabels, elementPreviewPlacement, selectedElementWidthBounds, selectedElementHeightBounds, selectedElementRotation, selectedElementHasCardinalRotation, wallPreview, editorHint });
}
