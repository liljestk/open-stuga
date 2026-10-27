import { useEffect, useId, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { ApiRequestError } from "../api";
import type {
  HomeElectricityPricePoint,
  DataMode,
  MeasurementSample,
  Metric,
  Sensor,
  UnitSystem,
} from "@climate-twin/contracts";
import { chartGapThresholdMs } from "../chartGaps";
import {
  SensorAnalyticsPlot,
  sensorDashes,
  type SensorAnalyticsPlotData,
  type SeriesPoint,
} from "../components/SensorAnalyticsPlot";
import { aggregateObservedSeries } from "../components/SensorAnalyticsChart";
import { timelineValueDomain } from "../components/TrendChart";
import { ANALYTICS_TIME_RANGES, timeRangeHours, type ClimateState, type TimeRange } from "../domain";
import { formatInTimeZone } from "../dateTime";
import { definitionFor, formatMeasurement, measurementLabel } from "../measurements";
import { useI18n } from "../i18n";
import { useNow } from "../useNow";
import { seriesStateKey, type SeriesLoadState } from "../useClimateData";
import { sensorsForHomeTotal } from "./energyTelemetry";
import { aggregateCumulativeSeries, consumptionHistorySeries, holdSeriesForBuckets } from "./energyAnalysis";
import { useElectricityHistoryQuery } from "../data/energy/electricityHistoryQuery";
import { historyIsPreparing } from "../data/energy/historyPreparation";
import { electricityHistoryLocation, writeElectricityHistoryLocation, type ElectricityChartMode } from "./electricityHistoryLocation";

export const ELECTRICITY_METRICS = ["power", "energy", "electricity_price"] as const;
export type ElectricityMetric = typeof ELECTRICITY_METRICS[number];

interface ElectricityHistoryProps {
  state: ClimateState;
  sensors: Sensor[];
  metric: ElectricityMetric;
  onMetric: (metric: ElectricityMetric) => void;
  units: UnitSystem;
  range: TimeRange;
  onRange: (range: TimeRange) => void;
  timeZone: string;
  electricityPrices?: HomeElectricityPricePoint[];
  priceLoading?: boolean;
  priceError?: boolean;
  priceAccessDenied?: boolean;
  onPriceRetry?: () => void;
  dataMode?: DataMode;
  onLoadSeries?: (sensorId: string, metric: Metric, range: TimeRange, forecastSupported?: boolean) => void;
  seriesStates?: Record<string, SeriesLoadState>;
}

function supportsDirectMetric(state: ClimateState, sensor: Sensor, metric: ElectricityMetric): boolean {
  return Boolean(sensor.measurementEntityIds?.[metric])
    || Boolean(state.latestMeasurements[sensor.id]?.[metric])
    || (state.measurementHistory[sensor.id]?.[metric]?.length ?? 0) > 0;
}

function supportsMetric(state: ClimateState, sensor: Sensor, metric: ElectricityMetric): boolean {
  return supportsDirectMetric(state, sensor, metric)
    || (metric === "energy" && supportsDirectMetric(state, sensor, "power"));
}

function loadedMetrics(metric: ElectricityMetric): ElectricityMetric[] {
  if (metric !== "energy") return [metric];
  // Consumption has a separate integral query. Generic history is averaged
  // and must never be interpreted as resetting counters or held power.
  return [];
}

function bucketMilliseconds(range: TimeRange): number {
  if (range === "6h") return 5 * 60_000;
  if (range === "24h") return 15 * 60_000;
  if (range === "7d") return 2 * 60 * 60_000;
  if (range === "30d") return 6 * 60 * 60_000;
  if (range === "90d") return 12 * 60 * 60_000;
  return 2 * 24 * 60 * 60_000;
}

function observedSeries(
  sensorId: string,
  metric: ElectricityMetric,
  state: ClimateState,
  from: number,
): SeriesPoint[] {
  const samples = [
    ...(state.measurementHistory[sensorId]?.[metric] ?? []),
    ...([state.latestMeasurements[sensorId]?.[metric]].filter(Boolean) as MeasurementSample[]),
  ];
  const points = new Map<number, SeriesPoint>();
  for (const sample of samples) {
    const timestamp = Date.parse(sample.timestamp);
    if (sample.metric !== metric || sample.quality === "stale" || !Number.isFinite(timestamp)
      || timestamp < from || !Number.isFinite(sample.value)) continue;
    points.set(timestamp, { timestamp, value: sample.value });
  }
  return [...points.values()].sort((left, right) => left.timestamp - right.timestamp);
}

function propertyPriceSeries(
  prices: readonly HomeElectricityPricePoint[],
  from: number,
  to: number,
): SeriesPoint[] {
  const rows = prices.filter((point) => {
    const start = Date.parse(point.startAt);
    const end = Date.parse(point.endAt);
    return Number.isFinite(start) && Number.isFinite(end) && end >= from && start <= to
      && Number.isFinite(point.effectivePriceEurPerKwh);
  }).sort((left, right) => left.startAt.localeCompare(right.startAt));
  const points = rows.map((point) => ({
    timestamp: Math.max(from, Date.parse(point.startAt)),
    value: point.effectivePriceEurPerKwh,
  }));
  const last = rows.at(-1);
  if (last) {
    points.push({
      timestamp: Math.min(to, Date.parse(last.endAt)),
      value: last.effectivePriceEurPerKwh,
    });
  }
  return points;
}

export function ElectricityHistory(props: Readonly<ElectricityHistoryProps>) {
  const { locale, t } = useI18n();
  const now = useNow();
  const summaryId = useId();
  const sourceLabelId = `${summaryId}-source`;
  const [location, setLocation] = useState(electricityHistoryLocation);
  const { mode, source: singleSensorId, sources: multipleSensorIds } = location;
  const selectLocation = (next: typeof location) => { setLocation(next); writeElectricityHistoryLocation(next); };
  const setMode = (next: ElectricityChartMode) => selectLocation({ ...location, mode: next });
  const setSingleSensorId = (next: string) => selectLocation({ ...location, source: next });
  const setMultipleSensorIds = (next: string[] | null) => selectLocation({ ...location, sources: next });
  const [dataOpen, setDataOpen] = useState(false);
  const definition = definitionFor(props.state.measurementDefinitions, props.metric);
  const metricSensors = useMemo(
    () => props.sensors.filter((sensor) => supportsMetric(props.state, sensor, props.metric)),
    [props.metric, props.sensors, props.state],
  );
  const singleSensor = metricSensors.find((sensor) => sensor.id === singleSensorId) ?? metricSensors[0] ?? null;
  const multipleSensors = multipleSensorIds === null
    ? metricSensors
    : metricSensors.filter((sensor) => multipleSensorIds.includes(sensor.id));
  const activeSensors = mode === "single" ? (singleSensor ? [singleSensor] : [])
    : mode === "multiple" ? multipleSensors : props.metric === "electricity_price" ? metricSensors : sensorsForHomeTotal(metricSensors);
  const activeSensorKey = activeSensors.map((sensor) => sensor.id).join("\u0000");
  const activeLoadKey = activeSensors.map((sensor) => (
    `${sensor.id}:${loadedMetrics(props.metric).join(",")}`
  )).join("\u0000");
  const houseId = props.sensors[0]?.houseId ?? "";
  const consumptionQuery = useElectricityHistoryQuery(houseId, activeSensors.map((sensor) => ({
    id: sensor.id,
    energy: supportsDirectMetric(props.state, sensor, "energy"),
    power: supportsDirectMetric(props.state, sensor, "power"),
  })), props.range, props.timeZone, props.dataMode ?? "live", props.metric === "energy");
  useEffect(() => {
    const pathname = window.location.pathname;
    const restore = () => {
      if (window.location.pathname === pathname) setLocation(electricityHistoryLocation());
    };
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [houseId]);
  const from = now - timeRangeHours(props.range) * 3_600_000;
  const propertyPrices = useMemo(
    () => props.metric === "electricity_price"
      ? propertyPriceSeries(props.electricityPrices ?? [], from, now)
      : [],
    [from, now, props.electricityPrices, props.metric],
  );
  const propertyOnly = metricSensors.length === 0 && propertyPrices.length > 0;

  useEffect(() => {
    activeSensors.forEach((sensor) => {
      for (const candidate of loadedMetrics(props.metric)) {
        props.onLoadSeries?.(sensor.id, candidate, props.range, false);
      }
    });
  }, [activeLoadKey, props.metric, props.onLoadSeries, props.range]);

  const consumption = useMemo(() => new Map(activeSensors.map((sensor) => [sensor.id,
    consumptionHistorySeries(consumptionQuery.data ?? [], sensor.id)])), [activeSensorKey, consumptionQuery.data]);
  const observed = useMemo(() => activeSensors.map((sensor) => ({
    sensor,
    points: props.metric === "energy"
      ? consumption.get(sensor.id)?.points ?? []
      : observedSeries(sensor.id, props.metric, props.state, from),
  })), [activeSensorKey, consumption, from, now, props.metric, props.state]);
  const aggregateResult = useMemo(() => {
    // Sensors without a single sample in the window cannot contribute and must
    // not blank the whole combined chart; they are excluded and called out.
    // Instantaneous metrics get a zero-order-hold fill so change-plus-heartbeat
    // reporters still cover every bucket their value was valid for.
    const withData = observed.filter(({ points: sensorPoints }) => sensorPoints.length > 0);
    const bucketMs = bucketMilliseconds(props.range);
    const input = withData.map(({ sensor, points: sensorPoints }) => ({
      sensorId: sensor.id,
      points: props.metric === "energy" ? sensorPoints : holdSeriesForBuckets(sensorPoints, bucketMs, from, now),
    }));
    const points = props.metric === "energy"
      ? aggregateCumulativeSeries(input, bucketMs)
      : aggregateObservedSeries(
        input,
        bucketMs,
        props.metric === "electricity_price" ? "mean" : "sum",
      );
    const complete = points.filter((point) => point.sensorCount === withData.length);
    return {
      points: complete,
      partialCount: points.length - complete.length,
      reportingCount: withData.length,
      excludedCount: observed.length - withData.length,
    };
  }, [from, now, observed, props.metric, props.range]);
  const aggregate = aggregateResult.points;
  const plottedObserved = mode === "combined" ? [] : observed;
  const plottedAggregate = mode === "combined" ? aggregate : [];
  const values = mode === "combined"
    ? aggregate.map((point) => point.value)
    : observed.flatMap((series) => series.points.map((point) => point.value));
  const domain = timelineValueDomain(definition, [...values, ...propertyPrices.map((point) => point.value)]);
  const metricLabel = props.metric === "energy" ? t("energy.intervalUse") : measurementLabel(definition, locale);
  const sourceTitle = propertyOnly
    ? t("sensors.analyticsPropertyPrice")
    : mode === "combined"
    ? metricSensors.length
      ? t(props.metric === "electricity_price" ? "energy.chartCombinedAverage" : "sensors.analyticsHomeTotal")
      : t("energy.noSource")
    : mode === "single"
      ? singleSensor?.name ?? t("energy.noSource")
      : t("sensors.analyticsSelectedSources", { count: activeSensors.length });
  const chartLabel = t("energy.chartAria", { metric: metricLabel, source: sourceTitle });
  const latestSummaries = propertyOnly && propertyPrices.at(-1)
    ? [`${sourceTitle}: ${formatMeasurement(propertyPrices.at(-1)!.value, definition, props.units)}`]
    : mode === "combined"
    ? aggregate.at(-1)
      ? [`${sourceTitle}: ${formatMeasurement(aggregate.at(-1)!.value, definition, props.units)}`]
      : propertyPrices.at(-1)
        ? [`${sourceTitle}: ${formatMeasurement(propertyPrices.at(-1)!.value, definition, props.units)}`]
      : []
    : observed.flatMap(({ sensor, points }) => {
      const latest = points.at(-1);
      return latest ? [`${sensor.name}: ${formatMeasurement(latest.value, definition, props.units)}`] : [];
    });
  const summary = [chartLabel, ...(latestSummaries.length ? latestSummaries : [t("common.noData")])].join(". ");
  const gapThresholdMs = chartGapThresholdMs(props.range);
  const plotData: SensorAnalyticsPlotData = {
    observed: plottedObserved,
    aggregate: plottedAggregate,
    aggregateForecast: [],
    outdoorObserved: [],
    outdoorForecast: [],
    electricityPrice: propertyPrices,
  };
  const loadStates = activeSensors.flatMap((sensor) => loadedMetrics(props.metric).flatMap((candidate) => {
    const state = props.seriesStates?.[seriesStateKey(sensor.id, candidate)];
    return state ? [state] : [];
  }));
  const preparing = props.metric === "energy" && historyIsPreparing(consumptionQuery.error);
  const loading = preparing || loadStates.some((state) => state.status === "loading")
    || (props.metric === "energy" && consumptionQuery.isFetching)
    || (props.metric === "electricity_price" && props.priceLoading === true);
  const errors = loadStates.filter((state) => state.status === "error");
  const truncatedSeries = loadStates.some((state) => state.truncated);
  const partialConsumption = props.metric === "energy" && [...consumption.values()].some((series) => series.partial);
  const failed = errors.length > 0 || (props.metric === "electricity_price" && props.priceError)
    || (props.metric === "energy" && consumptionQuery.isError && !preparing);
  const accessDenied = (props.metric === "electricity_price" && props.priceAccessDenied)
    || (props.metric === "energy" && consumptionQuery.error instanceof ApiRequestError && consumptionQuery.error.status === 403)
    || errors.some((state) => state.errorStatus === 403);
  const retry = () => {
    if (props.metric === "energy") void consumptionQuery.refetch();
    else activeSensors.forEach((sensor) => props.onLoadSeries?.(sensor.id, props.metric, props.range, false));
    if (props.metric === "electricity_price" && props.priceError) props.onPriceRetry?.();
  };
  const dataRows = [
    ...(mode === "combined"
      ? aggregate.map((point, index) => ({ id: `combined-${point.timestamp}-${index}`, source: sourceTitle, point }))
      : observed.flatMap(({ sensor, points }) => points.map((point, index) => ({
      id: `${sensor.id}-${point.timestamp}-${index}`,
      source: sensor.name,
      point,
    })))),
    ...propertyPrices.map((point, index) => ({
      id: `property-price-${point.timestamp}-${index}`,
      source: t("sensors.analyticsPropertyPrice"),
      point,
    })),
  ];
  const selectedAll = multipleSensors.length === metricSensors.length && metricSensors.length > 0;
  const pickerLabel = selectedAll
    ? t("sensors.analyticsAllSensors")
    : t("sensors.analyticsSelectedSources", { count: multipleSensors.length });
  const toggleMultipleSensor = (sensorId: string) => {
    const current = multipleSensorIds ?? metricSensors.map((sensor) => sensor.id);
    const next = current.includes(sensorId)
      ? current.filter((candidate) => candidate !== sensorId)
      : [...current, sensorId];
    setMultipleSensorIds(next.length === metricSensors.length ? null : next);
  };

  return <>
    <section className="panel energy-history-controls" aria-labelledby="energy-history-heading">
      <div className="panel-header"><div><span className="eyebrow">{t("chart.history")}</span><h2 id="energy-history-heading">{t("energy.historyTitle")}</h2></div></div>
      <div className="energy-history-fields">
        <div className="field">
          <span>{t("common.metric")}</span>
          <div className="segmented" role="group" aria-label={t("common.metric")}>{ELECTRICITY_METRICS.map((candidate) => {
            const candidateDefinition = definitionFor(props.state.measurementDefinitions, candidate);
            const label = candidate === "energy" ? t("energy.intervalUse") : measurementLabel(candidateDefinition, locale);
            return <button key={candidate} type="button" aria-pressed={props.metric === candidate} onClick={() => props.onMetric(candidate)}>{label}</button>;
          })}</div>
        </div>
        <div className="field">
          <span>{t("energy.chartView")}</span>
          <div className="segmented" role="group" aria-label={t("energy.chartView")}>
            {(["single", "multiple", "combined"] as const).map((candidate) => <button key={candidate} type="button" aria-pressed={mode === candidate} onClick={() => setMode(candidate)}>{t(`energy.chartView.${candidate}`)}</button>)}
          </div>
        </div>
        <div className="field">
          <span id={sourceLabelId}>{t("energy.dataSource")}</span>
          {propertyOnly && <div className="energy-combined-source" aria-labelledby={sourceLabelId}>{t("sensors.analyticsPropertyPrice")}</div>}
          {!propertyOnly && mode === "single" && <select aria-labelledby={sourceLabelId} value={singleSensor?.id ?? ""} disabled={!metricSensors.length} onChange={(event) => setSingleSensorId(event.target.value)}>
            {!metricSensors.length && <option value="">{t("energy.noSource")}</option>}
            {metricSensors.map((sensor) => <option key={sensor.id} value={sensor.id}>{sensor.name}</option>)}
          </select>}
          {!propertyOnly && mode === "multiple" && <details className="sensor-series-picker">
            <summary aria-label={t("sensors.analyticsChooseSources")}><span>{pickerLabel}</span><ChevronDown size={15} aria-hidden="true" /></summary>
            <div className="sensor-series-picker-menu">
              <div className="sensor-series-picker-actions">
                <button type="button" disabled={selectedAll} onClick={() => setMultipleSensorIds(null)}>{t("sensors.analyticsSelectAll")}</button>
                <button type="button" disabled={!multipleSensors.length} onClick={() => setMultipleSensorIds([])}>{t("sensors.analyticsClear")}</button>
              </div>
              <fieldset>
                <legend>{t("sensors.analyticsSensorsGroup")}</legend>
                {metricSensors.map((sensor) => <label key={sensor.id}>
                  <input type="checkbox" checked={multipleSensors.some((candidate) => candidate.id === sensor.id)} onChange={() => toggleMultipleSensor(sensor.id)} />
                  <span>{sensor.name}</span>
                </label>)}
              </fieldset>
            </div>
          </details>}
          {!propertyOnly && mode === "combined" && <div className="energy-combined-source" aria-labelledby={sourceLabelId}>{metricSensors.length
            ? t("energy.combinedSources", { count: aggregateResult.reportingCount, total: activeSensors.length })
            : t("energy.waitingForSource")}</div>}
        </div>
      </div>
    </section>

    <section className="panel chart-panel energy-history-chart">
      <div className="panel-header chart-heading">
        <div><span className="eyebrow">{t("chart.title")}</span><h2>{sourceTitle}</h2></div>
        <div className="segmented compact" role="group" aria-label={t("chart.history")}>
          {ANALYTICS_TIME_RANGES.map((candidate) => <button key={candidate} type="button" aria-pressed={props.range === candidate} onClick={() => props.onRange(candidate)}>{t(`chart.range${candidate}`)}</button>)}
        </div>
      </div>
      <div className="sensor-analytics-legend" aria-label={t("sensors.analyticsLegend")}>
        {mode === "combined"
          ? aggregate.length > 0 && <span><i className="sensor-series-swatch aggregate" aria-hidden="true" />{sourceTitle}</span>
          : observed.map(({ sensor, points }, index) => points.length > 0 && <span key={sensor.id}><i className={`sensor-series-swatch series-${index % 6}`} style={{ borderTopStyle: sensorDashes[index % sensorDashes.length] ? "dashed" : "solid" }} aria-hidden="true" />{sensor.name}</span>)}
        {propertyPrices.length > 0 && <span><i className="sensor-series-swatch electricity-price" aria-hidden="true" />{t("sensors.analyticsPropertyPrice")}</span>}
      </div>
      {domain ? <SensorAnalyticsPlot
        fitContainer
        data={plotData}
        definition={definition}
        units={props.units}
        range={props.range}
        timeZone={props.timeZone}
        from={from}
        now={now}
        timeMax={now}
        domain={domain}
        chartLabel={chartLabel}
        summary={summary}
        summaryId={summaryId}
        isCombined={mode === "combined"}
        missingIntervals={[]}
        gapThresholdMs={gapThresholdMs}
        forecastGapThresholdMs={gapThresholdMs}
        aggregateLabel={sourceTitle}
        predictionLabel={t("chart.predicted")}
      /> : <div className="empty-state" role={loading ? "status" : undefined}>{loading ? t("chart.loading") : t("common.noData")}</div>}
      {loading && domain && <p className="chart-capability-note" role="status">{t("chart.loading")}</p>}
      {props.metric === "energy" && <p className="chart-capability-note">{t("energy.chartCumulativeHint")}</p>}
      {failed && <div className="inline-error" role="alert"><p>{t(accessDenied ? "energy.accessDenied" : "chart.loadError")}</p><button type="button" className="button secondary" disabled={loading} onClick={retry}>{t("common.retry")}</button></div>}
      {mode === "combined" && aggregateResult.partialCount > 0 && <p className="chart-capability-note">{t("energy.chartCompleteIntervals")}</p>}
      {mode === "combined" && !loading && aggregateResult.excludedCount > 0 && aggregateResult.reportingCount > 0 && <p className="chart-capability-note">{t("energy.chartSourcesWithoutData", { count: aggregateResult.excludedCount })}</p>}
      {truncatedSeries && <p className="chart-capability-note">{t("energy.chartTruncatedRange")}</p>}
      {partialConsumption && <p className="chart-capability-note">{t("energy.chartConsumptionIncomplete")}</p>}
      {dataRows.length > 0 && <details className="chart-data-disclosure" open={dataOpen}>
        <summary onClick={(event) => { event.preventDefault(); setDataOpen((current) => !current); }}>{t("common.showDataTable")}</summary>
        {dataOpen && <div className="chart-data-table-wrap" role="region" aria-label={chartLabel} tabIndex={0}>
          <table>
            <caption className="sr-only">{chartLabel}</caption>
            <thead><tr><th scope="col">{t("analytics.series")}</th><th scope="col">{t("historyImport.dateTime")}</th><th scope="col">{t("historyImport.value")}</th></tr></thead>
            <tbody>{dataRows.map((row) => <tr key={row.id}><th scope="row">{row.source}</th><td>{formatInTimeZone(row.point.timestamp, locale, props.timeZone, { dateStyle: "medium", timeStyle: "short" })}</td><td>{formatMeasurement(row.point.value, definition, props.units)}</td></tr>)}</tbody>
          </table>
        </div>}
      </details>}
    </section>
  </>;
}
