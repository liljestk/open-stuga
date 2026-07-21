import { useId, useMemo, useState } from "react";
import type { MeasurementDefinition, MeasurementForecastPoint, MeasurementSample, Sensor, UnitSystem } from "@climate-twin/contracts";
import { type TimeRange } from "../domain";
import { displayUnit, formatMeasurement, measurementLabel, measurementValue, toDisplayValue } from "../measurements";
import { useI18n } from "../i18n";
import { formatInTimeZone } from "../dateTime";
import { useNow } from "../useNow";
import type { SeriesLoadState } from "../useClimateData";

interface TrendChartProps {
  sensor: Sensor | null;
  history: MeasurementSample[];
  forecast: MeasurementForecastPoint[];
  definition: MeasurementDefinition;
  units: UnitSystem;
  range: TimeRange;
  onRange: (range: TimeRange) => void;
  timeZone?: string;
  loadState?: SeriesLoadState;
  heading?: string | undefined;
}

interface PlotPoint { timestamp: number; value: number; low?: number; high?: number; kind: "history" | "forecast" }

const width = 780;
const height = 250;
const margin = { top: 20, right: 22, bottom: 34, left: 62 };

/**
 * Fit the vertical timeline axis to the values that are currently visible.
 * Measurement display bounds are useful for stable spatial colour scales, but
 * they can flatten a low-amplitude series (for example, 155 W on a 0–10 kW
 * power scale). Keep enough padding for a readable line and enough range for
 * four distinct labels when the series is flat.
 */
export function timelineValueDomain(
  definition: MeasurementDefinition,
  values: number[],
): { min: number; max: number } | null {
  const finiteValues = values.filter(Number.isFinite);
  if (!finiteValues.length) return null;

  const actualMin = Math.min(...finiteValues);
  const actualMax = Math.max(...finiteValues);
  const actualSpan = actualMax - actualMin;
  const labelStep = 10 ** -definition.precision;
  let targetSpan = Math.max(
    actualSpan * 1.2,
    actualSpan === 0 ? Math.abs(actualMax) * 0.1 : 0,
    labelStep * 3,
  );

  // Respect physical bounds when the data itself is within them. Values that
  // are already outside a configured bound remain visible for diagnosis.
  const lowerBound = definition.validMin != null && actualMin >= definition.validMin
    ? definition.validMin
    : Number.NEGATIVE_INFINITY;
  const upperBound = definition.validMax != null && actualMax <= definition.validMax
    ? definition.validMax
    : Number.POSITIVE_INFINITY;
  if (Number.isFinite(lowerBound) && Number.isFinite(upperBound)) {
    targetSpan = Math.min(targetSpan, upperBound - lowerBound);
  }

  const padding = (targetSpan - actualSpan) / 2;
  let min = actualMin - padding;
  let max = actualMax + padding;
  if (min < lowerBound) {
    max += lowerBound - min;
    min = lowerBound;
  }
  if (max > upperBound) {
    min -= max - upperBound;
    max = upperBound;
  }

  return { min: Math.max(min, lowerBound), max: Math.min(max, upperBound) };
}

