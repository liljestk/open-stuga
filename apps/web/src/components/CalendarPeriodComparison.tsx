import { useEffect, useId, useMemo, useState } from "react";
import { CalendarRange, RefreshCw } from "lucide-react";
import type {
  AnalyticsAggregation,
  AnalyticsSampleQuality,
  MeasurementDefinition,
  Metric,
  Sensor,
  UnitSystem,
} from "@climate-twin/contracts";
import { ApiRequestError, api } from "../api";
import {
  CALENDAR_COMPARISON_UNITS,
  appendAnalyticsSeries,
  calendarAccumulatorValue,
  calendarComparisonPeriods,
  comparisonAggregationOptions,
  createCalendarValueAccumulator,
  splitCalendarAnalyticsRange,
  type CalendarComparisonAnchor,
  type CalendarComparisonPeriod,
  type CalendarComparisonUnit,
  type CalendarComparisonValue,
  type CalendarValueAccumulator,
} from "../calendarComparison";
import { formatInTimeZone } from "../dateTime";
import { useI18n } from "../i18n";
import {
  displayUnit,
  formatMeasurement,
  measurementDomain,
  toDisplayValue,
} from "../measurements";

interface CalendarPeriodComparisonProps {
  houseId: string;
  timeZone: string;
  dataMode: "demo" | "real" | "unknown";
  sensors: Sensor[];
  metric: Metric;
  definition: MeasurementDefinition;
  units: UnitSystem;
}

type QualityPreset = "good" | "reliable" | "all";

interface LoadedComparison {
  periods: CalendarComparisonPeriod[];
  values: Map<string, Map<string, CalendarValueAccumulator>>;
  complete: boolean;
  archiveState: string;
}

interface ComparisonPoint extends CalendarComparisonValue {
  period: CalendarComparisonPeriod;
}

interface ComparisonSeries {
  id: string;
  label: string;
  combined: boolean;
  points: ComparisonPoint[];
}

const width = 1_100;
const height = 310;
const margin = { top: 22, right: 28, bottom: 48, left: 62 };
const RETRYABLE_BUDGET_CODES = new Set([
  "ANALYTICS_SOURCE_POINT_LIMIT_EXCEEDED",
  "ANALYTICS_QUERY_TOO_LARGE",
  "ANALYTICS_POINT_LIMIT_EXCEEDED",
]);

function qualities(preset: QualityPreset): AnalyticsSampleQuality[] {
  if (preset === "good") return ["good"];
  if (preset === "reliable") return ["good", "estimated"];
  return ["good", "estimated", "stale"];
}

function defaultAnchor(timeZone: string): CalendarComparisonAnchor {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes, fallback: number) => Number(parts.find((part) => part.type === type)?.value) || fallback;
  const now = new Date();
  const utc = new Date(Date.UTC(value("year", now.getUTCFullYear()), value("month", now.getUTCMonth() + 1) - 1, value("day", now.getUTCDate())));
  const weekday = utc.getUTCDay() || 7;
  const thursday = new Date(utc.getTime() + (4 - weekday) * 86_400_000);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstWeekday = firstThursday.getUTCDay() || 7;
  const firstWeekStart = firstThursday.getTime() - (firstWeekday - 1) * 86_400_000;
  return {
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
    week: Math.floor((thursday.getTime() - firstWeekStart) / (7 * 86_400_000)) + 1,
  };
}

function daysInAnchorMonth(month: number): number {
  return new Date(Date.UTC(2024, month, 0)).getUTCDate();
}

function pointBudget(unit: CalendarComparisonUnit): number {
  if (unit === "day") return 500;
  if (unit === "week" || unit === "month") return 1_000;
  return 5_000;
}

function retryableBudget(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.status === 422 && Boolean(error.code && RETRYABLE_BUDGET_CODES.has(error.code));
}

