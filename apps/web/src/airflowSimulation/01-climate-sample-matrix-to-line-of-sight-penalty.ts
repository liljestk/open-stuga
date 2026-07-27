import {
  configuredPlanElementOpeningState,
  isAirflowPlanElement,
  resolvePlanElementOpeningState,
  type AirflowPlanElement,
  type Floor,
  type House,
  type MeasurementSample,
  type OpeningStateObservation,
  type PlanElement,
  type Point,
  type Sensor,
  type VentPlanElement,
} from "@climate-twin/contracts";
import type { OutdoorBoundaryContext, PlanEdge } from "../outdoorContext";
import { defaultPlanElementWidth, effectivePlanElementHeight, planElementBottomOffset } from "../planElementGeometry";
import { isSpatialSampleFresh, type SpatialFreshnessOptions } from "../spatialFreshness";

/**
 * This is deliberately a relative-motion model, not a calibrated CFD result.
 * Plan x/y coordinates are not guaranteed to be metres, so the solver works in
 * a normalized room volume and never exposes its velocity as m/s.
 */
export type ClimateSampleMatrix = Record<string, Partial<Record<string, MeasurementSample>>>;

export type AirflowDataSupport = "low" | "medium" | "high";

export interface AirflowPoint2D extends Point {
  /** Upward (+) or downward (-) component at this plan position. */
  vertical: number;
}

export interface AirflowPoint3D extends Point {
  z: number;
}

export interface AirflowPath2D {
  id: string;
  points: AirflowPoint2D[];
  relativeSpeed: number;
  support: number;
  verticalTendency: number;
}

export interface AirflowPath3D {
  id: string;
  floorId: string;
  points: AirflowPoint3D[];
  relativeSpeed: number;
  support: number;
  hasVerticalComponent: boolean;
}

export interface AirflowEvidence {
  temperatureSensors: number;
  humiditySensors: number;
  tracerSensors: number;
  windDriven: boolean;
  doorOpenings: number;
  windowOpenings: number;
  ventOpenings: number;
  counterflowOpenings: number;
  pressureAssumed: boolean;
  support: AirflowDataSupport;
  /** RMS divergence after pressure projection, in normalized solver units. */
  divergenceRms: number;
}

export interface FloorAirflowEstimate {
  paths: AirflowPath2D[];
  evidence: AirflowEvidence;
}

export interface BuildingAirflowEstimate {
  paths: AirflowPath3D[];
  evidence: AirflowEvidence;
}

export interface ClimateAnchor {
  x: number;
  y: number;
  z: number;
  temperatureC: number;
  specificHumidity: number;
  virtualTemperatureK: number;
  co2: number | null;
  weight: number;
}

export interface NormalizedPoint3D {
  x: number;
  y: number;
  z: number;
}

export interface Velocity3D extends NormalizedPoint3D {
  support: number;
}

export interface SolverGrid {
  floor: Floor;
  anchors: ClimateAnchor[];
  nx: number;
  ny: number;
  nz: number;
  fluid: Uint8Array;
  blockX: Uint8Array;
  blockY: Uint8Array;
  u: Float64Array;
  v: Float64Array;
  w: Float64Array;
  support: Float64Array;
  temperature: Float64Array;
  humidity: Float64Array;
  tracer: Float64Array;
  tracerAvailable: boolean;
  maximumSpeed: number;
  divergenceRms: number;
  evidence: AirflowEvidence;
}

export interface BuildGridInput {
  floor: Floor;
  sensors: Sensor[];
  samples: ClimateSampleMatrix;
  freshness: SpatialFreshnessOptions;
  outdoor?: OutdoorBoundaryContext | null;
  openingStateObservations?: readonly OpeningStateObservation[];
}

export const STANDARD_PRESSURE_HPA = 1013.25;

export const GRAVITY_MPS2 = 9.80665;

export const DEFAULT_CEILING_HEIGHT_M = 2.8;

export const MIN_TEMPERATURE_ANCHORS = 2;

export const PRESSURE_ITERATIONS = 24;

export const STEADY_STEPS = 8;

