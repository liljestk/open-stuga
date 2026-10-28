import type { MeasurementDefinition, Sensor } from "@climate-twin/contracts";
import { type ImportCell, type InputUnit, isBlank, normalizeImportToken } from "./importModel";
import { metricAliases } from "./columnMapping";

export function numberValue(value: ImportCell | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  let text = value.trim().replace(/\s/g, "");
  if (!text) return null;
  if (/^-?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?$/.test(text)) {
    const lastComma = text.lastIndexOf(",");
    const lastDot = text.lastIndexOf(".");
    const decimal = Math.max(lastComma, lastDot);
    text = `${text.slice(0, decimal).replace(/[.,]/g, "")}.${text.slice(decimal + 1)}`;
  } else if (text.includes(",") && !text.includes(".")) {
    text = text.replace(",", ".");
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

export function convertValue(value: number, unit: InputUnit): number {
  if (unit === "fahrenheit") return (value - 32) * 5 / 9;
  if (unit === "kelvin") return value - 273.15;
  return value;
}

export function unitFromCell(value: ImportCell | undefined): InputUnit {
  const unit = normalizeImportToken(value);
  if (["f", "degf", "fahrenheit"].includes(unit)) return "fahrenheit";
  if (["k", "kelvin"].includes(unit)) return "kelvin";
  return "canonical";
}

export interface ImportLookups {
  sensorsById: Map<string, Sensor>;
  sensorsByToken: Map<string, Sensor | null>;
  metricsByToken: Map<string, MeasurementDefinition>;
}

export function createImportLookups(sensors: Sensor[], definitions: MeasurementDefinition[]): ImportLookups {
  const sensorsById = new Map<string, Sensor>();
  const sensorsByToken = new Map<string, Sensor | null>();
  for (const sensor of sensors) {
    if (!sensorsById.has(sensor.id)) sensorsById.set(sensor.id, sensor);
    const tokens = new Set([normalizeImportToken(sensor.id), normalizeImportToken(sensor.name)]);
    for (const token of tokens) {
      if (!token) continue;
      const existing = sensorsByToken.get(token);
      if (existing === undefined) sensorsByToken.set(token, sensor);
      else if (existing !== sensor) sensorsByToken.set(token, null);
    }
  }
  const metricsByToken = new Map<string, MeasurementDefinition>();
  for (const definition of definitions) {
    for (const token of metricAliases(definition)) {
      if (!metricsByToken.has(token)) metricsByToken.set(token, definition);
    }
  }
  return { sensorsById, sensorsByToken, metricsByToken };
}

export function resolveSensor(value: ImportCell | undefined, lookups: ImportLookups, fallbackSensorId: string): Sensor | null {
  if (value === undefined || value === null || String(value).trim() === "") {
    return lookups.sensorsById.get(fallbackSensorId) ?? null;
  }
  return lookups.sensorsByToken.get(normalizeImportToken(value)) ?? null;
}

export function resolveMetric(
  value: ImportCell | undefined,
  definitionsById: Map<string, MeasurementDefinition>,
  lookups: ImportLookups,
  fallback: string,
): MeasurementDefinition | null {
  if (isBlank(value)) return definitionsById.get(fallback) ?? null;
  return lookups.metricsByToken.get(normalizeImportToken(value)) ?? null;
}
