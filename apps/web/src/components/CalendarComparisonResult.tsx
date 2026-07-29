import { useId, useMemo } from "react";
import type {
  CalendarComparisonBucket,
  CalendarComparisonPeriod,
  CalendarComparisonResponse,
  MeasurementDefinition,
  Sensor,
  UnitSystem,
} from "@climate-twin/contracts";
import {
  calendarPeriodSeries,
  type CalendarComparisonSource,
  type CalendarPeriodSeries,
} from "../calendarComparisonView";
import { formatInTimeZone } from "../dateTime";
import { useI18n } from "../i18n";
import {
  displayUnit,
  formatMeasurement,
  formatMeasurementDelta,
  measurementDomain,
  toDisplayValue,
} from "../measurements";

interface CalendarComparisonResultProps {
  loaded: CalendarComparisonResponse;
  sensors: Sensor[];
  source: CalendarComparisonSource;
  sourceLabel: string;
  definition: MeasurementDefinition;
  units: UnitSystem;
  timeZone: string;
  periodLabel: (period: CalendarComparisonPeriod, compact?: boolean) => string;
}

interface Slot {
  id: string;
  order: number;
  reference: CalendarComparisonBucket;
  period: CalendarComparisonPeriod;
}

const width = 1_100;
const height = 330;
const margin = { top: 22, right: 28, bottom: 54, left: 62 };

function linePath(
  series: CalendarPeriodSeries,
  indexBySlot: Map<string, number>,
  x: (index: number) => number,
  y: (value: number) => number,
): string {
  return series.points
    .map((point) => ({ point, index: indexBySlot.get(point.bucket.slot) }))
    .filter((item): item is { point: typeof item.point; index: number } => item.index !== undefined)
    .sort((left, right) => left.index - right.index)
    .map((item, index, points) => {
      const previous = points[index - 1];
      const command = !previous || item.index !== previous.index + 1 ? "M" : "L";
      return `${command}${x(item.index).toFixed(1)} ${y(item.point.value).toFixed(1)}`;
    })
    .join(" ");
}

function numericPart(value: string, timeZone: string, type: "day" | "year"): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    day: type === "day" ? "numeric" : undefined,
    year: type === "year" ? "numeric" : undefined,
  }).formatToParts(new Date(value));
  return Number(parts.find((part) => part.type === type)?.value);
}

function bucketLabel(
  bucket: CalendarComparisonBucket,
  period: CalendarComparisonPeriod,
  locale: string,
  timeZone: string,
  compact = false,
): string {
  if (period.unit === "day") {
    return formatInTimeZone(bucket.start, locale, timeZone, {
      hour: "2-digit",
      minute: "2-digit",
      ...(bucket.slot.endsWith("-1") ? { timeZoneName: "short" } : {}),
    });
  }
  if (period.unit === "week") {
    return formatInTimeZone(bucket.start, locale, timeZone, compact
      ? { weekday: "short" }
      : { weekday: "long", month: "short", day: "numeric" });
  }
  if (period.unit === "month") {
    const start = numericPart(bucket.start, timeZone, "day");
    const end = numericPart(new Date(Date.parse(bucket.end) - 1).toISOString(), timeZone, "day");
    return `${start}–${end}`;
  }
  if (period.unit === "year") {
    return formatInTimeZone(bucket.start, locale, timeZone, { month: compact ? "short" : "long" });
  }
  return String(numericPart(bucket.start, timeZone, "year"));
}

function marker(
  seriesIndex: number,
  key: string,
  cx: number,
  cy: number,
  partial: boolean,
) {
  const className = partial ? "partial" : undefined;
  if (seriesIndex % 3 === 0) return <circle key={key} className={className} cx={cx} cy={cy} r="3.5" />;
  if (seriesIndex % 3 === 1) return <rect key={key} className={className} x={cx - 3.5} y={cy - 3.5} width="7" height="7" />;
  return <path key={key} className={`calendar-comparison-marker${partial ? " partial" : ""}`} d={`M${cx} ${cy - 4} L${cx + 4} ${cy} L${cx} ${cy + 4} L${cx - 4} ${cy} Z`} />;
}

