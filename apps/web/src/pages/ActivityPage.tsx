import { CheckCircle2, Edit3, Eye, Map, Plus, Search, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { House, ManualObservation, ManualObservationInput, ManualObservationPatch, ObservationRevision } from "@climate-twin/contracts";
import type { ClimateState } from "../domain";
import { useI18n } from "../i18n";
import { formatInTimeZone } from "../dateTime";
import { useHouseWeather } from "../useHouseWeather";
import { HomeActivityTimeline, ObservationLifecycle, ObservationRevisionHistory } from "../components/HomeActivityTimeline";
import { ObservationComposer } from "./ActivityPage/ObservationComposer";
import { Tabs } from "../components/Tabs";
import "./OperationsPages.css";

type ObservationFilter = "all" | "open" | "resolved" | "critical";
type ActivityTab = "timeline" | "observations";

const observationFilters: ObservationFilter[] = ["all", "open", "resolved", "critical"];

interface ActivityLocationState {
  tab: ActivityTab;
  statusFilter: ObservationFilter;
  search: string;
}

function activityStateFromLocation(): ActivityLocationState {
  if (typeof window === "undefined") return { tab: "timeline", statusFilter: "all", search: "" };
  const params = new URLSearchParams(window.location.search);
  const requestedStatus = params.get("status");
  return {
    tab: params.get("view") === "observations" ? "observations" : "timeline",
    statusFilter: observationFilters.includes(requestedStatus as ObservationFilter)
      ? requestedStatus as ObservationFilter
      : "all",
    search: params.get("search")?.trim() ?? "",
  };
}

function writeActivityState(state: ActivityLocationState, mode: "push" | "replace"): void {
  const url = new URL(window.location.href);
  if (state.tab === "observations") url.searchParams.set("view", state.tab);
  else url.searchParams.delete("view");
  if (state.statusFilter === "all") url.searchParams.delete("status");
  else url.searchParams.set("status", state.statusFilter);
  if (state.search.trim()) url.searchParams.set("search", state.search.trim());
  else url.searchParams.delete("search");
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) window.history[`${mode}State`](window.history.state, "", next);
}

interface ActivityPageProps {
  state: ClimateState;
  house: House;
  onCreateObservation: (input: ManualObservationInput) => Promise<ManualObservation>;
  onUpdateObservation: (id: string, patch: ManualObservationPatch) => Promise<ManualObservation>;
  onReloadObservation: (id: string) => Promise<ManualObservation>;
  onLoadObservationRevisions: (id: string) => Promise<ObservationRevision[]>;
  onOpenFloor: (floorId: string) => void;
  onPlanMaintenance: (observation: ManualObservation) => void;
  readOnly?: boolean;
}

function observedLabel(observation: ManualObservation, locale: string, timeZone: string, fallback: string): string {
  if (observation.timePrecision === "unknown") return fallback;
  if (observation.timePrecision === "date-range") return observation.validFrom && observation.validTo ? `${observation.validFrom} - ${observation.validTo}` : fallback;
  if (observation.timePrecision === "date-only") return observation.occurredAt || fallback;
  return formatInTimeZone(observation.occurredAt, locale, timeZone, { dateStyle: "medium", timeStyle: "short" });
}

