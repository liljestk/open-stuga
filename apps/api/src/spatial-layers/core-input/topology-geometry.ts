import type { LocalBucketQuery } from "../../timeseries/local-telemetry-worker-thread.js";
import type { MeasurementWindowQuery } from "../../timeseries/types.js";
import {
  configuredPlanElementOpeningState,
  floorMetersPerPlanUnit,
  resolvePlanElementOpeningState,
  type AirflowPlanElement,
  type Floor,
  type House,
  type MeasurementSample,
  type OutdoorTemperatureSample,
  type OpeningStateObservation,
  type Property,
  type PropertyArea,
  type Reading,
  type Sensor,
} from "@climate-twin/contracts";
import {
  type SpatialConnection,
  type SpatialSensorBinding,
  type SpatialTopology,
  type SpatialZone,
  type Vector2,
} from "@climate-twin/spatial-layers";
import type {
  HybridTelemetryReader,
} from "../../timeseries/read-facade.js";
import type {
  SpatialScope,
  StoredSpatialSensorBinding,
} from "../types.js";

export type SpatialTelemetryReader =
  Pick<HybridTelemetryReader, "measurementWindow" | "outdoorTemperatureHistory">
  & Partial<Pick<HybridTelemetryReader, "openingStateHistory" | "openingStateSnapshot">>;

/** Narrow structural view of ClimateDatabase containing reads only. */
export interface CoreClimateReader {
  telemetryArchiveSourceId(): string;
  isRealDataMode(): boolean;
  getHouse(id: string): House | null;
  listHouses(): House[];
  listOpeningStateObservations(houseId: string, options?: { limit?: number; at?: string | number | Date }): OpeningStateObservation[];
  listCurrentOpeningStateCandidates?(
    houseId: string,
    at?: string | number | Date,
    limit?: number,
  ): OpeningStateObservation[];
  listOpeningStateObservationHistory(
    houseId: string,
    window: { from: string | number | Date; to: string | number | Date; limit?: number },
  ): OpeningStateObservation[];
  listProperties(limit?: number, offset?: number): Property[];
  getProperty(id: string): Property | null;
  listPropertyAreas(propertyId?: string, limit?: number, offset?: number): PropertyArea[];
  listSensors(houseId?: string): Sensor[];
  getSensor(id: string): Sensor | null;
  measurementHistory(sensorId: string, metric: string, from: string, to: string, limit?: number): MeasurementSample[];
  measurementHistoryBucketed(query: LocalBucketQuery): MeasurementSample[];
  measurementWindow(query: MeasurementWindowQuery): MeasurementSample[];
  history(sensorIds: string[], from: string, to: string, limit?: number): Reading[];
  outdoorTemperatureHistory(houseId: string, locationKey: string, from: string, to: string, limit?: number): OutdoorTemperatureSample[];
}

export interface BuiltTopology {
  topology: SpatialTopology;
  warnings: string[];
}

export const DEFAULT_ACTIVE_FROM = "1970-01-01T00:00:00.000Z";

export function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function averagePoint(points: Vector2[]): Vector2 {
  if (points.length === 0) return { x: 0, y: 0 };
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

export function polygonArea(points: Vector2[]): number {
  let doubled = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    doubled += current.x * next.y - next.x * current.y;
  }
  return Math.abs(doubled) / 2;
}

export function pointSegmentDistance(point: Vector2, start: Vector2, end: Vector2): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= Number.EPSILON) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + projection * dx), point.y - (start.y + projection * dy));
}

export function distanceToPolygonBoundary(point: Vector2, polygon: Vector2[]): number {
  if (polygon.length < 2) return Number.POSITIVE_INFINITY;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1) {
    distance = Math.min(distance, pointSegmentDistance(point, polygon[index]!, polygon[(index + 1) % polygon.length]!));
  }
  return distance;
}

