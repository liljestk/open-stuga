import {
  configuredPlanElementOpeningState,
  isAirflowPlanElement,
  type Floor,
  type PlanElement,
  type Point,
  type VentPlanElement,
} from "@climate-twin/contracts";
import type { OutdoorBoundaryContext, PlanEdge } from "../outdoorContext";
import { effectivePlanElementHeight, planElementBottomOffset } from "../planElementGeometry";
import { AirflowEvidence, BuildGridInput, ClimateAnchor, FIELD_EPSILON, GRAVITY_MPS2, MIN_TEMPERATURE_ANCHORS, NormalizedPoint3D, PRESSURE_ITERATIONS, STEADY_STEPS, SolverGrid, Velocity3D, anchorsForFloor, ceilingHeight, clamp, effectiveGridInput, faceOpen, finite, freshSample, gridDimensions, index, lineOfSightPenalty, openingIsActive, rasterizeFluid, rasterizeWalls, supportLevel, virtualTemperatureK, AirflowPath3D, AirflowPoint3D, elementWidth, pointInPolygon } from "./01-climate-sample-matrix-to-line-of-sight-penalty";

export function interpolateScalars(grid: SolverGrid, anchors: ClimateAnchor[]): void {
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

export function neighborValue(grid: SolverGrid, values: Float64Array, x: number, y: number, z: number, dx: number, dy: number, dz: number): number {
  const current = values[index(grid, x, y, z)]!;
  return faceOpen(grid, x, y, z, dx, dy, dz) ? values[index(grid, x + dx, y + dy, z + dz)]! : current;
}

export function diffuseVelocity(grid: SolverGrid): void {
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

export function boundaryDistance(point: Point, edge: PlanEdge, floor: Floor): number {
  if (edge === "left") return point.x / Math.max(1, floor.width);
  if (edge === "right") return (floor.width - point.x) / Math.max(1, floor.width);
  if (edge === "top") return point.y / Math.max(1, floor.height);
  return (floor.height - point.y) / Math.max(1, floor.height);
}

export function windwardWindows(floor: Floor, outdoor?: OutdoorBoundaryContext | null): Array<Extract<PlanElement, { kind: "window" }>> {
  const edge = outdoor?.windwardEdge;
  if (!edge || outdoor.stale || !outdoor.inwardVector || !finite(outdoor.conditions.windSpeedMps)) return [];
  return (floor.planElements ?? []).filter((element) => element.kind === "window"
    && openingIsActive(element) && boundaryDistance(element.position, edge, floor) <= .15) as Array<Extract<PlanElement, { kind: "window" }>>;
}

export function activeVents(floor: Floor): VentPlanElement[] {
  return (floor.planElements ?? []).filter((element): element is VentPlanElement => element.kind === "vent" && openingIsActive(element));
}

export function addForces(grid: SolverGrid, anchors: ClimateAnchor[], outdoor?: OutdoorBoundaryContext | null): void {
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

export function divergenceAt(grid: SolverGrid, x: number, y: number, z: number): number {
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

export function projectVelocity(grid: SolverGrid): number {
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

export function solve(grid: SolverGrid, anchors: ClimateAnchor[], outdoor?: OutdoorBoundaryContext | null): void {
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

export function emptyEvidence(rawInput: BuildGridInput, suppliedAnchors?: ClimateAnchor[]): AirflowEvidence {
  const input = effectiveGridInput(rawInput);
  const anchors = suppliedAnchors ?? anchorsForFloor(input);
  const floorSensors = input.sensors.filter((sensor) => sensor.enabled && sensor.floorId === input.floor.id);
  const humiditySensors = floorSensors.filter((sensor) => freshSample(input.samples, sensor.id, "temperature", input.freshness)
    && freshSample(input.samples, sensor.id, "humidity", input.freshness)).length;
  const tracerSensors = floorSensors.filter((sensor) => freshSample(input.samples, sensor.id, "co2", input.freshness)).length;
  const airflowElements = (input.floor.planElements ?? []).filter(isAirflowPlanElement);
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

export function buildGrid(rawInput: BuildGridInput): SolverGrid | null {
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

export function trilinear(grid: SolverGrid, values: Float64Array, point: NormalizedPoint3D): number {
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

export function velocityAt(grid: SolverGrid, point: NormalizedPoint3D): Velocity3D {
  return {
    x: trilinear(grid, grid.u, point),
    y: trilinear(grid, grid.v, point),
    z: trilinear(grid, grid.w, point),
    support: trilinear(grid, grid.support, point),
  };
}

export function fluidAt(grid: SolverGrid, point: NormalizedPoint3D): boolean {
  const x = clamp(Math.floor(point.x * grid.nx), 0, grid.nx - 1);
  const y = clamp(Math.floor(point.y * grid.ny), 0, grid.ny - 1);
  const z = clamp(Math.floor(point.z * grid.nz), 0, grid.nz - 1);
  return Boolean(grid.fluid[index(grid, x, y, z)]);
}

export interface Seed extends NormalizedPoint3D {
  score: number;
}

export function chooseSeeds(grid: SolverGrid, maximum: number, sliceLayer?: number): Seed[] {
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

type FloorRoom = Floor["rooms"][number];
type FloorDoor = Extract<PlanElement, { kind: "door" }>;

/**
 * Probes outward from a door along its wall normal until the two probe points
 * land in different rooms; returns those points and rooms, or null.
 */
function doorSides(floor: Floor, door: FloorDoor): { a: Point; b: Point; roomA: FloorRoom; roomB: FloorRoom } | null {
  const wall = floor.walls.find((candidate) => candidate.id === door.wallId);
  if (!wall) return null;
  const dx = wall.to.x - wall.from.x;
  const dy = wall.to.y - wall.from.y;
  const length = Math.hypot(dx, dy);
  if (length <= FIELD_EPSILON) return null;
  const normal = { x: -dy / length, y: dx / length };
  const span = Math.max(floor.width, floor.height);
  const roomAt = (point: Point) => floor.rooms.find((room) => room.points.length >= 3 && pointInPolygon(point, room.points));
  for (const distance of [Math.max(elementWidth(door, floor) * .62, span * .015), span * .035, span * .065]) {
    const a = { x: door.position.x + normal.x * distance, y: door.position.y + normal.y * distance };
    const b = { x: door.position.x - normal.x * distance, y: door.position.y - normal.y * distance };
    const roomA = roomAt(a);
    const roomB = roomAt(b);
    if (roomA && roomB && roomA.id !== roomB.id) return { a, b, roomA, roomB };
  }
  return null;
}

/** Weighted mean anchor temperature inside a room, or null without anchors. */
function roomTemperature(grid: SolverGrid, room: FloorRoom): { value: number; count: number } | null {
  const { floor } = grid;
  const anchors = grid.anchors.filter((anchor) => pointInPolygon({ x: anchor.x * floor.width, y: anchor.y * floor.height }, room.points));
  if (!anchors.length) return null;
  const weight = anchors.reduce((sum, anchor) => sum + anchor.weight, 0);
  return { value: anchors.reduce((sum, anchor) => sum + anchor.temperatureC * anchor.weight, 0) / Math.max(FIELD_EPSILON, weight), count: anchors.length };
}

export function naturalDoorCounterflow(grid: SolverGrid): { paths: AirflowPath3D[]; openings: number } {
  const floor = grid.floor;
  const doors = (floor.planElements ?? []).filter((element): element is FloorDoor => element.kind === "door" && openingIsActive(element));
  const paths: AirflowPath3D[] = [];
  let openings = 0;
  for (const door of doors) {
    const sides = doorSides(floor, door);
    if (!sides) continue;
    const temperatureA = roomTemperature(grid, sides.roomA);
    const temperatureB = roomTemperature(grid, sides.roomB);
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
