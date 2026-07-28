import { useEffect, useId, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type {
  HomeElectricityPricePoint,
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

export const ELECTRICITY_METRICS = ["power", "energy", "electricity_price"] as const;
export type ElectricityMetric = typeof ELECTRICITY_METRICS[number];
type ChartMode = "single" | "multiple" | "combined";

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
  onLoadSeries?: (sensorId: string, metric: Metric, range: TimeRange, forecastSupported?: boolean) => void;
  seriesStates?: Record<string, SeriesLoadState>;
}

function supportsMetric(state: ClimateState, sensor: Sensor, metric: ElectricityMetric): boolean {
  return Boolean(sensor.measurementEntityIds?.[metric])
    || Boolean(state.latestMeasurements[sensor.id]?.[metric])
    || (state.measurementHistory[sensor.id]?.[metric]?.length ?? 0) > 0;
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
  const [mode, setMode] = useState<ChartMode>("combined");
  const [singleSensorId, setSingleSensorId] = useState("");
  const [multipleSensorIds, setMultipleSensorIds] = useState<string[] | null>(null);
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
    : mode === "multiple" ? multipleSensors : metricSensors;
  const activeSensorKey = activeSensors.map((sensor) => sensor.id).join("\u0000");
  const from = now - timeRangeHours(props.range) * 3_600_000;
  const propertyPrices = useMemo(
    () => props.metric === "electricity_price"
      ? propertyPriceSeries(props.electricityPrices ?? [], from, now)
      : [],
    [from, now, props.electricityPrices, props.metric],
  );
  const propertyOnly = metricSensors.length === 0 && propertyPrices.length > 0;

  useEffect(() => {
    setSingleSensorId("");
    setMultipleSensorIds(null);
  }, [props.metric]);

  useEffect(() => {
    activeSensors.forEach((sensor) => {
      props.onLoadSeries?.(sensor.id, props.metric, props.range, false);
    });
  }, [activeSensorKey, props.metric, props.onLoadSeries, props.range]);

  const observed = useMemo(() => activeSensors.map((sensor) => ({
    sensor,
    points: observedSeries(sensor.id, props.metric, props.state, from),
  })), [activeSensorKey, from, props.metric, props.state]);
  const aggregateResult = useMemo(() => {
    const points = aggregateObservedSeries(
      observed.map(({ sensor, points: sensorPoints }) => ({ sensorId: sensor.id, points: sensorPoints })),
      bucketMilliseconds(props.range),
      props.metric === "electricity_price" ? "mean" : "sum",
    );
    const complete = points.filter((point) => point.sensorCount === activeSensors.length);
    return { points: complete, partialCount: points.length - complete.length };
  }, [activeSensors.length, observed, props.metric, props.range]);
  const aggregate = aggregateResult.points;
  const plottedObserved = mode === "combined" ? [] : observed;
  const plottedAggregate = mode === "combined" ? aggregate : [];
  const values = mode === "combined"
    ? aggregate.map((point) => point.value)
    : observed.flatMap((series) => series.points.map((point) => point.value));
  const domain = timelineValueDomain(definition, [...values, ...propertyPrices.map((point) => point.value)]);
  const metricLabel = measurementLabel(definition, locale);
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
  const latestSummaries = mode === "combined"
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
  const loadStates = activeSensors.flatMap((sensor) => {
    const state = props.seriesStates?.[seriesStateKey(sensor.id, props.metric)];
    return state ? [state] : [];
  });
  const loading = loadStates.some((state) => state.status === "loading")
    || (props.metric === "electricity_price" && props.priceLoading === true);
  const errors = loadStates.filter((state) => state.status === "error");
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
            return <button key={candidate} type="button" aria-pressed={props.metric === candidate} onClick={() => props.onMetric(candidate)}>{measurementLabel(candidateDefinition, locale)}</button>;
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
            <option value="">{t("energy.noSource")}</option>
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
            ? t("energy.combinedSources", { count: metricSensors.length, total: metricSensors.length })
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
      /> : <div className="empty-state">{loading ? t("chart.loading") : t("common.noData")}</div>}
      {(errors.length > 0 || (props.metric === "electricity_price" && props.priceError)) && <p className="inline-error" role="alert">{t("chart.loadError")}</p>}
      {mode === "combined" && aggregateResult.partialCount > 0 && <p className="chart-capability-note">{t("energy.chartCompleteIntervals")}</p>}
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
      {!definition.forecastSupported && <p className="chart-capability-note">{t("chart.forecastUnsupported", { metric: metricLabel })}</p>}
    </section>
  </>;
}
