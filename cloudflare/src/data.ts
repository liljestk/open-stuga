import type {
  AlertEvent,
  AlertRule,
  AssetRecord,
  ForecastPoint,
  Floor,
  House,
  HouseLocation,
  HouseMapPlacement,
  ManualObservation,
  MeasurementDefinition,
  MeasurementForecastPoint,
  MeasurementSample,
  Reading,
  Sensor,
  SensorSnapshot,
  StaticParameter,
} from "../../packages/contracts/src/index.js";
import { HttpError, finiteNumber, isObject, objectBody, parseStoredJson, requiredString } from "./http.js";
import type { TelemetryGroup } from "./telemetry.js";
import { metricJsonPath } from "./telemetry.js";

interface JsonRow { data_json: string }
interface TelemetryRow {
  sensor_id: string;
  timestamp: string;
  source: MeasurementSample["source"];
  quality: MeasurementSample["quality"];
  values_json: string;
  units_json: string;
}

const BUILTIN_DEFINITIONS: MeasurementDefinition[] = [
  {
    id: "temperature", labels: { en: "Temperature", fi: "Lämpötila" }, unit: "°C", precision: 1,
    validMin: -80, validMax: 80, displayMin: 10, displayMax: 35, interpolationDelta: 2,
    colorScale: "thermal", builtin: true, enabled: true, spatialInterpolation: true, forecastSupported: true,
  },
  {
    id: "humidity", labels: { en: "Relative humidity", fi: "Suhteellinen kosteus" }, unit: "%", precision: 0,
    validMin: 0, validMax: 100, displayMin: 20, displayMax: 80, interpolationDelta: 10,
    colorScale: "humidity", builtin: true, enabled: true, spatialInterpolation: true, forecastSupported: true,
  },
  {
    id: "co2", labels: { en: "Carbon dioxide", fi: "Hiilidioksidi" }, unit: "ppm", precision: 0,
    validMin: 0, validMax: 20_000, displayMin: 400, displayMax: 2_000, interpolationDelta: 200,
    colorScale: "air-quality", builtin: true, enabled: true, spatialInterpolation: true, forecastSupported: true,
  },
  {
    id: "battery", labels: { en: "Battery", fi: "Akku" }, unit: "%", precision: 0,
    validMin: 0, validMax: 100, displayMin: 0, displayMax: 100, interpolationDelta: 10,
    colorScale: "sequential", builtin: true, enabled: true, spatialInterpolation: false, forecastSupported: false,
  },
];

function entityId(candidate: unknown): string {
  if (candidate === undefined) return crypto.randomUUID();
  if (typeof candidate !== "string" || !candidate.trim() || candidate.length > 200) {
    throw new HttpError(400, "INVALID_ID", "id must be a non-empty string of at most 200 characters");
  }
  return candidate.trim();
}

function ensureJsonSerializable(value: unknown): void {
  try {
    const encoded = JSON.stringify(value);
    if (encoded.length > 1_000_000) throw new HttpError(413, "ENTITY_TOO_LARGE", "Entity JSON exceeds 1 MB");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "INVALID_BODY", "Entity must be JSON serializable");
  }
}

function canonicalInstant(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new HttpError(400, "INVALID_FIELD", "occurredAt must be a valid ISO-8601 instant");
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new HttpError(400, "INVALID_FIELD", "occurredAt must be a valid ISO-8601 instant");
  return new Date(epoch).toISOString();
}

function optionalText(input: Record<string, unknown>, key: string, maxLength = 500): string | undefined {
  if (input[key] === undefined) return undefined;
  if (typeof input[key] !== "string" || input[key].length > maxLength) {
    throw new HttpError(400, "INVALID_FIELD", `${key} must be a string of at most ${maxLength} characters`);
  }
  return input[key];
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  if (input[key] === undefined) return undefined;
  if (typeof input[key] !== "boolean") throw new HttpError(400, "INVALID_FIELD", `${key} must be a boolean`);
  return input[key];
}

function parsePoint(value: unknown, field: string): { x: number; y: number } {
  if (!isObject(value)) throw new HttpError(400, "INVALID_FIELD", `${field} must be a point object`);
  return { x: finiteNumber(value.x, `${field}.x`), y: finiteNumber(value.y, `${field}.y`) };
}

function parseFloorType(value: unknown): Floor["type"] {
  if (value === undefined) return undefined;
  if (value === "basement" || value === "ground" || value === "upper" || value === "attic" || value === "mezzanine" || value === "outdoor") return value;
  throw new HttpError(400, "INVALID_FIELD", "floor type is not supported");
}

