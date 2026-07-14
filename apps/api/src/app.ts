import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import type {
  AlertRule,
  Floor,
  HouseLocation,
  ManualObservation,
  MeasurementDefinition,
  MeasurementSample,
  Reading,
  Sensor,
  StaticParameter,
  TelemetryEvent,
} from "@climate-twin/contracts";
import { loadConfig, type AppConfig } from "./config.js";
import { ClimateDatabase, ClimateDataValidationError } from "./db.js";
import { TelemetryBus } from "./events.js";
import { HomeAssistantBridge } from "./home-assistant.js";
import { openApiV1Document, openApiV2Document } from "./openapi.js";
import {
  FmiWeatherProvider,
  WeatherService,
  WeatherUnavailableError,
  type WeatherProvider,
} from "./weather.js";
import {
  AlertEngine,
  forecast,
  forecastMeasurement,
  MeasurementService,
  MeasurementValidationError,
  MockEngine,
  MOCK_SCENARIOS,
  ReplayEngine,
  RuntimeStatus,
  TelemetryValidationError,
  TelemetryService,
} from "./services.js";

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "INVALID_BODY", "A JSON object is required");
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "INVALID_FIELD", `${key} must be a non-empty string`);
  return value.trim();
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "INVALID_FIELD", `${key} must be a string`);
  return value;
}

function requiredNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(400, "INVALID_FIELD", `${key} must be a finite number`);
  return value;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new HttpError(400, "INVALID_FIELD", `${key} must be a boolean`);
  return value;
}

