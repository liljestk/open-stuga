import {
  useEffect, useId, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type WheelEvent,
} from "react";
import { isAirflowPlanElement, type ConfiguredOpeningState, type Floor, type House, type ManualObservation, type MeasurementDefinition, type MeasurementSample, type OpeningStateObservation, type PlanElement, type Sensor, type UnitSystem } from "@climate-twin/contracts";
import { useI18n, type TranslationKey } from "../i18n";
import { formatMeasurement, formatMeasurementDelta, measurementGradient, measurementLabel, measurementValue, toDisplayValue, type LatestMeasurements } from "../measurements";
import { energyDeviceMapStats, isEnergyDeviceSensor } from "../energyDeviceMap";
import {
  configuredSpatialMaxSampleAgeMs, isSpatialSampleFresh, type SpatialFreshnessOptions,
} from "../spatialFreshness";
import { simulateBuildingAirflow, type BuildingAirflowEstimate, type ClimateSampleMatrix } from "../airflowSimulation";
import {
  clampCameraOrbit, createVolumeClouds, estimateVolumeFlows, interpolateVolume, projectPoint3D,
  type CameraOrbit, type Point3D, type ProjectedPoint3D, type VolumeBounds, type VolumeCloudBlob,
} from "../spatialVolume";
import {
  formatOutdoorHumidity,
  formatOutdoorTemperature,
  formatOutdoorWindSpeed,
  OutdoorConditionsBadge,
  type OutdoorVisualizationState,
} from "./OutdoorConditionsBadge";
import { PlanElementDimensionFields } from "./PlanElementDimensionFields";
import { applyAirflowPlanElementPatch, PlanElementAirflowFields, type AirflowPlanElementPatch } from "./PlanElementAirflowFields";
import { applyFixturePlanElementPatch, PlanElementFixtureFields, type FixturePlanElementPatch } from "./PlanElementFixtureFields";
import { OpeningInventory } from "./OpeningInventory";
import { SpatialLayerOverlay3D } from "./SpatialLayerOverlay3D";
import type { SpatialLayerSnapshot, SpatialTopology } from "../spatialLayers";
import type { SensorCoverageAssessment } from "../experimentalSpatialLayers";
import { ExperimentalSensorCoverage3D } from "./ExperimentalSensorCoverage";
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
} from "../planElementGeometry";
import { fireplaceChimneyDimensions, fireplaceChimneyTop, isRoofSpanningFireplace, roofEavesZ, roofPeakZ, roofSurfaces } from "../architecturalGeometry";
import { MapInformationToggle, useMapInformationVisibility } from "./MapInformationToggle";
import { effectiveOpeningState, openingStateCanChange, openingStateKey, openingStateObservationsForHouse } from "../openingState";

interface BuildingSceneProps {
  house: House;
  sensors: Sensor[];
  samples: Record<string, MeasurementSample>;
  /** Metric-complete samples used by capability-specific markers such as energy plugs. */
  sensorMeasurements?: LatestMeasurements;
  energyDevicesVisible?: boolean;
  climateSamples?: ClimateSampleMatrix;
  observations: ManualObservation[];
  definition: MeasurementDefinition;
  colorDomain?: { min: number; max: number } | null;
  units: UnitSystem;
  activeFloorId: string;
  selectedSensorId: string | null;
  referenceTimeMs?: number;
  maxSampleAgeMs?: number;
  outdoor?: OutdoorVisualizationState;
  editing?: boolean;
  spatialLayerSnapshots?: readonly SpatialLayerSnapshot[];
  spatialLayerTopology?: SpatialTopology | null;
  experimentalAirflowEnabled?: boolean;
  experimentalAirflow?: BuildingAirflowEstimate | null;
  experimentalSensorCoverage?: SensorCoverageAssessment | null;
  openingStateObservations?: readonly OpeningStateObservation[];
  pendingOpeningStateKeys?: ReadonlySet<string>;
  onOpeningStateChange?: (floorId: string, elementId: string, state: ConfiguredOpeningState) => void;
  onFloorSelect: (floorId: string) => void;
  onSensorSelect: (sensorId: string, floorId: string) => void;
  onFloorChange?: (floor: Floor) => void;
}

interface ProjectedCloud {
  blob: VolumeCloudBlob;
  center: ProjectedPoint3D;
  radiusX: number;
  radiusY: number;
  angle: number;
}

interface DragState {
  pointerId: number;
  x: number;
  y: number;
  camera: CameraOrbit;
  moved: boolean;
}

type AddableOpeningKind = "door" | "window" | "vent" | "fireEscape";
type SelectedElementPatch = AirflowPlanElementPatch & FixturePlanElementPatch & {
  width?: number;
  height?: number;
};

const VIEW_WIDTH = 1100;
const VIEW_HEIGHT = 720;
const DEFAULT_CAMERA: CameraOrbit = { yaw: -.68, pitch: .63, zoom: 1 };

function points(projected: ProjectedPoint3D[]): string {
  return projected.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
}

