import {
  configuredPlanElementOpeningState,
  floorMetersPerPlanUnit,
  resolvePlanElementOpeningState,
  type House,
  type MeasurementSample,
  type OpeningStateObservation,
  type Property,
  type PropertyArea,
  type Sensor,
} from "@climate-twin/contracts";
import {
  validateTopology,
  type CoordinateFrame,
  type SpatialClimateSample,
  type SpatialConnection,
  type SpatialConnectionStateInterval,
  type SpatialContextEvent,
  type SpatialSensorBinding,
  type SpatialSensorCalibration,
  type SpatialTopology,
  type SpatialZone,
  type Vector2,
} from "@climate-twin/spatial-layers";
import type {
  HybridTelemetryReadProvenance,
} from "../../timeseries/read-facade.js";
import type {
  SpatialScope,
  StoredSpatialContextEvent,
  StoredSpatialSensorBinding,
  StoredSpatialSensorCalibration,
} from "../types.js";
import { ArchitecturalOpeningReference, BuiltTopology, DEFAULT_ACTIVE_FROM, PLAN_ELEMENT_REFERENCE_PREFIX, architecturalOpeningAreaM2, architecturalOpeningReferences, averagePoint, configuredTopology, connectionMatchesOpeningKind, defaultHouseBindings, deriveOpeningConnections, deriveVentConnections, frameId, legacyOpeningConnectionId, parsePlanElementReference, planElementReferenceTag, polygonArea, roomZoneId, zoneKind } from "./01-spatial-telemetry-reader-to-architectural-opening-ar.js";

export function applyArchitecturalOpeningStates(
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

export function localMeters(latitude: number, longitude: number, originLatitude: number, originLongitude: number): Vector2 {
  const radians = Math.PI / 180;
  return {
    x: (longitude - originLongitude) * 111_320 * Math.cos(originLatitude * radians),
    y: (latitude - originLatitude) * 110_540,
  };
}

export function rotatedRectangle(center: Vector2, width: number, height: number, degrees: number): Vector2[] {
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

export function pairSparseClimateSamples(samples: MeasurementSample[], bucketSeconds = 60): SpatialClimateSample[] {
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

export function canonicalCalibrations(calibrations: StoredSpatialSensorCalibration[]): SpatialSensorCalibration[] {
  return calibrations.map(({ id: _id, houseId: _houseId, createdAt: _createdAt, ...calibration }) => calibration);
}

export function canonicalContextEvents(events: StoredSpatialContextEvent[]): SpatialContextEvent[] {
  return events.map(({ houseId: _houseId, source: _source, payload: _payload, createdAt: _createdAt, ...event }) => event);
}

export function queryMetrics(requiredMetrics: string[]): string[] {
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

export interface ResolvedSpatialControlData {
  house: House | null;
  property: Property | null;
  houses: House[];
  propertyAreas: PropertyArea[];
  sensors: Sensor[];
  built: BuiltTopology;
}

export function telemetryReadWarnings(provenance: HybridTelemetryReadProvenance[]): string[] {
  return provenance.some((item) => item.archiveState === "failed")
    ? ["TELEMETRY_ARCHIVE_UNAVAILABLE_LOCAL_FALLBACK"]
    : [];
}