function houseLocationValue(value: unknown): HouseLocation;
function houseLocationValue(value: unknown, allowNull: true): HouseLocation | null;
function houseLocationValue(value: unknown, allowNull = false): HouseLocation | null {
  if (value === null && allowNull) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_FIELD", "location must be an object with latitude and longitude");
  }
  const body = value as Record<string, unknown>;
  const latitude = requiredNumber(body, "latitude");
  const longitude = requiredNumber(body, "longitude");
  const label = optionalString(body, "label")?.trim();
  return { latitude, longitude, ...(label ? { label } : {}) };
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new HttpError(400, "INVALID_FIELD", `${field} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

function dateValue(value: unknown, fallback: Date, field: string): string {
  if (value === undefined) return fallback.toISOString();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new HttpError(400, "INVALID_FIELD", `${field} must be an ISO date-time`);
  return new Date(value).toISOString();
}

function queryList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => String(item).split(",")).filter(Boolean);
  if (typeof value === "string") return value.split(",").filter(Boolean);
  return [];
}

function safeInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function keyMatches(provided: string, expected: string): boolean {
  const first = Buffer.from(provided);
  const second = Buffer.from(expected);
  return first.length === second.length && timingSafeEqual(first, second);
}

const SAFE_ASSET_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "model/gltf+json",
  "model/gltf-binary",
]);

const RESERVED_MEASUREMENT_IDS = new Set(["__proto__", "constructor", "prototype"]);
const MEASUREMENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

function measurementId(value: unknown, field = "metric"): string {
  if (typeof value !== "string" || value.length > 64 || !MEASUREMENT_ID_PATTERN.test(value) || RESERVED_MEASUREMENT_IDS.has(value)) {
    throw new HttpError(400, "INVALID_MEASUREMENT_ID", `${field} must be a safe lowercase registry identifier`);
  }
  return value;
}

function stringMap(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "INVALID_FIELD", `${field} must be an object`);
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(key) || typeof item !== "string" || !item.trim()) {
      throw new HttpError(400, "INVALID_FIELD", `${field} must contain non-empty labels keyed by language tag`);
    }
    result[key] = item.trim();
  }
  if (Object.keys(result).length === 0) throw new HttpError(400, "INVALID_FIELD", `${field} must contain at least one label`);
  return result;
}

function measurementNumberMap(value: unknown, field: string): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "INVALID_FIELD", `${field} must be an object`);
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [key, item] of Object.entries(value)) {
    const id = measurementId(key, `${field} key`);
    if (typeof item !== "number" || !Number.isFinite(item)) throw new HttpError(400, "INVALID_FIELD", `${field}.${key} must be finite`);
    result[id] = item;
  }
  return result;
}

function measurementStringMap(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "INVALID_FIELD", `${field} must be an object`);
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, item] of Object.entries(value)) {
    const id = measurementId(key, `${field} key`);
    if (typeof item !== "string" || !item.trim()) throw new HttpError(400, "INVALID_FIELD", `${field}.${key} must be a non-empty entity id`);
    result[id] = item.trim();
  }
  return result;
}

function nullableFinite(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(400, "INVALID_FIELD", `${field} must be finite or null`);
  return value;
}

function validateMeasurementDefinition(definition: MeasurementDefinition): MeasurementDefinition {
  if (!Number.isInteger(definition.precision) || definition.precision < 0 || definition.precision > 6) {
    throw new HttpError(400, "INVALID_FIELD", "precision must be an integer from 0 to 6");
  }
  if (!Number.isFinite(definition.interpolationDelta) || definition.interpolationDelta <= 0) {
    throw new HttpError(400, "INVALID_FIELD", "interpolationDelta must be positive and finite");
  }
  if (definition.validMin !== null && definition.validMax !== null && definition.validMin >= definition.validMax) {
    throw new HttpError(400, "INVALID_RANGE", "validMin must be less than validMax");
  }
  if (definition.displayMin !== null && definition.displayMax !== null && definition.displayMin >= definition.displayMax) {
    throw new HttpError(400, "INVALID_RANGE", "displayMin must be less than displayMax");
  }
  const displayBounds = [definition.displayMin, definition.displayMax].filter((value): value is number => value !== null);
  if (displayBounds.some((value) => (definition.validMin !== null && value < definition.validMin)
    || (definition.validMax !== null && value > definition.validMax))) {
    throw new HttpError(400, "INVALID_RANGE", "Display range must be within the valid range");
  }
  return definition;
}

function parseMeasurementDefinition(value: unknown, current?: MeasurementDefinition): MeasurementDefinition {
  const body = bodyObject(value);
  if ((current && body.id !== undefined) || body.builtin !== undefined) {
    throw new HttpError(409, "IMMUTABLE_FIELD", "Measurement definition id and builtin status cannot be changed");
  }
  const definition: MeasurementDefinition = {
    id: current?.id ?? measurementId(body.id, "id"),
    labels: body.labels === undefined ? current?.labels ?? (() => { throw new HttpError(400, "INVALID_FIELD", "labels is required"); })() : stringMap(body.labels, "labels"),
    unit: body.unit === undefined ? current?.unit ?? requiredString(body, "unit") : requiredString(body, "unit"),
    precision: body.precision === undefined ? current?.precision ?? 1 : (() => {
      if (typeof body.precision !== "number" || !Number.isInteger(body.precision)) {
        throw new HttpError(400, "INVALID_FIELD", "precision must be an integer from 0 to 6");
      }
      return body.precision;
    })(),
    validMin: body.validMin === undefined ? current?.validMin ?? null : nullableFinite(body.validMin, "validMin"),
    validMax: body.validMax === undefined ? current?.validMax ?? null : nullableFinite(body.validMax, "validMax"),
    displayMin: body.displayMin === undefined ? current?.displayMin ?? null : nullableFinite(body.displayMin, "displayMin"),
    displayMax: body.displayMax === undefined ? current?.displayMax ?? null : nullableFinite(body.displayMax, "displayMax"),
    interpolationDelta: body.interpolationDelta === undefined ? current?.interpolationDelta ?? 1 : requiredNumber(body, "interpolationDelta"),
    colorScale: body.colorScale === undefined ? current?.colorScale ?? "sequential" : enumValue(body.colorScale, ["thermal", "humidity", "air-quality", "sequential"] as const, "colorScale"),
    builtin: current?.builtin ?? false,
    enabled: body.enabled === undefined ? current?.enabled ?? true : optionalBoolean(body, "enabled") as boolean,
    spatialInterpolation: body.spatialInterpolation === undefined ? current?.spatialInterpolation ?? false : optionalBoolean(body, "spatialInterpolation") as boolean,
    forecastSupported: body.forecastSupported === undefined ? current?.forecastSupported ?? false : optionalBoolean(body, "forecastSupported") as boolean,
  };
  return validateMeasurementDefinition(definition);
}

function parseMeasurementSample(value: unknown, database: ClimateDatabase): MeasurementSample {
  const body = bodyObject(value);
  const metric = measurementId(body.metric);
  const definition = database.getMeasurementDefinition(metric);
  const canonicalUnit = body.canonicalUnit === undefined ? definition?.unit ?? "" : requiredString(body, "canonicalUnit");
  return {
    sensorId: requiredString(body, "sensorId"),
    metric,
    value: requiredNumber(body, "value"),
    canonicalUnit,
    timestamp: dateValue(body.timestamp, new Date(), "timestamp"),
    source: body.source === undefined ? "api" : enumValue(body.source, ["mock", "home-assistant", "api", "replay"] as const, "source"),
    quality: body.quality === undefined ? "good" : enumValue(body.quality, ["good", "estimated", "stale"] as const, "quality"),
  };
}

function parseReading(value: unknown): Reading {
  const body = bodyObject(value);
  const temperature = requiredNumber(body, "temperature");
  const humidity = requiredNumber(body, "humidity");
  const batteryValue = body.battery;
  if (temperature < -80 || temperature > 100) throw new HttpError(400, "OUT_OF_RANGE", "temperature must be between -80 and 100 °C");
  if (humidity < 0 || humidity > 100) throw new HttpError(400, "OUT_OF_RANGE", "humidity must be between 0 and 100 percent");
  if (batteryValue !== undefined && batteryValue !== null && (typeof batteryValue !== "number" || batteryValue < 0 || batteryValue > 100)) {
    throw new HttpError(400, "OUT_OF_RANGE", "battery must be null or between 0 and 100 percent");
  }
  return {
    sensorId: requiredString(body, "sensorId"),
    timestamp: dateValue(body.timestamp, new Date(), "timestamp"),
    temperature,
    humidity,
    battery: typeof batteryValue === "number" ? batteryValue : null,
    source: "api",
    quality: body.quality === undefined ? "good" : enumValue(body.quality, ["good", "estimated", "stale"] as const, "quality"),
    ...(body.measurements !== undefined ? { measurements: measurementNumberMap(body.measurements, "measurements") } : {}),
  };
}

function parseAlertRule(value: unknown, database: ClimateDatabase): Omit<AlertRule, "id"> & { id?: string } {
  const body = bodyObject(value);
  const sensorId = body.sensorId;
  if (sensorId !== null && sensorId !== undefined && typeof sensorId !== "string") throw new HttpError(400, "INVALID_FIELD", "sensorId must be a string or null");
  return {
    ...(typeof body.id === "string" ? { id: body.id } : {}),
    name: requiredString(body, "name"),
    sensorId: typeof sensorId === "string" ? sensorId : null,
    metric: (() => {
      const metric = measurementId(body.metric);
      if (!database.getMeasurementDefinition(metric)) throw new HttpError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${metric}`);
      return metric;
    })(),
    operator: enumValue(body.operator, ["gt", "gte", "lt", "lte"] as const, "operator"),
    threshold: requiredNumber(body, "threshold"),
    durationSeconds: safeInteger(body.durationSeconds, 0, 0, 31_536_000),
    severity: enumValue(body.severity, ["info", "warning", "critical"] as const, "severity"),
    enabled: body.enabled === undefined ? true : optionalBoolean(body, "enabled") as boolean,
    webhookEnabled: body.webhookEnabled === undefined ? false : optionalBoolean(body, "webhookEnabled") as boolean,
  };
}

