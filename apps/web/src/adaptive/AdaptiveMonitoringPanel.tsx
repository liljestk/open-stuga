import { useEffect, useState } from "react";
import { ChevronDown, ChartNoAxesCombined } from "lucide-react";
import { ADAPTIVE_METRICS, adaptiveReferenceDeviceKey, roleCanManageWorkspace, type AdaptiveFinding, type House, type UnitSystem } from "@climate-twin/contracts";
import { useAdaptiveMonitoringQuery } from "../data/analytics/adaptiveMonitoringQuery";
import { useI18n, type TranslationKey } from "../i18n";
import { formatInTimeZone } from "../dateTime";
import type { ClimateState } from "../domain";
import { definitionFor, measurementLabel, sensorHasMetric } from "../measurements";
import { AdaptiveFindingReview } from "./AdaptiveFindingReview";
import { AdaptiveLearningSettings } from "./AdaptiveLearningSettings";
import "./adaptive-monitoring.css";

const reasonCopy: Record<string, TranslationKey> = {
  "resource-pressure": "adaptive.resourcePause", "input-budget": "adaptive.inputPause",
  "storage-budget": "adaptive.storagePause", "baseline-review-required": "adaptive.baselineExpired",
};

function locationState() {
  const query = new URLSearchParams(window.location.search);
  return { open: query.get("learning") === "1", finding: query.get("finding"), history: query.get("learningHistory") === "1" };
}
function writeLocation(view: ReturnType<typeof locationState>): void {
  const url = new URL(window.location.href);
  if (view.open) url.searchParams.set("learning", "1"); else url.searchParams.delete("learning");
  if (view.finding) url.searchParams.set("finding", view.finding); else url.searchParams.delete("finding");
  if (view.history) url.searchParams.set("learningHistory", "1"); else url.searchParams.delete("learningHistory");
  if (url.href !== window.location.href) window.history.pushState(null, "", url.pathname + url.search);
}
function groupFindings(findings: AdaptiveFinding[]): AdaptiveFinding[] {
  const groups = new Map<string, AdaptiveFinding>();
  for (const f of findings) {
    const key = JSON.stringify([f.sensorId, f.metric]);
    const previous = groups.get(key);
    if (!previous || f.kind === "sensor-comparison") groups.set(key, f);
  }
  return [...groups.values()];
}
function queryScope(mode: "demo" | "real" | "unknown", surface: string, view: ReturnType<typeof locationState>) {
  return { dataMode: mode === "real" ? "live" as const : "demo" as const,
    enabled: mode !== "unknown" && (surface === "home" || view.open), findingId: view.finding,
    includeHistory: surface !== "home" && view.history,
    kind: surface === "sensors" ? "sensor-comparison" as const : undefined };
}
export function AdaptiveMonitoringPanel(props: Readonly<{
  state: ClimateState; house: House; dataMode: "demo" | "real" | "unknown"; units: UnitSystem;
  readOnly?: boolean; surface?: "analytics" | "home" | "sensors";
}>) {
  const { t, locale } = useI18n();
  const surface = props.surface ?? "analytics";
  const [location, setLocation] = useState(locationState);
  const query = useAdaptiveMonitoringQuery({ houseId: props.house.id, ...queryScope(props.dataMode, surface, location) });
  const canManage = !props.readOnly && roleCanManageWorkspace(props.state.session.tenant.role);
  useEffect(() => {
    const sync = () => setLocation(locationState());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const setOpen = (open: boolean, finding = location.finding) => {
    const next = { ...location, open, finding };
    setLocation(next); writeLocation(next);
  };
  const snapshot = query.data;
  const error = query.settings.error ?? query.review.error ?? query.error ?? query.findings.error ?? query.detail.error;
  const allFindings = query.findings.data?.pages.flatMap(page => page.items) ?? snapshot?.findings.items ?? [];
  const selected = query.detail.data?.finding;
  const listed = selected && !allFindings.some(f => f.id === selected.id) ? [selected, ...allFindings] : allFindings;
  const visible = listed.filter(f => (location.history || f.id === location.finding || f.state === "presented" || f.state === "candidate")
    && (surface !== "sensors" || f.kind === "sensor-comparison"));
  const findings = surface === "home" ? groupFindings(visible.filter(f => f.state === "presented" && f.freshness === "fresh")).slice(0, 3) : visible;
  const sensors = props.state.sensors.filter(s => s.houseId === props.house.id && s.enabled
    && ADAPTIVE_METRICS.some(metric => sensorHasMetric(props.state, s, metric)));
  const referenceSensors = sensors.filter(s => sensorHasMetric(props.state, s, "temperature") && adaptiveReferenceDeviceKey(s));
  if (surface === "home" && (!snapshot || snapshot.settings.mode === "off")) return null;
  const label = snapshot ? t(`adaptive.state.${error ? "stale" : snapshot.state}`) : t("adaptive.description");
  return <details className="analytics-tool adaptive-monitoring" open={location.open} onToggle={e => {
    if (e.currentTarget.open !== location.open) setOpen(e.currentTarget.open);
  }}>
    <summary><span className="analytics-tool-icon"><ChartNoAxesCombined size={18} aria-hidden="true" /></span>
      <span className="analytics-tool-copy"><strong>{t("adaptive.title")}</strong><small>{label}</small></span>
      <ChevronDown size={18} aria-hidden="true" /></summary>
    <div className="adaptive-content">
      <p>{t("adaptive.description")}</p>
      {props.dataMode === "unknown" && <p role="status">{t("adaptive.modeUnknown")}</p>}
      {query.isLoading && <p role="status">{t("adaptive.loading")}</p>}
      {error && <div className="adaptive-error" role="alert"><p>{t("adaptive.loadFailed")}</p>
        <button type="button" className="secondary-button" disabled={query.isFetching} onClick={() => {
          query.settings.reset(); query.review.reset(); void query.refetch(); void query.findings.refetch();
          if (location.finding) void query.detail.refetch();
        }}>{t("adaptive.retry")}</button></div>}
      {snapshot && <>
        <p role="status">{t(`adaptive.state.${error ? "stale" : snapshot.state}`)} · {t("adaptive.monitored", { ready: snapshot.counts.ready, total: snapshot.counts.streams })}</p>
        {snapshot.settings.mode === "shadow" && <p>{t("adaptive.shadowExplanation")}</p>}
        <p>{t("adaptive.learningTime")}</p>
        {canManage && <AdaptiveLearningSettings settings={snapshot.settings} sensors={sensors} referenceSensors={referenceSensors} homeName={props.house.name} dataMode={snapshot.dataMode}
          busy={query.settings.isPending} onSave={patch => query.settings.mutateAsync(patch)} />}
        <label className="adaptive-check"><input type="checkbox" checked={location.history} onChange={e => {
          const next = { ...location, history: e.target.checked }; setLocation(next); writeLocation(next);
        }} />{t("adaptive.history")}</label>
        {findings.length === 0 && <p>{t(snapshot.state === "ready" ? "adaptive.noChange" : "adaptive.noQualifiedFinding")}</p>}
        {findings.map(f => <AdaptiveFindingReview key={f.id} finding={f} house={props.house} units={props.units}
          definition={props.state.measurementDefinitions.find(d => d.id === f.metric)} dataMode={snapshot.dataMode}
          readOnly={!canManage} busy={query.review.isPending} open={location.finding === f.id}
          onOpen={open => setOpen(true, open ? f.id : null)} onReview={body => query.review.mutateAsync({ findingId: f.id, body })} />)}
        {surface !== "home" && query.findings.hasNextPage && <button type="button" className="secondary-button"
          disabled={query.findings.isFetchingNextPage} onClick={() => { void query.findings.fetchNextPage(); }}>{t("adaptive.loadMore")}</button>}
        {surface === "home" && (query.findings.hasNextPage || visible.length > findings.length) && <a className="text-link"
          href={`/properties/${encodeURIComponent(props.house.propertyId)}/homes/${encodeURIComponent(props.house.id)}/analytics?learning=1`}>{t("adaptive.loadMore")}</a>}
        <details><summary>{t("adaptive.coverageTitle")}</summary>
          <ul className="adaptive-streams">{query.streams.map(s => <li key={s.id}>
            <strong>{s.sensorName} · {s.kind === "sensor-comparison" ? t("adaptive.comparison") : measurementLabel(definitionFor(props.state.measurementDefinitions, s.metric), locale)}</strong><span>{t(`adaptive.state.${s.state}`)}</span>
            <small>{t("adaptive.usableHours", { hours: s.usableHours })}</small>
            {reasonCopy[s.reason] && <small>{t(reasonCopy[s.reason]!)}</small>}
            {s.evaluatedThrough && <small>{t("adaptive.evaluatedThrough", { time: formatInTimeZone(s.evaluatedThrough, locale,
              props.house.timezone, { dateStyle: "medium", timeStyle: "short" }) })}</small>}
          </li>)}</ul>
          {query.hasNextPage && <button type="button" className="secondary-button" disabled={query.isFetchingNextPage}
            onClick={() => { void query.fetchNextPage(); }}>{t("adaptive.loadStreams")}</button>}
        </details>
      </>}
    </div>
  </details>;
}
