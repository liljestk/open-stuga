import type { Metric } from "@climate-twin/contracts";

import type { TimeRange, ViewMode } from "../../domain";
import { enabledDefinitions } from "../../measurements";
import { sensorSupportsMeasurement, type TwinDashboardProps } from "./support";

export const TWIN_DASHBOARD_QUERY_KEYS = {
  floor: "floor",
  metric: "metric",
  view: "view",
  sensor: "sensor",
  range: "range",
} as const;

export const TWIN_DASHBOARD_HOME_VIEW_QUERY_KEY = "homeView";

export type TwinDashboardHomeView = "auto" | "summary" | "live" | "edit" | "full";

export const TWIN_DASHBOARD_TIME_RANGES = ["6h", "24h", "7d"] as const satisfies readonly TimeRange[];

export interface TwinDashboardQuerySelection {
  floorId: string;
  metric: Metric;
  viewMode: ViewMode;
  selectedSensorId: string | null;
  range: TimeRange;
}

export interface TwinDashboardQueryOptions {
  floorIds: readonly string[];
  metricIds: readonly Metric[];
  sensors: readonly { id: string; floorId: string }[];
  defaultFloorId: string;
  defaultMetric: Metric;
}

export function twinDashboardQueryOptions(props: TwinDashboardProps): TwinDashboardQueryOptions {
  const sensors = props.state.sensors
    .filter((sensor) => sensor.houseId === props.houseId && sensor.enabled)
    .map(({ id, floorId }) => ({ id, floorId }));
  const definitions = enabledDefinitions(props.state.measurementDefinitions);
  const supported = definitions.filter((definition) => props.state.sensors.some((sensor) => (
    sensor.houseId === props.houseId
    && sensor.enabled
    && sensorSupportsMeasurement(props.state, sensor, definition.id)
  )));
  const metricIds = (supported.length ? supported : definitions).map((definition) => definition.id);
  const defaultMetric = metricIds.includes("temperature")
    ? "temperature"
    : metricIds[0] ?? props.metric;

  return {
    floorIds: props.house.floors.map((floor) => floor.id),
    metricIds,
    sensors,
    defaultFloorId: props.house.floors[0]?.id ?? props.floorId,
    defaultMetric,
  };
}

function defaultSensorId(options: TwinDashboardQueryOptions, floorId: string): string | null {
  return options.sensors.find((sensor) => sensor.floorId === floorId)?.id
    ?? options.sensors[0]?.id
    ?? null;
}

function sensorIdForFloor(
  sensorId: string | null,
  floorId: string,
  options: TwinDashboardQueryOptions,
): string | null {
  return sensorId && options.sensors.some((sensor) => sensor.id === sensorId && sensor.floorId === floorId)
    ? sensorId
    : defaultSensorId(options, floorId);
}

export function defaultTwinDashboardQuerySelection(
  options: TwinDashboardQueryOptions,
): TwinDashboardQuerySelection {
  return {
    floorId: options.defaultFloorId,
    metric: options.defaultMetric,
    viewMode: "plan",
    selectedSensorId: defaultSensorId(options, options.defaultFloorId),
    range: "24h",
  };
}

export function twinDashboardQueryHasMeaningfulSelection(
  search: string,
  options: TwinDashboardQueryOptions,
): boolean {
  const params = new URLSearchParams(search);
  if (!Object.values(TWIN_DASHBOARD_QUERY_KEYS).some((key) => params.has(key))) return false;
  const selection = readTwinDashboardQuerySelection(search, options);
  const defaults = defaultTwinDashboardQuerySelection(options);
  return selection.floorId !== defaults.floorId
    || selection.metric !== defaults.metric
    || selection.viewMode !== defaults.viewMode
    || selection.selectedSensorId !== defaults.selectedSensorId
    || selection.range !== defaults.range;
}

