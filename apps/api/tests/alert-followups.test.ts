import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { ClimateDatabase } from "../src/db.js";
import { TelemetryBus } from "../src/events.js";
import { normalizeAlertDeliveryPolicy } from "../src/notification-policy.js";
import { AlertEngine } from "../src/services.js";

const webhookConfig = {
  alertWebhookDestinations: [{ id: "primary", url: "https://alerts.example.test/stugu", signingSecret: "test-signing-secret" }],
  telegramBotToken: null,
  telegramChatId: null,
} as unknown as AppConfig;

function openAlert(database: ClimateDatabase, engine: AlertEngine, startedAt: Date) {
  const rule = database.saveAlertRule({
    name: "Escalating humidity",
    sensorId: "sensor-01",
    metric: "humidity",
    operator: "gte",
    threshold: 60,
    durationSeconds: 0,
    severity: "critical",
    enabled: true,
    webhookEnabled: true,
    telegramEnabled: false,
    deliveryPolicy: normalizeAlertDeliveryPolicy({
      timeZone: "UTC",
      activeDays: [1, 2, 3, 4, 5, 6, 7],
      activeFrom: null,
      activeUntil: null,
      quietHoursFrom: null,
      quietHoursUntil: null,
      quietHoursMode: "defer",
      criticalBypassQuietHours: true,
      escalationAfterSeconds: 900,
      reminderIntervalSeconds: 1_800,
      maxAttempts: 5,
    }),
  });
  const [event] = engine.evaluateSample({
    sensorId: "sensor-01",
    metric: "humidity",
    value: 75,
    canonicalUnit: "%",
    timestamp: startedAt.toISOString(),
    source: "api",
    quality: "good",
  });
  if (!event) throw new Error("expected the sample to open an alert");
  return { rule, event };
}

describe("alert follow-ups and maintenance reminders", () => {
  it("queues one escalation and one reminder per elapsed interval for an open alert", () => {
    const database = new ClimateDatabase(":memory:", true);
    try {
      const bus = new TelemetryBus();
      const published = vi.fn();
      bus.subscribe(published);
      const engine = new AlertEngine(database, bus, webhookConfig);
      const startedAt = new Date("2026-07-18T10:00:00.000Z");
      const { event } = openAlert(database, engine, startedAt);
      const followups = () => database.listNotificationDeliveries(100)
        .filter((item) => item.subjectId === event.id && item.stage !== "initial")
        .map((item) => `${item.stage}:${item.sequence}`)
        .sort();
      const alertPublications = () => published.mock.calls.filter(([message]) => message.type === "alert").length;

      void engine.tick(new Date(startedAt.getTime() + 10 * 60_000));
      expect(followups()).toEqual([]);
      const beforeFollowups = alertPublications();

      void engine.tick(new Date(startedAt.getTime() + 16 * 60_000));
      expect(followups()).toEqual(["escalation:0"]);
      expect(alertPublications()).toBe(beforeFollowups + 1);

      void engine.tick(new Date(startedAt.getTime() + 31 * 60_000));
      void engine.tick(new Date(startedAt.getTime() + 32 * 60_000));
      expect(followups()).toEqual(["escalation:0", "reminder:1"]);
      expect(alertPublications()).toBe(beforeFollowups + 2);

      void engine.tick(new Date(startedAt.getTime() + 61 * 60_000));
      expect(followups()).toEqual(["escalation:0", "reminder:1", "reminder:2"]);

      database.acknowledgeAlert(event.id, new Date(startedAt.getTime() + 62 * 60_000).toISOString());
      void engine.tick(new Date(startedAt.getTime() + 91 * 60_000));
      expect(followups()).toEqual(["escalation:0", "reminder:1", "reminder:2"]);
    } finally {
      database.close();
    }
  });

  it("queues overdue maintenance and skips tasks that are not yet due or already completed", () => {
    const database = new ClimateDatabase(":memory:", true);
    try {
      const overdue = database.createMaintenanceTask({ houseId: "house-main", title: "Replace filter", basis: "scheduled", dueBy: "2026-07-10" });
      const future = database.createMaintenanceTask({ houseId: "house-main", title: "Clean gutters", basis: "scheduled", dueBy: "2026-08-01" });
      const completed = database.createMaintenanceTask({ houseId: "house-main", title: "Bleed radiators", basis: "scheduled", dueBy: "2026-07-01" });
      database.updateMaintenanceTask(completed.id, { status: "completed", completionNote: "Bled all radiators", baseRevision: completed.revision });
      const now = new Date("2026-07-18T12:00:00.000Z");

      void new AlertEngine(database, new TelemetryBus(), { ...webhookConfig, alertWebhookDestinations: [] } as AppConfig).tick(now);
      expect(database.listNotificationDeliveries(100).filter((item) => item.subjectKind === "maintenance")).toEqual([]);

      void new AlertEngine(database, new TelemetryBus(), webhookConfig).tick(now);
      const deliveries = database.listNotificationDeliveries(100).filter((item) => item.subjectKind === "maintenance");
      expect(deliveries.map((item) => item.subjectId)).toEqual([overdue.id]);
      expect(deliveries[0]).toMatchObject({ stage: "due", channel: "webhook", sequence: 0 });
      expect(deliveries.map((item) => item.subjectId)).not.toContain(future.id);
    } finally {
      database.close();
    }
  });
});
