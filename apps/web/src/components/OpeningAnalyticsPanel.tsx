import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, Clock, DoorOpen, Download, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import type { House, OpeningState, OpeningStateObservation, OpeningStateSource } from "@climate-twin/contracts";
import { api } from "../api";
import { ANALYTICS_TIME_RANGES, timeRangeHours, type TimeRange } from "../domain";
import { formatInTimeZone } from "../dateTime";
import { useI18n } from "../i18n";
import {
  deriveOpeningAnalytics,
  type OpeningAnalyticsSeries,
  type OpeningAnalyticsTarget,
} from "../openingAnalytics";
import { useNow } from "../useNow";

const HISTORY_LIMIT = 10_000;
const TABLE_LIMIT = 500;

interface OpeningAnalyticsPanelProps {
  house: House;
  range: TimeRange;
  refreshRevision: number;
  liveObservationId?: string;
  onRange: (range: TimeRange) => void;
}

interface Insight {
  id: string;
  icon: ReactNode;
  text: string;
}

function analyticsTargets(house: House, t: ReturnType<typeof useI18n>["t"]): OpeningAnalyticsTarget[] {
  return house.floors.flatMap((floor) => {
    let doorIndex = 0;
    let windowIndex = 0;
    return (floor.planElements ?? []).flatMap((element) => {
      if (element.kind !== "door" && element.kind !== "window") return [];
      const ordinal = element.kind === "door" ? ++doorIndex : ++windowIndex;
      if ((element.kind === "door" && element.variant === "open-passage")
        || (element.kind === "window" && element.variant === "fixed")) return [];
      const fallback = `${t(element.kind === "door" ? "planElement.door" : "planElement.window")} ${ordinal}`;
      return [{
        key: `${floor.id}:${element.id}`,
        floorId: floor.id,
        floorName: floor.name,
        elementId: element.id,
        kind: element.kind,
        label: element.label?.trim() || fallback,
        binding: element.stateBinding,
      }];
    });
  });
}

function durationLabel(milliseconds: number, locale: string): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  if (minutes < 60) {
    return new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "short" }).format(minutes);
  }
  const hours = minutes / 60;
  if (hours < 48) {
    return new Intl.NumberFormat(locale, {
      maximumFractionDigits: hours < 10 ? 1 : 0,
      style: "unit",
      unit: "hour",
      unitDisplay: "short",
    }).format(hours);
  }
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: "unit",
    unit: "day",
    unitDisplay: "short",
  }).format(hours / 24);
}

function tickOptions(range: TimeRange): Intl.DateTimeFormatOptions {
  if (range === "6h" || range === "24h") return { hour: "2-digit", minute: "2-digit" };
  if (range === "7d") return { weekday: "short", hour: "2-digit" };
  if (range === "1y") return { month: "short" };
  return { month: "short", day: "numeric" };
}

function sourceLabel(source: OpeningStateSource, t: ReturnType<typeof useI18n>["t"]): string {
  if (source === "home-assistant") return t("analytics.openingSourceHomeAssistant");
  if (source === "tapo") return t("analytics.openingSourceTapo");
  if (source === "manual") return t("analytics.openingSourceManual");
  return t("analytics.openingSourceApi");
}

function stateLabel(state: OpeningState, t: ReturnType<typeof useI18n>["t"]): string {
  if (state === "open") return t("opening.state.open");
  if (state === "closed") return t("opening.state.closed");
  return t("analytics.openingUnknown");
}