export function parseFloorInput(value: unknown): Floor {
  const input = objectBody(value);
  if (!Array.isArray(input.walls) || !Array.isArray(input.rooms)) {
    throw new HttpError(400, "INVALID_FIELD", "floor walls and rooms must be arrays");
  }
  const width = finiteNumber(input.width, "width");
  const height = finiteNumber(input.height, "height");
  if (width <= 0 || height <= 0) throw new HttpError(400, "INVALID_FIELD", "floor width and height must be positive");
  const walls = input.walls.map((wall, index) => {
    const candidate = objectBody(wall);
    return {
      id: requiredString(candidate, "id", 200),
      from: parsePoint(candidate.from, `walls[${index}].from`),
      to: parsePoint(candidate.to, `walls[${index}].to`),
    };
  });
  const rooms = input.rooms.map((room, index) => {
    const candidate = objectBody(room);
    if (!Array.isArray(candidate.points) || candidate.points.length < 3) {
      throw new HttpError(400, "INVALID_FIELD", `rooms[${index}].points must contain at least three points`);
    }
    const kind = optionalText(candidate, "kind", 100);
    return {
      id: requiredString(candidate, "id", 200),
      name: requiredString(candidate, "name", 200),
      points: candidate.points.map((point, pointIndex) => parsePoint(point, `rooms[${index}].points[${pointIndex}]`)),
      ...(kind === undefined ? {} : { kind }),
    };
  });
  if (input.planElements !== undefined && !Array.isArray(input.planElements)) {
    throw new HttpError(400, "INVALID_FIELD", "planElements must be an array");
  }
  const planElements: Floor["planElements"] = Array.isArray(input.planElements) ? input.planElements.map((element, index): NonNullable<Floor["planElements"]>[number] => {
    const candidate = objectBody(element);
    const kind = candidate.kind;
    if (kind !== "door" && kind !== "window" && kind !== "fireplace" && kind !== "vent") {
      throw new HttpError(400, "INVALID_FIELD", `planElements[${index}].kind is not supported`);
    }
    const rotationDegrees = finiteNumber(candidate.rotationDegrees, `planElements[${index}].rotationDegrees`);
    if (rotationDegrees < 0 || rotationDegrees >= 360) throw new HttpError(400, "INVALID_FIELD", `planElements[${index}].rotationDegrees must be between 0 and 360`);
    const elementWidth = candidate.width === undefined ? undefined : finiteNumber(candidate.width, `planElements[${index}].width`);
    if (elementWidth !== undefined && elementWidth <= 0) throw new HttpError(400, "INVALID_FIELD", `planElements[${index}].width must be positive`);
    const base = {
      id: requiredString(candidate, "id", 200),
      position: parsePoint(candidate.position, `planElements[${index}].position`),
      rotationDegrees,
      ...(elementWidth === undefined ? {} : { width: elementWidth }),
    };
    if (kind === "door" || kind === "window") return { ...base, kind, wallId: requiredString(candidate, "wallId", 200) };
    if (candidate.wallId !== undefined) throw new HttpError(400, "INVALID_FIELD", `planElements[${index}].wallId is only valid for openings`);
    return { ...base, kind };
  }) : undefined;
  const ceilingHeight = input.ceilingHeight === undefined ? undefined : finiteNumber(input.ceilingHeight, "ceilingHeight");
  if (ceilingHeight !== undefined && ceilingHeight <= 0) throw new HttpError(400, "INVALID_FIELD", "ceilingHeight must be positive");
  const backgroundImage = optionalText(input, "backgroundImage", 1_000_000);
  return {
    id: requiredString(input, "id", 200),
    name: requiredString(input, "name", 200),
    type: parseFloorType(input.type),
    width,
    height,
    elevation: finiteNumber(input.elevation, "elevation"),
    walls,
    rooms,
    ...(ceilingHeight === undefined ? {} : { ceilingHeight }),
    ...(planElements === undefined ? {} : { planElements }),
    ...(backgroundImage === undefined ? {} : { backgroundImage }),
  };
}

function parseFloors(value: unknown): Floor[] {
  if (!Array.isArray(value)) throw new HttpError(400, "INVALID_FIELD", "floors must be an array");
  const floors = value.map(parseFloorInput);
  if (new Set(floors.map((floor) => floor.id)).size !== floors.length) throw new HttpError(400, "INVALID_FIELD", "floor ids must be unique");
  return floors;
}

