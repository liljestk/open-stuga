import { useEffect, useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from "react";
import type { MeasurementDefinition, UnitSystem } from "@climate-twin/contracts";
import { splitSeriesAtGaps, type DisplayDataGap } from "../chartGaps";
import { formatInTimeZone } from "../dateTime";
import type { TimeRange } from "../domain";
import { useI18n } from "../i18n";
import { displayUnit, formatMeasurement, toDisplayValue } from "../measurements";

export interface SeriesPoint {
  timestamp: number;
  value: number;
}

export interface ForecastSeriesPoint extends SeriesPoint {
  low: number;
  high: number;
}

export interface AggregateSeriesPoint extends SeriesPoint {
  low: number;
  high: number;
  sensorCount: number;
}

export interface SensorAnalyticsPlotData {
  observed: Array<{ sensor: { id: string; name: string }; points: SeriesPoint[] }>;
  aggregate: AggregateSeriesPoint[];
  aggregateForecast: AggregateSeriesPoint[];
  outdoorObserved: SeriesPoint[];
  outdoorForecast: SeriesPoint[];
  electricityPrice: SeriesPoint[];
}

interface SensorAnalyticsPlotProps {
  data: SensorAnalyticsPlotData;
  fitContainer?: boolean;
  definition: MeasurementDefinition;
  units: UnitSystem;
  range: TimeRange;
  timeZone: string;
  from: number;
  now: number;
  timeMax: number;
  domain: { min: number; max: number };
  chartLabel: string;
  summary: string;
  summaryId: string;
  isCombined: boolean;
  latestAggregate?: AggregateSeriesPoint | undefined;
  missingIntervals: DisplayDataGap[];
  gapThresholdMs: number;
  forecastGapThresholdMs: number;
  aggregateLabel: string;
  predictionLabel: string;
}

interface HoverSeries {
  id: string;
  label: string;
  className: string;
  points: SeriesPoint[];
  interpolation: "linear" | "step";
  gapThresholdMs: number;
  pointerPriority: number;
  keyboardPriority: number;
}

interface HoverDatum {
  seriesId: string;
  label: string;
  className: string;
  timestamp: number;
  value: number;
  x: number;
  y: number;
  origin: "pointer" | "keyboard";
}

const defaultWidth = 1_100;
const height = 300;
const margin = { top: 24, right: 28, bottom: 38, left: 62 };
const tooltipWidth = 218;
const tooltipHeight = 65;
const pointerTolerancePx = 24;
export const sensorDashes = [undefined, "10 5", "3 4", "12 4 3 4"] as const;

function tickDateOptions(range: TimeRange): Intl.DateTimeFormatOptions {
  if (range === "6h" || range === "24h") return { hour: "2-digit", minute: "2-digit" };
  if (range === "7d") return { weekday: "short", hour: "2-digit" };
  if (range === "1y") return { month: "short" };
  return { month: "short", day: "numeric" };
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

export function interpolatedSeriesValue(
  points: readonly SeriesPoint[],
  timestamp: number,
  interpolation: HoverSeries["interpolation"],
  gapThresholdMs: number,
): number | null {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || timestamp < first.timestamp - 1 || timestamp > last.timestamp + 1) return null;
  const boundedTimestamp = Math.min(last.timestamp, Math.max(first.timestamp, timestamp));
  if (boundedTimestamp === first.timestamp) return first.value;
  if (boundedTimestamp === last.timestamp) return last.value;

  let low = 1;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle]!.timestamp < boundedTimestamp) low = middle + 1;
    else high = middle;
  }
  const right = points[low];
  const left = points[low - 1];
  if (!left || !right || right.timestamp - left.timestamp > gapThresholdMs) return null;
  if (interpolation === "step") return left.value;
  const progress = (boundedTimestamp - left.timestamp) / Math.max(right.timestamp - left.timestamp, 1);
  return left.value + (right.value - left.value) * progress;
}

function nearestPointIndex(points: readonly SeriesPoint[], timestamp: number): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle]!.timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  if (low === points.length) return points.length - 1;
  return timestamp - points[low - 1]!.timestamp <= points[low]!.timestamp - timestamp ? low - 1 : low;
}

function shortenedLabel(label: string): string {
  return label.length > 29 ? `${label.slice(0, 28)}…` : label;
}

