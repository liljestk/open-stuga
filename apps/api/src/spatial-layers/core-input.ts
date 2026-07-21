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
  validateTopology,
  type CoordinateFrame,
  type SpatialClimateSample,
  type SpatialConnection,
  type SpatialConnectionStateInterval,
  type SpatialContextEvent,
  type SpatialLayerEngineInput,
  type SpatialSensorBinding,
  type SpatialSensorCalibration,
  type SpatialTopology,
  type SpatialZone,
  type Vector2,
  type Vector3,
} from "@climate-twin/spatial-layers";
import { outdoorLocationKey } from "../db.js";
import type {
  HybridTelemetryReadProvenance,
  HybridTelemetryReader,
} from "../timeseries/read-facade.js";
import type {
  SpatialConfigurationVersion,
  SpatialCoreDescription,
  SpatialCoreDataset,
  SpatialCoreInputPort,
  SpatialDataPartition,
  SpatialScope,
  StoredSpatialContextEvent,
  StoredSpatialSensorBinding,
  StoredSpatialSensorCalibration,
} from "./types.js";

export type SpatialTelemetryReader = Pick<HybridTelemetryReader, "measurementWindow" | "outdoorTemperatureHistory">;

/** Narrow structural view of ClimateDatabase containing reads only. */
export interface CoreClimateReader {
  telemetryArchiveSourceId(): string;
  isRealDataMode(): boolean;
  getHouse(id: string): House | null;
  listHouses(): House[];
  listOpeningStateObservations(houseId: string, limit?: number, at?: string | number | Date): OpeningStateObservation[];
  listOpeningStateObservationHistory(
    houseId: string,
    from: string | number | Date,
    to: string | number | Date,
    limit?: number,
  ): OpeningStateObservation[];
  listProperties(limit?: number, offset?: number): Property[];
  getProperty(id: string): Property | null;
  listPropertyAreas(propertyId?: string, limit?: number, offset?: number): PropertyArea[];
  listSensors(houseId?: string): Sensor[];
  getSensor(id: string): Sensor | null;
  measurementHistory(sensorId: string, metric: string, from: string, to: string, limit?: number): MeasurementSample[];
  measurementWindow(sensorIds: string[], metrics: string[], from: string, to: string, limit?: number): MeasurementSample[];
  history(sensorIds: string[], from: string, to: string, limit?: number): Reading[];
  outdoorTemperatureHistory(houseId: string, locationKey: string, from: string, to: string, limit?: number): OutdoorTemperatureSample[];
}

export interface BuiltTopology {
  topology: SpatialTopology;
  warnings: string[];
}

const DEFAULT_ACTIVE_FROM = "1970-01-01T00:00:00.000Z";

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function averagePoint(points: Vector2[]): Vector2 {
  if (points.length === 0) return { x: 0, y: 0 };
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function polygonArea(points: Vector2[]): number {
  let doubled = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    doubled += current.x * next.y - next.x * current.y;
  }
  return Math.abs(doubled) / 2;
}

function pointSegmentDistance(point: Vector2, start: Vector2, end: Vector2): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= Number.EPSILON) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + projection * dx), point.y - (start.y + projection * dy));
}

function distanceToPolygonBoundary(point: Vector2, polygon: Vector2[]): number {
  if (polygon.length < 2) return Number.POSITIVE_INFINITY;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1) {
    distance = Math.min(distance, pointSegmentDistance(point, polygon[index]!, polygon[(index + 1) % polygon.length]!));
  }
  return distance;
}

