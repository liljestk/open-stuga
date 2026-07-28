import { useEffect, useMemo, useState } from "react";
import { CalendarRange, RefreshCw } from "lucide-react";
import type {
  AnalyticsAggregation,
  AnalyticsCoverageResponse,
  AnalyticsResolution,
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
  calendarComparisonBuckets,
  calendarComparisonPeriods,
  comparisonAggregationOptions,
  createCalendarValueAccumulator,
  splitCalendarAnalyticsRange,
  type CalendarComparisonAnchor,
  type CalendarComparisonBucket,
  type CalendarComparisonPeriod,
  type CalendarComparisonUnit,
  type CalendarValueAccumulator,
} from "../calendarComparison";
import {
  calendarPeriodSeries,
  combinedCalendarMode,
  type CalendarComparisonSource,
  type LoadedCalendarComparison,
} from "../calendarComparisonView";
import { formatInTimeZone } from "../dateTime";
import { useI18n } from "../i18n";
import { CalendarComparisonResult } from "./CalendarComparisonResult";

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

interface PeriodSelection {
  primary: string | null;
  comparison: string | null;
}

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

function comparisonResolution(unit: CalendarComparisonUnit): Exclude<AnalyticsResolution, "auto" | "raw"> {
  if (unit === "day") return "1m";
  if (unit === "week") return "5m";
  if (unit === "month" || unit === "year") return "15m";
  return "1h";
}