export function pointInPolygon(point: Vector2, polygon: Vector2[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const current = polygon[index]!;
    const prior = polygon[previous]!;
    const crosses = (current.y > point.y) !== (prior.y > point.y)
      && point.x < (prior.x - current.x) * (point.y - current.y) / (prior.y - current.y) + current.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function zoneKind(floor: Floor): SpatialZone["kind"] {
  if (floor.type === "basement") return "cellar";
  if (floor.type === "attic") return "attic";
  if (floor.type === "outdoor") return "outdoor";
  return "indoor";
}

export function frameId(houseId: string, floorId: string): string {
  return `house:${houseId}:floor:${floorId}`;
}

export function roomZoneId(houseId: string, floorId: string, roomId: string): string {
  return `house:${houseId}:floor:${floorId}:room:${roomId}`;
}

export function ventilationBoundaryZone(house: House, floor: Floor): SpatialZone {
  return {
    id: `house:${house.id}:floor:${floor.id}:ventilation-boundary`,
    name: `${floor.name} ventilation boundary`,
    kind: "outdoor",
    frameId: frameId(house.id, floor.id),
    floorId: floor.id,
    centroid: { x: floor.width / 2, y: -Math.max(.1, floor.height * .05), z: floor.elevation + (floor.ceilingHeight ?? 2.4) / 2 },
    elevationM: floor.elevation,
    heightM: floor.ceilingHeight ?? 2.4,
    tags: ["derived-ventilation-boundary"],
  };
}

export function wallIsRectangularFloorBoundary(floor: Floor, wallId: string): boolean {
  const wall = floor.walls.find((candidate) => candidate.id === wallId);
  if (!wall) return false;
  const tolerance = Math.max(1e-6, Math.min(floor.width, floor.height) * 1e-4);
  return (Math.abs(wall.from.x) <= tolerance && Math.abs(wall.to.x) <= tolerance)
    || (Math.abs(wall.from.x - floor.width) <= tolerance && Math.abs(wall.to.x - floor.width) <= tolerance)
    || (Math.abs(wall.from.y) <= tolerance && Math.abs(wall.to.y) <= tolerance)
    || (Math.abs(wall.from.y - floor.height) <= tolerance && Math.abs(wall.to.y - floor.height) <= tolerance);
}

export function deriveOpeningConnections(house: House, zones: SpatialZone[], observations: readonly OpeningStateObservation[] = [], at = new Date().toISOString()): { connections: SpatialConnection[]; boundaryZones: SpatialZone[]; warnings: string[] } {
  const connections: SpatialConnection[] = [];
  const boundaryZones: SpatialZone[] = [];
  const warnings: string[] = [];
  for (const floor of house.floors) {
    const floorZones = zones.filter((zone) => zone.floorId === floor.id && zone.polygon);
    const tolerance = Math.max(0.02, Math.min(floor.width, floor.height) * 0.015);
    const boundaryZone = ventilationBoundaryZone(house, floor);
    let boundaryUsed = false;
    for (const element of floor.planElements ?? []) {
      if (element.kind !== "door" && element.kind !== "window") continue;
      const touching = floorZones.filter((zone) => distanceToPolygonBoundary(element.position, zone.polygon!) <= tolerance);
      let left: SpatialZone | undefined;
      let right: SpatialZone | undefined;
      if (touching.length === 2) {
        [left, right] = touching;
      } else if (touching.length === 1 && wallIsRectangularFloorBoundary(floor, element.wallId)) {
        left = touching[0];
        right = boundaryZone;
        boundaryUsed = true;
      } else {
        warnings.push(`OPENING_${element.id}_ADJACENCY_UNRESOLVED`);
        continue;
      }
      if (!left || !right || left.id === right.id) continue;
      const floorObservations = observations.filter((observation) => observation.floorId === floor.id);
      const effective = floorObservations.length ? resolvePlanElementOpeningState(element, floorObservations, at) : configuredPlanElementOpeningState(element);
      const configured = configuredPlanElementOpeningState(element);
      const defaultHeight = element.kind === "door" ? 2.1 : 1.2;
      const height = element.height ?? defaultHeight;
      const bottom = element.bottomOffsetM ?? (element.kind === "window" ? Math.max(0, Math.min((floor.ceilingHeight ?? 2.8) - height, .9)) : 0);
      const metresPerPlanUnit = floorMetersPerPlanUnit(floor, house);
      connections.push({
        id: openingConnectionId(house.id, floor.id, element),
        zoneAId: left.id,
        zoneBId: right.id,
        kind: element.kind === "door" && element.variant === "open-passage" ? "open-passage" : element.kind,
        enabled: effective.openFraction > 0,
        normallyOpen: configured.state === "open",
        ...(metresPerPlanUnit ? { openingAreaM2: (element.width ?? 1) * metresPerPlanUnit * height * effective.openFraction } : {}),
        anchors: [{ x: element.position.x, y: element.position.y, z: floor.elevation + bottom + height / 2 }],
        tags: ["derived-conservatively", planElementReferenceTag(floor.id, element.id), `state:${effective.state}`, `state-source:${effective.source}`],
      });
    }
    if (boundaryUsed) boundaryZones.push(boundaryZone);
  }
  return { connections, boundaryZones, warnings };
}

export function deriveVentConnections(house: House, zones: SpatialZone[], observations: readonly OpeningStateObservation[] = [], at = new Date().toISOString()): { connections: SpatialConnection[]; boundaryZones: SpatialZone[]; warnings: string[] } {
  const connections: SpatialConnection[] = [];
  const boundaryZones: SpatialZone[] = [];
  const warnings: string[] = [];
  for (const floor of house.floors) {
    const floorZones = zones.filter((zone) => zone.floorId === floor.id && zone.polygon);
    const vents = (floor.planElements ?? []).filter((element) => element.kind === "vent");
    if (!vents.length) continue;
    const boundaryZone = ventilationBoundaryZone(house, floor);
    let boundaryUsed = false;
    for (const vent of vents) {
      const floorObservations = observations.filter((observation) => observation.floorId === floor.id);
      const effective = floorObservations.length ? resolvePlanElementOpeningState(vent, floorObservations, at) : configuredPlanElementOpeningState(vent);
      const configured = configuredPlanElementOpeningState(vent);
      const height = vent.height ?? .3;
      const bottom = vent.bottomOffsetM ?? Math.max(0, (floor.ceilingHeight ?? 2.8) - height - .15);
      const metresPerPlanUnit = floorMetersPerPlanUnit(floor, house);
      let zoneA: SpatialZone | undefined;
      let zoneB: SpatialZone | undefined;
      if (vent.variant === "transfer") {
        const tolerance = Math.max(0.02, Math.min(floor.width, floor.height) * 0.02);
        const touching = floorZones.filter((zone) => distanceToPolygonBoundary(vent.position, zone.polygon!) <= tolerance);
        if (touching.length === 2) [zoneA, zoneB] = touching;
      } else {
        zoneA = floorZones.find((zone) => pointInPolygon(vent.position, zone.polygon!));
        zoneB = boundaryZone;
        boundaryUsed = Boolean(zoneA);
      }
      if (!zoneA || !zoneB || zoneA.id === zoneB.id) {
        warnings.push(`VENT_${vent.id}_ADJACENCY_UNRESOLVED`);
        continue;
      }
      connections.push({
        id: openingConnectionId(house.id, floor.id, vent),
        zoneAId: zoneA.id,
        zoneBId: zoneB.id,
        kind: "vent",
        enabled: effective.openFraction > 0,
        normallyOpen: configured.state === "open",
        ...(metresPerPlanUnit ? { openingAreaM2: (vent.width ?? .3) * metresPerPlanUnit * height * effective.openFraction } : {}),
        anchors: [{ x: vent.position.x, y: vent.position.y, z: floor.elevation + bottom + height / 2 }],
        tags: ["derived-conservatively", planElementReferenceTag(floor.id, vent.id), `vent:${vent.variant ?? "passive"}`, `state:${effective.state}`, `state-source:${effective.source}`],
      });
    }
    if (boundaryUsed) boundaryZones.push(boundaryZone);
  }
  return { connections, boundaryZones, warnings };
}

export function activeAt(binding: StoredSpatialSensorBinding, at: string): boolean {
  const timestamp = Date.parse(at);
  return timestamp >= Date.parse(binding.activeFrom)
    && (binding.activeTo === undefined || timestamp < Date.parse(binding.activeTo));
}

export function defaultHouseBindings(
  house: House,
  sensors: Sensor[],
  zones: SpatialZone[],
  explicitBindings: StoredSpatialSensorBinding[],
  at: string,
  configuredBindings: SpatialSensorBinding[] = [],
): { bindings: SpatialSensorBinding[]; warnings: string[] } {
  const warnings: string[] = [];
  const result: SpatialSensorBinding[] = [];
  const zoneIds = new Set(zones.map((zone) => zone.id));
  for (const sensor of sensors) {
    const explicit = explicitBindings.find((binding) => binding.sensorId === sensor.id && activeAt(binding, at));
    if (explicit) {
      if (!zoneIds.has(explicit.zoneId)) {
        warnings.push(`BINDING_${explicit.id}_ZONE_UNKNOWN`);
      } else {
        const { id: _id, houseId: _houseId, createdAt: _createdAt, ...binding } = explicit;
        result.push(binding);
      }
      continue;
    }
    const configured = configuredBindings.find((binding) => binding.sensorId === sensor.id
      && Date.parse(at) >= Date.parse(binding.activeFrom)
      && (binding.activeTo === undefined || Date.parse(at) < Date.parse(binding.activeTo)));
    if (configured) {
      if (zoneIds.has(configured.zoneId)) result.push(structuredClone(configured));
      else warnings.push(`SENSOR_${sensor.id}_CONFIGURED_ZONE_UNKNOWN`);
      continue;
    }
    const floor = house.floors.find((candidate) => candidate.id === sensor.floorId);
    if (!floor) {
      warnings.push(`SENSOR_${sensor.id}_FLOOR_UNKNOWN`);
      continue;
    }
    // null is an explicit instruction to keep the legacy display label
    // spatially unlinked. Only old/in-memory records where roomId is genuinely
    // absent may use the backwards-compatible exact-label fallback.
    const room = sensor.roomId === undefined
      ? floor.rooms.find((candidate) => candidate.id === sensor.room)
        ?? floor.rooms.find((candidate) => normalized(candidate.name) === normalized(sensor.room))
      : sensor.roomId === null
        ? undefined
        : floor.rooms.find((candidate) => candidate.id === sensor.roomId);
    if (!room) {
      warnings.push(`SENSOR_${sensor.id}_ROOM_UNRESOLVED`);
      continue;
    }
    result.push({
      sensorId: sensor.id,
      zoneId: roomZoneId(house.id, floor.id, room.id),
      frameId: frameId(house.id, floor.id),
      position: { x: sensor.x, y: sensor.y, z: sensor.z },
      role: "primary",
      activeFrom: DEFAULT_ACTIVE_FROM,
    });
  }
  return { bindings: result, warnings };
}

export function configuredTopology(config: Record<string, unknown>, scope: SpatialScope): SpatialTopology | null {
  const candidate = config.topology;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const topology = structuredClone(candidate) as Partial<SpatialTopology>;
  if (!topology.scope || topology.scope.kind !== scope.kind || topology.scope.id !== scope.id
    || !Array.isArray(topology.frames) || !Array.isArray(topology.zones)
    || !Array.isArray(topology.connections) || !Array.isArray(topology.sensorBindings)) return null;
  return topology as SpatialTopology;
}

export const PLAN_ELEMENT_REFERENCE_PREFIX = "plan-element-ref:";

export function planElementReferenceTag(floorId: string, elementId: string): string {
  return `${PLAN_ELEMENT_REFERENCE_PREFIX}${encodeURIComponent(floorId)}/${encodeURIComponent(elementId)}`;
}

export interface ArchitecturalOpeningReference {
  floor: Floor;
  element: AirflowPlanElement;
}

export function architecturalOpeningReferences(house: House): ArchitecturalOpeningReference[] {
  return house.floors.flatMap((floor) => (floor.planElements ?? []).flatMap((element) => (
    element.kind === "door" || element.kind === "window" || element.kind === "vent"
      ? [{ floor, element }]
      : []
  )));
}

export function parsePlanElementReference(tag: string): { floorId: string; elementId: string } | null {
  if (!tag.startsWith(PLAN_ELEMENT_REFERENCE_PREFIX)) return null;
  const reference = tag.slice(PLAN_ELEMENT_REFERENCE_PREFIX.length);
  const separator = reference.indexOf("/");
  if (separator < 1 || separator === reference.length - 1) return null;
  try {
    return {
      floorId: decodeURIComponent(reference.slice(0, separator)),
      elementId: decodeURIComponent(reference.slice(separator + 1)),
    };
  } catch {
    return null;
  }
}

export function connectionMatchesOpeningKind(connection: SpatialConnection, element: AirflowPlanElement): boolean {
  if (element.kind === "door") return connection.kind === "door" || connection.kind === "open-passage";
  return connection.kind === element.kind;
}

export function legacyOpeningConnectionId(houseId: string, element: AirflowPlanElement): string {
  return element.kind === "vent"
    ? `house:${houseId}:vent:${element.id}`
    : `house:${houseId}:opening:${element.id}`;
}

export function openingConnectionId(houseId: string, floorId: string, element: AirflowPlanElement): string {
  const kind = element.kind === "vent" ? "vent" : "opening";
  return `house:${houseId}:${kind}:${encodeURIComponent(floorId)}/${encodeURIComponent(element.id)}`;
}

export function architecturalOpeningAreaM2(house: House, floor: Floor, element: AirflowPlanElement): number | null {
  const scale = floorMetersPerPlanUnit(floor, house);
  if (scale === null) return null;
  const height = element.height ?? (element.kind === "door" ? 2.1 : element.kind === "window" ? 1.2 : .3);
  const width = element.width ?? (element.kind === "vent" ? .3 : 1);
  return width * scale * height;
}
