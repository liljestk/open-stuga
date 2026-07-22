import { useEffect, useId, useMemo, useState } from "react";
import { Activity, BrainCircuit, ChevronDown, CloudSun, GitCompareArrows } from "lucide-react";
import type {
  MeasurementDefinition,
  MeasurementForecastPoint,
  MeasurementSample,
  Metric,
  HouseWeather,
  HomeElectricityPricePoint,
  OutdoorTemperatureSample,
  Sensor,
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
import { chartGapThresholdMs, splitSeriesAtGaps } from "../chartGaps";
import { CalendarPeriodComparison } from "./CalendarPeriodComparison";

interface SensorAnalyticsChartProps {
  houseId: string;
  dataMode: "demo" | "real" | "unknown";
  sensors: Sensor[];
  history: MeasurementHistory;
  forecasts: MeasurementForecasts;
  latestMeasurements: LatestMeasurements;
  definitions: MeasurementDefinition[];
  outdoorHistory?: OutdoorTemperatureSample[];
  weather?: HouseWeather | null;
  electricityPrices?: HomeElectricityPricePoint[];
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

interface SeriesPoint {
  timestamp: number;
  value: number;
}

interface ForecastSeriesPoint extends SeriesPoint {
  low: number;
  high: number;
}

export interface AggregateSeriesPoint extends SeriesPoint {
  low: number;
  high: number;
  sensorCount: number;
}

const width = 1_100;
const height = 300;
const margin = { top: 24, right: 28, bottom: 38, left: 62 };
const sensorDashes = [undefined, "10 5", "3 4", "12 4 3 4"] as const;

function bucketMilliseconds(range: TimeRange): number {
  if (range === "6h") return 5 * 60_000;
  if (range === "24h") return 15 * 60_000;
  if (range === "7d") return 2 * 60 * 60_000;
  if (range === "30d") return 6 * 60 * 60_000;
  if (range === "90d") return 12 * 60 * 60_000;
  return 2 * 24 * 60 * 60_000;
}

function tickDateOptions(range: TimeRange): Intl.DateTimeFormatOptions {
  if (range === "6h" || range === "24h") return { hour: "2-digit", minute: "2-digit" };
  if (range === "7d") return { weekday: "short", hour: "2-digit" };
  if (range === "1y") return { month: "short" };
  return { month: "short", day: "numeric" };
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
): SeriesPoint[] {
  const samples = [
    ...(history[sensorId]?.[metric] ?? []),
    ...([latestMeasurements[sensorId]?.[metric]].filter(Boolean) as MeasurementSample[]),
  ];
  const byTimestamp = new Map<number, SeriesPoint>();
  for (const sample of samples) {
    const timestamp = validTimestamp(sample.timestamp);
    if (sample.quality === "stale" || timestamp === null || timestamp < from || !Number.isFinite(sample.value)) continue;
    byTimestamp.set(timestamp, { timestamp, value: sample.value });
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

function linePath(points: SeriesPoint[], x: (timestamp: number) => number, y: (value: number) => number): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.timestamp).toFixed(1)} ${y(point.value).toFixed(1)}`).join(" ");
}

function stepLinePath(points: SeriesPoint[], x: (timestamp: number) => number, y: (value: number) => number): string {
  return points.map((point, index) => index === 0
    ? `M${x(point.timestamp).toFixed(1)} ${y(point.value).toFixed(1)}`
    : `H${x(point.timestamp).toFixed(1)} V${y(point.value).toFixed(1)}`).join(" ");
}

function areaPoints(
  points: Array<Pick<AggregateSeriesPoint, "timestamp" | "low" | "high">>,
  x: (timestamp: number) => number,
  y: (value: number) => number,
): string {
  return [
    ...points.map((point) => `${x(point.timestamp).toFixed(1)},${y(point.high).toFixed(1)}`),
    ...[...points].reverse().map((point) => `${x(point.timestamp).toFixed(1)},${y(point.low).toFixed(1)}`),
  ].join(" ");
}

export function SensorAnalyticsChart(props: Readonly<SensorAnalyticsChartProps>) {
  const { locale, t } = useI18n();
  const now = useNow();
  const summaryId = useId();
  const [exactDataOpen, setExactDataOpen] = useState(false);
  const clipId = `${useId().replace(/:/g, "")}-sensor-analytics-clip`;
  const definition = props.definitions.find((candidate) => candidate.id === props.metric) ?? props.definitions[0];
  const activeSensors = useMemo(() => props.selectedSensorIds === null
    ? props.sensors
    : props.sensors.filter((sensor) => props.selectedSensorIds?.includes(sensor.id)), [props.selectedSensorIds, props.sensors]);
  const sensorIds = activeSensors.map((sensor) => sensor.id).join("\u0000");
  const isCombined = activeSensors.length !== 1;

  useEffect(() => {
    if (!definition || !props.onLoadSeries) return;
    activeSensors.forEach((sensor) => {
      props.onLoadSeries?.(sensor.id, definition.id, props.range, definition.forecastSupported);
    });
  }, [definition?.id, definition?.forecastSupported, props.onLoadSeries, props.range, sensorIds]);

  const data = useMemo(() => {
    if (!definition) return {
      observed: [], predicted: [], aggregate: [], aggregateForecast: [], outdoorObserved: [], outdoorForecast: [], electricityPrice: [],
    };
    const from = now - timeRangeHours(props.range) * 60 * 60_000;
    const observed = activeSensors.map((sensor) => ({
      sensor,
      points: observedSeries(sensor.id, definition.id, props.history, props.latestMeasurements, from),
    }));
    const predicted = definition.forecastSupported ? activeSensors.map((sensor) => ({
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
  }, [activeSensors, definition, now, props.electricityPrices, props.forecasts, props.history, props.latestMeasurements, props.outdoorHistory, props.range, props.weather, props.weatherForecastVisible, props.weatherObservationsVisible]);

  if (!definition) return null;

  const from = now - timeRangeHours(props.range) * 60 * 60_000;
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
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const x = (timestamp: number) => margin.left + (timestamp - from) / Math.max(timeMax - from, 1) * plotWidth;
  const y = (value: number) => margin.top + ((domain?.max ?? 1) - value) / Math.max((domain?.max ?? 1) - (domain?.min ?? 0), Number.EPSILON) * plotHeight;
  const xTicks = Array.from({ length: 5 }, (_, index) => from + (timeMax - from) * index / 4);
  const yTicks = domain ? Array.from({ length: 4 }, (_, index) => domain.max - (domain.max - domain.min) * index / 3) : [];
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
  const reportingSensors = data.observed.filter((series) => series.points.length > 0).length;
  const observedValues = activeSensors.length > 0
    ? data.observed.flatMap((series) => series.points.map((point) => point.value))
    : data.outdoorObserved.map((point) => point.value);
  const observedRange = observedValues.length > 0 ? Math.max(...observedValues) - Math.min(...observedValues) : null;
  const metricLabel = measurementLabel(definition, locale);
  const chartLabel = isCombined
    ? t("sensors.analyticsAria", { metric: metricLabel })
    : t("sensors.analyticsSensorAria", { metric: metricLabel, sensor: activeSensors[0]?.name ?? "" });
  const gapThresholdMs = chartGapThresholdMs(props.range);
  const forecastGapThresholdMs = Math.max(gapThresholdMs, 2 * 60 * 60_000);
  const summary = [
    chartLabel,
    latestAggregate ? t(isCombined && !(reportingSensors === 0 && data.electricityPrice.length > 0)
      ? "sensors.analyticsAverageSummary"
      : "sensors.analyticsLatestSummary", {
      value: formatMeasurement(latestAggregate.value, definition, props.units),
      count: latestAggregate.sensorCount,
    }) : t("common.noData"),
    finalPrediction ? t(isCombined ? "sensors.analyticsPredictionSummary" : "sensors.analyticsSensorPredictionSummary", {
      value: formatMeasurement(finalPrediction.value, definition, props.units),
      time: formatInTimeZone(finalPrediction.timestamp, locale, props.timeZone, { dateStyle: "medium", timeStyle: "short" }),
    }) : null,
  ].filter(Boolean).join(". ");
  const climateDefinitions = props.definitions.filter((candidate) => ["temperature", "humidity", "co2"].includes(candidate.id));
  const electricityDefinitions = props.definitions.filter((candidate) => ["power", "energy", "electricity_price"].includes(candidate.id));
  const otherDefinitions = props.definitions.filter((candidate) => !["temperature", "humidity", "co2", "power", "energy", "electricity_price"].includes(candidate.id));
  const optionGroup = (label: string, candidates: MeasurementDefinition[]) => candidates.length > 0
    ? <optgroup label={label}>{candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{measurementLabel(candidate, locale)}</option>)}</optgroup>
    : null;
  const weatherOnly = activeSensors.length === 0 && (data.outdoorObserved.length > 0 || data.outdoorForecast.length > 0);
  const aggregateLabel = weatherOnly
    ? t("sensors.analyticsFmiObservations")
    : isCombined
      ? (definition.id === "power" || definition.id === "energy"
      ? t("sensors.analyticsHomeTotal")
      : definition.id === "electricity_price" && reportingSensors === 0 && data.electricityPrice.length > 0
        ? t("sensors.analyticsPropertyPrice")
        : t("sensors.analyticsHomeAverage"))
    : t("sensors.analyticsLatestReading");
  const predictionLabel = weatherOnly
    ? t("sensors.analyticsFmiForecast")
    : isCombined ? t("sensors.analyticsPrediction") : t("sensors.analyticsSensorPrediction");
  type ExactDataRow = { id: string; source: string; kind: "observed" | "forecast"; timestamp: number; value: number; low: number | null; high: number | null; sensorCount: number; sensorTotal: number; gapMs: number | null };
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
    const interval = previous ? point.timestamp - previous.timestamp : 0;
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
  data.observed.forEach(({ sensor, points }) => appendRows(sensor.name, "observed", points, gapThresholdMs));
  data.predicted.forEach(({ sensor, points }) => appendRows(sensor.name, "forecast", points, forecastGapThresholdMs));
  if (isCombined) {
    appendRows(aggregateLabel, "observed", data.aggregate, gapThresholdMs, (point) => (point as AggregateSeriesPoint).sensorCount, activeSensors.length);
    appendRows(predictionLabel, "forecast", data.aggregateForecast, forecastGapThresholdMs, (point) => (point as AggregateSeriesPoint).sensorCount, activeSensors.length);
  }
  appendRows(t("sensors.analyticsFmiObservations"), "observed", data.outdoorObserved, gapThresholdMs);
  appendRows(t("sensors.analyticsFmiForecast"), "forecast", data.outdoorForecast, forecastGapThresholdMs);
  appendRows(t("sensors.analyticsPropertyPrice"), "observed", data.electricityPrice, gapThresholdMs);
  exactRows.sort((left, right) => left.timestamp - right.timestamp || left.source.localeCompare(right.source));
  const csvCell = (value: string | number | null) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const exactCsv = [
    ["timestamp", "source", "kind", "value", "unit", "low", "high", "reporting_sources", "available_sources", "gap_before_seconds"],
    ...exactRows.map((row) => [new Date(row.timestamp).toISOString(), row.source, row.kind, toDisplayValue(row.value, definition, props.units), displayUnit(definition, props.units), row.low === null ? null : toDisplayValue(row.low, definition, props.units), row.high === null ? null : toDisplayValue(row.high, definition, props.units), row.sensorCount, row.sensorTotal, row.gapMs === null ? null : Math.round(row.gapMs / 1_000)]),
  ].map((row) => row.map(csvCell).join(",")).join("\r\n");
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
  const sourcePickerLabel = allSourcesSelected
    ? t("sensors.analyticsAllSources")
    : selectedSourceCount === 1 && activeSensors.length === 1
      ? activeSensors[0]!.name
      : t("sensors.analyticsSelectedSources", { count: selectedSourceCount });
  const toggleSensor = (sensorId: string) => {
    const current = props.selectedSensorIds ?? props.sensors.map((sensor) => sensor.id);
    const next = current.includes(sensorId) ? current.filter((id) => id !== sensorId) : [...current, sensorId];
    props.onSensors(next.length === props.sensors.length ? null : next);
  };
  const selectAllSources = () => {
    props.onSensors(null);
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

  return (
    <section className="panel sensor-analytics-panel" aria-labelledby="sensor-analytics-title">
      <header className="sensor-analytics-heading">
        <div>
          <span className="eyebrow"><GitCompareArrows size={13} aria-hidden="true" />{t(weatherOnly ? "sensors.analyticsWeatherEyebrow" : isCombined ? "sensors.analyticsEyebrow" : "sensors.analyticsSensorEyebrow")}</span>
          <h2 id="sensor-analytics-title">{weatherOnly ? t("sensors.analyticsWeatherTitle") : isCombined ? t("sensors.analyticsTitle") : activeSensors[0]?.name ?? t("sensors.analyticsTitle")}</h2>
          <p>{t(weatherOnly ? "sensors.analyticsWeatherDescription" : isCombined ? "sensors.analyticsDescription" : "sensors.analyticsSensorDescription")}</p>
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
                    <span>{sensor.name}</span>
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
          <div className="segmented compact" role="group" aria-label={t("chart.history")}>
            {ANALYTICS_TIME_RANGES.map((range) => <button key={range} type="button" aria-pressed={props.range === range} onClick={() => props.onRange(range)}>{t(`chart.range${range}`)}</button>)}
          </div>
        </div>
      </header>

      <div className="sensor-analytics-stats" aria-label={t("sensors.analyticsSummary")}>
        <div><span><Activity size={14} aria-hidden="true" />{aggregateLabel}</span><strong>{latestAggregate ? formatMeasurement(latestAggregate.value, definition, props.units) : "—"}</strong><small>{weatherOnly ? t("sensors.analyticsFmiSource") : isCombined ? (reportingSensors === 0 && data.electricityPrice.length > 0 ? t("sensors.analyticsPropertyPriceSource") : t("sensors.analyticsReporting", { count: reportingSensors, total: activeSensors.length })) : t("sensors.analyticsSelectedSource")}</small></div>
        <div><span><GitCompareArrows size={14} aria-hidden="true" />{t(!weatherOnly && isCombined ? "sensors.analyticsSensorRange" : "sensors.analyticsObservedRange")}</span><strong>{!weatherOnly && isCombined ? (latestAggregate ? formatMeasurementDelta(latestAggregate.high - latestAggregate.low, definition, props.units) : "—") : (observedRange === null ? "—" : formatMeasurementDelta(observedRange, definition, props.units))}</strong><small>{t(!weatherOnly && isCombined ? "sensors.analyticsMinMax" : "sensors.analyticsRangeContext")}</small></div>
        <div><span><BrainCircuit size={14} aria-hidden="true" />{predictionLabel}</span><strong>{finalPrediction ? formatMeasurement(finalPrediction.value, definition, props.units) : "—"}</strong><small>{finalPrediction ? formatInTimeZone(finalPrediction.timestamp, locale, props.timeZone, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : t("sensors.analyticsNoPrediction")}</small></div>
      </div>

      <div className="sensor-analytics-legend" aria-label={t("sensors.analyticsLegend")}>
        {data.observed.map(({ sensor, points }, index) => points.length > 0 && <span key={sensor.id}><i className={`sensor-series-swatch series-${index % 6}`} style={{ borderTopStyle: sensorDashes[index % sensorDashes.length] ? "dashed" : "solid" }} aria-hidden="true" />{sensor.name}</span>)}
        {isCombined && data.aggregate.length > 0 && <span><i className="sensor-series-swatch aggregate" aria-hidden="true" />{aggregateLabel}</span>}
        {data.aggregateForecast.length > 0 && <span><i className="sensor-series-swatch prediction" aria-hidden="true" />{predictionLabel}</span>}
        {data.outdoorObserved.length > 0 && <span><i className="sensor-series-swatch outdoor" aria-hidden="true" />{t("decision.outdoor")}</span>}
        {data.outdoorForecast.length > 0 && <span><i className="sensor-series-swatch outdoor-forecast" aria-hidden="true" />{t("analytics.outdoorForecast")}</span>}
        {data.electricityPrice.length > 0 && <span><i className="sensor-series-swatch electricity-price" aria-hidden="true" />{t("sensors.analyticsPropertyPrice")}</span>}
      </div>

      {domain && (data.aggregate.length > 0 || data.outdoorObserved.length > 0 || data.outdoorForecast.length > 0 || data.electricityPrice.length > 0) ? <div className="sensor-analytics-chart-wrap" role="region" aria-label={chartLabel} tabIndex={0}>
        <p id={summaryId} className="sr-only">{summary}</p>
        <svg className="sensor-analytics-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={chartLabel} aria-describedby={summaryId}>
          <title>{chartLabel}</title>
          <defs><clipPath id={clipId}><rect x={margin.left} y={margin.top} width={plotWidth} height={plotHeight} /></clipPath></defs>
          <g className="chart-grid" aria-hidden="true">{yTicks.map((tick, index) => <line key={`${tick}-${index}`} x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} />)}</g>
          <g className="chart-axis" aria-hidden="true">
            {yTicks.map((tick, index) => <text key={`${tick}-${index}`} x={margin.left - 10} y={y(tick) + 4} textAnchor="end">{toDisplayValue(tick, definition, props.units).toFixed(definition.precision)}</text>)}
            {xTicks.map((tick, index) => <text key={tick} x={x(tick)} y={height - 10} textAnchor={index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle"}>{formatInTimeZone(tick, locale, props.timeZone, tickDateOptions(props.range))}</text>)}
            <text x="7" y="16">{displayUnit(definition, props.units)}</text>
          </g>
          <g clipPath={`url(#${clipId})`} aria-hidden="true">
            {isCombined && definition.id !== "power" && definition.id !== "energy" && splitSeriesAtGaps(data.aggregate, gapThresholdMs).map((segment, index) => segment.length > 1 && <polygon key={`aggregate-range-${index}`} className="sensor-aggregate-range" points={areaPoints(segment, x, y)} />)}
            {splitSeriesAtGaps(data.aggregateForecast, forecastGapThresholdMs).map((segment, index) => segment.length > 1 && <polygon key={`prediction-range-${index}`} className="sensor-prediction-range" points={areaPoints(segment, x, y)} />)}
            {data.observed.flatMap((series, index) => splitSeriesAtGaps(series.points, gapThresholdMs).map((segment, segmentIndex) => segment.length > 1 && <path key={`${series.sensor.id}-${segmentIndex}`} className={`sensor-series-line series-${index % 6}`} strokeDasharray={sensorDashes[index % sensorDashes.length]} d={linePath(segment, x, y)} />))}
            {isCombined && splitSeriesAtGaps(data.aggregate, gapThresholdMs).map((segment, index) => segment.length > 1 && <path key={`aggregate-${index}`} className="sensor-aggregate-line" d={linePath(segment, x, y)} />)}
            {splitSeriesAtGaps(data.aggregateForecast, forecastGapThresholdMs).map((segment, index) => segment.length > 1 && <path key={`prediction-${index}`} className="sensor-prediction-line" d={linePath(segment, x, y)} />)}
            {splitSeriesAtGaps(data.outdoorObserved, gapThresholdMs).map((segment, index) => segment.length > 1 && <path key={`outdoor-${index}`} className="sensor-outdoor-line" d={linePath(segment, x, y)} />)}
            {splitSeriesAtGaps(data.outdoorForecast, forecastGapThresholdMs).map((segment, index) => segment.length > 1 && <path key={`outdoor-forecast-${index}`} className="sensor-outdoor-forecast-line" d={linePath(segment, x, y)} />)}
            {data.electricityPrice.length > 1 && <path className="sensor-electricity-price-line" d={stepLinePath(data.electricityPrice, x, y)} />}
            <line className="sensor-analytics-now" x1={x(now)} x2={x(now)} y1={margin.top} y2={height - margin.bottom} />
          </g>
          {latestAggregate && <g className="sensor-analytics-end-label" aria-hidden="true"><circle cx={x(latestAggregate.timestamp)} cy={y(latestAggregate.value)} r="4" /><text x={Math.min(width - margin.right - 4, x(latestAggregate.timestamp) + 8)} y={y(latestAggregate.value) - 8} textAnchor={x(latestAggregate.timestamp) > width - 120 ? "end" : "start"}>{formatMeasurement(latestAggregate.value, definition, props.units)}</text></g>}
        </svg>
      </div> : <div className="empty-state">{t("common.noData")}</div>}
      {exactRows.length > 0 && <details className="analytics-data-details" open={exactDataOpen}>
        <summary onClick={(event) => { event.preventDefault(); setExactDataOpen((current) => !current); }}>{t("analytics.showDataTable", { count: exactRows.length })}</summary>
        {exactDataOpen && <div className="analytics-data-table-wrap" role="region" aria-label={t("analytics.dataTable")} tabIndex={0}>
          <a className="secondary-button" href={`data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${exactCsv}`)}`} download={`stuga-${definition.id}-${props.range}.csv`}>{t("analytics.downloadCsv")}</a>
          <table className="analytics-data-table"><caption className="sr-only">{chartLabel}</caption><thead><tr><th scope="col">{t("analytics.series")}</th><th scope="col">{t("analytics.timestamp")}</th><th scope="col">{t("observations.kind")}</th><th scope="col">{t("analytics.value")}</th><th scope="col">{t("chart.confidence")}</th><th scope="col">{t("analytics.coverageLabel")}</th><th scope="col">{t("analytics.gap")}</th></tr></thead><tbody>
            {exactRows.map((row) => <tr key={row.id}><th scope="row">{row.source}</th><td><time dateTime={new Date(row.timestamp).toISOString()}>{formatInTimeZone(row.timestamp, locale, props.timeZone, { dateStyle: "medium", timeStyle: "short" })}</time></td><td>{t(row.kind === "observed" ? "chart.observed" : "chart.predicted")}</td><td>{formatMeasurement(row.value, definition, props.units)}</td><td>{row.low === null || row.high === null ? "—" : `${formatMeasurement(row.low, definition, props.units)} – ${formatMeasurement(row.high, definition, props.units)}`}</td><td>{row.sensorCount} / {row.sensorTotal}</td><td>{gapText(row.gapMs)}</td></tr>)}
          </tbody></table>
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
