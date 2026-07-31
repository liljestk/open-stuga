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
import { useFloorPlanPart01 } from "./part-01";
import { useFloorPlanPart02 } from "./part-02";
import { useFloorPlanPart03 } from "./part-03";
import { useFloorPlanPart04 } from "./part-04";
import { useFloorPlanPart05 } from "./part-05";
import { renderFloorPlan } from "./render";

export function FloorPlan({
  floor, house, sensors, samples, climateSamples, observations, definition, colorDomain, units, viewMode, selectedSensorId, editing,
  observationPlacement, onSensorSelect, onSensorMove, onFloorChange, onObservationPoint, onCancelObservationPlacement,
  referenceTimeMs, maxSampleAgeMs,
  outdoor, mapAnimationsEnabled = true, outdoorExtrasVisible = true, spatialLayerSnapshots = [], spatialLayerTopology = null,
  experimentalAirflowEnabled = false, experimentalAirflow = null, experimentalSensorCoverage = null, experimentalOutdoorInfluence = null,
  openingStateObservations = [], pendingOpeningStateKeys = new Set<string>(), onOpeningStateChange,
  sensorMeasurements = {}, climateSensorMarkersVisible = true, energyDevicesVisible = true,
  connectedDevices = [], connectedDevicesVisible = true, pendingConnectedDeviceIds = new Set<string>(),
  onConnectedDevicePowerChange, onConnectedDeviceMove, allowBackgroundImageEditing = true,
}: FloorPlanProps) {
  const context0 = { floor, house, sensors, samples, climateSamples, observations, definition, colorDomain, units, viewMode, selectedSensorId, editing, observationPlacement, onSensorSelect, onSensorMove, onFloorChange, onObservationPoint, onCancelObservationPlacement, referenceTimeMs, maxSampleAgeMs, outdoor, mapAnimationsEnabled, outdoorExtrasVisible, spatialLayerSnapshots, spatialLayerTopology, experimentalAirflowEnabled, experimentalAirflow, experimentalSensorCoverage, experimentalOutdoorInfluence, openingStateObservations, pendingOpeningStateKeys, onOpeningStateChange, sensorMeasurements, climateSensorMarkersVisible, energyDevicesVisible, connectedDevices, connectedDevicesVisible, pendingConnectedDeviceIds, onConnectedDevicePowerChange, onConnectedDeviceMove, allowBackgroundImageEditing };
  const context1 = useFloorPlanPart01(context0);
  const context2 = useFloorPlanPart02(context1);
  const context3 = useFloorPlanPart03(context2);
  const context4 = useFloorPlanPart04(context3);
  const context5 = useFloorPlanPart05(context4);
  return renderFloorPlan(context5);
}