export const FIELD_EPSILON = 1e-9;

export function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function qualityWeight(sample: MeasurementSample): number {
  return sample.quality === "estimated" ? .62 : sample.quality === "good" ? 1 : 0;
}

export function freshSample(
  samples: ClimateSampleMatrix,
  sensorId: string,
  metric: string,
  freshness: SpatialFreshnessOptions,
): MeasurementSample | null {
  const sample = samples[sensorId]?.[metric];
  return sample && isSpatialSampleFresh(sample, freshness) ? sample : null;
}

/** Buck (1981-style) saturation vapour pressure approximation over water. */
export function saturationVapourPressureHpa(temperatureC: number): number {
  return 6.1121 * Math.exp((18.678 - temperatureC / 234.5) * (temperatureC / (257.14 + temperatureC)));
}

/** Convert paired temperature/RH to specific humidity before interpolation. */
export function relativeHumidityToSpecificHumidity(
  temperatureC: number,
  relativeHumidityPercent: number,
  pressureHpa = STANDARD_PRESSURE_HPA,
): number {
  const pressure = clamp(pressureHpa, 700, 1_200);
  const vapourPressure = clamp(relativeHumidityPercent, 0, 100) / 100 * saturationVapourPressureHpa(temperatureC);
  const mixingRatio = .62198 * vapourPressure / Math.max(1, pressure - vapourPressure);
  return mixingRatio / (1 + mixingRatio);
}

export function specificHumidityToRelativeHumidity(
  temperatureC: number,
  specificHumidity: number,
  pressureHpa = STANDARD_PRESSURE_HPA,
): number {
  const pressure = clamp(pressureHpa, 700, 1_200);
  const q = clamp(specificHumidity, 0, .08);
  const mixingRatio = q / Math.max(FIELD_EPSILON, 1 - q);
  const vapourPressure = mixingRatio * pressure / (.62198 + mixingRatio);
  return clamp(vapourPressure / saturationVapourPressureHpa(temperatureC) * 100, 0, 100);
}

export function virtualTemperatureK(temperatureC: number, specificHumidity: number): number {
  return (temperatureC + 273.15) * (1 + .61 * specificHumidity);
}

export function ceilingHeight(floor: Floor): number {
  return Math.max(.8, floor.ceilingHeight ?? DEFAULT_CEILING_HEIGHT_M);
}

export function floorWithEffectiveOpeningStates(input: BuildGridInput): Floor {
  const observations = input.openingStateObservations?.filter((observation) => observation.floorId === input.floor.id);
  if (!observations?.length || !input.floor.planElements?.length) return input.floor;
  return {
    ...input.floor,
    planElements: input.floor.planElements.map((element): PlanElement => {
      if (!isAirflowPlanElement(element)) return element;
      const effective = resolvePlanElementOpeningState(element, observations, input.freshness.referenceTimeMs);
      return { ...element, state: effective.state, openFraction: effective.openFraction };
    }),
  };
}

export function effectiveGridInput(input: BuildGridInput): BuildGridInput {
  const floor = floorWithEffectiveOpeningStates(input);
  return floor === input.floor ? input : { ...input, floor };
}

