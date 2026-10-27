import { STUGBY_MAX_BLOB_BYTES, STUGBY_MAX_EVENT_BYTES, STUGBY_PROTOCOL_VERSION } from "./protocol-contracts.js";
import type { JsonObject, JsonValue, StugubyDataset, StugubyDatasetPayload, StugubyHomeRecoveryKind, StugubySignedEvent, StugubyWireEvent, StugubyHomeCommand } from "./protocol-contracts.js";

import { eventPayloadForHash, legacySigningEnvelope, normalizeLegacySignedEvent, rememberLegacySignedEvent } from "./legacy-wire.js";
import { ENVELOPE_SCHEMA_SET, EVENT_KIND_SET, assertSafeFederationPayload, coordinate, fail, isObject, isStugubyDataset, isStugubyRole, onlyKeys, optionalString, point, requireArray, requireBoolean, requireEnumString, requireFiniteNumber, requireIdentifier, requireInteger, requireIsoDate, requireNullableFiniteNumber, requireNullableIsoDate, requireNullableString, requireString, requireStringArray, validateShareGrant, validateSharedProperty } from "./validation.js";
import { compareCodeUnits } from "./text-order.js";

export function validateDatasetPayload(dataset: StugubyDataset, value: unknown): StugubyDatasetPayload {
  assertSafeFederationPayload(value);
  if (!isObject(value)) fail(`${dataset} must be an object`);
  requireIdentifier(value, "publicationId");
  switch (dataset) {
    case "home.directory.v1":
      onlyKeys(value, ["publicationId", "name", "timezone", "localHouseId"], dataset);
      requireString(value, "name");
      requireString(value, "timezone");
      optionalString(value, "localHouseId");
      break;
    case "home.location.v1":
      onlyKeys(value, ["publicationId", "latitude", "longitude", "label", "countryCode", "mapPlacement", "orientationDegrees"], dataset);
      if (requireFiniteNumber(value, "latitude") < -90 || Number(value.latitude) > 90) fail("latitude is outside WGS84 bounds");
      if (requireFiniteNumber(value, "longitude") < -180 || Number(value.longitude) > 180) fail("longitude is outside WGS84 bounds");
      optionalString(value, "label"); optionalString(value, "countryCode");
      if (value.orientationDegrees !== undefined) requireFiniteNumber(value, "orientationDegrees");
      if (value.mapPlacement !== undefined) {
        if (!isObject(value.mapPlacement)) fail("mapPlacement must be an object");
        onlyKeys(value.mapPlacement, ["latitude", "longitude", "metersPerPlanUnit", "footprintFloorPublicationId"], "mapPlacement");
        coordinate(value.mapPlacement, "mapPlacement");
        if (requireFiniteNumber(value.mapPlacement, "metersPerPlanUnit") <= 0) fail("metersPerPlanUnit must be positive");
        optionalString(value.mapPlacement, "footprintFloorPublicationId");
      }
      break;
    case "home.structure.v1":
      onlyKeys(value, ["publicationId", "floors"], dataset);
      {
      const floorIds = new Set<string>();
      for (const floor of requireArray(value.floors, "floors", 1_000)) {
        if (!isObject(floor)) fail("each floor must be an object");
        onlyKeys(floor, ["floorPublicationId", "localFloorId", "name", "type", "width", "height", "metersPerPlanUnit", "elevation", "ceilingHeight", "wallHeight", "roof", "walls", "rooms", "planElements"], "floor");
        const floorId = requireIdentifier(floor, "floorPublicationId"); requireString(floor, "name");
        if (floorIds.has(floorId)) fail(`duplicate floor publication id ${floorId}`);
        floorIds.add(floorId);
        optionalString(floor, "localFloorId"); optionalString(floor, "type");
        if (requireFiniteNumber(floor, "width") <= 0 || requireFiniteNumber(floor, "height") <= 0) fail("floor dimensions must be positive");
        requireFiniteNumber(floor, "elevation");
        for (const key of ["metersPerPlanUnit", "ceilingHeight", "wallHeight"] as const) {
          if (floor[key] !== undefined && requireFiniteNumber(floor, key) <= 0) fail(`${key} must be positive`);
        }
        if (floor.roof !== undefined) {
          if (!isObject(floor.roof)) fail("floor.roof must be an object");
          onlyKeys(floor.roof, ["style", "pitchDegrees", "ridgeAxis", "overhang", "eavesHeight"], "floor.roof");
          requireString(floor.roof, "style"); requireString(floor.roof, "ridgeAxis");
          requireFiniteNumber(floor.roof, "pitchDegrees"); requireFiniteNumber(floor.roof, "overhang"); requireFiniteNumber(floor.roof, "eavesHeight");
        }
        const wallIds = new Set<string>();
        for (const wall of requireArray(floor.walls, "floor.walls", 100_000)) {
          if (!isObject(wall)) fail("each wall must be an object");
          onlyKeys(wall, ["wallPublicationId", "localWallId", "from", "to"], "wall");
          const wallId = requireIdentifier(wall, "wallPublicationId"); optionalString(wall, "localWallId");
          if (wallIds.has(wallId)) fail(`duplicate wall publication id ${wallId}`);
          wallIds.add(wallId);
          point(wall.from, "wall.from"); point(wall.to, "wall.to");
        }
        const roomIds = new Set<string>();
        for (const room of requireArray(floor.rooms, "floor.rooms", 100_000)) {
          if (!isObject(room)) fail("each room must be an object");
          onlyKeys(room, ["roomPublicationId", "localRoomId", "name", "points", "kind"], "room");
          const roomId = requireIdentifier(room, "roomPublicationId"); optionalString(room, "localRoomId");
          if (roomIds.has(roomId)) fail(`duplicate room publication id ${roomId}`);
          roomIds.add(roomId);
          requireString(room, "name"); optionalString(room, "kind");
          for (const roomPoint of requireArray(room.points, "room.points", 100_000)) point(roomPoint, "room point");
        }
        const elementIds = new Set<string>();
        for (const element of requireArray(floor.planElements, "floor.planElements", 100_000)) {
          if (!isObject(element)) fail("each plan element must be an object");
          onlyKeys(element, ["planElementPublicationId", "localPlanElementId", "kind", "position", "rotationDegrees", "width", "height", "label", "state", "openFraction", "bottomOffsetM", "wallPublicationId", "variant", "nominalFlowM3h", "verticalExtent", "chimneyHeightAboveRoof", "chimneyWidth", "chimneyDepth", "projection"], "plan element");
          const elementId = requireIdentifier(element, "planElementPublicationId"); optionalString(element, "localPlanElementId");
          if (elementIds.has(elementId)) fail(`duplicate plan element publication id ${elementId}`);
          elementIds.add(elementId);
          requireString(element, "kind"); point(element.position, "plan element position");
          requireFiniteNumber(element, "rotationDegrees");
          for (const key of ["width", "height", "openFraction", "bottomOffsetM", "nominalFlowM3h", "chimneyHeightAboveRoof", "chimneyWidth", "chimneyDepth", "projection"] as const) {
            if (element[key] !== undefined) requireFiniteNumber(element, key);
          }
          for (const key of ["label", "state", "wallPublicationId", "variant", "verticalExtent"] as const) optionalString(element, key);
          if (typeof element.wallPublicationId === "string" && !wallIds.has(element.wallPublicationId)) fail(`plan element ${elementId} references an unknown wall`);
        }
      }
      }
      break;
    case "home.floorplan.v1":
      onlyKeys(value, ["publicationId", "assets"], dataset);
      {
      const assetFloors = new Set<string>();
      for (const asset of requireArray(value.assets, "assets", 1_000)) {
        if (!isObject(asset) || !isObject(asset.image)) fail("each floor-plan asset requires an image reference");
        onlyKeys(asset, ["floorPublicationId", "image"], "floor-plan asset");
        onlyKeys(asset.image, ["digest", "byteLength", "mediaType"], "floor-plan image");
        const floorId = requireIdentifier(asset, "floorPublicationId");
        if (assetFloors.has(floorId)) fail(`duplicate floor-plan asset for floor ${floorId}`);
        assetFloors.add(floorId);
        const digest = requireString(asset.image, "digest");
        if (!/^[a-f0-9]{64}$/.test(digest)) fail("floor-plan digest must be lowercase SHA-256");
        const byteLength = requireInteger(asset.image, "byteLength", 1);
        if (byteLength > STUGBY_MAX_BLOB_BYTES) fail("floor-plan asset exceeds maximum size");
        if (!["image/png", "image/jpeg", "image/webp"].includes(String(asset.image.mediaType))) fail("unsupported floor-plan media type");
      }
      }
      break;
    case "home.sensor-catalog.v1":
      onlyKeys(value, ["publicationId", "sensors"], dataset);
      {
      const sensorIds = new Set<string>();
      for (const sensor of requireArray(value.sensors, "sensors", 100_000)) {
        if (!isObject(sensor)) fail("each sensor must be an object");
        onlyKeys(sensor, ["sensorPublicationId", "localSensorId", "floorPublicationId", "roomPublicationId", "name", "model", "tags", "enabled", "x", "y", "z", "metricIds"], "sensor");
        const sensorId = requireIdentifier(sensor, "sensorPublicationId");
        if (sensorIds.has(sensorId)) fail(`duplicate sensor publication id ${sensorId}`);
        sensorIds.add(sensorId);
        requireIdentifier(sensor, "floorPublicationId");
        requireString(sensor, "name");
        requireString(sensor, "model");
        requireStringArray(sensor.tags, "sensor.tags", 100);
        requireBoolean(sensor, "enabled");
        optionalString(sensor, "localSensorId"); optionalString(sensor, "roomPublicationId");
        requireFiniteNumber(sensor, "x");
        requireFiniteNumber(sensor, "y");
        requireFiniteNumber(sensor, "z");
        requireStringArray(sensor.metricIds, "sensor.metricIds", 1_000);
      }
      }
      break;
    case "home.telemetry.v1":
      onlyKeys(value, ["publicationId", "chunkId", "from", "to", "complete", "samples"], dataset);
      requireString(value, "chunkId");
      requireIsoDate(value.from, "from");
      requireIsoDate(value.to, "to");
      if (Date.parse(String(value.from)) > Date.parse(String(value.to))) fail("telemetry from must not follow to");
      if (typeof value.complete !== "boolean") fail("complete must be boolean");
      for (const sample of requireArray(value.samples, "samples", 100_000)) {
        if (!isObject(sample)) fail("each telemetry sample must be an object");
        onlyKeys(sample, ["sensorPublicationId", "metricId", "timestamp", "value", "quality", "correctionOf"], "telemetry sample");
        requireIdentifier(sample, "sensorPublicationId");
        requireIdentifier(sample, "metricId");
        requireIsoDate(sample.timestamp, "sample.timestamp");
        if (Date.parse(String(sample.timestamp)) < Date.parse(String(value.from)) || Date.parse(String(sample.timestamp)) > Date.parse(String(value.to))) fail("telemetry sample is outside chunk bounds");
        requireFiniteNumber(sample, "value");
        if (!["good", "estimated", "stale"].includes(String(sample.quality))) fail("invalid telemetry quality");
        optionalString(sample, "correctionOf");
      }
      break;
    case "home.notes.v1":
      onlyKeys(value, ["publicationId", "notes"], dataset);
      {
      const noteIds = new Set<string>();
      for (const note of requireArray(value.notes, "notes", 100_000)) {
        if (!isObject(note)) fail("each Home note must be an object");
        onlyKeys(note, ["notePublicationId", "localNoteId", "kind", "text", "createdAt", "updatedAt"], "Home note");
        const noteId = requireIdentifier(note, "notePublicationId"); requireString(note, "text"); optionalString(note, "localNoteId");
        if (noteIds.has(noteId)) fail(`duplicate Home note publication id ${noteId}`);
        noteIds.add(noteId);
        if (!["note", "inspection", "maintenance"].includes(String(note.kind))) fail("invalid Home note kind");
        requireIsoDate(note.createdAt, "note.createdAt"); requireIsoDate(note.updatedAt, "note.updatedAt");
        if (Date.parse(String(note.updatedAt)) < Date.parse(String(note.createdAt))) fail(`Home note ${noteId} updatedAt precedes createdAt`);
      }
      }
      break;
    case "home.observations.v1":
      onlyKeys(value, ["publicationId", "observations"], dataset);
      {
      const observationIds = new Set<string>();
      for (const observation of requireArray(value.observations, "observations", 100_000)) {
        if (!isObject(observation)) fail("each observation must be an object");
        onlyKeys(observation, ["observationPublicationId", "localObservationId", "floorPublicationId", "sensorPublicationId", "kind", "severity", "note", "x", "y", "occurredAt", "timePrecision", "validFrom", "validTo", "confidence", "status", "resolutionNote", "resolvedAt", "updatedAt"], "observation");
        const observationId = requireIdentifier(observation, "observationPublicationId"); requireIdentifier(observation, "floorPublicationId");
        if (observationIds.has(observationId)) fail(`duplicate observation publication id ${observationId}`);
        observationIds.add(observationId);
        requireString(observation, "kind"); requireString(observation, "severity"); requireString(observation, "note");
        optionalString(observation, "localObservationId"); optionalString(observation, "sensorPublicationId");
        for (const axis of ["x", "y"] as const) if (observation[axis] !== null) requireFiniteNumber(observation, axis);
        requireIsoDate(observation.occurredAt, "observation.occurredAt"); requireIsoDate(observation.updatedAt, "observation.updatedAt");
        for (const key of ["validFrom", "validTo", "resolvedAt"] as const) if (observation[key] !== undefined) requireNullableIsoDate(observation[key], `observation.${key}`);
        for (const key of ["timePrecision", "confidence", "status"] as const) optionalString(observation, key);
        if (observation.resolutionNote !== undefined) requireNullableString(observation.resolutionNote, "observation.resolutionNote");
      }
      }
      break;
    case "home.recovery.v1": {
      onlyKeys(value, ["publicationId", "chunkId", "generation", "kind", "complete", "records"], dataset);
      requireString(value, "chunkId");
      requireInteger(value, "generation", 1);
      if (!["manifest", "measurement-definitions", "alert-rules", "alert-events", "static-parameters", "opening-states",
        "weather-history", "electricity-history", "assets"].includes(String(value.kind))) fail("invalid Home recovery kind");
      if (typeof value.complete !== "boolean") fail("recovery complete must be boolean");
      const records = requireArray(value.records, "records", 25_000);
      const allowed: Record<StugubyHomeRecoveryKind, readonly string[]> = {
        manifest: ["telemetrySamples", "generatedAt"],
        "measurement-definitions": ["id", "labels", "unit", "dimension", "allowedUnits", "kind", "defaultAggregation", "precision", "validMin", "validMax", "displayMin", "displayMax", "interpolationDelta", "colorScale", "enabled", "spatialInterpolation", "forecastSupported"],
        "alert-rules": ["ruleKey", "name", "sensorPublicationId", "metric", "operator", "threshold", "durationSeconds", "severity", "enabled", "retiredAt"],
        "alert-events": ["eventKey", "ruleKey", "sensorPublicationId", "metric", "value", "threshold", "severity", "startedAt", "acknowledgedAt", "resolvedAt"],
        "static-parameters": ["parameterKey", "scopeType", "scopePublicationId", "key", "value", "unit", "label"],
        "opening-states": ["openingKey", "floorPublicationId", "planElementPublicationId", "state", "openFraction", "observedAt", "validUntil"],
        "weather-history": ["weatherKey", "locationKey", "timestamp", "temperatureC", "source", "fetchedAt", "stationId", "stationName", "conditions"],
        "electricity-history": ["priceKey", "startAt", "endAt", "rawPriceCentsPerKwh", "marginCentsPerKwh", "fetchedAt"],
        assets: ["assetKey", "name", "mimeType", "kind", "digest", "byteLength", "createdAt"],
      };
      for (const record of records) {
        if (!isObject(record)) fail("each Home recovery record must be an object");
        onlyKeys(record, allowed[value.kind as StugubyHomeRecoveryKind], `${String(value.kind)} recovery record`);
      }
      const kind = value.kind as StugubyHomeRecoveryKind;
      const typedRecords = records as Array<Record<string, unknown>>;
      const uniqueRecordKey: Partial<Record<StugubyHomeRecoveryKind, string>> = {
        "measurement-definitions": "id",
        "alert-rules": "ruleKey",
        "alert-events": "eventKey",
        "static-parameters": "parameterKey",
        "opening-states": "openingKey",
        "weather-history": "weatherKey",
        "electricity-history": "priceKey",
        assets: "assetKey",
      };
      const recordKey = uniqueRecordKey[kind];
      if (recordKey) {
        const seen = new Set<string>();
        for (const record of typedRecords) {
          const key = requireIdentifier(record, recordKey);
          if (seen.has(key)) fail(`${kind} recovery records contain duplicate ${recordKey}`);
          seen.add(key);
        }
      }
      if (kind === "manifest") {
        if (typedRecords.length !== 1) fail("Home recovery manifest requires exactly one record");
        const record = typedRecords[0]!;
        requireInteger(record, "telemetrySamples", 0);
        requireIsoDate(record.generatedAt, "manifest.generatedAt");
      } else if (kind === "measurement-definitions") {
        for (const record of typedRecords) {
          requireString(record, "unit");
          if (!isObject(record.labels) || Object.keys(record.labels).length === 0
            || Object.keys(record.labels).length > 100
            || Object.values(record.labels).some((label) => typeof label !== "string" || label.length === 0 || label.length > 500)) {
            fail("measurement definition labels must be a non-empty string map");
          }
          optionalString(record, "dimension");
          if (record.allowedUnits !== undefined) requireStringArray(record.allowedUnits, "measurement definition allowedUnits", 100);
          if (record.kind !== undefined) {
            requireEnumString(record, "kind", ["gauge", "rate", "increment", "cumulative_counter", "binary_state", "categorical_state"]);
          }
          if (record.defaultAggregation !== undefined) {
            requireEnumString(record, "defaultAggregation", ["mean", "sum", "delta", "last", "time_weighted_mean", "duration", "custom"]);
          }
          requireInteger(record, "precision", 0);
          const validMin = requireNullableFiniteNumber(record, "validMin");
          const validMax = requireNullableFiniteNumber(record, "validMax");
          const displayMin = requireNullableFiniteNumber(record, "displayMin");
          const displayMax = requireNullableFiniteNumber(record, "displayMax");
          if (validMin !== null && validMax !== null && validMin > validMax) fail("measurement definition validMin exceeds validMax");
          if (displayMin !== null && displayMax !== null && displayMin > displayMax) fail("measurement definition displayMin exceeds displayMax");
          if (requireFiniteNumber(record, "interpolationDelta") < 0) fail("measurement definition interpolationDelta must not be negative");
          requireEnumString(record, "colorScale", ["thermal", "humidity", "air-quality", "sequential"]);
          requireBoolean(record, "enabled");
          requireBoolean(record, "spatialInterpolation");
          requireBoolean(record, "forecastSupported");
        }
      } else if (kind === "alert-rules") {
        for (const record of typedRecords) {
          requireString(record, "name");
          requireIdentifier(record, "sensorPublicationId");
          requireIdentifier(record, "metric");
          requireEnumString(record, "operator", ["gt", "gte", "lt", "lte"]);
          requireFiniteNumber(record, "threshold");
          requireInteger(record, "durationSeconds", 0);
          requireEnumString(record, "severity", ["info", "warning", "critical"]);
          requireBoolean(record, "enabled");
          requireNullableIsoDate(record.retiredAt, "alert rule retiredAt");
        }
      } else if (kind === "alert-events") {
        for (const record of typedRecords) {
          requireIdentifier(record, "ruleKey");
          requireIdentifier(record, "sensorPublicationId");
          requireIdentifier(record, "metric");
          requireFiniteNumber(record, "value");
          requireFiniteNumber(record, "threshold");
          requireEnumString(record, "severity", ["info", "warning", "critical"]);
          const startedAt = requireIsoDate(record.startedAt, "alert event startedAt");
          const acknowledgedAt = requireNullableIsoDate(record.acknowledgedAt, "alert event acknowledgedAt");
          const resolvedAt = requireNullableIsoDate(record.resolvedAt, "alert event resolvedAt");
          if (acknowledgedAt && Date.parse(acknowledgedAt) < Date.parse(startedAt)) fail("alert event acknowledgedAt precedes startedAt");
          if (resolvedAt && Date.parse(resolvedAt) < Date.parse(startedAt)) fail("alert event resolvedAt precedes startedAt");
        }
      } else if (kind === "static-parameters") {
        for (const record of typedRecords) {
          requireEnumString(record, "scopeType", ["house", "floor", "room", "sensor"]);
          requireIdentifier(record, "scopePublicationId");
          requireString(record, "key");
          if (!["string", "number", "boolean"].includes(typeof record.value)
            || (typeof record.value === "number" && !Number.isFinite(record.value))) {
            fail("static parameter value must be a finite scalar");
          }
          requireNullableString(record.unit, "static parameter unit");
          requireString(record, "label");
        }
      } else if (kind === "opening-states") {
        for (const record of typedRecords) {
          requireIdentifier(record, "floorPublicationId");
          requireIdentifier(record, "planElementPublicationId");
          const state = requireEnumString(record, "state", ["open", "closed", "unknown"]);
          const openFraction = requireNullableFiniteNumber(record, "openFraction");
          if (openFraction !== null && (openFraction < 0 || openFraction > 1
            || (state !== "open" && openFraction !== 0))) {
            fail("opening-state openFraction is invalid");
          }
          const observedAt = requireIsoDate(record.observedAt, "opening-state observedAt");
          const validUntil = requireNullableIsoDate(record.validUntil, "opening-state validUntil");
          if (validUntil && Date.parse(validUntil) <= Date.parse(observedAt)) fail("opening-state validUntil must follow observedAt");
        }
      } else if (kind === "weather-history") {
        for (const record of typedRecords) {
          requireString(record, "locationKey");
          requireIsoDate(record.timestamp, "weather timestamp");
          requireFiniteNumber(record, "temperatureC");
          requireEnumString(record, "source", [
            "fmi-observation", "open-meteo-current", "fmi-backfill", "open-meteo-backfill", "mock", "api",
          ]);
          requireIsoDate(record.fetchedAt, "weather fetchedAt");
          requireNullableString(record.stationId, "weather stationId");
          requireNullableString(record.stationName, "weather stationName");
          if (record.conditions !== null && !isObject(record.conditions)) fail("weather conditions must be an object or null");
        }
      } else if (kind === "electricity-history") {
        for (const record of typedRecords) {
          const startAt = requireIsoDate(record.startAt, "electricity startAt");
          const endAt = requireIsoDate(record.endAt, "electricity endAt");
          if (Date.parse(endAt) <= Date.parse(startAt)) fail("electricity endAt must follow startAt");
          requireFiniteNumber(record, "rawPriceCentsPerKwh");
          requireFiniteNumber(record, "marginCentsPerKwh");
          requireIsoDate(record.fetchedAt, "electricity fetchedAt");
        }
      } else {
        for (const record of typedRecords) {
          requireString(record, "name");
          if (!["image/png", "image/jpeg", "image/webp", "model/gltf+json", "model/gltf-binary"].includes(String(record.mimeType))) {
            fail("unsupported Home recovery asset media type");
          }
          if (!["floor-plan", "model-3d", "other"].includes(String(record.kind))) fail("invalid Home recovery asset kind");
          if (!/^[a-f0-9]{64}$/.test(requireString(record, "digest"))) fail("Home recovery asset digest must be lowercase SHA-256");
          const byteLength = requireInteger(record, "byteLength", 1);
          if (byteLength > STUGBY_MAX_BLOB_BYTES) fail("Home recovery asset exceeds maximum size");
          requireIsoDate(record.createdAt, "asset.createdAt");
        }
      }
      break;
    }
  }
  return value as unknown as StugubyDatasetPayload;
}

