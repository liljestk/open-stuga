import { useEffect, useMemo, useState } from "react";
import { CalendarRange } from "lucide-react";
import {
  CALENDAR_COMPARISON_UNITS,
  type AnalyticsAggregation,
  type AnalyticsSampleQuality,
  type CalendarComparisonAnchor,
  type CalendarComparisonPeriod,
  type CalendarComparisonRequest,
  type CalendarComparisonUnit,
  type MeasurementDefinition,
  type Metric,
  type Sensor,
  type UnitSystem,
} from "@climate-twin/contracts";
import { calendarPeriodSeries, type CalendarComparisonSource } from "../calendarComparisonView";
import { useCalendarComparisonQuery } from "../data/analytics/calendarComparisonQuery";
import { formatInTimeZone } from "../dateTime";
import { useI18n } from "../i18n";
import { CalendarComparisonResult } from "./CalendarComparisonResult";
import { RefreshButton } from "./RefreshButton";
import {
  sensorHistoryName,
  sensorHistoryState,
  withSensorHistoryState,
} from "./sensorHistoryLabels";

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

function qualities(preset: QualityPreset): AnalyticsSampleQuality[] {
  if (preset === "good") return ["good"];
  if (preset === "reliable") return ["good", "estimated"];
  return ["good", "estimated", "stale"];
}

function defaultAnchor(timeZone: string): CalendarComparisonAnchor {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes, fallback: number) => (
    Number(parts.find((part) => part.type === type)?.value) || fallback
  );
  const now = new Date();
  const utc = new Date(Date.UTC(
    value("year", now.getUTCFullYear()),
    value("month", now.getUTCMonth() + 1) - 1,
    value("day", now.getUTCDate()),
  ));
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

function aggregationOptions(kind: string | undefined): AnalyticsAggregation[] {
  if (kind === "rate") return ["default", "time_weighted_mean", "mean", "last", "min", "max"];
  if (kind === "increment") return ["default", "sum", "last", "min", "max"];
  if (kind === "cumulative_counter") return ["default", "delta", "last", "min", "max"];
  if (kind === "binary_state") return ["default", "last", "mean"];
  if (kind === "categorical_state") return ["default", "last"];
  return ["default", "mean", "last", "min", "max"];
}

function combinedMode(definition: MeasurementDefinition): "mean" | "sum" {
  return definition.id === "power"
    || definition.id === "energy"
    || definition.kind === "increment"
    || definition.kind === "cumulative_counter"
    ? "sum"
    : "mean";
}

