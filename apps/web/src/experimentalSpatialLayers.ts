import type { Floor, House, MeasurementSample, Point, Room, Sensor } from "@climate-twin/contracts";
import type { AirflowEvidence, ClimateSampleMatrix } from "./airflowSimulation";
import { isSpatialSampleFresh, type SpatialFreshnessOptions } from "./spatialFreshness";
import type { SpatialLayerSnapshot, SpatialLayerZone } from "./spatialLayers";

export type ExperimentalVisualizationId = "air-movement" | "sensor-coverage";
export type ExperimentalDataSupport = "low" | "medium" | "high";

export interface SensorCoverageRegion {
  id: string;
  sensorId: string;
  floorId: string;
  x: number;
  y: number;
  z: number;
  radiusX: number;
  radiusY: number;
  radiusZ: number;
  support: number;
  pairedHumidity: boolean;
}

export type PlacementReason = "room-uncovered" | "second-anchor" | "refresh-sensor";

export interface SensorPlacementRecommendation {
  id: string;
  floorId: string;
  floorName: string;
  roomId?: string;
  roomName?: string;
  x: number;
  y: number;
  z: number;
  reason: PlacementReason;
}

export interface SensorCoverageAssessment {
  regions: SensorCoverageRegion[];
  recommendations: SensorPlacementRecommendation[];
  freshTemperatureSensors: number;
  pairedHumiditySensors: number;
  staleOrMissingSensors: number;
  enabledSensors: number;
  coverageScore: number;
  support: ExperimentalDataSupport;
}

export interface SensorPlacementSuggestion {
  recommendation: SensorPlacementRecommendation;
  coverageAtPoint: number;
  engineLayerCount: number;
  engineSupport: number | null;
}

export type ExperimentalSuggestionCode =
  | "add-temperature-anchor"
  | "add-paired-humidity"
  | "refresh-sensor"
  | "add-pressure"
  | "model-openings"
  | "record-opening-state"
  | "add-physical-scale"
  | "model-vertical-portals";