export function anchorsForFloor(input: BuildGridInput): ClimateAnchor[] {
  const pressure = finite(input.outdoor?.conditions.pressureHpa)
    ? input.outdoor!.conditions.pressureHpa!
    : STANDARD_PRESSURE_HPA;
  const height = ceilingHeight(input.floor);
  const floorSensors = input.sensors.filter((sensor) => sensor.enabled && sensor.floorId === input.floor.id);
  const observedHumidity = floorSensors.flatMap((sensor) => {
    const humidity = freshSample(input.samples, sensor.id, "humidity", input.freshness);
    return humidity && finite(humidity.value) ? [humidity.value] : [];
  });
  const fallbackHumidity = observedHumidity.length
    ? observedHumidity.reduce((sum, value) => sum + value, 0) / observedHumidity.length
    : 50;
  return floorSensors.flatMap((sensor) => {
    const temperature = freshSample(input.samples, sensor.id, "temperature", input.freshness);
    if (!temperature || !finite(temperature.value)) return [];
    const humidity = freshSample(input.samples, sensor.id, "humidity", input.freshness);
    const co2 = freshSample(input.samples, sensor.id, "co2", input.freshness);
    const humidityValue = humidity && finite(humidity.value) ? humidity.value : fallbackHumidity;
    const specificHumidity = relativeHumidityToSpecificHumidity(temperature.value, humidityValue, pressure);
    const weight = qualityWeight(temperature) * (humidity ? (.78 + .22 * qualityWeight(humidity)) : .72);
    return [{
      x: clamp(sensor.x / Math.max(1, input.floor.width)),
      y: clamp(sensor.y / Math.max(1, input.floor.height)),
      z: clamp((sensor.z - input.floor.elevation) / height, .04, .96),
      temperatureC: temperature.value,
      specificHumidity,
      virtualTemperatureK: virtualTemperatureK(temperature.value, specificHumidity),
      co2: co2 && finite(co2.value) ? co2.value : null,
      weight,
    }];
  });
}

export function supportLevel(anchorCount: number, averageCoverage: number, pairedHumidityFraction: number): AirflowDataSupport {
  const score = clamp((anchorCount - 1) / 4) * .5 + clamp(averageCoverage) * .34 + clamp(pairedHumidityFraction) * .16;
  return score >= .72 ? "high" : score >= .42 ? "medium" : "low";
}

export function gridDimensions(floor: Floor): { nx: number; ny: number; nz: number } {
  const nx = 20;
  const aspect = floor.height / Math.max(1, floor.width);
  return { nx, ny: Math.max(10, Math.min(22, Math.round(nx * aspect))), nz: 6 };
}