export function SensorAnalyticsPlot(props: Readonly<SensorAnalyticsPlotProps>) {
  const { locale, t } = useI18n();
  const clipId = `${useId().replace(/:/g, "")}-sensor-analytics-clip`;
  const gapPatternId = `${clipId}-missing-pattern`;
  const hintId = `${clipId}-interaction-hint`;
  const [hover, setHover] = useState<HoverDatum | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(defaultWidth);
  const width = props.fitContainer ? containerWidth : defaultWidth;
  useEffect(() => {
    const element = containerRef.current;
    if (!props.fitContainer || !element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) {
        setContainerWidth(Math.max(240, Math.round(entry.contentRect.width)));
        setHover(null);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.fitContainer]);
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const x = (timestamp: number) => margin.left + (timestamp - props.from) / Math.max(props.timeMax - props.from, 1) * plotWidth;
  const y = (value: number) => margin.top + (props.domain.max - value) / Math.max(props.domain.max - props.domain.min, Number.EPSILON) * plotHeight;
  const tickCount = width < 480 ? 2 : width < 760 ? 3 : 5;
  const xTicks = Array.from({ length: tickCount }, (_, index) => props.from + (props.timeMax - props.from) * index / (tickCount - 1));
  const yTicks = Array.from({ length: 4 }, (_, index) => props.domain.max - (props.domain.max - props.domain.min) * index / 3);
  const hoverSeries = useMemo<HoverSeries[]>(() => [
    ...props.data.observed.flatMap(({ sensor, points }, index) => points.length > 0 ? [{
      id: `sensor:${sensor.id}`,
      label: sensor.name,
      className: `series-${index % 6}`,
      points,
      interpolation: "linear" as const,
      gapThresholdMs: props.gapThresholdMs,
      pointerPriority: 1,
      keyboardPriority: props.isCombined ? 2 : 8,
    }] : []),
    ...(props.isCombined && props.data.aggregate.length > 0 ? [{
      id: "aggregate",
      label: props.aggregateLabel,
      className: "aggregate",
      points: props.data.aggregate,
      interpolation: "linear" as const,
      gapThresholdMs: props.gapThresholdMs,
      pointerPriority: 8,
      keyboardPriority: 10,
    }] : []),
    ...(props.data.aggregateForecast.length > 0 ? [{
      id: "prediction",
      label: props.predictionLabel,
      className: "prediction",
      points: props.data.aggregateForecast,
      interpolation: "linear" as const,
      gapThresholdMs: props.forecastGapThresholdMs,
      pointerPriority: 7,
      keyboardPriority: 5,
    }] : []),
    ...(props.data.outdoorObserved.length > 0 ? [{
      id: "outdoor",
      label: t("decision.outdoor"),
      className: "outdoor",
      points: props.data.outdoorObserved,
      interpolation: "linear" as const,
      gapThresholdMs: props.gapThresholdMs,
      pointerPriority: 5,
      keyboardPriority: 7,
    }] : []),
    ...(props.data.outdoorForecast.length > 0 ? [{
      id: "outdoor-forecast",
      label: t("analytics.outdoorForecast"),
      className: "outdoor-forecast",
      points: props.data.outdoorForecast,
      interpolation: "linear" as const,
      gapThresholdMs: props.forecastGapThresholdMs,
      pointerPriority: 4,
      keyboardPriority: 4,
    }] : []),
    ...(props.data.electricityPrice.length > 0 ? [{
      id: "electricity-price",
      label: t("sensors.analyticsPropertyPrice"),
      className: "electricity-price",
      points: props.data.electricityPrice,
      interpolation: "step" as const,
      gapThresholdMs: props.forecastGapThresholdMs,
      pointerPriority: 6,
      keyboardPriority: 9,
    }] : []),
  ], [props.aggregateLabel, props.data, props.forecastGapThresholdMs, props.gapThresholdMs, props.isCombined, props.predictionLabel, t]);
  const primarySeries = hoverSeries.reduce<HoverSeries | null>((best, series) => (
    !best || series.keyboardPriority > best.keyboardPriority ? series : best
  ), null);

  const showKeyboardPoint = (index: number) => {
    const point = primarySeries?.points[index];
    if (!primarySeries || !point) return;
    setHover({
      seriesId: primarySeries.id,
      label: primarySeries.label,
      className: primarySeries.className,
      timestamp: point.timestamp,
      value: point.value,
      x: x(point.timestamp),
      y: y(point.value),
      origin: "keyboard",
    });
  };

  const handlePointer = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const pointerX = (event.clientX - bounds.left) / bounds.width * width;
    const pointerY = (event.clientY - bounds.top) / bounds.height * height;
    if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY)) return;
    if (pointerX < margin.left || pointerX > width - margin.right || pointerY < margin.top || pointerY > height - margin.bottom) {
      setHover(null);
      return;
    }
    const timestamp = props.from + (pointerX - margin.left) / plotWidth * (props.timeMax - props.from);
    let best: HoverDatum | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestPriority = -1;
    for (const series of hoverSeries) {
      const value = interpolatedSeriesValue(series.points, timestamp, series.interpolation, series.gapThresholdMs);
      if (value === null) continue;
      const pointY = y(value);
      const distance = Math.abs(pointY - pointerY) / height * bounds.height;
      if (distance > pointerTolerancePx
        || (distance > bestDistance - 0.5 && (distance >= bestDistance + 0.5 || series.pointerPriority <= bestPriority))) continue;
      bestDistance = distance;
      bestPriority = series.pointerPriority;
      best = {
        seriesId: series.id,
        label: series.label,
        className: series.className,
        timestamp,
        value,
        x: pointerX,
        y: pointY,
        origin: "pointer",
      };
    }
    setHover(best);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!primarySeries || primarySeries.points.length === 0) return;
    const currentIndex = hover?.seriesId === primarySeries.id
      ? nearestPointIndex(primarySeries.points, hover.timestamp)
      : primarySeries.points.length - 1;
    let nextIndex: number | null = null;
    if (event.key === "ArrowLeft") nextIndex = Math.max(0, currentIndex - 1);
    if (event.key === "ArrowRight") nextIndex = Math.min(primarySeries.points.length - 1, currentIndex + 1);
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = primarySeries.points.length - 1;
    if (event.key === "Escape") {
      event.preventDefault();
      setHover(null);
      return;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    showKeyboardPoint(nextIndex);
  };

  const handleFocus = (_event: FocusEvent<HTMLDivElement>) => {
    if (!hover && primarySeries) showKeyboardPoint(primarySeries.points.length - 1);
  };
  const tooltipTime = hover
    ? formatInTimeZone(hover.timestamp, locale, props.timeZone, { dateStyle: "medium", timeStyle: "short" })
    : "";
  const tooltipValue = hover ? formatMeasurement(hover.value, props.definition, props.units) : "";
  const tooltipX = hover
    ? Math.max(4, Math.min(width - tooltipWidth - 4, hover.x > width - margin.right - tooltipWidth - 18 ? hover.x - tooltipWidth - 14 : hover.x + 14))
    : 0;
  const tooltipY = hover
    ? (hover.y > margin.top + tooltipHeight + 18 ? hover.y - tooltipHeight - 12 : hover.y + 12)
    : 0;

  return <div
    ref={containerRef}
    className="sensor-analytics-chart-wrap"
    role="region"
    aria-label={props.chartLabel}
    aria-describedby={`${props.summaryId} ${hintId}`}
    aria-keyshortcuts="ArrowLeft ArrowRight Home End Escape"
    tabIndex={0}
    onFocus={handleFocus}
    onBlur={() => setHover(null)}
    onKeyDown={handleKeyDown}
  >
    <p id={props.summaryId} className="sr-only">{props.summary}</p>
    <p id={hintId} className="sr-only">{t("analytics.chartInteractionHint")}</p>
    <p className="sr-only" aria-live="polite">{hover ? `${tooltipTime}. ${hover.label}: ${tooltipValue}` : ""}</p>
    <svg
      className="sensor-analytics-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={props.chartLabel}
      aria-describedby={props.summaryId}
      onPointerMove={handlePointer}
      onPointerDown={handlePointer}
      onPointerLeave={() => setHover((current) => current?.origin === "pointer" ? null : current)}
    >
      <title>{props.chartLabel}</title>
      <defs>
        <clipPath id={clipId}><rect x={margin.left} y={margin.top} width={plotWidth} height={plotHeight} /></clipPath>
        <pattern id={gapPatternId} width="8" height="8" patternUnits="userSpaceOnUse"><path className="sensor-data-gap-hatch" d="M-2 2 L2 -2 M0 8 L8 0 M6 10 L10 6" /></pattern>
      </defs>
      <g className="chart-grid" aria-hidden="true">{yTicks.map((tick, index) => <line key={`${tick}-${index}`} x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} />)}</g>
      <g className="chart-axis" aria-hidden="true">
        {yTicks.map((tick, index) => <text key={`${tick}-${index}`} x={margin.left - 10} y={y(tick) + 4} textAnchor="end">{props.fitContainer ? new Intl.NumberFormat(locale, { maximumFractionDigits: Math.abs(props.domain.max - props.domain.min) >= 10 ? 1 : props.definition.precision }).format(toDisplayValue(tick, props.definition, props.units)) : toDisplayValue(tick, props.definition, props.units).toFixed(props.definition.precision)}</text>)}
        {xTicks.map((tick, index) => <text key={tick} x={x(tick)} y={height - 10} textAnchor={index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle"}>{formatInTimeZone(tick, locale, props.timeZone, (props.fitContainer && props.range === "7d") ? { month: "short", day: "numeric" } : (props.fitContainer && props.range === "1y") ? { month: "short", year: "2-digit" } : tickDateOptions(props.range))}</text>)}
        <text x="7" y="16">{displayUnit(props.definition, props.units)}</text>
      </g>
      <g clipPath={`url(#${clipId})`} aria-hidden="true">
        <rect className="sensor-analytics-hit-area" x={margin.left} y={margin.top} width={plotWidth} height={plotHeight} />
        {props.missingIntervals.map((gap, index) => <rect key={`missing-${gap.startedAt}-${gap.endedAt}-${index}`}
          className="sensor-data-gap-region" x={x(gap.startedAt)} y={margin.top}
          width={Math.max(1, x(gap.endedAt) - x(gap.startedAt))} height={plotHeight} fill={`url(#${gapPatternId})`} />)}
        {props.isCombined && props.definition.id !== "power" && props.definition.id !== "energy" && splitSeriesAtGaps(props.data.aggregate, props.gapThresholdMs).map((segment, index) => segment.length > 1 && <polygon key={`aggregate-range-${index}`} className="sensor-aggregate-range" points={areaPoints(segment, x, y)} />)}
        {splitSeriesAtGaps(props.data.aggregateForecast, props.forecastGapThresholdMs).map((segment, index) => segment.length > 1 && <polygon key={`prediction-range-${index}`} className="sensor-prediction-range" points={areaPoints(segment, x, y)} />)}
        {props.data.observed.flatMap((series, index) => splitSeriesAtGaps(series.points, props.gapThresholdMs).map((segment, segmentIndex) => segment.length > 1 && <path key={`${series.sensor.id}-${segmentIndex}`} className={`sensor-series-line series-${index % 6}`} strokeDasharray={sensorDashes[index % sensorDashes.length]} d={linePath(segment, x, y)} />))}
        {props.isCombined && splitSeriesAtGaps(props.data.aggregate, props.gapThresholdMs).map((segment, index) => segment.length > 1 && <path key={`aggregate-${index}`} className="sensor-aggregate-line" d={linePath(segment, x, y)} />)}
        {splitSeriesAtGaps(props.data.aggregateForecast, props.forecastGapThresholdMs).map((segment, index) => segment.length > 1 && <path key={`prediction-${index}`} className="sensor-prediction-line" d={linePath(segment, x, y)} />)}
        {splitSeriesAtGaps(props.data.outdoorObserved, props.gapThresholdMs).map((segment, index) => segment.length > 1 && <path key={`outdoor-${index}`} className="sensor-outdoor-line" d={linePath(segment, x, y)} />)}
        {splitSeriesAtGaps(props.data.outdoorForecast, props.forecastGapThresholdMs).map((segment, index) => segment.length > 1 && <path key={`outdoor-forecast-${index}`} className="sensor-outdoor-forecast-line" d={linePath(segment, x, y)} />)}
        {props.data.electricityPrice.length > 1 && <path className="sensor-electricity-price-line" d={stepLinePath(props.data.electricityPrice, x, y)} />}
        <line className="sensor-analytics-now" x1={x(props.now)} x2={x(props.now)} y1={margin.top} y2={height - margin.bottom} />
      </g>
      {props.latestAggregate && <g className="sensor-analytics-end-label" aria-hidden="true"><circle cx={x(props.latestAggregate.timestamp)} cy={y(props.latestAggregate.value)} r="4" /><text x={Math.min(width - margin.right - 4, x(props.latestAggregate.timestamp) + 8)} y={y(props.latestAggregate.value) - 8} textAnchor={x(props.latestAggregate.timestamp) > width - 120 ? "end" : "start"}>{formatMeasurement(props.latestAggregate.value, props.definition, props.units)}</text></g>}
      {hover && <g className="sensor-analytics-hover" aria-hidden="true">
        <line className="sensor-analytics-hover-crosshair" x1={hover.x} x2={hover.x} y1={margin.top} y2={height - margin.bottom} />
        <circle className={`sensor-analytics-hover-dot ${hover.className}`} cx={hover.x} cy={hover.y} r="5" />
        <g className="sensor-analytics-tooltip" transform={`translate(${tooltipX} ${tooltipY})`}>
          <rect width={tooltipWidth} height={tooltipHeight} rx="5" />
          <text className="sensor-analytics-tooltip-time" x="11" y="17">{tooltipTime}</text>
          <circle className={`sensor-analytics-tooltip-marker ${hover.className}`} cx="13" cy="36" r="3" />
          <text className="sensor-analytics-tooltip-label" x="22" y="40">{shortenedLabel(hover.label)}</text>
          <text className="sensor-analytics-tooltip-value" x="11" y="57">{tooltipValue}</text>
          <title>{hover.label}</title>
        </g>
      </g>}
    </svg>
  </div>;
}