function parseHouseLocation(value: unknown): HouseLocation {
  const input = objectBody(value);
  const latitude = finiteNumber(input.latitude, "latitude");
  const longitude = finiteNumber(input.longitude, "longitude");
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new HttpError(422, "INVALID_COORDINATES", "House location coordinates are outside WGS84 bounds");
  }
  const label = optionalText(input, "label", 200);
  const countryCode = optionalText(input, "countryCode", 2);
  if (countryCode !== undefined && !/^[A-Z]{2}$/.test(countryCode)) throw new HttpError(422, "INVALID_LOCATION_COUNTRY", "countryCode must be a two-letter uppercase code");
  const source = input.source;
  if (source !== undefined && source !== "manual" && source !== "place-search" && source !== "browser-geolocation" && source !== "home-assistant" && source !== "map-placement") {
    throw new HttpError(422, "INVALID_LOCATION_SOURCE", "House location source is not supported");
  }
  const confidence = input.confidence;
  if (confidence !== undefined && confidence !== "high" && confidence !== "medium" && confidence !== "low") {
    throw new HttpError(422, "INVALID_LOCATION_CONFIDENCE", "House location confidence is not supported");
  }
  const discoveredAt = input.discoveredAt === undefined ? undefined : canonicalInstant(input.discoveredAt, "");
  const userOverridden = optionalBoolean(input, "userOverridden");
  return {
    latitude,
    longitude,
    ...(label === undefined ? {} : { label }),
    ...(countryCode === undefined ? {} : { countryCode }),
    ...(source === undefined ? {} : { source }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(discoveredAt === undefined ? {} : { discoveredAt }),
    ...(userOverridden === undefined ? {} : { userOverridden }),
  };
}

function parseHouseMapPlacement(value: unknown, floors: Floor[]): HouseMapPlacement {
  const input = objectBody(value);
  const latitude = finiteNumber(input.latitude, "latitude");
  const longitude = finiteNumber(input.longitude, "longitude");
  const metersPerPlanUnit = finiteNumber(input.metersPerPlanUnit, "metersPerPlanUnit");
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || metersPerPlanUnit <= 0) {
    throw new HttpError(422, "INVALID_MAP_PLACEMENT", "Map placement coordinates and scale are invalid");
  }
  const footprintFloorId = optionalText(input, "footprintFloorId", 200);
  if (footprintFloorId && !floors.some((floor) => floor.id === footprintFloorId)) {
    throw new HttpError(422, "MAP_PLACEMENT_FLOOR_NOT_FOUND", "Map placement footprint floor does not exist");
  }
  return { latitude, longitude, metersPerPlanUnit, ...(footprintFloorId ? { footprintFloorId } : {}) };
}

export async function listHouses(db: D1Database, tenantId: string): Promise<House[]> {
  const rows = await db.prepare("SELECT data_json FROM houses WHERE tenant_id = ? ORDER BY created_at, id")
    .bind(tenantId).all<JsonRow>();
  return rows.results.map((row) => parseStoredJson<House>(row.data_json));
}

export async function getHouse(db: D1Database, tenantId: string, id: string): Promise<House | null> {
  const row = await db.prepare("SELECT data_json FROM houses WHERE tenant_id = ? AND id = ?")
    .bind(tenantId, id).first<JsonRow>();
  return row ? parseStoredJson<House>(row.data_json) : null;
}

