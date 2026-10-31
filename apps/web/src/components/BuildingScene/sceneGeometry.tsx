import { type ConfiguredOpeningState, type ConnectedDeviceState, type Floor, type HeatPumpState, type House, type ManualObservation, type MeasurementDefinition, type MeasurementSample, type OpeningStateObservation, type PlanElement, type Sensor, type UnitSystem } from "@climate-twin/contracts";
import { type LatestMeasurements } from "../../measurements";
import { type BuildingAirflowEstimate, type ClimateSampleMatrix } from "../../airflowSimulation";
import {
  type CameraOrbit,
  type Point3D,
  type ProjectedPoint3D,
  type VolumeBounds,
  type VolumeCloudBlob,
} from "../../spatial/volume";
import {
  type OutdoorVisualizationState,
} from "../OutdoorConditionsBadge";
import { type AirflowPlanElementPatch } from "../PlanElementAirflowFields";
import { type FixturePlanElementPatch } from "../PlanElementFixtureFields";
import type { SpatialLayerSnapshot, SpatialTopology } from "../../spatial/layers";
import type { SensorCoverageAssessment } from "../../spatial/experimentalLayers";
import type { OutdoorInfluenceEstimate } from "../../outdoor/influence";
import {
  DEFAULT_CEILING_HEIGHT_METRES,
  defaultPlanElementWidth,
  defaultFireEscapeProjection,
  effectivePlanElementHeight,
  isWallAttachedPlanElement,
  isWallOpening,
  planElementBottomOffset,
} from "../../planElementGeometry";
import { fireplaceChimneyTop, isRoofSpanningFireplace, roofPeakZ } from "../../architecturalGeometry";

export interface BuildingSceneProps {
  house: House;
  sensors: Sensor[];
  samples: Record<string, MeasurementSample>;
  /** Metric-complete samples used by capability-specific markers such as energy plugs. */
  sensorMeasurements?: LatestMeasurements;
  climateSensorMarkersVisible?: boolean;
  energyDevicesVisible?: boolean;
  connectedDevices?: readonly ConnectedDeviceState[];
  connectedDevicesVisible?: boolean;
  pendingConnectedDeviceIds?: ReadonlySet<string>;
  heatPumps?: readonly HeatPumpState[];
  heatPumpInfluenceVisible?: boolean;
  selectedHeatPumpId?: string | null;
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
  mapAnimationsEnabled?: boolean;
  outdoorExtrasVisible?: boolean;
  editing?: boolean;
  spatialLayerSnapshots?: readonly SpatialLayerSnapshot[];
  spatialLayerTopology?: SpatialTopology | null;
  experimentalAirflowEnabled?: boolean;
  experimentalAirflow?: BuildingAirflowEstimate | null;
  experimentalSensorCoverage?: SensorCoverageAssessment | null;
  experimentalOutdoorInfluence?: OutdoorInfluenceEstimate | null;
  openingStateObservations?: readonly OpeningStateObservation[];
  openingStateLabelsVisible?: boolean;
  pendingOpeningStateKeys?: ReadonlySet<string>;
  onOpeningStateChange?: (floorId: string, elementId: string, state: ConfiguredOpeningState) => void;
  onConnectedDevicePowerChange?: (connectionId: string, power: boolean) => void;
  onHeatPumpSelect?: (connectionId: string, floorId: string) => void;
  onFloorSelect: (floorId: string) => void;
  onSensorSelect: (sensorId: string, floorId: string) => void;
  onFloorChange?: (floor: Floor) => void;
}

export interface ProjectedCloud {
  blob: VolumeCloudBlob;
  center: ProjectedPoint3D;
  radiusX: number;
  radiusY: number;
  angle: number;
}

export interface DragState {
  pointerId: number;
  x: number;
  y: number;
  camera: CameraOrbit;
  moved: boolean;
}

export type AddableOpeningKind = "door" | "window" | "vent" | "fireEscape";

export type SelectedElementPatch = AirflowPlanElementPatch & FixturePlanElementPatch & {
  width?: number;
  height?: number;
};

export const VIEW_WIDTH = 1100;

export const VIEW_HEIGHT = 720;

export const DEFAULT_CAMERA: CameraOrbit = { yaw: -.68, pitch: .63, zoom: 1 };

/**
 * The outdoor shell's chip rail in view units: a title chip, then temperature and humidity chips. The
 * reading chips fit the longest en/fi/sv label ("Outdoor temperature", about 118 units) inside their
 * rounded ends.
 */
const OUTDOOR_SHELL_RAIL_TITLE_WIDTH = 112;
const OUTDOOR_SHELL_RAIL_CHIP_WIDTH = 148;
const OUTDOOR_SHELL_RAIL_GAP = 8;
export const OUTDOOR_SHELL_RAIL = {
  titleWidth: OUTDOOR_SHELL_RAIL_TITLE_WIDTH,
  chipWidth: OUTDOOR_SHELL_RAIL_CHIP_WIDTH,
  gap: OUTDOOR_SHELL_RAIL_GAP,
  height: 52,
  width: OUTDOOR_SHELL_RAIL_TITLE_WIDTH + 2 * (OUTDOOR_SHELL_RAIL_GAP + OUTDOOR_SHELL_RAIL_CHIP_WIDTH),
} as const;

export function points(projected: ProjectedPoint3D[]): string {
  return projected.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
}

export function smoothProjectedAirflowPath(projected: ProjectedPoint3D[]): string {
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

export function svgToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function relativeSensorHeight(sensor: Sensor, floorElevation: number): number {
  return sensor.z - floorElevation;
}

export function visualLabel(value: string, maximumCharacters = 20): string {
  const characters = Array.from(value);
  return characters.length > maximumCharacters
    ? `${characters.slice(0, maximumCharacters - 1).join("")}…`
    : value;
}

export interface ElementWorldGeometry {
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

export function elementAxis(floor: Floor, element: PlanElement): { x: number; y: number } {
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
export function elementWorldGeometry(
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

export function inferReferenceTime(samples: Record<string, MeasurementSample>): number {
  const timestamps = Object.values(samples).map((sample) => Date.parse(sample.timestamp)).filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : Date.now();
}

export function buildingBounds(house: House, sensors: Sensor[]): VolumeBounds {
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

export function projectedCloud(
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
