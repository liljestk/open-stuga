import { bodyObject, requiredString, enumValue, optionalBoolean, presentFields, requiredNumber } from "../../request-fields.js";
import type { MeasurementDefinition, MeasurementSample, Reading } from "@climate-twin/contracts";
import { ClimateDatabase } from "../../db.js";
import { HttpError } from "../../http-error.js";
import { dateValue } from "./query-fields.js";

export const RESERVED_MEASUREMENT_IDS = new Set(["__proto__", "constructor", "prototype"]);

export const MEASUREMENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

export function measurementId(value: unknown, field = "metric"): string {
  if (typeof value !== "string" || value.length > 64 || !MEASUREMENT_ID_PATTERN.test(value) || RESERVED_MEASUREMENT_IDS.has(value)) {
    throw new HttpError(400, "INVALID_MEASUREMENT_ID", `${field} must be a safe lowercase registry identifier`);
  }
  return value;
}

export function stringMap(value: unknown, field: string): Record<string, string> {
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

export function measurementNumberMap(value: unknown, field: string): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "INVALID_FIELD", `${field} must be an object`);
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [key, item] of Object.entries(value)) {
    const id = measurementId(key, `${field} key`);
    if (typeof item !== "number" || !Number.isFinite(item)) throw new HttpError(400, "INVALID_FIELD", `${field}.${key} must be finite`);
    result[id] = item;
  }
  return result;
}

export function measurementStringMap(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "INVALID_FIELD", `${field} must be an object`);
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, item] of Object.entries(value)) {
    const id = measurementId(key, `${field} key`);
    if (typeof item !== "string" || !item.trim()) throw new HttpError(400, "INVALID_FIELD", `${field}.${key} must be a non-empty entity id`);
    result[id] = item.trim();
  }
  return result;
}

export function nullableFinite(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(400, "INVALID_FIELD", `${field} must be finite or null`);
  return value;
}

export function validateMeasurementDefinition(definition: MeasurementDefinition): MeasurementDefinition {
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
  if (!definition.dimension?.trim()) throw new HttpError(400, "INVALID_FIELD", "dimension must be a non-empty string");
  if (!definition.allowedUnits?.length || definition.allowedUnits.some((unit) => !unit.trim())) {
    throw new HttpError(400, "INVALID_FIELD", "allowedUnits must contain at least one non-empty unit");
  }
  if (!definition.allowedUnits.includes(definition.unit)) {
    throw new HttpError(400, "INVALID_FIELD", "allowedUnits must include the canonical unit");
  }
  return definition;
}

export function measurementUnits(value: unknown, canonicalUnit: string, current?: string[]): string[] {
  if (value === undefined) return current ?? [canonicalUnit];
  if (!Array.isArray(value) || value.length === 0 || value.length > 50
    || value.some((unit) => typeof unit !== "string" || !unit.trim() || unit.length > 50)) {
    throw new HttpError(400, "INVALID_FIELD", "allowedUnits must contain between 1 and 50 non-empty unit strings");
  }
  return [...new Set(value.map((unit) => (unit as string).trim()))];
}

type DefinitionSettings = Required<Omit<MeasurementDefinition, "id" | "labels" | "unit" | "allowedUnits" | "builtin">>;

/** A new definition's settings when neither the body nor the current definition sets them. */
const DEFINITION_DEFAULTS: DefinitionSettings = {
  dimension: "finite_scalar", kind: "gauge", defaultAggregation: "mean", genericHistoryEnabled: true, genericStatsEnabled: true,
  precision: 1, validMin: null, validMax: null, displayMin: null, displayMax: null, interpolationDelta: 1,
  colorScale: "sequential", enabled: true, spatialInterpolation: false, forecastSupported: false,
};

const flag = (body: Record<string, unknown>, key: string) => optionalBoolean(body, key) as boolean;
const nullableFiniteField = (body: Record<string, unknown>, key: string) => nullableFinite(body[key], key);