export function validateWireEvent(value: unknown): StugubyWireEvent {
  if (!isObject(value)) fail("event must be an object");
  onlyKeys(value, ["protocolVersion", "stugubyId", "eventId", "eventKind", "authorityNodeId", "streamId", "sequence", "schema", "resourceId", "operation", "revision", "grantId", "grantEpoch", "occurredAt", "payload", "payloadHash", "keyFingerprint", "signature"], "event");
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > STUGBY_MAX_EVENT_BYTES) fail("event exceeds maximum encoded size");
  if (value.protocolVersion !== STUGBY_PROTOCOL_VERSION) fail("unsupported protocol version");
  requireIdentifier(value, "stugubyId");
  requireIdentifier(value, "eventId");
  if (!EVENT_KIND_SET.has(String(value.eventKind))) fail("invalid event kind");
  requireIdentifier(value, "authorityNodeId");
  requireIdentifier(value, "streamId");
  requireInteger(value, "sequence", 1);
  requireIdentifier(value, "resourceId");
  requireInteger(value, "revision", 1);
  requireIsoDate(value.occurredAt, "occurredAt");
  if (!ENVELOPE_SCHEMA_SET.has(String(value.schema))) fail("unsupported event schema");
  if (!/^[a-f0-9]{64}$/.test(requireString(value, "payloadHash"))) fail("payloadHash must be lowercase SHA-256");
  if (value.operation !== "upsert" && value.operation !== "tombstone") fail("invalid operation");
  if (value.operation === "tombstone" && value.payload !== null) fail("tombstone payload must be null");
  if (value.operation === "upsert" && value.payload === null) fail("upsert payload is required");
  if (isStugubyDataset(value.schema)) {
    if (value.eventKind !== "dataset.published") fail("dataset schema requires dataset.published event kind");
    requireIdentifier(value, "grantId");
    requireInteger(value, "grantEpoch", 1);
    if (value.operation === "upsert") validateDatasetPayload(value.schema, value.payload);
  } else if (value.schema === "stuguby.grant.v2") {
    if (value.eventKind !== (value.operation === "tombstone" ? "grant.revoked" : "grant.upserted")) fail("grant event kind does not match operation");
    requireIdentifier(value, "grantId");
    requireInteger(value, "grantEpoch", 1);
    if (value.operation === "upsert") {
      const grant = validateShareGrant(value.payload);
      if (grant.localHouseId !== undefined) fail("wire grants must not expose a local house id");
    }
  } else if (value.schema === "stuguby.member.v2") {
    if (value.eventKind !== "member.updated" || value.operation !== "upsert" || !isObject(value.payload)) fail("invalid member event");
    if (value.grantId !== null || value.grantEpoch !== null) fail("member events cannot reference a grant");
    onlyKeys(value.payload, ["stugubyId", "nodeId", "displayName", "role", "state", "publicKey", "keyFingerprint", "joinedAt", "updatedAt"], "member");
    requireString(value.payload, "stugubyId");
    requireString(value.payload, "nodeId");
    requireString(value.payload, "displayName");
    if (!isStugubyRole(value.payload.role)) fail("invalid member role");
    if (!["invited", "active", "suspended", "left", "revoked"].includes(String(value.payload.state))) fail("invalid member state");
    requireString(value.payload, "publicKey");
    requireString(value.payload, "keyFingerprint");
    requireNullableIsoDate(value.payload.joinedAt, "member.joinedAt");
    requireIsoDate(value.payload.updatedAt, "member.updatedAt");
  } else if (value.schema === "stuguby.shared-property.v2") {
    if (value.eventKind !== "shared-property.updated" || value.operation !== "upsert") fail("invalid shared-property event");
    if (value.grantId !== null || value.grantEpoch !== null) fail("shared-property events cannot reference a grant");
    validateSharedProperty(value.payload);
  }
  return value as unknown as StugubyWireEvent;
}

