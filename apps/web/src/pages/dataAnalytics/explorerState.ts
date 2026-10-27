import type {
  AnalyticsAggregation,
  AnalyticsResolution,
  AnalyticsSampleQuality,
  MeasurementDefinition,
  Metric,
} from "@climate-twin/contracts";
import { ANALYTICS_TIME_RANGES, type TimeRange } from "../../domain";
import { compareCodeUnits } from "../../textOrder";

export type QualityPreset = "good" | "reliable" | "all";
export type AnalyticsTool = "performance" | "openings" | "sensors";

export const ANALYTICS_RESOLUTIONS = ["auto", "raw", "1m", "5m", "15m", "30m", "1h", "1d"] as const satisfies readonly AnalyticsResolution[];
const ANALYTICS_AGGREGATIONS: AnalyticsAggregation[] = ["default", "mean", "sum", "delta", "last", "time_weighted_mean", "min", "max"];
const QUALITY_PRESETS: QualityPreset[] = ["good", "reliable", "all"];
const ANALYTICS_TOOLS: AnalyticsTool[] = ["performance", "openings", "sensors"];
const ANALYTICS_CHART_PARAMS = ["range", "resolution", "aggregation", "quality", "metric", "sensors", "weather"];
const DEFAULT_ANALYTICS_STATE = {
  range: "24h",
  resolution: "auto",
  aggregation: "default",
  qualityPreset: "reliable",
  metric: "temperature",
  selectedSensorIds: null,
  weatherObservationsVisible: true,
  weatherForecastVisible: true,
} as const satisfies AnalyticsLocationState;

export interface AnalyticsLocationState {
  range: TimeRange;
  resolution: AnalyticsResolution;
  aggregation: AnalyticsAggregation;
  qualityPreset: QualityPreset;
  metric: Metric;
  selectedSensorIds: string[] | null;
  weatherObservationsVisible: boolean;
  weatherForecastVisible: boolean;
}

export function analyticsToolsFromLocation(): AnalyticsTool[] {
  if (typeof window === "undefined") return [];
  const params = new URLSearchParams(window.location.search);
  const requested = (params.get("tools") ?? "")
    .split(",")
    .filter((tool): tool is AnalyticsTool => ANALYTICS_TOOLS.includes(tool as AnalyticsTool));
  const tools = new Set<AnalyticsTool>(requested);
  const hasExplicitHash = ["#performance", "#openings", "#sensors", "#evidence"].includes(window.location.hash);
  if (window.location.hash === "#performance") tools.add("performance");
  if (window.location.hash === "#openings") tools.add("openings");
  if (
    window.location.hash === "#sensors"
    || window.location.hash === "#evidence"
    || (requested.length === 0 && !hasExplicitHash && ANALYTICS_CHART_PARAMS.some((parameter) => params.has(parameter)))
  ) tools.add("sensors");
  return ANALYTICS_TOOLS.filter((tool) => tools.has(tool));
}

export function writeAnalyticsToolsToLocation(tools: ReadonlySet<AnalyticsTool>): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const ordered = ANALYTICS_TOOLS.filter((tool) => tools.has(tool));
  if (ordered.length > 0) url.searchParams.set("tools", ordered.join(","));
  else url.searchParams.delete("tools");
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) window.history.pushState(window.history.state, "", next);
}

export function evidenceIsDeepLinked(): boolean {
  return typeof window !== "undefined" && window.location.hash === "#evidence";
}

export function defaultAnalyticsMetric(metricIds: readonly Metric[]): Metric {
  return metricIds.includes("temperature") ? "temperature" : metricIds[0] ?? "temperature";
}

