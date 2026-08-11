import { useCallback, useEffect, useMemo, useState } from "react";
import { Droplets, Gauge, Layers3, RefreshCw, ShieldCheck, TriangleAlert, Wind } from "lucide-react";
import type {
  House,
  MoistureResponseEntry,
  MoistureResponseInsight,
  MoistureResponseResult,
} from "@climate-twin/contracts";
import { useI18n } from "../i18n";
import { useMoistureResponse } from "../useMoistureResponse";
import { DerivedArtifactNotices } from "./DerivedArtifactNotices";

interface MoistureResponsePanelProps {
  house: House;
  embedded?: boolean;
  dataMode?: "demo" | "real" | "unknown";
  canRefresh?: boolean;
}

const WINDOW_OPTIONS = [24, 7 * 24, 14 * 24] as const;

function numeric(value: number | null, locale: string, digits = 1): string {
  return value === null ? "\u2014" : new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
}

function hours(value: number | null, locale: string): string {
  return value === null ? "\u2014" : `${numeric(value, locale, 1)} h`;
}

function hpa(value: number | null, locale: string): string {
  return value === null ? "\u2014" : `${numeric(value, locale, 2)} hPa`;
}

function percent(value: number | null, locale: string): string {
  return value === null ? "\u2014" : `${numeric(value, locale, 1)}%`;
}

function InsightCard({
  insight,
  entries,
  locale,
}: Readonly<{
  insight: MoistureResponseInsight;
  entries: MoistureResponseEntry[];
  locale: string;
}>) {
  const { t } = useI18n();
  const label = entries.find((entry) => entry.scope.id === insight.scopeIds[0])?.scope.label ?? "\u2014";
  const limited = insight.code === "LIMITED_MOISTURE_EVIDENCE";
  const detail = insight.code === "FASTEST_MOISTURE_RESPONSE_ROOM"
    ? t("moisture.insight.fastestDetail", { room: label, hours: numeric(insight.value, locale, 1) })
    : insight.code === "STRONGEST_OUTDOOR_MOISTURE_COUPLING"
      ? t("moisture.insight.couplingDetail", { room: label, percent: numeric(insight.value, locale, 1) })
      : insight.code === "HIGHEST_INDOOR_MOISTURE_EXCESS"
        ? t("moisture.insight.excessDetail", { room: label, value: numeric(insight.value, locale, 2) })
        : insight.value >= 100
          ? t("moisture.insight.confidenceDetail")
          : t("moisture.insight.coverageDetail", { percent: numeric(insight.value, locale, 1) });
  return <article className={`isolation-insight ${limited ? "warning" : ""}`}>
    {limited ? <TriangleAlert size={16} aria-hidden="true" /> : <Droplets size={16} aria-hidden="true" />}
    <div><strong>{t(`moisture.insight.${insight.code}`)}</strong><p>{detail}</p></div>
  </article>;
}