function comparisonResolutionMilliseconds(unit: CalendarComparisonUnit): number {
  const resolution = comparisonResolution(unit);
  return {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "1d": 86_400_000,
  }[resolution];
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

export function CalendarPeriodComparison(props: Readonly<CalendarPeriodComparisonProps>) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [unit, setUnit] = useState<CalendarComparisonUnit>("month");
  const [anchor, setAnchor] = useState<CalendarComparisonAnchor>(() => defaultAnchor(props.timeZone));
  const [aggregation, setAggregation] = useState<AnalyticsAggregation>("default");
  const [quality, setQuality] = useState<QualityPreset>("reliable");
  const [source, setSource] = useState<CalendarComparisonSource>("combined");
  const [selection, setSelection] = useState<PeriodSelection>({ primary: null, comparison: null });
  const [revision, setRevision] = useState(0);
  const [coverage, setCoverage] = useState<AnalyticsCoverageResponse | null>(null);
  const [loaded, setLoaded] = useState<LoadedCalendarComparison | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [queryLoading, setQueryLoading] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const sensorKey = props.sensors.map((sensor) => sensor.id).join("\u0000");
  const sensorIds = useMemo(() => sensorKey === "" ? [] : sensorKey.split("\u0000"), [sensorKey]);
  const aggregationOptions = useMemo(() => comparisonAggregationOptions(props.definition.kind), [props.definition.kind]);

  useEffect(() => {
    if (!aggregationOptions.includes(aggregation)) setAggregation("default");
  }, [aggregation, aggregationOptions]);

  useEffect(() => {
    const maxDay = daysInAnchorMonth(anchor.month);
    if (anchor.day > maxDay) setAnchor((current) => ({ ...current, day: maxDay }));
  }, [anchor.day, anchor.month]);

  useEffect(() => {
    if (source !== "combined" && !sensorIds.includes(source)) {
      setSource(sensorIds.length === 1 ? sensorIds[0]! : "combined");
    } else if (source === "combined" && sensorIds.length === 1) {
      setSource(sensorIds[0]!);
    }
  }, [sensorIds, source]);

  useEffect(() => {
    if (!open || props.dataMode === "unknown" || sensorIds.length === 0) return;
    const controller = new AbortController();
    let active = true;
    setCoverageLoading(true);
    setCoverageError(null);
    setCoverage(null);
    setLoaded(null);
    void api.analyticsCoverage({
      apiVersion: "1.0",
      dataMode: props.dataMode === "real" ? "live" : "demo",
      scope: { kind: "house", id: props.houseId, entityIds: sensorIds },
      measurementIds: [props.metric],
      requestId: `calendar-coverage-${props.houseId}-${props.metric}-${revision}`,
    }, controller.signal).then((response) => {
      if (active) setCoverage(response);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && active) {
        setCoverageError(error instanceof Error ? error.message : t("analytics.comparisonFailed"));
      }
    }).finally(() => {
      if (active) setCoverageLoading(false);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [open, props.dataMode, props.houseId, props.metric, revision, sensorIds, t]);

  const candidates = useMemo(() => {
    if (!coverage) return [];
    const sourceIds = source === "combined" ? new Set(sensorIds) : new Set([source]);
    const relevant = coverage.series.filter((series) => (
      series.measurementId === props.metric && sourceIds.has(series.entityId)
    ));
    const starts = relevant.map((series) => series.start).sort();
    const ends = relevant.map((series) => series.end).sort();
    if (!starts[0] || !ends.at(-1)) return [];
    return calendarComparisonPeriods({
      unit,
      anchor,
      coverageStart: starts[0],
      coverageEnd: ends.at(-1)!,
      timeZone: props.timeZone,
    });
  }, [anchor, coverage, props.metric, props.timeZone, sensorIds, source, unit]);
  const candidateKey = candidates.map((period) => period.key).join("\u0000");

  useEffect(() => {
    const available = new Set(candidates.map((period) => period.key));
    setSelection((current) => {
      const primary = current.primary && available.has(current.primary)
        ? current.primary
        : candidates.at(-1)?.key ?? null;
      const comparison = current.comparison && available.has(current.comparison) && current.comparison !== primary
        ? current.comparison
        : [...candidates].reverse().find((period) => period.key !== primary)?.key ?? null;
      return current.primary === primary && current.comparison === comparison
        ? current
        : { primary, comparison };
    });
  }, [candidateKey, candidates]);

  const selectedPeriods = useMemo(() => {
    const byKey = new Map(candidates.map((period) => [period.key, period]));
    return [selection.primary, selection.comparison].flatMap((key) => key && byKey.has(key) ? [byKey.get(key)!] : []);
  }, [candidates, selection.comparison, selection.primary]);
  const selectedPeriodKey = selectedPeriods.map((period) => period.key).join("\u0000");
  const querySensorIds = useMemo(
    () => source === "combined" ? sensorIds : sensorIds.includes(source) ? [source] : [],
    [sensorIds, source],
  );

  useEffect(() => {
    if (!open || !coverage || props.dataMode === "unknown" || querySensorIds.length === 0 || selectedPeriods.length === 0) return;
    const controller = new AbortController();
    let active = true;
    const run = async () => {
      setQueryLoading(true);
      setQueryError(null);
      setLoaded(null);
      const buckets = new Map(selectedPeriods.map((period) => [
        period.key,
        calendarComparisonBuckets(period, props.timeZone),
      ]));
      const tasks = selectedPeriods.flatMap((period) => (buckets.get(period.key) ?? []).flatMap((bucket) => {
        const end = new Date(Math.min(Date.parse(bucket.end), Date.parse(period.end))).toISOString();
        return bucket.start < end ? [{ period, bucket, start: bucket.start, end }] : [];
      }));
      const values = new Map<string, Map<string, Map<string, CalendarValueAccumulator>>>();
      const coverageBySensor = new Map(coverage.series.filter((series) => series.measurementId === props.metric)
        .map((series) => [series.entityId, series]));
      let requestSequence = 0;
      let completed = 0;
      if (active) setProgress({ completed: 0, total: tasks.length });

      const recordResponse = (
        period: CalendarComparisonPeriod,
        bucket: CalendarComparisonBucket,
        response: Awaited<ReturnType<typeof api.analyticsQuery>>,
        rangeStart: string,
        rangeEnd: string,
        discardBefore: string | null,
      ) => {
        const byBucket = values.get(period.key) ?? new Map<string, Map<string, CalendarValueAccumulator>>();
        const bySensor = byBucket.get(bucket.key) ?? new Map<string, CalendarValueAccumulator>();
        for (const series of response.series) {
          if (series.measurementId !== props.metric) continue;
          const accumulator = bySensor.get(series.entityId) ?? createCalendarValueAccumulator(series.aggregation);
          const effectiveStart = discardBefore ?? rangeStart;
          appendAnalyticsSeries(accumulator, discardBefore === null ? series : {
            ...series,
            points: series.points.filter((point) => point.timestamp >= discardBefore),
          }, { start: effectiveStart, end: rangeEnd });
          bySensor.set(series.entityId, accumulator);
        }
        byBucket.set(bucket.key, bySensor);
        values.set(period.key, byBucket);
      };

      const queryRange = async (
        period: CalendarComparisonPeriod,
        bucket: CalendarComparisonBucket,
        ids: string[],
        start: string,
        end: string,
        depth = 0,
        discardBefore: string | null = null,
      ): Promise<void> => {
        if (ids.length === 0) return;
        requestSequence += 1;
        try {
          const response = await api.analyticsQuery({
            apiVersion: "1.0",
            dataMode: props.dataMode === "real" ? "live" : "demo",
            scope: { kind: "house", id: props.houseId, entityIds: ids },
            measurementIds: [props.metric],
            range: { start, end, timezone: props.timeZone },
            resolution: comparisonResolution(unit),
            aggregation,
            qualityFilter: { include: qualities(quality) },
            include: ["series", "quality", "provenance"],
            maxPointsPerSeries: 5_000,
            requestId: `calendar-${unit}-${period.key}-${bucket.slot}-${requestSequence}-${revision}`,
          }, controller.signal);
          recordResponse(period, bucket, response, start, end, discardBefore);
        } catch (error) {
          if (!retryableBudget(error) || depth >= 12) throw error;
          if (ids.length > 1) {
            const middle = Math.ceil(ids.length / 2);
            await queryRange(period, bucket, ids.slice(0, middle), start, end, depth + 1, discardBefore);
            await queryRange(period, bucket, ids.slice(middle), start, end, depth + 1, discardBefore);
            return;
          }
          const startMs = Date.parse(start);
          const endMs = Date.parse(end);
          if (endMs - startMs <= 2 * 3_600_000) throw error;
          const split = splitCalendarAnalyticsRange(start, end, 5_000);
          if (!split) throw error;
          await queryRange(period, bucket, ids, start, split.middle, depth + 1, discardBefore);
          const needsCounterContext = aggregation === "delta"
            || (aggregation === "default" && props.definition.kind === "cumulative_counter");
          await queryRange(
            period,
            bucket,
            ids,
            needsCounterContext ? split.overlapStart : split.middle,
            end,
            depth + 1,
            needsCounterContext ? split.middle : null,
          );
        }
      };

      try {
        await mapConcurrently(tasks, 4, async ({ period, bucket, start, end }) => {
          const matchingSensors = querySensorIds.filter((sensorId) => {
            const span = coverageBySensor.get(sensorId);
            return span && span.start < end && span.end >= start;
          });
          const needsCounterContext = aggregation === "delta"
            || (aggregation === "default" && props.definition.kind === "cumulative_counter");
          const queryStart = needsCounterContext
            ? new Date(Date.parse(start) - comparisonResolutionMilliseconds(unit)).toISOString()
            : start;
          await queryRange(
            period,
            bucket,
            matchingSensors,
            queryStart,
            end,
            0,
            needsCounterContext ? start : null,
          );
          completed += 1;
          if (active) setProgress({ completed, total: tasks.length });
        });
        if (active) setLoaded({
          periods: selectedPeriods,
          buckets,
          values,
          complete: coverage.complete,
          archiveState: coverage.archiveState,
        });
      } catch (error) {
        if (!controller.signal.aborted && active) {
          setQueryError(error instanceof Error ? error.message : t("analytics.comparisonFailed"));
        }
      } finally {
        if (active) setQueryLoading(false);
      }
    };
    void run();
    return () => {
      active = false;
      controller.abort();
    };
  }, [aggregation, coverage, open, props.dataMode, props.definition.kind, props.houseId, props.metric, props.timeZone, quality, querySensorIds, revision, selectedPeriodKey, selectedPeriods, t, unit]);

  const periodLabel = (period: CalendarComparisonPeriod, compact = false): string => {
    if (period.unit === "week") return compact
      ? `${period.year} W${period.week}`
      : t("analytics.comparisonWeekLabel", { week: period.week ?? 0, year: period.year });
    if (period.unit === "decade") return t("analytics.comparisonDecadeLabel", { start: period.decade ?? period.year, end: (period.decade ?? period.year) + 9 });
    if (period.unit === "year") return String(period.year);
    return formatInTimeZone(period.start, locale, props.timeZone, period.unit === "day"
      ? { dateStyle: compact ? "short" : "medium" }
      : { month: compact ? "short" : "long", year: "numeric" });
  };
  const sourceLabel = source === "combined"
    ? t(combinedCalendarMode(props.definition) === "sum"
      ? "analytics.comparisonCombinedTotal"
      : "analytics.comparisonCombinedAverage")
    : props.sensors.find((sensor) => sensor.id === source)?.name ?? source;
  const orderedCandidates = [...candidates].reverse();
  const comparisonSensors = source === "combined"
    ? props.sensors
    : props.sensors.filter((sensor) => sensor.id === source);
  const hasValues = loaded
    ? calendarPeriodSeries(loaded, comparisonSensors, source, props.definition)
      .some((series) => series.points.length > 0)
    : false;
  const loading = coverageLoading || queryLoading;

  return <details className="calendar-comparison" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><span><CalendarRange size={17} aria-hidden="true" /><span>
      <strong>{t("analytics.comparisonTitle")}</strong>
      <small>{t("analytics.comparisonDescriptionDetailed")}</small>
    </span></span></summary>
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
        <label className="field"><span>{t("analytics.comparisonPrimaryPeriod")}</span><select value={selection.primary ?? ""} disabled={orderedCandidates.length === 0} onChange={(event) => {
          const primary = event.target.value || null;
          setSelection((current) => ({
            primary,
            comparison: primary === current.comparison ? current.primary : current.comparison,
          }));
        }}>
          {orderedCandidates.map((period) => <option key={period.key} value={period.key}>{periodLabel(period)}</option>)}
        </select></label>
        <label className="field"><span>{t("analytics.comparisonBaselinePeriod")}</span><select value={selection.comparison ?? ""} disabled={orderedCandidates.length < 2} onChange={(event) => {
          const comparison = event.target.value || null;
          setSelection((current) => ({
            primary: comparison === current.primary ? current.comparison : current.primary,
            comparison,
          }));
        }}>
          {orderedCandidates.filter((period) => period.key !== selection.primary).map((period) => <option key={period.key} value={period.key}>{periodLabel(period)}</option>)}
        </select></label>
        <label className="field"><span>{t("analytics.comparisonSource")}</span><select value={source} onChange={(event) => setSource(event.target.value)}>
          {props.sensors.length > 1 && <option value="combined">{t(combinedCalendarMode(props.definition) === "sum" ? "analytics.comparisonCombinedTotal" : "analytics.comparisonCombinedAverage")}</option>}
          {props.sensors.map((sensor) => <option key={sensor.id} value={sensor.id}>{sensor.name}</option>)}
        </select></label>
        <label className="field"><span>{t("analytics.comparisonCalculation")}</span><select value={aggregation} onChange={(event) => setAggregation(event.target.value as AnalyticsAggregation)}>
          {aggregationOptions.map((option) => <option key={option} value={option}>{t(`analytics.aggregation_${option}`)}</option>)}
        </select></label>
        <label className="field"><span>{t("analytics.comparisonQuality")}</span><select value={quality} onChange={(event) => setQuality(event.target.value as QualityPreset)}>
          <option value="good">{t("analytics.quality_good")}</option>
          <option value="reliable">{t("analytics.quality_reliable")}</option>
          <option value="all">{t("analytics.quality_all")}</option>
        </select></label>
        <button type="button" className="secondary-button calendar-comparison-refresh" onClick={() => setRevision((value) => value + 1)} disabled={loading}>
          <RefreshCw className={loading ? "spin" : ""} size={14} aria-hidden="true" />{t("common.refresh")}
        </button>
      </div>

      {loading && <output className="calendar-comparison-status sr-only" aria-live="polite" aria-atomic="true">
        {coverageLoading ? t("analytics.comparisonFindingPeriods") : t("analytics.comparisonLoading", { completed: progress.completed, total: progress.total })}
      </output>}
      {(coverageError || queryError) && <p className="inline-error" role="alert">{coverageError ?? queryError}</p>}
      {coverage && !coverage.complete && <p className="calendar-comparison-warning" role="status">{t("analytics.comparisonArchiveIncomplete")}</p>}
      {!loading && coverage && candidates.length === 0 && <div className="empty-state" role="status">{t("analytics.comparisonNoData")}</div>}
      {!loading && loaded && !hasValues && <div className="empty-state" role="status">{t("analytics.comparisonNoAlignedData")}</div>}
      {loaded && hasValues && <CalendarComparisonResult
        loaded={loaded}
        sensors={comparisonSensors}
        source={source}
        sourceLabel={sourceLabel}
        definition={props.definition}
        units={props.units}
        timeZone={props.timeZone}
        periodLabel={periodLabel}
      />}
      {props.dataMode === "unknown" && <div className="empty-state" role="status">{t("analytics.comparisonUnavailable")}</div>}
      {props.sensors.length === 0 && <div className="empty-state" role="status">{t("analytics.comparisonChooseSensors")}</div>}
    </div>
  </details>;
}