export function validateSignedEvent(value: unknown): StugubySignedEvent {
  const compatible = normalizeLegacySignedEvent(value);
  const event = validateWireEvent(compatible.normalized);
  if (!isObject(compatible.normalized)) fail("signed event must be an object");
  requireString(compatible.normalized, "keyFingerprint");
  if (!/^[a-f0-9]{64}$/.test(String(compatible.normalized.keyFingerprint))) fail("keyFingerprint must be lowercase SHA-256");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(requireString(compatible.normalized, "signature"))) fail("signature must be base64");
  const signed = event as StugubySignedEvent;
  rememberLegacySignedEvent(signed, compatible.legacy);
  return signed;
}

/** Stable JSON used for event hashing and signatures. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical JSON cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort(compareCodeUnits).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

export function eventSigningValue(event: StugubyWireEvent): string {
  const envelope: JsonObject = legacySigningEnvelope(event) ?? {
    protocolVersion: event.protocolVersion,
    stugubyId: event.stugubyId,
    eventId: event.eventId,
    eventKind: event.eventKind,
    authorityNodeId: event.authorityNodeId,
    streamId: event.streamId,
    sequence: event.sequence,
    schema: event.schema,
    resourceId: event.resourceId,
    operation: event.operation,
    revision: event.revision,
    grantId: event.grantId,
    grantEpoch: event.grantEpoch,
    occurredAt: event.occurredAt,
    payload: event.payload,
  };
  return `${canonicalJson(envelope)}\n${event.payloadHash}`;
}

/** Stable payload JSON used when checking an event's signed payload hash. */
export function eventPayloadHashValue(event: StugubyWireEvent): string {
  return canonicalJson(eventPayloadForHash(event));
}

