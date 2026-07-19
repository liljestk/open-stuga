import { describe, expect, it } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import { TelemetryBus } from "../src/events.js";
import { normalizeAlertDeliveryPolicy, notificationScheduleDecision } from "../src/notification-policy.js";
import { AlertEngine } from "../src/services.js";
import type { AppConfig } from "../src/config.js";

describe("operational orchestration", () => {
  it("defers a non-critical notification through quiet hours and lets critical alerts bypass", () => {
    const policy = normalizeAlertDeliveryPolicy({
      timeZone: "Europe/Helsinki",
      activeDays: [1, 2, 3, 4, 5, 6, 7],
      activeFrom: null,
      activeUntil: null,
      quietHoursFrom: "22:00",
      quietHoursUntil: "07:00",
      quietHoursMode: "defer",
      criticalBypassQuietHours: true,
      escalationAfterSeconds: 900,
      reminderIntervalSeconds: 1_800,
      maxAttempts: 5,
    });
    const quietInstant = new Date("2026-01-15T22:30:00.000Z"); // 00:30 in Helsinki
    const warning = notificationScheduleDecision(policy, "warning", quietInstant);
    const critical = notificationScheduleDecision(policy, "critical", quietInstant);
    expect(warning.deferred).toBe(true);
    expect(warning.deliverAt.getTime()).toBeGreaterThan(quietInstant.getTime());
    expect(critical.deferred).toBe(false);
  });

  it("opens sustained alerts on wall clock time without requiring a second sensor sample", () => {
    const database = new ClimateDatabase(":memory:", true);
    try {
      const startedAt = new Date("2026-07-18T10:00:00.000Z");
      const rule = database.saveAlertRule({
        name: "Clock-driven humidity",
        sensorId: "sensor-01",
        metric: "humidity",
        operator: "gte",
        threshold: 60,
        durationSeconds: 60,
        severity: "warning",
        enabled: true,
        webhookEnabled: false,
        telegramEnabled: false,
      });
      const sample = {
        sensorId: "sensor-01",
        metric: "humidity",
        value: 70,
        canonicalUnit: "%",
        timestamp: startedAt.toISOString(),
        source: "api" as const,
        quality: "good" as const,
      };
      database.insertMeasurementSamples([sample]);
      const engine = new AlertEngine(database, new TelemetryBus());
      expect(engine.evaluateSample(sample)).toHaveLength(0);
      engine.tick(new Date(startedAt.getTime() + 60_000));
      expect(database.activeAlert(rule.id, "sensor-01")).toMatchObject({ startedAt: startedAt.toISOString(), value: 70 });
    } finally {
      database.close();
    }
  });

  it("captures a before value and automatically verifies an action from later evidence", () => {
    const database = new ClimateDatabase(":memory:", true);
    try {
      const baselineAt = new Date("2026-07-18T10:00:00.000Z");
      database.insertMeasurementSamples([{
        sensorId: "sensor-01", metric: "humidity", value: 72, canonicalUnit: "%",
        timestamp: baselineAt.toISOString(), source: "api", quality: "good",
      }]);
      const playbook = database.saveActionPlaybook({
        name: "Test ventilation",
        description: "Verify a measurable humidity reduction.",
        instructions: ["Ventilate", "Close the window"],
        metric: "humidity",
        goal: "decrease",
        minimumImprovement: 3,
        targetValue: null,
        waitSeconds: 0,
        verificationWindowSeconds: 300,
      });
      const run = database.startActionRun({ playbookId: playbook.id, sensorId: "sensor-01" }, baselineAt);
      database.completeActionRun(run.id, baselineAt);
      const resultAt = new Date(baselineAt.getTime() + 60_000);
      database.insertMeasurementSamples([{
        sensorId: "sensor-01", metric: "humidity", value: 66, canonicalUnit: "%",
        timestamp: resultAt.toISOString(), source: "api", quality: "good",
      }]);
      database.verifyDueActionRuns(resultAt);
      expect(database.getActionRun(run.id)).toMatchObject({
        status: "verified",
        baselineValue: 72,
        resultValue: 66,
        improvement: 6,
        sampleCount: 1,
      });
    } finally {
      database.close();
    }
  });

  it("queues a due maintenance reminder once through the durable delivery ledger", () => {
    const database = new ClimateDatabase(":memory:", true);
    try {
      const task = database.createMaintenanceTask({
        houseId: "house-main",
        title: "Inspect the heat pump filter",
        basis: "scheduled",
        dueBy: "2026-07-18",
      });
      const config = {
        alertWebhookUrl: "https://alerts.example.test/stuga",
        alertWebhookBearerToken: null,
        alertWebhookSigningSecret: "test-signing-secret",
        telegramBotToken: null,
        telegramChatId: null,
      } as unknown as AppConfig;
      const engine = new AlertEngine(database, new TelemetryBus(), config);
      const now = new Date("2026-07-18T12:00:00.000Z");
      engine.tick(now);
      engine.tick(new Date(now.getTime() + 5_000));
      expect(database.listNotificationDeliveries(100).filter((item) => item.subjectId === task.id)).toEqual([
        expect.objectContaining({ subjectKind: "maintenance", stage: "due", channel: "webhook", sequence: 0 }),
      ]);
    } finally {
      database.close();
    }
  });
});