export function ActivityPage(props: Readonly<ActivityPageProps>) {
  const { locale, t } = useI18n();
  const initialLocationState = useMemo(activityStateFromLocation, []);
  const [tab, setTab] = useState<ActivityTab>(initialLocationState.tab);
  const [composerOpen, setComposerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ObservationFilter>(initialLocationState.statusFilter);
  const [search, setSearch] = useState(initialLocationState.search);
  const [announcement, setAnnouncement] = useState("");
  const composerButtonRef = useRef<HTMLButtonElement>(null);
  const weather = useHouseWeather(props.house);
  const readOnly = props.readOnly ?? false;
  useEffect(() => {
    const expectedPathname = window.location.pathname;
    const restoreState = () => {
      if (window.location.pathname !== expectedPathname) return;
      const next = activityStateFromLocation();
      setTab(next.tab);
      setStatusFilter(next.statusFilter);
      setSearch(next.search);
      writeActivityState(next, "replace");
    };
    restoreState();
    window.addEventListener("popstate", restoreState);
    return () => window.removeEventListener("popstate", restoreState);
  }, [props.house.id]);
  useEffect(() => {
    if (!readOnly) return;
    setComposerOpen(false);
    setEditingId(null);
  }, [readOnly]);
  const sensors = props.state.sensors.filter((sensor) => sensor.houseId === props.house.id);
  const sensorIds = new Set(sensors.map((sensor) => sensor.id));
  const alerts = props.state.alerts.filter((alert) => sensorIds.has(alert.sensorId));
  const observations = props.state.observations.filter((observation) => observation.houseId === props.house.id);
  const filteredObservations = useMemo(() => observations
    .filter((observation) => statusFilter === "all"
      || (statusFilter === "critical"
        ? (observation.status ?? "open") === "open" && observation.severity === "critical"
        : (observation.status ?? "open") === statusFilter))
    .filter((observation) => {
      const needle = search.trim().toLocaleLowerCase(locale);
      if (!needle) return true;
      const floor = props.house.floors.find((candidate) => candidate.id === observation.floorId)?.name ?? "";
      const kind = t(`observations.${observation.kind === "note" ? "noteKind" : observation.kind}`);
      const severity = t(`alerts.${observation.severity}`);
      return `${observation.note} ${observation.kind} ${kind} ${observation.severity} ${severity} ${floor}`.toLocaleLowerCase(locale).includes(needle);
    })
    .sort((left, right) => {
      const leftOpen = (left.status ?? "open") === "open";
      const rightOpen = (right.status ?? "open") === "open";
      if (leftOpen !== rightOpen) return leftOpen ? -1 : 1;
      return Date.parse(right.updatedAt ?? right.createdAt) - Date.parse(left.updatedAt ?? left.createdAt);
    }), [locale, observations, props.house.floors, search, statusFilter, t]);

  const announce = (message: string) => {
    setAnnouncement("");
    window.setTimeout(() => setAnnouncement(message), 0);
  };

  const closeComposer = () => {
    setComposerOpen(false);
    window.setTimeout(() => composerButtonRef.current?.focus(), 0);
  };

  const activateTab = (next: ActivityTab) => {
    if (next === tab) return;
    setTab(next);
    writeActivityState({ tab: next, statusFilter, search }, "push");
  };

  const selectStatusFilter = (next: ObservationFilter) => {
    setStatusFilter(next);
    writeActivityState({ tab, statusFilter: next, search }, "push");
  };

  const updateSearch = (next: string) => {
    setSearch(next);
    writeActivityState({ tab, statusFilter, search: next }, "replace");
  };

  return (
    <div className="page-stack operations-page activity-page">
      <header className="page-heading operations-heading">
        <div><span className="eyebrow"><Eye size={14} aria-hidden="true" />{props.house.name}</span><h1>{t("activity.pageTitle")}</h1><p>{t("activity.pageDescription")}</p></div>
        {!readOnly && <button ref={composerButtonRef} type="button" className="primary-button" aria-expanded={composerOpen} aria-controls={composerOpen ? "activity-observation-composer" : undefined} onClick={() => composerOpen ? closeComposer() : setComposerOpen(true)}>{composerOpen ? <X size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}{t(composerOpen ? "common.close" : "observations.add")}</button>}
      </header>

      {!readOnly && composerOpen && <ObservationComposer id="activity-observation-composer" house={props.house} floorId={props.house.floors[0]?.id ?? ""} onCreate={props.onCreateObservation} onSaved={closeComposer} onCancel={closeComposer} />}

      <Tabs<ActivityTab>
        className="operations-tabs"
        label={t("activity.views")}
        items={[{ id: "timeline", label: t("activity.timelineTab") }, { id: "observations", label: t("activity.observationsTab"), count: observations.length }]}
        selected={tab}
        onSelect={activateTab}
        tabId={(id) => `activity-${id}-tab`}
        panelId={(id) => `activity-${id}-panel`}
      />
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>

      <div role="tabpanel" id="activity-timeline-panel" aria-labelledby="activity-timeline-tab" hidden={tab !== "timeline"}>
        <HomeActivityTimeline
          sensors={sensors}
          alerts={alerts}
          observations={observations}
          maintenanceTasks={props.state.maintenanceTasks.filter((task) => task.houseId === props.house.id)}
          warnings={weather.weather?.warnings ?? []}
          integration={props.state.integration}
          timeZone={props.house.timezone}
          {...(!readOnly ? { onUpdateObservation: props.onUpdateObservation, onReloadObservation: props.onReloadObservation } : {})}
          onLoadObservationRevisions={props.onLoadObservationRevisions}
          onOpenSensor={(floorId) => props.onOpenFloor(floorId)}
          onOpenFloor={props.onOpenFloor}
        />
      </div>
      <section className="panel observation-workspace" role="tabpanel" id="activity-observations-panel" aria-labelledby="activity-observations-tab" hidden={tab !== "observations"}>
        <div className="operations-toolbar">
          <label className="field operations-search-field"><span>{t("activity.searchObservations")}</span><span className="operations-search"><Search size={16} aria-hidden="true" /><input type="search" value={search} onChange={(event) => updateSearch(event.target.value)} placeholder={t("activity.searchPlaceholder")} /></span></label>
          <label className="field operations-filter"><span>{t("observations.status")}</span><select value={statusFilter} onChange={(event) => selectStatusFilter(event.target.value as ObservationFilter)}><option value="all">{t("activity.allObservations")}</option><option value="open">{t("observations.status.open")}</option><option value="critical">{t("activity.criticalOpen")}</option><option value="resolved">{t("observations.status.resolved")}</option></select></label>
        </div>
        {filteredObservations.length === 0 ? <div className="operations-empty"><CheckCircle2 size={24} aria-hidden="true" /><strong>{t("activity.noObservationMatches")}</strong><p>{t("activity.noObservationMatchesHelp")}</p></div> : <ul className="observation-management-list">
          {filteredObservations.map((observation) => {
            const floor = props.house.floors.find((candidate) => candidate.id === observation.floorId);
            const open = expandedId === observation.id;
            const editing = !readOnly && editingId === observation.id;
            return <li key={observation.id}>
              <article className={`observation-management-card ${observation.severity} ${observation.status ?? "open"}`}>
                <button type="button" className="observation-card-summary" aria-expanded={open} onClick={() => { setExpandedId(open ? null : observation.id); setEditingId(null); }}>
                  <span className={`observation-kind-icon ${observation.kind}`} aria-hidden="true"><Eye size={17} /></span>
                  <span className="observation-card-copy"><span><strong>{t(`observations.${observation.kind === "note" ? "noteKind" : observation.kind}`)}</strong><span className={`observation-severity-badge ${observation.severity}`}>{t(`alerts.${observation.severity}`)}</span><span className={`observation-status-badge ${observation.status ?? "open"}`}>{t(`observations.status.${observation.status ?? "open"}`)}</span></span><span>{observation.note}</span><small>{floor?.name ?? t("sensors.unknownFloor")} | {observedLabel(observation, locale, props.house.timezone, t("observations.notRecorded"))}</small></span>
                </button>
                {open && <div className="observation-card-detail">
                  <div className="observation-card-actions">
                    {!readOnly && <button type="button" className="secondary-button" onClick={() => setEditingId(editing ? null : observation.id)}><Edit3 size={14} aria-hidden="true" />{t("common.edit")}</button>}
                    {observation.x != null && observation.y != null && <button type="button" className="secondary-button" onClick={() => props.onOpenFloor(observation.floorId)}><Map size={14} aria-hidden="true" />{t("activity.viewOnPlan")}</button>}
                    {!readOnly && (observation.status ?? "open") === "open" && <button type="button" className="primary-button" onClick={() => props.onPlanMaintenance(observation)}><Wrench size={14} aria-hidden="true" />{t("activity.planMaintenance")}</button>}
                  </div>
                  {editing ? <ObservationComposer compact house={props.house} floorId={observation.floorId} observation={observation} onUpdate={props.onUpdateObservation} onReload={props.onReloadObservation} onSaved={() => setEditingId(null)} onCancel={() => setEditingId(null)} /> : <>
                    {!readOnly && <ObservationLifecycle observation={observation} timeZone={props.house.timezone} onUpdate={props.onUpdateObservation} onReload={props.onReloadObservation} onAnnounce={announce} />}
                    <ObservationRevisionHistory observation={observation} timeZone={props.house.timezone} onLoad={props.onLoadObservationRevisions} />
                  </>}
                </div>}
              </article>
            </li>;
          })}
        </ul>}
      </section>
    </div>
  );
}
