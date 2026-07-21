import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { ClimateDatabase } from "../src/db.js";
import { TelemetryBus } from "../src/events.js";
import { NotificationOutboxWorker } from "../src/outbox.js";
import { AlertEngine, RuntimeStatus } from "../src/services.js";
import { TelegramService } from "../src/telegram.js";

const OLD_BOT_TOKEN = "123456:old_stuga_bot_token";
const OLD_CHAT_ID = "9007199254740993";
const NEW_BOT_TOKEN = "654321:new_stuga_bot_token";
const NEW_CHAT_ID = "9007199254740994";

function alertConfig(directory: string, databasePath: string, rotated = false): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: databasePath,
    INTEGRATION_SECRETS_FILE: join(directory, "integration-secrets.json"),
    MOCK_ENABLED: "false",
    ALERT_WEBHOOK_URL: rotated ? "https://alerts.example/new" : "https://alerts.example/old",
    ALERT_WEBHOOK_BEARER_TOKEN: rotated ? "new-webhook-secret" : "old-webhook-secret",
    TELEGRAM_BOT_TOKEN: rotated ? NEW_BOT_TOKEN : OLD_BOT_TOKEN,
    TELEGRAM_CHAT_ID: rotated ? NEW_CHAT_ID : OLD_CHAT_ID,
  });
}

function queueAlert(database: ClimateDatabase, config: AppConfig, ruleId: string): string {
  const bus = new TelemetryBus();
  const engine = new AlertEngine(database, bus, config);
  database.saveAlertRule({
    id: ruleId,
    name: "Original cold-room rule",
    sensorId: "sensor-01",
    metric: "temperature",
    operator: "lte",
    threshold: 30,
    durationSeconds: 1,
    severity: "warning",
    enabled: true,
    webhookEnabled: true,
    telegramEnabled: true,
  });
  const base = Date.now() - 10_000;
  for (const offset of [0, 2_000]) {
    engine.evaluateSample({
      sensorId: "sensor-01",
      metric: "temperature",
      value: 20,
      canonicalUnit: database.getMeasurementDefinition("temperature")!.unit,
      timestamp: new Date(base + offset).toISOString(),
      source: "api",
      quality: "good",
    });
  }
  return database.listAlertEvents().find((event) => event.ruleId === ruleId)!.id;
}

