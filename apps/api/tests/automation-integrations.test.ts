import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ClimateDatabase } from "../src/db.js";
import { readIntegrationSecrets } from "../src/integration-secrets.js";
import { TelegramService } from "../src/telegram.js";

const BOT_TOKEN = "123456:stuga_test_bot_token";
const CHAT_ID = "9007199254740993";

function telegramSuccessFetch() {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const method = String(input).split("/").at(-1);
    const result = method === "getMe"
      ? { id: 7, username: "stuga_test_bot" }
      : method === "getUpdates"
        ? [
            { message: { chat: { id: CHAT_ID, type: "private", first_name: "Alice", username: "alice" } } },
            { edited_message: { chat: { id: CHAT_ID, type: "private", first_name: "Alice", username: "alice" } } },
            { message: { chat: { id: "-100123", type: "supergroup", title: "Not eligible" } } },
            { my_chat_member: { chat: { id: "42", type: "private", first_name: "Bob" } } },
          ]
        : method === "getChat"
          ? { id: CHAT_ID, type: "private", first_name: "Alice", username: "alice" }
          : { message_id: 1 };
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("Telegram and Apple Notes local automations", () => {
  let directory: string | null = null;
  let runtime: ApiRuntime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  function boot(fetchImpl: typeof fetch = telegramSuccessFetch()): {
    secretsPath: string;
    databasePath: string;
  } {
    directory = mkdtempSync(join(tmpdir(), "stuga-automations-"));
    const secretsPath = join(directory, "private", "integrations.json");
    const databasePath = join(directory, "climate.sqlite");
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: databasePath,
      INTEGRATION_SECRETS_FILE: secretsPath,
      MOCK_ENABLED: "false",
    });
    runtime = createApi({ config, startBackground: false, telegram: new TelegramService(fetchImpl) });
    return { secretsPath, databasePath };
  }

  it("discovers only private chats, validates the selection, and keeps the bot token write-only", async () => {
    const telegramFetch = telegramSuccessFetch();
    const { secretsPath, databasePath } = boot(telegramFetch);

    const discovery = await request(runtime!.app).post("/api/v1/integrations/telegram/discover")
      .send({ botToken: BOT_TOKEN }).expect(200);
    expect(discovery.body).toEqual({
      botUsername: "stuga_test_bot",
      chats: [
        { id: CHAT_ID, label: "Alice", username: "alice", type: "private" },
        { id: "42", label: "Bob", username: null, type: "private" },
      ],
      message: "Select the private chat that should receive Stuga alerts.",
    });

    const configured = await request(runtime!.app).put("/api/v1/integrations/telegram/config")
      .send({ botToken: BOT_TOKEN, chatId: CHAT_ID }).expect(200);
    expect(configured.body).toMatchObject({
      ok: true,
      configured: true,
      integration: {
        telegram: {
          available: true,
          configured: true,
          connected: false,
          botUsername: "stuga_test_bot",
          chatLabel: "Alice",
        },
      },
    });
    expect(JSON.stringify(configured.body)).not.toContain(BOT_TOKEN);
    expect(readIntegrationSecrets(secretsPath).telegram).toEqual({ botToken: BOT_TOKEN, chatId: CHAT_ID });

    runtime!.close();
    runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: databasePath,
        INTEGRATION_SECRETS_FILE: secretsPath,
        MOCK_ENABLED: "false",
      }),
      startBackground: false,
      telegram: new TelegramService(telegramFetch),
    });
    expect(runtime.status.value.telegram).toMatchObject({
      configured: true,
      connected: false,
      botUsername: "stuga_test_bot",
      chatLabel: "Alice",
    });
    const tested = await request(runtime.app).post("/api/v1/integrations/telegram/test").expect(200);
    expect(tested.body).toEqual({ ok: true, message: "The Telegram test message was delivered." });
    expect(runtime.status.value.telegram).toMatchObject({
      configured: true,
      connected: true,
      botUsername: "stuga_test_bot",
      chatLabel: "Alice",
    });
    const sendCall = telegramFetch.mock.calls.find(([input]) => String(input).endsWith("/sendMessage"));
    expect(sendCall).toBeDefined();
    expect(JSON.parse(String(sendCall?.[1]?.body))).toMatchObject({
      chat_id: CHAT_ID,
      protect_content: true,
      disable_notification: false,
    });

    const disconnected = await request(runtime!.app).delete("/api/v1/integrations/telegram/config").expect(200);
    expect(disconnected.body).toMatchObject({ ok: true, integration: { telegram: { configured: false, connected: false } } });
    expect(readIntegrationSecrets(secretsPath).telegram).toBeUndefined();
  });

  it("sanitizes Telegram failures without echoing the bot token or Telegram response", async () => {
    const failingFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      description: `bad token ${BOT_TOKEN}`,
    }), { status: 401, headers: { "content-type": "application/json" } }));
    boot(failingFetch);

    const failed = await request(runtime!.app).post("/api/v1/integrations/telegram/discover")
      .send({ botToken: BOT_TOKEN }).expect(400);
    expect(failed.body.error).toEqual({
      code: "TELEGRAM_INVALID_CREDENTIALS",
      message: "Telegram rejected the bot credentials",
    });
    expect(JSON.stringify(failed.body)).not.toContain(BOT_TOKEN);
  });

  it("sends one protected, silent, label-rich message for a newly opened enabled real alert", async () => {
    const telegramFetch = telegramSuccessFetch();
    boot(telegramFetch);
    const configuredRuntime = runtime!;

    // Configure through the public route so delivery uses exactly the persisted runtime values.
    await request(configuredRuntime.app).put("/api/v1/integrations/telegram/config")
      .send({ botToken: BOT_TOKEN, chatId: CHAT_ID }).expect(200);
    await request(configuredRuntime.app).post("/api/v1/alert-rules").send({
      name: "Cold room warning",
      sensorId: "sensor-01",
      metric: "temperature",
      operator: "lte",
      threshold: 30,
      durationSeconds: 1,
      severity: "info",
      telegramEnabled: true,
    }).expect(201);
    await request(configuredRuntime.app).post("/api/v1/alert-rules").send({
      name: "Disabled Telegram route",
      sensorId: "sensor-02",
      metric: "temperature",
      operator: "lte",
      threshold: 30,
      durationSeconds: 1,
      severity: "warning",
      telegramEnabled: false,
    }).expect(201);
    for (const [sensorId, source] of [["sensor-03", "mock"], ["sensor-04", "replay"]] as const) {
      await request(configuredRuntime.app).post("/api/v1/alert-rules").send({
        name: `${source} Telegram guard`,
        sensorId,
        metric: "temperature",
        operator: "lte",
        threshold: 30,
        durationSeconds: 1,
        severity: "warning",
        telegramEnabled: true,
      }).expect(201);
    }

    const first = new Date(Date.now() - 10_000).toISOString();
    const second = new Date(Date.now() - 8_000).toISOString();
    for (const [sensorId, source] of [["sensor-03", "mock"], ["sensor-04", "replay"]] as const) {
      configuredRuntime.measurements.ingest({
        sensorId, metric: "temperature", value: 20, canonicalUnit: "°C", timestamp: first, source, quality: "good",
      });
      configuredRuntime.measurements.ingest({
        sensorId, metric: "temperature", value: 20, canonicalUnit: "°C", timestamp: second, source, quality: "good",
      });
    }
    expect(telegramFetch.mock.calls.filter(([input]) => String(input).endsWith("/sendMessage"))).toHaveLength(0);
    configuredRuntime.measurements.ingest({
      sensorId: "sensor-01", metric: "temperature", value: 20, canonicalUnit: "°C", timestamp: first, source: "api", quality: "good",
    });
    configuredRuntime.measurements.ingest({
      sensorId: "sensor-01", metric: "temperature", value: 20, canonicalUnit: "°C", timestamp: second, source: "api", quality: "good",
    });
    configuredRuntime.measurements.ingest({
      sensorId: "sensor-02", metric: "temperature", value: 20, canonicalUnit: "°C", timestamp: first, source: "api", quality: "good",
    });
    configuredRuntime.measurements.ingest({
      sensorId: "sensor-02", metric: "temperature", value: 20, canonicalUnit: "°C", timestamp: second, source: "api", quality: "good",
    });

    await vi.waitFor(() => {
      expect(telegramFetch.mock.calls.filter(([input]) => String(input).endsWith("/sendMessage"))).toHaveLength(1);
      expect(configuredRuntime.status.value.telegram!.lastDeliveryAt).not.toBeNull();
    });
    const sendCall = telegramFetch.mock.calls.find(([input]) => String(input).endsWith("/sendMessage"));
    const payload = JSON.parse(String(sendCall?.[1]?.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      chat_id: CHAT_ID,
      protect_content: true,
      disable_notification: true,
    });
    expect(payload.text).toContain("House: My home");
    expect(payload.text).toContain("Sensor: Living room — window");
    expect(payload.text).not.toContain("<b>");
    expect(configuredRuntime.status.value.telegram).toMatchObject({ connected: true, error: null });
    expect(configuredRuntime.status.value.telegram!.lastDeliveryAt).not.toBeNull();
  });

  it("retries durable notification outbox deliveries without recreating the alert", async () => {
    let sendAttempts = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const method = String(input).split("/").at(-1);
      if (method === "sendMessage" && ++sendAttempts === 1) {
        return new Response(JSON.stringify({ ok: false }), { status: 503, headers: { "content-type": "application/json" } });
      }
      const result = method === "getMe"
        ? { id: 7, username: "stuga_test_bot" }
        : method === "getChat"
          ? { id: CHAT_ID, type: "private", first_name: "Alice" }
          : { message_id: sendAttempts };
      return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
    });
    boot(fetchImpl);
    await request(runtime!.app).put("/api/v1/integrations/telegram/config")
      .send({ botToken: BOT_TOKEN, chatId: CHAT_ID }).expect(200);
    await request(runtime!.app).post("/api/v1/alert-rules").send({
      id: "durable-telegram", name: "Durable Telegram", sensorId: "sensor-01", metric: "temperature",
      operator: "lte", threshold: 30, durationSeconds: 1, severity: "warning", telegramEnabled: true,
    }).expect(201);
    const base = Date.now() - 5_000;
    for (const offset of [0, 2_000]) runtime!.measurements.ingest({
      sensorId: "sensor-01", metric: "temperature", value: 20,
      canonicalUnit: runtime!.database.getMeasurementDefinition("temperature")!.unit,
      timestamp: new Date(base + offset).toISOString(), source: "api", quality: "good",
    });

    await vi.waitFor(() => expect(sendAttempts).toBe(2), { timeout: 4_000 });
    expect(runtime!.database.listAlertEvents()).toHaveLength(1);
    expect(runtime!.database.pendingNotificationCount()).toBe(0);
    const outbox = runtime!.database.db.prepare("SELECT attempts, delivered_at FROM notification_outbox").get() as {
      attempts: number; delivered_at: string | null;
    };
    expect(outbox.attempts).toBe(1);
    expect(outbox.delivered_at).not.toBeNull();
  });

  it("hashes one-time Notes tokens, scopes bearer access, and makes capture retries idempotent", async () => {
    const { secretsPath, databasePath } = boot();
    const missingAuth = await request(runtime!.app).get("/api/v1/integrations/apple-notes/snapshot")
      .query({ houseId: "house-main" }).expect(401);
    expect(missingAuth.headers["cache-control"]).toBe("no-store");

    const created = await request(runtime!.app).post("/api/v1/integrations/apple-notes/grants")
      .send({ houseId: "house-main", deviceLabel: "Niklas's iPhone" }).expect(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    expect(created.body).toMatchObject({
      deviceLabel: "Niklas's iPhone",
      houseId: "house-main",
      integration: { appleNotes: { available: true, configured: true, grantCount: 1 } },
    });
    const token = created.body.token as string;
    expect(token).toMatch(/^stuga_notes_[A-Za-z0-9_-]{43}$/);
    const tokenHash = `sha256:${createHash("sha256").update(token).digest("hex")}`;
    const secretsText = readFileSync(secretsPath, "utf8");
    expect(secretsText).not.toContain(token);
    expect(secretsText).toContain(tokenHash);
    expect(readFileSync(databasePath).includes(Buffer.from(token))).toBe(false);

    const grants = await request(runtime!.app).get("/api/v1/integrations/apple-notes/grants").expect(200);
    expect(grants.headers["cache-control"]).toBe("no-store");
    expect(grants.body.grants).toEqual([{
      id: created.body.id,
      deviceLabel: "Niklas's iPhone",
      houseId: "house-main",
      createdAt: created.body.createdAt,
    }]);
    expect(JSON.stringify(grants.body)).not.toContain("token");
    const status = await request(runtime!.app).get("/api/v1/integrations/status").expect(200);
    expect(JSON.stringify(status.body)).not.toContain(token);
    await request(runtime!.app).get("/api/v1/integrations/apple-notes/snapshot")
      .set("Authorization", "Bearer definitely-wrong").query({ houseId: "house-main" }).expect(401);
    await request(runtime!.app).get("/api/v1/integrations/apple-notes/snapshot")
      .set("Authorization", `Bearer ${token}`).query({ houseId: "another-house" }).expect(403);

    await request(runtime!.app).post("/api/v1/property-areas").send({
      id: "notes-area",
      propertyId: "property-main",
      name: "Notes area",
      kind: "yard",
      polygon: [
        { latitude: 60.17, longitude: 24.93 },
        { latitude: 60.17, longitude: 24.931 },
        { latitude: 60.171, longitude: 24.931 },
      ],
    }).expect(201);
    await request(runtime!.app).post("/api/v1/area-equipment").send({
      id: "notes-equipment",
      propertyId: "property-main",
      areaId: "notes-area",
      name: "Notes equipment",
      kind: "pump",
    }).expect(201);

    const operationId = "11111111-1111-4111-8111-111111111111";
    const command = {
      schema: "stuga.apple-notes-command/v1",
      operationId,
      houseId: "house-main",
      title: "Inspect roof flashing",
      description: "Captured from Siri",
      basis: "condition-based",
      priority: "high",
      plannedFor: "2026-08-01",
    };
    const first = await request(runtime!.app).post("/api/v1/integrations/apple-notes/capture")
      .set("Authorization", `Bearer ${token}`).send(command).expect(201);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.body).toMatchObject({
      ok: true,
      deduplicated: false,
      task: { id: `apple-notes-${operationId}`, title: command.title, revision: 1 },
      receipt: `apple-notes:${operationId}`,
    });
    const retry = await request(runtime!.app).post("/api/v1/integrations/apple-notes/capture")
      .set("Authorization", `Bearer ${token}`).send(command).expect(200);
    expect(retry.body).toMatchObject({ ok: true, deduplicated: true, task: { id: first.body.task.id }, receipt: first.body.receipt });
    expect(runtime!.database.listMaintenanceTasks("house-main").filter((task) => task.id === first.body.task.id)).toHaveLength(1);
    expect(runtime!.database.listMaintenanceTaskRevisions(first.body.task.id)).toHaveLength(1);
    await request(runtime!.app).post("/api/v1/integrations/apple-notes/capture")
      .set("Authorization", `Bearer ${token}`).send({ ...command, title: "Different content" }).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("APPLE_NOTES_OPERATION_CONFLICT"));
    await request(runtime!.app).post("/api/v1/integrations/apple-notes/capture")
      .set("Authorization", `Bearer ${token}`).send({ ...command, areaId: "notes-area" }).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("APPLE_NOTES_OPERATION_CONFLICT"));
    await request(runtime!.app).post("/api/v1/integrations/apple-notes/capture")
      .set("Authorization", `Bearer ${token}`).send({ ...command, equipmentId: "notes-equipment" }).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("APPLE_NOTES_OPERATION_CONFLICT"));
    await request(runtime!.app).post("/api/v1/integrations/apple-notes/capture")
      .set("Authorization", `Bearer ${token}`).send({ ...command, operationId: "22222222-2222-4222-8222-222222222222", houseId: "another-house" })
      .expect(403);

    const snapshot = await request(runtime!.app).get("/api/v1/integrations/apple-notes/snapshot")
      .set("Authorization", `Bearer ${token}`).query({ houseId: "house-main" }).expect(200);
    expect(snapshot.headers["cache-control"]).toBe("no-store");
    expect(snapshot.body).toMatchObject({
      schema: "stuga.apple-notes-snapshot/v1",
      houseId: "house-main",
      maintenanceTasks: [expect.objectContaining({ id: first.body.task.id })],
    });
    expect(snapshot.body.title).toMatch(/^My home maintenance — \d{4}-\d{2}-\d{2} — Stuga$/);
    expect(snapshot.body.text).toContain(snapshot.body.generatedAt);
    expect(snapshot.body.text).toContain("new dated generated note");
    expect(runtime!.status.value.appleNotes!.lastSyncAt).toBe(snapshot.body.generatedAt);

    const revoked = await request(runtime!.app).delete(`/api/v1/integrations/apple-notes/grants/${created.body.id}`).expect(200);
    expect(revoked.body).toMatchObject({ ok: true, integration: { appleNotes: { configured: false, grantCount: 0 } } });
    await request(runtime!.app).get("/api/v1/integrations/apple-notes/snapshot")
      .set("Authorization", `Bearer ${token}`).query({ houseId: "house-main" }).expect(401);
  });

  it("migrates legacy alert rules and defaults Telegram delivery to disabled", async () => {
    directory = mkdtempSync(join(tmpdir(), "stuga-alert-migration-"));
    const databasePath = join(directory, "legacy.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`CREATE TABLE alert_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sensor_id TEXT,
      metric TEXT NOT NULL,
      operator TEXT NOT NULL,
      threshold REAL NOT NULL,
      duration_seconds INTEGER NOT NULL,
      severity TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      webhook_enabled INTEGER NOT NULL
    );`);
    legacy.prepare(`INSERT INTO alert_rules
      (id, name, sensor_id, metric, operator, threshold, duration_seconds, severity, enabled, webhook_enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("legacy-rule", "Legacy rule", null, "humidity", "gte", 65, 60, "warning", 1, 0);
    legacy.close();

    const database = new ClimateDatabase(databasePath, false);
    try {
      expect(database.getAlertRule("legacy-rule")).toMatchObject({ telegramEnabled: false });
      const columns = database.db.prepare("PRAGMA table_info(alert_rules)").all() as Array<{ name: string; dflt_value: string | null }>;
      expect(columns.find((column) => column.name === "telegram_enabled")?.dflt_value).toBe("0");
    } finally {
      database.close();
    }
  });
});
