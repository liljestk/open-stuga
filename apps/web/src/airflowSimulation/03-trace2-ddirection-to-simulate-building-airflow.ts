import {
  configuredPlanElementOpeningState,
  type Floor,
  type House,
  type OpeningStateObservation,
  type PlanElement,
  type Point,
  type Sensor,
} from "@climate-twin/contracts";
import type { OutdoorBoundaryContext } from "../outdoorContext";
import { effectivePlanElementHeight, planElementBottomOffset } from "../planElementGeometry";
import { type SpatialFreshnessOptions } from "../spatialFreshness";
import { AirflowDataSupport, AirflowEvidence, AirflowPath2D, AirflowPath3D, AirflowPoint2D, AirflowPoint3D, BuildGridInput, BuildingAirflowEstimate, ClimateSampleMatrix, FIELD_EPSILON, FloorAirflowEstimate, NormalizedPoint3D, SolverGrid, blockedByWall, ceilingHeight, clamp, elementWidth, openingIsActive, pointInPolygon } from "./01-climate-sample-matrix-to-line-of-sight-penalty";
import { buildGrid, chooseSeeds, emptyEvidence, fluidAt, velocityAt } from "./02-interpolate-scalars-to-choose-seeds";

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

export function naturalDoorCounterflow(grid: SolverGrid): { paths: AirflowPath3D[]; openings: number } {
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