export function readTwinDashboardQuerySelection(
  search: string,
  options: TwinDashboardQueryOptions,
  fallback?: TwinDashboardQuerySelection,
): TwinDashboardQuerySelection {
  const defaults = defaultTwinDashboardQuerySelection(options);
  const params = new URLSearchParams(search);

  const floorValue = params.get(TWIN_DASHBOARD_QUERY_KEYS.floor);
  const floorId = floorValue === null
    ? (fallback && options.floorIds.includes(fallback.floorId) ? fallback.floorId : defaults.floorId)
    : (options.floorIds.includes(floorValue) ? floorValue : defaults.floorId);

  const metricValue = params.get(TWIN_DASHBOARD_QUERY_KEYS.metric) as Metric | null;
  const metric = metricValue === null
    ? (fallback && options.metricIds.includes(fallback.metric) ? fallback.metric : defaults.metric)
    : (options.metricIds.includes(metricValue) ? metricValue : defaults.metric);

  const viewValue = params.get(TWIN_DASHBOARD_QUERY_KEYS.view);
  const viewMode = viewValue === null
    ? fallback?.viewMode ?? defaults.viewMode
    : (viewValue === "isometric" ? "isometric" : defaults.viewMode);

  const sensorValue = params.get(TWIN_DASHBOARD_QUERY_KEYS.sensor);
  const fallbackSensor = sensorIdForFloor(fallback?.selectedSensorId ?? null, floorId, options);
  const selectedSensorId = sensorValue === null
    ? fallbackSensor
    : sensorIdForFloor(sensorValue, floorId, options);

  const rangeValue = params.get(TWIN_DASHBOARD_QUERY_KEYS.range) as TimeRange | null;
  const range = rangeValue === null
    ? fallback?.range ?? defaults.range
    : (TWIN_DASHBOARD_TIME_RANGES.some((candidate) => candidate === rangeValue) ? rangeValue : defaults.range);

  return { floorId, metric, viewMode, selectedSensorId, range };
}

export function twinDashboardLocation(
  href: string,
  selection: TwinDashboardQuerySelection,
  options: TwinDashboardQueryOptions,
): string {
  const defaults = defaultTwinDashboardQuerySelection(options);
  const floorId = options.floorIds.includes(selection.floorId) ? selection.floorId : defaults.floorId;
  const metric = options.metricIds.includes(selection.metric) ? selection.metric : defaults.metric;
  const viewMode = selection.viewMode === "isometric" ? selection.viewMode : defaults.viewMode;
  const range = TWIN_DASHBOARD_TIME_RANGES.some((candidate) => candidate === selection.range)
    ? selection.range
    : defaults.range;
  const selectedSensorId = sensorIdForFloor(selection.selectedSensorId, floorId, options);
  const url = new URL(href);
  const setOrDelete = (key: string, value: string, defaultValue: string) => {
    if (value === defaultValue) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  };

  setOrDelete(TWIN_DASHBOARD_QUERY_KEYS.floor, floorId, defaults.floorId);
  setOrDelete(TWIN_DASHBOARD_QUERY_KEYS.metric, metric, defaults.metric);
  setOrDelete(TWIN_DASHBOARD_QUERY_KEYS.view, viewMode, defaults.viewMode);
  setOrDelete(TWIN_DASHBOARD_QUERY_KEYS.range, range, defaults.range);

  const defaultSensor = defaultSensorId(options, floorId);
  if (!selectedSensorId || selectedSensorId === defaultSensor) {
    url.searchParams.delete(TWIN_DASHBOARD_QUERY_KEYS.sensor);
  } else {
    url.searchParams.set(TWIN_DASHBOARD_QUERY_KEYS.sensor, selectedSensorId);
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

export function writeTwinDashboardQuerySelection(
  selection: TwinDashboardQuerySelection,
  options: TwinDashboardQueryOptions,
  mode: "push" | "replace",
): void {
  const next = twinDashboardLocation(window.location.href, selection, options);
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  if (mode === "push") window.history.pushState(window.history.state, "", next);
  else window.history.replaceState(window.history.state, "", next);
}

export function readTwinDashboardHomeView(search: string): TwinDashboardHomeView {
  const value = new URLSearchParams(search).get(TWIN_DASHBOARD_HOME_VIEW_QUERY_KEY);
  return value === "summary" || value === "live" || value === "edit" || value === "full"
    ? value
    : "auto";
}

export function twinDashboardHomeViewLocation(href: string, homeView: TwinDashboardHomeView): string {
  const url = new URL(href);
  if (homeView === "auto") url.searchParams.delete(TWIN_DASHBOARD_HOME_VIEW_QUERY_KEY);
  else url.searchParams.set(TWIN_DASHBOARD_HOME_VIEW_QUERY_KEY, homeView);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function writeTwinDashboardHomeView(
  homeView: TwinDashboardHomeView,
  mode: "push" | "replace",
): void {
  const next = twinDashboardHomeViewLocation(window.location.href, homeView);
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  if (mode === "push") window.history.pushState(window.history.state, "", next);
  else window.history.replaceState(window.history.state, "", next);
}

export function selectionWithFloor(
  selection: TwinDashboardQuerySelection,
  floorId: string,
  options: TwinDashboardQueryOptions,
): TwinDashboardQuerySelection {
  return { ...selection, floorId, selectedSensorId: defaultSensorId(options, floorId) };
}
