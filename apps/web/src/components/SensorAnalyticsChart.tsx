import { useId, useMemo, useState } from "react";
import { Activity, BrainCircuit, ChevronDown, CloudSun, GitCompareArrows, TriangleAlert, X } from "lucide-react";
import type {
  AnalyticsSeries,
  MeasurementDefinition,
  MeasurementForecastPoint,
  MeasurementSample,
  Metric,
  HouseWeather,
  HomeElectricityPricePoint,
  OutdoorTemperatureSample,
  Sensor,
  SensorDataGap,
  UnitSystem,
} from "@climate-twin/contracts";
import { ANALYTICS_TIME_RANGES, timeRangeHours, type TimeRange } from "../domain";
import { formatInTimeZone } from "../dateTime";
import { useI18n } from "../i18n";
import {
  displayUnit,
  formatMeasurement,
  formatMeasurementDelta,
  measurementDomain,
  measurementLabel,
  toDisplayValue,
  type LatestMeasurements,
  type MeasurementForecasts,
  type MeasurementHistory,
} from "../measurements";
import { useNow } from "../useNow";
import { chartGapThresholdMs } from "../chartGaps";
import { CalendarPeriodComparison } from "./CalendarPeriodComparison";
import { deriveSensorAnalyticsGapStatus } from "./sensorAnalyticsGaps";
import {
  SensorAnalyticsPlot,
  sensorDashes,
  type AggregateSeriesPoint,
  type ForecastSeriesPoint,
  type SeriesPoint,
} from "./SensorAnalyticsPlot";
import {
  sensorHistoryName,
  sensorHistoryState,
  withSensorHistoryState,
} from "./sensorHistoryLabels";

export type { AggregateSeriesPoint } from "./SensorAnalyticsPlot";

interface SensorAnalyticsChartProps {
  houseId: string;
  dataMode: "demo" | "real" | "unknown";
  sensors: Sensor[];
  history: MeasurementHistory;
  forecasts: MeasurementForecasts;
  analyticsSeries?: readonly AnalyticsSeries[] | null;
  analyticsRangeEnd?: string | null;
  loading?: boolean;
  latestMeasurements: LatestMeasurements;
  definitions: MeasurementDefinition[];
  outdoorHistory?: OutdoorTemperatureSample[];
  weather?: HouseWeather | null;
  electricityPrices?: HomeElectricityPricePoint[];
  sensorGaps?: SensorDataGap[];
  metric: Metric;
  units: UnitSystem;
  range: TimeRange;
  timeZone: string;
  selectedSensorIds: string[] | null;
  weatherObservationsVisible: boolean;
  weatherForecastVisible: boolean;
  onMetric: (metric: Metric) => void;
  onRange: (range: TimeRange) => void;
  onSensors: (sensorIds: string[] | null) => void;
  onWeatherObservationsVisible: (visible: boolean) => void;
  onWeatherForecastVisible: (visible: boolean) => void;
  onLoadSeries?: (sensorId: string, metric: Metric, range: TimeRange, forecastSupported: boolean) => void;
}

function SensorAnalyticsGapNotice({ title, description }: Readonly<{ title: string; description: string }>) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(true);
  if (!visible) return null;
  return <div className="sensor-analytics-gap-status" role="status">
    <TriangleAlert size={18} aria-hidden="true" />
    <span><strong>{title}</strong><small>{description}</small></span>
    <button type="button" className="icon-button small" onClick={() => setVisible(false)} aria-label={t("analytics.dismissGapNotice")}><X size={16} aria-hidden="true" /></button>
  </div>;
}

function bucketMilliseconds(range: TimeRange): number {
  if (range === "6h") return 5 * 60_000;
  if (range === "24h") return 15 * 60_000;
  if (range === "7d") return 2 * 60 * 60_000;
  if (range === "30d") return 6 * 60 * 60_000;
  if (range === "90d") return 12 * 60 * 60_000;
  return 2 * 24 * 60 * 60_000;
}

function validTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function observedSeries(
  sensorId: string,
  metric: Metric,
  history: MeasurementHistory,
  latestMeasurements: LatestMeasurements,
  from: number,
  analyticsSeries?: readonly AnalyticsSeries[] | null,
  analyticsRangeEnd?: string | null,
): SeriesPoint[] {
  const byTimestamp = new Map<number, SeriesPoint>();
  const rangeEnd = analyticsRangeEnd ? validTimestamp(analyticsRangeEnd) : null;
  if (analyticsSeries !== undefined) {
    const analytics = analyticsSeries?.find((series) => series.entityId === sensorId && series.measurementId === metric);
    for (const point of analytics?.points ?? []) {
      const timestamp = validTimestamp(point.timestamp);
      if (point.value === null || timestamp === null || timestamp < from || !Number.isFinite(point.value)) continue;
      byTimestamp.set(timestamp, { timestamp, value: point.value });
    }
  }
  if (analyticsSeries === undefined || rangeEnd !== null) {
    for (const sample of history[sensorId]?.[metric] ?? []) {
      const timestamp = validTimestamp(sample.timestamp);
      if (sample.quality === "stale" || timestamp === null || timestamp < from || !Number.isFinite(sample.value)
        || (analyticsSeries !== undefined && timestamp <= rangeEnd!)) continue;
      byTimestamp.set(timestamp, { timestamp, value: sample.value });
    }
  }
  const latest = latestMeasurements[sensorId]?.[metric] as MeasurementSample | undefined;
  if (latest) {
    const timestamp = validTimestamp(latest.timestamp);
    const isNewLiveTail = analyticsSeries === undefined || rangeEnd === null || (timestamp !== null && timestamp > rangeEnd);
    if (isNewLiveTail && latest.quality !== "stale" && timestamp !== null && timestamp >= from && Number.isFinite(latest.value)) {
      byTimestamp.set(timestamp, { timestamp, value: latest.value });
    }
  }
  return [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
}

function forecastSeries(
  sensorId: string,
  metric: Metric,
  forecasts: MeasurementForecasts,
  from: number,
): ForecastSeriesPoint[] {
  return (forecasts[sensorId]?.[metric] ?? []).flatMap((point: MeasurementForecastPoint) => {
    const timestamp = validTimestamp(point.timestamp);
    return timestamp === null || timestamp < from || ![point.value, point.low, point.high].every(Number.isFinite)
      ? []
      : [{ timestamp, value: point.value, low: point.low, high: point.high }];
  }).sort((left, right) => left.timestamp - right.timestamp);
}

/**
 * Aligns sensor values into range-sized time buckets before aggregating. A
 * sensor contributes one mean value per bucket, so chatty devices do not
 * outweigh slower devices in the Home average.
 */
export function aggregateObservedSeries(
  series: Array<{ sensorId: string; points: SeriesPoint[] }>,
  bucketMs: number,
  aggregate: "mean" | "sum" = "mean",
): AggregateSeriesPoint[] {
  const buckets = new Map<number, Map<string, { sum: number; count: number }>>();
  for (const item of series) {
    for (const point of item.points) {
      const bucket = Math.floor(point.timestamp / bucketMs) * bucketMs;
      const sensors = buckets.get(bucket) ?? new Map<string, { sum: number; count: number }>();
      const current = sensors.get(item.sensorId) ?? { sum: 0, count: 0 };
      sensors.set(item.sensorId, { sum: current.sum + point.value, count: current.count + 1 });
      buckets.set(bucket, sensors);
    }
  }
  return [...buckets.entries()].sort(([left], [right]) => left - right).map(([timestamp, sensors]) => {
    const values = [...sensors.values()].map(({ sum, count }) => sum / count);
    return {
      timestamp,
      value: values.reduce((sum, value) => sum + value, 0) / (aggregate === "mean" ? values.length : 1),
      low: Math.min(...values),
      high: Math.max(...values),
      sensorCount: values.length,
    };
  });
}

export function aggregateForecastSeries(
  series: Array<{ sensorId: string; points: ForecastSeriesPoint[] }>,
  bucketMs: number,
  aggregate: "mean" | "sum" = "mean",
): AggregateSeriesPoint[] {
  const buckets = new Map<number, Map<string, { value: number; low: number; high: number; count: number }>>();
  for (const item of series) {
    for (const point of item.points) {
      const bucket = Math.floor(point.timestamp / bucketMs) * bucketMs;
      const sensors = buckets.get(bucket) ?? new Map<string, { value: number; low: number; high: number; count: number }>();
      const current = sensors.get(item.sensorId) ?? { value: 0, low: 0, high: 0, count: 0 };
      sensors.set(item.sensorId, {
        value: current.value + point.value,
        low: current.low + point.low,
        high: current.high + point.high,
        count: current.count + 1,
      });
      buckets.set(bucket, sensors);
    }
  }
  return [...buckets.entries()].sort(([left], [right]) => left - right).map(([timestamp, sensors]) => {
    const values = [...sensors.values()].map((point) => ({
      value: point.value / point.count,
      low: point.low / point.count,
      high: point.high / point.count,
    }));
    return {
      timestamp,
      value: values.reduce((sum, point) => sum + point.value, 0) / (aggregate === "mean" ? values.length : 1),
      low: values.reduce((sum, point) => sum + point.low, 0) / (aggregate === "mean" ? values.length : 1),
      high: values.reduce((sum, point) => sum + point.high, 0) / (aggregate === "mean" ? values.length : 1),
      sensorCount: values.length,
    };
  });
}

export function SensorAnalyticsChart(props: Readonly<SensorAnalyticsChartProps>) {
  const { locale, t } = useI18n();
  const now = useNow();
  const summaryId = useId();
  const rangeLabelId = `${summaryId}-range`;
  const [exactDataOpen, setExactDataOpen] = useState(false);
  const [visibleExactRowCount, setVisibleExactRowCount] = useState(250);
  const definition = props.definitions.find((candidate) => candidate.id === props.metric) ?? props.definitions[0];
  const activeSensors = useMemo(() => props.selectedSensorIds === null
    ? props.sensors.filter((sensor) => sensor.enabled)
    : props.sensors.filter((sensor) => props.selectedSensorIds?.includes(sensor.id)), [props.selectedSensorIds, props.sensors]);
  const selectedHistoryState = sensorHistoryState(activeSensors);
  const sensorDisplayName = (sensor: Sensor) => sensorHistoryName(sensor, t("sensors.archived"));
  const historyLabel = (label: string) => withSensorHistoryState(
    label,
    selectedHistoryState,
    t("sensors.analyticsArchivedHistory"),
    t("sensors.analyticsIncludesArchived"),
  );
  const sensorIds = activeSensors.map((sensor) => sensor.id).join("\u0000");
  const isCombined = activeSensors.length !== 1;

  const data = useMemo(() => {
    if (!definition) return {
      observed: [], predicted: [], aggregate: [], aggregateForecast: [], outdoorObserved: [], outdoorForecast: [], electricityPrice: [],
    };
    const from = now - timeRangeHours(props.range) * 60 * 60_000;
    const observed = activeSensors.map((sensor) => ({
      sensor,
      points: observedSeries(
        sensor.id,
        definition.id,
        props.history,
        props.latestMeasurements,
        from,
        props.analyticsSeries,
        props.analyticsRangeEnd,
      ),
    }));
    const predicted = definition.forecastSupported ? activeSensors.filter((sensor) => sensor.enabled).map((sensor) => ({
      sensor,
      points: forecastSeries(sensor.id, definition.id, props.forecasts, now),
    })) : [];
    const bucketMs = bucketMilliseconds(props.range);
    const aggregateMode = definition.id === "power" || definition.id === "energy" ? "sum" : "mean";
    const outdoorObserved = definition.id === "temperature" && props.weatherObservationsVisible
      ? [...new Map([
        ...(props.outdoorHistory ?? []).flatMap((sample) => {
          const timestamp = validTimestamp(sample.timestamp);
          return timestamp === null || timestamp < from || !Number.isFinite(sample.temperatureC)
            ? []
            : [[timestamp, { timestamp, value: sample.temperatureC }] as const];
        }),
        ...([props.weather?.current].filter(Boolean) as NonNullable<HouseWeather["current"]>[]).flatMap((point) => {
          const timestamp = validTimestamp(point.timestamp);
          return timestamp === null || timestamp < from || timestamp > now || !Number.isFinite(point.temperatureC)
            ? []
            : [[timestamp, { timestamp, value: point.temperatureC as number }] as const];
        }),
      ]).values()].sort((left, right) => left.timestamp - right.timestamp)
      : [];
    const outdoorForecast = definition.id === "temperature" && props.weatherForecastVisible
      ? (props.weather?.forecast ?? []).flatMap((point) => {
        const timestamp = validTimestamp(point.timestamp);
        return timestamp === null || timestamp < now || !Number.isFinite(point.temperatureC)
          ? []
          : [{ timestamp, value: point.temperatureC as number }];
      }).sort((left, right) => left.timestamp - right.timestamp)
      : [];
    const electricityPrice = definition.id === "electricity_price"
      ? (() => {
        const rows = (props.electricityPrices ?? []).filter((point) => {
          const start = validTimestamp(point.startAt);
          const end = validTimestamp(point.endAt);
          return start !== null && end !== null && end >= from && Number.isFinite(point.effectivePriceEurPerKwh);
        }).sort((left, right) => left.startAt.localeCompare(right.startAt));
        const points = rows.map((point) => ({
          timestamp: Math.max(from, Date.parse(point.startAt)),
          value: point.effectivePriceEurPerKwh,
        }));
        const last = rows.at(-1);
        if (last) points.push({ timestamp: Date.parse(last.endAt), value: last.effectivePriceEurPerKwh });
        return points;
      })()
      : [];
    return {
      observed,
      predicted,
      aggregate: aggregateObservedSeries(observed.map(({ sensor, points }) => ({ sensorId: sensor.id, points })), bucketMs, aggregateMode),
      aggregateForecast: aggregateForecastSeries(predicted.map(({ sensor, points }) => ({ sensorId: sensor.id, points })), bucketMs, aggregateMode),
      outdoorObserved,
      outdoorForecast,
      electricityPrice,
    };
  }, [activeSensors, definition, now, props.analyticsRangeEnd, props.analyticsSeries, props.electricityPrices, props.forecasts, props.history, props.latestMeasurements, props.outdoorHistory, props.range, props.weather, props.weatherForecastVisible, props.weatherObservationsVisible]);

  if (!definition) return null;

  const from = now - timeRangeHours(props.range) * 60 * 60_000;
  const gapThresholdMs = chartGapThresholdMs(props.range);
  const forecastGapThresholdMs = Math.max(gapThresholdMs, 2 * 60 * 60_000);
  const forecastEnd = Math.max(data.aggregateForecast.at(-1)?.timestamp ?? now, data.electricityPrice.at(-1)?.timestamp ?? now);
  const timeMax = Math.max(now, forecastEnd);
  const values = [
    ...data.observed.flatMap((series) => series.points.map((point) => point.value)),
    ...data.aggregate.flatMap((point) => [point.low, point.value, point.high]),
    ...data.aggregateForecast.flatMap((point) => [point.low, point.value, point.high]),
    ...data.outdoorObserved.map((point) => point.value),
    ...data.outdoorForecast.map((point) => point.value),
    ...data.electricityPrice.map((point) => point.value),
  ];
  const domain = measurementDomain(definition, values);
  const latestSensorAggregate = data.aggregate.at(-1);
  const latestWeatherObservation = data.outdoorObserved.at(-1);
  const currentPropertyPrice = data.electricityPrice.filter((point) => point.timestamp <= now).at(-1);
  const latestAggregate = latestSensorAggregate ?? (activeSensors.length === 0 && latestWeatherObservation ? {
    ...latestWeatherObservation, low: latestWeatherObservation.value, high: latestWeatherObservation.value, sensorCount: 1,
  } : isCombined && currentPropertyPrice ? {
    ...currentPropertyPrice, low: currentPropertyPrice.value, high: currentPropertyPrice.value, sensorCount: 1,
  } : undefined);
  const latestWeatherForecast = data.outdoorForecast.at(-1);
  const finalPrediction = data.aggregateForecast.at(-1) ?? (activeSensors.length === 0 && latestWeatherForecast ? {
    ...latestWeatherForecast, low: latestWeatherForecast.value, high: latestWeatherForecast.value, sensorCount: 1,
  } : undefined);
  const { missingSeriesCount, missingIntervals, statusKey: gapStatusKey } = deriveSensorAnalyticsGapStatus({
    observed: data.observed.filter((series) => series.sensor.enabled),
    durable: props.sensorGaps ?? [],
    activeSensorIds: activeSensors.filter((sensor) => sensor.enabled).map((sensor) => sensor.id),
    metric: definition.id,
    from,
    to: now,
    thresholdMs: gapThresholdMs,
  });
  const gapNoticeKey = [props.houseId, definition.id, props.range, sensorIds, gapStatusKey, missingSeriesCount, missingIntervals.length].join(":");
  const reportingSensors = data.observed.filter((series) => series.points.length > 0).length;
  const observedValues = activeSensors.length > 0
    ? data.observed.flatMap((series) => series.points.map((point) => point.value))
    : data.outdoorObserved.map((point) => point.value);
  const observedRange = observedValues.length > 0 ? Math.max(...observedValues) - Math.min(...observedValues) : null;
  const metricLabel = measurementLabel(definition, locale);
  const archivedSensorOnly = activeSensors.length === 1 && !activeSensors[0]!.enabled;
  const chartLabel = isCombined
    ? `${historyLabel(t("sensors.analyticsAria", { metric: metricLabel }))}${selectedHistoryState === "mixed" ? ` · ${t("sensors.analyticsLiveSourcesOnly")}` : ""}`
    : t(archivedSensorOnly ? "sensors.analyticsHistoricalSensorAria" : "sensors.analyticsSensorAria", {
      metric: metricLabel,
      sensor: activeSensors[0] ? sensorDisplayName(activeSensors[0]) : "",
    });
  const observationSummary = latestAggregate
    ? archivedSensorOnly
      ? `${t("sensors.analyticsHistoricalSummary", {
        value: formatMeasurement(latestAggregate.value, definition, props.units),
      })} · ${t("sensors.archived")}`
      : historyLabel(t(isCombined && !(reportingSensors === 0 && data.electricityPrice.length > 0)
        ? "sensors.analyticsAverageSummary"
        : "sensors.analyticsLatestSummary", {
        value: formatMeasurement(latestAggregate.value, definition, props.units),
        count: latestAggregate.sensorCount,
      }))
    : t("common.noData");
  const predictionSummary = finalPrediction
    ? `${t(isCombined ? "sensors.analyticsPredictionSummary" : "sensors.analyticsSensorPredictionSummary", {
      value: formatMeasurement(finalPrediction.value, definition, props.units),
      time: formatInTimeZone(finalPrediction.timestamp, locale, props.timeZone, { dateStyle: "medium", timeStyle: "short" }),
    })}${selectedHistoryState === "mixed" ? ` · ${t("sensors.analyticsLiveSourcesOnly")}` : ""}`
    : null;
  const summary = [
    chartLabel,
    observationSummary,
    predictionSummary,
  ].filter(Boolean).join(". ");
  const climateDefinitions = props.definitions.filter((candidate) => ["temperature", "humidity", "co2"].includes(candidate.id));
  const electricityDefinitions = props.definitions.filter((candidate) => ["power", "energy", "electricity_price"].includes(candidate.id));
  const otherDefinitions = props.definitions.filter((candidate) => !["temperature", "humidity", "co2", "power", "energy", "electricity_price"].includes(candidate.id));
  const optionGroup = (label: string, candidates: MeasurementDefinition[]) => candidates.length > 0
    ? <optgroup label={label}>{candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{measurementLabel(candidate, locale)}</option>)}</optgroup>
    : null;
  const weatherOnly = activeSensors.length === 0 && (data.outdoorObserved.length > 0 || data.outdoorForecast.length > 0);
  const aggregateBaseLabel = weatherOnly
    ? t("sensors.analyticsFmiObservations")
    : isCombined
      ? (definition.id === "power" || definition.id === "energy"
      ? t("sensors.analyticsHomeTotal")
      : definition.id === "electricity_price" && reportingSensors === 0 && data.electricityPrice.length > 0
        ? t("sensors.analyticsPropertyPrice")
        : t("sensors.analyticsHomeAverage"))
    : t("sensors.analyticsLatestReading");
  const aggregateLabel = archivedSensorOnly
    ? `${t("sensors.analyticsHistoricalReading")} · ${t("sensors.archived")}`
    : weatherOnly ? aggregateBaseLabel : historyLabel(aggregateBaseLabel);
  const predictionBaseLabel = weatherOnly
    ? t("sensors.analyticsFmiForecast")
    : isCombined ? t("sensors.analyticsPrediction") : t("sensors.analyticsSensorPrediction");
  const predictionLabel = selectedHistoryState === "mixed"
    ? `${predictionBaseLabel} · ${t("sensors.analyticsLiveSourcesOnly")}`
    : predictionBaseLabel;
  type ExactDataRow = { id: string; source: string; kind: "observed" | "forecast"; timestamp: number; value: number; low: number | null; high: number | null; sensorCount: number; sensorTotal: number; gapMs: number | null };
  const exactRowCount = data.observed.reduce((count, series) => count + series.points.length, 0)
    + data.predicted.reduce((count, series) => count + series.points.length, 0)
    + (isCombined ? data.aggregate.length + data.aggregateForecast.length : 0)
    + data.outdoorObserved.length
    + data.outdoorForecast.length
    + data.electricityPrice.length;
  const exactRows: ExactDataRow[] = [];
  const appendRows = (
    source: string,
    kind: ExactDataRow["kind"],
    points: Array<SeriesPoint & Partial<Pick<ForecastSeriesPoint, "low" | "high">>>,
    threshold: number,
    sensorCount: (point: SeriesPoint & Partial<Pick<ForecastSeriesPoint, "low" | "high">>) => number = () => 1,
    sensorTotal = 1,
  ) => points.forEach((point, index) => {
    const previous = points[index - 1];
    const interval = previous
      ? point.timestamp - previous.timestamp
      : point.timestamp - (kind === "observed" ? from : now);
    exactRows.push({
      id: `${source}:${kind}:${point.timestamp}:${index}`,
      source,
      kind,
      timestamp: point.timestamp,
      value: point.value,
      low: point.low ?? null,
      high: point.high ?? null,
      sensorCount: sensorCount(point),
      sensorTotal,
      gapMs: previous && interval > threshold ? interval : null,
    });
  });
  if (exactDataOpen) {
    data.observed.forEach(({ sensor, points }) => appendRows(sensorDisplayName(sensor), "observed", points, gapThresholdMs));
    data.predicted.forEach(({ sensor, points }) => appendRows(sensorDisplayName(sensor), "forecast", points, forecastGapThresholdMs));
    if (isCombined) {
      appendRows(aggregateLabel, "observed", data.aggregate, gapThresholdMs, (point) => (point as AggregateSeriesPoint).sensorCount, activeSensors.length);
      appendRows(predictionLabel, "forecast", data.aggregateForecast, forecastGapThresholdMs, (point) => (point as AggregateSeriesPoint).sensorCount, activeSensors.length);
    }
    appendRows(t("sensors.analyticsFmiObservations"), "observed", data.outdoorObserved, gapThresholdMs);
    appendRows(t("sensors.analyticsFmiForecast"), "forecast", data.outdoorForecast, forecastGapThresholdMs);
    appendRows(t("sensors.analyticsPropertyPrice"), "observed", data.electricityPrice, gapThresholdMs);
    exactRows.sort((left, right) => left.timestamp - right.timestamp || left.source.localeCompare(right.source));
  }
  const visibleExactRows = exactRows.slice(0, visibleExactRowCount);
  const csvCell = (value: string | number | null) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const downloadChartCsv = () => {
    const csv = [
      ["timestamp", "source", "kind", "value", "unit", "low", "high", "reporting_sources", "available_sources", "gap_before_seconds"],
      ...exactRows.map((row) => [new Date(row.timestamp).toISOString(), row.source, row.kind, toDisplayValue(row.value, definition, props.units), displayUnit(definition, props.units), row.low === null ? null : toDisplayValue(row.low, definition, props.units), row.high === null ? null : toDisplayValue(row.high, definition, props.units), row.sensorCount, row.sensorTotal, row.gapMs === null ? null : Math.round(row.gapMs / 1_000)]),
    ].map((row) => row.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `stugu-${definition.id}-${props.range}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const gapText = (gapMs: number | null) => gapMs === null
    ? t("analytics.noGap")
    : gapMs >= 60 * 60_000
      ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(gapMs / 3_600_000)} ${t("common.hours")}`
      : `${Math.round(gapMs / 60_000)} ${t("common.minutes")}`;
  const weatherAvailable = definition.id === "temperature";
  const selectedSourceCount = activeSensors.length
    + (weatherAvailable && props.weatherObservationsVisible ? 1 : 0)
    + (weatherAvailable && props.weatherForecastVisible ? 1 : 0);
  const selectableSourceCount = props.sensors.length + (weatherAvailable ? 2 : 0);
  const allSourcesSelected = selectedSourceCount === selectableSourceCount;
  const sourcePickerBaseLabel = allSourcesSelected
    ? t("sensors.analyticsAllSources")
    : selectedSourceCount === 1 && activeSensors.length === 1
      ? sensorDisplayName(activeSensors[0]!)
      : t("sensors.analyticsSelectedSources", { count: selectedSourceCount });
  const sourcePickerLabel = selectedSourceCount === 1 && activeSensors.length === 1
    ? sourcePickerBaseLabel
    : historyLabel(sourcePickerBaseLabel);
  const toggleSensor = (sensorId: string) => {
    const defaultSensorIds = props.sensors.filter((sensor) => sensor.enabled).map((sensor) => sensor.id);
    const current = props.selectedSensorIds ?? defaultSensorIds;
    const next = current.includes(sensorId) ? current.filter((id) => id !== sensorId) : [...current, sensorId];
    const isDefault = next.length === defaultSensorIds.length
      && next.every((id) => defaultSensorIds.includes(id));
    props.onSensors(isDefault ? null : next);
  };
  const selectAllSources = () => {
    const allSensorIds = props.sensors.map((sensor) => sensor.id);
    props.onSensors(props.sensors.every((sensor) => sensor.enabled) ? null : allSensorIds);
    if (weatherAvailable) {
      props.onWeatherObservationsVisible(true);
      props.onWeatherForecastVisible(true);
    }
  };
  const clearSources = () => {
    props.onSensors([]);
    if (weatherAvailable) {
      props.onWeatherObservationsVisible(false);
      props.onWeatherForecastVisible(false);
    }
  };
  const headingTitle = weatherOnly
    ? t("sensors.analyticsWeatherTitle")
    : isCombined
      ? historyLabel(t("sensors.analyticsTitle"))
      : activeSensors[0] ? sensorDisplayName(activeSensors[0]) : t("sensors.analyticsTitle");
  const headingDescription = weatherOnly
    ? t("sensors.analyticsWeatherDescription")
    : selectedHistoryState === "archived"
      ? t("sensors.analyticsArchivedDescription")
      : selectedHistoryState === "mixed"
        ? t("sensors.analyticsMixedDescription")
        : t(isCombined ? "sensors.analyticsDescription" : "sensors.analyticsSensorDescription");

  return (
    <section className="panel sensor-analytics-panel" aria-labelledby="sensor-analytics-title">
      <header className="sensor-analytics-heading">
        <div>
          <span className="eyebrow"><GitCompareArrows size={13} aria-hidden="true" />{t(weatherOnly ? "sensors.analyticsWeatherEyebrow" : isCombined ? "sensors.analyticsEyebrow" : "sensors.analyticsSensorEyebrow")}</span>
          <h2 id="sensor-analytics-title">{headingTitle}</h2>
          <p>{headingDescription}</p>
        </div>
        <div className="sensor-analytics-controls">
          <div className="field sensor-series-picker-field">
            <span>{t("sensors.analyticsSources")}</span>
            <details className="sensor-series-picker">
              <summary aria-label={t("sensors.analyticsChooseSources")}><span>{sourcePickerLabel}</span><ChevronDown size={15} aria-hidden="true" /></summary>
              <div className="sensor-series-picker-menu">
                <div className="sensor-series-picker-actions">
                  <button type="button" onClick={selectAllSources} disabled={allSourcesSelected}>{t("sensors.analyticsSelectAll")}</button>
                  <button type="button" onClick={clearSources} disabled={selectedSourceCount === 0}>{t("sensors.analyticsClear")}</button>
                </div>
                <fieldset>
                  <legend>{t("sensors.analyticsSensorsGroup")}</legend>
                  {props.sensors.map((sensor) => <label key={sensor.id}>
                    <input type="checkbox" checked={activeSensors.some((candidate) => candidate.id === sensor.id)} onChange={() => toggleSensor(sensor.id)} />
                    <span>{sensorDisplayName(sensor)}</span>
                  </label>)}
                </fieldset>
                {weatherAvailable && <fieldset>
                  <legend>{t("sensors.analyticsFmiWeatherGroup")}</legend>
                  <label><input type="checkbox" checked={props.weatherObservationsVisible} onChange={(event) => props.onWeatherObservationsVisible(event.target.checked)} /><CloudSun size={14} aria-hidden="true" /><span>{t("sensors.analyticsFmiObservations")}</span></label>
                  <label><input type="checkbox" checked={props.weatherForecastVisible} onChange={(event) => props.onWeatherForecastVisible(event.target.checked)} /><CloudSun size={14} aria-hidden="true" /><span>{t("sensors.analyticsFmiForecast")}</span></label>
                </fieldset>}
              </div>
            </details>
          </div>
          <label className="field">
            <span>{t("sensors.analyticsMetric")}</span>
            <select value={definition.id} onChange={(event) => props.onMetric(event.target.value)}>
              {optionGroup(t("sensors.analyticsClimateGroup"), climateDefinitions)}
              {optionGroup(t("sensors.analyticsElectricityGroup"), electricityDefinitions)}
              {optionGroup(t("sensors.analyticsOtherGroup"), otherDefinitions)}
            </select>
          </label>
          <div className="field sensor-analytics-range-field">
            <span id={rangeLabelId}>{t("chart.history")}</span>
            <div className="segmented compact" role="group" aria-labelledby={rangeLabelId}>
              {ANALYTICS_TIME_RANGES.map((range) => <button key={range} type="button" aria-pressed={props.range === range} onClick={() => props.onRange(range)}>{t(`chart.range${range}`)}</button>)}
            </div>
          </div>
        </div>
      </header>

      <div className="sensor-analytics-stats" aria-label={t("sensors.analyticsSummary")}>
        <div><span><Activity size={14} aria-hidden="true" />{aggregateLabel}</span><strong>{latestAggregate ? formatMeasurement(latestAggregate.value, definition, props.units) : "—"}</strong><small>{weatherOnly ? t("sensors.analyticsFmiSource") : isCombined ? (reportingSensors === 0 && data.electricityPrice.length > 0 ? t("sensors.analyticsPropertyPriceSource") : t("sensors.analyticsReporting", { count: reportingSensors, total: activeSensors.length })) : archivedSensorOnly ? `${t("sensors.analyticsSelectedSource")} · ${t("sensors.analyticsArchivedHistory")}` : t("sensors.analyticsSelectedSource")}</small></div>
        <div><span><GitCompareArrows size={14} aria-hidden="true" />{t(!weatherOnly && isCombined ? "sensors.analyticsSensorRange" : "sensors.analyticsObservedRange")}</span><strong>{!weatherOnly && isCombined ? (latestAggregate ? formatMeasurementDelta(latestAggregate.high - latestAggregate.low, definition, props.units) : "—") : (observedRange === null ? "—" : formatMeasurementDelta(observedRange, definition, props.units))}</strong><small>{t(!weatherOnly && isCombined ? "sensors.analyticsMinMax" : "sensors.analyticsRangeContext")}</small></div>
        <div><span><BrainCircuit size={14} aria-hidden="true" />{predictionLabel}</span><strong>{finalPrediction ? formatMeasurement(finalPrediction.value, definition, props.units) : "—"}</strong><small>{finalPrediction ? formatInTimeZone(finalPrediction.timestamp, locale, props.timeZone, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : t("sensors.analyticsNoPrediction")}</small></div>
      </div>

      {missingSeriesCount > 0 && <SensorAnalyticsGapNotice
        key={gapNoticeKey}
        title={t("analytics.missingSeriesStatus", { count: missingSeriesCount })}
        description={t(gapStatusKey)}
      />}

      <div className="sensor-analytics-legend" aria-label={t("sensors.analyticsLegend")}>
        {data.observed.map(({ sensor, points }, index) => points.length > 0 && <span key={sensor.id}><i className={`sensor-series-swatch series-${index % 6}`} style={{ borderTopStyle: sensorDashes[index % sensorDashes.length] ? "dashed" : "solid" }} aria-hidden="true" />{sensorDisplayName(sensor)}</span>)}
        {isCombined && data.aggregate.length > 0 && <span><i className="sensor-series-swatch aggregate" aria-hidden="true" />{aggregateLabel}</span>}
        {data.aggregateForecast.length > 0 && <span><i className="sensor-series-swatch prediction" aria-hidden="true" />{predictionLabel}</span>}
        {data.outdoorObserved.length > 0 && <span><i className="sensor-series-swatch outdoor" aria-hidden="true" />{t("decision.outdoor")}</span>}
        {data.outdoorForecast.length > 0 && <span><i className="sensor-series-swatch outdoor-forecast" aria-hidden="true" />{t("analytics.outdoorForecast")}</span>}
        {data.electricityPrice.length > 0 && <span><i className="sensor-series-swatch electricity-price" aria-hidden="true" />{t("sensors.analyticsPropertyPrice")}</span>}
        {missingIntervals.length > 0 && <span><i className="sensor-gap-swatch" aria-hidden="true" />{t("analytics.missingData")}</span>}
      </div>

      {domain && (data.aggregate.length > 0 || data.outdoorObserved.length > 0 || data.outdoorForecast.length > 0 || data.electricityPrice.length > 0) ? <SensorAnalyticsPlot
        data={data}
        definition={definition}
        units={props.units}
        range={props.range}
        timeZone={props.timeZone}
        from={from}
        now={now}
        timeMax={timeMax}
        domain={domain}
        chartLabel={chartLabel}
        summary={summary}
        summaryId={summaryId}
        isCombined={isCombined}
        latestAggregate={latestAggregate}
        missingIntervals={missingIntervals}
        gapThresholdMs={gapThresholdMs}
        forecastGapThresholdMs={forecastGapThresholdMs}
        aggregateLabel={aggregateLabel}
        predictionLabel={predictionLabel}
      /> : props.loading ? <output className="empty-state" aria-live="polite">{t("sensors.loadingData")}</output> : <div className="empty-state">{t("common.noData")}</div>}
      {exactRowCount > 0 && <details className="analytics-data-details" open={exactDataOpen}>
        <summary onClick={(event) => {
          event.preventDefault();
          setExactDataOpen((current) => {
            if (current) setVisibleExactRowCount(250);
            return !current;
          });
        }}>{t("analytics.showDataTable", { count: exactRowCount })}</summary>
        {exactDataOpen && <div className="analytics-data-table-wrap" role="region" aria-label={t("analytics.dataTable")} tabIndex={0}>
          <button type="button" className="secondary-button" onClick={downloadChartCsv}>{t("dataExport.downloadCsv")}</button>
          <table className="analytics-data-table"><caption className="sr-only">{chartLabel}</caption><thead><tr><th scope="col">{t("analytics.series")}</th><th scope="col">{t("analytics.timestamp")}</th><th scope="col">{t("observations.kind")}</th><th scope="col">{t("analytics.value")}</th><th scope="col">{t("chart.confidence")}</th><th scope="col">{t("analytics.coverageLabel")}</th><th scope="col">{t("analytics.gap")}</th></tr></thead><tbody>
            {visibleExactRows.map((row) => <tr key={row.id}><th scope="row">{row.source}</th><td><time dateTime={new Date(row.timestamp).toISOString()}>{formatInTimeZone(row.timestamp, locale, props.timeZone, { dateStyle: "medium", timeStyle: "short" })}</time></td><td>{t(row.kind === "observed" ? "chart.observed" : "chart.predicted")}</td><td>{formatMeasurement(row.value, definition, props.units)}</td><td>{row.low === null || row.high === null ? "—" : `${formatMeasurement(row.low, definition, props.units)} – ${formatMeasurement(row.high, definition, props.units)}`}</td><td>{row.sensorCount} / {row.sensorTotal}</td><td>{gapText(row.gapMs)}</td></tr>)}
          </tbody></table>
          {visibleExactRows.length < exactRows.length && <button type="button" className="secondary-button" onClick={() => setVisibleExactRowCount((count) => Math.min(count + 250, exactRows.length))}>{t("analytics.dataTableShowMore", { count: Math.min(250, exactRows.length - visibleExactRows.length) })}</button>}
        </div>}
      </details>}
      <CalendarPeriodComparison
        houseId={props.houseId}
        timeZone={props.timeZone}
        dataMode={props.dataMode}
        sensors={activeSensors}
        metric={definition.id}
        definition={definition}
        units={props.units}
      />
    </section>
  );
}
