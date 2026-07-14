import type { MeasurementSample, Reading } from "../../packages/contracts/src/index.js";
import { HttpError, finiteNumber, isObject, requiredString } from "./http.js";

export interface TelemetryGroup {
  sensorId: string;
  timestamp: string;
  source: MeasurementSample["source"];
  quality: MeasurementSample["quality"];
  values: Record<string, number>;
  units: Record<string, string>;
}

const SOURCES = new Set<MeasurementSample["source"]>(["mock", "home-assistant", "tp-link", "api", "import", "replay"]);
const QUALITIES = new Set<MeasurementSample["quality"]>(["good", "estimated", "stale"]);
const METRIC_ID = /^[a-z][a-z0-9._-]{0,63}$/;

export function configuredBucketSeconds(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 60 && parsed <= 86_400 ? parsed : 600;
}

export function bucketTimestamp(timestamp: string, intervalSeconds: number): string {
  const epoch = Date.parse(timestamp);
  if (!Number.isFinite(epoch)) throw new HttpError(400, "INVALID_TIMESTAMP", "timestamp must be a valid ISO-8601 instant");
  const intervalMs = intervalSeconds * 1000;
  return new Date(Math.floor(epoch / intervalMs) * intervalMs).toISOString();
}

function sourceValue(value: unknown): MeasurementSample["source"] {
  return typeof value === "string" && SOURCES.has(value as MeasurementSample["source"])
    ? value as MeasurementSample["source"]
    : "api";
}

function qualityValue(value: unknown): MeasurementSample["quality"] {
  return typeof value === "string" && QUALITIES.has(value as MeasurementSample["quality"])
    ? value as MeasurementSample["quality"]
    : "good";
}

function timestampValue(value: unknown): string {
  return typeof value === "string" ? value : new Date().toISOString();
}

function canonicalTimestamp(value: unknown): string {
  const epoch = Date.parse(timestampValue(value));
  if (!Number.isFinite(epoch)) throw new HttpError(400, "INVALID_TIMESTAMP", "timestamp must be a valid ISO-8601 instant");
  return new Date(epoch).toISOString();
}

function defaultUnit(metric: string): string {
  if (metric === "temperature") return "°C";
  if (metric === "humidity" || metric === "battery") return "%";
  if (metric === "co2") return "ppm";
  return "";
}

export function parseMeasurementInput(value: unknown): MeasurementSample {
  if (!isObject(value)) throw new HttpError(400, "INVALID_SAMPLE", "Every measurement sample must be an object");
  const sensorId = requiredString(value, "sensorId", 200);
  const metric = requiredString(value, "metric", 64).toLowerCase();
  if (!METRIC_ID.test(metric)) throw new HttpError(400, "INVALID_METRIC", "metric must be a lowercase registry identifier");
  const timestamp = canonicalTimestamp(value.timestamp);
  const canonicalUnit = typeof value.canonicalUnit === "string" && value.canonicalUnit.length <= 40
    ? value.canonicalUnit
    : defaultUnit(metric);
  return {
    sensorId,
    metric,
    value: finiteNumber(value.value, "value"),
    canonicalUnit,
    timestamp,
    source: sourceValue(value.source),
    quality: qualityValue(value.quality),
  };
}

export function parseReadingInput(value: unknown): Reading {
  if (!isObject(value)) throw new HttpError(400, "INVALID_READING", "Every reading must be an object");
  const measurements: Record<string, number> = {};
  if (isObject(value.measurements)) {
    for (const [metric, candidate] of Object.entries(value.measurements)) {
      if (METRIC_ID.test(metric) && typeof candidate === "number" && Number.isFinite(candidate)) measurements[metric] = candidate;
    }
  }
  return {
    sensorId: requiredString(value, "sensorId", 200),
    temperature: finiteNumber(value.temperature, "temperature"),
    humidity: finiteNumber(value.humidity, "humidity"),
    battery: value.battery === null || value.battery === undefined ? null : finiteNumber(value.battery, "battery"),
    timestamp: canonicalTimestamp(value.timestamp),
    source: sourceValue(value.source),
    quality: qualityValue(value.quality),
    ...(Object.keys(measurements).length ? { measurements } : {}),
  };
}

export function readingsToMeasurements(readings: Reading[]): MeasurementSample[] {
  return readings.flatMap((reading) => {
    const values: Record<string, number> = {
      ...(reading.measurements ?? {}),
      temperature: reading.temperature,
      humidity: reading.humidity,
      ...(reading.battery === null ? {} : { battery: reading.battery }),
    };
    return Object.entries(values).map(([metric, value]) => ({
      sensorId: reading.sensorId,
      metric,
      value,
      canonicalUnit: defaultUnit(metric),
      timestamp: reading.timestamp,
      source: reading.source,
      quality: reading.quality,
    }));
  });
}

export function groupMeasurements(samples: MeasurementSample[], intervalSeconds: number): TelemetryGroup[] {
  const groups = new Map<string, TelemetryGroup>();
  for (const sample of samples) {
    const timestamp = bucketTimestamp(sample.timestamp, intervalSeconds);
    const key = `${sample.sensorId}\u0000${timestamp}`;
    const current = groups.get(key) ?? {
      sensorId: sample.sensorId,
      timestamp,
      source: sample.source,
      quality: sample.quality,
      values: {},
      units: {},
    };
    current.values[sample.metric] = sample.value;
    current.units[sample.metric] = sample.canonicalUnit;
    if (sample.quality === "stale" || (sample.quality === "estimated" && current.quality === "good")) current.quality = sample.quality;
    current.source = sample.source;
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.sensorId.localeCompare(right.sensorId));
}

export function metricJsonPath(metric: string): string {
  if (!METRIC_ID.test(metric)) throw new HttpError(400, "INVALID_METRIC", "metric must be a lowercase registry identifier");
  return `$.${metric}`;
}