export function TrendChart({ sensor, history, forecast, definition, units, range, onRange, timeZone, loadState, heading }: TrendChartProps) {
  const { locale, t } = useI18n();
  const [focused, setFocused] = useState<PlotPoint | null>(null);
  const [dataOpen, setDataOpen] = useState(false);
  const chartSummaryId = useId();
  const now = useNow();
  const rangeHours = range === "6h" ? 6 : range === "24h" ? 24 : 168;
  const requestedStart = now - rangeHours * 3600000;
  const metricLabel = measurementLabel(definition, locale);
  const series = useMemo(() => {
    const observed: PlotPoint[] = history
      .filter((sample) => sample.metric === definition.id && sample.quality !== "stale" && Date.parse(sample.timestamp) >= requestedStart)
      .flatMap((sample) => {
        const value = measurementValue(sample, definition.id);
        return value == null ? [] : [{ timestamp: Date.parse(sample.timestamp), value, kind: "history" as const }];
      });
    const predicted: PlotPoint[] = definition.forecastSupported ? forecast
      .filter((point) => point.metric === definition.id)
      .map((point) => ({
        timestamp: Date.parse(point.timestamp), value: point.value, low: point.low, high: point.high, kind: "forecast" as const,
      })) : [];
    return { observed, predicted };
  }, [history, forecast, definition, requestedStart]);

  const all = [...series.observed, ...series.predicted];
  if (!sensor) {
    return <section className="panel chart-panel"><div className="panel-header"><div><span className="eyebrow">{t("chart.title")}</span><h2>{t("twin.selectSensor")}</h2></div></div><div className="empty-state">{t("common.noData")}</div></section>;
  }
  if (!all.length) {
    return <section className="panel chart-panel"><ChartHeader sensor={sensor} heading={heading} range={range} onRange={onRange} />
      {loadState?.status === "loading"
        ? <div className="empty-state" role="status">{t("chart.loading")}</div>
        : loadState?.status === "error"
          ? <p className="inline-error" role="alert">{t("chart.loadError")}</p>
          : <div className="empty-state">{t("common.noData")}</div>}
      {!definition.forecastSupported && <p className="chart-capability-note">{t("chart.forecastUnsupported", { metric: metricLabel })}</p>}
    </section>;
  }

  // Keep the selected history window fixed even when only a short tail has
  // loaded. Forecasts may extend the right edge, but sparse history no longer
  // masquerades as full-range coverage.
  const timeMin = requestedStart;
  const timeMax = Math.max(now, ...series.predicted.map((point) => point.timestamp));
  const domain = timelineValueDomain(definition, all.flatMap((point) => [point.value, point.low ?? point.value, point.high ?? point.value]))!;
  const valueMin = domain.min;
  const valueMax = domain.max;
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const x = (timestamp: number) => margin.left + (timestamp - timeMin) / Math.max(timeMax - timeMin, 1) * plotWidth;
  const y = (value: number) => margin.top + (valueMax - value) / Math.max(valueMax - valueMin, Number.EPSILON) * plotHeight;
  const path = (points: PlotPoint[]) => points.map((point, index) => `${index ? "L" : "M"}${x(point.timestamp).toFixed(1)} ${y(point.value).toFixed(1)}`).join(" ");
  const confidence = series.predicted.length
    ? [
      ...series.predicted.map((point) => `${x(point.timestamp).toFixed(1)},${y(point.high ?? point.value).toFixed(1)}`),
      ...[...series.predicted].reverse().map((point) => `${x(point.timestamp).toFixed(1)},${y(point.low ?? point.value).toFixed(1)}`),
    ].join(" ") : "";
  const yTicks = Array.from({ length: 4 }, (_, index) => valueMin + (valueMax - valueMin) * index / 3).reverse();
  const xTicks = Array.from({ length: 5 }, (_, index) => timeMin + (timeMax - timeMin) * index / 4);
  const currentX = x(now);
  const unit = displayUnit(definition, units);
  const focusValue = focused ? formatMeasurement(focused.value, definition, units) : null;
  const chartLabel = t("chart.aria", { metric: metricLabel, sensor: sensor.name });
  const latestPoint = (points: PlotPoint[]) => points.reduce<PlotPoint | null>((latest, point) => (
    !latest || point.timestamp > latest.timestamp ? point : latest
  ), null);
  const summarizePoint = (label: string, point: PlotPoint | null) => point
    ? `${label}: ${formatMeasurement(point.value, definition, units)}, ${formatInTimeZone(point.timestamp, locale, timeZone, { dateStyle: "medium", timeStyle: "short" })}`
    : null;
  const chartSummary = [
    chartLabel,
    summarizePoint(t("chart.observed"), latestPoint(series.observed)),
    summarizePoint(t("chart.predicted"), latestPoint(series.predicted)),
  ].filter(Boolean).join(". ");
  const dataRows = dataOpen ? [...all].sort((left, right) => left.timestamp - right.timestamp) : [];
  const observedStart = series.observed.length ? Math.min(...series.observed.map((point) => point.timestamp)) : null;
  const coverageStart = loadState?.loadedFrom ? Date.parse(loadState.loadedFrom) : observedStart;
  const coverageIsPartial = loadState?.partial === true
    || (coverageStart !== null && Number.isFinite(coverageStart) && coverageStart > requestedStart + rangeHours * 36_000);

  return (
    <section className="panel chart-panel">
      <ChartHeader sensor={sensor} heading={heading} range={range} onRange={onRange} />
      <div className="chart-legend" aria-hidden="true"><span><i className="legend-line observed" />{t("chart.observed")}</span>{definition.forecastSupported && <><span><i className="legend-line predicted" />{t("chart.predicted")}</span><span><i className="legend-area" />{t("chart.confidence")}</span></>}</div>
      <div className="chart-wrap">
        <p id={chartSummaryId} className="sr-only">{chartSummary}</p>
        <svg className="trend-chart" viewBox={`0 0 ${width} ${height}`} role="group" aria-label={chartLabel} aria-describedby={chartSummaryId}>
          <title>{chartLabel}</title>
          <g className="chart-grid" aria-hidden="true">
            {yTicks.map((tick, index) => <line key={`grid-y-${index}-${tick}`} x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} />)}
          </g>
          <g className="chart-axis" aria-hidden="true">
            {yTicks.map((tick, index) => <text key={`axis-y-${index}-${tick}`} x={margin.left - 10} y={y(tick) + 4} textAnchor="end">{toDisplayValue(tick, definition, units).toFixed(definition.precision)}</text>)}
            {xTicks.map((tick, index) => <text key={`axis-x-${index}-${tick}`} x={x(tick)} y={height - 10} textAnchor={tick === timeMin ? "start" : tick === timeMax ? "end" : "middle"}>{formatInTimeZone(tick, locale, timeZone, range === "7d" ? { weekday: "short", hour: "2-digit" } : { hour: "2-digit", minute: "2-digit" })}</text>)}
            <text x="7" y="15">{unit}</text>
          </g>
          {confidence && <polygon points={confidence} className="confidence-area" aria-hidden="true" />}
          {series.observed.length > 1 && <path d={path(series.observed)} className="chart-line observed" aria-hidden="true" />}
          {series.predicted.length > 1 && <path d={path(series.predicted)} className="chart-line predicted" aria-hidden="true" />}
          {currentX >= margin.left && currentX <= width - margin.right && <g className="now-marker" aria-hidden="true"><line x1={currentX} x2={currentX} y1={margin.top} y2={height - margin.bottom} /><text x={currentX + 6} y={margin.top + 12}>{t("chart.now")}</text></g>}
          <g className="chart-points">
            {all.filter((_, index) => index % Math.max(1, Math.floor(all.length / 35)) === 0 || index === all.length - 1).map((point, index) => (
              <circle
                key={`${point.kind}-${point.timestamp}-${index}`}
                cx={x(point.timestamp)} cy={y(point.value)} r="8" className={point.kind}
                aria-hidden="true"
                onMouseEnter={() => setFocused(point)} onMouseLeave={() => setFocused(null)}
              />
            ))}
          </g>
          {focused && <g className="chart-focus" aria-hidden="true"><line x1={x(focused.timestamp)} x2={x(focused.timestamp)} y1={margin.top} y2={height - margin.bottom} /><circle cx={x(focused.timestamp)} cy={y(focused.value)} r="4" /></g>}
        </svg>
        {focused && <div className="chart-tooltip" role="status"><strong>{focusValue}</strong><span>{formatInTimeZone(focused.timestamp, locale, timeZone, { weekday: "short", hour: "2-digit", minute: "2-digit" })} · {focused.kind === "history" ? t("chart.observed") : t("chart.predicted")}</span></div>}
      </div>
      <details className="chart-data-disclosure" open={dataOpen}>
        <summary onClick={(event) => { event.preventDefault(); setDataOpen((value) => !value); }}>{t("common.showDataTable")}</summary>
        {dataOpen && <div className="chart-data-table-wrap">
          <table>
            <caption className="sr-only">{chartLabel}</caption>
            <thead><tr><th scope="col">{t("historyImport.dateTime")}</th><th scope="col">{t("historyImport.value")}</th><th scope="col">{t("observations.kind")}</th></tr></thead>
            <tbody>{dataRows.map((point, index) => (
              <tr key={`data-${point.kind}-${point.timestamp}-${index}`}>
                <td>{formatInTimeZone(point.timestamp, locale, timeZone, { dateStyle: "medium", timeStyle: "short" })}</td>
                <td>{formatMeasurement(point.value, definition, units)}{point.kind === "forecast" && point.low !== undefined && point.high !== undefined ? ` (${t("chart.confidence")}: ${formatMeasurement(point.low, definition, units)} – ${formatMeasurement(point.high, definition, units)})` : ""}</td>
                <td>{point.kind === "history" ? t("chart.observed") : t("chart.predicted")}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>}
      </details>
      {loadState?.status === "loading" && <p className="chart-capability-note" role="status">{t("chart.loading")}</p>}
      {loadState?.status === "error" && <p className="inline-error" role="alert">{t("chart.loadError")} {loadState.error}</p>}
      {coverageIsPartial && coverageStart !== null && <p className="chart-capability-note">{t("chart.coverage", {
        time: formatInTimeZone(coverageStart, locale, timeZone, { dateStyle: "medium", timeStyle: "short" }),
      })}</p>}
      {loadState?.forecastError && <p className="chart-capability-note">{t("chart.forecastLoadError")}</p>}
      {!definition.forecastSupported && <p className="chart-capability-note">{t("chart.forecastUnsupported", { metric: metricLabel })}</p>}
    </section>
  );
}

function ChartHeader({ sensor, heading, range, onRange }: { sensor: Sensor; heading?: string | undefined; range: TimeRange; onRange: (range: TimeRange) => void }) {
  const { t } = useI18n();
  return (
    <div className="panel-header chart-heading">
      <div><span className="eyebrow">{t("chart.title")}</span><h2>{heading ?? sensor.name}</h2></div>
      <div className="segmented compact" role="group" aria-label={t("chart.history")}>
        {(["6h", "24h", "7d"] as const).map((item) => <button key={item} type="button" aria-pressed={range === item} onClick={() => onRange(item)}>{t(`chart.range${item}`)}</button>)}
      </div>
    </div>
  );
}