function parseSensorPatch(value: unknown): Partial<Omit<Sensor, "id">> {
  const body = bodyObject(value);
  const patch: Partial<Omit<Sensor, "id">> = {};
  for (const key of ["houseId", "floorId", "name", "room", "model"] as const) {
    if (body[key] !== undefined) Object.assign(patch, { [key]: requiredString(body, key) });
  }
  for (const key of ["x", "y", "z"] as const) {
    if (body[key] !== undefined) Object.assign(patch, { [key]: requiredNumber(body, key) });
  }
  for (const key of ["temperatureEntityId", "humidityEntityId", "batteryEntityId"] as const) {
    if (body[key] !== undefined) Object.assign(patch, { [key]: requiredString(body, key) });
  }
  if (body.measurementEntityIds !== undefined) patch.measurementEntityIds = measurementStringMap(body.measurementEntityIds, "measurementEntityIds");
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== "string")) throw new HttpError(400, "INVALID_FIELD", "tags must be a string array");
    patch.tags = body.tags as string[];
  }
  if (body.enabled !== undefined) patch.enabled = optionalBoolean(body, "enabled") as boolean;
  return patch;
}

export interface ApiRuntime {
  app: express.Express;
  database: ClimateDatabase;
  bus: TelemetryBus;
  telemetry: TelemetryService;
  measurements: MeasurementService;
  mock: MockEngine;
  replay: ReplayEngine;
  status: RuntimeStatus;
  homeAssistant: HomeAssistantBridge;
  weather: WeatherService;
  close: () => void;
}

export interface CreateApiOptions {
  config?: AppConfig;
  database?: ClimateDatabase;
  weatherProvider?: WeatherProvider;
  startBackground?: boolean;
}

