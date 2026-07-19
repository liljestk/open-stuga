import { AlertTriangle, CheckCircle2, CloudSun, Eye, RadioTower, Wrench } from "lucide-react";
import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH } from "@climate-twin/contracts";
import type { AlertEvent, IntegrationStatus, MaintenanceTask, ManualObservation, ManualObservationPatch, ObservationRevision, Sensor, WeatherWarning } from "@climate-twin/contracts";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { formatInTimeZone } from "../dateTime";
import { ApiRequestError } from "../api";
import { isHomeRelevantWeatherWarning } from "../weatherWarningRelevance";
import "./decisionLayer.css";

export type HomeActivityKind = "alert" | "observation" | "maintenance" | "weather" | "system";

export interface HomeActivityEvent {
  id: string;
  kind: HomeActivityKind;
  timestamp: string;
  title: string;
  detail: string;
  severity: "info" | "warning" | "critical";
  sensorId?: string;
  floorId?: string;
  observation?: ManualObservation;
  maintenanceTask?: MaintenanceTask;
}

interface HomeActivityTimelineProps {
  sensors: Sensor[];
  alerts: AlertEvent[];
  observations: ManualObservation[];
  maintenanceTasks?: MaintenanceTask[];
  warnings: WeatherWarning[];
  integration: IntegrationStatus;
  timeZone: string;
  onUpdateObservation?: (id: string, patch: ManualObservationPatch) => Promise<ManualObservation>;
  onReloadObservation?: (id: string) => Promise<ManualObservation>;
  onLoadObservationRevisions?: (observationId: string) => Promise<ObservationRevision[]>;
  onOpenSensor: (floorId: string, sensorId: string) => void;
  onOpenFloor: (floorId: string) => void;
}

function alertDetail(alert: AlertEvent): string {
  if (alert.resolvedAt) return "resolved";
  if (alert.acknowledgedAt) return "acknowledged";
  return "open";
}

function weatherSeverity(severity: WeatherWarning["severity"]): HomeActivityEvent["severity"] {
  if (severity === "extreme" || severity === "severe") return "critical";
  if (severity === "moderate") return "warning";
  return "info";
}

function observationSortTimestamp(observation: ManualObservation): string {
  const observed = observation.timePrecision === "unknown"
    ? ""
    : observation.timePrecision === "date-range"
      ? observation.validFrom ?? ""
      : observation.occurredAt;
  return Number.isFinite(Date.parse(observed)) ? observed : observation.createdAt;
}

export function buildHomeActivityEvents({
  sensors,
  alerts,
  observations,
  maintenanceTasks = [],
  warnings,
  integration,
}: Omit<HomeActivityTimelineProps, "onOpenSensor" | "onOpenFloor" | "onUpdateObservation" | "onReloadObservation" | "onLoadObservationRevisions" | "timeZone">): HomeActivityEvent[] {
  const sensorById = new Map(sensors.map((sensor) => [sensor.id, sensor]));
  const events: HomeActivityEvent[] = [
    ...alerts.map((alert): HomeActivityEvent => {
      const sensor = sensorById.get(alert.sensorId);
      return {
        id: `alert:${alert.id}`,
        kind: "alert",
        timestamp: alert.resolvedAt ?? alert.acknowledgedAt ?? alert.startedAt,
        title: sensor?.name ?? alert.sensorId,
        detail: alertDetail(alert),
        severity: alert.severity,
        sensorId: alert.sensorId,
        ...(sensor ? { floorId: sensor.floorId } : {}),
      };
    }),
    ...observations.map((observation): HomeActivityEvent => ({
      id: `observation:${observation.id}`,
      kind: "observation",
      timestamp: observation.status === "resolved" && observation.resolvedAt
        ? observation.resolvedAt
        : observationSortTimestamp(observation),
      title: observation.kind,
      detail: observation.note,
      severity: observation.severity,
      floorId: observation.floorId,
      observation,
      ...(observation.sensorId ? { sensorId: observation.sensorId } : {}),
    })),
    ...maintenanceTasks.map((task): HomeActivityEvent => ({
      id: `maintenance:${task.id}`,
      kind: "maintenance",
      timestamp: task.verifiedAt ?? task.completedAt ?? task.updatedAt,
      title: task.title,
      detail: task.status,
      severity: task.priority === "urgent" ? "critical" : task.priority === "high" ? "warning" : "info",
      maintenanceTask: task,
      ...(task.floorId ? { floorId: task.floorId } : {}),
    })),
    ...warnings.flatMap((warning): HomeActivityEvent[] => {
      if (!isHomeRelevantWeatherWarning(warning)) return [];
      const timestamp = warning.onsetAt ?? warning.effectiveAt ?? warning.expiresAt;
      if (!timestamp) return [];
      return [{
        id: `weather:${warning.id}`,
        kind: "weather",
        timestamp,
        title: warning.event,
        detail: warning.headline,
        severity: weatherSeverity(warning.severity),
      }];
    }),
    ...(integration.mock.activatedAt ? [{
      id: "system:real-data",
      kind: "system" as const,
      timestamp: integration.mock.activatedAt,
      title: "real-data",
      detail: "activated",
      severity: "info" as const,
    }] : []),
  ];
  return events
    .filter((event) => Number.isFinite(Date.parse(event.timestamp)))
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
}

