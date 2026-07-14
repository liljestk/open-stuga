import { AlertTriangle, CheckCircle2, CloudSun, Eye, RadioTower } from "lucide-react";
import type { AlertEvent, IntegrationStatus, ManualObservation, Sensor, WeatherWarning } from "@climate-twin/contracts";
import { useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { formatInTimeZone } from "../dateTime";

export type HomeActivityKind = "alert" | "observation" | "weather" | "system";

export interface HomeActivityEvent {
  id: string;
  kind: HomeActivityKind;
  timestamp: string;
  title: string;
  detail: string;
  severity: "info" | "warning" | "critical";
  sensorId?: string;
  floorId?: string;
}

interface HomeActivityTimelineProps {
  sensors: Sensor[];
  alerts: AlertEvent[];
  observations: ManualObservation[];
  warnings: WeatherWarning[];
  integration: IntegrationStatus;
  timeZone: string;
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

export function buildHomeActivityEvents({
  sensors,
  alerts,
  observations,
  warnings,
  integration,
}: Omit<HomeActivityTimelineProps, "onOpenSensor" | "onOpenFloor" | "timeZone">): HomeActivityEvent[] {
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
      timestamp: observation.occurredAt,
      title: observation.kind,
      detail: observation.note,
      severity: observation.severity,
      floorId: observation.floorId,
      ...(observation.sensorId ? { sensorId: observation.sensorId } : {}),
    })),
    ...warnings.flatMap((warning): HomeActivityEvent[] => {
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
  if (kind === "weather") return <CloudSun size={16} aria-hidden="true" />;
  if (kind === "system") return <RadioTower size={16} aria-hidden="true" />;
  return <Eye size={16} aria-hidden="true" />;
}

export function HomeActivityTimeline(props: Readonly<HomeActivityTimelineProps>) {
  const { locale, t } = useI18n();
  const [filter, setFilter] = useState<"all" | HomeActivityKind>("all");
  const events = useMemo(() => buildHomeActivityEvents(props), [props.sensors, props.alerts, props.observations, props.warnings, props.integration]);
  const visible = events.filter((event) => filter === "all" || event.kind === filter).slice(0, 10);

  const titleFor = (event: HomeActivityEvent) => {
    if (event.kind === "alert") return t("activity.alertTitle", { sensor: event.title });
    if (event.kind === "weather") return event.title;
    if (event.kind === "system") return t("activity.realDataTitle");
    return t(`observations.${event.title === "note" ? "noteKind" : event.title}` as Parameters<typeof t>[0]);
  };
  const detailFor = (event: HomeActivityEvent) => {
    if (event.kind === "alert") return t(`activity.alert.${event.detail}` as Parameters<typeof t>[0]);
    if (event.kind === "system") return t("activity.realDataBody");
    return event.detail;
  };
  const openEvent = (event: HomeActivityEvent) => {
    if (event.sensorId && event.floorId) props.onOpenSensor(event.floorId, event.sensorId);
    else if (event.floorId) props.onOpenFloor(event.floorId);
  };

  let activityContent: ReactNode;
  if (visible.length === 0) {
    activityContent = <div className="decision-empty"><CheckCircle2 size={22} aria-hidden="true" />{t("activity.empty")}</div>;
  } else {
    activityContent = (
      <ol className="activity-list">
        {visible.map((event) => {
          const content: ReactNode = <>
            <span className={`activity-icon ${event.kind} ${event.severity}`}><ActivityIcon kind={event.kind} /></span>
            <span className="activity-copy"><strong>{titleFor(event)}</strong><span>{detailFor(event)}</span><time dateTime={event.timestamp}>{formatInTimeZone(event.timestamp, locale, props.timeZone, { dateStyle: "medium", timeStyle: "short" })}</time></span>
          </>;
          if (event.floorId) {
            return <li key={event.id}><button type="button" onClick={() => openEvent(event)} aria-label={t("activity.open", { title: titleFor(event) })}>{content}</button></li>;
          }
          return <li key={event.id}><div>{content}</div></li>;
        })}
      </ol>
    );
  }

  return (
    <section className="panel activity-timeline" aria-labelledby="activity-heading">
      <div className="panel-header">
        <div><span className="eyebrow">{t("activity.eyebrow")}</span><h2 id="activity-heading">{t("activity.title")}</h2></div>
        <label className="activity-filter"><span className="sr-only">{t("activity.filter")}</span><select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">{t("activity.all")}</option><option value="alert">{t("nav.alerts")}</option><option value="observation">{t("observations.title")}</option><option value="weather">{t("activity.weather")}</option><option value="system">{t("activity.system")}</option></select></label>
      </div>
      {activityContent}
    </section>
  );
}