function telegramSuccessFetch() {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

describe("durable alert history and notification snapshots", () => {
  it("restores a pending sustained condition and opens it from wall-clock time after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "stuga-alert-deadline-"));
    const databasePath = join(directory, "climate.sqlite");
    let database: ClimateDatabase | null = new ClimateDatabase(databasePath, true);
    try {
      const startedAt = new Date("2026-07-21T10:00:00.000Z");
      const rule = database.saveAlertRule({
        name: "Restart-safe humidity deadline",
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
      expect(new AlertEngine(database, new TelemetryBus()).evaluateSample(sample)).toEqual([]);
      expect(database.listDueAlertConditions(new Date(startedAt.getTime() + 59_999))).toEqual([]);

      database.close();
      database = new ClimateDatabase(databasePath, false);
      const restarted = new AlertEngine(database, new TelemetryBus());
      restarted.tick(new Date(startedAt.getTime() + 60_000));

      expect(database.activeAlert(rule.id, sample.sensorId)).toMatchObject({
        startedAt: startedAt.toISOString(),
        value: sample.value,
      });
      expect(database.listDueAlertConditions(new Date(startedAt.getTime() + 65_000))).toEqual([]);
    } finally {
      database?.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("delivers the original immutable payload after rule edits, retirement, and restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stuga-alert-history-"));
    const databasePath = join(directory, "climate.sqlite");
    const config = alertConfig(directory, databasePath);
    let database: ClimateDatabase | null = new ClimateDatabase(databasePath, true);
    let worker: NotificationOutboxWorker | null = null;
    try {
      const eventId = queueAlert(database, config, "durable-history-rule");
      const snapshots = database.db.prepare(`SELECT channel, payload_json, destination_ref
        FROM notification_outbox WHERE event_id = ? ORDER BY channel`).all(eventId) as Array<{
          channel: "telegram" | "webhook";
          payload_json: string;
          destination_ref: string;
        }>;
      expect(snapshots).toHaveLength(2);
      expect(JSON.parse(snapshots.find((row) => row.channel === "webhook")!.payload_json)).toMatchObject({
        apiVersion: "v1",
        type: "climate-twin.alert",
        event: { id: eventId, resolvedAt: null, severity: "warning" },
        rule: { id: "durable-history-rule", name: "Original cold-room rule", severity: "warning" },
      });
      expect(JSON.parse(snapshots.find((row) => row.channel === "telegram")!.payload_json).text)
        .toContain("Original cold-room rule");
      expect(JSON.stringify(snapshots)).not.toContain(OLD_BOT_TOKEN);
      expect(JSON.stringify(snapshots)).not.toContain("old-webhook-secret");
      expect(JSON.stringify(snapshots)).not.toContain("https://alerts.example/old");

      expect(database.updateAlertRule("durable-history-rule", {
        name: "Edited name that must not be delivered",
        severity: "critical",
      })).not.toBeNull();
      expect(database.deleteAlertRule("durable-history-rule")).toBe(true);
      expect(database.getAlertRule("durable-history-rule")).toBeNull();
      expect(database.getAlertEvent(eventId)).toMatchObject({ id: eventId, severity: "warning" });
      expect(database.getAlertEvent(eventId)!.resolvedAt).not.toBeNull();
      expect(() => database!.deleteSensor("sensor-01")).toThrowError(expect.objectContaining({
        code: "ALERT_HISTORY_EXISTS",
        status: 409,
      }));
      expect(() => database!.db.prepare("DELETE FROM alert_rules WHERE id = ?").run("durable-history-rule"))
        .toThrow(/ALERT_RULE_HISTORY_EXISTS/);
      expect(() => database!.db.prepare("DELETE FROM sensors WHERE id = ?").run("sensor-01"))
        .toThrow(/ALERT_SENSOR_HISTORY_EXISTS/);
      expect((database.db.prepare("SELECT COUNT(*) AS count FROM notification_outbox WHERE event_id = ?")
        .get(eventId) as { count: number }).count).toBe(2);

      database.close();
      database = new ClimateDatabase(databasePath, false);
      expect(database.getAlertEvent(eventId)).not.toBeNull();
      expect(database.getAlertRule("durable-history-rule")).toBeNull();
      expect(database.pendingNotificationCount()).toBe(2);
      expect(database.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      const bus = new TelemetryBus();
      const status = new RuntimeStatus(config, bus, database);
      const webhookFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
      const telegramFetch = telegramSuccessFetch();
      worker = new NotificationOutboxWorker(
        database,
        config,
        status,
        new TelegramService(telegramFetch),
        webhookFetch,
      );
      worker.start();
      await vi.waitFor(() => expect(database!.pendingNotificationCount()).toBe(0));

      expect(webhookFetch).toHaveBeenCalledTimes(1);
      const webhookBody = JSON.parse(String(webhookFetch.mock.calls[0]![1]?.body));
      expect(webhookBody.rule).toMatchObject({
        id: "durable-history-rule",
        name: "Original cold-room rule",
        severity: "warning",
      });
      expect(webhookBody.event).toMatchObject({ id: eventId, resolvedAt: null, severity: "warning" });
      expect(JSON.parse(String(telegramFetch.mock.calls[0]![1]?.body)).text)
        .toContain("Original cold-room rule");
      expect(JSON.parse(String(telegramFetch.mock.calls[0]![1]?.body)).text)
        .not.toContain("Edited name that must not be delivered");
      expect((database.db.prepare(`SELECT COUNT(*) AS count FROM notification_outbox
        WHERE delivered_at IS NOT NULL AND abandoned_at IS NULL`).get() as { count: number }).count).toBe(2);
    } finally {
      await worker?.stop();
      database?.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("abandons queued work instead of rerouting it after destination rotation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stuga-alert-rotation-"));
    const databasePath = join(directory, "climate.sqlite");
    const oldConfig = alertConfig(directory, databasePath);
    let database: ClimateDatabase | null = new ClimateDatabase(databasePath, true);
    let worker: NotificationOutboxWorker | null = null;
    try {
      queueAlert(database, oldConfig, "rotated-destination-rule");
      database.close();
      database = new ClimateDatabase(databasePath, false);

      const rotatedConfig = alertConfig(directory, databasePath, true);
      const bus = new TelemetryBus();
      const status = new RuntimeStatus(rotatedConfig, bus, database);
      const webhookFetch = vi.fn<typeof fetch>();
      const telegramFetch = telegramSuccessFetch();
      worker = new NotificationOutboxWorker(
        database,
        rotatedConfig,
        status,
        new TelegramService(telegramFetch),
        webhookFetch,
      );
      worker.start();
      await vi.waitFor(() => expect(database!.pendingNotificationCount()).toBe(0));

      expect(webhookFetch).not.toHaveBeenCalled();
      expect(telegramFetch).not.toHaveBeenCalled();
      const rows = database.db.prepare(`SELECT delivered_at, abandoned_at, last_error
        FROM notification_outbox ORDER BY channel`).all() as Array<{
          delivered_at: string | null;
          abandoned_at: string | null;
          last_error: string | null;
        }>;
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.delivered_at === null && row.abandoned_at !== null)).toBe(true);
      expect(rows.every((row) => row.last_error?.includes("destination configuration changed"))).toBe(true);
    } finally {
      await worker?.stop();
      database?.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("migrates legacy queued rows to a safe snapshot without binding them to current credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "stuga-alert-migration-"));
    const databasePath = join(directory, "climate.sqlite");
    const config = alertConfig(directory, databasePath);
    let database: ClimateDatabase | null = new ClimateDatabase(databasePath, true);
    try {
      const eventId = queueAlert(database, config, "legacy-queue-rule");
      database.close();
      database = null;

      const legacy = new DatabaseSync(databasePath);
      legacy.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TRIGGER IF EXISTS require_notification_outbox_snapshot_insert;
        DROP TRIGGER IF EXISTS preserve_notification_outbox_snapshot_update;
        ALTER TABLE notification_outbox RENAME TO notification_outbox_current;
        CREATE TABLE notification_outbox (
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL REFERENCES alert_events(id) ON DELETE CASCADE,
          channel TEXT NOT NULL CHECK(channel IN ('webhook', 'telegram')),
          attempts INTEGER NOT NULL DEFAULT 0,
          available_at TEXT NOT NULL,
          locked_at TEXT,
          lock_token TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          delivered_at TEXT,
          UNIQUE(event_id, channel)
        );
        INSERT INTO notification_outbox
          (id, event_id, channel, attempts, available_at, locked_at, lock_token, last_error, created_at, delivered_at)
        SELECT id, event_id, channel, attempts, available_at, locked_at, lock_token, last_error, created_at, delivered_at
        FROM notification_outbox_current;
        DROP TABLE notification_outbox_current;
      `);
      legacy.close();

      database = new ClimateDatabase(databasePath, false);
      const migrated = database.db.prepare(`SELECT channel, payload_json, destination_ref, abandoned_at
        FROM notification_outbox WHERE event_id = ? ORDER BY channel`).all(eventId) as Array<{
          channel: "telegram" | "webhook";
          payload_json: string;
          destination_ref: string;
          abandoned_at: string | null;
        }>;
      expect(migrated).toHaveLength(2);
      expect(JSON.parse(migrated.find((row) => row.channel === "webhook")!.payload_json).rule)
        .toMatchObject({ id: "legacy-queue-rule", name: "Original cold-room rule" });
      expect(migrated.map((row) => row.destination_ref)).toEqual([
        "telegram:legacy-unbound",
        "webhook:legacy-unbound",
      ]);
      expect(migrated.every((row) => row.abandoned_at === null)).toBe(true);
      expect(() => database!.db.prepare(`UPDATE notification_outbox SET payload_json = '{}'
        WHERE event_id = ?`).run(eventId)).toThrow(/NOTIFICATION_SNAPSHOT_IMMUTABLE/);
    } finally {
      database?.close();
      database = null;
      try {
        rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch (error) {
        // Node's experimental DatabaseSync can keep a just-migrated file handle
        // visible to Windows briefly after close. The test outcome must not be
        // replaced by best-effort temp cleanup; other platforms still fail.
        if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
      }
    }
  });
});