function ActivityIcon({ kind }: Readonly<{ kind: HomeActivityKind }>) {
  if (kind === "alert") return <AlertTriangle size={16} aria-hidden="true" />;
  if (kind === "maintenance") return <Wrench size={16} aria-hidden="true" />;
  if (kind === "weather") return <CloudSun size={16} aria-hidden="true" />;
  if (kind === "system") return <RadioTower size={16} aria-hidden="true" />;
  return <Eye size={16} aria-hidden="true" />;
}

export function ObservationRevisionHistory({
  observation,
  timeZone,
  onLoad,
}: Readonly<{
  observation: ManualObservation;
  timeZone: string;
  onLoad?: (observationId: string) => Promise<ObservationRevision[]>;
}>) {
  const { locale, t } = useI18n();
  const [revisions, setRevisions] = useState<ObservationRevision[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setRevisions(null);
    setFailed(false);
  }, [observation.id, observation.revision]);
  const load = async () => {
    if (!onLoad || loading) return;
    setLoading(true);
    setFailed(false);
    try {
      setRevisions(await onLoad(observation.id));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };
  const actor = (revision: ObservationRevision) => revision.actorLabel?.trim()
    || t(`activity.revisionActor.${revision.actor}`);
  const changedFields = (revision: ObservationRevision) => revision.changedFields
    .map((field) => t(`activity.changedField.${field}` as Parameters<typeof t>[0]))
    .join(", ");

  return (
    <section className="observation-revision-history" aria-label={t("activity.revisionHistory")}>
      <div>
        <span>{t("activity.currentRevision", { revision: observation.revision ?? 1 })}</span>
        {onLoad && <button type="button" className="text-button" disabled={loading} onClick={() => void load()}>{t(loading ? "activity.loadingRevisions" : "activity.loadRevisions")}</button>}
      </div>
      {failed && <p className="inline-error" role="alert">{t("activity.revisionsFailed")}</p>}
      {revisions && <ol>
        {revisions.slice().reverse().map((revision) => <li key={revision.revision}>
          <div><strong>{t("activity.revisionLabel", { revision: revision.revision })}</strong><time dateTime={revision.changedAt}>{formatInTimeZone(revision.changedAt, locale, timeZone, { dateStyle: "medium", timeStyle: "short" })}</time></div>
          <span>{t("activity.revisionBy", { actor: actor(revision) })}</span>
          <small>{t("activity.changedFields", { fields: changedFields(revision) })}</small>
        </li>)}
      </ol>}
    </section>
  );
}

