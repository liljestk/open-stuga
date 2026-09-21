import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartLine, ChevronDown, CloudSun, Database, DoorOpen, Download, Droplets, FileJson, FileSpreadsheet, Gauge, RefreshCw, ShieldCheck, Table2, TriangleAlert } from "lucide-react";
import type {
  AnalyticsAggregation,
  AnalyticsQueryResponse,
  AnalyticsResolution,
  AnalyticsSampleQuality,
  House,
  HomeElectricityPricePoint,
  Metric,
  MeasurementDefinition,
  MeasurementForecastPoint,
  OutdoorTemperatureSample,
  SensorDataGap,
  UnitSystem,
} from "@climate-twin/contracts";
import { ANALYTICS_TIME_RANGES, timeRangeHours, type ClimateState, type TimeRange } from "../domain";
import { api } from "../api";
import { observedSeries, SensorAnalyticsChart } from "../components/SensorAnalyticsChart";
import { DailyAnalyticsFindings } from "../components/DailyAnalyticsFindings";
import { HomePerformancePanel } from "../components/HomePerformancePanel";
import { OpeningAnalyticsPanel } from "../components/OpeningAnalyticsPanel";
import { ThermalIsolationPanel } from "../components/ThermalIsolationPanel";
import { MoistureResponsePanel } from "../components/MoistureResponsePanel";
import { DataExportPanel } from "../components/DataExportPanel";
import { chartGapThresholdMs, detectSeriesGaps } from "../chartGaps";
import { csvDocument } from "../csv";
import { formatInTimeZone } from "../dateTime";
import { useHouseWeather } from "../useHouseWeather";
import { useI18n } from "../i18n";
import { formatMeasurement, measurementLabel, type MeasurementForecasts } from "../measurements";
import { useNow } from "../useNow";

interface DataAnalyticsPageProps {
  state: ClimateState;
  house: House;
  units: UnitSystem;
  dataMode: "demo" | "real" | "unknown";
  readOnly?: boolean;
  onLoadSeries: (sensorId: string, metric: Metric, range: TimeRange, forecastSupported: boolean) => void;
}

interface ContinuityRow {
  id: string;
  source: string;
  metric: string;
  startedAt: number;
  endedAt: number;
  state: SensorDataGap["recoveryState"] | "visible";
  recoveredPoints: number;
  detail: string | null;
}

type QualityPreset = "good" | "reliable" | "all";
type AnalyticsTool = "performance" | "openings" | "sensors";

const ANALYTICS_RESOLUTIONS = ["auto", "raw", "1m", "5m", "15m", "30m", "1h", "1d"] as const satisfies readonly AnalyticsResolution[];
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

interface AnalyticsLocationState {
  range: TimeRange;
  resolution: AnalyticsResolution;
  aggregation: AnalyticsAggregation;
  qualityPreset: QualityPreset;
  metric: Metric;
  selectedSensorIds: string[] | null;
  weatherObservationsVisible: boolean;
  weatherForecastVisible: boolean;
}

function analyticsToolsFromLocation(): AnalyticsTool[] {
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

function writeAnalyticsToolsToLocation(tools: ReadonlySet<AnalyticsTool>): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const ordered = ANALYTICS_TOOLS.filter((tool) => tools.has(tool));
  if (ordered.length > 0) url.searchParams.set("tools", ordered.join(","));
  else url.searchParams.delete("tools");
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) window.history.pushState(window.history.state, "", next);
}

function evidenceIsDeepLinked(): boolean {
  return typeof window !== "undefined" && window.location.hash === "#evidence";
}

function defaultAnalyticsMetric(metricIds: readonly Metric[]): Metric {
  return metricIds.includes("temperature") ? "temperature" : metricIds[0] ?? "temperature";
}

function analyticsStateFromLocation(metricIds: readonly Metric[], sensorIds: readonly string[]): AnalyticsLocationState {
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
    ? [...new Set(requestedSensors.split(",").filter((sensorId) => sensorIds.includes(sensorId)))].sort()
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

function writeAnalyticsStateToLocation(state: AnalyticsLocationState, mode: "push" | "replace", defaultMetric: Metric): void {
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
  else url.searchParams.set("sensors", [...new Set(state.selectedSensorIds)].sort().join(","));
  const weather = state.weatherObservationsVisible
    ? state.weatherForecastVisible ? null : "observations"
    : state.weatherForecastVisible ? "forecast" : "none";
  if (weather) url.searchParams.set("weather", weather);
  else url.searchParams.delete("weather");
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) window.history[`${mode}State`](window.history.state, "", next);
}

function aggregationOptions(definition: MeasurementDefinition | undefined): AnalyticsAggregation[] {
  const kind = definition?.kind ?? "gauge";
  if (kind === "rate") return ["default", "time_weighted_mean", "mean", "last", "min", "max"];
  if (kind === "increment") return ["default", "sum", "last", "min", "max"];
  if (kind === "cumulative_counter") return ["default", "delta", "last", "min", "max"];
  if (kind === "binary_state") return ["default", "last", "mean"];
  if (kind === "categorical_state") return ["default", "last"];
  return ["default", "mean", "last", "min", "max"];
}

function qualitiesForPreset(preset: QualityPreset): AnalyticsSampleQuality[] {
  if (preset === "good") return ["good"];
  if (preset === "reliable") return ["good", "estimated"];
  return ["good", "estimated", "stale"];
}

function analyticsPointBudget(range: TimeRange): number {
  if (range === "30d") return 1_000;
  if (range === "90d") return 2_500;
  if (range === "1y") return 1_000;
  return 500;
}

