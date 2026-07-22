import { useCallback, useEffect, useMemo, useState } from "react";
import { Gauge, Home, Layers3, RefreshCw, ShieldCheck, Thermometer, TriangleAlert } from "lucide-react";
import type {
  House,
  ThermalIsolationEntry,
  ThermalIsolationInsight,
  ThermalIsolationResult,
  UnitSystem,
} from "@climate-twin/contracts";
import { useI18n } from "../i18n";
import { useThermalIsolation } from "../useThermalIsolation";

interface ThermalIsolationPanelProps {
  house: House;
  units: UnitSystem;
}

const WINDOW_OPTIONS = [24, 7 * 24, 14 * 24] as const;

function numeric(value: number | null, locale: string, digits = 1): string {
  return value === null ? "—" : new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
}

function temperatureSpread(value: number | null, locale: string, units: UnitSystem): string {
  if (value === null) return "—";
  const converted = units === "imperial" ? value * 9 / 5 : value;
  return `${numeric(converted, locale, 2)} ${units === "imperial" ? "°F" : "°C"}`;
}

function scoreLabel(entry: ThermalIsolationEntry, locale: string): string {
  return entry.score === null ? "—" : new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(entry.score);
}

function InsightCard({
  insight,
  entries,
  locale,
  units,
}: Readonly<{
  insight: ThermalIsolationInsight;
  entries: ThermalIsolationEntry[];
  locale: string;
  units: UnitSystem;
}>) {
  const { t } = useI18n();
  const labels = insight.scopeIds.map((scopeId) => entries.find((entry) => entry.scope.id === scopeId)?.scope.label ?? scopeId);
  const detail = insight.code === "LOWEST_BUFFERING_ROOM"
    ? t("isolation.insight.weakestDetail", { room: labels[0] ?? "—", score: numeric(insight.value, locale, 0) })
    : insight.code === "FLOOR_CONTRAST"
      ? t("isolation.insight.floorDetail", { high: labels[0] ?? "—", low: labels[1] ?? "—", points: numeric(insight.value, locale, 1) })
      : insight.code === "ROOM_SENSOR_SPREAD"
        ? t("isolation.insight.spreadDetail", { room: labels[0] ?? "—", spread: temperatureSpread(insight.value, locale, units) })
        : t("isolation.insight.coverageDetail", { percent: numeric(insight.value, locale, 0) });
  return <article className={`isolation-insight ${insight.code === "LIMITED_EVIDENCE" ? "warning" : ""}`}>
    {insight.code === "LIMITED_EVIDENCE" ? <TriangleAlert size={16} aria-hidden="true" /> : <Gauge size={16} aria-hidden="true" />}
    <div><strong>{t(`isolation.insight.${insight.code}`)}</strong><p>{detail}</p></div>
  </article>;
}

