import type { ApiReadSchedulingClass } from "./support/requestScheduler";
import { type AlertRule, withSignal, type ActionRunStartInput, type AlertRulePatch, type NotificationDeliveryStatus, expectShape, isNotificationDeliveryList, isNotificationDeliveryStatus } from "@climate-twin/contracts";
import { request } from "./support/request";
import { actionPlaybookShape, actionRunShape, alertEventShape, alertRuleShape } from "./support/entity-shapes";
import { anyBody, optional, arrayOf, fields } from "./support/response-shapes";

/** Alert rules and events, notification deliveries, and action playbooks and runs. */
export const alertsApi = {
  alertRules: async (schedulingClass: ApiReadSchedulingClass = "background") => (await request("/alert-rules", fields({ rules: arrayOf(alertRuleShape) }), { schedulingClass })).rules,
  createAlertRule: async (rule: Omit<AlertRule, "id">) => (await request("/alert-rules", fields({ rule: alertRuleShape }), { method: "POST", body: JSON.stringify(rule) })).rule,
  updateAlertRule: async (id: string, patch: AlertRulePatch) => {
      const response = await request(`/alert-rules/${encodeURIComponent(id)}`, fields({ rule: alertRuleShape }), { method: "PATCH", body: JSON.stringify(patch) });
      return response.rule;
    },
  alerts: async (schedulingClass: ApiReadSchedulingClass = "background") => (await request("/alert-events", fields({ events: arrayOf(alertEventShape) }), { schedulingClass })).events,
  acknowledgeAlert: async (id: string) => (await request(`/alert-events/${encodeURIComponent(id)}/acknowledge`, fields({ event: alertEventShape }), { method: "POST" })).event,
  notificationDeliveries: async (options: { limit?: number } = {}): Promise<NotificationDeliveryStatus[]> => {
      const endpoint = `/notification-deliveries${options.limit ? `?limit=${options.limit}` : ""}`;
      const body = await request(endpoint, fields({ deliveries: optional(anyBody) }));
      return expectShape(body.deliveries, isNotificationDeliveryList, endpoint);
    },
  retryNotificationDelivery: async (id: string): Promise<NotificationDeliveryStatus> => {
      const endpoint = `/notification-deliveries/${encodeURIComponent(id)}/retry`;
      const body = await request(endpoint, fields({ delivery: optional(anyBody) }), { method: "POST" });
      return expectShape(body.delivery, isNotificationDeliveryStatus, endpoint);
    },
  actionPlaybooks: async (metric?: string) => (await request(`/action-playbooks${metric ? `?metric=${encodeURIComponent(metric)}` : ""}`, fields({ playbooks: arrayOf(actionPlaybookShape) }))).playbooks,
  alertActionPlaybooks: async (alertId: string) => (await request(`/alerts/${encodeURIComponent(alertId)}/action-playbooks`, fields({ playbooks: arrayOf(actionPlaybookShape) }))).playbooks,
  actionRuns: async (
      options: { active?: boolean; houseId?: string; sensorId?: string; alertEventId?: string; limit?: number } = {},
      signal?: AbortSignal,
    ) => {
      const query = new URLSearchParams();
      if (options.active) query.set("active", "true");
      if (options.houseId) query.set("houseId", options.houseId);
      if (options.sensorId) query.set("sensorId", options.sensorId);
      if (options.alertEventId) query.set("alertEventId", options.alertEventId);
      if (options.limit) query.set("limit", String(options.limit));
      return (await request(`/action-runs${query.size ? `?${query}` : ""}`, fields({ runs: arrayOf(actionRunShape) }), withSignal(signal))).runs;
    },
  startActionRun: async (input: ActionRunStartInput) => (await request("/action-runs", fields({ run: actionRunShape }), { method: "POST", body: JSON.stringify(input) })).run,
  completeActionRun: async (id: string) => (await request(`/action-runs/${encodeURIComponent(id)}/complete`, fields({ run: actionRunShape }), { method: "POST" })).run,
  cancelActionRun: async (id: string, note?: string) => (await request(`/action-runs/${encodeURIComponent(id)}/cancel`, fields({ run: actionRunShape }), { method: "POST", body: JSON.stringify({ note: note ?? null }) })).run,
};