/** How each definition setting is read from a request body. */
const DEFINITION_SETTING_FIELDS = {
  dimension: (body: Record<string, unknown>, key: string) => requiredString(body, key),
  kind: (body: Record<string, unknown>) => enumValue(body.kind, ["gauge", "rate", "increment", "cumulative_counter", "binary_state", "categorical_state"] as const, "kind"),
  defaultAggregation: (body: Record<string, unknown>) => enumValue(body.defaultAggregation, ["mean", "sum", "delta", "last", "time_weighted_mean", "duration", "custom"] as const, "defaultAggregation"),
  genericHistoryEnabled: flag,
  genericStatsEnabled: flag,
  precision: (body: Record<string, unknown>) => {
    if (typeof body.precision !== "number" || !Number.isInteger(body.precision)) {
      throw new HttpError(400, "INVALID_FIELD", "precision must be an integer from 0 to 6");
    }
    return body.precision;
  },
  validMin: nullableFiniteField,
  validMax: nullableFiniteField,
  displayMin: nullableFiniteField,
  displayMax: nullableFiniteField,
  interpolationDelta: (body: Record<string, unknown>, key: string) => requiredNumber(body, key),
  colorScale: (body: Record<string, unknown>) => enumValue(body.colorScale, ["thermal", "humidity", "air-quality", "sequential"] as const, "colorScale"),
  enabled: flag,
  spatialInterpolation: flag,
  forecastSupported: flag,
};

/** Each setting from the body when present, else from the current definition, else its default. */
function definitionSettings(body: Record<string, unknown>, current: MeasurementDefinition | undefined): DefinitionSettings {
  const fromBody: Partial<DefinitionSettings> = presentFields(body, DEFINITION_SETTING_FIELDS);
  const settings = { ...DEFINITION_DEFAULTS };
  for (const key of Object.keys(DEFINITION_DEFAULTS) as (keyof DefinitionSettings)[]) {
    if (Object.hasOwn(fromBody, key)) Object.assign(settings, { [key]: fromBody[key] });
    else if (current?.[key] !== undefined && current[key] !== null) Object.assign(settings, { [key]: current[key] });
  }
  return settings;
}

export function parseMeasurementDefinition(value: unknown, current?: MeasurementDefinition): MeasurementDefinition {
  const body = bodyObject(value);
  if ((current && body.id !== undefined) || body.builtin !== undefined) {
    throw new HttpError(409, "IMMUTABLE_FIELD", "Measurement definition id and builtin status cannot be changed");
  }
  const canonicalUnit = body.unit === undefined ? current?.unit ?? requiredString(body, "unit") : requiredString(body, "unit");
  const inheritedAllowedUnits = body.unit !== undefined && body.allowedUnits === undefined
    ? [canonicalUnit, ...(current?.allowedUnits ?? []).filter((unit) => unit !== canonicalUnit)]
    : current?.allowedUnits;
  const id = current?.id ?? measurementId(body.id, "id");
  const labels = body.labels === undefined ? current?.labels : stringMap(body.labels, "labels");
  if (!labels) throw new HttpError(400, "INVALID_FIELD", "labels is required");
  return validateMeasurementDefinition({
    id,
    labels,
    unit: canonicalUnit,
    allowedUnits: measurementUnits(body.allowedUnits, canonicalUnit, inheritedAllowedUnits),
    ...definitionSettings(body, current),
    builtin: current?.builtin ?? false,
  });
}

export function parseMeasurementSample(value: unknown, database: ClimateDatabase): MeasurementSample {
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
    // External REST/MCP callers cannot assert trusted integration provenance.
    // Historical traffic is assigned `import` only by the dedicated import path.
    source: "api",
    quality: body.quality === undefined ? "good" : enumValue(body.quality, ["good", "estimated", "stale"] as const, "quality"),
  };
}

export function parseReading(value: unknown): Reading {
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
