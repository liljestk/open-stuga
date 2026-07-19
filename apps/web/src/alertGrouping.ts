import type { AlertEvent, AlertRule } from "@climate-twin/contracts";

export function alertGroupKey(alert: AlertEvent, rulesById: ReadonlyMap<string, AlertRule>): string {
  const rule = rulesById.get(alert.ruleId);
  return `${alert.sensorId}:${alert.metric}:${rule?.operator ?? alert.ruleId}`;
}

export function countActionableAlertGroups(alerts: readonly AlertEvent[], rules: readonly AlertRule[]): number {
  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  return new Set(alerts
    .filter((alert) => !alert.resolvedAt && !alert.acknowledgedAt)
    .map((alert) => alertGroupKey(alert, rulesById))).size;
}