export interface ExperimentalLayerSuggestion {
  id: string;
  code: ExperimentalSuggestionCode;
  layer: ExperimentalVisualizationId | "both";
  floorName?: string;
  roomName?: string;
  count?: number;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function freshSample(
  samples: ClimateSampleMatrix,
  sensorId: string,
  metric: string,
  freshness: SpatialFreshnessOptions,
): MeasurementSample | null {
  const sample = samples[sensorId]?.[metric];
  return sample && Number.isFinite(sample.value) && isSpatialSampleFresh(sample, freshness) ? sample : null;
}

function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
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

function roomCentroid(room: Room): Point | null {
  if (room.points.length < 3) return null;
  return {
    x: room.points.reduce((sum, point) => sum + point.x, 0) / room.points.length,
    y: room.points.reduce((sum, point) => sum + point.y, 0) / room.points.length,
  };
}

function normalizedRoomName(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? "";
}

function recommendedHeight(floor: Floor): number {
  return floor.elevation + Math.min(1.4, Math.max(.9, (floor.ceilingHeight ?? 2.8) * .45));
}

function coverageAtPoint(point: Point, regions: readonly SensorCoverageRegion[]): number {
  if (!regions.length) return 0;
  return Math.max(...regions.map((region) => {
    const normalizedDistance = Math.hypot(
      (region.x - point.x) / Math.max(1, region.radiusX),
      (region.y - point.y) / Math.max(1, region.radiusY),
    );
    return Math.exp(-normalizedDistance * normalizedDistance * .72) * region.support;
  }));
}

function placementBiasPenalty(floor: Floor, point: Point): number {
  const influenceRadius = Math.max(1, Math.max(floor.width, floor.height) * .16);
  return (floor.planElements ?? []).reduce((sum, element) => {
    const weight = { window: 1, fireplace: 1, vent: .72, door: .42 }[element.kind];
    const normalizedDistance = Math.hypot(point.x - element.position.x, point.y - element.position.y) / influenceRadius;
    return sum + Math.exp(-normalizedDistance * normalizedDistance * 1.3) * weight;
  }, 0);
}

function roomForZone(floor: Floor, zone: SpatialLayerZone): Room | undefined {
  const byId = zone.roomId ? floor.rooms.find((room) => room.id === zone.roomId) : undefined;
  if (byId) return byId;
  return zone.centroid
    ? floor.rooms.find((room) => room.points.length >= 3 && pointInPolygon(zone.centroid!, room.points))
    : undefined;
}

function zoneSupport(snapshot: SpatialLayerSnapshot, zone: SpatialLayerZone): number {
  const evidence = zone.evidence?.confidence ?? zone.evidence?.quality ?? zone.evidence?.strength;
  if (typeof evidence === "number" && Number.isFinite(evidence)) return clamp(evidence);
  const metricQualities = Object.values(zone.metrics).flatMap((metric) => (
    typeof metric.quality === "number" && Number.isFinite(metric.quality) ? [metric.quality] : []
  ));
  return metricQualities.length
    ? clamp(metricQualities.reduce((sum, value) => sum + value, 0) / metricQualities.length)
    : clamp(snapshot.qualityScore);
}

function roomCandidates(floor: Floor, room: Room | undefined): Point[] {
  if (room) {
    const center = roomCentroid(room);
    if (!center) return [];
    const xs = room.points.map((point) => point.x);
    const ys = room.points.map((point) => point.y);
    const minimumX = Math.min(...xs);
    const maximumX = Math.max(...xs);
    const minimumY = Math.min(...ys);
    const maximumY = Math.max(...ys);
    const grid = [.25, .5, .75].flatMap((fractionY) => [.25, .5, .75].map((fractionX) => ({
      x: minimumX + (maximumX - minimumX) * fractionX,
      y: minimumY + (maximumY - minimumY) * fractionY,
    }))).filter((point) => pointInPolygon(point, room.points));
    return [center, ...grid.filter((point) => point.x !== center.x || point.y !== center.y)];
  }
  const candidates: Point[] = [];
  for (const fractionY of [.2, .35, .5, .65, .8]) {
    for (const fractionX of [.2, .35, .5, .65, .8]) {
      const point = { x: floor.width * fractionX, y: floor.height * fractionY };
      if (!floor.rooms.length || floor.rooms.some((candidate) => candidate.points.length >= 3 && pointInPolygon(point, candidate.points))) {
        candidates.push(point);
      }
    }
  }
  return candidates.length ? candidates : [{ x: floor.width / 2, y: floor.height / 2 }];
}

/**
 * Chooses an optional onboarding target from the same support model used by
 * the experimental coverage layer. Stored engine zones can prioritize a room,
 * while the exact point remains the least-supported valid point in that room.
 */
export function suggestSensorPlacement(input: {
  floor: Floor;
  roomName?: string;
  coverage: SensorCoverageAssessment;
  spatialSnapshots?: readonly SpatialLayerSnapshot[];
}): SensorPlacementSuggestion {
  const { floor, coverage } = input;
  const floorRegions = coverage.regions.filter((region) => region.floorId === floor.id);
  const requestedRoomName = normalizedRoomName(input.roomName);
  const requestedRoom = requestedRoomName
    ? floor.rooms.find((room) => normalizedRoomName(room.name) === requestedRoomName)
    : undefined;
  const engineZones = (input.spatialSnapshots ?? []).flatMap((snapshot) => snapshot.status === "ready"
    ? snapshot.zones.flatMap((zone) => {
        const roomBelongsToFloor = Boolean(zone.roomId && floor.rooms.some((room) => room.id === zone.roomId));
        if (zone.floorId ? zone.floorId !== floor.id : !roomBelongsToFloor) return [];
        if (!zone.centroid || !Number.isFinite(zone.centroid.x) || !Number.isFinite(zone.centroid.y)) return [];
        if (zone.centroid.x < 0 || zone.centroid.x > floor.width || zone.centroid.y < 0 || zone.centroid.y > floor.height) return [];
        const room = roomForZone(floor, zone);
        if (requestedRoom && room?.id !== requestedRoom.id) return [];
        return [{ snapshot, zone, room, support: zoneSupport(snapshot, zone) }];
      })
    : []);
  const weakestEngineZone = engineZones.reduce<(typeof engineZones)[number] | undefined>(
    (weakest, candidate) => !weakest || candidate.support < weakest.support ? candidate : weakest,
    undefined,
  );
  const floorRecommendations = coverage.recommendations.filter((recommendation) => (
    recommendation.floorId === floor.id && recommendation.reason !== "refresh-sensor"
  ));
  const recommendedRoom = floorRecommendations.flatMap((recommendation) => (
    recommendation.roomId ? floor.rooms.filter((room) => room.id === recommendation.roomId) : []
  ))[0];
  const targetRoom = requestedRoom ?? weakestEngineZone?.room ?? recommendedRoom;
  const candidates = roomCandidates(floor, targetRoom);
  const point = candidates.reduce((best, candidate) => (
    coverageAtPoint(candidate, floorRegions) + placementBiasPenalty(floor, candidate) * .24
      < coverageAtPoint(best, floorRegions) + placementBiasPenalty(floor, best) * .24 ? candidate : best
  ), candidates[0] ?? { x: floor.width / 2, y: floor.height / 2 });
  const freshInTargetRoom = targetRoom
    ? floorRegions.some((region) => pointInPolygon(region, targetRoom.points))
    : floorRegions.length > 0;
  const matchingEngineZones = engineZones.filter((candidate) => targetRoom
    ? candidate.room?.id === targetRoom.id
    : true);
  return {
    recommendation: {
      id: `placement:${floor.id}:suggested:${targetRoom?.id ?? "coverage-gap"}`,
      floorId: floor.id,
      floorName: floor.name,
      ...(targetRoom ? { roomId: targetRoom.id, roomName: targetRoom.name } : {}),
      x: point.x,
      y: point.y,
      z: recommendedHeight(floor),
      reason: targetRoom && !freshInTargetRoom ? "room-uncovered" : "second-anchor",
    },
    coverageAtPoint: coverageAtPoint(point, floorRegions),
    engineLayerCount: new Set(matchingEngineZones.map((candidate) => candidate.snapshot.layerId)).size,
    engineSupport: matchingEngineZones.length
      ? Math.min(...matchingEngineZones.map((candidate) => candidate.support))
      : null,
  };
}

function farthestFloorPoint(floor: Floor, sensors: readonly Sensor[]): Point {
  const candidates: Point[] = [];
  for (const fractionY of [.2, .5, .8]) {
    for (const fractionX of [.2, .5, .8]) candidates.push({ x: floor.width * fractionX, y: floor.height * fractionY });
  }
  const usable = candidates.filter((candidate) => floor.rooms.length === 0
    || floor.rooms.some((room) => room.points.length >= 3 && pointInPolygon(candidate, room.points)));
  return (usable.length ? usable : candidates).reduce((best, candidate) => {
    const nearest = sensors.length
      ? Math.min(...sensors.map((sensor) => Math.hypot(
          (sensor.x - candidate.x) / Math.max(1, floor.width),
          (sensor.y - candidate.y) / Math.max(1, floor.height),
        )))
      : Number.POSITIVE_INFINITY;
    const bestNearest = sensors.length
      ? Math.min(...sensors.map((sensor) => Math.hypot(
          (sensor.x - best.x) / Math.max(1, floor.width),
          (sensor.y - best.y) / Math.max(1, floor.height),
        )))
      : Number.NEGATIVE_INFINITY;
    return nearest > bestNearest ? candidate : best;
  }, (usable.length ? usable : candidates)[0]!);
}

function floorCoverageScore(floor: Floor, regions: readonly SensorCoverageRegion[]): number {
  if (!regions.length) return 0;
  const samples: number[] = [];
  for (const fractionY of [.12, .3, .5, .7, .88]) {
    for (const fractionX of [.12, .3, .5, .7, .88]) {
      const point = { x: floor.width * fractionX, y: floor.height * fractionY };
      if (floor.rooms.length && !floor.rooms.some((room) => room.points.length >= 3 && pointInPolygon(point, room.points))) continue;
      samples.push(Math.max(...regions.map((region) => {
        const normalizedDistance = Math.hypot(
          (region.x - point.x) / Math.max(1, region.radiusX),
          (region.y - point.y) / Math.max(1, region.radiusY),
        );
        return Math.exp(-normalizedDistance * normalizedDistance * .72) * region.support;
      })));
    }
  }
  return samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : 0;
}

function supportFor(score: number, freshSensors: number, floorCount: number): ExperimentalDataSupport {
  if (freshSensors >= Math.max(3, floorCount * 2) && score >= .52) return "high";
  if (freshSensors >= Math.max(2, floorCount) && score >= .26) return "medium";
  return "low";
}

/**
 * Estimates where the research views are constrained by current temperature
 * and paired-humidity samples. This is a sampling-support layer, not a radio
 * range map and not a statement that unsampled rooms are unsafe.
 */
export function assessSensorCoverage(input: {
  house: House;
  sensors: Sensor[];
  samples: ClimateSampleMatrix;
  freshness: SpatialFreshnessOptions;
}): SensorCoverageAssessment {
  const enabled = input.sensors.filter((sensor) => sensor.enabled && input.house.floors.some((floor) => floor.id === sensor.floorId));
  const freshTemperature = enabled.filter((sensor) => freshSample(input.samples, sensor.id, "temperature", input.freshness));
  const regions = freshTemperature.map<SensorCoverageRegion>((sensor) => {
    const floor = input.house.floors.find((candidate) => candidate.id === sensor.floorId)!;
    const temperature = freshSample(input.samples, sensor.id, "temperature", input.freshness)!;
    const humidity = freshSample(input.samples, sensor.id, "humidity", input.freshness);
    const quality = temperature.quality === "estimated" ? .62 : 1;
    const pairing = humidity ? 1 : .78;
    return {
      id: `coverage:${sensor.id}`,
      sensorId: sensor.id,
      floorId: floor.id,
      x: sensor.x,
      y: sensor.y,
      z: sensor.z,
      radiusX: Math.max(1, floor.width * .27),
      radiusY: Math.max(1, floor.height * .27),
      radiusZ: Math.max(.7, (floor.ceilingHeight ?? 2.8) * .34),
      support: quality * pairing,
      pairedHumidity: Boolean(humidity),
    };
  });

  const recommendations: SensorPlacementRecommendation[] = [];
  input.house.floors.forEach((floor) => {
    const floorEnabled = enabled.filter((sensor) => sensor.floorId === floor.id);
    const floorFresh = freshTemperature.filter((sensor) => sensor.floorId === floor.id);
    const uncoveredRooms = floor.rooms.flatMap((room) => {
      const center = roomCentroid(room);
      if (!center || floorFresh.some((sensor) => pointInPolygon(sensor, room.points))) return [];
      return [{ room, center }];
    });
    uncoveredRooms.forEach(({ room, center }) => recommendations.push({
      id: `placement:${floor.id}:${room.id}`,
      floorId: floor.id,
      floorName: floor.name,
      roomId: room.id,
      roomName: room.name,
      x: center.x,
      y: center.y,
      z: recommendedHeight(floor),
      reason: "room-uncovered",
    }));
    if (floorFresh.length < 2 && uncoveredRooms.length === 0) {
      const point = farthestFloorPoint(floor, floorFresh);
      recommendations.push({
        id: `placement:${floor.id}:second-anchor`,
        floorId: floor.id,
        floorName: floor.name,
        x: point.x,
        y: point.y,
        z: recommendedHeight(floor),
        reason: "second-anchor",
      });
    }
    floorEnabled.filter((sensor) => !floorFresh.some((fresh) => fresh.id === sensor.id)).forEach((sensor) => {
      recommendations.push({
        id: `placement:${floor.id}:refresh:${sensor.id}`,
        floorId: floor.id,
        floorName: floor.name,
        x: sensor.x,
        y: sensor.y,
        z: sensor.z,
        reason: "refresh-sensor",
      });
    });
  });

  const floorScores = input.house.floors.map((floor) => floorCoverageScore(
    floor,
    regions.filter((region) => region.floorId === floor.id),
  ));
  const coverageScore = floorScores.length
    ? clamp(floorScores.reduce((sum, value) => sum + value, 0) / floorScores.length)
    : 0;
  const pairedHumiditySensors = freshTemperature.filter((sensor) => freshSample(input.samples, sensor.id, "humidity", input.freshness)).length;
  return {
    regions,
    recommendations,
    freshTemperatureSensors: freshTemperature.length,
    pairedHumiditySensors,
    staleOrMissingSensors: enabled.length - freshTemperature.length,
    enabledSensors: enabled.length,
    coverageScore,
    support: supportFor(coverageScore, freshTemperature.length, input.house.floors.length),
  };
}

export function experimentalLayerSuggestions(input: {
  house: House;
  coverage: SensorCoverageAssessment;
  airflow: AirflowEvidence | null;
  floorId?: string;
}): ExperimentalLayerSuggestion[] {
  const visiblePlacements = input.coverage.recommendations.filter((recommendation) => !input.floorId || recommendation.floorId === input.floorId);
  const suggestions: ExperimentalLayerSuggestion[] = visiblePlacements.slice(0, 2).map((recommendation) => ({
    id: recommendation.id,
    code: recommendation.reason === "refresh-sensor" ? "refresh-sensor" : "add-temperature-anchor",
    layer: "both",
    floorName: recommendation.floorName,
    ...(recommendation.roomName ? { roomName: recommendation.roomName } : {}),
  }));
  if (input.airflow && input.airflow.humiditySensors < input.airflow.temperatureSensors) suggestions.push({
    id: "airflow:paired-humidity",
    code: "add-paired-humidity",
    layer: "air-movement",
    count: input.airflow.temperatureSensors - input.airflow.humiditySensors,
  });
  if (input.airflow?.pressureAssumed) suggestions.push({ id: "airflow:pressure", code: "add-pressure", layer: "air-movement" });
  const visibleFloors = input.floorId ? input.house.floors.filter((floor) => floor.id === input.floorId) : input.house.floors;
  if (input.airflow && visibleFloors.every((floor) => (floor.planElements ?? []).every((element) => element.kind !== "door" && element.kind !== "vent"))) {
    suggestions.push({ id: "airflow:openings", code: "model-openings", layer: "air-movement" });
  } else if (input.airflow) {
    suggestions.push({ id: "airflow:opening-state", code: "record-opening-state", layer: "air-movement" });
  }
  if (input.airflow) suggestions.push({ id: "airflow:scale", code: "add-physical-scale", layer: "air-movement" });
  if (input.airflow && !input.floorId && input.house.floors.length > 1) {
    suggestions.push({ id: "airflow:vertical-portals", code: "model-vertical-portals", layer: "air-movement" });
  }
  return [...new Map(suggestions.map((suggestion) => [suggestion.id, suggestion])).values()];
}
