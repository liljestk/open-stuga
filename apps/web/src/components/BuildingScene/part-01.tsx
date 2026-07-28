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
export function useBuildingScenePart01(context: { house: BuildingSceneProps["house"]; sensors: BuildingSceneProps["sensors"]; samples: BuildingSceneProps["samples"]; climateSamples: BuildingSceneProps["climateSamples"]; observations: BuildingSceneProps["observations"]; definition: BuildingSceneProps["definition"]; colorDomain: BuildingSceneProps["colorDomain"]; units: BuildingSceneProps["units"]; activeFloorId: BuildingSceneProps["activeFloorId"]; selectedSensorId: BuildingSceneProps["selectedSensorId"]; referenceTimeMs: BuildingSceneProps["referenceTimeMs"]; maxSampleAgeMs: BuildingSceneProps["maxSampleAgeMs"]; outdoor: BuildingSceneProps["outdoor"]; editing: Exclude<BuildingSceneProps["editing"], undefined>; spatialLayerSnapshots: Exclude<BuildingSceneProps["spatialLayerSnapshots"], undefined>; spatialLayerTopology: Exclude<BuildingSceneProps["spatialLayerTopology"], undefined>; experimentalAirflowEnabled: Exclude<BuildingSceneProps["experimentalAirflowEnabled"], undefined>; experimentalAirflow: Exclude<BuildingSceneProps["experimentalAirflow"], undefined>; experimentalSensorCoverage: Exclude<BuildingSceneProps["experimentalSensorCoverage"], undefined>; experimentalOutdoorInfluence: Exclude<BuildingSceneProps["experimentalOutdoorInfluence"], undefined>; openingStateObservations: Exclude<BuildingSceneProps["openingStateObservations"], undefined>; pendingOpeningStateKeys: Exclude<BuildingSceneProps["pendingOpeningStateKeys"], undefined>; onOpeningStateChange: BuildingSceneProps["onOpeningStateChange"]; sensorMeasurements: Exclude<BuildingSceneProps["sensorMeasurements"], undefined>; climateSensorMarkersVisible: Exclude<BuildingSceneProps["climateSensorMarkersVisible"], undefined>; energyDevicesVisible: Exclude<BuildingSceneProps["energyDevicesVisible"], undefined>; onFloorSelect: BuildingSceneProps["onFloorSelect"]; onSensorSelect: BuildingSceneProps["onSensorSelect"]; onFloorChange: BuildingSceneProps["onFloorChange"] }) {
  const { house, sensors, samples, climateSamples, observations, definition, colorDomain, units, activeFloorId, selectedSensorId, referenceTimeMs, maxSampleAgeMs, outdoor, editing, spatialLayerSnapshots, spatialLayerTopology, experimentalAirflowEnabled, experimentalAirflow, experimentalSensorCoverage, experimentalOutdoorInfluence, openingStateObservations, pendingOpeningStateKeys, onOpeningStateChange, sensorMeasurements, climateSensorMarkersVisible, energyDevicesVisible, onFloorSelect, onSensorSelect, onFloorChange } = context;
  const { locale, t } = useI18n();
  const houseOpeningStateObservations = useMemo(
      () => openingStateObservationsForHouse(house.id, openingStateObservations),
      [house.id, openingStateObservations],
    );
  const metricLabel = measurementLabel(definition, locale);
  const markerId = `building-flow-${useId().replace(/:/g, "")}`;
  const [camera, setCamera] = useState<CameraOrbit>(DEFAULT_CAMERA);
  const [reducedMotion, setReducedMotion] = useState(false);
  const { expanded: mapInformationExpanded, setMapInformationExpanded } = useMapInformationVisibility();
  const mapInformationId = `building-map-information-${useId().replace(/:/g, "")}`;
  const [selectedElementKey, setSelectedElementKey] = useState<{ floorId: string; elementId: string } | null>(null);
  const [addableOpeningKind, setAddableOpeningKind] = useState<AddableOpeningKind>("vent");
  const [openingEditorMessage, setOpeningEditorMessage] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const effectiveReferenceTimeMs = referenceTimeMs ?? inferReferenceTime(samples);
  const effectiveMaxAgeMs = maxSampleAgeMs ?? configuredSpatialMaxSampleAgeMs();
  const freshness: SpatialFreshnessOptions = useMemo(() => ({
      referenceTimeMs: effectiveReferenceTimeMs,
      maxSampleAgeMs: effectiveMaxAgeMs,
    }), [effectiveReferenceTimeMs, effectiveMaxAgeMs]);
  useEffect(() => {
      if (typeof window.matchMedia !== "function") return;
      const query = window.matchMedia("(prefers-reduced-motion: reduce)");
      const update = () => setReducedMotion(query.matches);
      update();
      query.addEventListener?.("change", update);
      return () => query.removeEventListener?.("change", update);
    }, []);
  const boundsSignature = house.floors.map((floor) => [
      floor.id, floor.width, floor.height, floor.elevation, floor.ceilingHeight ?? "", floor.wallHeight ?? "",
      floor.roof ? `${floor.roof.style}:${floor.roof.pitchDegrees}:${floor.roof.ridgeAxis}:${floor.roof.overhang}:${floor.roof.eavesHeight}` : "",
      ...(floor.planElements ?? []).filter(isRoofSpanningFireplace).map((element) => `${element.id}:${element.chimneyHeightAboveRoof ?? .6}:${element.chimneyWidth ?? ""}:${element.chimneyDepth ?? ""}`),
    ].join(":" )).join("|");
  // Element-only edits keep this object stable so heat-volume interpolation does not rerun on every slider tick.
    const bounds = useMemo(() => buildingBounds(house, sensors), [boundsSignature, sensors]);
  const floorModels = useMemo(() => [...house.floors].sort((a, b) => a.elevation - b.elevation).map((floor) => {
      const floorSensors = sensors.filter((sensor) => sensor.floorId === floor.id && sensor.enabled);
      const values = floorSensors.flatMap((sensor) => {
        const sample = samples[sensor.id];
        const value = measurementValue(sample, definition.id);
        return isSpatialSampleFresh(sample, freshness) && value != null ? [value] : [];
      });
      return {
        floor,
        floorSensors,
        values,
        average: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      };
    }), [house.floors, sensors, samples, definition.id, freshness]);
  const volume = useMemo(() => interpolateVolume(
      sensors, samples, definition, bounds, freshness, 11,
    ), [sensors, samples, definition, bounds, freshness]);
  const heatMin = colorDomain?.min ?? volume.min;
  const heatMax = colorDomain?.max ?? volume.max;
  const clouds = useMemo(() => createVolumeClouds(
      volume, definition, 24, { min: heatMin, max: heatMax },
    ), [volume, definition, heatMin, heatMax]);
  const gradientFlows = useMemo(() => estimateVolumeFlows(volume, definition, 11), [volume, definition]);
  const allValues = volume.anchors.map((anchor) => anchor.value);
  const project = (point: Point3D) => projectPoint3D(point, bounds, camera, {
      width: VIEW_WIDTH, height: VIEW_HEIGHT, padding: 72,
    });
  const outdoorContext = outdoor?.context ?? null;
  const airflow = useMemo(() => {
      if (!experimentalAirflowEnabled || editing) return null;
      if (experimentalAirflow) return experimentalAirflow;
      return climateSamples ? simulateBuildingAirflow({
        house,
        sensors,
        samples: climateSamples,
        freshness,
        outdoor: outdoorContext,
        openingStateObservations: houseOpeningStateObservations,
      }, 14) : null;
    }, [experimentalAirflowEnabled, experimentalAirflow, editing, climateSamples, house, sensors, freshness, outdoorContext, houseOpeningStateObservations]);
  const airflowPaths = airflow?.paths ?? [];
  const activeGradientFlows = editing || airflowPaths.length ? [] : gradientFlows;
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
  const outdoorShellWorld = outdoorContext ? (() => {
      const padding = Math.min(bounds.width, bounds.depth) * .14;
      const bottomZ = bounds.minZ - .12;
      const topZ = bounds.maxZ + .4;
      const footprint = [
        { x: -padding, y: -padding },
        { x: bounds.width + padding, y: -padding },
        { x: bounds.width + padding, y: bounds.depth + padding },
        { x: -padding, y: bounds.depth + padding },
      ];
      return {
        bottom: footprint.map((point) => ({ ...point, z: bottomZ })),
        top: footprint.map((point) => ({ ...point, z: topZ })),
      };
    })() : null;
  const outdoorShellProjected = outdoorShellWorld ? {
      bottom: outdoorShellWorld.bottom.map(project),
      top: outdoorShellWorld.top.map(project),
    } : null;
  const outdoorWindwardProjected = outdoorShellProjected && outdoorContext?.windwardEdge ? (() => {
      const startIndex = outdoorContext.windwardEdge === "top"
        ? 0
        : outdoorContext.windwardEdge === "right"
          ? 1
          : outdoorContext.windwardEdge === "bottom"
            ? 2
            : 3;
      return {
        edge: outdoorContext.windwardEdge,
        start: outdoorShellProjected.top[startIndex]!,
        end: outdoorShellProjected.top[(startIndex + 1) % outdoorShellProjected.top.length]!,
      };
    })() : null;
  const outdoorShellRail = outdoorShellProjected ? (() => {
      const anchor = outdoorShellProjected.top.reduce((highest, point) => point.y < highest.y ? point : highest);
      return {
        anchor,
        x: Math.max(330, Math.min(VIEW_WIDTH - 430, anchor.x - 209)),
        y: Math.max(28, Math.min(VIEW_HEIGHT - 66, anchor.y - 72)),
      };
    })() : null;
  return Object.assign(context, { locale, t, houseOpeningStateObservations, metricLabel, markerId, camera, setCamera, reducedMotion, setReducedMotion, mapInformationExpanded, setMapInformationExpanded, mapInformationId, selectedElementKey, setSelectedElementKey, addableOpeningKind, setAddableOpeningKind, openingEditorMessage, setOpeningEditorMessage, dragRef, suppressClickRef, effectiveReferenceTimeMs, effectiveMaxAgeMs, freshness, boundsSignature, bounds, floorModels, volume, heatMin, heatMax, clouds, gradientFlows, allValues, project, outdoorContext, airflow, airflowPaths, activeGradientFlows, airflowSupport, airflowDriver, airflowDescription, airflowAria, outdoorTemperature, outdoorHumidity, outdoorTemperatureColor, outdoorHumidityColor, activeOutdoorColor, activeOutdoorStyle, outdoorTemperatureStyle, outdoorHumidityStyle, outdoorWindSpeed, outdoorWindDirection, outdoorWindwardSide, outdoorShellLabel, outdoorShellWorld, outdoorShellProjected, outdoorWindwardProjected, outdoorShellRail });
}
