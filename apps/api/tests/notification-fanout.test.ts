import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { ClimateDatabase } from "../src/db.js";
import { TelemetryBus } from "../src/events.js";
import { DEFAULT_ALERT_DELIVERY_POLICY } from "../src/notification-policy.js";
import { NotificationOutboxWorker } from "../src/outbox.js";
import { AlertEngine, RuntimeStatus } from "../src/services.js";
import { TelegramService } from "../src/telegram.js";

const OPERATIONS_SIGNING_SECRET = "operations-signing-secret".padEnd(32, "x");
const ARCHIVE_SIGNING_SECRET = "archive-signing-secret".padEnd(32, "x");

function fanoutConfig(directory: string): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: ":memory:",
    INTEGRATION_SECRETS_FILE: join(directory, "integration-secrets.json"),
    MOCK_ENABLED: "false",
    ALERT_WEBHOOK_DESTINATIONS_JSON: JSON.stringify([
      {
        id: "operations",
        url: "https://ops.example.test/hooks",
        bearerToken: "operations-bearer",
        signingSecret: OPERATIONS_SIGNING_SECRET,
      },
      {
        id: "archive",
        url: "https://archive.example.test/events",
        bearerToken: "archive-bearer",
        signingSecret: ARCHIVE_SIGNING_SECRET,
      },
    ]),
  });
}