export async function createHouse(db: D1Database, tenantId: string, body: unknown): Promise<House> {
  const input = objectBody(body);
  const floors = parseFloors(input.floors);
  const timestamp = new Date().toISOString();
  const house: House = {
    id: entityId(input.id),
    name: requiredString(input, "name", 200),
    timezone: requiredString(input, "timezone", 100),
    floors,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(input.location === undefined ? {} : { location: parseHouseLocation(input.location) }),
    ...(input.mapPlacement === undefined ? {} : { mapPlacement: parseHouseMapPlacement(input.mapPlacement, floors) }),
    ...(typeof input.orientationDegrees === "number" ? { orientationDegrees: finiteNumber(input.orientationDegrees, "orientationDegrees") } : {}),
  };
  ensureJsonSerializable(house);
  try {
    await db.prepare(`INSERT INTO houses(tenant_id, id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(tenantId, house.id, JSON.stringify(house), timestamp, timestamp).run();
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) throw new HttpError(409, "CONFLICT", "House id already exists in this tenant");
    throw error;
  }
  return house;
}

export async function updateHouse(db: D1Database, tenantId: string, id: string, body: unknown): Promise<House> {
  const current = await getHouse(db, tenantId, id);
  if (!current) throw new HttpError(404, "NOT_FOUND", "House not found");
  const patch = objectBody(body);
  const next: House = { ...current, updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) next.name = requiredString(patch, "name", 200);
  if (patch.timezone !== undefined) next.timezone = requiredString(patch, "timezone", 100);
  if (patch.floors !== undefined) {
    next.floors = parseFloors(patch.floors);
  }
  if (patch.location === null) delete next.location;
  else if (patch.location !== undefined) next.location = parseHouseLocation(patch.location);
  if (patch.mapPlacement === null) delete next.mapPlacement;
  else if (patch.mapPlacement !== undefined) next.mapPlacement = parseHouseMapPlacement(patch.mapPlacement, next.floors);
  if (patch.orientationDegrees === null) delete next.orientationDegrees;
  else if (patch.orientationDegrees !== undefined) next.orientationDegrees = finiteNumber(patch.orientationDegrees, "orientationDegrees");
  ensureJsonSerializable(next);
  await db.prepare("UPDATE houses SET data_json = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
    .bind(JSON.stringify(next), next.updatedAt, tenantId, id).run();
  return next;
}

export async function deleteHouse(db: D1Database, tenantId: string, id: string): Promise<void> {
  const result = await db.prepare("DELETE FROM houses WHERE tenant_id = ? AND id = ?").bind(tenantId, id).run();
  if (!result.meta.changes) throw new HttpError(404, "NOT_FOUND", "House not found");
}

export async function listSensors(db: D1Database, tenantId: string, houseId?: string): Promise<Sensor[]> {
  const query = houseId
    ? db.prepare("SELECT data_json FROM sensors WHERE tenant_id = ? AND house_id = ? ORDER BY id").bind(tenantId, houseId)
    : db.prepare("SELECT data_json FROM sensors WHERE tenant_id = ? ORDER BY id").bind(tenantId);
  const rows = await query.all<JsonRow>();
  return rows.results.map((row) => parseStoredJson<Sensor>(row.data_json));
}

export async function getSensor(db: D1Database, tenantId: string, id: string): Promise<Sensor | null> {
  const row = await db.prepare("SELECT data_json FROM sensors WHERE tenant_id = ? AND id = ?")
    .bind(tenantId, id).first<JsonRow>();
  return row ? parseStoredJson<Sensor>(row.data_json) : null;
}

function sensorFromBody(input: Record<string, unknown>, id = entityId(input.id)): Sensor {
  const tags = input.tags ?? [];
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
    throw new HttpError(400, "INVALID_FIELD", "tags must be a string array");
  }
  const enabled = optionalBoolean(input, "enabled") ?? true;
  return {
    ...input,
    id,
    houseId: requiredString(input, "houseId", 200),
    floorId: requiredString(input, "floorId", 200),
    name: requiredString(input, "name", 200),
    room: requiredString(input, "room", 200),
    model: requiredString(input, "model", 200),
    x: finiteNumber(input.x, "x"),
    y: finiteNumber(input.y, "y"),
    z: finiteNumber(input.z, "z"),
    tags,
    enabled,
  } as Sensor;
}

export async function createSensor(db: D1Database, tenantId: string, body: unknown): Promise<Sensor> {
  const input = objectBody(body);
  const sensor = sensorFromBody(input);
  if (!await getHouse(db, tenantId, sensor.houseId)) throw new HttpError(404, "HOUSE_NOT_FOUND", "House not found");
  const timestamp = new Date().toISOString();
  ensureJsonSerializable(sensor);
  try {
    await db.prepare(`INSERT INTO sensors(tenant_id, id, house_id, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(tenantId, sensor.id, sensor.houseId, JSON.stringify(sensor), timestamp, timestamp).run();
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) throw new HttpError(409, "CONFLICT", "Sensor id already exists in this tenant");
    throw error;
  }
  return sensor;
}

export async function updateSensor(db: D1Database, tenantId: string, id: string, body: unknown): Promise<Sensor> {
  const current = await getSensor(db, tenantId, id);
  if (!current) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
  const patch = objectBody(body);
  const merged = { ...current, ...patch, id } as Record<string, unknown>;
  if (patch.tpLinkDeviceId === null) delete merged.tpLinkDeviceId;
  const sensor = sensorFromBody(merged, id);
  if (!await getHouse(db, tenantId, sensor.houseId)) throw new HttpError(404, "HOUSE_NOT_FOUND", "House not found");
  ensureJsonSerializable(sensor);
  await db.prepare(`UPDATE sensors SET house_id = ?, data_json = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`)
    .bind(sensor.houseId, JSON.stringify(sensor), new Date().toISOString(), tenantId, id).run();
  return sensor;
}

export async function deleteSensor(db: D1Database, tenantId: string, id: string): Promise<void> {
  const result = await db.prepare("DELETE FROM sensors WHERE tenant_id = ? AND id = ?").bind(tenantId, id).run();
  if (!result.meta.changes) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
}

export async function insertTelemetry(db: D1Database, tenantId: string, groups: TelemetryGroup[]): Promise<void> {
  if (!groups.length) throw new HttpError(400, "INVALID_BATCH", "At least one telemetry sample is required");
  if (groups.length > 1_000) throw new HttpError(400, "INVALID_BATCH", "A batch can contain at most 1,000 sensor buckets");
  const sensors = new Set((await listSensors(db, tenantId)).map((sensor) => sensor.id));
  const unknown = groups.find((group) => !sensors.has(group.sensorId));
  if (unknown) throw new HttpError(404, "UNKNOWN_SENSOR", `Sensor ${unknown.sensorId} does not exist in this tenant`);
  const timestamp = new Date().toISOString();
  const compact = groups.map((group) => ({
    sensorId: group.sensorId,
    timestamp: group.timestamp,
    source: group.source,
    quality: group.quality,
    values: group.values,
    units: group.units,
  }));
  await db.prepare(`INSERT INTO telemetry_samples
    (tenant_id, sensor_id, timestamp, source, quality, values_json, units_json, created_at, updated_at)
    SELECT ?, json_extract(value, '$.sensorId'), json_extract(value, '$.timestamp'),
      json_extract(value, '$.source'), json_extract(value, '$.quality'),
      json_extract(value, '$.values'), json_extract(value, '$.units'), ?, ?
    FROM json_each(?) WHERE true
    ON CONFLICT(tenant_id, sensor_id, timestamp) DO UPDATE SET
      source = excluded.source,
      quality = excluded.quality,
      values_json = json_patch(telemetry_samples.values_json, excluded.values_json),
      units_json = json_patch(telemetry_samples.units_json, excluded.units_json),
      updated_at = excluded.updated_at`)
    .bind(tenantId, timestamp, timestamp, JSON.stringify(compact)).run();
}

function rowMeasurements(row: TelemetryRow): Record<string, MeasurementSample> {
  const values = parseStoredJson<Record<string, number>>(row.values_json);
  const units = parseStoredJson<Record<string, string>>(row.units_json);
  return Object.fromEntries(Object.entries(values).filter(([, value]) => Number.isFinite(value)).map(([metric, value]) => [metric, {
    sensorId: row.sensor_id,
    metric,
    value,
    canonicalUnit: units[metric] ?? "",
    timestamp: row.timestamp,
    source: row.source,
    quality: row.quality,
  }]));
}

function rowReading(row: TelemetryRow): Reading | null {
  const values = parseStoredJson<Record<string, number>>(row.values_json);
  if (!Number.isFinite(values.temperature) || !Number.isFinite(values.humidity)) return null;
  const measurements = Object.fromEntries(Object.entries(values).filter(([metric]) => !["temperature", "humidity", "battery"].includes(metric)));
  return {
    sensorId: row.sensor_id,
    timestamp: row.timestamp,
    temperature: values.temperature!,
    humidity: values.humidity!,
    battery: Number.isFinite(values.battery) ? values.battery! : null,
    source: row.source,
    quality: row.quality,
    ...(Object.keys(measurements).length ? { measurements } : {}),
  };
}

export async function latestTelemetryRows(db: D1Database, tenantId: string, houseId?: string): Promise<TelemetryRow[]> {
  // CROSS JOIN fixes sensors as the outer loop. Each correlated MAX and row
  // lookup is then an exact seek through PK (tenant_id, sensor_id, timestamp),
  // keeping current-state reads proportional to sensor count, not retention.
  const rows = await db.prepare(`SELECT t.sensor_id, t.timestamp, t.source, t.quality, t.values_json, t.units_json
    FROM sensors s CROSS JOIN telemetry_samples t
    WHERE s.tenant_id = ? AND (? IS NULL OR s.house_id = ?)
      AND t.tenant_id = s.tenant_id AND t.sensor_id = s.id
      AND t.timestamp = (
        SELECT MAX(latest.timestamp) FROM telemetry_samples latest
        WHERE latest.tenant_id = s.tenant_id AND latest.sensor_id = s.id
      )
    ORDER BY t.sensor_id`)
    .bind(tenantId, houseId ?? null, houseId ?? null).all<TelemetryRow>();
  return rows.results;
}

export async function snapshots(db: D1Database, tenantId: string, houseId?: string): Promise<SensorSnapshot[]> {
  const [sensors, rows] = await Promise.all([listSensors(db, tenantId, houseId), latestTelemetryRows(db, tenantId, houseId)]);
  const readings = new Map(rows.map((row) => [row.sensor_id, rowReading(row)]));
  return sensors.map((sensor) => ({ ...sensor, reading: readings.get(sensor.id) ?? null }));
}

export async function measurementSnapshot(db: D1Database, tenantId: string, houseId?: string) {
  const [sensors, rows] = await Promise.all([listSensors(db, tenantId, houseId), latestTelemetryRows(db, tenantId, houseId)]);
  const measurements = new Map(rows.map((row) => [row.sensor_id, rowMeasurements(row)]));
  return sensors.map((sensor) => ({ sensorId: sensor.id, measurements: measurements.get(sensor.id) ?? {} }));
}

export async function readingHistory(
  db: D1Database,
  tenantId: string,
  sensorId: string,
  from: string,
  to: string,
  limit: number,
): Promise<Reading[]> {
  if (!await getSensor(db, tenantId, sensorId)) throw new HttpError(404, "UNKNOWN_SENSOR", "Sensor not found");
  const rows = await db.prepare(`SELECT sensor_id, timestamp, source, quality, values_json, units_json FROM (
      SELECT sensor_id, timestamp, source, quality, values_json, units_json FROM telemetry_samples
      WHERE tenant_id = ? AND sensor_id = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp DESC LIMIT ?
    ) ORDER BY timestamp`)
    .bind(tenantId, sensorId, from, to, limit).all<TelemetryRow>();
  return rows.results.map(rowReading).filter((reading): reading is Reading => reading !== null);
}

export async function measurementHistory(
  db: D1Database,
  tenantId: string,
  sensorId: string,
  metric: string,
  from: string,
  to: string,
  limit: number,
): Promise<MeasurementSample[]> {
  if (!await getSensor(db, tenantId, sensorId)) throw new HttpError(404, "UNKNOWN_SENSOR", "Sensor not found");
  const path = metricJsonPath(metric);
  interface MetricRow { timestamp: string; source: MeasurementSample["source"]; quality: MeasurementSample["quality"]; value: number; unit: string | null }
  const rows = await db.prepare(`SELECT timestamp, source, quality, value, unit FROM (
      SELECT timestamp, source, quality, json_extract(values_json, ?) AS value, json_extract(units_json, ?) AS unit
      FROM telemetry_samples WHERE tenant_id = ? AND sensor_id = ? AND timestamp >= ? AND timestamp <= ?
        AND json_type(values_json, ?) IN ('integer', 'real') ORDER BY timestamp DESC LIMIT ?
    ) ORDER BY timestamp`)
    .bind(path, path, tenantId, sensorId, from, to, path, limit).all<MetricRow>();
  return rows.results.map((row) => ({
    sensorId, metric, value: row.value, canonicalUnit: row.unit ?? "", timestamp: row.timestamp,
    source: row.source, quality: row.quality,
  }));
}

export function measurementForecast(samples: MeasurementSample[], hours: number): MeasurementForecastPoint[] {
  const latest = samples.at(-1);
  if (!latest) return [];
  const previous = samples.at(-2);
  const slopePerHour = previous && Date.parse(latest.timestamp) > Date.parse(previous.timestamp)
    ? (latest.value - previous.value) / ((Date.parse(latest.timestamp) - Date.parse(previous.timestamp)) / 3_600_000)
    : 0;
  const boundedSlope = Math.max(-5, Math.min(5, slopePerHour));
  return Array.from({ length: hours }, (_, index) => {
    const horizon = index + 1;
    const value = latest.value + boundedSlope * horizon;
    const uncertainty = Math.max(0.2, Math.abs(value) * 0.02) * Math.sqrt(horizon);
    return {
      sensorId: latest.sensorId, metric: latest.metric,
      timestamp: new Date(Date.parse(latest.timestamp) + horizon * 3_600_000).toISOString(),
      value, low: value - uncertainty, high: value + uncertainty,
    };
  });
}

export function legacyForecast(temperature: MeasurementForecastPoint[], humidity: MeasurementForecastPoint[]): ForecastPoint[] {
  const humidityByTime = new Map(humidity.map((point) => [point.timestamp, point]));
  return temperature.flatMap((point) => {
    const humidityPoint = humidityByTime.get(point.timestamp);
    if (!humidityPoint) return [];
    return [{
      sensorId: point.sensorId, timestamp: point.timestamp,
      temperature: point.value, humidity: humidityPoint.value,
      temperatureLow: point.low, temperatureHigh: point.high,
      humidityLow: humidityPoint.low, humidityHigh: humidityPoint.high,
    }];
  });
}

export async function listMeasurementDefinitions(db: D1Database, tenantId: string, includeDisabled = true): Promise<MeasurementDefinition[]> {
  const rows = await db.prepare("SELECT data_json FROM measurement_definitions WHERE tenant_id = ? ORDER BY id")
    .bind(tenantId).all<JsonRow>();
  const custom = new Map(rows.results.map((row) => {
    const definition = parseStoredJson<MeasurementDefinition>(row.data_json);
    return [definition.id, definition] as const;
  }));
  const definitions = [...BUILTIN_DEFINITIONS.map((definition) => custom.get(definition.id) ?? definition)];
  for (const [id, definition] of custom) if (!BUILTIN_DEFINITIONS.some((builtin) => builtin.id === id)) definitions.push(definition);
  return includeDisabled ? definitions : definitions.filter((definition) => definition.enabled);
}

export async function saveMeasurementDefinition(db: D1Database, tenantId: string, id: string, body: unknown): Promise<MeasurementDefinition> {
  const input = objectBody(body);
  const existing = (await listMeasurementDefinitions(db, tenantId, true)).find((definition) => definition.id === id);
  const definition: MeasurementDefinition = {
    ...(existing ?? {
      id, labels: { en: id }, unit: "", precision: 1, validMin: null, validMax: null, displayMin: null, displayMax: null,
      interpolationDelta: 1, colorScale: "sequential", builtin: false, enabled: true, spatialInterpolation: false, forecastSupported: false,
    }),
    ...input,
    id,
    builtin: existing?.builtin ?? false,
  } as MeasurementDefinition;
  ensureJsonSerializable(definition);
  const timestamp = new Date().toISOString();
  await db.prepare(`INSERT INTO measurement_definitions(tenant_id, id, data_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`)
    .bind(tenantId, id, JSON.stringify(definition), timestamp, timestamp).run();
  return definition;
}

type JsonEntityTable = "alert_rules" | "alert_events" | "observations" | "static_parameters";

export async function listJsonEntities<T>(db: D1Database, table: JsonEntityTable, tenantId: string, suffix = "", params: unknown[] = []): Promise<T[]> {
  const rows = await db.prepare(`SELECT data_json FROM ${table} WHERE tenant_id = ? ${suffix}`).bind(tenantId, ...params).all<JsonRow>();
  return rows.results.map((row) => parseStoredJson<T>(row.data_json));
}

export async function listAlertRules(db: D1Database, tenantId: string): Promise<AlertRule[]> {
  return listJsonEntities<AlertRule>(db, "alert_rules", tenantId, "ORDER BY id");
}

export async function saveAlertRule(db: D1Database, tenantId: string, body: unknown, id?: string): Promise<AlertRule> {
  const input = objectBody(body);
  const current = id ? (await listAlertRules(db, tenantId)).find((rule) => rule.id === id) : undefined;
  if (id && !current) throw new HttpError(404, "NOT_FOUND", "Alert rule not found");
  const merged = { ...(current ?? {}), ...input };
  const sensorId = input.sensorId === undefined ? current?.sensorId ?? null : input.sensorId;
  if (sensorId !== null && typeof sensorId !== "string") throw new HttpError(400, "INVALID_FIELD", "sensorId must be a string or null");
  const operator = input.operator ?? current?.operator ?? "gt";
  if (operator !== "gt" && operator !== "gte" && operator !== "lt" && operator !== "lte") throw new HttpError(400, "INVALID_FIELD", "operator is not supported");
  const severity = input.severity ?? current?.severity ?? "warning";
  if (severity !== "info" && severity !== "warning" && severity !== "critical") throw new HttpError(400, "INVALID_FIELD", "severity is not supported");
  const durationSeconds = Number(input.durationSeconds ?? current?.durationSeconds ?? 0);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 0) throw new HttpError(400, "INVALID_FIELD", "durationSeconds must be a non-negative integer");
  const enabled = optionalBoolean(merged, "enabled") ?? true;
  const rule: AlertRule = {
    ...(current ?? {}), ...input, id: id ?? entityId(input.id),
    name: requiredString(merged, "name", 200),
    sensorId,
    metric: requiredString(merged, "metric", 64),
    operator,
    threshold: finiteNumber(input.threshold ?? current?.threshold, "threshold"),
    durationSeconds,
    severity,
    enabled,
    webhookEnabled: false,
  };
  if (rule.sensorId && !await getSensor(db, tenantId, rule.sensorId)) throw new HttpError(404, "UNKNOWN_SENSOR", "Sensor not found");
  const timestamp = new Date().toISOString();
  await db.prepare(`INSERT INTO alert_rules(tenant_id, id, sensor_id, data_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, id) DO UPDATE SET sensor_id = excluded.sensor_id,
      data_json = excluded.data_json, updated_at = excluded.updated_at`)
    .bind(tenantId, rule.id, rule.sensorId, JSON.stringify(rule), timestamp, timestamp).run();
  return rule;
}