function smoothProjectedAirflowPath(projected: ProjectedPoint3D[]): string {
  if (projected.length < 2) return "";
  if (projected.length === 2) return `M${projected[0]!.x.toFixed(1)} ${projected[0]!.y.toFixed(1)}L${projected[1]!.x.toFixed(1)} ${projected[1]!.y.toFixed(1)}`;
  let path = `M${projected[0]!.x.toFixed(1)} ${projected[0]!.y.toFixed(1)}`;
  for (let index = 1; index < projected.length - 1; index += 1) {
    const current = projected[index]!;
    const next = projected[index + 1]!;
    path += `Q${current.x.toFixed(1)} ${current.y.toFixed(1)} ${((current.x + next.x) / 2).toFixed(1)} ${((current.y + next.y) / 2).toFixed(1)}`;
  }
  const last = projected.at(-1)!;
  return `${path}L${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
}

function svgToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function relativeSensorHeight(sensor: Sensor, floorElevation: number): number {
  return sensor.z - floorElevation;
}

function visualLabel(value: string, maximumCharacters = 20): string {
  const characters = Array.from(value);
  return characters.length > maximumCharacters
    ? `${characters.slice(0, maximumCharacters - 1).join("")}…`
    : value;
}

interface ElementWorldGeometry {
  front: Point3D[];
  back?: Point3D[];
  left?: Point3D[];
  right?: Point3D[];
  top?: Point3D[];
  width: number;
  height: number;
  bottom: number;
  depth: number;
}

function elementAxis(floor: Floor, element: PlanElement): { x: number; y: number } {
  if (isWallAttachedPlanElement(element)) {
    const wall = floor.walls.find((candidate) => candidate.id === element.wallId);
    if (wall) {
      const dx = wall.to.x - wall.from.x;
      const dy = wall.to.y - wall.from.y;
      const length = Math.hypot(dx, dy);
      if (length > 1e-8) return { x: dx / length, y: dy / length };
    }
  }
  const radians = element.rotationDegrees * Math.PI / 180;
  return { x: Math.cos(radians), y: Math.sin(radians) };
}

/** Builds the 3D shape directly from the same floor-local record used by the plan editor. */
function elementWorldGeometry(
  floor: Floor,
  element: PlanElement,
  overrides: { width?: number; height?: number; bottom?: number; depth?: number } = {},
): ElementWorldGeometry {
  const width = overrides.width ?? element.width ?? defaultPlanElementWidth(floor, element.kind);
  const height = overrides.height ?? effectivePlanElementHeight(floor, element);
  const bottom = overrides.bottom ?? floor.elevation + planElementBottomOffset(floor, element);
  const top = bottom + height;
  const axis = elementAxis(floor, element);
  let perpendicular = { x: -axis.y, y: axis.x };
  const halfWidth = width / 2;
  const depth = overrides.depth ?? (isWallOpening(element)
    ? 0
    : element.kind === "fireEscape"
      ? element.projection ?? defaultFireEscapeProjection(floor, width)
      : Math.max(Math.max(floor.width, floor.height) * .012, width * (element.kind === "fireplace" ? .34 : .2)));
  if (element.kind === "fireEscape") {
    const away = { x: element.position.x - floor.width / 2, y: element.position.y - floor.height / 2 };
    if (perpendicular.x * away.x + perpendicular.y * away.y < 0) perpendicular = { x: -perpendicular.x, y: -perpendicular.y };
  }
  const point = (along: number, across: number, z: number): Point3D => ({
    x: element.position.x + axis.x * along + perpendicular.x * across,
    y: element.position.y + axis.y * along + perpendicular.y * across,
    z,
  });
  const frontAcross = element.kind === "fireEscape" ? depth : depth / 2;
  const backAcross = element.kind === "fireEscape" ? 0 : -depth / 2;
  const front = [
    point(-halfWidth, frontAcross, bottom), point(halfWidth, frontAcross, bottom),
    point(halfWidth, frontAcross, top), point(-halfWidth, frontAcross, top),
  ];
  if (depth <= 0) return { front, width, height, bottom, depth };
  const back = [
    point(halfWidth, backAcross, bottom), point(-halfWidth, backAcross, bottom),
    point(-halfWidth, backAcross, top), point(halfWidth, backAcross, top),
  ];
  return {
    front,
    back,
    left: [front[0]!, back[1]!, back[2]!, front[3]!],
    right: [back[0]!, front[1]!, front[2]!, back[3]!],
    top: [front[3]!, front[2]!, back[3]!, back[2]!],
    width,
    height,
    bottom,
    depth,
  };
}

function inferReferenceTime(samples: Record<string, MeasurementSample>): number {
  const timestamps = Object.values(samples).map((sample) => Date.parse(sample.timestamp)).filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : Date.now();
}

function buildingBounds(house: House, sensors: Sensor[]): VolumeBounds {
  const ordered = [...house.floors].sort((a, b) => a.elevation - b.elevation);
  const minFloor = Math.min(0, ...ordered.map((floor) => floor.elevation));
  const structuralTop = Math.max(minFloor + 1, ...ordered.map((floor) => floor.roof
    ? roofPeakZ(floor)
    : floor.elevation + (floor.wallHeight ?? floor.ceilingHeight ?? DEFAULT_CEILING_HEIGHT_METRES)));
  const chimneyTop = Math.max(structuralTop, ...ordered.flatMap((floor) => (floor.planElements ?? [])
    .filter(isRoofSpanningFireplace)
    .map((element) => fireplaceChimneyTop(house, floor, element))));
  return {
    width: Math.max(1, ...ordered.map((floor) => floor.width)),
    depth: Math.max(1, ...ordered.map((floor) => floor.height)),
    minZ: Math.min(minFloor, ...sensors.map((sensor) => sensor.z)),
    maxZ: Math.max(
      minFloor + 1,
      structuralTop,
      chimneyTop,
      ...sensors.map((sensor) => sensor.z + .4),
    ),
  };
}

function projectedCloud(
  blob: VolumeCloudBlob,
  project: (point: Point3D) => ProjectedPoint3D,
): ProjectedCloud {
  const center = project(blob);
  const axes = [
    project({ x: blob.x + blob.radiusX, y: blob.y, z: blob.z }),
    project({ x: blob.x, y: blob.y + blob.radiusY, z: blob.z }),
    project({ x: blob.x, y: blob.y, z: blob.z + blob.radiusZ }),
  ].map((point) => ({ x: point.x - center.x, y: point.y - center.y }));
  const xx = axes.reduce((sum, axis) => sum + axis.x ** 2, 0);
  const yy = axes.reduce((sum, axis) => sum + axis.y ** 2, 0);
  const xy = axes.reduce((sum, axis) => sum + axis.x * axis.y, 0);
  const trace = xx + yy;
  const discriminant = Math.sqrt(Math.max(0, (xx - yy) ** 2 + 4 * xy ** 2));
  return {
    blob,
    center,
    radiusX: Math.max(7, Math.sqrt(Math.max(1, (trace + discriminant) / 2))),
    radiusY: Math.max(5, Math.sqrt(Math.max(1, (trace - discriminant) / 2))),
    angle: Math.atan2(2 * xy, xx - yy) * 90 / Math.PI,
  };
}

export function BuildingScene({
  house, sensors, samples, climateSamples, observations, definition, colorDomain, units, activeFloorId, selectedSensorId,
  referenceTimeMs, maxSampleAgeMs, outdoor, editing = false, spatialLayerSnapshots = [], spatialLayerTopology = null,
  experimentalAirflowEnabled = false, experimentalAirflow = null, experimentalSensorCoverage = null,
  openingStateObservations = [], pendingOpeningStateKeys = new Set<string>(), onOpeningStateChange,
  sensorMeasurements = {}, energyDevicesVisible = true,
  onFloorSelect, onSensorSelect, onFloorChange,
}: BuildingSceneProps) {
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
  const outdoorContext = !outdoor?.replayActive ? outdoor?.context ?? null : null;
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
    const id = crypto.randomUUID();
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

  const renderArchitecturalElement = (floor: Floor, element: PlanElement, index: number) => {
    const geometry = elementWorldGeometry(floor, element);
    const chimneyDimensions = isRoofSpanningFireplace(element) ? fireplaceChimneyDimensions(floor, element) : null;
    const chimneyGeometry = chimneyDimensions ? elementWorldGeometry(floor, element, {
      width: chimneyDimensions.width,
      depth: chimneyDimensions.depth,
      bottom: floor.elevation,
      height: Math.max(.05, fireplaceChimneyTop(house, floor, element) - floor.elevation),
    }) : null;
    const chimneyFront = chimneyGeometry?.front.map(project);
    const chimneyBack = chimneyGeometry?.back?.map(project);
    const chimneyLeft = chimneyGeometry?.left?.map(project);
    const chimneyRight = chimneyGeometry?.right?.map(project);
    const chimneyTop = chimneyGeometry?.top?.map(project);
    const front = geometry.front.map(project);
    const back = geometry.back?.map(project);
    const left = geometry.left?.map(project);
    const right = geometry.right?.map(project);
    const top = geometry.top?.map(project);
    const selected = selectedElementKey?.floorId === floor.id && selectedElementKey.elementId === element.id;
    const airflowElement = isAirflowPlanElement(element) ? element : null;
    const openingState = airflowElement
      ? effectiveOpeningState(house.id, floor.id, airflowElement, houseOpeningStateObservations, effectiveReferenceTimeMs)
      : null;
    const openingControlEnabled = Boolean(
      airflowElement && openingState && !editing && onOpeningStateChange && openingStateCanChange(airflowElement),
    );
    const openingPending = openingControlEnabled && pendingOpeningStateKeys.has(openingStateKey(floor.id, element.id));
    const nextOpeningState: ConfiguredOpeningState | null = openingState?.state === "open" ? "closed" : openingState ? "open" : null;
    const openingName = `${element.label ?? t(`planElement.${element.kind}` as TranslationKey)} ${index + 1}`;
    const stateLabel = openingState ? ` ${t("opening.state")} ${t(`opening.state.${openingState.state}` as TranslationKey)}.` : "";
    const geometryLabel = `${openingName}, ${floor.name}.${stateLabel} ${t("twin.elementWidth")} ${Number(geometry.width.toFixed(2))} ${t("twin.planUnit")}. ${t("twin.elementHeight")} ${geometry.height.toFixed(2)} m.`;
    const label = openingControlEnabled && openingState && nextOpeningState
      ? t("opening.toggleAria", {
        opening: `${openingName}, ${floor.name}`,
        state: t(`opening.state.${openingState.state}` as TranslationKey),
        action: t(`opening.state.${nextOpeningState}` as TranslationKey),
      })
      : geometryLabel;
    const verticalMidpoint = (a: ProjectedPoint3D, b: ProjectedPoint3D) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const bottomMid = verticalMidpoint(front[0]!, front[1]!);
    const topMid = verticalMidpoint(front[3]!, front[2]!);
    const leftMid = verticalMidpoint(front[0]!, front[3]!);
    const rightMid = verticalMidpoint(front[1]!, front[2]!);
    const frontXs = front.map((point) => point.x);
    const frontYs = front.map((point) => point.y);
    const hitPadding = 12;
    return (
      <g
        key={`${floor.id}:${element.id}`}
        className={`building-plan-element ${element.kind} ${openingState ? `opening-${openingState.state}` : ""} ${openingControlEnabled ? "opening-control" : ""} ${openingPending ? "pending" : ""} ${selected ? "selected" : ""} ${editing ? "editable" : ""}`}
        role={editing || openingControlEnabled ? "button" : "img"}
        tabIndex={editing || openingControlEnabled ? 0 : undefined}
        aria-label={label}
        aria-pressed={editing ? selected : openingControlEnabled ? openingState?.state === "open" : undefined}
        aria-busy={openingPending || undefined}
        data-element-id={element.id}
        data-floor-id={floor.id}
        data-kind={element.kind}
        data-width={geometry.width.toFixed(4)}
          data-height={geometry.height.toFixed(4)}
          data-bottom={geometry.bottom.toFixed(4)}
          data-depth={geometry.depth.toFixed(4)}
        data-opening-state={openingState?.state}
        data-opening-source={openingState?.source}
        onPointerDown={editing
          ? (event) => selectArchitecturalElement(event, floor.id, element.id)
          : openingControlEnabled
            ? (event) => { event.stopPropagation(); }
            : undefined}
        onClick={editing
          ? (event) => event.stopPropagation()
          : openingControlEnabled
            ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!openingPending && nextOpeningState) onOpeningStateChange?.(floor.id, element.id, nextOpeningState);
            }
            : (event) => {
              event.stopPropagation();
              activateFloor(floor.id);
            }}
        onKeyDown={editing
          ? (event) => selectArchitecturalElement(event, floor.id, element.id)
          : openingControlEnabled
            ? (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              if (!openingPending && nextOpeningState) onOpeningStateChange?.(floor.id, element.id, nextOpeningState);
            }
            : undefined}
      >
        <title>{label}</title>
        {(editing || openingControlEnabled) && <rect
          x={Math.min(...frontXs) - hitPadding}
          y={Math.min(...frontYs) - hitPadding}
          width={Math.max(...frontXs) - Math.min(...frontXs) + hitPadding * 2}
          height={Math.max(...frontYs) - Math.min(...frontYs) + hitPadding * 2}
          className="building-element-hit-target"
        />}
        {chimneyGeometry && <g className="building-chimney" data-vertical-extent="roof" data-bottom={chimneyGeometry.bottom.toFixed(4)} data-height={chimneyGeometry.height.toFixed(4)} data-width={chimneyGeometry.width.toFixed(4)} data-depth={chimneyGeometry.depth.toFixed(4)}>
          {chimneyBack && <polygon points={points(chimneyBack)} className="building-chimney-side" />}
          {chimneyLeft && <polygon points={points(chimneyLeft)} className="building-chimney-side" />}
          {chimneyRight && <polygon points={points(chimneyRight)} className="building-chimney-side" />}
          {chimneyTop && <polygon points={points(chimneyTop)} className="building-chimney-cap" />}
          {chimneyFront && <polygon points={points(chimneyFront)} className="building-chimney-front" />}
          {chimneyFront && [.12, .24, .36, .48, .6, .72, .84].map((progress) => {
            const from = { x: chimneyFront[0]!.x + (chimneyFront[3]!.x - chimneyFront[0]!.x) * progress, y: chimneyFront[0]!.y + (chimneyFront[3]!.y - chimneyFront[0]!.y) * progress };
            const to = { x: chimneyFront[1]!.x + (chimneyFront[2]!.x - chimneyFront[1]!.x) * progress, y: chimneyFront[1]!.y + (chimneyFront[2]!.y - chimneyFront[1]!.y) * progress };
            return <line key={progress} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className="building-chimney-course" />;
          })}
        </g>}
        {back && <polygon points={points(back)} className="building-element-side building-element-back" />}
        {left && <polygon points={points(left)} className="building-element-side building-element-left" />}
        {right && <polygon points={points(right)} className="building-element-side building-element-right" />}
        {top && <polygon points={points(top)} className="building-element-side building-element-top" />}
        <polygon points={points(front)} className="building-element-front" />
        {element.kind === "window" && <>
          <line x1={bottomMid.x} y1={bottomMid.y} x2={topMid.x} y2={topMid.y} className="building-window-frame" />
          <line x1={leftMid.x} y1={leftMid.y} x2={rightMid.x} y2={rightMid.y} className="building-window-frame" />
        </>}
        {element.kind === "door" && <circle cx={(front[0]!.x * .24 + front[1]!.x * .66 + front[2]!.x * .1)} cy={(front[0]!.y * .24 + front[1]!.y * .66 + front[2]!.y * .1)} r="3.2" className="building-door-handle" />}
        {element.kind === "fireEscape" && (element.variant ?? "ladder") === "ladder" && <g className="building-fire-escape-detail">
          {[.14, .29, .44, .59, .74, .89].map((progress) => {
            const from = { x: front[0]!.x + (front[3]!.x - front[0]!.x) * progress, y: front[0]!.y + (front[3]!.y - front[0]!.y) * progress };
            const to = { x: front[1]!.x + (front[2]!.x - front[1]!.x) * progress, y: front[1]!.y + (front[2]!.y - front[1]!.y) * progress };
            return <line key={progress} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
          })}
          <line x1={front[0]!.x} y1={front[0]!.y} x2={front[3]!.x} y2={front[3]!.y} />
          <line x1={front[1]!.x} y1={front[1]!.y} x2={front[2]!.x} y2={front[2]!.y} />
        </g>}
        {element.kind === "fireEscape" && element.variant === "stairs" && <g className="building-fire-escape-detail stairs">
          <line x1={front[0]!.x} y1={front[0]!.y} x2={front[2]!.x} y2={front[2]!.y} />
          {[.18, .36, .54, .72, .9].map((progress) => {
            const point = { x: front[0]!.x + (front[2]!.x - front[0]!.x) * progress, y: front[0]!.y + (front[2]!.y - front[0]!.y) * progress };
            const end = { x: front[1]!.x + (front[2]!.x - front[1]!.x) * progress, y: front[1]!.y + (front[2]!.y - front[1]!.y) * progress };
            return <line key={progress} x1={point.x} y1={point.y} x2={end.x} y2={end.y} />;
          })}
        </g>}
        {openingState && <circle cx={topMid.x} cy={topMid.y - 8} r="4.5" className="building-opening-state-dot" aria-hidden="true" />}
        {element.kind === "fireplace" && <path d={`M${bottomMid.x.toFixed(1)} ${bottomMid.y.toFixed(1)}Q${((leftMid.x + rightMid.x) / 2 - 7).toFixed(1)} ${((leftMid.y + rightMid.y) / 2 + 3).toFixed(1)} ${topMid.x.toFixed(1)} ${topMid.y.toFixed(1)}Q${((leftMid.x + rightMid.x) / 2 + 9).toFixed(1)} ${((leftMid.y + rightMid.y) / 2 + 5).toFixed(1)} ${bottomMid.x.toFixed(1)} ${bottomMid.y.toFixed(1)}Z`} className="building-fireplace-flame" />}
        {selected && <polygon points={points(front)} className="building-element-selection" />}
      </g>
    );
  };

  const observationName = (observation: ManualObservation) => t(`observations.${observation.kind === "note" ? "noteKind" : observation.kind}` as TranslationKey);

  return (
    <div className="building-scene">
      <div className="building-scene-controls">
        <div><span className="eyebrow">{t("building.title")}</span><strong>{house.name}</strong></div>
        <div className="building-orbit-controls" role="group" aria-label={t("building.cameraControls")}>
          <button type="button" className="secondary-button" aria-label={t("building.rotateLeft")} onClick={() => rotateCamera(-.22, 0)}>↶</button>
          <button type="button" className="secondary-button" aria-label={t("building.rotateRight")} onClick={() => rotateCamera(.22, 0)}>↷</button>
          <button type="button" className="secondary-button" aria-label={t("building.tiltUp")} onClick={() => rotateCamera(0, .13)}>↑</button>
          <button type="button" className="secondary-button" aria-label={t("building.tiltDown")} onClick={() => rotateCamera(0, -.13)}>↓</button>
          <label className="building-zoom"><span>{t("building.zoom")}</span><input aria-label={t("building.zoom")} type="range" min="0.55" max="1.75" step="0.05" value={camera.zoom} onChange={(event) => changeCamera({ zoom: Number(event.target.value) })} /></label>
          <button type="button" className="secondary-button building-reset" onClick={() => setCamera(DEFAULT_CAMERA)}>{t("building.resetView")}</button>
          <output className="sr-only building-camera-state">{t("building.cameraState", {
            yaw: Math.round(camera.yaw * 180 / Math.PI), pitch: Math.round(camera.pitch * 180 / Math.PI), zoom: camera.zoom.toFixed(2),
          })}</output>
        </div>
      </div>
      {editing && <div className="building-element-editor" role="region" aria-label={t("twin.elementProperties")}>
        <div className="building-element-editor-heading">
          <span className="eyebrow">{t("twin.planElements")}</span>
          <strong>{selectedElement
            ? t(`planElement.${selectedElement.kind}` as TranslationKey)
            : t("twin.elementProperties")}</strong>
          {selectedElementFloor && <small>{selectedElementFloor.name}</small>}
        </div>
        {onFloorChange && <div className="building-element-add" role="group" aria-label={t("opening.addIn3d")}>
          <label><span>{t("twin.planElement")}</span><select value={addableOpeningKind} onChange={(event) => { setAddableOpeningKind(event.currentTarget.value as AddableOpeningKind); setOpeningEditorMessage(null); }}><option value="door">{t("planElement.door")}</option><option value="window">{t("planElement.window")}</option><option value="vent">{t("planElement.vent")}</option><option value="fireEscape">{t("planElement.fireEscape")}</option></select></label>
          <button type="button" className="tool-button" onClick={addOpeningIn3d}>{t("opening.addIn3d")}</button>
        </div>}
        {openingEditorMessage && <p className="editor-properties-note" role="status">{openingEditorMessage}</p>}
        <OpeningInventory floors={house.floors} selected={selectedElementKey} onSelect={(floorId, elementId) => { onFloorSelect(floorId); setSelectedElementKey({ floorId, elementId }); }} />
        {selectedElement && selectedElementFloor && selectedWidthBounds && selectedHeightBounds
          ? <>
            <PlanElementDimensionFields
              widthLabel={t("twin.elementWidth")}
              heightLabel={t("twin.elementHeight")}
              planUnitLabel={t("twin.planUnit")}
              metreLabel="m"
              width={selectedElement.width ?? defaultPlanElementWidth(selectedElementFloor, selectedElement.kind)}
              height={effectivePlanElementHeight(selectedElementFloor, selectedElement)}
              widthBounds={selectedWidthBounds}
              heightBounds={selectedHeightBounds}
              onWidthChange={updateSelectedWidth}
              onHeightChange={updateSelectedHeight}
            />
            {isAirflowPlanElement(selectedElement) && <PlanElementAirflowFields floor={selectedElementFloor} element={selectedElement} onChange={(patch) => updateSelectedElement(patch)} />}
            {(selectedElement.kind === "fireplace" || selectedElement.kind === "fireEscape") && <PlanElementFixtureFields floor={selectedElementFloor} element={selectedElement} planUnitLabel={t("twin.planUnit")} onChange={(patch) => updateSelectedElement(patch)} />}
            <button type="button" className="tool-button danger-tool building-element-delete" onClick={deleteSelectedElement}>{t("twin.deleteElement")}</button>
          </>
          : <p>{t("building.editElementHelp")}</p>}
      </div>}
      <div className="building-viewport">
        <svg
          className="building-svg" viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} role="group"
          aria-label={t("building.aria", { house: house.name, floors: house.floors.length, sensors: sensors.filter((sensor) => sensor.enabled).length, metric: metricLabel })}
          data-camera-yaw={camera.yaw.toFixed(3)} data-camera-pitch={camera.pitch.toFixed(3)} data-camera-zoom={camera.zoom.toFixed(2)}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endPointer} onPointerCancel={endPointer} onWheel={onWheel}
        >
          <desc>{spatialLayerSnapshots.length || experimentalSensorCoverage || experimentalAirflowEnabled
            ? t("spatial.buildingDescription")
            : allValues.length
              ? t("building.volumeDescription", { metric: metricLabel })
              : definition.spatialInterpolation
                ? t("twin.estimateUnavailable", { metric: metricLabel })
                : t("building.noSpatial", { metric: metricLabel })}</desc>
          <defs>
            <marker id={markerId} markerWidth="9" markerHeight="9" refX="8" refY="4.5" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L9 4.5L0 9Z" className="building-arrow-head" /></marker>
            <marker id={`${markerId}-vertical`} markerWidth="9" markerHeight="9" refX="8" refY="4.5" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L9 4.5L0 9Z" className="vertical-arrow-head" /></marker>
            <marker id={`${markerId}-airflow`} markerWidth="9" markerHeight="9" refX="8" refY="4.5" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L9 4.5L0 9Z" className="simulated-flow-arrow-head" /></marker>
            <marker id={`${markerId}-airflow-vertical`} markerWidth="9" markerHeight="9" refX="8" refY="4.5" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L9 4.5L0 9Z" className="simulated-flow-arrow-head" /></marker>
            <filter id={`${markerId}-shadow`} x="-80%" y="-80%" width="260%" height="260%"><feDropShadow dx="0" dy="4" stdDeviation="5" floodOpacity=".24" /></filter>
            <filter id={`${markerId}-cloud-soften`} x="-35%" y="-35%" width="170%" height="170%"><feGaussianBlur stdDeviation="7" /></filter>
            {projectedClouds.map(({ blob }) => (
              <radialGradient key={blob.id} id={`${markerId}-cloud-${svgToken(blob.id)}`}>
                <stop offset="0" stopColor={blob.color} stopOpacity={Math.min(.78, blob.opacity + .32)} />
                <stop offset="52%" stopColor={blob.color} stopOpacity={blob.opacity} />
                <stop offset="100%" stopColor={blob.color} stopOpacity="0" />
              </radialGradient>
            ))}
          </defs>

          {outdoorShellProjected && outdoorShellRail && (
            <g className={`building-outdoor-shell ${activeOutdoorColor ? "compared" : ""} ${outdoorContext?.stale ? "stale" : ""}`} style={activeOutdoorStyle} role="img" aria-label={outdoorShellLabel}>
              <polygon points={points(outdoorShellProjected.top)} className="building-outdoor-shell-face" />
              <polygon points={points(outdoorShellProjected.bottom)} className="building-outdoor-shell-outline building-outdoor-shell-bottom" />
              <polygon points={points(outdoorShellProjected.top)} className="building-outdoor-shell-outline building-outdoor-shell-top" />
              {outdoorWindwardProjected && (
                <line
                  x1={outdoorWindwardProjected.start.x}
                  y1={outdoorWindwardProjected.start.y}
                  x2={outdoorWindwardProjected.end.x}
                  y2={outdoorWindwardProjected.end.y}
                  className="building-outdoor-windward-edge"
                  data-windward-edge={outdoorWindwardProjected.edge}
                  aria-hidden="true"
                />
              )}
              {outdoorShellProjected.top.map((point, index) => (
                <line
                  key={index}
                  x1={point.x}
                  y1={point.y}
                  x2={outdoorShellProjected.bottom[index]!.x}
                  y2={outdoorShellProjected.bottom[index]!.y}
                  className="building-outdoor-shell-edge"
                />
              ))}
              <line
                x1={outdoorShellRail.anchor.x}
                y1={outdoorShellRail.anchor.y}
                x2={outdoorShellRail.x + 209}
                y2={outdoorShellRail.y + 53}
                className="building-outdoor-shell-connector"
              />
              <g transform={`translate(${outdoorShellRail.x} ${outdoorShellRail.y})`} className="building-outdoor-shell-rail">
                <g className="outdoor-shell-chip building-shell-title">
                  <rect width="132" height="52" rx="26" />
                  <text x="66" y="31" textAnchor="middle"><tspan className="outdoor-shell-chip-label">{t("outdoor.shellLabel")}</tspan></text>
                </g>
                <g transform="translate(140 0)" className={`outdoor-shell-chip building-temperature-chip ${outdoorTemperatureColor ? "condition-color" : ""}`} style={outdoorTemperatureStyle}>
                  <rect width="136" height="52" rx="26" />
                  <text x="68" y="18" textAnchor="middle"><tspan className="outdoor-shell-chip-label">{t("outdoor.shellTemperature")}</tspan></text>
                  <text x="68" y="38" textAnchor="middle"><tspan className="outdoor-shell-chip-value">{outdoorTemperature ?? t("common.noData")}</tspan></text>
                </g>
                <g transform="translate(284 0)" className={`outdoor-shell-chip building-humidity-chip ${outdoorHumidityColor ? "condition-color" : ""}`} style={outdoorHumidityStyle}>
                  <rect width="136" height="52" rx="26" />
                  <text x="68" y="18" textAnchor="middle"><tspan className="outdoor-shell-chip-label">{t("outdoor.shellHumidity")}</tspan></text>
                  <text x="68" y="38" textAnchor="middle"><tspan className="outdoor-shell-chip-value">{outdoorHumidity ?? t("common.noData")}</tspan></text>
                </g>
              </g>
            </g>
          )}

          <g className="building-floors">
            {orderedFloors.map(({ floor, floorSensors, average }) => {
              const z = floor.elevation;
              const wallHeight = floor.roof?.style === "flat"
                ? roofEavesZ(floor) - floor.elevation
                : floor.wallHeight ?? floor.ceilingHeight ?? DEFAULT_CEILING_HEIGHT_METRES;
              const surface = [project({ x: 0, y: 0, z }), project({ x: floor.width, y: 0, z }), project({ x: floor.width, y: floor.height, z }), project({ x: 0, y: floor.height, z })];
              const slabBottom = [project({ x: 0, y: 0, z: z - .12 }), project({ x: floor.width, y: 0, z: z - .12 }), project({ x: floor.width, y: floor.height, z: z - .12 }), project({ x: 0, y: floor.height, z: z - .12 })];
              const active = floor.id === activeFloorId;
              const averageLabel = average == null ? t("common.noData") : formatMeasurement(average, definition, units);
              const labelPoint = surface.reduce((best, point) => point.x > best.x ? point : best, surface[0]!);
              return (
                <g
                  key={floor.id} className={`building-floor ${active ? "active" : ""}`} role={editing ? "group" : "button"} tabIndex={editing ? undefined : 0}
                  data-wall-height={wallHeight.toFixed(3)}
                  aria-pressed={editing ? undefined : active} aria-label={t("building.floorAria", { floor: floor.name, height: floor.elevation.toFixed(1), sensors: floorSensors.length, metric: metricLabel, value: averageLabel })}
                  onClick={() => activateFloor(floor.id)} onKeyDown={editing ? undefined : (event) => floorKeyDown(event, floor.id)}
                >
                  <polygon points={points([surface[1]!, surface[2]!, slabBottom[2]!, slabBottom[1]!])} className="floor-slab-side" />
                  <polygon points={points([surface[2]!, surface[3]!, slabBottom[3]!, slabBottom[2]!])} className="floor-slab-front" />
                  <polygon points={points(surface)} className="floor-surface" />
                  <g className="building-room-surfaces" aria-hidden="true">{floor.rooms.filter((room) => room.points.length >= 3).map((room) => (
                    <polygon
                      key={room.id}
                      points={points(room.points.map((point) => project({ ...point, z: z + .018 })))}
                      className="building-room-surface"
                      data-room-id={room.id}
                    />
                  ))}</g>
                  <g className="building-walls" aria-hidden="true">{floor.walls.map((wall) => {
                    const face = [
                      project({ x: wall.from.x, y: wall.from.y, z: z + .03 }),
                      project({ x: wall.to.x, y: wall.to.y, z: z + .03 }),
                      project({ x: wall.to.x, y: wall.to.y, z: z + wallHeight }),
                      project({ x: wall.from.x, y: wall.from.y, z: z + wallHeight }),
                    ];
                    return <g key={wall.id} data-wall-id={wall.id}>
                      <polygon points={points(face)} className="building-wall-face" />
                      <line x1={face[3]!.x} y1={face[3]!.y} x2={face[2]!.x} y2={face[2]!.y} className="building-wall-top" />
                    </g>;
                  })}</g>
                  <g className="building-floor-label" aria-hidden="true" transform={`translate(${Math.min(VIEW_WIDTH - 184, labelPoint.x + 10)} ${Math.max(8, labelPoint.y - 40)})`}>
                    <rect width="176" height="43" rx="9" />
                    <text x="11" y="17">{visualLabel(floor.name, 22)}</text>
                    <text x="11" y="33" className="sub-label">{t("building.floorSummary", { height: floor.elevation.toFixed(1), value: averageLabel })}</text>
                  </g>
                </g>
              );
            })}
          </g>

          {!editing && <g className="building-plan-elements building-plan-elements-live">
            {orderedFloors.flatMap(({ floor }) => (floor.planElements ?? []).map((element, index) => renderArchitecturalElement(floor, element, index)))}
          </g>}

          <g className="building-roofs">
            {orderedFloors.flatMap(({ floor }) => roofSurfaces(floor).map((surface, index) => (
              <polygon key={`${floor.id}:roof:${index}`} points={points(surface.map(project))} className={`building-roof-face roof-${floor.roof?.style ?? "none"}`} data-floor-id={floor.id} />
            )))}
          </g>

          <g className="building-clouds building-volume-clouds" filter={`url(#${markerId}-cloud-soften)`} aria-hidden="true">
            {projectedClouds.map(({ blob, center, radiusX, radiusY, angle }) => (
              <ellipse
                key={blob.id} className={`building-cloud-lobe building-volume-cloud volume-cloud ${blob.level}`}
                cx={center.x} cy={center.y} rx={radiusX} ry={radiusY}
                transform={`rotate(${angle.toFixed(1)} ${center.x.toFixed(1)} ${center.y.toFixed(1)})`}
                fill={`url(#${markerId}-cloud-${svgToken(blob.id)})`}
                data-world-x={blob.x.toFixed(2)} data-world-y={blob.y.toFixed(2)} data-world-z={blob.z.toFixed(2)} data-depth={center.depth.toFixed(4)}
              />
            ))}
          </g>

          {!editing && experimentalSensorCoverage && (
            <ExperimentalSensorCoverage3D house={house} assessment={experimentalSensorCoverage} project={project} />
          )}

          {!editing && spatialLayerSnapshots.length > 0 && (
            <SpatialLayerOverlay3D house={house} snapshots={spatialLayerSnapshots} topology={spatialLayerTopology} project={project} />
          )}

          {airflowPaths.length > 0 && <g className="building-volume-flows building-simulated-airflow" role="img" aria-label={airflowAria}>
            <title>{airflowAria}</title>
            {airflowPaths.map((flow) => {
              const projected = flow.points.map((point) => project(point));
              const path = smoothProjectedAirflowPath(projected);
              const fromPoint = flow.points[0]!;
              const toPoint = flow.points.at(-1)!;
              return (
                <g
                  key={flow.id}
                  className={`building-volume-vector volume-flow-vector simulated-volume-flow ${flow.hasVerticalComponent ? "has-z" : "planar"}`}
                  aria-hidden="true"
                  data-floor-id={flow.floorId}
                  data-from-z={fromPoint.z.toFixed(3)} data-to-z={toPoint.z.toFixed(3)}
                  data-from-x={fromPoint.x.toFixed(2)} data-to-x={toPoint.x.toFixed(2)} data-from-y={fromPoint.y.toFixed(2)} data-to-y={toPoint.y.toFixed(2)}
                  data-dx={(toPoint.x - fromPoint.x).toFixed(3)} data-dy={(toPoint.y - fromPoint.y).toFixed(3)} data-dz={(toPoint.z - fromPoint.z).toFixed(3)}
                  data-relative-speed={flow.relativeSpeed.toFixed(3)} data-support={flow.support.toFixed(3)}
                >
                  <path d={path} className="building-flow-path simulated-building-flow-path" markerEnd={`url(#${markerId}-airflow${flow.hasVerticalComponent ? "-vertical" : ""})`} />
                  {!reducedMotion && <circle r="4.5" className="building-flow-particle simulated-flow-particle"><animateMotion dur="3.4s" repeatCount="indefinite" path={path} /></circle>}
                </g>
              );
            })}
          </g>}

          {activeGradientFlows.length > 0 && <g className="building-volume-flows building-gradient-flows" aria-label={t("twin.flow")}>
            {activeGradientFlows.map((flow, index) => {
              const from = project(flow.from);
              const to = project(flow.to);
              const path = `M${from.x.toFixed(1)} ${from.y.toFixed(1)}L${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
              const dx = flow.to.x - flow.from.x;
              const dy = flow.to.y - flow.from.y;
              const dz = flow.to.z - flow.from.z;
              const label = t("twin.gradientAria", {
                from: formatMeasurement(flow.from.value, definition, units),
                to: formatMeasurement(flow.to.value, definition, units),
                difference: formatMeasurementDelta(flow.difference, definition, units),
              });
              return (
                <g
                  key={flow.id} className={`building-volume-vector volume-flow-vector ${flow.hasVerticalComponent ? "has-z" : "planar"}`}
                  role="img" aria-label={label} data-from-z={flow.from.z.toFixed(3)} data-to-z={flow.to.z.toFixed(3)}
                  data-from-x={flow.from.x.toFixed(2)} data-to-x={flow.to.x.toFixed(2)} data-from-y={flow.from.y.toFixed(2)} data-to-y={flow.to.y.toFixed(2)}
                  data-dx={dx.toFixed(3)} data-dy={dy.toFixed(3)} data-dz={dz.toFixed(3)}
                >
                  <title>{label}</title>
                  <path d={path} className="building-flow-path" markerEnd={`url(#${markerId}${flow.hasVerticalComponent ? "-vertical" : ""})`} />
                  {!reducedMotion && <circle r="4.5" className="building-flow-particle"><animateMotion dur={`${2.7 + index * .22}s`} repeatCount="indefinite" path={path} /></circle>}
                </g>
              );
            })}
          </g>}

          <g className="building-observations">
            {observations.filter((observation) => observation.x != null && observation.y != null).map((observation) => {
              const model = floorModels.find((item) => item.floor.id === observation.floorId);
              if (!model) return null;
              const position = project({ x: observation.x!, y: observation.y!, z: model.floor.elevation + .18 });
              const status = observation.status ?? "open";
              const label = t("building.observationAria", {
                kind: observationName(observation), severity: t(`alerts.${observation.severity}`), floor: model.floor.name, note: observation.note,
                status: t(`observations.status.${status}`),
              });
              return (
                <g key={observation.id} transform={`translate(${position.x} ${position.y})`} className={`building-observation ${observation.severity} ${status}`} role="img" aria-label={label}>
                  <title>{label}</title><path d="M0-15C-8-15-14-9-14-1C-14 9 0 19 0 19S14 9 14-1C14-9 8-15 0-15Z" /><text textAnchor="middle" y="3">{status === "resolved" ? "✓" : "!"}</text>
                </g>
              );
            })}
          </g>

          <g className="building-sensors">
            {renderedSensors.flatMap(({ sensor, model, position, anchor }) => {
              const measurements = sensorMeasurements[sensor.id] ?? {};
              const energyDevice = isEnergyDeviceSensor(sensor, measurements);
              if (energyDevice && !energyDevicesVisible && !editing) return [];
              const energyStats = energyDeviceMapStats(measurements, [definition], units);
              const rawSample = energyDevice ? energyStats.power ?? energyStats.energy ?? undefined : samples[sensor.id];
              const fresh = isSpatialSampleFresh(rawSample, freshness);
              const sampleValue = !energyDevice && fresh ? measurementValue(rawSample, definition.id) : null;
              const value = energyDevice
                ? energyStats.short ?? t("twin.noEnergyStats")
                : sampleValue == null ? t("common.noData") : formatMeasurement(sampleValue, definition, units);
              const selected = sensor.id === selectedSensorId;
              const status = !fresh
                ? t("building.statusStale")
                : rawSample?.quality === "estimated"
                  ? t("building.statusEstimated")
                  : t("building.statusCurrent");
              const height = relativeSensorHeight(sensor, model.floor.elevation);
              const label = energyDevice
                ? t("building.energySensorAria", { sensor: sensor.name, floor: model.floor.name, height: height.toFixed(1), stats: value, status })
                : t("building.sensorAria", { sensor: sensor.name, floor: model.floor.name, height: height.toFixed(1), metric: metricLabel, value, status });
              return (
                <g
                  key={sensor.id} transform={`translate(${position.x} ${position.y})`} className={`building-sensor ${energyDevice ? "energy-device" : ""} ${selected ? "selected" : ""} ${!fresh ? "stale" : ""}`}
                  data-map-layer={energyDevice ? "energy-devices" : "sensors"}
                  role="button" tabIndex={0} aria-pressed={selected} aria-label={label}
                  onClick={(event) => selectSensor(event, sensor)} onKeyDown={(event) => selectSensor(event, sensor)}
                >
                  <title>{label}</title>
                  <line x1="0" y1="0" x2={anchor.x - position.x} y2={anchor.y - position.y} className="sensor-tether" aria-hidden="true" />
                  <circle r="34" className="building-sensor-hit" aria-hidden="true" />
                  <circle r="19" className="building-sensor-ring" />
                  <circle r="14" className="building-sensor-core" filter={`url(#${markerId}-shadow)`} />
                  {energyDevice
                    ? <path d="M2-10L-6 1H-1L-4 10L7-4H2Z" className="building-sensor-energy-glyph" aria-hidden="true" />
                    : <text textAnchor="middle" y="4" className="building-sensor-value">{sampleValue == null ? "—" : toDisplayValue(sampleValue, definition, units).toFixed(definition.precision)}</text>}
                  <text x="22" y={energyDevice ? -7 : -2} className="building-sensor-name">{visualLabel(sensor.name)}</text>
                  {energyDevice && <text x="22" y="9" className="building-sensor-energy-stats">{energyStats.short ?? "—"}</text>}
                </g>
              );
            })}
          </g>

          {editing && <g className="building-plan-elements building-plan-elements-editing">
            {orderedFloors.flatMap(({ floor }) => (floor.planElements ?? []).map((element, index) => renderArchitecturalElement(floor, element, index)))}
          </g>}

        </svg>
        {outdoor && <OutdoorConditionsBadge outdoor={outdoor} units={units} />}
      </div>
      <div className={`building-legend ${!editing && !mapInformationExpanded ? "collapsed" : ""}`}>
        {(editing || mapInformationExpanded) && <div id={mapInformationId} className="building-legend-content">
          {editing ? <span className="building-structure-sync">{t("building.structureSync")}</span> : <span>{!definition.spatialInterpolation
            ? t("building.noSpatial", { metric: metricLabel })
            : allValues.length > 0
              ? <><i className="heat-gradient" style={{ background: measurementGradient(definition) }} aria-hidden="true" />{t("twin.estimatedField", { metric: metricLabel })}: {formatMeasurement(heatMin, definition, units)} – {formatMeasurement(heatMax, definition, units)}</>
              : t("common.noData")}</span>}
          {!editing && airflowPaths.length > 0 && <span className="building-airflow-key experimental-layer-legend"><i className="volume-vector-key simulated" aria-hidden="true">↝</i><span><strong>{t("spatial.airflow.title")}</strong><small>{airflowDescription}</small></span></span>}
          {!editing && airflowPaths.length === 0 && definition.spatialInterpolation && activeGradientFlows.length > 0 && <span><i className="volume-vector-key" aria-hidden="true">↗</i>{t("building.xyzGradient")}</span>}
          {!editing && experimentalSensorCoverage && <span className="building-airflow-key coverage-layer-legend"><i className="volume-vector-key coverage" aria-hidden="true">◎</i><span><strong>{t("spatial.coverage.title")}</strong><small>{t("spatial.coverage.legend", { support: Math.round(experimentalSensorCoverage.coverageScore * 100) })}</small></span></span>}
          {!editing && spatialLayerSnapshots.length > 0 && <span className="building-airflow-key spatial-layer-legend"><i className="volume-vector-key" aria-hidden="true">⇢</i><span><strong>{t("spatial.title")}</strong><small>{t("spatial.inferenceDisclaimer")}</small></span></span>}
        </div>}
        {!editing && <MapInformationToggle
          controls={mapInformationId}
          expanded={mapInformationExpanded}
          onExpandedChange={setMapInformationExpanded}
        />}
      </div>
      {(editing || mapInformationExpanded) && <p className="building-help">{editing ? t("building.editElementHelp") : airflowPaths.length ? t("spatial.airflow.help3d") : t("building.help")}</p>}
    </div>
  );
}