export function ObservationLifecycle({
  observation,
  timeZone,
  onUpdate,
  onReload,
  onAnnounce,
}: Readonly<{
  observation: ManualObservation;
  timeZone: string;
  onUpdate?: (id: string, patch: ManualObservationPatch) => Promise<ManualObservation>;
  onReload?: (id: string) => Promise<ManualObservation>;
  onAnnounce?: (message: string) => void;
}>) {
  const { locale, t } = useI18n();
  const status = observation.status ?? "open";
  const [resolutionNote, setResolutionNote] = useState("");
  const [pending, setPending] = useState<"resolve" | "reopen" | "reload" | null>(null);
  const [failed, setFailed] = useState<"resolve" | "reopen" | "conflict" | "reload" | null>(null);

  useEffect(() => {
    setResolutionNote("");
    setFailed(null);
  }, [observation.id]);

  const resolve = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const outcome = resolutionNote.trim();
    if (!onUpdate || pending || !outcome) return;
    setPending("resolve");
    setFailed(null);
    try {
      await onUpdate(observation.id, {
        baseRevision: observation.revision ?? 1,
        status: "resolved",
        resolutionNote: outcome,
      });
      setResolutionNote("");
      onAnnounce?.(t("observations.resolvedAnnouncement"));
    } catch (error) {
      setFailed(error instanceof ApiRequestError && error.status === 409 ? "conflict" : "resolve");
    } finally {
      setPending(null);
    }
  };

  const reopen = async () => {
    if (!onUpdate || pending) return;
    setPending("reopen");
    setFailed(null);
    try {
      await onUpdate(observation.id, {
        baseRevision: observation.revision ?? 1,
        status: "open",
        resolutionNote: null,
      });
      setResolutionNote("");
      onAnnounce?.(t("observations.reopenedAnnouncement"));
    } catch (error) {
      setFailed(error instanceof ApiRequestError && error.status === 409 ? "conflict" : "reopen");
    } finally {
      setPending(null);
    }
  };

  const reload = async () => {
    if (!onReload || pending) return;
    setPending("reload");
    try {
      await onReload(observation.id);
      setFailed(null);
    } catch {
      setFailed("reload");
    } finally {
      setPending(null);
    }
  };

  const recovery = failed === "conflict" || failed === "reload" ? <div className="observation-conflict-recovery">
    <p className="inline-error" role="alert">{t(failed === "conflict" ? "observations.conflict" : "observations.reloadFailed")}</p>
    {onReload && <button type="button" className="text-button" disabled={pending !== null} onClick={() => void reload()}>{t(pending === "reload" ? "observations.reloading" : "observations.reload")}</button>}
  </div> : null;

  if (status === "resolved") {
    return (
      <section className="observation-lifecycle resolved" aria-label={t("observations.status")}>
        <div className="observation-resolution-outcome">
          <CheckCircle2 size={15} aria-hidden="true" />
          <div>
            <strong>{observation.resolutionNote ?? t("observations.notRecorded")}</strong>
            {observation.resolvedAt && <time dateTime={observation.resolvedAt}>{t("observations.resolvedAt")}: {formatInTimeZone(observation.resolvedAt, locale, timeZone, { dateStyle: "medium", timeStyle: "short" })}</time>}
          </div>
        </div>
        {onUpdate && <button type="button" className="text-button" disabled={pending !== null} onClick={() => void reopen()}>{t(pending === "reopen" ? "observations.reopening" : "observations.reopen")}</button>}
        {failed === "reopen" && <p className="inline-error" role="alert">{t("observations.reopenFailed")}</p>}
        {recovery}
      </section>
    );
  }

  if (!onUpdate) return null;
  return (
    <form className="observation-lifecycle" onSubmit={(event) => void resolve(event)}>
      <label className="field">
        <span>{t("observations.resolutionNote")}</span>
        <input required maxLength={MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH} value={resolutionNote} disabled={pending !== null} onChange={(event) => setResolutionNote(event.target.value)} placeholder={t("observations.resolutionPlaceholder")} />
      </label>
      <button type="submit" className="secondary-button" disabled={pending !== null || !resolutionNote.trim()}><CheckCircle2 size={14} aria-hidden="true" />{t(pending === "resolve" ? "observations.resolving" : "observations.resolve")}</button>
      {failed === "resolve" && <p className="inline-error" role="alert">{t("observations.resolveFailed")}</p>}
      {recovery}
    </form>
  );
}