function ComparisonRows({
  result,
  locale,
}: Readonly<{ result: MoistureResponseResult; locale: string }>) {
  const { t } = useI18n();
  const floors = result.entries.filter((entry) => entry.scope.type === "floor");
  const rooms = result.entries.filter((entry) => entry.scope.type === "room");
  const rows = floors.flatMap((floor) => [floor, ...rooms.filter((room) => room.scope.parentId === floor.scope.id)]);
  return <div className="isolation-table-wrap" role="region" aria-label={t("moisture.comparisonTable")} tabIndex={0}>
    <table className="isolation-table">
      <caption className="sr-only">{t("moisture.comparisonTable")}</caption>
      <thead><tr>
        <th scope="col">{t("moisture.scope")}</th>
        <th scope="col">{t("moisture.responseTime")}</th>
        <th scope="col">{t("moisture.outdoorCoupling")}</th>
        <th scope="col">{t("moisture.moistureExcess")}</th>
        <th scope="col">{t("moisture.modelSkill")}</th>
        <th scope="col">{t("moisture.confidence")}</th>
      </tr></thead>
      <tbody>{rows.map((entry) => <tr key={entry.scope.id} className={entry.scope.type}>
        <th scope="row"><span className="isolation-scope-label">{entry.scope.type === "floor" ? <Layers3 size={14} aria-hidden="true" /> : <span className="isolation-room-indent" aria-hidden="true">{"\u21b3"}</span>}<span>{entry.scope.label}</span>{entry.scope.type === "room" && entry.rank !== null && <small>#{entry.rank}</small>}</span></th>
        <td>{hours(entry.metrics.responseTimeHours, locale)}</td>
        <td>{percent(entry.metrics.outdoorCouplingPct, locale)}</td>
        <td>{hpa(entry.metrics.medianMoistureExcessHpa, locale)}</td>
        <td>{percent(entry.metrics.modelSkillPct, locale)}</td>
        <td><span className={`isolation-confidence ${entry.confidence}`}>{t(`moisture.confidence.${entry.confidence}`)}</span></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

export function MoistureResponsePanel({ house, embedded = false, dataMode = "real", canRefresh = true }: Readonly<MoistureResponsePanelProps>) {
  const { locale, t } = useI18n();
  const [windowHours, setWindowHours] = useState<number>(7 * 24);
  const activeDataMode = dataMode === "real" ? "live" as const : "demo" as const;
  const { result, status, loading, error, errorCode, run } = useMoistureResponse(house.id, activeDataMode);

  const load = useCallback(() => {
    void run({ windowDays: (windowHours / 24) as 1 | 7 | 14 });
  }, [run, windowHours]);
  const refresh = useCallback(() => {
    void run({ windowDays: (windowHours / 24) as 1 | 7 | 14 }, true);
  }, [run, windowHours]);

  useEffect(() => {
    if (dataMode !== "unknown") load();
  }, [dataMode, load]);

  const houseEntry = result?.entries.find((entry) => entry.scope.type === "house") ?? null;
  const sensorEntries = result?.entries.filter((entry) => entry.scope.type === "sensor") ?? [];
  const entryById = useMemo(() => new Map(result?.entries.map((entry) => [entry.scope.id, entry]) ?? []), [result]);

  return <section className={`${embedded ? "analytics-tool-content" : "panel"} thermal-isolation-panel moisture-response-panel`} aria-label={embedded ? t("moisture.title") : undefined} aria-labelledby={embedded ? undefined : "moisture-response-title"}>
    {embedded ? <div className="isolation-embedded-toolbar">
      <div className="isolation-controls">
        <label className="field"><span>{t("moisture.window")}</span><select value={windowHours} onChange={(event) => setWindowHours(Number(event.target.value))}>
          {WINDOW_OPTIONS.map((value) => <option key={value} value={value}>{value === 24 ? t("moisture.window24h") : t("moisture.windowDays", { count: value / 24 })}</option>)}
        </select></label>
        {canRefresh && <button type="button" className="secondary-button" onClick={refresh} disabled={loading || dataMode === "unknown"}><RefreshCw className={loading ? "spin" : ""} size={14} aria-hidden="true" />{t("common.refresh")}</button>}
      </div>
    </div> : <header className="panel-header isolation-panel-header">
      <div><span className="eyebrow"><Droplets size={13} aria-hidden="true" />{t("moisture.eyebrow")}</span><h2 id="moisture-response-title">{t("moisture.title")}</h2><p>{t("moisture.description")}</p></div>
      <div className="isolation-controls">
        <label className="field"><span>{t("moisture.window")}</span><select value={windowHours} onChange={(event) => setWindowHours(Number(event.target.value))}>
          {WINDOW_OPTIONS.map((value) => <option key={value} value={value}>{value === 24 ? t("moisture.window24h") : t("moisture.windowDays", { count: value / 24 })}</option>)}
        </select></label>
        {canRefresh && <button type="button" className="secondary-button" onClick={refresh} disabled={loading || dataMode === "unknown"}><RefreshCw className={loading ? "spin" : ""} size={14} aria-hidden="true" />{t("common.refresh")}</button>}
      </div>
    </header>}

    {loading && !result && <output className="isolation-loading">{t("derived.loading")}</output>}
    <DerivedArtifactNotices status={status} hasResult={Boolean(result)} canRefresh={canRefresh} />
    {error && <div className="isolation-error" role="alert"><TriangleAlert size={18} aria-hidden="true" /><div><strong>{t(errorCode === "MOISTURE_SCOPE_TOO_LARGE" ? "moisture.errorScope" : errorCode === "RANGE_TOO_LARGE" ? "moisture.errorRange" : "moisture.error")}</strong><p>{t(errorCode === "MOISTURE_SCOPE_TOO_LARGE" ? "moisture.errorScopeHelp" : errorCode === "RANGE_TOO_LARGE" ? "moisture.errorRangeHelp" : "moisture.errorHelp")}</p></div></div>}
    {houseEntry && <>
      <div className="isolation-house-summary">
        <article className="isolation-score-card">
          <div className="isolation-score-icon"><Droplets size={19} aria-hidden="true" /></div>
          <div><span>{t("moisture.houseResponseTime")}</span><strong>{houseEntry.metrics.responseTimeHours === null ? "\u2014" : numeric(houseEntry.metrics.responseTimeHours, locale, 1)}{houseEntry.metrics.responseTimeHours !== null && <small>h</small>}</strong><p>{houseEntry.metrics.responseTimeHours === null ? t("moisture.collecting") : t("moisture.notRating")}</p></div>
        </article>
        <dl className="isolation-house-metrics">
          <div><dt><Wind size={14} aria-hidden="true" />{t("moisture.outdoorCoupling")}</dt><dd>{percent(houseEntry.metrics.outdoorCouplingPct, locale)}</dd></div>
          <div><dt><Gauge size={14} aria-hidden="true" />{t("moisture.moistureExcess")}</dt><dd>{hpa(houseEntry.metrics.medianMoistureExcessHpa, locale)}</dd></div>
          <div><dt><Layers3 size={14} aria-hidden="true" />{t("moisture.sensorEvidence")}</dt><dd>{t("moisture.sensorCount", { eligible: houseEntry.eligibleSensorCount, total: houseEntry.sensorCount })}</dd></div>
          <div><dt><ShieldCheck size={14} aria-hidden="true" />{t("moisture.confidence")}</dt><dd><span className={`isolation-confidence ${houseEntry.confidence}`}>{t(`moisture.confidence.${houseEntry.confidence}`)}</span></dd></div>
        </dl>
      </div>

      {result && result.insights.length > 0 && <div className="isolation-insights">{result.insights.map((insight) => <InsightCard key={`${insight.code}-${insight.scopeIds.join("-")}`} insight={insight} entries={result.entries} locale={locale} />)}</div>}
      {result && <ComparisonRows result={result} locale={locale} />}

      {result && <details className="isolation-sensor-details">
        <summary>{t("moisture.sensorDetails", { count: sensorEntries.length })}</summary>
        <div className="isolation-table-wrap" role="region" aria-label={t("moisture.sensorEvidenceTable")} tabIndex={0}><table className="isolation-table sensor-table">
          <caption className="sr-only">{t("moisture.sensorEvidenceTable")}</caption>
          <thead><tr><th scope="col">{t("moisture.sensor")}</th><th scope="col">{t("moisture.room")}</th><th scope="col">{t("moisture.responseTime")}</th><th scope="col">{t("moisture.outdoorCoupling")}</th><th scope="col">{t("moisture.validationMae")}</th><th scope="col">{t("moisture.confidence")}</th></tr></thead>
          <tbody>{sensorEntries.map((entry) => <tr key={entry.scope.id}><th scope="row">{entry.scope.label}</th><td>{entry.scope.parentId ? entryById.get(entry.scope.parentId)?.scope.label ?? "\u2014" : "\u2014"}</td><td>{hours(entry.metrics.responseTimeHours, locale)}</td><td>{percent(entry.metrics.outdoorCouplingPct, locale)}</td><td>{hpa(entry.quality.validationMaeHpa, locale)}</td><td><span className={`isolation-confidence ${entry.confidence}`}>{t(`moisture.confidence.${entry.confidence}`)}</span></td></tr>)}</tbody>
        </table></div>
      </details>}

      <p className="isolation-method-note">{t("moisture.methodNote")}</p>
    </>}
    {!loading && !error && !houseEntry && <p className="analytics-no-gaps">{t("moisture.collectingHelp")}</p>}
  </section>;
}