export function requestSigningValue(input: {
  method: string;
  path: string;
  bodyHash: string;
  timestamp: string;
  requestId: string;
  nodeId: string;
}): string {
  return [input.method.toUpperCase(), input.path, input.bodyHash, input.timestamp, input.requestId, input.nodeId, STUGBY_PROTOCOL_VERSION].join("\n");
}

export function validateHomeCommand(value: unknown): StugubyHomeCommand {
  assertSafeFederationPayload(value);
  if (!isObject(value)) fail("Home command must be an object");
  onlyKeys(value, [
    "id", "stugubyId", "actorNodeId", "authorityNodeId", "publicationId", "grantId", "grantEpoch",
    "authorityEpoch", "baseRevision", "snapshot", "createdAt",
  ], "Home command");
  for (const key of ["id", "stugubyId", "actorNodeId", "authorityNodeId", "publicationId", "grantId"] as const) {
    requireString(value, key);
  }
  requireInteger(value, "grantEpoch", 1);
  requireInteger(value, "authorityEpoch", 1);
  requireInteger(value, "baseRevision", 1);
  requireIsoDate(value.createdAt, "createdAt");
  if (!isObject(value.snapshot)) fail("Home command snapshot must be an object");
  onlyKeys(value.snapshot, ["directory", "location", "structure", "sensorCatalog", "notes", "observations"], "Home command snapshot");
  validateDatasetPayload("home.directory.v1", value.snapshot.directory);
  if (value.snapshot.location !== null) validateDatasetPayload("home.location.v1", value.snapshot.location);
  validateDatasetPayload("home.structure.v1", value.snapshot.structure);
  validateDatasetPayload("home.sensor-catalog.v1", value.snapshot.sensorCatalog);
  validateDatasetPayload("home.notes.v1", value.snapshot.notes);
  validateDatasetPayload("home.observations.v1", value.snapshot.observations);
  const publicationId = String(value.publicationId);
  for (const payload of [
    value.snapshot.directory,
    value.snapshot.location,
    value.snapshot.structure,
    value.snapshot.sensorCatalog,
    value.snapshot.notes,
    value.snapshot.observations,
  ]) {
    if (payload !== null && isObject(payload) && payload.publicationId !== publicationId) {
      fail("Home command snapshot publication ids must match");
    }
  }
  return value as unknown as StugubyHomeCommand;
}