async function mapConcurrently<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      await operation(values[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
}

function combinedMode(definition: MeasurementDefinition): "mean" | "sum" {
  return definition.id === "power" || definition.id === "energy"
    || definition.kind === "increment" || definition.kind === "cumulative_counter"
    ? "sum"
    : "mean";
}

function comparisonSeries(
  loaded: LoadedComparison | null,
  sensors: Sensor[],
  definition: MeasurementDefinition,
): { periods: CalendarComparisonPeriod[]; series: ComparisonSeries[] } {
  if (!loaded) return { periods: [], series: [] };
  const individual = sensors.map((sensor) => ({
    id: sensor.id,
    label: sensor.name,
    combined: false,
    points: loaded.periods.flatMap((period) => {
      const accumulator = loaded.values.get(period.key)?.get(sensor.id);
      const value = accumulator ? calendarAccumulatorValue(accumulator) : null;
      return value ? [{ period, ...value }] : [];
    }),
  }));
  if (sensors.length < 2) {
    const visible = new Set(individual.flatMap((series) => series.points.map((point) => point.period.key)));
    return { periods: loaded.periods.filter((period) => visible.has(period.key)), series: individual };
  }
  const mode = combinedMode(definition);
  const combined: ComparisonSeries = {
    id: "combined",
    label: "",
    combined: true,
    points: loaded.periods.flatMap((period) => {
      const values = individual.flatMap((series) => series.points.find((point) => point.period.key === period.key) ?? []);
      // A combined value must retain the same population in every period.
      // Otherwise a missing sensor can masquerade as a real change in the
      // selected-sensors total or average.
      if (values.length !== sensors.length) return [];
      const divisor = mode === "mean" ? values.length : 1;
      return [{
        period,
        value: values.reduce((sum, point) => sum + point.value, 0) / divisor,
        minimum: Math.min(...values.map((point) => point.minimum ?? point.value)),
        maximum: Math.max(...values.map((point) => point.maximum ?? point.value)),
        sampleCount: values.reduce((sum, point) => sum + point.sampleCount, 0),
        coverage: values.reduce((sum, point) => sum + point.coverage, 0) / values.length,
      }];
    }),
  };
  const visible = new Set([...individual, combined].flatMap((series) => series.points.map((point) => point.period.key)));
  return { periods: loaded.periods.filter((period) => visible.has(period.key)), series: [combined, ...individual] };
}

function linePath(
  points: ComparisonPoint[],
  indexByPeriod: Map<string, number>,
  x: (index: number) => number,
  y: (value: number) => number,
): string {
  return points.map((point, index) => {
    const periodIndex = indexByPeriod.get(point.period.key) ?? 0;
    const previousIndex = index === 0 ? undefined : indexByPeriod.get(points[index - 1]!.period.key);
    const command = previousIndex === undefined || periodIndex !== previousIndex + 1 ? "M" : "L";
    return `${command}${x(periodIndex).toFixed(1)} ${y(point.value).toFixed(1)}`;
  }).join(" ");
}

export function CalendarPeriodComparison(props: Readonly<CalendarPeriodComparisonProps>) {
  const { locale, t } = useI18n();
  const summaryId = useId();
  const [open, setOpen] = useState(false);
  const [unit, setUnit] = useState<CalendarComparisonUnit>("month");
  const [anchor, setAnchor] = useState<CalendarComparisonAnchor>(() => defaultAnchor(props.timeZone));
  const [aggregation, setAggregation] = useState<AnalyticsAggregation>("default");
  const [quality, setQuality] = useState<QualityPreset>("reliable");
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<LoadedComparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const sensorKey = props.sensors.map((sensor) => sensor.id).sort().join("\u0000");
  const aggregationOptions = useMemo(() => comparisonAggregationOptions(props.definition.kind), [props.definition.kind]);

  useEffect(() => {
    if (!aggregationOptions.includes(aggregation)) setAggregation("default");
  }, [aggregation, aggregationOptions]);

  useEffect(() => {
    const maxDay = daysInAnchorMonth(anchor.month);
    if (anchor.day > maxDay) setAnchor((current) => ({ ...current, day: maxDay }));
  }, [anchor.day, anchor.month]);

  useEffect(() => {
    if (!open || props.dataMode === "unknown" || props.sensors.length === 0) return;
    const controller = new AbortController();
    let active = true;
    const run = async () => {
      setLoading(true);
      setError(null);
      setProgress({ completed: 0, total: 0 });
      try {
        const coverage = await api.analyticsCoverage({
          apiVersion: "1.0",
          dataMode: props.dataMode === "real" ? "live" : "demo",
          scope: { kind: "house", id: props.houseId, entityIds: props.sensors.map((sensor) => sensor.id) },
          measurementIds: [props.metric],
          requestId: `calendar-coverage-${props.houseId}-${props.metric}-${revision}`,
        }, controller.signal);
        if (!coverage.range.start || !coverage.range.end) {
          if (active) setLoaded({ periods: [], values: new Map(), complete: coverage.complete, archiveState: coverage.archiveState });
          return;
        }
        const periods = calendarComparisonPeriods({
          unit, anchor, coverageStart: coverage.range.start, coverageEnd: coverage.range.end, timeZone: props.timeZone,
        });
        const coverageBySensor = new Map(coverage.series.filter((series) => series.measurementId === props.metric)
          .map((series) => [series.entityId, series]));
        const tasks = periods.map((period) => ({
          period,
          segment: { start: period.start, end: period.end },
        }));
        const values = new Map<string, Map<string, CalendarValueAccumulator>>();
        let requestSequence = 0;
        if (active) setProgress({ completed: 0, total: tasks.length });

        const recordResponse = (
          period: CalendarComparisonPeriod,
          response: Awaited<ReturnType<typeof api.analyticsQuery>>,
          discardBefore: string | null,
        ) => {
          const bySensor = values.get(period.key) ?? new Map<string, CalendarValueAccumulator>();
          for (const series of response.series) {
            if (series.measurementId !== props.metric) continue;
            const accumulator = bySensor.get(series.entityId) ?? createCalendarValueAccumulator(series.aggregation);
            appendAnalyticsSeries(accumulator, discardBefore === null ? series : {
              ...series,
              points: series.points.filter((point) => point.timestamp >= discardBefore),
            });
            bySensor.set(series.entityId, accumulator);
          }
          values.set(period.key, bySensor);
        };

        const queryRange = async (
          period: CalendarComparisonPeriod,
          sensorIds: string[],
          start: string,
          end: string,
          depth = 0,
          discardBefore: string | null = null,
        ): Promise<void> => {
          if (sensorIds.length === 0) return;
          requestSequence += 1;
          try {
            const response = await api.analyticsQuery({
              apiVersion: "1.0",
              dataMode: props.dataMode === "real" ? "live" : "demo",
              scope: { kind: "house", id: props.houseId, entityIds: sensorIds },
              measurementIds: [props.metric],
              range: { start, end, timezone: props.timeZone },
              resolution: "auto",
              aggregation,
              qualityFilter: { include: qualities(quality) },
              include: ["series", "quality", "provenance"],
              maxPointsPerSeries: pointBudget(unit),
              requestId: `calendar-${unit}-${period.key}-${requestSequence}-${revision}`,
            }, controller.signal);
            recordResponse(period, response, discardBefore);
          } catch (queryError) {
            if (!retryableBudget(queryError) || depth >= 12) throw queryError;
            if (sensorIds.length > 1) {
              const middle = Math.ceil(sensorIds.length / 2);
              await queryRange(period, sensorIds.slice(0, middle), start, end, depth + 1, discardBefore);
              await queryRange(period, sensorIds.slice(middle), start, end, depth + 1, discardBefore);
              return;
            }
            const startMs = Date.parse(start);
            const endMs = Date.parse(end);
            if (endMs - startMs <= 2 * 3_600_000) throw queryError;
            const split = splitCalendarAnalyticsRange(start, end, pointBudget(unit));
            if (!split) throw queryError;
            await queryRange(period, sensorIds, start, split.middle, depth + 1, discardBefore);
            const needsCounterContext = aggregation === "delta"
              || (aggregation === "default" && props.definition.kind === "cumulative_counter");
            await queryRange(
              period,
              sensorIds,
              needsCounterContext ? split.overlapStart : split.middle,
              end,
              depth + 1,
              needsCounterContext ? split.middle : null,
            );
          }
        };

        let completed = 0;
        await mapConcurrently(tasks, 4, async ({ period, segment }) => {
          const matchingSensors = props.sensors.flatMap((sensor) => {
            const span = coverageBySensor.get(sensor.id);
            return span && span.start < segment.end && span.end >= segment.start ? [sensor.id] : [];
          });
          await queryRange(period, matchingSensors, segment.start, segment.end);
          completed += 1;
          if (active) setProgress({ completed, total: tasks.length });
        });
        if (active) setLoaded({ periods, values, complete: coverage.complete, archiveState: coverage.archiveState });
      } catch (loadError) {
        if (controller.signal.aborted) return;
        if (active) {
          setLoaded(null);
          setError(loadError instanceof Error ? loadError.message : t("analytics.comparisonFailed"));
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    void run();
    return () => {
      active = false;
      controller.abort();
    };
  }, [aggregation, anchor.day, anchor.month, anchor.week, open, props.dataMode, props.houseId, props.metric, props.sensors, props.timeZone, quality, revision, sensorKey, t, unit]);

  const compared = useMemo(() => comparisonSeries(loaded, props.sensors, props.definition), [loaded, props.definition, props.sensors]);
  const combinedLabel = combinedMode(props.definition) === "sum"
    ? t("analytics.comparisonCombinedTotal")
    : t("analytics.comparisonCombinedAverage");
  const series = compared.series.map((item) => item.combined ? { ...item, label: combinedLabel } : item);
  const periodLabel = (period: CalendarComparisonPeriod, compact = false): string => {
    if (period.unit === "week") return compact
      ? String(period.year)
      : t("analytics.comparisonWeekLabel", { week: period.week ?? 0, year: period.year });
    if (period.unit === "decade") return t("analytics.comparisonDecadeLabel", { start: period.decade ?? period.year, end: (period.decade ?? period.year) + 9 });
    if (period.unit === "year") return String(period.year);
    if (compact) return String(period.year);
    return formatInTimeZone(period.start, locale, props.timeZone, period.unit === "day"
      ? { dateStyle: "medium" }
      : { month: "long", year: "numeric" });
  };

  const indexByPeriod = new Map(compared.periods.map((period, index) => [period.key, index]));
  const values = series.flatMap((item) => item.points.map((point) => point.value));
  const domain = measurementDomain(props.definition, values);
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const x = (index: number) => compared.periods.length < 2
    ? margin.left + plotWidth / 2
    : margin.left + index / (compared.periods.length - 1) * plotWidth;
  const y = (value: number) => margin.top + ((domain?.max ?? 1) - value)
    / Math.max((domain?.max ?? 1) - (domain?.min ?? 0), Number.EPSILON) * plotHeight;
  const yTicks = domain ? Array.from({ length: 4 }, (_, index) => domain.max - (domain.max - domain.min) * index / 3) : [];
  const xTickIndexes = compared.periods.length <= 7
    ? compared.periods.map((_, index) => index)
    : [...new Set(Array.from({ length: 6 }, (_, index) => Math.round((compared.periods.length - 1) * index / 5)))];
  const summary = t("analytics.comparisonAria", {
    metric: props.definition.labels[locale] ?? props.definition.labels.en ?? props.definition.id,
    count: compared.periods.length,
  });
  const unitLabel = displayUnit(props.definition, props.units);

  return <details className="calendar-comparison" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><span><CalendarRange size={17} aria-hidden="true" /><span><strong>{t("analytics.comparisonTitle")}</strong><small>{t("analytics.comparisonDescription")}</small></span></span></summary>
    <div className="calendar-comparison-body" aria-busy={loading}>
      <div className="calendar-comparison-controls" role="group" aria-label={t("analytics.comparisonControls")}>
        <label className="field"><span>{t("analytics.comparisonPeriod")}</span><select value={unit} onChange={(event) => setUnit(event.target.value as CalendarComparisonUnit)}>
          {CALENDAR_COMPARISON_UNITS.map((item) => <option key={item} value={item}>{t(`analytics.comparisonUnit_${item}`)}</option>)}
        </select></label>
        {(unit === "day" || unit === "month") && <label className="field"><span>{t("analytics.comparisonMonth")}</span><select value={anchor.month} onChange={(event) => setAnchor((current) => ({ ...current, month: Number(event.target.value) }))}>
          {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => <option key={month} value={month}>{new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, month - 1, 1)))}</option>)}
        </select></label>}
        {unit === "day" && <label className="field"><span>{t("analytics.comparisonDay")}</span><select value={anchor.day} onChange={(event) => setAnchor((current) => ({ ...current, day: Number(event.target.value) }))}>
          {Array.from({ length: daysInAnchorMonth(anchor.month) }, (_, index) => index + 1).map((day) => <option key={day} value={day}>{day}</option>)}
        </select></label>}
        {unit === "week" && <label className="field"><span>{t("analytics.comparisonWeek")}</span><select value={anchor.week} onChange={(event) => setAnchor((current) => ({ ...current, week: Number(event.target.value) }))}>
          {Array.from({ length: 53 }, (_, index) => index + 1).map((week) => <option key={week} value={week}>{t("analytics.comparisonWeekOption", { week })}</option>)}
        </select></label>}
        <label className="field"><span>{t("analytics.comparisonCalculation")}</span><select value={aggregation} onChange={(event) => setAggregation(event.target.value as AnalyticsAggregation)}>
          {aggregationOptions.map((option) => <option key={option} value={option}>{t(`analytics.aggregation_${option}`)}</option>)}
        </select></label>
        <label className="field"><span>{t("analytics.comparisonQuality")}</span><select value={quality} onChange={(event) => setQuality(event.target.value as QualityPreset)}>
          <option value="good">{t("analytics.quality_good")}</option>
          <option value="reliable">{t("analytics.quality_reliable")}</option>
          <option value="all">{t("analytics.quality_all")}</option>
        </select></label>
        <button type="button" className="secondary-button calendar-comparison-refresh" onClick={() => setRevision((value) => value + 1)} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={14} aria-hidden="true" />{t("common.refresh")}</button>
      </div>

      {loading && <output className="calendar-comparison-status" aria-live="polite" aria-atomic="true">{t("analytics.comparisonLoading", { completed: progress.completed, total: progress.total })}</output>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {loaded && !loaded.complete && <p className="calendar-comparison-warning" role="status">{t("analytics.comparisonArchiveIncomplete")}</p>}
      {!loading && loaded && compared.periods.length === 0 && <div className="empty-state" role="status">{t("analytics.comparisonNoData")}</div>}
      {domain && compared.periods.length > 0 && <>
        <div className="calendar-comparison-summary">
          <span><strong>{compared.periods.length}</strong>{t("analytics.comparisonPeriodsFound")}</span>
          <span><strong>{periodLabel(compared.periods[0]!)}</strong>{t("analytics.comparisonEarliest")}</span>
          <span><strong>{periodLabel(compared.periods.at(-1)!)}</strong>{t("analytics.comparisonLatest")}</span>
        </div>
        <div className="calendar-comparison-legend" aria-label={t("analytics.comparisonLegend")}>
          {series.map((item, index) => item.points.length > 0 && <span key={item.id}><i className={item.combined ? "combined" : `series-${index % 6}`} aria-hidden="true" />{item.label}</span>)}
        </div>
        <div className="calendar-comparison-chart-wrap" role="region" aria-label={summary} tabIndex={0}>
          <p id={summaryId} className="sr-only">{summary}</p>
          <svg className="calendar-comparison-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary} aria-describedby={summaryId}>
            <g className="chart-grid" aria-hidden="true">{yTicks.map((tick) => <line key={tick} x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} />)}</g>
            <g className="chart-axis" aria-hidden="true">
              <text className="calendar-comparison-unit" x="7" y="16">{unitLabel}</text>
              {yTicks.map((tick) => <text key={tick} x={margin.left - 10} y={y(tick) + 4} textAnchor="end">{toDisplayValue(tick, props.definition, props.units).toFixed(props.definition.precision)}</text>)}
              {xTickIndexes.map((index, tickIndex) => <text key={compared.periods[index]!.key} x={x(index)} y={height - 13} textAnchor={tickIndex === 0 ? "start" : tickIndex === xTickIndexes.length - 1 ? "end" : "middle"}>{periodLabel(compared.periods[index]!, true)}</text>)}
            </g>
            <g aria-hidden="true">{series.map((item, index) => <g key={item.id} className={item.combined ? "calendar-comparison-series combined" : `calendar-comparison-series series-${index % 6}`}>
              {item.points.length > 1 && <path d={linePath(item.points, indexByPeriod, x, y)} />}
              {item.points.map((point) => {
                const cx = x(indexByPeriod.get(point.period.key) ?? 0);
                const cy = y(point.value);
                if (item.combined || index % 3 === 0) return <circle key={point.period.key} cx={cx} cy={cy} r={item.combined ? 4 : 3} />;
                if (index % 3 === 1) return <rect key={point.period.key} x={cx - 3} y={cy - 3} width="6" height="6" />;
                return <path key={point.period.key} className="calendar-comparison-marker" d={`M${cx} ${cy - 4} L${cx + 4} ${cy} L${cx} ${cy + 4} L${cx - 4} ${cy} Z`} />;
              })}
            </g>)}</g>
          </svg>
        </div>
        <details className="calendar-comparison-table-details"><summary>{t("analytics.comparisonShowTable", { count: compared.periods.length })}</summary>
          <div className="calendar-comparison-table-wrap" role="region" aria-label={t("analytics.comparisonTable")} tabIndex={0}><table>
            <thead><tr><th scope="col">{t("analytics.comparisonPeriod")}</th><th scope="col">{t("analytics.series")}</th><th scope="col">{t("analytics.value")}</th><th scope="col">{t("analytics.coverageLabel")}</th><th scope="col">{t("analytics.comparisonSamples")}</th></tr></thead>
            <tbody>{compared.periods.flatMap((period) => series.flatMap((item) => {
              const point = item.points.find((candidate) => candidate.period.key === period.key);
              return point ? [<tr key={`${period.key}-${item.id}`}><th scope="row">{periodLabel(period)}</th><td>{item.label}</td><td>{formatMeasurement(point.value, props.definition, props.units)}</td><td>{Math.round(point.coverage * 100)}%</td><td>{point.sampleCount}</td></tr>] : [];
            }))}</tbody>
          </table></div>
        </details>
      </>}
      {props.dataMode === "unknown" && <div className="empty-state" role="status">{t("analytics.comparisonUnavailable")}</div>}
      {props.sensors.length === 0 && <div className="empty-state" role="status">{t("analytics.comparisonChooseSensors")}</div>}
    </div>
  </details>;
}
