import { ANALYTICS_AGGREGATIONS, type AnalyticsAggregation, type AnalyticsResolution, type DataMode } from "./measurement-analytics.js";
import { isOneOf } from "./literal-values.js";

export const ANALYTICS_RELATIVE_RANGES = ["6h", "24h", "7d", "30d", "90d", "1y"] as const;
export type AnalyticsRelativeRange = (typeof ANALYTICS_RELATIVE_RANGES)[number];
export type AnalyticsViewRange = { kind: "relative"; value: AnalyticsRelativeRange }
  | { kind: "absolute"; start: string; end: string };
export interface AnalyticsViewDefinition {
  metric: string;
  sensorIds: string[] | null;
  range: AnalyticsViewRange;
  resolution: AnalyticsResolution;
  aggregation: AnalyticsAggregation;
  qualityPreset: "good" | "reliable" | "all";
  weatherObservationsVisible: boolean;
  weatherForecastVisible: boolean;
}
export interface SavedAnalyticsView {
  id: string;
  houseId: string;
  dataMode: DataMode;
  name: string;
  revision: number;
  definition: AnalyticsViewDefinition;
  createdAt: string;
  updatedAt: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}
export function isAnalyticsViewRange(value: unknown): value is AnalyticsViewRange {
  if (!record(value)) return false;
  if (value.kind === "relative") return keys(value, ["kind", "value"]) && isOneOf(value.value, ANALYTICS_RELATIVE_RANGES);
  if (value.kind !== "absolute" || !keys(value, ["kind", "start", "end"])) return false;
  if (typeof value.start !== "string" || typeof value.end !== "string") return false;
  const start = Date.parse(value.start);
  const end = Date.parse(value.end);
  return Number.isFinite(start) && Number.isFinite(end) && start < end && end - start <= 366 * 86_400_000
    && new Date(start).toISOString() === value.start && new Date(end).toISOString() === value.end;
}
export function isAnalyticsResolution(value: unknown): value is AnalyticsResolution {
  if (value === "auto" || value === "raw" || value === "1h" || value === "1d") return true;
  if (typeof value !== "string" || !/^[1-9]\d{0,3}m$/u.test(value)) return false;
  return Number(value.slice(0, -1)) <= 1440;
}
export function isAnalyticsViewDefinition(value: unknown): value is AnalyticsViewDefinition {
  if (!record(value) || !keys(value, ["metric", "sensorIds", "range", "resolution", "aggregation", "qualityPreset", "weatherObservationsVisible", "weatherForecastVisible"])) return false;
  const sensors = value.sensorIds;
  const validSensors = sensors === null || (Array.isArray(sensors) && sensors.length <= 50
    && sensors.every(identifier) && new Set(sensors).size === sensors.length);
  return identifier(value.metric) && validSensors && isAnalyticsViewRange(value.range) && isAnalyticsResolution(value.resolution)
    && isOneOf(value.aggregation, ANALYTICS_AGGREGATIONS) && isOneOf(value.qualityPreset, ["good", "reliable", "all"])
    && typeof value.weatherObservationsVisible === "boolean" && typeof value.weatherForecastVisible === "boolean";
}
export function isSavedAnalyticsView(value: unknown): value is SavedAnalyticsView {
  if (!record(value)) return false;
  return identifier(value.id) && identifier(value.houseId) && isOneOf(value.dataMode, ["live", "demo"])
    && typeof value.name === "string" && value.name.trim().length > 0 && value.name.length <= 80
    && Number.isSafeInteger(value.revision) && Number(value.revision) > 0 && isAnalyticsViewDefinition(value.definition)
    && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt));
}