export function index(grid: Pick<SolverGrid, "nx" | "ny">, x: number, y: number, z: number): number {
  return z * grid.nx * grid.ny + y * grid.nx + x;
}

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
    const a = polygon[current]!;
    const b = polygon[previous]!;
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function orientation(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

export function segmentIntersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const denominator = orientation(a, b, d) - orientation(a, b, c);
  if (Math.abs(denominator) <= FIELD_EPSILON) return null;
  const t = orientation(a, c, d) / denominator;
  const u = orientation(a, c, b) / denominator;
  if (t < -FIELD_EPSILON || t > 1 + FIELD_EPSILON || u < -FIELD_EPSILON || u > 1 + FIELD_EPSILON) return null;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function elementWidth(element: PlanElement, floor: Floor): number {
  return Math.max(element.width ?? defaultPlanElementWidth(floor, element.kind), Math.max(floor.width, floor.height) / 80);
}

export function openingIsActive(element: AirflowPlanElement): boolean {
  return configuredPlanElementOpeningState(element).openFraction > .01;
}

export function openingAllowsCrossing(floor: Floor, wallId: string, crossing: Point, heightAboveFloorM: number): boolean {
  return (floor.planElements ?? []).some((element) => {
    if ((element.kind !== "door" && element.kind !== "window") || element.wallId !== wallId || !openingIsActive(element)) return false;
    const effective = configuredPlanElementOpeningState(element);
    const bottom = planElementBottomOffset(floor, element);
    const top = bottom + effectivePlanElementHeight(floor, element);
    if (heightAboveFloorM < bottom - FIELD_EPSILON || heightAboveFloorM > top + FIELD_EPSILON) return false;
    const effectiveHalfWidth = elementWidth(element, floor) * .5 * effective.openFraction;
    return Math.hypot(element.position.x - crossing.x, element.position.y - crossing.y) <= effectiveHalfWidth + FIELD_EPSILON;
  });
}

export function blockedByWall(floor: Floor, from: Point, to: Point, heightAboveFloorM = (floor.ceilingHeight ?? DEFAULT_CEILING_HEIGHT_M) * .5): boolean {
  return floor.walls.some((wall) => {
    const crossing = segmentIntersection(from, to, wall.from, wall.to);
    return crossing !== null && !openingAllowsCrossing(floor, wall.id, crossing, heightAboveFloorM);
  });
}

export function rasterizeFluid(grid: SolverGrid): void {
  const roomPolygons = grid.floor.rooms.filter((room) => room.points.length >= 3);
  const candidate = new Uint8Array(grid.nx * grid.ny);
  let covered = 0;
  for (let y = 0; y < grid.ny; y += 1) {
    for (let x = 0; x < grid.nx; x += 1) {
      const point = { x: (x + .5) / grid.nx * grid.floor.width, y: (y + .5) / grid.ny * grid.floor.height };
      const inside = roomPolygons.length === 0 || roomPolygons.some((room) => pointInPolygon(point, room.points));
      candidate[y * grid.nx + x] = inside ? 1 : 0;
      if (inside) covered += 1;
    }
  }
  // Partial/in-progress room drawings should not erase most of the air domain.
  const useRoomMask = roomPolygons.length > 0 && covered / candidate.length >= .48;
  for (let z = 0; z < grid.nz; z += 1) {
    for (let y = 0; y < grid.ny; y += 1) {
      for (let x = 0; x < grid.nx; x += 1) {
        grid.fluid[index(grid, x, y, z)] = !useRoomMask || candidate[y * grid.nx + x] ? 1 : 0;
      }
    }
  }
}

export function rasterizeWalls(grid: SolverGrid): void {
  for (let z = 0; z < grid.nz; z += 1) {
    const heightAboveFloorM = (z + .5) / grid.nz * ceilingHeight(grid.floor);
    for (let y = 0; y < grid.ny; y += 1) {
      for (let x = 0; x < grid.nx - 1; x += 1) {
        const from = { x: (x + .5) / grid.nx * grid.floor.width, y: (y + .5) / grid.ny * grid.floor.height };
        const to = { x: (x + 1.5) / grid.nx * grid.floor.width, y: from.y };
        grid.blockX[z * grid.ny * (grid.nx - 1) + y * (grid.nx - 1) + x] = blockedByWall(grid.floor, from, to, heightAboveFloorM) ? 1 : 0;
      }
    }
    for (let y = 0; y < grid.ny - 1; y += 1) {
      for (let x = 0; x < grid.nx; x += 1) {
        const from = { x: (x + .5) / grid.nx * grid.floor.width, y: (y + .5) / grid.ny * grid.floor.height };
        const to = { x: from.x, y: (y + 1.5) / grid.ny * grid.floor.height };
        grid.blockY[z * (grid.ny - 1) * grid.nx + y * grid.nx + x] = blockedByWall(grid.floor, from, to, heightAboveFloorM) ? 1 : 0;
      }
    }
  }
}

export function faceOpen(grid: SolverGrid, x: number, y: number, z: number, dx: number, dy: number, dz: number): boolean {
  const nx = x + dx;
  const ny = y + dy;
  const nz = z + dz;
  if (nx < 0 || nx >= grid.nx || ny < 0 || ny >= grid.ny || nz < 0 || nz >= grid.nz) return false;
  if (!grid.fluid[index(grid, x, y, z)] || !grid.fluid[index(grid, nx, ny, nz)]) return false;
  if (dx === 1 && grid.blockX[z * grid.ny * (grid.nx - 1) + y * (grid.nx - 1) + x]) return false;
  if (dx === -1 && grid.blockX[z * grid.ny * (grid.nx - 1) + y * (grid.nx - 1) + x - 1]) return false;
  if (dy === 1 && grid.blockY[z * (grid.ny - 1) * grid.nx + y * grid.nx + x]) return false;
  if (dy === -1 && grid.blockY[z * (grid.ny - 1) * grid.nx + (y - 1) * grid.nx + x]) return false;
  return true;
}

export function lineOfSightPenalty(floor: Floor, point: Point, pointZ: number, anchor: ClimateAnchor): number {
  const anchorPoint = { x: anchor.x * floor.width, y: anchor.y * floor.height };
  return blockedByWall(floor, point, anchorPoint, (pointZ + anchor.z) * .5 * ceilingHeight(floor)) ? .07 : 1;
}
