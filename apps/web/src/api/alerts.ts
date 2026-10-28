import type { ApiReadSchedulingClass } from "./support/requestScheduler";
import { type AlertRule, withSignal, type ActionPlaybook, type ActionRun, type ActionRunStartInput, type AlertEvent, type AlertRulePatch, type NotificationDeliveryStatus, expectShape, isNotificationDeliveryList, isNotificationDeliveryStatus } from "@climate-twin/contracts";
import { list, request } from "./support/request";

/** Alert rules and events, notification deliveries, and action playbooks and runs. */
export const alertsApi = {
  alertRules: async (schedulingClass: ApiReadSchedulingClass = "background") => list<AlertRule>(await request<unknown>("/alert-rules", { schedulingClass }), "rules"),
  createAlertRule: async (rule: Omit<AlertRule, "id">) => (await request<{ rule: AlertRule }>("/alert-rules", { method: "POST", body: JSON.stringify(rule) })).rule,
  updateAlertRule: async (id: string, patch: AlertRulePatch) => {
      const response = await request<{ rule: AlertRule }>(`/alert-rules/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      return response.rule;
    },
  alerts: async (schedulingClass: ApiReadSchedulingClass = "background") => list<AlertEvent>(await request<unknown>("/alert-events", { schedulingClass }), "events"),
  acknowledgeAlert: async (id: string) => (await request<{ event: AlertEvent }>(`/alert-events/${encodeURIComponent(id)}/acknowledge`, { method: "POST" })).event,
  notificationDeliveries: async (options: { limit?: number } = {}): Promise<NotificationDeliveryStatus[]> => {
      const endpoint = `/notification-deliveries${options.limit ? `?limit=${options.limit}` : ""}`;
      const body = await request<{ deliveries?: unknown }>(endpoint);
      return expectShape(body.deliveries, isNotificationDeliveryList, endpoint);
    },
  retryNotificationDelivery: async (id: string): Promise<NotificationDeliveryStatus> => {
      const endpoint = `/notification-deliveries/${encodeURIComponent(id)}/retry`;
      const body = await request<{ delivery?: unknown }>(endpoint, { method: "POST" });
      return expectShape(body.delivery, isNotificationDeliveryStatus, endpoint);
    },
  actionPlaybooks: async (metric?: string) => list<ActionPlaybook>(await request<unknown>(`/action-playbooks${metric ? `?metric=${encodeURIComponent(metric)}` : ""}`), "playbooks"),
  alertActionPlaybooks: async (alertId: string) => list<ActionPlaybook>(await request<unknown>(`/alerts/${encodeURIComponent(alertId)}/action-playbooks`), "playbooks"),
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
      return list<ActionRun>(await request<unknown>(
        `/action-runs${query.size ? `?${query}` : ""}`,
        withSignal(signal),
      ), "runs");
    },
  startActionRun: async (input: ActionRunStartInput) => (await request<{ run: ActionRun }>("/action-runs", { method: "POST", body: JSON.stringify(input) })).run,
  completeActionRun: async (id: string) => (await request<{ run: ActionRun }>(`/action-runs/${encodeURIComponent(id)}/complete`, { method: "POST" })).run,
  cancelActionRun: async (id: string, note?: string) => (await request<{ run: ActionRun }>(`/action-runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({ note: note ?? null }) })).run,
};