export function analyticsStateFromLocation(metricIds: readonly Metric[], sensorIds: readonly string[]): AnalyticsLocationState {
  const defaultMetric = defaultAnalyticsMetric(metricIds);
  if (typeof window === "undefined") return { ...DEFAULT_ANALYTICS_STATE, metric: defaultMetric };
  const params = new URLSearchParams(window.location.search);
  const requestedRange = params.get("range");
  const requestedResolution = params.get("resolution");
  const requestedAggregation = params.get("aggregation");
  const requestedQuality = params.get("quality");
  const requestedMetric = params.get("metric");
  const requestedSensors = params.get("sensors");
  const requestedWeather = params.get("weather");
  const validRequestedSensors = requestedSensors && requestedSensors !== "none"
    ? [...new Set(requestedSensors.split(",").filter((sensorId) => sensorIds.includes(sensorId)))].sort(compareCodeUnits)
    : [];
  const resolution = ANALYTICS_RESOLUTIONS.some((option) => option === requestedResolution)
    ? requestedResolution as AnalyticsResolution
    : DEFAULT_ANALYTICS_STATE.resolution;
  return {
    range: ANALYTICS_TIME_RANGES.includes(requestedRange as TimeRange)
      ? requestedRange as TimeRange
      : DEFAULT_ANALYTICS_STATE.range,
    resolution,
    aggregation: resolution !== "raw" && ANALYTICS_AGGREGATIONS.includes(requestedAggregation as AnalyticsAggregation)
      ? requestedAggregation as AnalyticsAggregation
      : DEFAULT_ANALYTICS_STATE.aggregation,
    qualityPreset: QUALITY_PRESETS.includes(requestedQuality as QualityPreset)
      ? requestedQuality as QualityPreset
      : DEFAULT_ANALYTICS_STATE.qualityPreset,
    metric: requestedMetric && metricIds.includes(requestedMetric) ? requestedMetric : defaultMetric,
    selectedSensorIds: requestedSensors === "none"
      ? []
      : validRequestedSensors.length > 0 ? validRequestedSensors : null,
    weatherObservationsVisible: requestedWeather !== "forecast" && requestedWeather !== "none",
    weatherForecastVisible: requestedWeather !== "observations" && requestedWeather !== "none",
  };
}

export function writeAnalyticsStateToLocation(state: AnalyticsLocationState, mode: "push" | "replace", defaultMetric: Metric): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const write = (key: string, value: string, defaultValue: string) => {
    if (value === defaultValue) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  };
  write("range", state.range, DEFAULT_ANALYTICS_STATE.range);
  write("resolution", state.resolution, DEFAULT_ANALYTICS_STATE.resolution);
  write("aggregation", state.resolution === "raw" ? "default" : state.aggregation, DEFAULT_ANALYTICS_STATE.aggregation);
  write("quality", state.qualityPreset, DEFAULT_ANALYTICS_STATE.qualityPreset);
  write("metric", state.metric, defaultMetric);
  if (state.selectedSensorIds === null) url.searchParams.delete("sensors");
  else if (state.selectedSensorIds.length === 0) url.searchParams.set("sensors", "none");
  else url.searchParams.set("sensors", [...new Set(state.selectedSensorIds)].sort(compareCodeUnits).join(","));
  const weather = state.weatherObservationsVisible
    ? state.weatherForecastVisible ? null : "observations"
    : state.weatherForecastVisible ? "forecast" : "none";
  if (weather) url.searchParams.set("weather", weather);
  else url.searchParams.delete("weather");
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) window.history[`${mode}State`](window.history.state, "", next);
}

export function aggregationOptions(definition: MeasurementDefinition | undefined): AnalyticsAggregation[] {
  const kind = definition?.kind ?? "gauge";
  if (kind === "rate") return ["default", "time_weighted_mean", "mean", "last", "min", "max"];
  if (kind === "increment") return ["default", "sum", "last", "min", "max"];
  if (kind === "cumulative_counter") return ["default", "delta", "last", "min", "max"];
  if (kind === "binary_state") return ["default", "last", "mean"];
  if (kind === "categorical_state") return ["default", "last"];
  return ["default", "mean", "last", "min", "max"];
}

export function qualitiesForPreset(preset: QualityPreset): AnalyticsSampleQuality[] {
  if (preset === "good") return ["good"];
  if (preset === "reliable") return ["good", "estimated"];
  return ["good", "estimated", "stale"];
}

export function analyticsPointBudget(range: TimeRange): number {
  if (range === "30d") return 1_000;
  if (range === "90d") return 2_500;
  if (range === "1y") return 1_000;
  return 500;
}

export function analyticsIdentityToken(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(36)}${(right >>> 0).toString(36)}`;
}

export function durationLabel(milliseconds: number, locale: string): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "short" }).format(minutes);
  const hours = minutes / 60;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: hours < 10 ? 1 : 0, style: "unit", unit: "hour", unitDisplay: "short" }).format(hours);
}
