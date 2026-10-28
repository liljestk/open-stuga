import type { HostSystemAlert, HostSystemAlertMetric } from "@climate-twin/contracts";
import type { AppConfig } from "../config.js";
import type { ClimateDatabase } from "../db.js";
import type { HostSystemAlertSnapshot } from "./monitor.js";

const METRIC_LABELS: Record<HostSystemAlertMetric, string> = {
  cpu: "CPU",
  database: "Database",
  "event-loop": "API responsiveness",
  memory: "Memory",
  storage: "Storage",
  "storage-forecast": "Storage forecast",
  temperature: "Temperature",
};

function plainLine(value: string, maximumLength = 500): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maximumLength);
}

export function renderHostSystemAlertText(alert: HostSystemAlert, hostname: string): string {
  return [
    `Stugu ${alert.severity.toUpperCase()} host alert`,
    METRIC_LABELS[alert.metric],
    plainLine(alert.message),
    plainLine(alert.recommendation),
    `Host: ${plainLine(hostname, 200)}`,
    `Started: ${alert.startedAt}`,
  ].join("\n").slice(0, 4_096);
}

export function renderHostSystemRecoveryText(alert: HostSystemAlert, hostname: string, resolvedAt: string): string {
  return [
    "Stugu host alert resolved",
    `${METRIC_LABELS[alert.metric]} is back within the monitored limits.`,
    `Host: ${plainLine(hostname, 200)}`,
    `Resolved: ${resolvedAt}`,
  ].join("\n");
}

function notificationSubject(alert: HostSystemAlert): string {
  return `${alert.metric}:${alert.severity}:${alert.startedAt}`;
}

/** Queue active and recovery notices; the outbox uniqueness key suppresses repeated health samples. */
export function enqueueHostSystemAlertNotifications(
  database: ClimateDatabase,
  config: AppConfig,
  snapshot: HostSystemAlertSnapshot,
): number {
  if (!config.telegramBotToken || !config.telegramChatId) return 0;
  const now = new Date(snapshot.current.sampledAt);
  let inserted = 0;
  for (const alert of snapshot.current.alerts) {
    inserted += database.enqueueOperationalNotification({
      subjectKind: "system",
      subjectId: notificationSubject(alert),
      stage: "initial",
      severity: alert.severity,
      webhookEnabled: false,
      telegramEnabled: true,
      config,
      type: "system.health",
      text: renderHostSystemAlertText(alert, snapshot.current.hostname),
      data: { transition: "active", alert },
      now,
    });
  }

  const currentAlerts = new Set(snapshot.current.alerts.map((alert) => `${alert.metric}:${alert.severity}`));
  for (const alert of snapshot.previous?.alerts ?? []) {
    if (currentAlerts.has(`${alert.metric}:${alert.severity}`)) continue;
    inserted += database.enqueueOperationalNotification({
      subjectKind: "system",
      subjectId: notificationSubject(alert),
      stage: "resolved",
      severity: "info",
      webhookEnabled: false,
      telegramEnabled: true,
      config,
      type: "system.health",
      text: renderHostSystemRecoveryText(alert, snapshot.current.hostname, snapshot.current.sampledAt),
      data: { transition: "resolved", alert, resolvedAt: snapshot.current.sampledAt },
      now,
    });
  }
  return inserted;
}