function ComparisonRows({
  result,
  locale,
  units,
}: Readonly<{ result: ThermalIsolationResult; locale: string; units: UnitSystem }>) {
  const { t } = useI18n();
  const floors = result.entries.filter((entry) => entry.scope.type === "floor");
  const rooms = result.entries.filter((entry) => entry.scope.type === "room");
  const rows = floors.flatMap((floor) => [floor, ...rooms.filter((room) => room.scope.parentId === floor.scope.id)]);
  return <div className="isolation-table-wrap" role="region" aria-label={t("isolation.comparisonTable")} tabIndex={0}>
    <table className="isolation-table">
      <caption className="sr-only">{t("isolation.comparisonTable")}</caption>
      <thead><tr>
        <th scope="col">{t("isolation.scope")}</th>
        <th scope="col">{t("isolation.score")}</th>
        <th scope="col">{t("isolation.timeConstant")}</th>
        <th scope="col">{t("isolation.response24h")}</th>
        <th scope="col">{t("isolation.temperatureSpread")}</th>
        <th scope="col">{t("isolation.confidence")}</th>
      </tr></thead>
      <tbody>{rows.map((entry) => <tr key={entry.scope.id} className={entry.scope.type}>
        <th scope="row"><span className="isolation-scope-label">{entry.scope.type === "floor" ? <Layers3 size={14} aria-hidden="true" /> : <span className="isolation-room-indent" aria-hidden="true">↳</span>}<span>{entry.scope.label}</span>{entry.scope.type === "room" && entry.rank !== null && <small>#{entry.rank}</small>}</span></th>
        <td><span className={`isolation-score-pill ${entry.rating ?? "unavailable"}`}>{scoreLabel(entry, locale)}</span></td>
        <td>{entry.metrics.effectiveTimeConstantHours === null ? "—" : t("isolation.hours", { value: numeric(entry.metrics.effectiveTimeConstantHours, locale, 1) })}</td>
        <td>{entry.metrics.outdoorResponseAfter24HoursPct === null ? "—" : `${numeric(entry.metrics.outdoorResponseAfter24HoursPct, locale, 1)}%`}</td>
        <td>{temperatureSpread(entry.metrics.typicalTemperatureSpreadC, locale, units)}</td>
        <td><span className={`isolation-confidence ${entry.confidence}`}>{t(`isolation.confidence.${entry.confidence}`)}</span></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

export function ThermalIsolationPanel({ house, units }: Readonly<ThermalIsolationPanelProps>) {
  const { locale, t } = useI18n();
  const [windowHours, setWindowHours] = useState<number>(7 * 24);
  const { result, loading, error, run } = useThermalIsolation(house.id);

  const refresh = useCallback(() => {
    const to = new Date();
    const from = new Date(to.getTime() - windowHours * 3_600_000);
    void run({ from: from.toISOString(), to: to.toISOString() });
  }, [run, windowHours]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const houseEntry = result?.entries.find((entry) => entry.scope.type === "house") ?? null;
  const sensorEntries = result?.entries.filter((entry) => entry.scope.type === "sensor") ?? [];
  const entryById = useMemo(() => new Map(result?.entries.map((entry) => [entry.scope.id, entry]) ?? []), [result]);

  return <section className="panel thermal-isolation-panel" aria-labelledby="thermal-isolation-title">
    <header className="panel-header isolation-panel-header">
      <div><span className="eyebrow"><ShieldCheck size={13} aria-hidden="true" />{t("isolation.eyebrow")}</span><h2 id="thermal-isolation-title">{t("isolation.title")}</h2><p>{t("isolation.description")}</p></div>
      <div className="isolation-controls">
        <label className="field"><span>{t("isolation.window")}</span><select value={windowHours} onChange={(event) => setWindowHours(Number(event.target.value))}>
          {WINDOW_OPTIONS.map((hours) => <option key={hours} value={hours}>{hours === 24 ? t("isolation.window24h") : t("isolation.windowDays", { count: hours / 24 })}</option>)}
        </select></label>
        <button type="button" className="secondary-button" onClick={refresh} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={14} aria-hidden="true" />{t("common.refresh")}</button>
      </div>
    </header>

    {loading && !result && <output className="isolation-loading">{t("isolation.calculating")}</output>}
    {error && <div className="isolation-error" role="alert"><TriangleAlert size={18} aria-hidden="true" /><div><strong>{t("isolation.error")}</strong><p>{t("isolation.errorHelp")}</p></div></div>}
    {houseEntry && <>
      <div className="isolation-house-summary">
        <article className={`isolation-score-card ${houseEntry.rating ?? "unavailable"}`}>
          <div className="isolation-score-icon"><Home size={19} aria-hidden="true" /></div>
          <div><span>{t("isolation.houseScore")}</span><strong>{scoreLabel(houseEntry, locale)}<small>/100</small></strong><p>{houseEntry.rating ? t(`isolation.rating.${houseEntry.rating}`) : t("isolation.collecting")}</p></div>
        </article>
        <dl className="isolation-house-metrics">
          <div><dt><Thermometer size={14} aria-hidden="true" />{t("isolation.response24h")}</dt><dd>{houseEntry.metrics.outdoorResponseAfter24HoursPct === null ? "—" : `${numeric(houseEntry.metrics.outdoorResponseAfter24HoursPct, locale, 1)}%`}</dd></div>
          <div><dt><Gauge size={14} aria-hidden="true" />{t("isolation.halfResponse")}</dt><dd>{houseEntry.metrics.halfResponseHours === null ? "—" : t("isolation.hours", { value: numeric(houseEntry.metrics.halfResponseHours, locale, 1) })}</dd></div>
          <div><dt><Layers3 size={14} aria-hidden="true" />{t("isolation.sensorEvidence")}</dt><dd>{t("isolation.sensorCount", { eligible: houseEntry.eligibleSensorCount, total: houseEntry.sensorCount })}</dd></div>
          <div><dt><ShieldCheck size={14} aria-hidden="true" />{t("isolation.confidence")}</dt><dd><span className={`isolation-confidence ${houseEntry.confidence}`}>{t(`isolation.confidence.${houseEntry.confidence}`)}</span></dd></div>
        </dl>
      </div>

      {result && result.insights.length > 0 && <div className="isolation-insights">{result.insights.map((insight) => <InsightCard key={`${insight.code}-${insight.scopeIds.join("-")}`} insight={insight} entries={result.entries} locale={locale} units={units} />)}</div>}

      {result && <ComparisonRows result={result} locale={locale} units={units} />}

      {result && <details className="isolation-sensor-details">
        <summary>{t("isolation.sensorDetails", { count: sensorEntries.length })}</summary>
        <div className="isolation-table-wrap"><table className="isolation-table sensor-table">
          <thead><tr><th scope="col">{t("isolation.sensor")}</th><th scope="col">{t("isolation.room")}</th><th scope="col">{t("isolation.score")}</th><th scope="col">{t("isolation.timeConstant")}</th><th scope="col">{t("isolation.validationMae")}</th><th scope="col">{t("isolation.confidence")}</th></tr></thead>
          <tbody>{sensorEntries.map((entry) => <tr key={entry.scope.id}><th scope="row">{entry.scope.label}</th><td>{entry.scope.parentId ? entryById.get(entry.scope.parentId)?.scope.label ?? "—" : "—"}</td><td>{scoreLabel(entry, locale)}</td><td>{entry.metrics.effectiveTimeConstantHours === null ? "—" : t("isolation.hours", { value: numeric(entry.metrics.effectiveTimeConstantHours, locale, 1) })}</td><td>{entry.quality.validationMaeC === null ? "—" : temperatureSpread(entry.quality.validationMaeC, locale, units)}</td><td><span className={`isolation-confidence ${entry.confidence}`}>{t(`isolation.confidence.${entry.confidence}`)}</span></td></tr>)}</tbody>
        </table></div>
      </details>}

      <p className="isolation-method-note">{t("isolation.methodNote")}</p>
    </>}
    {!loading && !error && !houseEntry && <p className="analytics-no-gaps">{t("isolation.collectingHelp")}</p>}
  </section>;
}
