import { useMemo, useState } from "react";
import type { MeasurementDefinition, MeasurementForecastPoint, MeasurementSample, Sensor, UnitSystem } from "@climate-twin/contracts";
import { type TimeRange } from "../domain";
import { displayUnit, formatMeasurement, measurementDomain, measurementLabel, measurementValue, toDisplayValue } from "../measurements";
import { useI18n } from "../i18n";

interface TrendChartProps {
  sensor: Sensor | null;
  history: MeasurementSample[];
  forecast: MeasurementForecastPoint[];
  definition: MeasurementDefinition;
  units: UnitSystem;
  range: TimeRange;
  onRange: (range: TimeRange) => void;
}

interface PlotPoint { timestamp: number; value: number; low?: number; high?: number; kind: "history" | "forecast" }

const width = 780;
const height = 250;
const margin = { top: 20, right: 22, bottom: 34, left: 62 };

export function TrendChart({ sensor, history, forecast, definition, units, range, onRange }: TrendChartProps) {
  const { locale, t } = useI18n();
  const [focused, setFocused] = useState<PlotPoint | null>(null);
  const now = Date.now();
  const rangeHours = range === "6h" ? 6 : range === "24h" ? 24 : 168;
  const metricLabel = measurementLabel(definition, locale);
  const series = useMemo(() => {
    const observed: PlotPoint[] = history
      .filter((sample) => sample.metric === definition.id && sample.quality !== "stale" && Date.parse(sample.timestamp) >= now - rangeHours * 3600000)
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
  }, [history, forecast, definition, rangeHours, now]);

  const all = [...series.observed, ...series.predicted];
  if (!sensor) {
    return <section className="panel chart-panel"><div className="panel-header"><div><span className="eyebrow">{t("chart.title")}</span><h2>{t("twin.selectSensor")}</h2></div></div><div className="empty-state">{t("common.noData")}</div></section>;
  }
  if (!all.length) {
    return <section className="panel chart-panel"><ChartHeader sensor={sensor} range={range} onRange={onRange} /><div className="empty-state">{t("common.noData")}</div>{!definition.forecastSupported && <p className="chart-capability-note">{t("chart.forecastUnsupported", { metric: metricLabel })}</p>}</section>;
  }

  const timeMin = Math.min(...all.map((point) => point.timestamp));
  const timeMax = Math.max(...all.map((point) => point.timestamp));
  const domain = measurementDomain(definition, all.flatMap((point) => [point.value, point.low ?? point.value, point.high ?? point.value]))!;
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

  return (
    <section className="panel chart-panel">
      <ChartHeader sensor={sensor} range={range} onRange={onRange} />
      <div className="chart-legend" aria-hidden="true"><span><i className="legend-line observed" />{t("chart.observed")}</span>{definition.forecastSupported && <><span><i className="legend-line predicted" />{t("chart.predicted")}</span><span><i className="legend-area" />{t("chart.confidence")}</span></>}</div>
      <div className="chart-wrap">
        <svg className="trend-chart" viewBox={`0 0 ${width} ${height}`} role="group" aria-label={t("chart.aria", { metric: metricLabel, sensor: sensor.name })}>
          <title>{t("chart.aria", { metric: metricLabel, sensor: sensor.name })}</title>
          <g className="chart-grid" aria-hidden="true">
            {yTicks.map((tick, index) => <line key={`grid-y-${index}-${tick}`} x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} />)}
          </g>
          <g className="chart-axis" aria-hidden="true">
            {yTicks.map((tick, index) => <text key={`axis-y-${index}-${tick}`} x={margin.left - 10} y={y(tick) + 4} textAnchor="end">{toDisplayValue(tick, definition, units).toFixed(definition.precision)}</text>)}
            {xTicks.map((tick, index) => <text key={`axis-x-${index}-${tick}`} x={x(tick)} y={height - 10} textAnchor={tick === timeMin ? "start" : tick === timeMax ? "end" : "middle"}>{new Intl.DateTimeFormat(locale, range === "7d" ? { weekday: "short", hour: "2-digit" } : { hour: "2-digit", minute: "2-digit" }).format(tick)}</text>)}
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
                role="img" tabIndex={0}
                aria-label={`${new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(point.timestamp)}, ${formatMeasurement(point.value, definition, units)}, ${point.kind === "history" ? t("chart.observed") : t("chart.predicted")}`}
                onFocus={() => setFocused(point)} onBlur={() => setFocused(null)} onMouseEnter={() => setFocused(point)} onMouseLeave={() => setFocused(null)}
              />
            ))}
          </g>
          {focused && <g className="chart-focus" aria-hidden="true"><line x1={x(focused.timestamp)} x2={x(focused.timestamp)} y1={margin.top} y2={height - margin.bottom} /><circle cx={x(focused.timestamp)} cy={y(focused.value)} r="4" /></g>}
        </svg>
        {focused && <div className="chart-tooltip" role="status"><strong>{focusValue}</strong><span>{new Intl.DateTimeFormat(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(focused.timestamp)} · {focused.kind === "history" ? t("chart.observed") : t("chart.predicted")}</span></div>}
      </div>
      {!definition.forecastSupported && <p className="chart-capability-note">{t("chart.forecastUnsupported", { metric: metricLabel })}</p>}
    </section>
  );
}

function ChartHeader({ sensor, range, onRange }: { sensor: Sensor; range: TimeRange; onRange: (range: TimeRange) => void }) {
  const { t } = useI18n();
  return (
    <div className="panel-header chart-heading">
      <div><span className="eyebrow">{t("chart.title")}</span><h2>{sensor.name}</h2></div>
      <div className="segmented compact" role="group" aria-label={t("chart.history")}>
        {(["6h", "24h", "7d"] as const).map((item) => <button key={item} type="button" aria-pressed={range === item} onClick={() => onRange(item)}>{t(`chart.range${item}`)}</button>)}
      </div>
    </div>
  );
}