export async function listAlertEvents(db: D1Database, tenantId: string, limit: number): Promise<AlertEvent[]> {
  return listJsonEntities<AlertEvent>(db, "alert_events", tenantId, "ORDER BY started_at DESC LIMIT ?", [limit]);
}

export async function acknowledgeAlert(db: D1Database, tenantId: string, id: string): Promise<AlertEvent> {
  const row = await db.prepare("SELECT data_json FROM alert_events WHERE tenant_id = ? AND id = ?").bind(tenantId, id).first<JsonRow>();
  if (!row) throw new HttpError(404, "NOT_FOUND", "Alert event not found");
  const event = { ...parseStoredJson<AlertEvent>(row.data_json), acknowledgedAt: new Date().toISOString() };
  await db.prepare("UPDATE alert_events SET data_json = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
    .bind(JSON.stringify(event), event.acknowledgedAt, tenantId, id).run();
  return event;
}

export async function createObservation(db: D1Database, tenantId: string, body: unknown): Promise<ManualObservation> {
  const input = objectBody(body);
  const timestamp = new Date().toISOString();
  const houseId = requiredString(input, "houseId", 200);
  if (!await getHouse(db, tenantId, houseId)) throw new HttpError(404, "HOUSE_NOT_FOUND", "House not found");
  const observation = {
    ...input,
    id: entityId(input.id),
    houseId,
    createdAt: timestamp,
    occurredAt: canonicalInstant(input.occurredAt, timestamp),
  } as ManualObservation;
  ensureJsonSerializable(observation);
  await db.prepare(`INSERT INTO observations(tenant_id, id, house_id, data_json, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).bind(tenantId, observation.id, observation.houseId, JSON.stringify(observation), observation.occurredAt, timestamp).run();
  return observation;
}

export async function saveStaticParameter(db: D1Database, tenantId: string, body: unknown): Promise<StaticParameter> {
  const input = objectBody(body);
  const timestamp = new Date().toISOString();
  const houseId = requiredString(input, "houseId", 200);
  if (!await getHouse(db, tenantId, houseId)) throw new HttpError(404, "HOUSE_NOT_FOUND", "House not found");
  const scopeType = requiredString(input, "scopeType", 20);
  const scopeId = requiredString(input, "scopeId", 200);
  const key = requiredString(input, "key", 200);
  const existing = await db.prepare(`SELECT id FROM static_parameters WHERE tenant_id = ? AND house_id = ?
    AND scope_type = ? AND scope_id = ? AND parameter_key = ?`)
    .bind(tenantId, houseId, scopeType, scopeId, key).first<{ id: string }>();
  const parameter = {
    ...input,
    id: existing?.id ?? entityId(input.id),
    houseId,
    scopeType,
    scopeId,
    key,
    unit: input.unit ?? null,
  } as StaticParameter;
  await db.prepare(`INSERT INTO static_parameters
    (tenant_id, id, house_id, scope_type, scope_id, parameter_key, data_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, house_id, scope_type, scope_id, parameter_key) DO UPDATE SET
      data_json = json_set(excluded.data_json, '$.id', static_parameters.id),
      updated_at = excluded.updated_at`)
    .bind(tenantId, parameter.id, houseId, scopeType, scopeId, key, JSON.stringify(parameter), timestamp, timestamp).run();
  const row = await db.prepare(`SELECT data_json FROM static_parameters WHERE tenant_id = ? AND house_id = ?
    AND scope_type = ? AND scope_id = ? AND parameter_key = ?`)
    .bind(tenantId, houseId, scopeType, scopeId, key).first<JsonRow>();
  return row ? parseStoredJson<StaticParameter>(row.data_json) : parameter;
}

export async function listAssets(db: D1Database, tenantId: string, houseId?: string): Promise<AssetRecord[]> {
  interface AssetRow { id: string; house_id: string; name: string; mime_type: string; kind: AssetRecord["kind"]; size: number; created_at: string }
  const query = houseId
    ? db.prepare(`SELECT id, house_id, name, mime_type, kind, size, created_at FROM assets
        WHERE tenant_id = ? AND house_id = ? ORDER BY created_at DESC`).bind(tenantId, houseId)
    : db.prepare(`SELECT id, house_id, name, mime_type, kind, size, created_at FROM assets
        WHERE tenant_id = ? ORDER BY created_at DESC`).bind(tenantId);
  const rows = await query.all<AssetRow>();
  return rows.results.map((row) => ({
    id: row.id, houseId: row.house_id, name: row.name, mimeType: row.mime_type,
    kind: row.kind, size: row.size, createdAt: row.created_at,
  }));
}

export interface StoredAsset extends AssetRecord { objectKey: string }

export async function getStoredAsset(db: D1Database, tenantId: string, id: string): Promise<StoredAsset | null> {
  interface AssetRow { id: string; house_id: string; object_key: string; name: string; mime_type: string; kind: AssetRecord["kind"]; size: number; created_at: string }
  const row = await db.prepare(`SELECT id, house_id, object_key, name, mime_type, kind, size, created_at
    FROM assets WHERE tenant_id = ? AND id = ?`).bind(tenantId, id).first<AssetRow>();
  return row ? {
    id: row.id, houseId: row.house_id, objectKey: row.object_key, name: row.name,
    mimeType: row.mime_type, kind: row.kind, size: row.size, createdAt: row.created_at,
  } : null;
}

export function builtinDefinitions(): readonly MeasurementDefinition[] {
  return BUILTIN_DEFINITIONS;
}
