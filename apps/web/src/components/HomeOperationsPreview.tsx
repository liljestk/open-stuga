import { ArrowRight, CheckCircle2, ChevronDown, Clock3, Eye, Wrench } from "lucide-react";
import { useState } from "react";
import type { AlertEvent, IntegrationStatus, MaintenanceTask, ManualObservation, Sensor, WeatherWarning } from "@climate-twin/contracts";
import { buildHomeActivityEvents } from "./HomeActivityTimeline";
import { useI18n, type TranslationKey } from "../i18n";
import { formatInTimeZone } from "../dateTime";

interface HomeOperationsPreviewProps {
  sensors: Sensor[];
  alerts: AlertEvent[];
  observations: ManualObservation[];
  maintenanceTasks: MaintenanceTask[];
  warnings: WeatherWarning[];
  integration: IntegrationStatus;
  timeZone: string;
  onOpenActivity?: () => void;
  onOpenMaintenance?: () => void;
}

export function HomeOperationsPreview(props: Readonly<HomeOperationsPreviewProps>) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const activityEvents = buildHomeActivityEvents(props).filter((event) => event.kind !== "maintenance");
  const activity = activityEvents.slice(0, 3);
  const activeWork = props.maintenanceTasks
    .filter((task) => task.status !== "verified" && task.status !== "cancelled")
    .sort((left, right) => (left.dueBy ?? left.plannedFor ?? "9999").localeCompare(right.dueBy ?? right.plannedFor ?? "9999"));
  const work = activeWork.slice(0, 3);
  const openObservations = props.observations.filter((observation) => (observation.status ?? "open") === "open").length;

  return <details className="home-operations-disclosure" open={open}>
    <summary onClick={(event) => { event.preventDefault(); setOpen((value) => !value); }}>
      <span className="home-preview-icon activity" aria-hidden="true"><Clock3 size={17} /></span>
      <span className="home-operations-summary-copy">
        <span className="eyebrow">{t("home.activityPreviewEyebrow")}</span>
        <strong>{t("home.operations")}</strong>
        <span className="home-operations-summary-stats">
          <span><Eye size={13} aria-hidden="true" />{t("home.activityPreviewTitle")}<b>{activityEvents.length}</b></span>
          <span><Wrench size={13} aria-hidden="true" />{t("home.maintenancePreviewTitle")}<b>{activeWork.length}</b></span>
        </span>
      </span>
      <ChevronDown className="disclosure-chevron" size={18} aria-hidden="true" />
    </summary>
    {open && <section className="home-operations-preview" aria-label={t("home.operations") }>
      <article className="panel home-preview-card">
        <header><span className="home-preview-icon activity" aria-hidden="true"><Eye size={17} /></span><div><span className="eyebrow">{t("home.activityPreviewEyebrow")}</span><h2>{t("home.activityPreviewTitle")}</h2></div>{openObservations > 0 && <span className="count-badge">{openObservations}</span>}</header>
        {activity.length === 0 ? <p className="home-preview-empty"><CheckCircle2 size={15} aria-hidden="true" />{t("home.noRecentActivity")}</p> : <ol>{activity.map((event) => <li key={event.id}><span className={`home-preview-event ${event.kind}`} aria-hidden="true" /><span><strong>{event.kind === "observation" ? event.detail : event.kind === "alert" ? t("nav.alerts") : event.kind === "weather" ? event.title : t("activity.system")}</strong><time dateTime={event.timestamp}>{formatInTimeZone(event.timestamp, locale, props.timeZone, { dateStyle: "short", timeStyle: "short" })}</time></span></li>)}</ol>}
        {props.onOpenActivity && <button type="button" className="text-button home-preview-link" onClick={props.onOpenActivity}>{t("activity.viewAll")}<ArrowRight size={14} aria-hidden="true" /></button>}
      </article>
      <article className="panel home-preview-card maintenance">
        <header><span className="home-preview-icon maintenance" aria-hidden="true"><Wrench size={17} /></span><div><span className="eyebrow">{t("home.maintenancePreviewEyebrow")}</span><h2>{t("home.maintenancePreviewTitle")}</h2></div>{work.length > 0 && <span className="count-badge">{activeWork.length}</span>}</header>
        {work.length === 0 ? <p className="home-preview-empty"><CheckCircle2 size={15} aria-hidden="true" />{t("home.noPlannedWork")}</p> : <ol>{work.map((task) => <li key={task.id}><Clock3 size={14} aria-hidden="true" /><span><strong>{task.title}</strong><small>{t(`maintenance.status.${task.status}` as TranslationKey)}{task.dueBy ? ` | ${t("maintenance.dueDate", { date: task.dueBy })}` : ""}</small></span></li>)}</ol>}
        {props.onOpenMaintenance && <button type="button" className="text-button home-preview-link" onClick={props.onOpenMaintenance}>{t("maintenance.viewPlan")}<ArrowRight size={14} aria-hidden="true" /></button>}
      </article>
    </section>}
  </details>;
}