export function createApi(options: CreateApiOptions = {}): ApiRuntime {
  const config = options.config ?? loadConfig();
  const database = options.database ?? new ClimateDatabase(config.databasePath);
  const bus = new TelemetryBus();
  const status = new RuntimeStatus(config, bus, database);
  const alertEngine = new AlertEngine(database, bus, config, status);
  const telemetry = new TelemetryService(database, bus, alertEngine);
  const measurements = new MeasurementService(database, bus, alertEngine);
  const mock = new MockEngine(database, telemetry, config);
  const replay = new ReplayEngine(database, bus);
  const homeAssistant = new HomeAssistantBridge(config, telemetry, measurements, database, status);
  const weather = new WeatherService(
    options.weatherProvider ?? new FmiWeatherProvider(),
    status.value.weather,
    () => status.changed(),
  );
  const app = express();
  // Keep the production build independent of the contracts package's TypeScript source export.
  const prefix = "/api/v1" as const;
  const v2Prefix = "/api/v2" as const;
  let retentionTimer: NodeJS.Timeout | null = null;

  app.disable("x-powered-by");
  app.use(express.json({ limit: "15mb" }));
  app.use((request, response, next) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-api-version", request.path.startsWith(v2Prefix) ? "v2" : "v1");
    if (config.corsOrigin) {
      response.setHeader("access-control-allow-origin", config.corsOrigin);
      response.setHeader("vary", "Origin");
      response.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      response.setHeader("access-control-allow-headers", "Content-Type,Authorization,X-API-Key,Last-Event-ID");
    }
    if (request.method === "OPTIONS") { response.status(204).end(); return; }
    next();
  });

  const requireIngestKey = (request: Request, _response: Response, next: NextFunction): void => {
    if (!config.ingestApiKey) { next(); return; }
    const authorization = request.header("authorization");
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    const provided = request.header("x-api-key") ?? bearer;
    if (!provided || !keyMatches(provided, config.ingestApiKey)) {
      next(new HttpError(401, "UNAUTHORIZED", "A valid ingestion API key is required"));
      return;
    }
    next();
  };

  app.get(`${prefix}/health`, (_request, response) => {
    response.json({ status: "ok", apiVersion: "v1", database: "ready", uptimeSeconds: Math.round(process.uptime()) });
  });
  app.get(`${prefix}/openapi.json`, (_request, response) => response.json(openApiV1Document));
  app.get(`${v2Prefix}/openapi.json`, (_request, response) => response.json(openApiV2Document));

  app.get(`${v2Prefix}/measurement-definitions`, (request, response) => {
    const includeDisabled = request.query.includeDisabled !== "false";
    response.json({ definitions: database.listMeasurementDefinitions(includeDisabled) });
  });
  app.post(`${v2Prefix}/measurement-definitions`, (request, response) => {
    const definition = database.createMeasurementDefinition(parseMeasurementDefinition(request.body));
    response.status(201).json({ definition });
  });
  app.patch(`${v2Prefix}/measurement-definitions/:id`, (request, response) => {
    const id = measurementId(request.params.id, "id");
    const current = database.getMeasurementDefinition(id);
    if (!current) throw new HttpError(404, "NOT_FOUND", "Measurement definition not found");
    const definition = database.updateMeasurementDefinition(id, parseMeasurementDefinition(request.body, current));
    response.json({ definition });
  });
  app.delete(`${v2Prefix}/measurement-definitions/:id`, (request, response) => {
    const definition = database.disableMeasurementDefinition(measurementId(request.params.id, "id"));
    if (!definition) throw new HttpError(404, "NOT_FOUND", "Measurement definition not found");
    response.json({ definition });
  });

  app.post(`${v2Prefix}/measurements`, requireIngestKey, (request, response) => {
    const candidate = request.body as unknown;
    let input: unknown[];
    if (Array.isArray(candidate)) input = candidate;
    else if (candidate && typeof candidate === "object" && Array.isArray((candidate as Record<string, unknown>).samples)) {
      input = (candidate as { samples: unknown[] }).samples;
    } else if (candidate && typeof candidate === "object" && (candidate as Record<string, unknown>).sample !== undefined) {
      input = [(candidate as Record<string, unknown>).sample];
    } else input = [candidate];
    if (input.length === 0 || input.length > 1_000) throw new HttpError(400, "INVALID_BATCH", "Submit between 1 and 1000 measurement samples");
    const samples = measurements.ingestBatch(input.map((item) => parseMeasurementSample(item, database)));
    response.status(201).json({ accepted: samples.length, samples });
  });
  app.get(`${v2Prefix}/measurements/snapshot`, (request, response) => {
    const houseId = typeof request.query.houseId === "string" ? request.query.houseId : undefined;
    if (houseId && !database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
    const latest = database.latestMeasurementSamples(houseId);
    const bySensor = new Map<string, Record<string, MeasurementSample>>();
    for (const sample of latest) {
      const map = bySensor.get(sample.sensorId) ?? Object.create(null) as Record<string, MeasurementSample>;
      map[sample.metric] = sample;
      bySensor.set(sample.sensorId, map);
    }
    const snapshot = database.listSensors(houseId).map((sensor) => ({
      sensorId: sensor.id,
      measurements: bySensor.get(sensor.id) ?? {},
    }));
    response.json({ snapshot });
  });
  app.get(`${v2Prefix}/measurements/history`, (request, response) => {
    if (typeof request.query.sensorId !== "string") throw new HttpError(400, "INVALID_FIELD", "sensorId is required");
    if (!database.getSensor(request.query.sensorId)) throw new HttpError(404, "UNKNOWN_SENSOR", "Sensor not found");
    const metric = measurementId(request.query.metric);
    if (!database.getMeasurementDefinition(metric)) throw new HttpError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${metric}`);
    const to = dateValue(request.query.to, new Date(), "to");
    const from = dateValue(request.query.from, new Date(Date.parse(to) - 24 * 3_600_000), "from");
    if (Date.parse(from) > Date.parse(to)) throw new HttpError(400, "INVALID_RANGE", "from must be before to");
    const limit = safeInteger(request.query.limit, 20_000, 1, 50_000);
    response.json({ samples: database.measurementHistory(request.query.sensorId, metric, from, to, limit) });
  });
  app.get(`${v2Prefix}/measurements/forecast`, (request, response) => {
    if (typeof request.query.sensorId !== "string") throw new HttpError(400, "INVALID_FIELD", "sensorId is required");
    if (!database.getSensor(request.query.sensorId)) throw new HttpError(404, "UNKNOWN_SENSOR", "Sensor not found");
    const metric = measurementId(request.query.metric);
    const hours = safeInteger(request.query.hours, 12, 1, 168);
    response.json({ forecast: forecastMeasurement(database, request.query.sensorId, metric, hours) });
  });
  app.get(`${v2Prefix}/measurements/events`, (request, response) => {
    const sensorFilter = new Set(queryList(request.query.sensorId));
    const metricFilter = new Set(queryList(request.query.metric));
    response.status(200);
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    response.flushHeaders();
    const write = (sample: MeasurementSample): void => {
      if (sensorFilter.size > 0 && !sensorFilter.has(sample.sensorId)) return;
      if (metricFilter.size > 0 && !metricFilter.has(sample.metric)) return;
      response.write(`event: measurement\ndata: ${JSON.stringify(sample)}\n\n`);
    };
    const unsubscribe = bus.subscribeMeasurements(write);
    const heartbeat = setInterval(() => response.write(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`), 15_000);
    heartbeat.unref();
    request.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
  });

  app.get(`${prefix}/houses`, (_request, response) => response.json({ houses: database.listHouses() }));
  app.post(`${prefix}/houses`, (request, response) => {
    const body = bodyObject(request.body);
    if (!Array.isArray(body.floors)) throw new HttpError(400, "INVALID_FIELD", "floors must be an array");
    const house = database.createHouse({
      ...(typeof body.id === "string" ? { id: body.id } : {}),
      name: requiredString(body, "name"),
      timezone: requiredString(body, "timezone"),
      ...(body.location !== undefined ? { location: houseLocationValue(body.location) } : {}),
      floors: body.floors as Floor[],
    });
    status.refreshWeatherConfiguration();
    response.status(201).json({ house });
  });
  app.get(`${prefix}/houses/:id`, (request, response) => {
    const house = database.getHouse(request.params.id as string);
    if (!house) throw new HttpError(404, "NOT_FOUND", "House not found");
    response.json({ house });
  });
  app.get(`${prefix}/houses/:id/weather`, async (request, response) => {
    const house = database.getHouse(request.params.id as string);
    if (!house) throw new HttpError(404, "NOT_FOUND", "House not found");
    if (!house.location) {
      throw new HttpError(409, "HOUSE_LOCATION_REQUIRED", "Set the house location before requesting weather");
    }
    const hours = safeInteger(request.query.hours, 48, 1, 240);
    try {
      response.json({ weather: await weather.get(house, hours) });
    } catch (error) {
      if (error instanceof WeatherUnavailableError) {
        throw new HttpError(503, "WEATHER_UNAVAILABLE", error.message);
      }
      throw error;
    }
  });
  app.patch(`${prefix}/houses/:id`, (request, response) => {
    const body = bodyObject(request.body);
    const patch: { name?: string; timezone?: string; floors?: Floor[]; location?: HouseLocation | null } = {};
    if (body.name !== undefined) patch.name = requiredString(body, "name");
    if (body.timezone !== undefined) patch.timezone = requiredString(body, "timezone");
    if (body.location !== undefined) patch.location = houseLocationValue(body.location, true);
    if (body.floors !== undefined) {
      if (!Array.isArray(body.floors)) throw new HttpError(400, "INVALID_FIELD", "floors must be an array");
      patch.floors = body.floors as Floor[];
    }
    const house = database.updateHouse(request.params.id as string, patch);
    if (!house) throw new HttpError(404, "NOT_FOUND", "House not found");
    weather.invalidate(house.id);
    status.refreshWeatherConfiguration();
    response.json({ house });
  });
  app.put(`${prefix}/houses/:id/layout`, (request, response) => {
    const body = bodyObject(request.body);
    if (!Array.isArray(body.floors)) throw new HttpError(400, "INVALID_FIELD", "floors must be an array");
    const house = database.updateHouse(request.params.id as string, { floors: body.floors as Floor[] });
    if (!house) throw new HttpError(404, "NOT_FOUND", "House not found");
    response.json({ house });
  });
  app.put(`${prefix}/houses/:id/floors/:floorId`, (request, response) => {
    const house = database.getHouse(request.params.id as string);
    if (!house) throw new HttpError(404, "NOT_FOUND", "House not found");
    const floor = bodyObject(request.body) as unknown as Floor;
    if (typeof floor.id !== "string" || floor.id !== request.params.floorId) throw new HttpError(400, "INVALID_FIELD", "Floor id must match the route");
    const index = house.floors.findIndex((candidate) => candidate.id === floor.id);
    if (index < 0) throw new HttpError(404, "NOT_FOUND", "Floor not found");
    const floors = house.floors.slice();
    floors[index] = floor;
    database.updateHouse(house.id, { floors });
    response.json(floor);
  });
  app.delete(`${prefix}/houses/:id`, (request, response) => {
    if (!database.deleteHouse(request.params.id as string)) throw new HttpError(404, "NOT_FOUND", "House not found");
    weather.invalidate(request.params.id as string);
    status.refreshWeatherConfiguration();
    response.status(204).end();
  });

  app.get(`${prefix}/sensors/snapshots`, (request, response) => {
    const sensors = database.listSensors(typeof request.query.houseId === "string" ? request.query.houseId : undefined);
    const latest = new Map(database.latestReadings(sensors.map((sensor) => sensor.id)).map((reading) => [reading.sensorId, reading]));
    response.json({ sensors: sensors.map((sensor) => ({ ...sensor, reading: latest.get(sensor.id) ?? null })) });
  });
  app.get(`${prefix}/snapshot`, (request, response) => {
    const sensors = database.listSensors(typeof request.query.houseId === "string" ? request.query.houseId : undefined);
    const latest = new Map(database.latestReadings(sensors.map((sensor) => sensor.id)).map((reading) => [reading.sensorId, reading]));
    response.json({ snapshot: sensors.map((sensor) => ({ ...sensor, reading: latest.get(sensor.id) ?? null })) });
  });
  app.get(`${prefix}/sensors`, (request, response) => {
    const houseId = typeof request.query.houseId === "string" ? request.query.houseId : undefined;
    response.json({ sensors: database.listSensors(houseId) });
  });
  app.post(`${prefix}/sensors`, (request, response) => {
    const body = bodyObject(request.body);
    const tags = body.tags === undefined ? [] : body.tags;
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) throw new HttpError(400, "INVALID_FIELD", "tags must be a string array");
    const sensor = database.createSensor({
      ...(typeof body.id === "string" ? { id: body.id } : {}),
      houseId: requiredString(body, "houseId"), floorId: requiredString(body, "floorId"), name: requiredString(body, "name"),
      room: requiredString(body, "room"), model: requiredString(body, "model"), x: requiredNumber(body, "x"),
      y: requiredNumber(body, "y"), z: requiredNumber(body, "z"), tags: tags as string[],
      enabled: body.enabled === undefined ? true : optionalBoolean(body, "enabled") as boolean,
      ...(optionalString(body, "temperatureEntityId") !== undefined ? { temperatureEntityId: optionalString(body, "temperatureEntityId") as string } : {}),
      ...(optionalString(body, "humidityEntityId") !== undefined ? { humidityEntityId: optionalString(body, "humidityEntityId") as string } : {}),
      ...(optionalString(body, "batteryEntityId") !== undefined ? { batteryEntityId: optionalString(body, "batteryEntityId") as string } : {}),
      ...(body.measurementEntityIds !== undefined ? { measurementEntityIds: measurementStringMap(body.measurementEntityIds, "measurementEntityIds") } : {}),
    });
    response.status(201).json({ sensor });
  });
  app.get(`${prefix}/sensors/:id`, (request, response) => {
    const sensor = database.getSensor(request.params.id as string);
    if (!sensor) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
    response.json({ sensor, reading: database.getLatestReading(sensor.id) });
  });
  app.patch(`${prefix}/sensors/:id`, (request, response) => {
    const sensor = database.updateSensor(request.params.id as string, parseSensorPatch(request.body));
    if (!sensor) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
    response.json({ sensor });
  });
  app.put(`${prefix}/sensors/:id`, (request, response) => {
    const sensor = database.updateSensor(request.params.id as string, parseSensorPatch(request.body));
    if (!sensor) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
    response.json(sensor);
  });
  app.delete(`${prefix}/sensors/:id`, (request, response) => {
    if (!database.deleteSensor(request.params.id as string)) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
    response.status(204).end();
  });

  app.post(`${prefix}/readings`, requireIngestKey, (request, response) => {
    const candidate = request.body as unknown;
    const readingsInput = Array.isArray(candidate) ? candidate : (
      candidate && typeof candidate === "object" && Array.isArray((candidate as Record<string, unknown>).readings)
        ? (candidate as { readings: unknown[] }).readings : [candidate]
    );
    if (readingsInput.length === 0 || readingsInput.length > 1_000) throw new HttpError(400, "INVALID_BATCH", "Submit between 1 and 1000 readings");
    const submitted = readingsInput.map(parseReading);
    const readings = telemetry.ingestBatch(submitted);
    response.status(201).json({ readings, ignoredDuplicates: submitted.length - readings.length });
  });
  app.get(`${prefix}/readings/latest`, (request, response) => {
    const sensorIds = queryList(request.query.sensorId);
    response.json({ readings: database.latestReadings(sensorIds.length ? sensorIds : undefined) });
  });
  app.get(`${prefix}/readings`, (request, response) => {
    const sensorIds = queryList(request.query.sensorId);
    const selected = sensorIds.length ? sensorIds : database.listSensors().map((sensor) => sensor.id);
    const to = dateValue(request.query.to, new Date(), "to");
    const from = dateValue(request.query.from, new Date(Date.parse(to) - 24 * 3_600_000), "from");
    const limit = safeInteger(request.query.limit, 2_000, 1, 50_000);
    response.json({ readings: database.history(selected, from, to, limit) });
  });
  app.get(`${prefix}/history`, (request, response) => {
    const sensorIds = queryList(request.query.sensorId);
    const selected = sensorIds.length ? sensorIds : database.listSensors().map((sensor) => sensor.id);
    const to = dateValue(request.query.to, new Date(), "to");
    const from = dateValue(request.query.from, new Date(Date.parse(to) - 24 * 3_600_000), "from");
    if (Date.parse(from) > Date.parse(to)) throw new HttpError(400, "INVALID_RANGE", "from must be before to");
    const limit = safeInteger(request.query.limit, 20_000, 1, 50_000);
    const readings = database.history(selected, from, to, limit);
    const forecastHours = safeInteger(request.query.forecastHours, 0, 0, 168);
    const series = selected.map((sensorId) => ({
      sensorId,
      readings: readings.filter((reading) => reading.sensorId === sensorId),
      forecast: forecastHours ? forecast(database, sensorId, forecastHours) : [],
    }));
    response.json({ from, to, series, truncated: readings.length === limit });
  });
  app.get(`${prefix}/forecast`, (request, response) => {
    const sensorIds = queryList(request.query.sensorId);
    const selected = sensorIds.length ? sensorIds : database.listSensors().map((sensor) => sensor.id);
    const horizonMinutes = safeInteger(request.query.horizonMinutes, 0, 0, 10_080);
    const hours = horizonMinutes > 0 ? Math.max(1, Math.ceil(horizonMinutes / 60)) : safeInteger(request.query.hours, 12, 1, 168);
    const series = selected.map((sensorId) => ({ sensorId, forecast: forecast(database, sensorId, hours) }));
    response.json({ generatedAt: new Date().toISOString(), model: "linear-v1", series, ...(series.length === 1 ? { forecast: series[0]?.forecast ?? [] } : {}) });
  });
  const streamTelemetry = (request: Request, response: Response): void => {
    const filter = new Set(queryList(request.query.sensorId));
    response.status(200);
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    response.flushHeaders();
    const write = (event: TelemetryEvent): void => {
      if (filter.size > 0 && (event.type === "reading" || event.type === "alert")) {
        const data = event.data as Reading | { sensorId: string };
        if (!filter.has(data.sensorId)) return;
      }
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    };
    write({ type: "integration", data: structuredClone(status.value) });
    const unsubscribe = bus.subscribe(write);
    const heartbeat = setInterval(() => write({ type: "heartbeat", data: { timestamp: new Date().toISOString() } }), 15_000);
    heartbeat.unref();
    request.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
  };
  app.get(`${prefix}/stream`, streamTelemetry);
  app.get(`${prefix}/events`, streamTelemetry);

  app.get(`${prefix}/alert-rules`, (_request, response) => response.json({ rules: database.listAlertRules() }));
  app.post(`${prefix}/alert-rules`, (request, response) => response.status(201).json(database.saveAlertRule(parseAlertRule(request.body, database))));
  app.patch(`${prefix}/alert-rules/:id`, (request, response) => {
    const current = database.getAlertRule(request.params.id as string);
    if (!current) throw new HttpError(404, "NOT_FOUND", "Alert rule not found");
    const body = bodyObject(request.body);
    const rule = database.updateAlertRule(current.id, {
      ...(body.name !== undefined ? { name: requiredString(body, "name") } : {}),
      ...(body.sensorId !== undefined ? { sensorId: body.sensorId === null ? null : requiredString(body, "sensorId") } : {}),
      ...(body.metric !== undefined ? { metric: (() => {
        const metric = measurementId(body.metric);
        if (!database.getMeasurementDefinition(metric)) throw new HttpError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${metric}`);
        return metric;
      })() } : {}),
      ...(body.operator !== undefined ? { operator: enumValue(body.operator, ["gt", "gte", "lt", "lte"] as const, "operator") } : {}),
      ...(body.threshold !== undefined ? { threshold: requiredNumber(body, "threshold") } : {}),
      ...(body.durationSeconds !== undefined ? { durationSeconds: safeInteger(body.durationSeconds, current.durationSeconds, 0, 31_536_000) } : {}),
      ...(body.severity !== undefined ? { severity: enumValue(body.severity, ["info", "warning", "critical"] as const, "severity") } : {}),
      ...(body.enabled !== undefined ? { enabled: optionalBoolean(body, "enabled") as boolean } : {}),
      ...(body.webhookEnabled !== undefined ? { webhookEnabled: optionalBoolean(body, "webhookEnabled") as boolean } : {}),
    });
    response.json({ rule });
  });
  app.delete(`${prefix}/alert-rules/:id`, (request, response) => {
    if (!database.deleteAlertRule(request.params.id as string)) throw new HttpError(404, "NOT_FOUND", "Alert rule not found");
    response.status(204).end();
  });
  app.get(`${prefix}/alert-events`, (request, response) => {
    const activeOnly = request.query.active === "true";
    response.json({ events: database.listAlertEvents(safeInteger(request.query.limit, 200, 1, 1_000), activeOnly) });
  });
  app.get(`${prefix}/alerts`, (request, response) => {
    const activeOnly = request.query.active === "true";
    response.json({ alerts: database.listAlertEvents(safeInteger(request.query.limit, 200, 1, 1_000), activeOnly) });
  });
  app.post(`${prefix}/alert-events/:id/acknowledge`, (request, response) => {
    const event = database.acknowledgeAlert(request.params.id as string, new Date().toISOString());
    if (!event) throw new HttpError(404, "NOT_FOUND", "Alert event not found");
    bus.publish({ type: "alert", data: event });
    response.json({ event });
  });
  app.post(`${prefix}/alerts/:id/acknowledge`, (request, response) => {
    const event = database.acknowledgeAlert(request.params.id as string, new Date().toISOString());
    if (!event) throw new HttpError(404, "NOT_FOUND", "Alert event not found");
    bus.publish({ type: "alert", data: event });
    response.json(event);
  });

  app.get(`${prefix}/observations`, (request, response) => {
    response.json({ observations: database.listObservations(typeof request.query.houseId === "string" ? request.query.houseId : undefined) });
  });
  app.post(`${prefix}/observations`, (request, response) => {
    const body = bodyObject(request.body);
    const sensorId = body.sensorId;
    const x = body.x;
    const y = body.y;
    const observation = database.createObservation({
      ...(typeof body.id === "string" ? { id: body.id } : {}),
      houseId: requiredString(body, "houseId"), floorId: requiredString(body, "floorId"),
      sensorId: typeof sensorId === "string" ? sensorId : null,
      kind: enumValue(body.kind, ["leak", "condensation", "mould", "ventilation", "maintenance", "note"] as const, "kind"),
      severity: enumValue(body.severity, ["info", "warning", "critical"] as const, "severity"),
      note: requiredString(body, "note"),
      x: typeof x === "number" ? x : null, y: typeof y === "number" ? y : null,
      occurredAt: dateValue(body.occurredAt, new Date(), "occurredAt"),
    });
    response.status(201).json(observation);
  });
  app.delete(`${prefix}/observations/:id`, (request, response) => {
    if (!database.deleteObservation(request.params.id as string)) throw new HttpError(404, "NOT_FOUND", "Observation not found");
    response.status(204).end();
  });

  app.get(`${prefix}/parameters`, (request, response) => response.json({ parameters: database.listParameters(typeof request.query.houseId === "string" ? request.query.houseId : undefined) }));
  app.post(`${prefix}/parameters`, (request, response) => {
    const body = bodyObject(request.body);
    if (!["string", "number", "boolean"].includes(typeof body.value)) throw new HttpError(400, "INVALID_FIELD", "value must be a string, number, or boolean");
    const parameter = database.saveParameter({
      ...(typeof body.id === "string" ? { id: body.id } : {}),
      houseId: requiredString(body, "houseId"),
      scopeType: enumValue(body.scopeType, ["house", "floor", "room", "sensor"] as const, "scopeType"),
      scopeId: requiredString(body, "scopeId"), key: requiredString(body, "key"),
      value: body.value as StaticParameter["value"], unit: body.unit === null ? null : optionalString(body, "unit") ?? null,
      label: requiredString(body, "label"),
    });
    response.status(200).json({ parameter });
  });
  app.get(`${prefix}/static-parameters`, (request, response) => response.json({ parameters: database.listParameters(typeof request.query.houseId === "string" ? request.query.houseId : undefined) }));
  app.post(`${prefix}/static-parameters`, (request, response) => {
    const body = bodyObject(request.body);
    if (!["string", "number", "boolean"].includes(typeof body.value)) throw new HttpError(400, "INVALID_FIELD", "value must be a string, number, or boolean");
    const parameter = database.saveParameter({
      houseId: requiredString(body, "houseId"), scopeType: enumValue(body.scopeType, ["house", "floor", "room", "sensor"] as const, "scopeType"),
      scopeId: requiredString(body, "scopeId"), key: requiredString(body, "key"), value: body.value as StaticParameter["value"],
      unit: body.unit === null ? null : optionalString(body, "unit") ?? null, label: requiredString(body, "label"),
    });
    response.status(201).json(parameter);
  });
  app.delete(`${prefix}/parameters/:id`, (request, response) => {
    if (!database.deleteParameter(request.params.id as string)) throw new HttpError(404, "NOT_FOUND", "Static parameter not found");
    response.status(204).end();
  });

  app.get(`${prefix}/assets`, (request, response) => response.json({ assets: database.listAssets(typeof request.query.houseId === "string" ? request.query.houseId : undefined) }));
  app.post(`${prefix}/assets`, (request, response) => {
    const body = bodyObject(request.body);
    const mimeType = requiredString(body, "mimeType").toLowerCase();
    if (!SAFE_ASSET_MIME_TYPES.has(mimeType)) {
      throw new HttpError(415, "UNSUPPORTED_ASSET_TYPE", "Assets must be PNG, JPEG, WebP, glTF, or GLB");
    }
    const encoded = requiredString(body, "data").replace(/^data:[^;]+;base64,/, "");
    const data = Buffer.from(encoded, "base64");
    if (data.length === 0) throw new HttpError(400, "INVALID_ASSET", "data must contain valid base64 bytes");
    if (data.length > 10 * 1024 * 1024) throw new HttpError(413, "ASSET_TOO_LARGE", "Decoded assets are limited to 10 MiB");
    const asset = database.createAsset({
      houseId: requiredString(body, "houseId"), name: requiredString(body, "name"), mimeType,
      kind: enumValue(body.kind, ["floor-plan", "model-3d", "other"] as const, "kind"), data,
    });
    response.status(201).json({ asset, url: `${prefix}/assets/${asset.id}` });
  });
  app.get(`${prefix}/assets/:id`, (request, response) => {
    const asset = database.getAsset(request.params.id as string);
    if (!asset) throw new HttpError(404, "NOT_FOUND", "Asset not found");
    response.setHeader("content-type", asset.mimeType);
    response.setHeader("content-length", String(asset.size));
    response.setHeader("content-security-policy", "sandbox; default-src 'none'");
    const disposition = asset.mimeType.startsWith("image/") ? "inline" : "attachment";
    response.setHeader("content-disposition", `${disposition}; filename="${asset.name.replace(/["\r\n]/g, "_")}"`);
    response.send(Buffer.from(asset.data));
  });
  app.delete(`${prefix}/assets/:id`, (request, response) => {
    if (!database.deleteAsset(request.params.id as string)) throw new HttpError(404, "NOT_FOUND", "Asset not found");
    response.status(204).end();
  });

  app.get(`${prefix}/integrations/status`, (_request, response) => response.json(status.value));
  app.post(`${prefix}/integrations/home-assistant/test`, (_request, response) => response.json({
    ok: status.value.homeAssistant.connected,
    message: status.value.homeAssistant.connected
      ? "Home Assistant is connected and streaming state changes."
      : status.value.homeAssistant.configured
        ? status.value.homeAssistant.error ?? "Home Assistant is configured but not connected yet."
        : "Set HA_URL, HA_TOKEN, and HA_ENTITY_MAP_FILE in the API environment, then restart the service.",
  }));
  app.get(`${prefix}/integrations/home-assistant/setup`, (_request, response) => response.json({
    configured: status.value.homeAssistant.configured,
    steps: [
      "Create a Home Assistant long-lived access token for a dedicated local user.",
      "Set HA_URL, HA_TOKEN, and HA_ENTITY_MAP_FILE in the API process environment.",
      "Map each Climate Twin sensor to legacy climate keys and/or a measurements object keyed by registry id.",
      "Restart the API and verify /api/v1/integrations/status reports connected=true.",
    ],
    entityMapSchema: {
      entities: [{
        sensorId: "sensor-01", temperature: "sensor.living_room_temperature", humidity: "sensor.living_room_humidity",
        battery: "sensor.living_room_battery", measurements: { co2: "sensor.living_room_co2" },
      }],
    },
    notes: [
      "All entity keys are optional, but each mapping needs at least one entity.",
      "Generic string bindings require the exact canonical unit; use {entityId, unit, scale, offset} for explicit conversions such as ppb to ppm.",
      "HA_TOKEN is read from the environment and is never returned or stored in SQLite",
    ],
  }));

  app.get(`${prefix}/mock/scenarios`, (_request, response) => response.json({ scenarios: MOCK_SCENARIOS, active: mock.scenario, enabled: config.mockEnabled }));
  app.put(`${prefix}/mock/scenario`, (request, response) => {
    const scenario = enumValue(bodyObject(request.body).scenario, MOCK_SCENARIOS.map((item) => item.id), "scenario");
    mock.setScenario(scenario);
    response.json({ active: mock.scenario });
  });
  app.post(`${prefix}/mock/scenario`, (request, response) => {
    const body = bodyObject(request.body);
    const scenario = enumValue(body.scenarioId ?? body.scenario, MOCK_SCENARIOS.map((item) => item.id), "scenarioId");
    mock.setScenario(scenario);
    response.json({ ok: true, active: mock.scenario });
  });
  app.post(`${prefix}/mock/tick`, (_request, response) => response.status(201).json({ readings: mock.generate(), scenario: mock.scenario }));

  app.get(`${prefix}/replay`, (_request, response) => response.json({ replay: replay.state }));
  app.post(`${prefix}/replay`, (request, response) => {
    const body = bodyObject(request.body);
    const sensorIds = Array.isArray(body.sensorIds) ? body.sensorIds.filter((id): id is string => typeof id === "string") : database.listSensors().map((sensor) => sensor.id);
    const to = dateValue(body.to, new Date(), "to");
    const from = dateValue(body.from, new Date(Date.parse(to) - 3_600_000), "from");
    const speed = typeof body.speed === "number" ? body.speed : 60;
    response.status(202).json({ replay: replay.start(sensorIds, from, to, speed) });
  });
  app.delete(`${prefix}/replay`, (_request, response) => response.json({ replay: replay.stop() }));

  app.use(`${prefix}`, (_request, _response, next) => next(new HttpError(404, "NOT_FOUND", "API endpoint not found")));
  app.use(`${v2Prefix}`, (_request, _response, next) => next(new HttpError(404, "NOT_FOUND", "API endpoint not found")));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ClimateDataValidationError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof TelemetryValidationError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof MeasurementValidationError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof HttpError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } });
      return;
    }
    const message = error instanceof Error ? error.message : "Unexpected error";
    const httpError = error as { status?: unknown; type?: unknown };
    if (httpError.status === 413 || httpError.type === "entity.too.large") {
      response.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the 15 MiB limit" } });
      return;
    }
    if (message.includes("FOREIGN KEY constraint failed")) {
      response.status(409).json({ error: { code: "INVALID_REFERENCE", message: "A referenced resource does not exist" } });
      return;
    }
    if (message.includes("UNIQUE constraint failed")) {
      response.status(409).json({ error: { code: "CONFLICT", message: "A resource with this identifier already exists" } });
      return;
    }
    if (error instanceof SyntaxError) {
      response.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON" } });
      return;
    }
    response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed" } });
  });

  if (options.startBackground) {
    mock.start();
    homeAssistant.start();
    const purge = (): void => {
      database.purgeReadingsBefore(new Date(Date.now() - config.retentionDays * 86_400_000).toISOString());
    };
    purge();
    retentionTimer = setInterval(purge, 86_400_000);
    retentionTimer.unref();
  }

  return {
    app, database, bus, telemetry, measurements, mock, replay, status, homeAssistant, weather,
    close: () => {
      mock.stop();
      replay.stop();
      homeAssistant.stop();
      if (retentionTimer) clearInterval(retentionTimer);
      database.close();
    },
  };
}