export function HomeActivityTimeline(props: Readonly<HomeActivityTimelineProps>) {
  const { locale, t } = useI18n();
  const [filter, setFilter] = useState<"all" | HomeActivityKind>("all");
  const [expanded, setExpanded] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const events = useMemo(() => buildHomeActivityEvents(props), [props.sensors, props.alerts, props.observations, props.maintenanceTasks, props.warnings, props.integration]);
  const filtered = events.filter((event) => filter === "all" || event.kind === filter);
  const ordered = filter === "observation"
    ? filtered.slice().sort((left, right) => {
        const leftOpen = (left.observation?.status ?? "open") === "open";
        const rightOpen = (right.observation?.status ?? "open") === "open";
        return leftOpen === rightOpen ? Date.parse(right.timestamp) - Date.parse(left.timestamp) : leftOpen ? -1 : 1;
      })
    : filtered;
  const openObservations = ordered.filter((event) => event.observation && (event.observation.status ?? "open") === "open");
  const routineEvents = ordered.filter((event) => !openObservations.includes(event));
  const collapsedVisible = filter === "observation"
    ? [...openObservations, ...routineEvents.slice(0, Math.max(0, 10 - openObservations.length))]
    : ordered.slice(0, 10);
  const visible = expanded ? ordered : collapsedVisible;
  const hiddenCount = Math.max(0, ordered.length - visible.length);

  useEffect(() => setExpanded(false), [filter]);

  const announce = (message: string) => {
    setAnnouncement("");
    window.setTimeout(() => setAnnouncement(message), 0);
  };

  const titleFor = (event: HomeActivityEvent) => {
    if (event.kind === "alert") return t("activity.alertTitle", { sensor: event.title });
    if (event.kind === "maintenance") return event.title;
    if (event.kind === "weather") return event.title;
    if (event.kind === "system") return t("activity.realDataTitle");
    return t(`observations.${event.title === "note" ? "noteKind" : event.title}` as Parameters<typeof t>[0]);
  };
  const detailFor = (event: HomeActivityEvent) => {
    if (event.kind === "alert") return t(`activity.alert.${event.detail}` as Parameters<typeof t>[0]);
    if (event.kind === "maintenance") return t(`maintenance.status.${event.detail}` as Parameters<typeof t>[0]);
    if (event.kind === "system") return t("activity.realDataBody");
    return event.detail;
  };
  const observedTimeFor = (observation: ManualObservation) => {
    const precision = observation.timePrecision ?? "exact";
    if (precision === "unknown") return t("observations.precision.unknown");
    if (precision === "date-range") {
      return observation.validFrom && observation.validTo
        ? `${observation.validFrom} – ${observation.validTo}`
        : t("observations.notRecorded");
    }
    if (precision === "date-only") return observation.occurredAt || t("observations.notRecorded");
    const formatted = formatInTimeZone(observation.occurredAt, locale, props.timeZone, { dateStyle: "medium", timeStyle: "short" });
    return precision === "approximate" ? t("activity.approximateTime", { time: formatted }) : formatted;
  };
  const recordedTimeFor = (observation: ManualObservation) => formatInTimeZone(
    observation.createdAt,
    locale,
    props.timeZone,
    { dateStyle: "medium", timeStyle: "short" },
  );
  const openEvent = (event: HomeActivityEvent) => {
    if (event.sensorId && event.floorId) props.onOpenSensor(event.floorId, event.sensorId);
    else if (event.floorId) props.onOpenFloor(event.floorId);
  };

  let activityContent: ReactNode;
  if (visible.length === 0) {
    activityContent = <div className="decision-empty"><CheckCircle2 size={22} aria-hidden="true" />{t("activity.empty")}</div>;
  } else {
    activityContent = (
      <>
      <ol className="activity-list">
        {visible.map((event) => {
          const observation = event.observation;
          const observationUsesMachineTime = observation
            && (observation.timePrecision === undefined
              || observation.timePrecision === "exact"
              || observation.timePrecision === "approximate"
              || observation.timePrecision === "date-only")
            && Boolean(observation.occurredAt);
          const content: ReactNode = <>
            <span className={`activity-icon ${event.kind} ${event.severity}`}><ActivityIcon kind={event.kind} /></span>
            <div className="activity-copy">
              {observation
                ? <div className="activity-title-line"><strong>{titleFor(event)}</strong><span className={`observation-status-badge ${observation.status ?? "open"}`}>{t(`observations.status.${observation.status ?? "open"}`)}</span></div>
                : <strong>{titleFor(event)}</strong>}
              <span>{detailFor(event)}</span>
              {observation
                ? observationUsesMachineTime
                  ? <time dateTime={observation.occurredAt}>{t("activity.observedTime", { time: observedTimeFor(observation) })}</time>
                  : <span className="activity-observed-time">{t("activity.observedTime", { time: observedTimeFor(observation) })}</span>
                : <time dateTime={event.timestamp}>{formatInTimeZone(event.timestamp, locale, props.timeZone, { dateStyle: "medium", timeStyle: "short" })}</time>}
              {observation?.status === "resolved" && observation.resolvedAt && <time className="activity-resolved-time" dateTime={observation.resolvedAt}>{t("activity.resolvedTime", { time: formatInTimeZone(observation.resolvedAt, locale, props.timeZone, { dateStyle: "medium", timeStyle: "short" }) })}</time>}
              {observation && <details className="observation-provenance">
                <summary>{t("activity.observationDetails")}</summary>
                <dl>
                  <div><dt>{t("activity.observed")}</dt><dd>{observedTimeFor(observation)}</dd></div>
                  <div><dt>{t("activity.recorded")}</dt><dd>{recordedTimeFor(observation)}</dd></div>
                  <div><dt>{t("observations.timePrecision")}</dt><dd>{t(`observations.precision.${observation.timePrecision ?? "exact"}`)}</dd></div>
                  <div><dt>{t("observations.source")}</dt><dd>{observation.source ? t(`observations.source.${observation.source}`) : t("observations.notRecorded")}{observation.sourceDetail ? ` · ${observation.sourceDetail}` : ""}</dd></div>
                  <div><dt>{t("observations.confidence")}</dt><dd>{observation.confidence ? t(`observations.confidence.${observation.confidence}`) : t("observations.notRecorded")}</dd></div>
                  <div><dt>{t("observations.status")}</dt><dd>{t(`observations.status.${observation.status ?? "open"}`)}</dd></div>
                </dl>
                <ObservationLifecycle observation={observation} timeZone={props.timeZone} onAnnounce={announce} {...(props.onUpdateObservation ? { onUpdate: props.onUpdateObservation } : {})} {...(props.onReloadObservation ? { onReload: props.onReloadObservation } : {})} />
                <ObservationRevisionHistory observation={observation} timeZone={props.timeZone} {...(props.onLoadObservationRevisions ? { onLoad: props.onLoadObservationRevisions } : {})} />
                {event.floorId && observation.x != null && observation.y != null && <button type="button" className="text-button" onClick={() => openEvent(event)}>{t("activity.open", { title: titleFor(event) })}</button>}
              </details>}
            </div>
          </>;
          if (observation || event.maintenanceTask) return <li key={event.id}><div>{content}</div></li>;
          if (event.floorId) {
            return <li key={event.id}><button type="button" onClick={() => openEvent(event)} aria-label={t("activity.open", { title: titleFor(event) })}>{content}</button></li>;
          }
          return <li key={event.id}><div>{content}</div></li>;
        })}
      </ol>
      {hiddenCount > 0 && <button type="button" className="text-button activity-show-more" onClick={() => setExpanded(true)}>{t("activity.showMore", { count: hiddenCount })}</button>}
      </>
    );
  }

  return (
    <section className="panel activity-timeline" aria-labelledby="activity-heading">
      <div className="panel-header">
        <div><span className="eyebrow">{t("activity.eyebrow")}</span><h2 id="activity-heading">{t("activity.title")}</h2></div>
        <label className="activity-filter"><span>{t("activity.filter")}</span><select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">{t("activity.all")}</option><option value="alert">{t("nav.alerts")}</option><option value="observation">{t("observations.title")}</option><option value="maintenance">{t("nav.maintenance")}</option><option value="weather">{t("activity.weather")}</option><option value="system">{t("activity.system")}</option></select></label>
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
      {activityContent}
    </section>
  );
}
