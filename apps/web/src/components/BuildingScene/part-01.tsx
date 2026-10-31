import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useI18n } from "../../i18n";
import { measurementLabel, measurementValue } from "../../measurements";
import {
  configuredSpatialMaxSampleAgeMs, isSpatialSampleFresh, type SpatialFreshnessOptions,
} from "../../spatial/freshness";
import { simulateBuildingAirflow } from "../../airflowSimulation";
import {
  createVolumeClouds,
  estimateVolumeFlows,
  interpolateVolume,
  projectPoint3D,
  type CameraOrbit,
  type Point3D,
} from "../../spatial/volume";
import {
  formatOutdoorHumidity,
  formatOutdoorTemperature,
  formatOutdoorWindSpeed,
} from "../OutdoorConditionsBadge";
import { isRoofSpanningFireplace } from "../../architecturalGeometry";
import { useMapInformationVisibility } from "../MapInformationToggle";
import { openingStateObservationsForHouse } from "../../openingState";
import { windPathOnRectangle } from "../../outdoor/context";
import { DEFAULT_CAMERA, OUTDOOR_SHELL_RAIL, VIEW_HEIGHT, VIEW_WIDTH, buildingBounds, inferReferenceTime } from "./sceneGeometry";
import type { AddableOpeningKind, BuildingSceneProps, DragState } from "./sceneGeometry";
export function useBuildingScenePart01(context: { house: BuildingSceneProps["house"]; sensors: BuildingSceneProps["sensors"]; samples: BuildingSceneProps["samples"]; climateSamples: BuildingSceneProps["climateSamples"]; observations: BuildingSceneProps["observations"]; definition: BuildingSceneProps["definition"]; colorDomain: BuildingSceneProps["colorDomain"]; units: BuildingSceneProps["units"]; activeFloorId: BuildingSceneProps["activeFloorId"]; selectedSensorId: BuildingSceneProps["selectedSensorId"]; referenceTimeMs: BuildingSceneProps["referenceTimeMs"]; maxSampleAgeMs: BuildingSceneProps["maxSampleAgeMs"]; outdoor: BuildingSceneProps["outdoor"]; mapAnimationsEnabled: Exclude<BuildingSceneProps["mapAnimationsEnabled"], undefined>; outdoorExtrasVisible: Exclude<BuildingSceneProps["outdoorExtrasVisible"], undefined>; editing: Exclude<BuildingSceneProps["editing"], undefined>; spatialLayerSnapshots: Exclude<BuildingSceneProps["spatialLayerSnapshots"], undefined>; spatialLayerTopology: Exclude<BuildingSceneProps["spatialLayerTopology"], undefined>; experimentalAirflowEnabled: Exclude<BuildingSceneProps["experimentalAirflowEnabled"], undefined>; experimentalAirflow: Exclude<BuildingSceneProps["experimentalAirflow"], undefined>; experimentalSensorCoverage: Exclude<BuildingSceneProps["experimentalSensorCoverage"], undefined>; experimentalOutdoorInfluence: Exclude<BuildingSceneProps["experimentalOutdoorInfluence"], undefined>; openingStateObservations: Exclude<BuildingSceneProps["openingStateObservations"], undefined>; openingStateLabelsVisible: Exclude<BuildingSceneProps["openingStateLabelsVisible"], undefined>; pendingOpeningStateKeys: Exclude<BuildingSceneProps["pendingOpeningStateKeys"], undefined>; onOpeningStateChange: BuildingSceneProps["onOpeningStateChange"]; sensorMeasurements: Exclude<BuildingSceneProps["sensorMeasurements"], undefined>; climateSensorMarkersVisible: Exclude<BuildingSceneProps["climateSensorMarkersVisible"], undefined>; energyDevicesVisible: Exclude<BuildingSceneProps["energyDevicesVisible"], undefined>; connectedDevices: Exclude<BuildingSceneProps["connectedDevices"], undefined>; connectedDevicesVisible: Exclude<BuildingSceneProps["connectedDevicesVisible"], undefined>; pendingConnectedDeviceIds: Exclude<BuildingSceneProps["pendingConnectedDeviceIds"], undefined>; onConnectedDevicePowerChange: BuildingSceneProps["onConnectedDevicePowerChange"]; onFloorSelect: BuildingSceneProps["onFloorSelect"]; onSensorSelect: BuildingSceneProps["onSensorSelect"]; onFloorChange: BuildingSceneProps["onFloorChange"] }) {
  const { house, sensors, samples, climateSamples, definition, colorDomain, units, referenceTimeMs, maxSampleAgeMs, outdoor, editing, experimentalAirflowEnabled, experimentalAirflow, openingStateObservations } = context;
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
      ? t(`spatial.airflow.support.${airflow.evidence.support}`)
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
      ? `${t(`outdoor.cardinal.${outdoorContext.windFromCardinal}`)} ${Math.round(outdoorContext.windFromDegrees)}°`
      : null;
  const outdoorWindwardSide = outdoorContext?.windwardEdge
      ? t(`outdoor.edge.${outdoorContext.windwardEdge}`)
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
  const outdoorWindwardProjected = outdoorShellProjected && outdoorContext?.windwardEdge
    && outdoorContext.planWindFromDegrees !== null ? (() => {
      const path = windPathOnRectangle(
        outdoorContext.planWindFromDegrees,
        bounds.width + Math.min(bounds.width, bounds.depth) * .28,
        bounds.depth + Math.min(bounds.width, bounds.depth) * .28,
        .035,
        .035,
      );
      const padding = Math.min(bounds.width, bounds.depth) * .14;
      const z = bounds.maxZ + .4;
      return {
        edge: outdoorContext.windwardEdge,
        bearing: outdoorContext.planWindFromDegrees,
        start: project({ x: path.sourcePoint.x - padding, y: path.sourcePoint.y - padding, z }),
        end: project({ x: path.inwardTarget.x - padding, y: path.inwardTarget.y - padding, z }),
      };
    })() : null;
  const outdoorShellRail = outdoorShellProjected ? (() => {
      const [first, ...others] = outdoorShellProjected.top;
      if (!first) return null;
      const anchor = others.reduce((highest, point) => point.y < highest.y ? point : highest, first);
      return {
        anchor,
        x: Math.max(330, Math.min(VIEW_WIDTH - OUTDOOR_SHELL_RAIL.width - 10, anchor.x - OUTDOOR_SHELL_RAIL.width / 2)),
        y: Math.max(28, Math.min(VIEW_HEIGHT - OUTDOOR_SHELL_RAIL.height - 14, anchor.y - OUTDOOR_SHELL_RAIL.height - 20)),
      };
    })() : null;
  return Object.assign(context, { locale, t, houseOpeningStateObservations, metricLabel, markerId, camera, setCamera, reducedMotion, setReducedMotion, mapInformationExpanded, setMapInformationExpanded, mapInformationId, selectedElementKey, setSelectedElementKey, addableOpeningKind, setAddableOpeningKind, openingEditorMessage, setOpeningEditorMessage, dragRef, suppressClickRef, effectiveReferenceTimeMs, effectiveMaxAgeMs, freshness, boundsSignature, bounds, floorModels, volume, heatMin, heatMax, clouds, gradientFlows, allValues, project, outdoorContext, airflow, airflowPaths, activeGradientFlows, airflowSupport, airflowDriver, airflowDescription, airflowAria, outdoorTemperature, outdoorHumidity, outdoorTemperatureColor, outdoorHumidityColor, activeOutdoorColor, activeOutdoorStyle, outdoorTemperatureStyle, outdoorHumidityStyle, outdoorWindSpeed, outdoorWindDirection, outdoorWindwardSide, outdoorShellLabel, outdoorShellWorld, outdoorShellProjected, outdoorWindwardProjected, outdoorShellRail });
}
