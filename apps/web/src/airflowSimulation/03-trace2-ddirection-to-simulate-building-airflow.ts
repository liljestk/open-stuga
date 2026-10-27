import {
  type House,
  type OpeningStateObservation,
  type Sensor,
} from "@climate-twin/contracts";
import type { OutdoorBoundaryContext } from "../outdoorContext";
import { type SpatialFreshnessOptions } from "../spatialFreshness";
import { AirflowDataSupport, AirflowEvidence, AirflowPath2D, AirflowPath3D, AirflowPoint2D, AirflowPoint3D, BuildGridInput, BuildingAirflowEstimate, ClimateSampleMatrix, FIELD_EPSILON, FloorAirflowEstimate, NormalizedPoint3D, SolverGrid, blockedByWall, ceilingHeight, clamp } from "./01-climate-sample-matrix-to-line-of-sight-penalty";
import { buildGrid, chooseSeeds, emptyEvidence, fluidAt, velocityAt, naturalDoorCounterflow } from "./02-interpolate-scalars-to-choose-seeds";

export function trace2DDirection(grid: SolverGrid, seed: NormalizedPoint3D, direction: -1 | 1): AirflowPoint2D[] {
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

export function floorPaths(grid: SolverGrid, maximum: number): AirflowPath2D[] {
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

export function trace3DDirection(grid: SolverGrid, seed: NormalizedPoint3D, direction: -1 | 1): AirflowPoint3D[] {
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

export function volumePaths(grid: SolverGrid, maximum: number): AirflowPath3D[] {
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

export function mergeEvidence(items: AirflowEvidence[]): AirflowEvidence {
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
