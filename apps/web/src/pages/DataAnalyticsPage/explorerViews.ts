import type { AnalyticsViewDefinition, DataMode, AnalyticsQueryRequest, AnalyticsQueryResponse, MeasurementDefinition } from "@climate-twin/contracts";
import { timeRangeHours, type TimeRange } from "../../domain";
import { writeAnalyticsStateToLocation, qualitiesForPreset, analyticsPointBudget, type AnalyticsLocationState, type ScopedAnalyticsWindow } from "./explorerState";

export function scopedAnalyticsWindow(input: { window: { start: string; end: string }; houseId: string; dataMode: DataMode }): ScopedAnalyticsWindow {
  return { ...input.window, houseId: input.houseId, dataMode: input.dataMode };
}
export function savedViewLocation(input: {
  definition: AnalyticsViewDefinition; houseId: string; dataMode: DataMode; range: TimeRange;
  metricIds: readonly string[]; sensorIds: readonly string[];
}): AnalyticsLocationState | null {
  const definition = input.definition;
  if (!input.metricIds.includes(definition.metric) || definition.sensorIds?.some((id) => !input.sensorIds.includes(id))) return null;
  return {
    metric: definition.metric, selectedSensorIds: definition.sensorIds,
    range: definition.range.kind === "relative" ? definition.range.value : input.range,
    absoluteRange: definition.range.kind === "absolute" ? scopedAnalyticsWindow({ window: definition.range, houseId: input.houseId, dataMode: input.dataMode }) : undefined,
    resolution: definition.resolution, aggregation: definition.aggregation, qualityPreset: definition.qualityPreset,
    weatherObservationsVisible: definition.weatherObservationsVisible, weatherForecastVisible: definition.weatherForecastVisible,
  };
}
export function analyticsViewDefinition(state: AnalyticsLocationState): AnalyticsViewDefinition {
  return {
    metric: state.metric, sensorIds: state.selectedSensorIds,
    range: state.absoluteRange ? { kind: "absolute", start: state.absoluteRange.start, end: state.absoluteRange.end } : { kind: "relative", value: state.range },
    resolution: state.resolution, aggregation: state.aggregation, qualityPreset: state.qualityPreset,
    weatherObservationsVisible: state.weatherObservationsVisible, weatherForecastVisible: state.weatherForecastVisible,
  };
}

export function explorerLocationScope(input: { houseId: string; dataMode: string; analyticsDataMode: DataMode }) {
  return { houseId: input.houseId, dataMode: input.dataMode === "unknown" ? "unknown" : input.analyticsDataMode };
}
export function applySavedAnalyticsView(input: Parameters<typeof savedViewLocation>[0] & { defaultMetric: string }): boolean {
  const next = savedViewLocation(input);
  if (!next) return false;
  writeAnalyticsStateToLocation(next, "push", input.defaultMetric);
  window.dispatchEvent(new PopStateEvent("popstate"));
  return true;
}
export function explorerForecastAllowed(input: { absolute: boolean; sensorsOpen: boolean; analytics: AnalyticsQueryResponse | null; requestId: string; definition: MeasurementDefinition | undefined }): boolean {
  return !input.absolute && input.sensorsOpen && input.analytics !== null && input.analytics.requestId === input.requestId && Boolean(input.definition?.forecastSupported);
}
export function explorerAnalyticsRequest(input: {
  houseId: string; dataMode: DataMode; sensorIds: string[]; timeZone: string; state: AnalyticsLocationState; requestId: string;
}): AnalyticsQueryRequest {
  const state = input.state;
  const end = state.absoluteRange ? new Date(state.absoluteRange.end) : new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const start = state.absoluteRange ? new Date(state.absoluteRange.start) : new Date(end.getTime() - timeRangeHours(state.range) * 3_600_000);
  return {
    apiVersion: "1.0", dataMode: input.dataMode, scope: { kind: "house", id: input.houseId, entityIds: input.sensorIds }, measurementIds: [state.metric],
    range: { start: start.toISOString(), end: end.toISOString(), timezone: input.timeZone }, resolution: state.resolution,
    aggregation: state.resolution === "raw" ? "default" : state.aggregation,
    qualityFilter: { include: qualitiesForPreset(state.qualityPreset) }, include: ["series", "summary", "quality", "provenance", "distribution"],
    maxPointsPerSeries: analyticsPointBudget(state.range), requestId: input.requestId,
  };
}
export function explorerBrushCallback(enabled: boolean, callback: (selection: { start: string; end: string }) => void) {
  return enabled ? callback : undefined;
}