function pointInPolygon(point: Vector2, polygon: Vector2[]): boolean {
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

function zoneKind(floor: Floor): SpatialZone["kind"] {
  if (floor.type === "basement") return "cellar";
  if (floor.type === "attic") return "attic";
  if (floor.type === "outdoor") return "outdoor";
  return "indoor";
}

function frameId(houseId: string, floorId: string): string {
  return `house:${houseId}:floor:${floorId}`;
}

function roomZoneId(houseId: string, floorId: string, roomId: string): string {
  return `house:${houseId}:floor:${floorId}:room:${roomId}`;
}

function ventilationBoundaryZone(house: House, floor: Floor): SpatialZone {
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

function wallIsRectangularFloorBoundary(floor: Floor, wallId: string): boolean {
  const wall = floor.walls.find((candidate) => candidate.id === wallId);
  if (!wall) return false;
  const tolerance = Math.max(1e-6, Math.min(floor.width, floor.height) * 1e-4);
  return (Math.abs(wall.from.x) <= tolerance && Math.abs(wall.to.x) <= tolerance)
    || (Math.abs(wall.from.x - floor.width) <= tolerance && Math.abs(wall.to.x - floor.width) <= tolerance)
    || (Math.abs(wall.from.y) <= tolerance && Math.abs(wall.to.y) <= tolerance)
    || (Math.abs(wall.from.y - floor.height) <= tolerance && Math.abs(wall.to.y - floor.height) <= tolerance);
}

function deriveOpeningConnections(house: House, zones: SpatialZone[], observations: readonly OpeningStateObservation[] = [], at = new Date().toISOString()): { connections: SpatialConnection[]; boundaryZones: SpatialZone[]; warnings: string[] } {
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

function deriveVentConnections(house: House, zones: SpatialZone[], observations: readonly OpeningStateObservation[] = [], at = new Date().toISOString()): { connections: SpatialConnection[]; boundaryZones: SpatialZone[]; warnings: string[] } {
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

function activeAt(binding: StoredSpatialSensorBinding, at: string): boolean {
  const timestamp = Date.parse(at);
  return timestamp >= Date.parse(binding.activeFrom)
    && (binding.activeTo === undefined || timestamp < Date.parse(binding.activeTo));
}

function defaultHouseBindings(
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

function configuredTopology(config: Record<string, unknown>, scope: SpatialScope): SpatialTopology | null {
  const candidate = config.topology;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const topology = structuredClone(candidate) as Partial<SpatialTopology>;
  if (!topology.scope || topology.scope.kind !== scope.kind || topology.scope.id !== scope.id
    || !Array.isArray(topology.frames) || !Array.isArray(topology.zones)
    || !Array.isArray(topology.connections) || !Array.isArray(topology.sensorBindings)) return null;
  return topology as SpatialTopology;
}

const PLAN_ELEMENT_REFERENCE_PREFIX = "plan-element-ref:";

function planElementReferenceTag(floorId: string, elementId: string): string {
  return `${PLAN_ELEMENT_REFERENCE_PREFIX}${encodeURIComponent(floorId)}/${encodeURIComponent(elementId)}`;
}

interface ArchitecturalOpeningReference {
  floor: Floor;
  element: AirflowPlanElement;
}

function architecturalOpeningReferences(house: House): ArchitecturalOpeningReference[] {
  return house.floors.flatMap((floor) => (floor.planElements ?? []).flatMap((element) => (
    element.kind === "door" || element.kind === "window" || element.kind === "vent"
      ? [{ floor, element }]
      : []
  )));
}

function parsePlanElementReference(tag: string): { floorId: string; elementId: string } | null {
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

function connectionMatchesOpeningKind(connection: SpatialConnection, element: AirflowPlanElement): boolean {
  if (element.kind === "door") return connection.kind === "door" || connection.kind === "open-passage";
  return connection.kind === element.kind;
}

function legacyOpeningConnectionId(houseId: string, element: AirflowPlanElement): string {
  return element.kind === "vent"
    ? `house:${houseId}:vent:${element.id}`
    : `house:${houseId}:opening:${element.id}`;
}

function openingConnectionId(houseId: string, floorId: string, element: AirflowPlanElement): string {
  const kind = element.kind === "vent" ? "vent" : "opening";
  return `house:${houseId}:${kind}:${encodeURIComponent(floorId)}/${encodeURIComponent(element.id)}`;
}

function architecturalOpeningAreaM2(house: House, floor: Floor, element: AirflowPlanElement): number | null {
  const scale = floorMetersPerPlanUnit(floor, house);
  if (scale === null) return null;
  const height = element.height ?? (element.kind === "door" ? 2.1 : element.kind === "window" ? 1.2 : .3);
  const width = element.width ?? (element.kind === "vent" ? .3 : 1);
  return width * scale * height;
}

function applyArchitecturalOpeningStates(
  house: House,
  connections: readonly SpatialConnection[],
  observations: readonly OpeningStateObservation[] = [],
  at = new Date().toISOString(),
): { connections: SpatialConnection[]; warnings: string[] } {
  const references = architecturalOpeningReferences(house);
  const warnings: string[] = [];
  const resolvedConnections = connections.map((connection): SpatialConnection => {
    const disabled = (): SpatialConnection => ({ ...connection, enabled: false });
    const referenceTags = [...new Set((connection.tags ?? []).filter((tag) => tag.startsWith(PLAN_ELEMENT_REFERENCE_PREFIX)))];
    let candidates: ArchitecturalOpeningReference[] = [];
    if (referenceTags.length > 0) {
      if (referenceTags.length !== 1) {
        warnings.push("OPENING_STATE_REFERENCE_AMBIGUOUS");
        return disabled();
      }
      const parsed = parsePlanElementReference(referenceTags[0]!);
      if (!parsed) {
        warnings.push("OPENING_STATE_REFERENCE_INVALID");
        return disabled();
      }
      candidates = references.filter(({ floor, element }) => floor.id === parsed.floorId && element.id === parsed.elementId);
      if (candidates.length === 0) {
        warnings.push("OPENING_STATE_REFERENCE_NOT_FOUND");
        return disabled();
      }
    } else {
      candidates = references.filter(({ element }) => legacyOpeningConnectionId(house.id, element) === connection.id);
      if (candidates.length === 0) {
        if (references.some(({ element }) => connectionMatchesOpeningKind(connection, element))) {
          warnings.push("OPENING_STATE_REFERENCE_MISSING");
          return disabled();
        }
        return connection;
      }
    }
    if (candidates.length !== 1) {
      warnings.push("OPENING_STATE_REFERENCE_AMBIGUOUS");
      return disabled();
    }
    const { floor, element } = candidates[0]!;
    if (!connectionMatchesOpeningKind(connection, element)) {
      warnings.push("OPENING_STATE_KIND_MISMATCH");
      return disabled();
    }
    const floorObservations = observations.filter((observation) => observation.floorId === floor.id);
    const effective = floorObservations.length
      ? resolvePlanElementOpeningState(element, floorObservations, at)
      : configuredPlanElementOpeningState(element);
    const configured = configuredPlanElementOpeningState(element);
    const fullAreaM2 = connection.openingAreaM2 ?? architecturalOpeningAreaM2(house, floor, element);
    const referenceTag = planElementReferenceTag(floor.id, element.id);
    const stableTags = (connection.tags ?? []).filter((tag) => (
      !tag.startsWith(PLAN_ELEMENT_REFERENCE_PREFIX) && !tag.startsWith("state:") && !tag.startsWith("state-source:")
    ));
    return {
      ...connection,
      enabled: connection.enabled && effective.openFraction > 0,
      normallyOpen: connection.normallyOpen ?? configured.state === "open",
      ...(fullAreaM2 == null ? {} : { openingAreaM2: fullAreaM2 * effective.openFraction }),
      tags: [...new Set([...stableTags, referenceTag, `state:${effective.state}`, `state-source:${effective.source}`])],
    };
  });
  return { connections: resolvedConnections, warnings };
}

export function buildHouseTopology(input: {
  house: House;
  sensors: Sensor[];
  bindings: StoredSpatialSensorBinding[];
  at: string;
  openingStateObservations?: OpeningStateObservation[];
  configuration?: Record<string, unknown>;
}): BuiltTopology {
  const scope: SpatialScope = { kind: "house", id: input.house.id };
  const configured = configuredTopology(input.configuration ?? {}, scope);
  let configuredOpeningWarnings: string[] = [];
  if (configured) {
    const resolvedBindings = defaultHouseBindings(
      input.house,
      input.sensors,
      configured.zones,
      input.bindings,
      input.at,
      configured.sensorBindings,
    );
    const openingOverlay = applyArchitecturalOpeningStates(
      input.house,
      configured.connections,
      input.openingStateObservations,
      input.at,
    );
    configuredOpeningWarnings = openingOverlay.warnings;
    const resolved = { ...configured, connections: openingOverlay.connections, sensorBindings: resolvedBindings.bindings };
    const validation = validateTopology(resolved);
    if (validation.valid && openingOverlay.warnings.length === 0) return {
      topology: resolved,
      warnings: [
        ...resolvedBindings.warnings,
        ...openingOverlay.warnings,
        ...validation.issues.filter((issue) => issue.severity === "warning").map((issue) => issue.code.toUpperCase()),
      ],
    };
  }

  const frames: CoordinateFrame[] = input.house.floors.map((floor) => ({
    id: frameId(input.house.id, floor.id),
    version: input.house.updatedAt,
    kind: "building-local-3d",
    unit: "normalized",
    floorId: floor.id,
    // Zone/sensor z values are absolute in the building coordinate system.
    origin: { x: 0, y: 0, z: 0 },
    ...(input.house.orientationDegrees === undefined ? {} : { rotationDegrees: input.house.orientationDegrees }),
  }));
  const zones: SpatialZone[] = input.house.floors.flatMap((floor) => floor.rooms.map((room) => {
    const centroid = averagePoint(room.points);
    const heightM = floor.ceilingHeight ?? 2.4;
    const kind = zoneKind(floor);
    const scale = floorMetersPerPlanUnit(floor, input.house);
    return {
      id: roomZoneId(input.house.id, floor.id, room.id),
      name: room.name,
      kind,
      frameId: frameId(input.house.id, floor.id),
      floorId: floor.id,
      roomId: room.id,
      centroid: { ...centroid, z: floor.elevation + heightM / 2 },
      polygon: room.points.map((point) => ({ ...point })),
      elevationM: floor.elevation,
      heightM,
      ...(scale === null ? {} : { volumeM3: polygonArea(room.points) * scale ** 2 * heightM }),
      tags: ["derived-from-floor-plan"],
    } satisfies SpatialZone;
  }));
  const openings = deriveOpeningConnections(input.house, zones, input.openingStateObservations, input.at);
  const vents = deriveVentConnections(input.house, zones, input.openingStateObservations, input.at);
  const topologyZones = [...new Map([...zones, ...openings.boundaryZones, ...vents.boundaryZones]
    .map((zone) => [zone.id, zone])).values()];
  const bindingResult = defaultHouseBindings(input.house, input.sensors, topologyZones, input.bindings, input.at);
  const configuredConnections = Array.isArray(input.configuration?.connections)
    ? structuredClone(input.configuration.connections) as SpatialConnection[]
    : [];
  const configuredConnectionOverlay = applyArchitecturalOpeningStates(
    input.house,
    configuredConnections,
    input.openingStateObservations,
    input.at,
  );
  const topology: SpatialTopology = {
    scope,
    frames,
    zones: topologyZones,
    connections: [...openings.connections, ...vents.connections, ...configuredConnectionOverlay.connections],
    sensorBindings: bindingResult.bindings,
  };
  const validation = validateTopology(topology);
  return {
    topology,
    warnings: [
      ...(configured ? ["CONFIGURED_TOPOLOGY_INVALID"] : []),
      ...configuredOpeningWarnings,
      ...openings.warnings,
      ...vents.warnings,
      ...configuredConnectionOverlay.warnings,
      ...bindingResult.warnings,
      ...validation.issues.map((issue) => issue.code.toUpperCase()),
    ],
  };
}

function localMeters(latitude: number, longitude: number, originLatitude: number, originLongitude: number): Vector2 {
  const radians = Math.PI / 180;
  return {
    x: (longitude - originLongitude) * 111_320 * Math.cos(originLatitude * radians),
    y: (latitude - originLatitude) * 110_540,
  };
}

function rotatedRectangle(center: Vector2, width: number, height: number, degrees: number): Vector2[] {
  const angle = degrees * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    { x: -width / 2, y: -height / 2 }, { x: width / 2, y: -height / 2 },
    { x: width / 2, y: height / 2 }, { x: -width / 2, y: height / 2 },
  ].map((point) => ({ x: center.x + point.x * cos - point.y * sin, y: center.y + point.x * sin + point.y * cos }));
}

export function buildPropertyTopology(input: {
  property: Property;
  houses: House[];
  sensors: Sensor[];
  at: string;
  configuration?: Record<string, unknown>;
}): BuiltTopology {
  const scope: SpatialScope = { kind: "property", id: input.property.id };
  const configured = configuredTopology(input.configuration ?? {}, scope);
  if (configured && validateTopology(configured).valid) return { topology: configured, warnings: [] };
  const firstLocation = input.property.location
    ?? input.houses.find((house) => house.mapPlacement)?.mapPlacement
    ?? input.houses.find((house) => house.location)?.location;
  const metric = firstLocation !== undefined && firstLocation !== null;
  const frame: CoordinateFrame = {
    id: `property:${input.property.id}:site`,
    version: input.property.updatedAt,
    kind: "property-local-3d",
    unit: metric ? "m" : "normalized",
    ...(metric ? { origin: { x: 0, y: 0, z: 0 } } : {}),
  };
  const warnings: string[] = [];
  const zones: SpatialZone[] = input.houses.map((house, index) => {
    const placement = house.mapPlacement ?? house.location;
    const center = metric && placement
      ? localMeters(placement.latitude, placement.longitude, firstLocation!.latitude, firstLocation!.longitude)
      : { x: index * 12, y: 0 };
    if (!placement) warnings.push(`HOUSE_${house.id}_MAP_PLACEMENT_MISSING`);
    const footprint = house.mapPlacement
      ? house.floors.find((floor) => floor.id === house.mapPlacement!.footprintFloorId) ?? house.floors[0]
      : undefined;
    const scale = footprint ? floorMetersPerPlanUnit(footprint, house) ?? 1 : 1;
    const height = house.floors.reduce((maximum, floor) => Math.max(maximum, floor.elevation + (floor.ceilingHeight ?? 2.4)), 2.4);
    return {
      id: `property:${input.property.id}:house:${house.id}`,
      name: house.name,
      kind: "building",
      frameId: frame.id,
      centroid: { ...center, z: height / 2 },
      ...(footprint ? { polygon: rotatedRectangle(center, footprint.width * scale, footprint.height * scale, house.orientationDegrees ?? 0) } : {}),
      elevationM: 0,
      heightM: height,
      tags: [`house:${house.id}`],
    };
  });
  const zoneByHouse = new Map(input.houses.map((house) => [house.id, `property:${input.property.id}:house:${house.id}`]));
  const centroidByZone = new Map(zones.map((zone) => [zone.id, zone.centroid]));
  const sensorBindings: SpatialSensorBinding[] = input.sensors.flatMap((sensor) => {
    const zoneId = zoneByHouse.get(sensor.houseId);
    if (!zoneId) return [];
    return [{
      sensorId: sensor.id,
      zoneId,
      frameId: frame.id,
      position: centroidByZone.get(zoneId) ?? { x: 0, y: 0, z: 0 },
      role: "supporting" as const,
      activeFrom: DEFAULT_ACTIVE_FROM,
    }];
  });
  const configuredConnections = Array.isArray(input.configuration?.connections)
    ? structuredClone(input.configuration.connections) as SpatialConnection[]
    : [];
  const topology: SpatialTopology = { scope, frames: [frame], zones, connections: configuredConnections, sensorBindings };
  return { topology, warnings: [...warnings, ...validateTopology(topology).issues.map((issue) => issue.code.toUpperCase())] };
}

function pairSparseClimateSamples(samples: MeasurementSample[], bucketSeconds = 60): SpatialClimateSample[] {
  const buckets = new Map<string, { sensorId: string; observedAt: string; temperature?: MeasurementSample; humidity?: MeasurementSample }>();
  for (const sample of samples) {
    if (sample.metric !== "temperature" && sample.metric !== "humidity") continue;
    const epoch = Math.floor(Date.parse(sample.timestamp) / (bucketSeconds * 1_000)) * bucketSeconds * 1_000;
    if (!Number.isFinite(epoch)) continue;
    const key = `${sample.sensorId}:${epoch}`;
    const bucket = buckets.get(key) ?? { sensorId: sample.sensorId, observedAt: new Date(epoch).toISOString() };
    if (sample.metric === "temperature") bucket.temperature = sample;
    else bucket.humidity = sample;
    buckets.set(key, bucket);
  }
  const quality = (value: MeasurementSample["quality"]): number => value === "good" ? 1 : value === "estimated" ? 0.65 : 0.2;
  return [...buckets.values()]
    .filter((bucket): bucket is typeof bucket & { temperature: MeasurementSample; humidity: MeasurementSample } => Boolean(bucket.temperature && bucket.humidity))
    .map((bucket) => ({
      sensorId: bucket.sensorId,
      observedAt: bucket.observedAt,
      temperatureC: bucket.temperature.value,
      relativeHumidityPct: bucket.humidity.value,
      sourceQuality: Math.min(quality(bucket.temperature.quality), quality(bucket.humidity.quality)),
    }))
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.sensorId.localeCompare(right.sensorId));
}

function canonicalCalibrations(calibrations: StoredSpatialSensorCalibration[]): SpatialSensorCalibration[] {
  return calibrations.map(({ id: _id, houseId: _houseId, createdAt: _createdAt, ...calibration }) => calibration);
}

function canonicalContextEvents(events: StoredSpatialContextEvent[]): SpatialContextEvent[] {
  return events.map(({ houseId: _houseId, source: _source, payload: _payload, createdAt: _createdAt, ...event }) => event);
}

function queryMetrics(requiredMetrics: string[]): string[] {
  const metrics = new Set<string>();
  for (const metric of requiredMetrics) {
    if (metric === "temperatureC" || metric === "temperature") metrics.add("temperature");
    if (metric === "relativeHumidityPct" || metric === "humidity") metrics.add("humidity");
  }
  // All current engines need paired climate readings; querying both remains one bounded read.
  metrics.add("temperature");
  metrics.add("humidity");
  return [...metrics];
}

/**
 * Builds a complete effective-state timeline for every architectural opening
 * connection in an inference window. A synthetic open snapshot is used only
 * to recover whether the underlying connection is structurally/admin enabled;
 * actual interval states always come from the persisted observation history.
 */
export function buildOpeningConnectionStateIntervals(input: {
  house: House;
  sensors: Sensor[];
  bindings: StoredSpatialSensorBinding[];
  topology: SpatialTopology;
  openingStateObservations: OpeningStateObservation[];
  windowStart: string;
  windowEnd: string;
  configuration?: Record<string, unknown>;
}): SpatialConnectionStateInterval[] {
  const windowStart = Date.parse(input.windowStart);
  const windowEnd = Date.parse(input.windowEnd);
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) return [];

  const references = architecturalOpeningReferences(input.house);
  const forcedOpenObservations: OpeningStateObservation[] = references.map(({ floor, element }) => ({
    id: `spatial-force-open:${encodeURIComponent(floor.id)}/${encodeURIComponent(element.id)}`,
    houseId: input.house.id,
    floorId: floor.id,
    elementId: element.id,
    state: "open",
    openFraction: 1,
    source: "api",
    observedAt: input.windowEnd,
  }));
  const forcedOpenTopology = buildHouseTopology({
    house: input.house,
    sensors: input.sensors,
    bindings: input.bindings,
    at: input.windowEnd,
    openingStateObservations: forcedOpenObservations,
    ...(input.configuration === undefined ? {} : { configuration: input.configuration }),
  }).topology;
  const forcedConnections = new Map(forcedOpenTopology.connections.map((connection) => [connection.id, connection]));
  const intervals: SpatialConnectionStateInterval[] = [];

  for (const connection of input.topology.connections) {
    const referenceTags = [...new Set((connection.tags ?? []).filter((tag) => tag.startsWith(PLAN_ELEMENT_REFERENCE_PREFIX)))];
    if (referenceTags.length !== 1) continue;
    const parsed = parsePlanElementReference(referenceTags[0]!);
    if (!parsed) continue;
    const reference = references.find(({ floor, element }) => floor.id === parsed.floorId && element.id === parsed.elementId);
    if (!reference) continue;

    const observations = input.openingStateObservations.filter((observation) => (
      observation.floorId === reference.floor.id && observation.elementId === reference.element.id
    ));
    const boundaries = new Set<number>([windowStart, windowEnd]);
    const addBoundary = (value: number): void => {
      if (Number.isFinite(value) && value > windowStart && value < windowEnd) boundaries.add(value);
    };
    for (const observation of observations) {
      const observedAt = Date.parse(observation.observedAt);
      addBoundary(observedAt);
      if (observation.validUntil !== undefined) addBoundary(Date.parse(observation.validUntil));
      if (observation.source === "home-assistant" || observation.source === "tapo") {
        addBoundary(observedAt + (reference.element.stateBinding?.staleAfterSeconds ?? 900) * 1_000);
      }
    }

    const structurallyEnabled = forcedConnections.get(connection.id)?.enabled === true;
    const ordered = [...boundaries].sort((left, right) => left - right);
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const start = ordered[index]!;
      const end = ordered[index + 1]!;
      const effectiveAt = new Date(start + Math.floor((end - start) / 2)).toISOString();
      const effective = resolvePlanElementOpeningState(reference.element, observations, effectiveAt);
      const enabled = structurallyEnabled && effective.openFraction > 0;
      const next: SpatialConnectionStateInterval = {
        connectionId: connection.id,
        startAt: new Date(start).toISOString(),
        endAt: new Date(end).toISOString(),
        enabled,
        openFraction: enabled ? effective.openFraction : 0,
      };
      const previous = intervals.at(-1);
      if (previous?.connectionId === next.connectionId
        && previous.endAt === next.startAt
        && previous.enabled === next.enabled
        && previous.openFraction === next.openFraction) {
        previous.endAt = next.endAt;
      } else {
        intervals.push(next);
      }
    }
  }
  return intervals;
}

interface ResolvedSpatialControlData {
  house: House | null;
  property: Property | null;
  houses: House[];
  propertyAreas: PropertyArea[];
  sensors: Sensor[];
  built: BuiltTopology;
}

function telemetryReadWarnings(provenance: HybridTelemetryReadProvenance[]): string[] {
  return provenance.some((item) => item.archiveState === "failed")
    ? ["TELEMETRY_ARCHIVE_UNAVAILABLE_LOCAL_FALLBACK"]
    : [];
}

export class ClimateDatabaseSpatialInputAdapter implements SpatialCoreInputPort {
  constructor(readonly core: CoreClimateReader, readonly telemetry: SpatialTelemetryReader) {}

  listScopes(): SpatialScope[] {
    return [
      ...this.core.listProperties(10_000, 0).map((property) => ({ kind: "property" as const, id: property.id })),
      ...this.core.listHouses().map((house) => ({ kind: "house" as const, id: house.id })),
    ];
  }

  scopeExists(scope: SpatialScope): boolean {
    return scope.kind === "house" ? this.core.getHouse(scope.id) !== null : this.core.getProperty(scope.id) !== null;
  }

  housesForScope(scope: SpatialScope): House[] {
    if (scope.kind === "house") {
      const house = this.core.getHouse(scope.id);
      return house ? [house] : [];
    }
    return this.core.listHouses().filter((house) => house.propertyId === scope.id);
  }

  async describe(request: {
    partition: SpatialDataPartition;
    scope: SpatialScope;
    bucketAt: string;
    configuration: SpatialConfigurationVersion;
    bindings: StoredSpatialSensorBinding[];
  }): Promise<SpatialCoreDescription> {
    const resolved = this.#resolveControlData(
      request.scope,
      request.bucketAt,
      request.configuration,
      request.bindings,
    );
    return { topology: resolved.built.topology, warnings: resolved.built.warnings };
  }

  async load(request: {
    partition: SpatialDataPartition;
    scope: SpatialScope;
    bucketAt: string;
    windowMinutes: number;
    requiredMetrics: string[];
    configuration: SpatialConfigurationVersion;
    bindings: StoredSpatialSensorBinding[];
    calibrations: StoredSpatialSensorCalibration[];
    contextEvents: StoredSpatialContextEvent[];
  }): Promise<SpatialCoreDataset> {
    const bucketEpoch = Date.parse(request.bucketAt);
    if (!Number.isFinite(bucketEpoch)) throw new TypeError("bucketAt must be an ISO timestamp");
    const windowStart = new Date(bucketEpoch - request.windowMinutes * 60_000).toISOString();
    const windowEnd = new Date(bucketEpoch).toISOString();
    const resolved = this.#resolveControlData(
      request.scope,
      request.bucketAt,
      request.configuration,
      request.bindings,
    );
    const openingStateObservations = resolved.house === null
      ? []
      : [...new Map([
          ...this.core.listOpeningStateObservations(resolved.house.id, 10_000, windowStart),
          ...this.core.listOpeningStateObservationHistory(resolved.house.id, windowStart, windowEnd, 10_000),
        ].map((observation) => [observation.id, observation])).values()]
        .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id));
    const measurements = await this.telemetry.measurementWindow({
      sensorIds: resolved.sensors.map((sensor) => sensor.id),
      metrics: queryMetrics(request.requiredMetrics),
      from: windowStart,
      to: windowEnd,
      limit: 250_000,
    });
    const outdoorReads = await Promise.all(resolved.houses.map((candidate) => this.telemetry.outdoorTemperatureHistory({
      houseId: candidate.id,
      locationKey: outdoorLocationKey(candidate.location),
      from: windowStart,
      to: windowEnd,
      limit: 20_000,
    })));
    const sparseSamples = measurements.records;
    const outdoorTemperature = outdoorReads.flatMap((result) => result.records);
    const engineInput: SpatialLayerEngineInput = {
      scope: request.scope,
      topology: resolved.built.topology,
      ...(resolved.house === null ? {} : {
        connectionStateIntervals: buildOpeningConnectionStateIntervals({
          house: resolved.house,
          sensors: resolved.sensors,
          bindings: request.bindings,
          topology: resolved.built.topology,
          openingStateObservations,
          windowStart,
          windowEnd,
          configuration: request.configuration.config,
        }),
      }),
      samples: pairSparseClimateSamples(sparseSamples),
      calibrations: canonicalCalibrations(request.calibrations),
      contextEvents: canonicalContextEvents(request.contextEvents),
      generatedAt: request.bucketAt,
      windowStart,
      windowEnd,
      configVersion: String(request.configuration.version),
      targetBucketSeconds: 60,
      config: request.configuration.config,
    };
    return {
      engineInput,
      house: resolved.house,
      property: resolved.property,
      houses: resolved.houses,
      propertyAreas: resolved.propertyAreas,
      sensors: resolved.sensors,
      sparseSamples,
      outdoorTemperature,
      topology: resolved.built.topology,
      warnings: [
        ...resolved.built.warnings,
        ...telemetryReadWarnings([measurements.provenance, ...outdoorReads.map((result) => result.provenance)]),
      ],
    };
  }

  #resolveControlData(
    scope: SpatialScope,
    bucketAt: string,
    configuration: SpatialConfigurationVersion,
    bindings: StoredSpatialSensorBinding[],
  ): ResolvedSpatialControlData {
    if (!Number.isFinite(Date.parse(bucketAt))) throw new TypeError("bucketAt must be an ISO timestamp");
    const houses = this.housesForScope(scope);
    const house = scope.kind === "house" ? houses[0] ?? null : null;
    const property = scope.kind === "property"
      ? this.core.getProperty(scope.id)
      : house ? this.core.getProperty(house.propertyId) : null;
    if ((scope.kind === "house" && !house) || (scope.kind === "property" && !property)) {
      throw new Error(`${scope.kind} ${scope.id} does not exist`);
    }
    const sensors = houses.flatMap((candidate) => this.core.listSensors(candidate.id)).filter((sensor) => sensor.enabled);
    const openingStateObservations = house
      ? this.core.listOpeningStateObservations(house.id, 10_000, bucketAt)
      : [];
    const built = house
      ? buildHouseTopology({ house, sensors, bindings, at: bucketAt, configuration: configuration.config,
        openingStateObservations })
      : buildPropertyTopology({ property: property!, houses, sensors, at: bucketAt, configuration: configuration.config });
    return {
      house,
      property,
      houses,
      propertyAreas: property ? this.core.listPropertyAreas(property.id, 10_000, 0) : [],
      sensors,
      built,
    };
  }
}