function csvCell(value: string | number): string {
  const text = String(value);
  const formulaSafe = /^[=+\-@]/u.test(text) ? `'${text}` : text;
  return /[",\r\n]/u.test(formulaSafe) ? `"${formulaSafe.replaceAll('"', '""')}"` : formulaSafe;
}

function activityCsv(series: readonly OpeningAnalyticsSeries[]): string {
  const rows: Array<Array<string | number>> = [["opening", "floor", "kind", "timestamp", "state", "source"]];
  for (const item of series) {
    for (const record of item.records) {
      rows.push([
        item.target.label,
        item.target.floorName,
        item.target.kind,
        new Date(record.observedAt).toISOString(),
        record.state,
        record.source,
      ]);
    }
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function OpeningAnalyticsPanel(props: Readonly<OpeningAnalyticsPanelProps>) {
  const { locale, t } = useI18n();
  const now = useNow();
  const [observations, setObservations] = useState<OpeningStateObservation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryRevision, setRetryRevision] = useState(0);
  const [selectedKey, setSelectedKey] = useState("all");
  const targets = useMemo(() => analyticsTargets(props.house, t), [props.house, t]);
  const targetSignature = useMemo(() => targets.map((target) => [
    target.key,
    target.binding?.provider ?? "",
    target.binding?.externalId ?? "",
    target.binding?.connectionId ?? "",
    target.binding?.invert ? "1" : "0",
    target.binding?.staleAfterSeconds ?? "",
  ].join(":")).join("|"), [targets]);
  const from = now - timeRangeHours(props.range) * 3_600_000;

  useEffect(() => {
    if (targets.length === 0) {
      setObservations([]);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const to = new Date();
    const start = new Date(to.getTime() - timeRangeHours(props.range) * 3_600_000);
    setObservations([]);
    setError(null);
    setLoading(true);
    void api.openingStateHistory(
      props.house.id,
      start.toISOString(),
      to.toISOString(),
      HISTORY_LIMIT,
      controller.signal,
    ).then((history) => {
      if (!controller.signal.aborted) setObservations(history);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : t("analytics.openingLoadFailed"));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [
    props.house.id,
    props.liveObservationId,
    props.range,
    props.refreshRevision,
    retryRevision,
    t,
    targetSignature,
  ]);

  const series = useMemo(
    () => deriveOpeningAnalytics(targets, observations, from, now),
    [from, now, observations, targets],
  );
  const visibleSeries = selectedKey === "all"
    ? series
    : series.filter((item) => item.target.key === selectedKey);

  useEffect(() => {
    if (selectedKey !== "all" && !series.some((item) => item.target.key === selectedKey)) setSelectedKey("all");
  }, [selectedKey, series]);

  if (targets.length === 0 || (series.length === 0 && !targets.some((target) => target.binding))) return null;

  const observedSeries = visibleSeries.filter((item) => item.observationCount > 0);
  const knownCurrent = visibleSeries.filter((item) => item.currentState !== "unknown");
  const openNow = knownCurrent.filter((item) => item.currentState === "open");
  const openedCount = visibleSeries.reduce((sum, item) => sum + item.openedCount, 0);
  const confirmedOpenMs = visibleSeries.reduce((sum, item) => sum + item.confirmedOpenMs, 0);
  const busiest = [...visibleSeries].sort((left, right) => (
    right.openedCount - left.openedCount || left.target.label.localeCompare(right.target.label)
  ))[0];
  const longest = [...visibleSeries].sort((left, right) => (
    right.longestOpenMs - left.longestOpenMs || left.target.label.localeCompare(right.target.label)
  ))[0];
  const records = visibleSeries.flatMap((item) => item.records.map((record) => ({ item, record })))
    .sort((left, right) => right.record.observedAt - left.record.observedAt);
  const truncated = observations.length >= HISTORY_LIMIT - 1;
  const stateNames = new Intl.ListFormat(locale, { style: "long", type: "conjunction" })
    .format(openNow.map((item) => item.target.label));
  const insights: Insight[] = [];
  if (openNow.length === 1) {
    insights.push({ id: "open-now", icon: <DoorOpen size={18} />, text: t("analytics.openingInsightOpenOne", { opening: stateNames }) });
  } else if (openNow.length > 1) {
    insights.push({ id: "open-now", icon: <DoorOpen size={18} />, text: t("analytics.openingInsightOpenMany", { count: openNow.length, openings: stateNames }) });
  }
  if (busiest && busiest.openedCount > 0) {
    insights.push({ id: "busiest", icon: <Activity size={18} />, text: t(
      busiest.openedCount === 1 ? "analytics.openingInsightBusiestOne" : "analytics.openingInsightBusiestMany", {
      opening: busiest.target.label,
      count: busiest.openedCount,
    }) });
  }
  if (longest && longest.longestOpenMs >= 60_000) {
    insights.push({ id: "longest", icon: <Clock size={18} />, text: t("analytics.openingInsightLongest", {
      opening: longest.target.label,
      duration: durationLabel(longest.longestOpenMs, locale),
    }) });
  }
  if (insights.length === 0 && observedSeries.length > 0) {
    insights.push({ id: "quiet", icon: <Sparkles size={18} />, text: t("analytics.openingInsightQuiet") });
  }
  const ticks = Array.from({ length: 5 }, (_, index) => from + (now - from) * index / 4);
  const csv = activityCsv(visibleSeries);

  return <section className="panel opening-analytics-panel" aria-labelledby="opening-analytics-title">
    <header className="opening-analytics-heading">
      <div>
        <span className="eyebrow"><DoorOpen size={14} aria-hidden="true" />{t("analytics.openingEyebrow")}</span>
        <h2 id="opening-analytics-title">{t("analytics.openingTitle")}</h2>
        <p>{t("analytics.openingDescription")}</p>
      </div>
      <div className="opening-analytics-controls">
        <label className="field">
          <span>{t("analytics.openingSeries")}</span>
          <select value={selectedKey} onChange={(event) => setSelectedKey(event.currentTarget.value)}>
            <option value="all">{t("analytics.openingAllSeries")}</option>
            {series.map((item) => <option key={item.target.key} value={item.target.key}>{item.target.label}</option>)}
          </select>
        </label>
        <div className="field opening-analytics-range">
          <span id="opening-history-label">{t("chart.history")}</span>
          <div className="segmented compact" role="group" aria-labelledby="opening-history-label">
            {ANALYTICS_TIME_RANGES.map((range) => <button
              key={range}
              type="button"
              aria-pressed={props.range === range}
              onClick={() => props.onRange(range)}
            >{t(`chart.range${range}`)}</button>)}
          </div>
        </div>
      </div>
    </header>

    {error && <div className="opening-analytics-error inline-error" role="alert">
      <TriangleAlert size={17} aria-hidden="true" />
      <span><strong>{t("analytics.openingLoadFailed")}</strong><small>{error}</small></span>
      <button type="button" className="secondary-button" onClick={() => setRetryRevision((value) => value + 1)}>
        <RefreshCw size={14} aria-hidden="true" />{t("common.refresh")}
      </button>
    </div>}
    {loading && <output className="opening-analytics-loading" aria-live="polite">
      <span className="spinner" aria-hidden="true" />{t("analytics.openingLoading")}
    </output>}
    {truncated && <div className="opening-analytics-warning" role="status">
      <TriangleAlert size={16} aria-hidden="true" />{t("analytics.openingTruncated")}
    </div>}

    {!loading && !error && observedSeries.length === 0
      ? <div className="opening-analytics-empty"><DoorOpen size={22} aria-hidden="true" /><div><strong>{t("analytics.openingEmptyTitle")}</strong><p>{t("analytics.openingEmptyBody")}</p></div></div>
      : <>
        <div className="opening-analytics-stats" aria-label={t("analytics.openingSummary")}>
          <div><span><DoorOpen size={14} aria-hidden="true" />{t("analytics.openingOpenNow")}</span><strong>{knownCurrent.length > 0 ? `${openNow.length} / ${knownCurrent.length}` : "—"}</strong><small>{t("analytics.openingOpenNowContext")}</small></div>
          <div><span><Activity size={14} aria-hidden="true" />{t("analytics.openingOpenedCount")}</span><strong>{openedCount}</strong><small>{t("analytics.openingOpenedContext")}</small></div>
          <div><span><Clock size={14} aria-hidden="true" />{t("analytics.openingOpenTime")}</span><strong>{durationLabel(confirmedOpenMs, locale)}</strong><small>{t("analytics.openingOpenTimeContext")}</small></div>
        </div>

        {insights.length > 0 && <section className="opening-analytics-insights" aria-labelledby="opening-insights-title">
          <h3 id="opening-insights-title"><Sparkles size={15} aria-hidden="true" />{t("analytics.openingInsights")}</h3>
          <div>{insights.slice(0, 3).map((insight) => <p key={insight.id}><span aria-hidden="true">{insight.icon}</span>{insight.text}</p>)}</div>
        </section>}

        <div className="opening-timeline-legend" aria-label={t("analytics.openingLegend")}>
          <span><i className="open" aria-hidden="true" />{t("opening.state.open")}</span>
          <span><i className="closed" aria-hidden="true" />{t("opening.state.closed")}</span>
          <span><i className="change" aria-hidden="true" />{t("analytics.openingStateChange")}</span>
        </div>
        <div className="opening-timeline-scroll" role="region" aria-label={t("analytics.openingTimeline")} tabIndex={0}>
          <div className="opening-timeline">
            <div className="opening-timeline-axis" aria-hidden="true">
              <span />
              <div>{ticks.map((tick) => <time key={tick} style={{ left: `${(tick - from) / (now - from) * 100}%` }}>{formatInTimeZone(tick, locale, props.house.timezone, tickOptions(props.range))}</time>)}</div>
              <span />
            </div>
            {visibleSeries.map((item) => <div className="opening-timeline-row" key={item.target.key}>
              <span className="opening-timeline-label"><strong>{item.target.label}</strong><small>{item.target.floorName}</small></span>
              <div className="opening-timeline-track" role="img" aria-label={t("analytics.openingTimelineAria", {
                opening: item.target.label,
                count: item.openedCount,
                duration: durationLabel(item.confirmedOpenMs, locale),
                state: item.currentState === "unknown" ? t("analytics.openingNoRecentData") : stateLabel(item.currentState, t),
              })}>
                {item.segments.map((segment, index) => <i
                  key={`${segment.startedAt}-${index}`}
                  className={`opening-timeline-segment ${segment.state}`}
                  style={{
                    left: `${Math.max(0, (segment.startedAt - from) / (now - from) * 100)}%`,
                    width: `${Math.max(.12, (segment.endedAt - segment.startedAt) / (now - from) * 100)}%`,
                  }}
                  title={t("analytics.openingInterval", {
                    state: stateLabel(segment.state, t),
                    start: formatInTimeZone(segment.startedAt, locale, props.house.timezone, { dateStyle: "medium", timeStyle: "short" }),
                    end: formatInTimeZone(segment.endedAt, locale, props.house.timezone, { dateStyle: "medium", timeStyle: "short" }),
                  })}
                />)}
                {item.records.map((record) => <i
                  key={record.id}
                  className="opening-timeline-change"
                  style={{ left: `${Math.max(0, Math.min(100, (record.observedAt - from) / (now - from) * 100))}%` }}
                />)}
              </div>
              <span className={`opening-current-state ${item.currentState}`}>
                {item.currentState === "unknown" ? t("analytics.openingNoRecentData") : stateLabel(item.currentState, t)}
              </span>
            </div>)}
          </div>
        </div>

        {records.length > 0 && <details className="opening-history-details">
          <summary>{t("analytics.openingShowHistory", { count: records.length })}</summary>
          <div className="opening-history-actions">
            <a className="secondary-button" href={`data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${csv}`)}`} download={`stugu-opening-activity-${props.range}.csv`}>
              <Download size={14} aria-hidden="true" />{t("analytics.openingDownload")}
            </a>
            {records.length > TABLE_LIMIT && <small>{t("analytics.openingTableLimited", { count: TABLE_LIMIT })}</small>}
          </div>
          <div className="opening-history-table-wrap" role="region" aria-label={t("analytics.openingHistoryTable")} tabIndex={0}>
            <table><thead><tr><th scope="col">{t("analytics.openingSeriesColumn")}</th><th scope="col">{t("analytics.timestamp")}</th><th scope="col">{t("opening.state")}</th><th scope="col">{t("sensors.logSource")}</th></tr></thead>
              <tbody>{records.slice(0, TABLE_LIMIT).map(({ item, record }) => <tr key={`${item.target.key}:${record.id}`}>
                <th scope="row">{item.target.label}<small>{item.target.floorName}</small></th>
                <td><time dateTime={new Date(record.observedAt).toISOString()}>{formatInTimeZone(record.observedAt, locale, props.house.timezone, { dateStyle: "medium", timeStyle: "short" })}</time></td>
                <td><span className={`opening-record-state ${record.state}`}>{stateLabel(record.state, t)}</span></td>
                <td>{sourceLabel(record.source, t)}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </details>}
        <p className="opening-analytics-method">{t("analytics.openingMethod")}</p>
      </>}
  </section>;
}
