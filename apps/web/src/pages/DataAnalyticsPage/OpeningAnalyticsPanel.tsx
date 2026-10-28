import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, Clock, DoorOpen, Download, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import type {
  House,
  OpeningActivitySeries,
  OpeningActivityTarget,
  OpeningState,
  OpeningStateSource,
} from "@climate-twin/contracts";
import { csvDocument } from "../../csv";
import { useOpeningActivityQuery } from "../../data/analytics/openingActivityQuery";
import { ANALYTICS_TIME_RANGES, timeRangeHours, type TimeRange } from "../../domain";
import { formatInTimeZone } from "../../dateTime";
import { useI18n } from "../../i18n";
import { useNow } from "../../useNow";

const TABLE_LIMIT = 500;

interface OpeningAnalyticsPanelProps {
  house: House;
  dataMode: "demo" | "real" | "unknown";
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

interface OpeningAnalyticsViewSeries extends Omit<
  OpeningActivitySeries,
  "target" | "segments" | "records" | "currentSince" | "lastObservedAt"
> {
  target: Omit<OpeningActivityTarget, "label"> & { label: string };
  segments: Array<Omit<OpeningActivitySeries["segments"][number], "startedAt" | "endedAt"> & {
    startedAt: number;
    endedAt: number;
  }>;
  records: Array<Omit<OpeningActivitySeries["records"][number], "observedAt"> & {
    observedAt: number;
  }>;
  currentSince: number | null;
  lastObservedAt: number | null;
}

function targetSummary(house: House): { count: number; boundCount: number; signature: string } {
  const targets = house.floors.flatMap((floor) => (
    (floor.planElements ?? []).flatMap((element) => {
      if (element.kind !== "door" && element.kind !== "window") return [];
      if ((element.kind === "door" && element.variant === "open-passage")
        || (element.kind === "window" && element.variant === "fixed")) return [];
      return [{
        key: `${floor.id}:${element.id}`,
        binding: element.stateBinding
          ? [
              element.stateBinding.provider,
              element.stateBinding.externalId,
              element.stateBinding.connectionId ?? "",
              element.stateBinding.invert ? "1" : "0",
              element.stateBinding.staleAfterSeconds ?? "",
            ].join(":")
          : "",
      }];
    })
  ));
  return {
    count: targets.length,
    boundCount: targets.filter((target) => target.binding.length > 0).length,
    signature: targets.map((target) => `${target.key}:${target.binding}`).join("|"),
  };
}

function viewSeries(
  series: readonly OpeningActivitySeries[],
  t: ReturnType<typeof useI18n>["t"],
): OpeningAnalyticsViewSeries[] {
  return series.map((item) => ({
    ...item,
    target: {
      ...item.target,
      label: item.target.label?.trim()
        || `${t(item.target.kind === "door" ? "planElement.door" : "planElement.window")} ${item.target.ordinal}`,
    },
    segments: item.segments.map((segment) => ({
      ...segment,
      startedAt: Date.parse(segment.startedAt),
      endedAt: Date.parse(segment.endedAt),
    })),
    records: item.records.map((record) => ({
      ...record,
      observedAt: Date.parse(record.observedAt),
    })),
    currentSince: item.currentSince === null ? null : Date.parse(item.currentSince),
    lastObservedAt: item.lastObservedAt === null ? null : Date.parse(item.lastObservedAt),
  }));
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

function activityCsv(series: readonly OpeningAnalyticsViewSeries[]): string {
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
  return csvDocument(rows);
}

export function OpeningAnalyticsPanel(props: Readonly<OpeningAnalyticsPanelProps>) {
  const { locale, t } = useI18n();
  const now = useNow();
  const [retryRevision, setRetryRevision] = useState(0);
  const [selectedKey, setSelectedKey] = useState("all");
  const [historyOpen, setHistoryOpen] = useState(false);
  const targets = useMemo(() => targetSummary(props.house), [props.house]);
  const requestIdentity = useMemo(() => [
    "opening",
    props.house.id,
    props.dataMode,
    props.range,
    props.refreshRevision,
    retryRevision,
    props.liveObservationId ?? "",
    targets.signature,
  ].join("-"), [
    props.dataMode,
    props.house.id,
    props.liveObservationId,
    props.range,
    props.refreshRevision,
    retryRevision,
    targets.signature,
  ]);
  const [requestWindow, setRequestWindow] = useState(() => ({ identity: requestIdentity, end: now }));
  const requestEnd = requestWindow.identity === requestIdentity ? requestWindow.end : now;
  const from = requestEnd - timeRangeHours(props.range) * 3_600_000;
  const request = useMemo(() => targets.count === 0 ? null : ({
      apiVersion: "1.0",
      requestId: requestIdentity,
      houseId: props.house.id,
      dataMode: props.dataMode === "real" ? "live" : "demo",
      range: {
        start: new Date(from).toISOString(),
        end: new Date(requestEnd).toISOString(),
      },
    } as const), [
      from,
      props.dataMode,
      props.house.id,
      requestEnd,
      requestIdentity,
      targets.count,
    ]);
  const query = useOpeningActivityQuery(request, props.range, props.dataMode !== "unknown");
  const response = query.data ?? null;
  const loading = query.isLoading || query.isFetching && !query.data;
  const error = query.error instanceof Error
    ? query.error.message
    : query.error
      ? t("analytics.openingLoadFailed")
      : null;
  const lastReceived = response && query.dataUpdatedAt > 0
    ? formatInTimeZone(query.dataUpdatedAt, locale, props.house.timezone, { dateStyle: "medium", timeStyle: "short" })
    : null;
  const retainedStale = Boolean(response && (query.isFetching || error));

  const series = useMemo(() => viewSeries(response?.series ?? [], t), [response?.series, t]);
  const visibleSeries = useMemo(() => selectedKey === "all"
    ? series
    : series.filter((item) => item.target.key === selectedKey), [selectedKey, series]);
  const recordCount = visibleSeries.reduce((sum, item) => sum + item.records.length, 0);
  const records = useMemo(() => historyOpen
    ? visibleSeries.flatMap((item) => item.records.map((record) => ({ item, record })))
      .sort((left, right) => right.record.observedAt - left.record.observedAt)
    : [], [historyOpen, visibleSeries]);

  useEffect(() => {
    setRequestWindow((current) => current.identity === requestIdentity
      ? current
      : { identity: requestIdentity, end: now });
  }, [now, requestIdentity]);

  useEffect(() => {
    if (requestWindow.identity !== requestIdentity || !query.isSuccess || query.isFetching || now <= requestWindow.end) return;
    setRequestWindow((current) => current.identity === requestIdentity && current.end < now
      ? { identity: requestIdentity, end: now }
      : current);
  }, [now, query.isFetching, query.isSuccess, requestIdentity, requestWindow.end, requestWindow.identity]);

  useEffect(() => {
    if (selectedKey !== "all" && !series.some((item) => item.target.key === selectedKey)) setSelectedKey("all");
  }, [selectedKey, series]);

  if (targets.count === 0 || (series.length === 0 && targets.boundCount === 0)) return null;

  const observedSeries = visibleSeries.filter((item) => item.observationCount > 0);
  const knownCurrent = retainedStale
    ? []
    : visibleSeries.filter((item) => item.currentState !== "unknown");
  const openNow = knownCurrent.filter((item) => item.currentState === "open");
  const openedCount = visibleSeries.reduce((sum, item) => sum + item.openedCount, 0);
  const confirmedOpenMs = visibleSeries.reduce((sum, item) => sum + item.confirmedOpenMs, 0);
  const busiest = [...visibleSeries].sort((left, right) => (
    right.openedCount - left.openedCount || left.target.label.localeCompare(right.target.label)
  ))[0];
  const longest = [...visibleSeries].sort((left, right) => (
    right.longestOpenMs - left.longestOpenMs || left.target.label.localeCompare(right.target.label)
  ))[0];
  const truncated = response?.truncated === true;
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
  const timelineFrom = response ? Date.parse(response.range.start) : from;
  const timelineTo = response ? Date.parse(response.range.end) : now;
  const timelineDuration = Math.max(1, timelineTo - timelineFrom);
  const ticks = Array.from({ length: 5 }, (_, index) => (
    timelineFrom + timelineDuration * index / 4
  ));
  const downloadActivity = () => {
    const url = URL.createObjectURL(new Blob(["\uFEFF", activityCsv(visibleSeries)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `stugu-opening-activity-${props.range}.csv`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

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
      <span><strong>{response ? t("analytics.openingStaleTitle") : t("analytics.openingLoadFailed")}</strong>{lastReceived && <small>{t("analytics.openingStaleBody", { time: lastReceived })}</small>}<small>{error}</small></span>
      <button type="button" className="secondary-button" onClick={() => setRetryRevision((value) => value + 1)}>
        <RefreshCw size={14} aria-hidden="true" />{t("common.refresh")}
      </button>
    </div>}
    {!error && retainedStale && <div className="opening-analytics-warning" role="status">
      <TriangleAlert size={16} aria-hidden="true" />
      <span><strong>{t("analytics.openingStaleTitle")}</strong>{lastReceived && <small>{t("analytics.openingStaleBody", { time: lastReceived })}</small>}</span>
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
              <div>{ticks.map((tick) => <time key={tick} style={{ left: `${(tick - timelineFrom) / timelineDuration * 100}%` }}>{formatInTimeZone(tick, locale, props.house.timezone, tickOptions(props.range))}</time>)}</div>
              <span />
            </div>
            {visibleSeries.map((item) => {
              const currentState = retainedStale ? "unknown" : item.currentState;
              return <div className="opening-timeline-row" key={item.target.key}>
              <span className="opening-timeline-label"><strong>{item.target.label}</strong><small>{item.target.floorName}</small></span>
              <div className="opening-timeline-track" role="img" aria-label={t("analytics.openingTimelineAria", {
                opening: item.target.label,
                count: item.openedCount,
                duration: durationLabel(item.confirmedOpenMs, locale),
                state: retainedStale
                  ? t("analytics.openingStaleState")
                  : currentState === "unknown" ? t("analytics.openingNoRecentData") : stateLabel(currentState, t),
              })}>
                {item.segments.map((segment, index) => <i
                  key={`${segment.startedAt}-${index}`}
                  className={`opening-timeline-segment ${segment.state}`}
                  style={{
                    left: `${Math.max(0, (segment.startedAt - timelineFrom) / timelineDuration * 100)}%`,
                    width: `${Math.max(.12, (segment.endedAt - segment.startedAt) / timelineDuration * 100)}%`,
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
                  style={{ left: `${Math.max(0, Math.min(100, (record.observedAt - timelineFrom) / timelineDuration * 100))}%` }}
                />)}
              </div>
              <span className={`opening-current-state ${currentState}`}>
                {retainedStale
                  ? t("analytics.openingStaleState")
                  : currentState === "unknown" ? t("analytics.openingNoRecentData") : stateLabel(currentState, t)}
              </span>
            </div>})}
          </div>
        </div>

        {recordCount > 0 && <details className="opening-history-details" open={historyOpen} onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
          <summary>{t("analytics.openingShowHistory", { count: recordCount })}</summary>
          {historyOpen && <>
            <div className="opening-history-actions">
              <button type="button" className="secondary-button" onClick={downloadActivity}>
                <Download size={14} aria-hidden="true" />{t("analytics.openingDownload")}
              </button>
              {recordCount > TABLE_LIMIT && <small>{t("analytics.openingTableLimited", { count: TABLE_LIMIT })}</small>}
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
          </>}
        </details>}
        <p className="opening-analytics-method">{t("analytics.openingMethod")}</p>
      </>}
  </section>;
}