function queueFanoutAlert(database: ClimateDatabase, config: AppConfig): string {
  const engine = new AlertEngine(database, new TelemetryBus(), config);
  database.saveAlertRule({
    id: "fanout-rule",
    name: "Fan-out delivery rule",
    sensorId: "sensor-01",
    metric: "temperature",
    operator: "lte",
    threshold: 30,
    durationSeconds: 1,
    severity: "warning",
    enabled: true,
    webhookEnabled: true,
    telegramEnabled: false,
    deliveryPolicy: { ...DEFAULT_ALERT_DELIVERY_POLICY, maxAttempts: 1 },
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
  return database.listAlertEvents().find((event) => event.ruleId === "fanout-rule")!.id;
}

describe("durable webhook fan-out", () => {
  it("signs and delivers each destination independently, then retries a dead letter", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stuga-webhook-fanout-"));
    const config = fanoutConfig(directory);
    const database = new ClimateDatabase(":memory:", true);
    let worker: NotificationOutboxWorker | null = null;
    try {
      const eventId = queueFanoutAlert(database, config);
      const queued = database.db.prepare(`SELECT destination_id, payload_json, destination_ref
        FROM notification_outbox WHERE event_id = ? ORDER BY destination_id`).all(eventId) as Array<{
          destination_id: string;
          payload_json: string;
          destination_ref: string;
        }>;
      expect(queued.map((row) => row.destination_id)).toEqual(["archive", "operations"]);
      expect(queued.every((row) => JSON.parse(row.payload_json).event.id === eventId)).toBe(true);
      expect(JSON.stringify(queued)).not.toContain("operations-bearer");
      expect(JSON.stringify(queued)).not.toContain("archive-bearer");
      expect(JSON.stringify(queued)).not.toContain(OPERATIONS_SIGNING_SECRET);
      expect(JSON.stringify(queued)).not.toContain(ARCHIVE_SIGNING_SECRET);
      expect(JSON.stringify(queued)).not.toContain("https://");

      let archiveShouldFail = true;
      const webhookFetch = vi.fn<typeof fetch>(async (input) => {
        if (String(input).includes("archive.example.test") && archiveShouldFail) {
          return new Response(null, { status: 503 });
        }
        return new Response(null, { status: 204 });
      });
      const status = new RuntimeStatus(config, new TelemetryBus(), database);
      worker = new NotificationOutboxWorker(
        database,
        config,
        status,
        new TelegramService(),
        webhookFetch,
      );
      worker.start();
      await vi.waitFor(() => expect(database.pendingNotificationCount()).toBe(0));

      expect(webhookFetch).toHaveBeenCalledTimes(2);
      for (const expected of [
        {
          id: "operations",
          host: "ops.example.test",
          bearer: "operations-bearer",
          signingSecret: OPERATIONS_SIGNING_SECRET,
        },
        {
          id: "archive",
          host: "archive.example.test",
          bearer: "archive-bearer",
          signingSecret: ARCHIVE_SIGNING_SECRET,
        },
      ]) {
        const call = webhookFetch.mock.calls.find(([input]) => String(input).includes(expected.host));
        expect(call).toBeDefined();
        const headers = new Headers(call![1]?.headers);
        const body = String(call![1]?.body);
        const timestamp = headers.get("x-stuga-timestamp");
        expect(headers.get("authorization")).toBe(`Bearer ${expected.bearer}`);
        expect(headers.get("idempotency-key"))
          .toBe(`stuga-alert-${eventId}-initial-0-${expected.id}`);
        expect(timestamp).toMatch(/^\d+$/);
        expect(headers.get("x-stuga-signature")).toBe(`sha256=${createHmac("sha256", expected.signingSecret)
          .update(`${timestamp}.${body}`, "utf8").digest("hex")}`);
      }

      const firstAttempt = database.listNotificationDeliveries();
      expect(firstAttempt.find((delivery) => delivery.destinationId === "operations")).toMatchObject({
        attempts: 0,
        maxAttempts: 1,
        deliveredAt: expect.any(String),
        deadLetteredAt: null,
        lastError: null,
      });
      const archiveDelivery = firstAttempt.find((delivery) => delivery.destinationId === "archive")!;
      expect(archiveDelivery).toMatchObject({
        attempts: 1,
        maxAttempts: 1,
        deliveredAt: null,
        deadLetteredAt: expect.any(String),
        lastError: "Webhook returned HTTP 503",
      });
      expect(status.value.webhook.destinations).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "operations", lastDeliveryAt: expect.any(String), error: null }),
        expect.objectContaining({ id: "archive", lastDeliveryAt: null, error: "Webhook returned HTTP 503" }),
      ]));
      expect(status.value.webhook.error).toBe("1 webhook destination failing");

      archiveShouldFail = false;
      expect(database.retryNotificationDelivery(archiveDelivery.id)).toBe(true);
      worker.wake();
      await vi.waitFor(() => expect(database.listNotificationDeliveries()
        .find((delivery) => delivery.id === archiveDelivery.id)?.deliveredAt).toEqual(expect.any(String)));

      expect(webhookFetch.mock.calls.filter(([input]) => String(input).includes("archive.example.test"))).toHaveLength(2);
      expect(database.listNotificationDeliveries().find((delivery) => delivery.id === archiveDelivery.id)).toMatchObject({
        attempts: 0,
        maxAttempts: 1,
        deliveredAt: expect.any(String),
        deadLetteredAt: null,
        lastError: null,
      });
      expect(status.value.webhook.error).toBeNull();
      expect(status.value.webhook.destinations?.find((destination) => destination.id === "archive")).toMatchObject({
        lastDeliveryAt: expect.any(String),
        error: null,
      });
      expect(database.retryNotificationDelivery(archiveDelivery.id)).toBe(false);
    } finally {
      await worker?.stop();
      database.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("exposes max attempts and lets an Owner requeue a terminal delivery", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      MOCK_ENABLED: "false",
      LOCAL_AUTH_TEST_BYPASS: "true",
    });
    const runtime = createApi({ config, startBackground: false });
    try {
      await runtime.notificationOutbox.stop();
      expect(runtime.database.enqueueOperationalNotification({
        subjectKind: "maintenance",
        subjectId: "maintenance-retry",
        stage: "due",
        policy: { ...DEFAULT_ALERT_DELIVERY_POLICY, maxAttempts: 1 },
        webhookEnabled: true,
        telegramEnabled: false,
        config,
        type: "maintenance.due",
        text: "Maintenance is due",
        data: { maintenanceId: "maintenance-retry" },
      })).toBe(1);
      const [claimed] = runtime.database.claimNotificationOutbox(1, new Date(Date.now() + 1_000));
      expect(claimed).toBeDefined();
      expect(runtime.database.deadLetterNotificationOutbox(claimed!.id, claimed!.lockToken, "forced terminal failure"))
        .toBe(true);

      const retried = await request(runtime.app)
        .post(`/api/v1/notification-deliveries/${claimed!.id}/retry`)
        .expect(200);
      expect(retried.body.delivery).toMatchObject({
        id: claimed!.id,
        attempts: 0,
        maxAttempts: 1,
        deadLetteredAt: null,
        abandonedAt: null,
        lastError: null,
      });
      const listed = await request(runtime.app).get("/api/v1/notification-deliveries").expect(200);
      expect(listed.body.deliveries).toContainEqual(expect.objectContaining({
        id: claimed!.id,
        maxAttempts: 1,
      }));
      await request(runtime.app)
        .post(`/api/v1/notification-deliveries/${claimed!.id}/retry`)
        .expect(409);
    } finally {
      await runtime.close();
    }
  });
});
