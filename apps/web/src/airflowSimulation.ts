import {
  configuredPlanElementOpeningState,
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
import type { OutdoorBoundaryContext, PlanEdge } from "./outdoorContext";
import { defaultPlanElementWidth, effectivePlanElementHeight, planElementBottomOffset } from "./planElementGeometry";
import { isSpatialSampleFresh, type SpatialFreshnessOptions } from "./spatialFreshness";

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

interface ClimateAnchor {
  x: number;
  y: number;
  z: number;
  temperatureC: number;
  specificHumidity: number;
  virtualTemperatureK: number;
  co2: number | null;
  weight: number;
}

interface NormalizedPoint3D {
  x: number;
  y: number;
  z: number;
}

interface Velocity3D extends NormalizedPoint3D {
  support: number;
}

interface SolverGrid {
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

interface BuildGridInput {
  floor: Floor;
  sensors: Sensor[];
  samples: ClimateSampleMatrix;
  freshness: SpatialFreshnessOptions;
  outdoor?: OutdoorBoundaryContext | null;
  openingStateObservations?: readonly OpeningStateObservation[];
}

const STANDARD_PRESSURE_HPA = 1013.25;
const GRAVITY_MPS2 = 9.80665;
const DEFAULT_CEILING_HEIGHT_M = 2.8;
const MIN_TEMPERATURE_ANCHORS = 2;
const PRESSURE_ITERATIONS = 24;
const STEADY_STEPS = 8;
const FIELD_EPSILON = 1e-9;

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function qualityWeight(sample: MeasurementSample): number {
  return sample.quality === "estimated" ? .62 : sample.quality === "good" ? 1 : 0;
}

function freshSample(
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

function virtualTemperatureK(temperatureC: number, specificHumidity: number): number {
  return (temperatureC + 273.15) * (1 + .61 * specificHumidity);
}

function ceilingHeight(floor: Floor): number {
  return Math.max(.8, floor.ceilingHeight ?? DEFAULT_CEILING_HEIGHT_M);
}

function floorWithEffectiveOpeningStates(input: BuildGridInput): Floor {
  const observations = input.openingStateObservations?.filter((observation) => observation.floorId === input.floor.id);
  if (!observations?.length || !input.floor.planElements?.length) return input.floor;
  return {
    ...input.floor,
    planElements: input.floor.planElements.map((element): PlanElement => {
      if (element.kind === "fireplace") return element;
      const effective = resolvePlanElementOpeningState(element, observations, input.freshness.referenceTimeMs);
      return { ...element, state: effective.state, openFraction: effective.openFraction };
    }),
  };
}

function effectiveGridInput(input: BuildGridInput): BuildGridInput {
  const floor = floorWithEffectiveOpeningStates(input);
  return floor === input.floor ? input : { ...input, floor };
}

function anchorsForFloor(input: BuildGridInput): ClimateAnchor[] {
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

function supportLevel(anchorCount: number, averageCoverage: number, pairedHumidityFraction: number): AirflowDataSupport {
  const score = clamp((anchorCount - 1) / 4) * .5 + clamp(averageCoverage) * .34 + clamp(pairedHumidityFraction) * .16;
  return score >= .72 ? "high" : score >= .42 ? "medium" : "low";
}

function gridDimensions(floor: Floor): { nx: number; ny: number; nz: number } {
  const nx = 20;
  const aspect = floor.height / Math.max(1, floor.width);
  return { nx, ny: Math.max(10, Math.min(22, Math.round(nx * aspect))), nz: 6 };
}

function index(grid: Pick<SolverGrid, "nx" | "ny">, x: number, y: number, z: number): number {
  return z * grid.nx * grid.ny + y * grid.nx + x;
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
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

function orientation(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentIntersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const denominator = orientation(a, b, d) - orientation(a, b, c);
  if (Math.abs(denominator) <= FIELD_EPSILON) return null;
  const t = orientation(a, c, d) / denominator;
  const u = orientation(a, c, b) / denominator;
  if (t < -FIELD_EPSILON || t > 1 + FIELD_EPSILON || u < -FIELD_EPSILON || u > 1 + FIELD_EPSILON) return null;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function elementWidth(element: PlanElement, floor: Floor): number {
  return Math.max(element.width ?? defaultPlanElementWidth(floor, element.kind), Math.max(floor.width, floor.height) / 80);
}

function openingIsActive(element: AirflowPlanElement): boolean {
  return configuredPlanElementOpeningState(element).openFraction > .01;
}

function openingAllowsCrossing(floor: Floor, wallId: string, crossing: Point, heightAboveFloorM: number): boolean {
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

function blockedByWall(floor: Floor, from: Point, to: Point, heightAboveFloorM = (floor.ceilingHeight ?? DEFAULT_CEILING_HEIGHT_M) * .5): boolean {
  return floor.walls.some((wall) => {
    const crossing = segmentIntersection(from, to, wall.from, wall.to);
    return crossing !== null && !openingAllowsCrossing(floor, wall.id, crossing, heightAboveFloorM);
  });
}

function rasterizeFluid(grid: SolverGrid): void {
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

function rasterizeWalls(grid: SolverGrid): void {
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

function faceOpen(grid: SolverGrid, x: number, y: number, z: number, dx: number, dy: number, dz: number): boolean {
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

function lineOfSightPenalty(floor: Floor, point: Point, pointZ: number, anchor: ClimateAnchor): number {
  const anchorPoint = { x: anchor.x * floor.width, y: anchor.y * floor.height };
  return blockedByWall(floor, point, anchorPoint, (pointZ + anchor.z) * .5 * ceilingHeight(floor)) ? .07 : 1;
}

function interpolateScalars(grid: SolverGrid, anchors: ClimateAnchor[]): void {
  const tracerAnchors = anchors.filter((anchor) => anchor.co2 !== null);
  grid.tracerAvailable = tracerAnchors.length >= 2;
  for (let z = 0; z < grid.nz; z += 1) {
    for (let y = 0; y < grid.ny; y += 1) {
      for (let x = 0; x < grid.nx; x += 1) {
        const cellIndex = index(grid, x, y, z);
        if (!grid.fluid[cellIndex]) continue;
        const point = { x: (x + .5) / grid.nx, y: (y + .5) / grid.ny, z: (z + .5) / grid.nz };
        const worldPoint = { x: point.x * grid.floor.width, y: point.y * grid.floor.height };
        let total = 0;
        let temperature = 0;
        let humidity = 0;
        let tracer = 0;
        let tracerTotal = 0;
        let nearest = Number.POSITIVE_INFINITY;
        anchors.forEach((anchor) => {
          const distanceSquared = Math.max(.012 ** 2,
            (point.x - anchor.x) ** 2 + (point.y - anchor.y) ** 2 + ((point.z - anchor.z) * .72) ** 2);
          const distance = Math.sqrt(distanceSquared);
          nearest = Math.min(nearest, distance);
          const weight = anchor.weight * lineOfSightPenalty(grid.floor, worldPoint, point.z, anchor) / distanceSquared;
          total += weight;
          temperature += anchor.temperatureC * weight;
          humidity += anchor.specificHumidity * weight;
          if (anchor.co2 !== null) {
            tracer += anchor.co2 * weight;
            tracerTotal += weight;
          }
        });
        grid.temperature[cellIndex] = temperature / Math.max(FIELD_EPSILON, total);
        grid.humidity[cellIndex] = humidity / Math.max(FIELD_EPSILON, total);
        grid.tracer[cellIndex] = tracerTotal ? tracer / tracerTotal : 0;
        grid.support[cellIndex] = clamp(1 - (nearest - .03) / .54) * clamp(total / (total + 7));
      }
    }
  }
}

function neighborValue(grid: SolverGrid, values: Float64Array, x: number, y: number, z: number, dx: number, dy: number, dz: number): number {
  const current = values[index(grid, x, y, z)]!;
  return faceOpen(grid, x, y, z, dx, dy, dz) ? values[index(grid, x + dx, y + dy, z + dz)]! : current;
}

function diffuseVelocity(grid: SolverGrid): void {
  const nextU = new Float64Array(grid.u.length);
  const nextV = new Float64Array(grid.v.length);
  const nextW = new Float64Array(grid.w.length);
  for (let z = 0; z < grid.nz; z += 1) {
    for (let y = 0; y < grid.ny; y += 1) {
      for (let x = 0; x < grid.nx; x += 1) {
        const cellIndex = index(grid, x, y, z);
        if (!grid.fluid[cellIndex]) continue;
        for (const [source, target] of [[grid.u, nextU], [grid.v, nextV], [grid.w, nextW]] as const) {
          const average = (
            neighborValue(grid, source, x, y, z, 1, 0, 0)
            + neighborValue(grid, source, x, y, z, -1, 0, 0)
            + neighborValue(grid, source, x, y, z, 0, 1, 0)
            + neighborValue(grid, source, x, y, z, 0, -1, 0)
            + neighborValue(grid, source, x, y, z, 0, 0, 1)
            + neighborValue(grid, source, x, y, z, 0, 0, -1)
          ) / 6;
          target[cellIndex] = source[cellIndex]! * .82 + average * .18;
        }
      }
    }
  }
  grid.u.set(nextU);
  grid.v.set(nextV);
  grid.w.set(nextW);
}

function boundaryDistance(point: Point, edge: PlanEdge, floor: Floor): number {
  if (edge === "left") return point.x / Math.max(1, floor.width);
  if (edge === "right") return (floor.width - point.x) / Math.max(1, floor.width);
  if (edge === "top") return point.y / Math.max(1, floor.height);
  return (floor.height - point.y) / Math.max(1, floor.height);
}

function windwardWindows(floor: Floor, outdoor?: OutdoorBoundaryContext | null): Array<Extract<PlanElement, { kind: "window" }>> {
  const edge = outdoor?.windwardEdge;
  if (!edge || outdoor.stale || !outdoor.inwardVector || !finite(outdoor.conditions.windSpeedMps)) return [];
  return (floor.planElements ?? []).filter((element) => element.kind === "window"
    && openingIsActive(element) && boundaryDistance(element.position, edge, floor) <= .15) as Array<Extract<PlanElement, { kind: "window" }>>;
}

function activeVents(floor: Floor): VentPlanElement[] {
  return (floor.planElements ?? []).filter((element): element is VentPlanElement => element.kind === "vent" && openingIsActive(element));
}

function addForces(grid: SolverGrid, anchors: ClimateAnchor[], outdoor?: OutdoorBoundaryContext | null): void {
  const referenceVirtualTemperature = anchors.reduce((sum, anchor) => sum + anchor.virtualTemperatureK * anchor.weight, 0)
    / Math.max(FIELD_EPSILON, anchors.reduce((sum, anchor) => sum + anchor.weight, 0));
  const windows = windwardWindows(grid.floor, outdoor);
  const vents = activeVents(grid.floor).filter((vent) => ["supply", "extract", "balanced"].includes(vent.variant ?? "passive"));
  const windSpeed = outdoor?.conditions.windSpeedMps ?? 0;
  const windStrength = windows.length && outdoor?.inwardVector ? clamp(windSpeed / 12, 0, .75) : 0;
  for (let z = 0; z < grid.nz; z += 1) {
    for (let y = 0; y < grid.ny; y += 1) {
      for (let x = 0; x < grid.nx; x += 1) {
        const cellIndex = index(grid, x, y, z);
        if (!grid.fluid[cellIndex]) continue;
        const q = grid.humidity[cellIndex]!;
        const virtual = virtualTemperatureK(grid.temperature[cellIndex]!, q);
        const buoyancy = GRAVITY_MPS2 * (virtual - referenceVirtualTemperature) / referenceVirtualTemperature;
        // No-penetration floor and ceiling: taper the body force to zero at both boundaries.
        const verticalShape = Math.sin(Math.PI * (z + .5) / grid.nz);
        grid.w[cellIndex] = grid.w[cellIndex]! + buoyancy * verticalShape * .18;
        if (windStrength && outdoor?.inwardVector) {
          const px = (x + .5) / grid.nx;
          const py = (y + .5) / grid.ny;
          const proximity = windows.reduce((maximum, opening) => {
            const ox = opening.position.x / Math.max(1, grid.floor.width);
            const oy = opening.position.y / Math.max(1, grid.floor.height);
            const aperture = configuredPlanElementOpeningState(opening).openFraction;
            return Math.max(maximum, Math.exp(-((px - ox) ** 2 + (py - oy) ** 2) / .035) * aperture);
          }, 0);
          const heightTaper = Math.sin(Math.PI * (z + .5) / grid.nz);
          grid.u[cellIndex] = grid.u[cellIndex]! + outdoor.inwardVector.x * windStrength * proximity * heightTaper * .13;
          grid.v[cellIndex] = grid.v[cellIndex]! + outdoor.inwardVector.y * windStrength * proximity * heightTaper * .13;
        }
        if (vents.length) {
          const px = (x + .5) / grid.nx;
          const py = (y + .5) / grid.ny;
          const pz = (z + .5) / grid.nz;
          for (const vent of vents) {
            const ox = vent.position.x / Math.max(1, grid.floor.width);
            const oy = vent.position.y / Math.max(1, grid.floor.height);
            const oz = (planElementBottomOffset(grid.floor, vent) + effectivePlanElementHeight(grid.floor, vent) * .5) / ceilingHeight(grid.floor);
            const proximity = Math.exp(-((px - ox) ** 2 + (py - oy) ** 2) / .025 - (pz - oz) ** 2 / .055);
            const effective = configuredPlanElementOpeningState(vent);
            const strength = (.07 + clamp((vent.nominalFlowM3h ?? 35) / 250, 0, .55) * .13) * effective.openFraction * proximity;
            const variant = vent.variant ?? "passive";
            if (variant === "supply" || (variant === "balanced" && pz <= oz)) {
              const radians = vent.rotationDegrees * Math.PI / 180;
              grid.u[cellIndex] = grid.u[cellIndex]! + Math.cos(radians) * strength;
              grid.v[cellIndex] = grid.v[cellIndex]! + Math.sin(radians) * strength;
            } else {
              const towardX = ox - px;
              const towardY = oy - py;
              const distance = Math.max(.025, Math.hypot(towardX, towardY));
              grid.u[cellIndex] = grid.u[cellIndex]! + towardX / distance * strength;
              grid.v[cellIndex] = grid.v[cellIndex]! + towardY / distance * strength;
            }
          }
        }
      }
    }
  }
}

function divergenceAt(grid: SolverGrid, x: number, y: number, z: number): number {
  const currentIndex = index(grid, x, y, z);
  if (!grid.fluid[currentIndex]) return 0;
  const component = (values: Float64Array, dx: number, dy: number, dz: number) => {
    const current = values[currentIndex]!;
    return faceOpen(grid, x, y, z, dx, dy, dz)
      ? (values[index(grid, x + dx, y + dy, z + dz)]! + current) / 2
      : 0;
  };
  const right = component(grid.u, 1, 0, 0);
  const left = component(grid.u, -1, 0, 0);
  const bottom = component(grid.v, 0, 1, 0);
  const top = component(grid.v, 0, -1, 0);
  const above = component(grid.w, 0, 0, 1);
  const below = component(grid.w, 0, 0, -1);
  return (right - left) * grid.nx + (bottom - top) * grid.ny + (above - below) * grid.nz;
}

function projectVelocity(grid: SolverGrid): number {
  const pressure = new Float64Array(grid.u.length);
  const nextPressure = new Float64Array(grid.u.length);
  const divergence = new Float64Array(grid.u.length);
  for (let z = 0; z < grid.nz; z += 1) {
    for (let y = 0; y < grid.ny; y += 1) {
      for (let x = 0; x < grid.nx; x += 1) divergence[index(grid, x, y, z)] = divergenceAt(grid, x, y, z);
    }
  }
  for (let iteration = 0; iteration < PRESSURE_ITERATIONS; iteration += 1) {
    for (let z = 0; z < grid.nz; z += 1) {
      for (let y = 0; y < grid.ny; y += 1) {
        for (let x = 0; x < grid.nx; x += 1) {
          const cellIndex = index(grid, x, y, z);
          if (!grid.fluid[cellIndex]) continue;
          let weighted = 0;
          let coefficient = 0;
          for (const [dx, dy, dz, inverseSpacingSquared] of [
            [1, 0, 0, grid.nx ** 2], [-1, 0, 0, grid.nx ** 2],
            [0, 1, 0, grid.ny ** 2], [0, -1, 0, grid.ny ** 2],
            [0, 0, 1, grid.nz ** 2], [0, 0, -1, grid.nz ** 2],
          ] as const) {
            if (!faceOpen(grid, x, y, z, dx, dy, dz)) continue;
            weighted += pressure[index(grid, x + dx, y + dy, z + dz)]! * inverseSpacingSquared;
            coefficient += inverseSpacingSquared;
          }
          nextPressure[cellIndex] = coefficient ? (weighted - divergence[cellIndex]!) / coefficient : 0;
        }
      }
    }
    pressure.set(nextPressure);
  }
  for (let z = 0; z < grid.nz; z += 1) {
    for (let y = 0; y < grid.ny; y += 1) {
      for (let x = 0; x < grid.nx; x += 1) {
        const cellIndex = index(grid, x, y, z);
        if (!grid.fluid[cellIndex]) continue;
        const gradient = (dx: number, dy: number, dz: number, spacing: number) => {
          const positive = faceOpen(grid, x, y, z, dx, dy, dz)
            ? pressure[index(grid, x + dx, y + dy, z + dz)]!
            : pressure[cellIndex]!;
          const negative = faceOpen(grid, x, y, z, -dx, -dy, -dz)
            ? pressure[index(grid, x - dx, y - dy, z - dz)]!
            : pressure[cellIndex]!;
          return (positive - negative) * spacing / 2;
        };
        grid.u[cellIndex] = grid.u[cellIndex]! - gradient(1, 0, 0, grid.nx);
        grid.v[cellIndex] = grid.v[cellIndex]! - gradient(0, 1, 0, grid.ny);
        grid.w[cellIndex] = grid.w[cellIndex]! - gradient(0, 0, 1, grid.nz);
        if (!faceOpen(grid, x, y, z, 1, 0, 0) && !faceOpen(grid, x, y, z, -1, 0, 0)) grid.u[cellIndex] = 0;
        if (!faceOpen(grid, x, y, z, 0, 1, 0) && !faceOpen(grid, x, y, z, 0, -1, 0)) grid.v[cellIndex] = 0;
        if (!faceOpen(grid, x, y, z, 0, 0, 1) && !faceOpen(grid, x, y, z, 0, 0, -1)) grid.w[cellIndex] = 0;
      }
    }
  }
  let squared = 0;
  let count = 0;
  for (let z = 0; z < grid.nz; z += 1) {
    for (let y = 0; y < grid.ny; y += 1) {
      for (let x = 0; x < grid.nx; x += 1) {
        const cellIndex = index(grid, x, y, z);
        if (!grid.fluid[cellIndex]) continue;
        const divergenceValue = divergenceAt(grid, x, y, z);
        squared += divergenceValue ** 2;
        count += 1;
      }
    }
  }
  return count ? Math.sqrt(squared / count) : 0;
}

function solve(grid: SolverGrid, anchors: ClimateAnchor[], outdoor?: OutdoorBoundaryContext | null): void {
  let divergenceRms = 0;
  for (let step = 0; step < STEADY_STEPS; step += 1) {
    addForces(grid, anchors, outdoor);
    diffuseVelocity(grid);
    divergenceRms = projectVelocity(grid);
    for (let cell = 0; cell < grid.u.length; cell += 1) {
      grid.u[cell] = grid.u[cell]! * .82;
      grid.v[cell] = grid.v[cell]! * .82;
      grid.w[cell] = grid.w[cell]! * .82;
    }
  }
  grid.divergenceRms = divergenceRms;
  grid.maximumSpeed = 0;
  for (let cell = 0; cell < grid.u.length; cell += 1) {
    grid.maximumSpeed = Math.max(grid.maximumSpeed, Math.hypot(grid.u[cell]!, grid.v[cell]!, grid.w[cell]!));
  }
}

function emptyEvidence(rawInput: BuildGridInput, suppliedAnchors?: ClimateAnchor[]): AirflowEvidence {
  const input = effectiveGridInput(rawInput);
  const anchors = suppliedAnchors ?? anchorsForFloor(input);
  const floorSensors = input.sensors.filter((sensor) => sensor.enabled && sensor.floorId === input.floor.id);
  const humiditySensors = floorSensors.filter((sensor) => freshSample(input.samples, sensor.id, "temperature", input.freshness)
    && freshSample(input.samples, sensor.id, "humidity", input.freshness)).length;
  const tracerSensors = floorSensors.filter((sensor) => freshSample(input.samples, sensor.id, "co2", input.freshness)).length;
  const airflowElements = (input.floor.planElements ?? []).filter((element): element is AirflowPlanElement => element.kind !== "fireplace");
  return {
    temperatureSensors: anchors.length,
    humiditySensors,
    tracerSensors,
    windDriven: windwardWindows(input.floor, input.outdoor).length > 0,
    doorOpenings: airflowElements.filter((element) => element.kind === "door" && openingIsActive(element)).length,
    windowOpenings: airflowElements.filter((element) => element.kind === "window" && openingIsActive(element)).length,
    ventOpenings: airflowElements.filter((element) => element.kind === "vent" && openingIsActive(element)).length,
    counterflowOpenings: 0,
    pressureAssumed: !finite(input.outdoor?.conditions.pressureHpa),
    support: "low",
    divergenceRms: 0,
  };
}

function buildGrid(rawInput: BuildGridInput): SolverGrid | null {
  const input = effectiveGridInput(rawInput);
  const anchors = anchorsForFloor(input);
  if (anchors.length < MIN_TEMPERATURE_ANCHORS) return null;
  const { nx, ny, nz } = gridDimensions(input.floor);
  const size = nx * ny * nz;
  const evidence = emptyEvidence(input, anchors);
  const grid: SolverGrid = {
    floor: input.floor, anchors, nx, ny, nz,
    fluid: new Uint8Array(size),
    blockX: new Uint8Array(Math.max(1, (nx - 1) * ny * nz)),
    blockY: new Uint8Array(Math.max(1, nx * (ny - 1) * nz)),
    u: new Float64Array(size), v: new Float64Array(size), w: new Float64Array(size),
    support: new Float64Array(size), temperature: new Float64Array(size), humidity: new Float64Array(size), tracer: new Float64Array(size),
    tracerAvailable: false, maximumSpeed: 0, divergenceRms: 0, evidence,
  };
  rasterizeFluid(grid);
  rasterizeWalls(grid);
  interpolateScalars(grid, anchors);
  solve(grid, anchors, input.outdoor);
  const supported = [...grid.support].filter((value) => value > 0);
  const averageCoverage = supported.length ? supported.reduce((sum, value) => sum + value, 0) / supported.length : 0;
  const counterflow = naturalDoorCounterflow(grid);
  grid.evidence = {
    ...evidence,
    support: supportLevel(anchors.length, averageCoverage, evidence.humiditySensors / Math.max(1, anchors.length)),
    divergenceRms: grid.divergenceRms,
    counterflowOpenings: counterflow.openings,
  };
  return grid;
}

function trilinear(grid: SolverGrid, values: Float64Array, point: NormalizedPoint3D): number {
  const gx = clamp(point.x) * grid.nx - .5;
  const gy = clamp(point.y) * grid.ny - .5;
  const gz = clamp(point.z) * grid.nz - .5;
  const x0 = clamp(Math.floor(gx), 0, grid.nx - 1);
  const y0 = clamp(Math.floor(gy), 0, grid.ny - 1);
  const z0 = clamp(Math.floor(gz), 0, grid.nz - 1);
  const x1 = Math.min(grid.nx - 1, x0 + 1);
  const y1 = Math.min(grid.ny - 1, y0 + 1);
  const z1 = Math.min(grid.nz - 1, z0 + 1);
  const tx = clamp(gx - x0);
  const ty = clamp(gy - y0);
  const tz = clamp(gz - z0);
  const plane = (z: number) => {
    const top = values[index(grid, x0, y0, z)]! * (1 - tx) + values[index(grid, x1, y0, z)]! * tx;
    const bottom = values[index(grid, x0, y1, z)]! * (1 - tx) + values[index(grid, x1, y1, z)]! * tx;
    return top * (1 - ty) + bottom * ty;
  };
  return plane(z0) * (1 - tz) + plane(z1) * tz;
}

function velocityAt(grid: SolverGrid, point: NormalizedPoint3D): Velocity3D {
  return {
    x: trilinear(grid, grid.u, point),
    y: trilinear(grid, grid.v, point),
    z: trilinear(grid, grid.w, point),
    support: trilinear(grid, grid.support, point),
  };
}

function fluidAt(grid: SolverGrid, point: NormalizedPoint3D): boolean {
  const x = clamp(Math.floor(point.x * grid.nx), 0, grid.nx - 1);
  const y = clamp(Math.floor(point.y * grid.ny), 0, grid.ny - 1);
  const z = clamp(Math.floor(point.z * grid.nz), 0, grid.nz - 1);
  return Boolean(grid.fluid[index(grid, x, y, z)]);
}

interface Seed extends NormalizedPoint3D {
  score: number;
}

function chooseSeeds(grid: SolverGrid, maximum: number, sliceLayer?: number): Seed[] {
  const candidates: Seed[] = [];
  let tracerMin = Number.POSITIVE_INFINITY;
  let tracerMax = Number.NEGATIVE_INFINITY;
  if (grid.tracerAvailable) {
    for (let cell = 0; cell < grid.tracer.length; cell += 1) {
      if (!grid.fluid[cell]) continue;
      tracerMin = Math.min(tracerMin, grid.tracer[cell]!);
      tracerMax = Math.max(tracerMax, grid.tracer[cell]!);
    }
  }
  const layers = sliceLayer === undefined ? [...Array(grid.nz).keys()] : [sliceLayer];
  for (const z of layers) {
    for (let y = 1; y < grid.ny - 1; y += 1) {
      for (let x = 1; x < grid.nx - 1; x += 1) {
        const cellIndex = index(grid, x, y, z);
        if (!grid.fluid[cellIndex] || grid.support[cellIndex]! < .14) continue;
        const speed = Math.hypot(grid.u[cellIndex]!, grid.v[cellIndex]!, grid.w[cellIndex]!);
        if (speed < grid.maximumSpeed * .035 || speed <= FIELD_EPSILON) continue;
        const tracerProminence = grid.tracerAvailable && tracerMax > tracerMin
          ? (grid.tracer[cellIndex]! - tracerMin) / (tracerMax - tracerMin)
          : 0;
        candidates.push({
          x: (x + .5) / grid.nx, y: (y + .5) / grid.ny, z: (z + .5) / grid.nz,
          score: speed / Math.max(FIELD_EPSILON, grid.maximumSpeed) * (.45 + grid.support[cellIndex]! * .55) * (1 + tracerProminence * .18),
        });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const selected: Seed[] = [];
  for (const candidate of candidates) {
    if (selected.length >= maximum) break;
    if (selected.some((seed) => Math.hypot(seed.x - candidate.x, seed.y - candidate.y, (seed.z - candidate.z) * .72) < (sliceLayer === undefined ? .21 : .18))) continue;
    selected.push(candidate);
  }
  return selected;
}

function trace2DDirection(grid: SolverGrid, seed: NormalizedPoint3D, direction: -1 | 1): AirflowPoint2D[] {
  const points: AirflowPoint2D[] = [];
  let current = { ...seed };
  for (let step = 0; step < 24; step += 1) {
    const velocity = velocityAt(grid, current);
    const horizontalSpeed = Math.hypot(velocity.x, velocity.y);
    if (horizontalSpeed <= grid.maximumSpeed * .018 || velocity.support < .1) break;
    const distance = .034;
    const next = {
      x: current.x + direction * velocity.x / horizontalSpeed * distance,
      y: current.y + direction * velocity.y / horizontalSpeed * distance,
      z: current.z,
    };
    if (next.x <= .015 || next.x >= .985 || next.y <= .015 || next.y >= .985 || !fluidAt(grid, next)) break;
    const fromWorld = { x: current.x * grid.floor.width, y: current.y * grid.floor.height };
    const toWorld = { x: next.x * grid.floor.width, y: next.y * grid.floor.height };
    if (blockedByWall(grid.floor, fromWorld, toWorld, current.z * ceilingHeight(grid.floor))) break;
    points.push({ x: toWorld.x, y: toWorld.y, vertical: velocity.z / Math.max(FIELD_EPSILON, grid.maximumSpeed) });
    current = next;
  }
  return points;
}

function floorPaths(grid: SolverGrid, maximum: number): AirflowPath2D[] {
  if (grid.maximumSpeed <= FIELD_EPSILON) return [];
  const sensorHeights = grid.floor.ceilingHeight
    ? .42
    : .45;
  const layer = clamp(Math.floor(sensorHeights * grid.nz), 1, grid.nz - 2);
  return chooseSeeds(grid, maximum * 2, layer).flatMap((seed, candidateIndex) => {
    const seedVelocity = velocityAt(grid, seed);
    const backward = trace2DDirection(grid, seed, -1).reverse();
    const center = { x: seed.x * grid.floor.width, y: seed.y * grid.floor.height, vertical: seedVelocity.z / Math.max(FIELD_EPSILON, grid.maximumSpeed) };
    const forward = trace2DDirection(grid, seed, 1);
    const points = [...backward, center, ...forward];
    if (points.length < 4) return [];
    const support = points.reduce((sum, point) => sum + velocityAt(grid, {
      x: point.x / grid.floor.width, y: point.y / grid.floor.height, z: seed.z,
    }).support, 0) / points.length;
    return [{
      id: `${grid.floor.id}-air-${candidateIndex}`,
      points,
      relativeSpeed: clamp(Math.hypot(seedVelocity.x, seedVelocity.y, seedVelocity.z) / grid.maximumSpeed),
      support,
      verticalTendency: center.vertical,
    }];
  }).slice(0, maximum);
}

function trace3DDirection(grid: SolverGrid, seed: NormalizedPoint3D, direction: -1 | 1): AirflowPoint3D[] {
  const points: AirflowPoint3D[] = [];
  let current = { ...seed };
  for (let step = 0; step < 28; step += 1) {
    const velocity = velocityAt(grid, current);
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    if (speed <= grid.maximumSpeed * .018 || velocity.support < .1) break;
    const distance = .04;
    const next = {
      x: current.x + direction * velocity.x / speed * distance,
      y: current.y + direction * velocity.y / speed * distance,
      z: current.z + direction * velocity.z / speed * distance,
    };
    if (next.x <= .015 || next.x >= .985 || next.y <= .015 || next.y >= .985 || next.z <= .025 || next.z >= .975 || !fluidAt(grid, next)) break;
    const fromWorld = { x: current.x * grid.floor.width, y: current.y * grid.floor.height };
    const toWorld = { x: next.x * grid.floor.width, y: next.y * grid.floor.height };
    if (blockedByWall(grid.floor, fromWorld, toWorld, (current.z + next.z) * .5 * ceilingHeight(grid.floor))) break;
    points.push({ x: toWorld.x, y: toWorld.y, z: grid.floor.elevation + next.z * ceilingHeight(grid.floor) });
    current = next;
  }
  return points;
}

function volumePaths(grid: SolverGrid, maximum: number): AirflowPath3D[] {
  if (grid.maximumSpeed <= FIELD_EPSILON) return [];
  return chooseSeeds(grid, maximum * 2).flatMap((seed, candidateIndex) => {
    const velocity = velocityAt(grid, seed);
    const backward = trace3DDirection(grid, seed, -1).reverse();
    const center = {
      x: seed.x * grid.floor.width,
      y: seed.y * grid.floor.height,
      z: grid.floor.elevation + seed.z * ceilingHeight(grid.floor),
    };
    const forward = trace3DDirection(grid, seed, 1);
    const points = [...backward, center, ...forward];
    if (points.length < 4) return [];
    const zValues = points.map((point) => point.z);
    const support = points.reduce((sum, point) => sum + velocityAt(grid, {
      x: point.x / grid.floor.width,
      y: point.y / grid.floor.height,
      z: (point.z - grid.floor.elevation) / ceilingHeight(grid.floor),
    }).support, 0) / points.length;
    return [{
      id: `${grid.floor.id}-volume-air-${candidateIndex}`,
      floorId: grid.floor.id,
      points,
      relativeSpeed: clamp(Math.hypot(velocity.x, velocity.y, velocity.z) / grid.maximumSpeed),
      support,
      hasVerticalComponent: Math.max(...zValues) - Math.min(...zValues) > ceilingHeight(grid.floor) * .045,
    }];
  }).slice(0, maximum);
}

function naturalDoorCounterflow(grid: SolverGrid): { paths: AirflowPath3D[]; openings: number } {
  const floor = grid.floor;
  const doors = (floor.planElements ?? []).filter((element): element is Extract<PlanElement, { kind: "door" }> => element.kind === "door" && openingIsActive(element));
  const paths: AirflowPath3D[] = [];
  let openings = 0;
  for (const door of doors) {
    const wall = floor.walls.find((candidate) => candidate.id === door.wallId);
    if (!wall) continue;
    const dx = wall.to.x - wall.from.x;
    const dy = wall.to.y - wall.from.y;
    const length = Math.hypot(dx, dy);
    if (length <= FIELD_EPSILON) continue;
    const normal = { x: -dy / length, y: dx / length };
    const span = Math.max(floor.width, floor.height);
    let sides: { a: Point; b: Point; roomA: Floor["rooms"][number]; roomB: Floor["rooms"][number] } | null = null;
    for (const distance of [Math.max(elementWidth(door, floor) * .62, span * .015), span * .035, span * .065]) {
      const a = { x: door.position.x + normal.x * distance, y: door.position.y + normal.y * distance };
      const b = { x: door.position.x - normal.x * distance, y: door.position.y - normal.y * distance };
      const roomA = floor.rooms.find((room) => room.points.length >= 3 && pointInPolygon(a, room.points));
      const roomB = floor.rooms.find((room) => room.points.length >= 3 && pointInPolygon(b, room.points));
      if (roomA && roomB && roomA.id !== roomB.id) {
        sides = { a, b, roomA, roomB };
        break;
      }
    }
    if (!sides) continue;
    const roomTemperature = (room: Floor["rooms"][number]) => {
      const anchors = grid.anchors.filter((anchor) => pointInPolygon({ x: anchor.x * floor.width, y: anchor.y * floor.height }, room.points));
      if (!anchors.length) return null;
      const weight = anchors.reduce((sum, anchor) => sum + anchor.weight, 0);
      return { value: anchors.reduce((sum, anchor) => sum + anchor.temperatureC * anchor.weight, 0) / Math.max(FIELD_EPSILON, weight), count: anchors.length };
    };
    const temperatureA = roomTemperature(sides.roomA);
    const temperatureB = roomTemperature(sides.roomB);
    if (!temperatureA || !temperatureB || Math.abs(temperatureA.value - temperatureB.value) < .15) continue;
    const aIsWarmer = temperatureA.value > temperatureB.value;
    const warm = aIsWarmer ? sides.a : sides.b;
    const cool = aIsWarmer ? sides.b : sides.a;
    const effective = configuredPlanElementOpeningState(door);
    const bottom = planElementBottomOffset(floor, door);
    const height = effectivePlanElementHeight(floor, door);
    const lowerZ = floor.elevation + bottom + height * .16;
    const upperZ = floor.elevation + bottom + height * .84;
    const support = clamp(.35 + Math.min(temperatureA.count, temperatureB.count) * .16, .35, .82);
    const relativeSpeed = clamp(Math.abs(temperatureA.value - temperatureB.value) / 4, .16, .86) * Math.sqrt(effective.openFraction);
    const across = (from: Point, to: Point, z: number): AirflowPoint3D[] => [0, .25, .5, .75, 1].map((progress) => ({
      x: from.x + (to.x - from.x) * progress,
      y: from.y + (to.y - from.y) * progress,
      z,
    }));
    paths.push({
      id: `${floor.id}-${door.id}-counterflow-low`, floorId: floor.id,
      points: across(cool, warm, lowerZ), relativeSpeed, support, hasVerticalComponent: false,
    }, {
      id: `${floor.id}-${door.id}-counterflow-high`, floorId: floor.id,
      points: across(warm, cool, upperZ), relativeSpeed, support, hasVerticalComponent: false,
    });
    openings += 1;
  }
  return { paths, openings };
}

function mergeEvidence(items: AirflowEvidence[]): AirflowEvidence {
  if (!items.length) {
    return { temperatureSensors: 0, humiditySensors: 0, tracerSensors: 0, windDriven: false, doorOpenings: 0, windowOpenings: 0, ventOpenings: 0, counterflowOpenings: 0, pressureAssumed: true, support: "low", divergenceRms: 0 };
  }
  const supports: Record<AirflowDataSupport, number> = { low: 0, medium: 1, high: 2 };
  const averageSupport = items.reduce((sum, item) => sum + supports[item.support], 0) / items.length;
  return {
    temperatureSensors: items.reduce((sum, item) => sum + item.temperatureSensors, 0),
    humiditySensors: items.reduce((sum, item) => sum + item.humiditySensors, 0),
    tracerSensors: items.reduce((sum, item) => sum + item.tracerSensors, 0),
    windDriven: items.some((item) => item.windDriven),
    doorOpenings: items.reduce((sum, item) => sum + item.doorOpenings, 0),
    windowOpenings: items.reduce((sum, item) => sum + item.windowOpenings, 0),
    ventOpenings: items.reduce((sum, item) => sum + item.ventOpenings, 0),
    counterflowOpenings: items.reduce((sum, item) => sum + item.counterflowOpenings, 0),
    pressureAssumed: items.some((item) => item.pressureAssumed),
    support: averageSupport >= 1.5 ? "high" : averageSupport >= .55 ? "medium" : "low",
    divergenceRms: items.reduce((sum, item) => sum + item.divergenceRms, 0) / items.length,
  };
}

export function simulateFloorAirflow(input: BuildGridInput, maximumPaths = 9): FloorAirflowEstimate {
  const grid = buildGrid(input);
  return grid
    ? { paths: floorPaths(grid, Math.max(0, maximumPaths)), evidence: grid.evidence }
    : { paths: [], evidence: emptyEvidence(input) };
}

export function simulateBuildingAirflow(input: {
  house: House;
  sensors: Sensor[];
  samples: ClimateSampleMatrix;
  freshness: SpatialFreshnessOptions;
  outdoor?: OutdoorBoundaryContext | null;
  openingStateObservations?: readonly OpeningStateObservation[];
}, maximumPaths = 14): BuildingAirflowEstimate {
  const floors = input.house.floors.filter((floor) => input.sensors.some((sensor) => sensor.floorId === floor.id && sensor.enabled));
  const perFloor = Math.max(3, Math.ceil(Math.max(0, maximumPaths) / Math.max(1, floors.length)));
  const floorResults = floors.map((floor) => {
    const gridInput: BuildGridInput = { floor, sensors: input.sensors, samples: input.samples, freshness: input.freshness };
    if (input.outdoor !== undefined) gridInput.outdoor = input.outdoor;
    if (input.openingStateObservations !== undefined) gridInput.openingStateObservations = input.openingStateObservations;
    const grid = buildGrid(gridInput);
    return { grid, evidence: grid?.evidence ?? emptyEvidence(gridInput) };
  });
  const grids = floorResults.flatMap(({ grid }) => grid ? [grid] : []);
  const counterflowPaths = grids.flatMap((grid) => naturalDoorCounterflow(grid).paths)
    .sort((a, b) => b.support - a.support)
    .slice(0, Math.floor(Math.max(0, maximumPaths) / 2) * 2);
  const solvedPaths = grids.flatMap((grid) => volumePaths(grid, perFloor)).sort((a, b) => b.support - a.support);
  return {
    paths: [...counterflowPaths, ...solvedPaths].slice(0, maximumPaths),
    evidence: mergeEvidence(floorResults.map(({ evidence }) => evidence)),
  };
}