function signedDelta(value: number, definition: MeasurementDefinition, units: UnitSystem): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatMeasurementDelta(value, definition, units)}`;
}

export function CalendarComparisonResult(props: Readonly<CalendarComparisonResultProps>) {
  const { locale, t } = useI18n();
  const summaryId = useId();
  const series = useMemo(
    () => calendarPeriodSeries(props.loaded, props.source),
    [props.loaded, props.source],
  );
  const slots = useMemo(() => {
    const bySlot = new Map<string, Slot>();
    for (const item of series) {
      for (const { bucket } of item.points) {
        if (!bySlot.has(bucket.slot)) bySlot.set(bucket.slot, {
          id: bucket.slot,
          order: bucket.order,
          reference: bucket,
          period: item.period,
        });
      }
    }
    return [...bySlot.values()].sort((left, right) => left.order - right.order);
  }, [series]);
  const indexBySlot = new Map(slots.map((slot, index) => [slot.id, index]));
  const values = series.flatMap((item) => item.points.map((point) => point.value));
  const domain = measurementDomain(props.definition, values);
  const summaries = series.map((item) => ({
    series: item,
    summary: item.summary,
  }));
  const serverComparison = props.loaded.comparisons.find((item) => (
    item.sourceId === props.source
    && item.currentSeriesId === series[0]?.id
    && item.baselineSeriesId === series[1]?.id
  ));
  const delta = serverComparison?.difference ?? null;

  if (!domain || slots.length === 0 || values.length === 0) return null;
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const x = (index: number) => slots.length < 2
    ? margin.left + plotWidth / 2
    : margin.left + index / (slots.length - 1) * plotWidth;
  const y = (value: number) => margin.top + (domain.max - value)
    / Math.max(domain.max - domain.min, Number.EPSILON) * plotHeight;
  const yTicks = Array.from({ length: 4 }, (_, index) => domain.max - (domain.max - domain.min) * index / 3);
  const xTickIndexes = slots.length <= 12
    ? slots.map((_, index) => index)
    : [...new Set(Array.from({ length: 8 }, (_, index) => Math.round((slots.length - 1) * index / 7)))];
  const chartSummary = t("analytics.comparisonPeriodAria", {
    metric: props.definition.labels[locale] ?? props.definition.labels.en ?? props.definition.id,
    count: series.length,
    source: props.sourceLabel,
  });

  return <>
    <div className="calendar-comparison-period-summaries">
      {summaries.map(({ series: item, summary }) => <article key={item.id}>
        <span>{props.periodLabel(item.period)}</span>
        <strong>{summary ? formatMeasurement(summary.value, props.definition, props.units) : "—"}</strong>
        <small>{summary
          ? t("analytics.comparisonSummaryCoverage", {
            coverage: Math.round(summary.coverage * 100),
            count: summary.bucketCount,
          })
          : t("analytics.comparisonNoCompletedBuckets")}</small>
        {item.period.partial && <em>{t("analytics.comparisonPartial")}</em>}
      </article>)}
      {delta !== null && <article className="calendar-comparison-delta">
        <span>{t("analytics.comparisonDifference")}</span>
        <strong>{signedDelta(delta, props.definition, props.units)}</strong>
        <small>{t("analytics.comparisonDifferenceContext", {
          current: props.periodLabel(series[0]!.period, true),
          baseline: props.periodLabel(series[1]!.period, true),
          count: serverComparison?.commonCompletedBucketCount ?? 0,
        })}</small>
      </article>}
    </div>
    {props.source === "combined" && props.sensors.length > 1 && <p className="calendar-comparison-cohort">
      {t("analytics.comparisonStableCohort", { count: props.sensors.length })}
    </p>}
    <div className="calendar-comparison-legend" aria-label={t("analytics.comparisonLegend")}>
      {series.map((item, index) => item.points.length > 0 && <span key={item.id}>
        <i className={`period-${index % 4}`} aria-hidden="true" />{props.periodLabel(item.period)}
      </span>)}
      {series.some((item) => item.points.some((point) => point.bucket.partial)) && <span>
        <i className="partial" aria-hidden="true" />{t("analytics.comparisonPartialBucket")}
      </span>}
    </div>
    <div className="calendar-comparison-chart-wrap" role="region" aria-label={chartSummary} tabIndex={0}>
      <p id={summaryId} className="sr-only">{chartSummary}</p>
      <svg className="calendar-comparison-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={chartSummary} aria-describedby={summaryId}>
        <g className="chart-grid" aria-hidden="true">{yTicks.map((tick) => <line key={tick} x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} />)}</g>
        <g className="chart-axis" aria-hidden="true">
          <text className="calendar-comparison-unit" x="7" y="16">{displayUnit(props.definition, props.units)}</text>
          {yTicks.map((tick) => <text key={tick} x={margin.left - 10} y={y(tick) + 4} textAnchor="end">{toDisplayValue(tick, props.definition, props.units).toFixed(props.definition.precision)}</text>)}
          {xTickIndexes.map((index, tickIndex) => <text key={slots[index]!.id} x={x(index)} y={height - 14} textAnchor={tickIndex === 0 ? "start" : tickIndex === xTickIndexes.length - 1 ? "end" : "middle"}>
            {series[0]?.period.unit === "decade"
              ? t("analytics.comparisonYearPosition", { position: index + 1 })
              : bucketLabel(slots[index]!.reference, slots[index]!.period, locale, props.timeZone, true)}
          </text>)}
        </g>
        <g aria-hidden="true">{series.map((item, seriesIndex) => <g key={item.id} className={`calendar-comparison-series period-${seriesIndex % 4}`}>
          {item.points.length > 1 && <path d={linePath(item, indexBySlot, x, y)} />}
          {item.points.map((point) => marker(
            seriesIndex,
            point.bucket.key,
            x(indexBySlot.get(point.bucket.slot) ?? 0),
            y(point.value),
            point.bucket.partial,
          ))}
        </g>)}</g>
      </svg>
    </div>
    <details className="calendar-comparison-table-details">
      <summary>{t("analytics.comparisonShowBuckets", { count: slots.length })}</summary>
      <div className="calendar-comparison-table-wrap" role="region" aria-label={t("analytics.comparisonTable")} tabIndex={0}>
        <table>
          <thead><tr>
            <th scope="col">{t("analytics.comparisonBreakdown")}</th>
            {series.map((item) => <th key={item.id} scope="col">{props.periodLabel(item.period)}</th>)}
            {series.length === 2 && <th scope="col">{t("analytics.comparisonDifference")}</th>}
          </tr></thead>
          <tbody>{slots.map((slot, slotIndex) => {
            const points = series.map((item) => item.points.find((point) => point.bucket.slot === slot.id));
            const rowDelta = points.length === 2 && points[0] && points[1] ? points[0].value - points[1].value : null;
            return <tr key={slot.id}>
              <th scope="row">{series[0]?.period.unit === "decade"
                ? t("analytics.comparisonYearPosition", { position: slotIndex + 1 })
                : bucketLabel(slot.reference, slot.period, locale, props.timeZone)}</th>
              {points.map((point, index) => <td key={series[index]!.id}>
                {point ? <><strong>{formatMeasurement(point.value, props.definition, props.units)}</strong><small>
                  {t("analytics.comparisonCellEvidence", {
                    coverage: Math.round(point.coverage * 100),
                    samples: point.sampleCount,
                  })}
                  {point.bucket.partial ? ` · ${t("analytics.comparisonPartial")}` : ""}
                </small></> : "—"}
              </td>)}
              {series.length === 2 && <td>{rowDelta === null ? "—" : signedDelta(rowDelta, props.definition, props.units)}</td>}
            </tr>;
          })}</tbody>
        </table>
      </div>
    </details>
  </>;
}