export function CalendarPeriodComparison(props: Readonly<CalendarPeriodComparisonProps>) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [unit, setUnit] = useState<CalendarComparisonUnit>("month");
  const [anchor, setAnchor] = useState<CalendarComparisonAnchor>(() => defaultAnchor(props.timeZone));
  const [aggregation, setAggregation] = useState<AnalyticsAggregation>("default");
  const [quality, setQuality] = useState<QualityPreset>("reliable");
  const [source, setSource] = useState<CalendarComparisonSource>("combined");
  const [selection, setSelection] = useState<PeriodSelection>({
    primary: null,
    comparison: null,
  });
  const [revision, setRevision] = useState(0);
  const sensorKey = props.sensors.map((sensor) => sensor.id).join("\u0000");
  const sensorIds = useMemo(
    () => sensorKey === "" ? [] : sensorKey.split("\u0000"),
    [sensorKey],
  );
  const selectedHistoryState = sensorHistoryState(props.sensors);
  const sensorDisplayName = (sensor: Sensor) => sensorHistoryName(sensor, t("sensors.archived"));
  const historyLabel = (label: string, sensors = props.sensors) => withSensorHistoryState(
    label,
    sensorHistoryState(sensors),
    t("sensors.analyticsArchivedHistory"),
    t("sensors.analyticsIncludesArchived"),
  );
  const availableAggregations = useMemo(
    () => aggregationOptions(props.definition.kind),
    [props.definition.kind],
  );

  useEffect(() => {
    if (!availableAggregations.includes(aggregation)) setAggregation("default");
  }, [aggregation, availableAggregations]);

  useEffect(() => {
    const maxDay = daysInAnchorMonth(anchor.month);
    if (anchor.day > maxDay) {
      setAnchor((current) => ({ ...current, day: maxDay }));
      setSelection({ primary: null, comparison: null });
    }
  }, [anchor.day, anchor.month]);

  useEffect(() => {
    if (source !== "combined" && !sensorIds.includes(source)) {
      setSource(sensorIds.length === 1 ? sensorIds[0]! : "combined");
    } else if (source === "combined" && sensorIds.length === 1) {
      setSource(sensorIds[0]!);
    }
  }, [sensorIds, source]);

  const request = useMemo((): CalendarComparisonRequest | null => {
    if (props.dataMode === "unknown" || sensorIds.length === 0) return null;
    const selectedPeriodKeys = [selection.primary, selection.comparison]
      .filter((key): key is string => Boolean(key));
    return {
      apiVersion: "1.0",
      requestId: [
        "calendar",
        props.houseId,
        props.metric,
        unit,
        anchor.month,
        anchor.day,
        anchor.week,
        aggregation,
        quality,
        revision,
      ].join("-"),
      houseId: props.houseId,
      dataMode: props.dataMode === "real" ? "live" : "demo",
      sensorIds,
      measurementId: props.metric,
      unit,
      anchor,
      ...(selectedPeriodKeys.length > 0 ? { selectedPeriodKeys } : {}),
      aggregation,
      qualityFilter: { include: qualities(quality) },
    };
  }, [
    aggregation,
    anchor,
    props.dataMode,
    props.houseId,
    props.metric,
    quality,
    revision,
    selection.comparison,
    selection.primary,
    sensorIds,
    unit,
  ]);
  const comparison = useCalendarComparisonQuery(request, open);
  const loaded = comparison.data ?? null;
  const candidates = loaded?.candidates ?? [];
  const candidateKeys = new Set(candidates.map((period) => period.key));
  const defaultPrimary = loaded?.selectedPeriods[0]?.key ?? null;
  const defaultComparison = loaded?.selectedPeriods[1]?.key ?? null;
  const effectiveSelection = {
    primary: selection.primary && candidateKeys.has(selection.primary)
      ? selection.primary
      : defaultPrimary,
    comparison: selection.comparison && candidateKeys.has(selection.comparison)
      ? selection.comparison
      : defaultComparison,
  };

  useEffect(() => {
    if ((selection.primary && !candidateKeys.has(selection.primary))
      || (selection.comparison && !candidateKeys.has(selection.comparison))) {
      setSelection({ primary: null, comparison: null });
    }
  }, [loaded, selection.comparison, selection.primary]);

  const periodLabel = (period: CalendarComparisonPeriod, compact = false): string => {
    if (period.unit === "week") {
      return compact
        ? `${period.year} W${period.week}`
        : t("analytics.comparisonWeekLabel", { week: period.week ?? 0, year: period.year });
    }
    if (period.unit === "decade") {
      return t("analytics.comparisonDecadeLabel", {
        start: period.decade ?? period.year,
        end: (period.decade ?? period.year) + 9,
      });
    }
    if (period.unit === "year") return String(period.year);
    return formatInTimeZone(
      period.start,
      locale,
      props.timeZone,
      period.unit === "day"
        ? { dateStyle: compact ? "short" : "medium" }
        : { month: compact ? "short" : "long", year: "numeric" },
    );
  };
  const sourceSensor = props.sensors.find((sensor) => sensor.id === source);
  const combinedSourceLabel = historyLabel(t(combinedMode(props.definition) === "sum"
      ? "analytics.comparisonCombinedTotal"
      : "analytics.comparisonCombinedAverage"));
  const sourceLabel = source === "combined"
    ? combinedSourceLabel
    : sourceSensor ? sensorDisplayName(sourceSensor) : source;
  const orderedCandidates = [...candidates].reverse();
  const comparisonSensors = source === "combined"
    ? props.sensors
    : props.sensors.filter((sensor) => sensor.id === source);
  const hasValues = calendarPeriodSeries(loaded, source)
    .some((series) => series.points.length > 0);
  const loading = open && request !== null && (comparison.isPending || comparison.isFetching);
  const error = comparison.error instanceof Error
    ? comparison.error.message
    : comparison.error
      ? t("analytics.comparisonFailed")
      : null;

  const updateUnit = (next: CalendarComparisonUnit) => {
    setUnit(next);
    setSelection({ primary: null, comparison: null });
  };
  const updateAnchor = (patch: Partial<CalendarComparisonAnchor>) => {
    setAnchor((current) => ({ ...current, ...patch }));
    setSelection({ primary: null, comparison: null });
  };

  return <details
    className="calendar-comparison"
    onToggle={(event) => setOpen(event.currentTarget.open)}
  >
    <summary><span><CalendarRange size={17} aria-hidden="true" /><span>
      <strong>{withSensorHistoryState(
        t("analytics.comparisonTitle"),
        selectedHistoryState,
        t("sensors.analyticsArchivedHistory"),
        t("sensors.analyticsIncludesArchived"),
      )}</strong>
      <small>{t("analytics.comparisonDescriptionDetailed")}</small>
    </span></span></summary>
    <div className="calendar-comparison-body" aria-busy={loading}>
      <div
        className="calendar-comparison-controls"
        role="group"
        aria-label={t("analytics.comparisonControls")}
      >
        <label className="field"><span>{t("analytics.comparisonPeriod")}</span><select
          value={unit}
          onChange={(event) => updateUnit(event.target.value as CalendarComparisonUnit)}
        >
          {CALENDAR_COMPARISON_UNITS.map((item) => <option key={item} value={item}>
            {t(`analytics.comparisonUnit_${item}`)}
          </option>)}
        </select></label>
        {(unit === "day" || unit === "month") && <label className="field"><span>
          {t("analytics.comparisonMonth")}
        </span><select
          value={anchor.month}
          onChange={(event) => updateAnchor({ month: Number(event.target.value) })}
        >
          {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => <option
            key={month}
            value={month}
          >
            {new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" })
              .format(new Date(Date.UTC(2024, month - 1, 1)))}
          </option>)}
        </select></label>}
        {unit === "day" && <label className="field"><span>
          {t("analytics.comparisonDay")}
        </span><select
          value={anchor.day}
          onChange={(event) => updateAnchor({ day: Number(event.target.value) })}
        >
          {Array.from({ length: daysInAnchorMonth(anchor.month) }, (_, index) => index + 1)
            .map((day) => <option key={day} value={day}>{day}</option>)}
        </select></label>}
        {unit === "week" && <label className="field"><span>
          {t("analytics.comparisonWeek")}
        </span><select
          value={anchor.week}
          onChange={(event) => updateAnchor({ week: Number(event.target.value) })}
        >
          {Array.from({ length: 53 }, (_, index) => index + 1)
            .map((week) => <option key={week} value={week}>
              {t("analytics.comparisonWeekOption", { week })}
            </option>)}
        </select></label>}
        <label className="field"><span>{t("analytics.comparisonPrimaryPeriod")}</span><select
          value={effectiveSelection.primary ?? ""}
          disabled={orderedCandidates.length === 0}
          onChange={(event) => {
            const primary = event.target.value || null;
            setSelection({
              primary,
              comparison: primary === effectiveSelection.comparison
                ? effectiveSelection.primary
                : effectiveSelection.comparison,
            });
          }}
        >
          {orderedCandidates.map((period) => <option key={period.key} value={period.key}>
            {periodLabel(period)}
          </option>)}
        </select></label>
        <label className="field"><span>{t("analytics.comparisonBaselinePeriod")}</span><select
          value={effectiveSelection.comparison ?? ""}
          disabled={orderedCandidates.length < 2}
          onChange={(event) => {
            const baseline = event.target.value || null;
            setSelection({
              primary: baseline === effectiveSelection.primary
                ? effectiveSelection.comparison
                : effectiveSelection.primary,
              comparison: baseline,
            });
          }}
        >
          {orderedCandidates
            .filter((period) => period.key !== effectiveSelection.primary)
            .map((period) => <option key={period.key} value={period.key}>
              {periodLabel(period)}
            </option>)}
        </select></label>
        <label className="field"><span>{t("analytics.comparisonSource")}</span><select
          value={source}
          onChange={(event) => setSource(event.target.value)}
        >
          {props.sensors.length > 1 && <option value="combined">
            {combinedSourceLabel}
          </option>}
          {props.sensors.map((sensor) => <option key={sensor.id} value={sensor.id}>
            {sensorDisplayName(sensor)}
          </option>)}
        </select></label>
        <label className="field"><span>{t("analytics.comparisonCalculation")}</span><select
          value={aggregation}
          onChange={(event) => setAggregation(event.target.value as AnalyticsAggregation)}
        >
          {availableAggregations.map((option) => <option key={option} value={option}>
            {t(`analytics.aggregation_${option}`)}
          </option>)}
        </select></label>
        <label className="field"><span>{t("analytics.comparisonQuality")}</span><select
          value={quality}
          onChange={(event) => setQuality(event.target.value as QualityPreset)}
        >
          <option value="good">{t("analytics.quality_good")}</option>
          <option value="reliable">{t("analytics.quality_reliable")}</option>
          <option value="all">{t("analytics.quality_all")}</option>
        </select></label>
        <RefreshButton className="secondary-button calendar-comparison-refresh" onClick={() => setRevision((value) => value + 1)} busy={loading} />
      </div>

      {loading && <output
        className="calendar-comparison-status sr-only"
        aria-live="polite"
        aria-atomic="true"
      >
        {t("analytics.comparisonLoading", { completed: 0, total: 1 })}
      </output>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {loaded?.completeness === "partial" && <p
        className="calendar-comparison-warning"
        role="status"
      >
        {t("analytics.comparisonArchiveIncomplete")}
      </p>}
      {!loading && loaded && candidates.length === 0 && <div
        className="empty-state"
        role="status"
      >
        {t("analytics.comparisonNoData")}
      </div>}
      {!loading && loaded && candidates.length > 0 && !hasValues && <div
        className="empty-state"
        role="status"
      >
        {t("analytics.comparisonNoAlignedData")}
      </div>}
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
      {props.dataMode === "unknown" && <div className="empty-state" role="status">
        {t("analytics.comparisonUnavailable")}
      </div>}
      {props.sensors.length === 0 && <div className="empty-state" role="status">
        {t("analytics.comparisonChooseSensors")}
      </div>}
    </div>
  </details>;
}
