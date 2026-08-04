import {
  useEffect, useId, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type WheelEvent,
} from "react";
import { isAirflowPlanElement, type ConfiguredOpeningState, type Floor, type House, type ManualObservation, type MeasurementDefinition, type MeasurementSample, type OpeningStateObservation, type PlanElement, type Sensor, type UnitSystem } from "@climate-twin/contracts";
import { useI18n, type TranslationKey } from "../../i18n";
import { formatMeasurement, formatMeasurementDelta, measurementGradient, measurementLabel, measurementValue, toDisplayValue, type LatestMeasurements } from "../../measurements";
import { energyDeviceMapStats, isEnergyDeviceSensor } from "../../energyDeviceMap";
import {
  configuredSpatialMaxSampleAgeMs, isSpatialSampleFresh, type SpatialFreshnessOptions,
} from "../../spatialFreshness";
import { simulateBuildingAirflow, type BuildingAirflowEstimate, type ClimateSampleMatrix } from "../../airflowSimulation";
import {
  clampCameraOrbit, createVolumeClouds, estimateVolumeFlows, interpolateVolume, projectPoint3D,
  type CameraOrbit, type Point3D, type ProjectedPoint3D, type VolumeBounds, type VolumeCloudBlob,
} from "../../spatialVolume";
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
import { SpatialLayerOverlay3D } from "../SpatialLayerOverlay3D";
import type { SpatialLayerSnapshot, SpatialTopology } from "../../spatialLayers";
import type { SensorCoverageAssessment } from "../../experimentalSpatialLayers";
import { ExperimentalSensorCoverage3D } from "../ExperimentalSensorCoverage";
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
  planElementBottomOffset,
  planElementHeightBounds,
  planElementWidthBounds,
} from "../../planElementGeometry";
import { fireplaceChimneyDimensions, fireplaceChimneyTop, isRoofSpanningFireplace, roofEavesZ, roofPeakZ, roofSurfaces } from "../../architecturalGeometry";
import { MapInformationToggle, useMapInformationVisibility } from "../MapInformationToggle";
import { effectiveOpeningState, openingStateCanChange, openingStateKey, openingStateObservationsForHouse } from "../../openingState";
import { DEFAULT_CAMERA, VIEW_HEIGHT, VIEW_WIDTH, buildingBounds, elementAxis, elementWorldGeometry, inferReferenceTime, points, projectedCloud, relativeSensorHeight, smoothProjectedAirflowPath, svgToken, visualLabel } from "./support";
import type { AddableOpeningKind, BuildingSceneProps, DragState, ElementWorldGeometry, ProjectedCloud, SelectedElementPatch } from "./support";
import { useBuildingScenePart01 } from "./part-01";
import { useBuildingScenePart02 } from "./part-02";
import { useBuildingScenePart03 } from "./part-03";
import { renderBuildingScene } from "./render";

export function BuildingScene({
  house, sensors, samples, climateSamples, observations, definition, colorDomain, units, activeFloorId, selectedSensorId,
  referenceTimeMs, maxSampleAgeMs, outdoor, mapAnimationsEnabled = true, outdoorExtrasVisible = true, editing = false, spatialLayerSnapshots = [], spatialLayerTopology = null,
  experimentalAirflowEnabled = false, experimentalAirflow = null, experimentalSensorCoverage = null, experimentalOutdoorInfluence = null,
  openingStateObservations = [], openingStateLabelsVisible = true, pendingOpeningStateKeys = new Set<string>(), onOpeningStateChange,
  sensorMeasurements = {}, climateSensorMarkersVisible = true, energyDevicesVisible = true,
  connectedDevices = [], connectedDevicesVisible = true, pendingConnectedDeviceIds = new Set<string>(),
  heatPumps = [], heatPumpInfluenceVisible = true,
  onConnectedDevicePowerChange,
  onFloorSelect, onSensorSelect, onFloorChange,
}: BuildingSceneProps) {
  const context0 = { house, sensors, samples, climateSamples, observations, definition, colorDomain, units, activeFloorId, selectedSensorId, referenceTimeMs, maxSampleAgeMs, outdoor, mapAnimationsEnabled, outdoorExtrasVisible, editing, spatialLayerSnapshots, spatialLayerTopology, experimentalAirflowEnabled, experimentalAirflow, experimentalSensorCoverage, experimentalOutdoorInfluence, openingStateObservations, openingStateLabelsVisible, pendingOpeningStateKeys, onOpeningStateChange, sensorMeasurements, climateSensorMarkersVisible, energyDevicesVisible, connectedDevices, connectedDevicesVisible, pendingConnectedDeviceIds, heatPumps, heatPumpInfluenceVisible, onConnectedDevicePowerChange, onFloorSelect, onSensorSelect, onFloorChange };
  const context1 = useBuildingScenePart01(context0);
  const context2 = useBuildingScenePart02(context1);
  const context3 = useBuildingScenePart03(context2);
  return renderBuildingScene(context3);
}