function analyticsIdentityToken(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(36)}${(right >>> 0).toString(36)}`;
}

function durationLabel(milliseconds: number, locale: string): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "short" }).format(minutes);
  const hours = minutes / 60;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: hours < 10 ? 1 : 0, style: "unit", unit: "hour", unitDisplay: "short" }).format(hours);
}

export function analyticsCsv(result: AnalyticsQueryResponse): string {
  const rows: Array<Array<string | number>> = [[
    "api_version", "data_mode", "request_id", "timezone", "range_start", "range_end", "generated_at",
    "series", "entity_id", "measurement", "timestamp", "value", "unit", "truth_class", "aggregation",
    "resolution", "quality_filter", "excluded_source_samples", "coverage", "sample_count", "quality_flags", "algorithm", "algorithm_version",
  ]];
  for (const series of result.series) {
    for (const point of series.points) {
      rows.push([
        result.apiVersion, result.dataMode, result.requestId, result.resolvedRange.timezone, result.resolvedRange.start,
        result.resolvedRange.end, result.generatedAt, series.entityLabel, series.entityId, series.measurementId, point.timestamp,
        point.value ?? "", series.canonicalUnit, series.truthClass, series.aggregation, series.resolution,
        result.quality.includedQualities.join("|"), result.quality.excludedSampleCount,
        point.coverage, point.sampleCount, point.qualityFlags.join("|"),
        series.provenance.algorithmKey, series.provenance.algorithmVersion,
      ]);
    }
  }
  return csvDocument(rows);
}

function downloadText(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function DataAnalyticsPage(props: Readonly<DataAnalyticsPageProps>) {
  const { locale, t } = useI18n();
  const now = useNow();
  const sensors = useMemo(
    () => props.state.sensors.filter((sensor) => sensor.houseId === props.house.id),
    [props.house.id, props.state.sensors],
  );
  const definitions = useMemo(() => props.state.measurementDefinitions.filter((definition) => definition.enabled), [props.state.measurementDefinitions]);
  const metricIds = definitions.map((definition) => definition.id);
  const sensorIds = sensors.map((sensor) => sensor.id);
  const metricIdsKey = metricIds.join("\u0000");
  const sensorIdsKey = sensorIds.join("\u0000");
  const defaultMetric = defaultAnalyticsMetric(metricIds);
  const initialLocationState = analyticsStateFromLocation(metricIds, sensorIds);
  const [metric, setMetric] = useState<Metric>(initialLocationState.metric);
  const [selectedSensorIds, setSelectedSensorIds] = useState<string[] | null>(initialLocationState.selectedSensorIds);
  const [weatherObservationsVisible, setWeatherObservationsVisible] = useState(initialLocationState.weatherObservationsVisible);
  const [weatherForecastVisible, setWeatherForecastVisible] = useState(initialLocationState.weatherForecastVisible);
  const [range, setRange] = useState<TimeRange>(initialLocationState.range);
  const [resolution, setResolution] = useState<AnalyticsResolution>(initialLocationState.resolution);
  const [aggregation, setAggregation] = useState<AnalyticsAggregation>(initialLocationState.aggregation);
  const [qualityPreset, setQualityPreset] = useState<QualityPreset>(initialLocationState.qualityPreset);
  const [outdoorHistory, setOutdoorHistory] = useState<OutdoorTemperatureSample[]>([]);
  const [electricityPrices, setElectricityPrices] = useState<HomeElectricityPricePoint[]>([]);
  const [sensorGaps, setSensorGaps] = useState<SensorDataGap[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [analytics, setAnalytics] = useState<AnalyticsQueryResponse | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [chartForecasts, setChartForecasts] = useState<MeasurementForecasts>({});
  const forecastCache = useRef(new Map<string, { expiresAt: number; points: MeasurementForecastPoint[] }>());
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [openTools, setOpenTools] = useState<Set<AnalyticsTool>>(() => new Set(analyticsToolsFromLocation()));
  const [isolationOpen, setIsolationOpen] = useState(false);
  const [moistureOpen, setMoistureOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(evidenceIsDeepLinked);
  const [continuityOpen, setContinuityOpen] = useState(false);
  const historyIdentity = useRef<string | null>(null);
  const analyticsIdentity = useRef<string | null>(null);
  const weather = useHouseWeather(props.house);
  const selectedDefinition = definitions.find((definition) => definition.id === metric) ?? definitions[0];
  const availableAggregations = useMemo(() => aggregationOptions(selectedDefinition), [selectedDefinition]);
  const metricSensors = useMemo(() => sensors.filter((sensor) => (
    Boolean(props.state.latestMeasurements[sensor.id]?.[metric])
      || (props.state.measurementHistory[sensor.id]?.[metric]?.length ?? 0) > 0
      || Boolean(sensor.measurementEntityIds?.[metric])
      || Boolean(sensor.recordedMeasurementIds?.includes(metric))
      || (metric === "temperature" && Boolean(sensor.temperatureEntityId))
      || (metric === "humidity" && Boolean(sensor.humidityEntityId))
      || sensorGaps.some((gap) => gap.sensorId === sensor.id && gap.metric === metric)
  )), [metric, props.state.latestMeasurements, props.state.measurementHistory, sensorGaps, sensors]);
  const selectedSensors = useMemo(() => selectedSensorIds === null
    ? metricSensors.filter((sensor) => sensor.enabled)
    : metricSensors.filter((sensor) => selectedSensorIds.includes(sensor.id)), [metricSensors, selectedSensorIds]);
  const selectedSensorKey = selectedSensors.map((sensor) => sensor.id).sort().join("\u0000");
  const sensorsOpen = openTools.has("sensors");
  const sensorRecoveryErrors = [...new Set([historyError, analyticsError]
    .filter((detail): detail is string => Boolean(detail)))];
  const auxiliaryHistoryVisible = sensorsOpen || continuityOpen;
  const analyticsNeeded = sensorsOpen || evidenceOpen || continuityOpen;
  const analyticsDataMode = props.dataMode === "real" ? "live" : "demo";
  const forecastCacheScope = [props.dataMode, props.house.id, refreshRevision, selectedSensorKey].join("\u0001");
  const analyticsBatchIdentity = [
    forecastCacheScope,
    metric,
    range,
    resolution,
    aggregation,
    qualityPreset,
    props.house.timezone,
  ].join("\u0001");
  const analyticsRequestId = `explorer-${analyticsIdentityToken(analyticsBatchIdentity)}`;
  const analyticsRetentionIdentity = [
    props.dataMode,
    props.house.id,
    selectedSensorKey,
    metric,
    range,
    resolution,
    aggregation,
    qualityPreset,
    props.house.timezone,
  ].join("\u0001");

  const writeLocationPatch = (patch: Partial<AnalyticsLocationState>, mode: "push" | "replace") => {
    const current = analyticsStateFromLocation(metricIds, sensorIds);
    writeAnalyticsStateToLocation({ ...current, ...patch }, mode, defaultMetric);
  };

  const toggleTool = (tool: AnalyticsTool, open: boolean) => {
    if (openTools.has(tool) === open) return;
    const next = new Set(openTools);
    if (open) next.add(tool);
    else next.delete(tool);
    setOpenTools(next);
    writeAnalyticsToolsToLocation(next);
  };

  useEffect(() => {
    const expectedPathname = window.location.pathname;
    const restoreState = () => {
      if (window.location.pathname !== expectedPathname) return;
      const next = analyticsStateFromLocation(metricIds, sensorIds);
      setMetric(next.metric);
      setSelectedSensorIds(next.selectedSensorIds);
      setWeatherObservationsVisible(next.weatherObservationsVisible);
      setWeatherForecastVisible(next.weatherForecastVisible);
      setRange(next.range);
      setResolution(next.resolution);
      setAggregation(next.aggregation);
      setQualityPreset(next.qualityPreset);
      setOpenTools(new Set(analyticsToolsFromLocation()));
      setEvidenceOpen(evidenceIsDeepLinked());
      writeAnalyticsStateToLocation(next, "replace", defaultMetric);
    };
    restoreState();
    window.addEventListener("popstate", restoreState);
    return () => window.removeEventListener("popstate", restoreState);
  }, [defaultMetric, metricIdsKey, props.house.id, sensorIdsKey]);

  const selectRange = (next: TimeRange) => {
    setRange(next);
    writeLocationPatch({ range: next }, "push");
  };
  const selectResolution = (next: AnalyticsResolution) => {
    const nextAggregation = next === "raw" ? "default" : aggregation;
    setResolution(next);
    setAggregation(nextAggregation);
    writeLocationPatch({ resolution: next, aggregation: nextAggregation }, "push");
  };
  const selectAggregation = (next: AnalyticsAggregation) => {
    setAggregation(next);
    writeLocationPatch({ aggregation: next }, "push");
  };
  const selectQualityPreset = (next: QualityPreset) => {
    setQualityPreset(next);
    writeLocationPatch({ qualityPreset: next }, "push");
  };
  const selectMetric = (next: Metric) => {
    setMetric(next);
    writeLocationPatch({ metric: next }, "push");
  };
  const selectSensors = (next: string[] | null) => {
    setSelectedSensorIds(next);
    writeLocationPatch({ selectedSensorIds: next }, "push");
  };
  const selectWeatherObservationsVisible = (next: boolean) => {
    setWeatherObservationsVisible(next);
    writeLocationPatch({ weatherObservationsVisible: next }, "push");
  };
  const selectWeatherForecastVisible = (next: boolean) => {
    setWeatherForecastVisible(next);
    writeLocationPatch({ weatherForecastVisible: next }, "push");
  };

  useEffect(() => {
    if (selectedDefinition && selectedDefinition.id !== metric) {
      setMetric(selectedDefinition.id);
      writeLocationPatch({ metric: selectedDefinition.id }, "replace");
    }
  }, [defaultMetric, metric, selectedDefinition]);

  useEffect(() => {
    if (!availableAggregations.includes(aggregation)) {
      setAggregation("default");
      writeLocationPatch({ aggregation: "default" }, "replace");
    }
  }, [aggregation, availableAggregations, qualityPreset, range, resolution]);

  useEffect(() => {
    if (selectedSensorIds === null) return;
    const available = new Set(metricSensors.map((sensor) => sensor.id));
    const valid = selectedSensorIds.filter((sensorId) => available.has(sensorId));
    const defaultIds = metricSensors.filter((sensor) => sensor.enabled).map((sensor) => sensor.id);
    const isDefault = valid.length === defaultIds.length && valid.every((sensorId) => defaultIds.includes(sensorId));
    if (isDefault) {
      setSelectedSensorIds(null);
      writeLocationPatch({ selectedSensorIds: null }, "replace");
    } else if (valid.length !== selectedSensorIds.length) {
      const next = valid.length > 0 || selectedSensorIds.length === 0 ? valid : null;
      setSelectedSensorIds(next);
      writeLocationPatch({ selectedSensorIds: next }, "replace");
    }
  }, [metricSensors, selectedSensorIds]);

  useEffect(() => {
    if (!auxiliaryHistoryVisible) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const to = new Date();
    const from = new Date(to.getTime() - timeRangeHours(range) * 3_600_000);
    const identity = `${props.house.id}\u0000${range}`;
    if (historyIdentity.current !== identity) {
      historyIdentity.current = identity;
      setOutdoorHistory([]);
      setElectricityPrices([]);
      setSensorGaps([]);
      setHistoryError(null);
      setHistoryLoaded(false);
    }
    setLoading(true);
    const outdoorRequest = api.outdoorTemperatureHistory(
      props.house.id, from.toISOString(), to.toISOString(), 100_000, controller.signal,
    ).then((outdoor) => {
      if (!controller.signal.aborted) setOutdoorHistory(outdoor.samples);
    });
    const gapsRequest = api.sensorDataGaps(props.house.id, 500, controller.signal).then((gaps) => {
      if (!controller.signal.aborted) setSensorGaps(gaps);
    });
    const pricesRequest = api.houseElectricityPrice(
      props.house.id,
      from.toISOString(),
      new Date(to.getTime() + 48 * 3_600_000).toISOString(),
      controller.signal,
    ).then((prices) => {
      if (!controller.signal.aborted) {
        setElectricityPrices(prices.prices ?? (prices.current ? [prices.current] : []));
      }
    });
    Promise.allSettled([outdoorRequest, gapsRequest, pricesRequest]).then(([outdoor, gaps, prices]) => {
      if (controller.signal.aborted) return;
      const failure = outdoor.status === "rejected"
        ? outdoor.reason
        : gaps.status === "rejected" ? gaps.reason : prices.status === "rejected" ? prices.reason : null;
      setHistoryError(failure === null
        ? null
        : failure instanceof Error ? failure.message : t("analytics.loadFailed"));
      setHistoryLoaded(true);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [auxiliaryHistoryVisible, props.house.id, range, refreshRevision, t]);

  const refresh = useCallback(() => {
    setRefreshRevision((value) => value + 1);
    void weather.refresh();
  }, [weather.refresh]);

  const fromMs = now - timeRangeHours(range) * 3_600_000;
  useEffect(() => {
    if (analyticsIdentity.current !== analyticsRetentionIdentity) {
      analyticsIdentity.current = analyticsRetentionIdentity;
      setAnalytics(null);
    }
    if (!analyticsNeeded || props.dataMode === "unknown" || !selectedDefinition || selectedSensors.length === 0) {
      setAnalyticsError(null);
      setAnalyticsLoading(false);
      return;
    }
    const controller = new AbortController();
    const end = new Date();
    const start = new Date(end.getTime() - timeRangeHours(range) * 3_600_000);
    setAnalyticsLoading(true);
    setAnalyticsError(null);
    void api.analyticsQuery({
      apiVersion: "1.0",
      dataMode: analyticsDataMode,
      scope: { kind: "house", id: props.house.id, entityIds: selectedSensors.map((sensor) => sensor.id) },
      measurementIds: [metric],
      range: { start: start.toISOString(), end: end.toISOString(), timezone: props.house.timezone },
      resolution,
      aggregation: resolution === "raw" ? "default" : aggregation,
      qualityFilter: { include: qualitiesForPreset(qualityPreset) },
      include: ["series", "summary", "quality", "provenance"],
      maxPointsPerSeries: analyticsPointBudget(range),
      requestId: analyticsRequestId,
    }, controller.signal).then((result) => {
      if (!controller.signal.aborted) setAnalytics(result);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setAnalyticsError(error instanceof Error ? error.message : t("analytics.queryFailed"));
    }).finally(() => {
      if (!controller.signal.aborted) setAnalyticsLoading(false);
    });
    return () => controller.abort();
  }, [aggregation, analyticsDataMode, analyticsNeeded, analyticsRequestId, analyticsRetentionIdentity, metric, props.dataMode, props.house.id, props.house.timezone, qualityPreset, range, refreshRevision, resolution, selectedDefinition, selectedSensorKey, t]);

  useEffect(() => {
    forecastCache.current.clear();
    setChartForecasts({});
  }, [forecastCacheScope]);

  useEffect(() => {
    if (!sensorsOpen || !analytics || analytics.requestId !== analyticsRequestId || !selectedDefinition?.forecastSupported) {
      setChartForecasts({});
      return;
    }
    const controller = new AbortController();
    void (async () => {
      const forecasts: MeasurementForecasts = {};
      const queue = selectedSensors.filter((sensor) => sensor.enabled);
      let cursor = 0;
      const worker = async () => {
        while (!controller.signal.aborted) {
          const sensor = queue[cursor++];
          if (!sensor) return;
          const cacheKey = `${forecastCacheScope}\u0000${sensor.id}\u0000${selectedDefinition.id}`;
          const cached = forecastCache.current.get(cacheKey);
          if (cached && cached.expiresAt > Date.now()) {
            forecasts[sensor.id] = { [selectedDefinition.id]: cached.points };
            continue;
          }
          try {
            const points = await api.measurementForecast(sensor.id, selectedDefinition.id, 12, controller.signal);
            if (controller.signal.aborted) return;
            forecastCache.current.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, points });
            forecasts[sensor.id] = { [selectedDefinition.id]: points };
          } catch {
            if (controller.signal.aborted) return;
            // Forecasts are optional supporting evidence; observed history remains usable.
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, queue.length) }, worker));
      if (!controller.signal.aborted) setChartForecasts(forecasts);
    })();
    return () => controller.abort();
  }, [analytics?.requestId, analyticsRequestId, forecastCacheScope, selectedDefinition?.forecastSupported, selectedDefinition?.id, selectedSensorKey, sensorsOpen]);
  const thresholdMs = chartGapThresholdMs(range);
  const visibleSensorGaps = useMemo(() => selectedSensors.flatMap((sensor) => {
    if (!sensor.enabled) return [];
    if (!analytics) return [];
    const points = observedSeries(sensor.id, metric, props.state.measurementHistory,
      props.state.latestMeasurements, fromMs, analytics.series, analytics.resolvedRange.end);
    return detectSeriesGaps(points, thresholdMs, { startedAt: fromMs, endedAt: now })
      .map((gap) => ({ sensor, gap }));
  }), [analytics, fromMs, metric, now, props.state.measurementHistory, props.state.latestMeasurements, selectedSensors, thresholdMs]);
  const visibleOutdoorGaps = useMemo(() => detectSeriesGaps(
    outdoorHistory.flatMap((sample) => {
      const timestamp = Date.parse(sample.timestamp);
      return Number.isFinite(timestamp) && timestamp >= fromMs ? [{ timestamp }] : [];
    }).sort((left, right) => left.timestamp - right.timestamp),
    thresholdMs,
    { startedAt: fromMs, endedAt: now },
  ), [fromMs, now, outdoorHistory, thresholdMs]);
  const relevantOutdoorGaps = metric === "temperature" && weatherObservationsVisible ? visibleOutdoorGaps : [];

  const continuityRows = useMemo<ContinuityRow[]>(() => {
    const durable = sensorGaps.flatMap((gap) => {
      if (gap.metric !== metric) return [];
      const startedAt = Math.max(fromMs, Date.parse(gap.startedAt));
      const endedAt = Math.min(now, Date.parse(gap.endedAt ?? new Date(now).toISOString()));
      const sensor = selectedSensors.find((candidate) => candidate.id === gap.sensorId);
      if (!sensor || !Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt) return [];
      const intervals = gap.recoveryState === "complete" ? [{ startedAt, endedAt }]
        : visibleSensorGaps.filter((hole) => hole.sensor.id === gap.sensorId
          && hole.gap.startedAt < endedAt && hole.gap.endedAt > startedAt)
          .map((hole) => ({ startedAt: Math.max(startedAt, hole.gap.startedAt), endedAt: Math.min(endedAt, hole.gap.endedAt) }));
      return intervals.map((interval, index) => ({
        id: `sensor-gap-${gap.id}-${index}`,
        source: sensor.name,
        metric: selectedDefinition ? measurementLabel(selectedDefinition, locale) : gap.metric,
        ...interval,
        state: gap.recoveryState === "open" && interval.endedAt < now ? "visible" as const : gap.recoveryState,
        recoveredPoints: gap.recoveredPoints,
        detail: gap.recoveryError,
      }));
    });
    const visibleSensors = visibleSensorGaps.flatMap(({ sensor, gap }, index) => {
      const recorded = sensorGaps.some((candidate) => {
        if (candidate.sensorId !== sensor.id || candidate.metric !== metric || candidate.recoveryState === "complete") return false;
        const candidateStart = Date.parse(candidate.startedAt);
        const candidateEnd = Date.parse(candidate.endedAt ?? new Date(now).toISOString());
        return Number.isFinite(candidateStart) && Number.isFinite(candidateEnd)
          && candidateStart < gap.endedAt && candidateEnd > gap.startedAt;
      });
      return recorded ? [] : [{
        id: `visible-sensor-gap-${sensor.id}-${gap.startedAt}-${index}`,
        source: sensor.name,
        metric: selectedDefinition ? measurementLabel(selectedDefinition, locale) : metric,
        startedAt: gap.startedAt,
        endedAt: gap.endedAt,
        state: "visible" as const,
        recoveredPoints: 0,
        detail: null,
      }];
    });
    const outdoor = relevantOutdoorGaps.map((gap, index) => ({
      id: `outdoor-gap-${gap.startedAt}-${index}`,
      source: t("decision.outdoor"),
      metric: t("analytics.weatherObservation"),
      startedAt: gap.startedAt,
      endedAt: gap.endedAt,
      state: "visible" as const,
      recoveredPoints: 0,
      detail: null,
    }));
    return [...durable, ...visibleSensors, ...outdoor].sort((left, right) => right.startedAt - left.startedAt);
  }, [fromMs, locale, metric, now, relevantOutdoorGaps, selectedDefinition, selectedSensors, sensorGaps, t, visibleSensorGaps]);
  const showTpLinkImportHelp = useMemo(() => sensorGaps.some((gap) => {
    if (gap.source !== "tp-link" || gap.metric !== metric
      || (gap.recoveryState !== "not-supported" && gap.recoveryState !== "partial")) return false;
    const endedAt = Date.parse(gap.endedAt ?? new Date(now).toISOString());
    return selectedSensors.some((sensor) => sensor.id === gap.sensorId) && Number.isFinite(endedAt) && endedAt >= fromMs;
  }), [fromMs, metric, now, selectedSensors, sensorGaps]);
  const visibleGapCount = continuityRows.filter((row) => row.state !== "complete").length;

  return (
    <>
      <header className="page-heading analytics-page-heading">
        <div><span className="eyebrow"><ChartLine size={14} aria-hidden="true" />{t("analytics.eyebrow")}</span><h1>{t("analytics.title")}</h1><p>{t("analytics.description")}</p></div>
        <button type="button" className="secondary-button" onClick={refresh} disabled={loading || analyticsLoading}><RefreshCw className={loading || analyticsLoading ? "spin" : ""} size={15} aria-hidden="true" />{t("common.refresh")}</button>
      </header>

      <DailyAnalyticsFindings
        house={props.house}
        definitions={props.state.measurementDefinitions}
        units={props.units}
        refreshRevision={refreshRevision}
      />

      <DataExportPanel
        state={props.state}
        house={props.house}
        units={props.units}
        dataMode={props.dataMode}
      />

      <section className="analytics-primary-tools" aria-labelledby="analytics-primary-tools-title">
        <div className="analytics-tools-intro">
          <h2 id="analytics-primary-tools-title">{t("analytics.toolsTitle")}</h2>
          <p>{t("analytics.toolsDescription")}</p>
        </div>
        <div className="analytics-tool-stack">
          <details className="analytics-tool analytics-primary-tool" open={openTools.has("performance")} onToggle={(event) => toggleTool("performance", event.currentTarget.open)}>
            <summary>
              <span className="analytics-tool-icon"><Gauge size={18} aria-hidden="true" /></span>
              <span className="analytics-tool-copy"><strong>{t("performance.title")}</strong><small>{t("performance.description")}</small></span>
              <ChevronDown className="analytics-tool-chevron" size={18} aria-hidden="true" />
            </summary>
            {openTools.has("performance") && <div className="analytics-primary-tool-content">
              <HomePerformancePanel
                house={props.house}
                definitions={props.state.measurementDefinitions}
                dataMode={props.dataMode}
                refreshRevision={refreshRevision}
                canRefresh={!props.readOnly}
                embedded
              />
            </div>}
          </details>

          <details className="analytics-tool analytics-primary-tool" open={openTools.has("openings")} onToggle={(event) => toggleTool("openings", event.currentTarget.open)}>
            <summary>
              <span className="analytics-tool-icon"><DoorOpen size={18} aria-hidden="true" /></span>
              <span className="analytics-tool-copy"><strong>{t("analytics.openingTitle")}</strong><small>{t("analytics.openingDescription")}</small></span>
              <ChevronDown className="analytics-tool-chevron" size={18} aria-hidden="true" />
            </summary>
            {openTools.has("openings") && <div className="analytics-primary-tool-content">
              <OpeningAnalyticsPanel
                house={props.house}
                dataMode={props.dataMode}
                range={range}
                refreshRevision={refreshRevision}
                {...(props.state.latestOpeningStateObservation?.houseId === props.house.id
                  ? { liveObservationId: props.state.latestOpeningStateObservation.id }
                  : {})}
                onRange={selectRange}
              />
            </div>}
          </details>

          <details className="analytics-tool analytics-primary-tool" open={openTools.has("sensors")} onToggle={(event) => toggleTool("sensors", event.currentTarget.open)}>
            <summary>
              <span className="analytics-tool-icon"><ChartLine size={18} aria-hidden="true" /></span>
              <span className="analytics-tool-copy"><strong>{t("sensors.analyticsTitle")}</strong><small>{t("sensors.analyticsDescription")}</small></span>
              <ChevronDown className="analytics-tool-chevron" size={18} aria-hidden="true" />
            </summary>
            {openTools.has("sensors") && <div className="analytics-primary-tool-content">
              {sensorRecoveryErrors.length > 0 && <p className="inline-error" role="alert">
                <span>{t("chart.loadError")}</span>
                {sensorRecoveryErrors.map((detail) => <span key={detail}><br />{detail}</span>)}
              </p>}
              {definitions.length > 0 && sensors.length > 0 ? <SensorAnalyticsChart
                houseId={props.house.id}
                dataMode={props.dataMode}
                sensors={metricSensors}
                history={props.state.measurementHistory}
                forecasts={chartForecasts}
                analyticsSeries={analytics?.series ?? null}
                analyticsRangeEnd={analytics?.resolvedRange.end ?? null}
                loading={analyticsLoading}
                latestMeasurements={props.state.latestMeasurements}
                definitions={definitions}
                outdoorHistory={outdoorHistory}
                weather={weather.weather}
                electricityPrices={electricityPrices}
                sensorGaps={sensorGaps}
                metric={metric}
                units={props.units}
                range={range}
                timeZone={props.house.timezone}
                selectedSensorIds={selectedSensorIds}
                weatherObservationsVisible={weatherObservationsVisible}
                weatherForecastVisible={weatherForecastVisible}
                onMetric={selectMetric}
                onRange={selectRange}
                onSensors={selectSensors}
                onWeatherObservationsVisible={selectWeatherObservationsVisible}
                onWeatherForecastVisible={selectWeatherForecastVisible}
              /> : <div className="empty-state">{t("common.noData")}</div>}
            </div>}
          </details>
        </div>
      </section>

      <div className="analytics-tool-stack">
        <details className="analytics-tool" onToggle={(event) => setIsolationOpen(event.currentTarget.open)}>
          <summary>
            <span className="analytics-tool-icon"><ShieldCheck size={18} aria-hidden="true" /></span>
            <span className="analytics-tool-copy"><strong>{t("isolation.title")}</strong><small>{t("isolation.description")}</small></span>
            <ChevronDown className="analytics-tool-chevron" size={18} aria-hidden="true" />
          </summary>
          {isolationOpen && <ThermalIsolationPanel house={props.house} units={props.units} dataMode={props.dataMode} canRefresh={!props.readOnly} embedded />}
        </details>

        <details className="analytics-tool" onToggle={(event) => setMoistureOpen(event.currentTarget.open)}>
          <summary>
            <span className="analytics-tool-icon"><Droplets size={18} aria-hidden="true" /></span>
            <span className="analytics-tool-copy"><strong>{t("moisture.title")}</strong><small>{t("moisture.description")}</small></span>
            <ChevronDown className="analytics-tool-chevron" size={18} aria-hidden="true" />
          </summary>
          {moistureOpen && <MoistureResponsePanel house={props.house} dataMode={props.dataMode} canRefresh={!props.readOnly} embedded />}
        </details>

        <details className="analytics-tool analytics-evidence-tool" open={evidenceOpen} onToggle={(event) => setEvidenceOpen(event.currentTarget.open)}>
          <summary>
            <span className="analytics-tool-icon"><Table2 size={18} aria-hidden="true" /></span>
            <span className="analytics-tool-copy"><strong id="analytics-evidence-title">{t("analytics.evidenceTitle")}</strong><small>{t("analytics.evidenceDescription")}</small></span>
            {analytics && <span className={`analytics-coverage ${analytics.quality.coverage < 0.75 ? "warning" : "healthy"}`}>{t("analytics.coverage", { percent: Math.round(analytics.quality.coverage * 100) })}</span>}
            <ChevronDown className="analytics-tool-chevron" size={18} aria-hidden="true" />
          </summary>
          <section className="analytics-evidence-panel analytics-tool-content" aria-labelledby="analytics-evidence-title">
          {analytics && <div className="analytics-export-actions">
            <button type="button" className="secondary-button" onClick={() => downloadText(
              `stugu-${metric}-${range}.csv`, analyticsCsv(analytics), "text/csv;charset=utf-8",
            )}><Download size={14} aria-hidden="true" />{t("analytics.exportCsv")}</button>
            <button type="button" className="secondary-button" onClick={() => downloadText(
              `stugu-${metric}-${range}.json`, JSON.stringify(analytics, null, 2), "application/json;charset=utf-8",
            )}><FileJson size={14} aria-hidden="true" />{t("analytics.exportJson")}</button>
          </div>}
        <div className="analytics-query-controls" role="group" aria-label={t("analytics.queryControls")}>
          <label className="field"><span>{t("analytics.resolution")}</span><select value={resolution} onChange={(event) => selectResolution(event.target.value as AnalyticsResolution)}>
            {ANALYTICS_RESOLUTIONS.map((option) => <option key={option} value={option}>{t(`analytics.resolution_${option}`)}</option>)}
          </select></label>
          <label className="field"><span>{t("analytics.aggregation")}</span><select value={resolution === "raw" ? "default" : aggregation} disabled={resolution === "raw"} onChange={(event) => selectAggregation(event.target.value as AnalyticsAggregation)}>
            {availableAggregations.map((option) => <option key={option} value={option}>{t(`analytics.aggregation_${option}`)}</option>)}
          </select></label>
          <label className="field"><span>{t("analytics.qualityFilter")}</span><select value={qualityPreset} onChange={(event) => selectQualityPreset(event.target.value as QualityPreset)}>
            <option value="good">{t("analytics.quality_good")}</option>
            <option value="reliable">{t("analytics.quality_reliable")}</option>
            <option value="all">{t("analytics.quality_all")}</option>
          </select></label>
        </div>
        {analyticsLoading && <output className="analytics-query-status">{t("analytics.calculating")}</output>}
        {analyticsError && !sensorsOpen && <p className="inline-error" role="status">{analytics
          ? <><span>{t("chart.loadError")}</span><br /><span>{analyticsError}</span></>
          : analyticsError}</p>}
        {analytics && selectedDefinition && <>
          {analytics.warnings.length > 0 && <ul className="analytics-query-warnings">{analytics.warnings.map((warning) => <li key={warning.code}>{warning.message}</li>)}</ul>}
          <div className="analytics-summary-grid">{analytics.summaries.map((summary) => {
            const matchingSeries = analytics.series.find((series) => series.entityId === summary.entityId && series.measurementId === summary.measurementId);
            const label = matchingSeries?.entityLabel ?? summary.entityId;
            return <article key={`${summary.entityId}-${summary.measurementId}`} className="analytics-summary-card">
              <div className="analytics-summary-title"><strong>{label}</strong>{matchingSeries && <span className={`analytics-truth-class ${matchingSeries.truthClass}`}>{t(`analytics.truth_${matchingSeries.truthClass}`)}</span>}</div>
              <dl>
                <div><dt>{t("analytics.median")}</dt><dd>{summary.median === null ? "—" : formatMeasurement(summary.median, selectedDefinition, props.units)}</dd></div>
                <div><dt>{t("analytics.minimum")}</dt><dd>{summary.minimum === null ? "—" : formatMeasurement(summary.minimum, selectedDefinition, props.units)}</dd></div>
                <div><dt>{t("analytics.maximum")}</dt><dd>{summary.maximum === null ? "—" : formatMeasurement(summary.maximum, selectedDefinition, props.units)}</dd></div>
                <div><dt>{t("analytics.coverageLabel")}</dt><dd>{Math.round(summary.coverage * 100)}%</dd></div>
              </dl>
              <small>{t("analytics.sampleCount", { count: summary.count })}</small>
            </article>;
          })}</div>
          <details className="analytics-data-details">
            <summary>{t("analytics.showDataTable", { count: analytics.series.reduce((sum, series) => sum + series.points.length, 0) })}</summary>
            <div className="analytics-data-table-wrap" role="region" aria-label={t("analytics.dataTable")} tabIndex={0}><table className="analytics-data-table">
              <thead><tr><th scope="col">{t("analytics.series")}</th><th scope="col">{t("analytics.timestamp")}</th><th scope="col">{t("analytics.value")}</th><th scope="col">{t("analytics.coverageLabel")}</th><th scope="col">{t("analytics.quality")}</th></tr></thead>
              <tbody>{analytics.series.flatMap((series) => series.points.map((point) => <tr key={`${series.entityId}-${series.measurementId}-${point.timestamp}`}>
                <th scope="row">{series.entityLabel}</th>
                <td><time dateTime={point.timestamp}>{formatInTimeZone(point.timestamp, locale, props.house.timezone, { dateStyle: "medium", timeStyle: "short" })}</time></td>
                <td>{point.value === null ? "—" : formatMeasurement(point.value, selectedDefinition, props.units)}</td>
                <td>{Math.round(point.coverage * 100)}%</td>
                <td>{point.qualityFlags.length > 0 ? point.qualityFlags.map((flag) => flag.replaceAll("_", " ")).join(", ") : t("analytics.qualityGood")}</td>
              </tr>))}</tbody>
            </table></div>
          </details>
          <p className="analytics-provenance-note">{t("analytics.provenance", {
            resolution: analytics.resolution,
            aggregation: analytics.series[0]?.aggregation ?? "—",
            version: analytics.provenance[0]?.algorithmVersion ?? "—",
          })}</p>
        </>}
        {!analyticsLoading && !analytics && !analyticsError && <p className="analytics-no-gaps">{t("analytics.noEvidence")}</p>}
          </section>
        </details>

        <details className="analytics-tool analytics-continuity-tool" open={continuityOpen} onToggle={(event) => setContinuityOpen(event.currentTarget.open)}>
          <summary>
            <span className="analytics-tool-icon"><Database size={18} aria-hidden="true" /></span>
            <span className="analytics-tool-copy"><strong id="analytics-continuity-title">{t("analytics.continuityTitle")}</strong><small>{t("analytics.continuityDescription")}</small></span>
            {historyLoaded && (analytics || analyticsError) && historyIdentity.current === `${props.house.id}\u0000${range}` && <span className={`analytics-gap-count ${historyError || analyticsError || visibleGapCount > 0 ? "warning" : "healthy"}`}><TriangleAlert size={14} aria-hidden="true" />{historyError || analyticsError ? t("analytics.continuityStale") : t("analytics.visibleGapCount", { count: visibleGapCount })}</span>}
            <ChevronDown className="analytics-tool-chevron" size={18} aria-hidden="true" />
          </summary>
          <section className="analytics-continuity-panel analytics-tool-content" aria-labelledby="analytics-continuity-title">
        {sensorRecoveryErrors.length > 0 && !sensorsOpen && <p className="inline-error" role="alert"><span>{t("chart.loadError")}</span><br /><span>{sensorRecoveryErrors.join(" · ")}</span></p>}
        {showTpLinkImportHelp && <aside className="analytics-gap-import-help">
          <FileSpreadsheet size={17} aria-hidden="true" />
          <p><strong>{t("analytics.tpLinkImportTitle")}</strong>{t("analytics.tpLinkImportHelp")}</p>
        </aside>}
        {!analytics && analyticsLoading ? <p className="analytics-no-gaps" role="status">{t("sensors.loadingData")}</p> : continuityRows.length > 0 ? <details className="analytics-gap-details"><summary>{t("analytics.showGapDetails", { count: continuityRows.length })}</summary><div className="analytics-gap-table-wrap" role="region" aria-label={t("analytics.continuityTitle")} tabIndex={0}><table className="analytics-gap-table">
          <thead><tr><th scope="col">{t("analytics.series")}</th><th scope="col">{t("sensors.analyticsMetric")}</th><th scope="col">{t("analytics.interval")}</th><th scope="col">{t("analytics.duration")}</th><th scope="col">{t("analytics.recovery")}</th></tr></thead>
          <tbody>{continuityRows.map((row) => <tr key={row.id}>
            <td>{row.source === t("decision.outdoor") && <CloudSun size={13} aria-hidden="true" />}{row.source}</td>
            <td>{row.metric}</td>
            <td><time>{formatInTimeZone(row.startedAt, locale, props.house.timezone, { weekday: "short", hour: "2-digit", minute: "2-digit" })}</time><span aria-hidden="true"> → </span><time>{formatInTimeZone(row.endedAt, locale, props.house.timezone, { weekday: "short", hour: "2-digit", minute: "2-digit" })}</time></td>
            <td>{durationLabel(row.endedAt - row.startedAt, locale)}</td>
            <td><span className={`analytics-recovery-state ${row.state}`}>{t(`analytics.recovery_${row.state}`)}</span>{row.recoveredPoints > 0 && <small>{t("analytics.recoveredPoints", { count: row.recoveredPoints })}</small>}{row.detail && <small>{row.detail}</small>}</td>
          </tr>)}</tbody>
        </table></div></details> : (analytics || selectedSensors.length === 0) && !loading && !analyticsError && !historyError ? <p className="analytics-no-gaps">{t("analytics.noRecordedGaps")}</p> : null}
          </section>
        </details>
      </div>
    </>
  );
}
