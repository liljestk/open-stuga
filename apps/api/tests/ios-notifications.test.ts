import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { TelemetryBus } from "../src/events.js";
import { DEFAULT_ALERT_DELIVERY_POLICY } from "../src/notification-policy.js";
import {
  alertNotificationBindings,
  apnsNotificationSnapshot,
} from "../src/notification-snapshot.js";
import { NotificationOutboxWorker } from "../src/outbox.js";
import { AlertEngine, RuntimeStatus } from "../src/services.js";
import { TelegramService } from "../src/telegram.js";

const OWNER = { email: "owner@example.test", password: "correct horse battery staple" };
const REGISTRATION_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_TOKEN = "ab".repeat(32);

describe("native iOS notifications", () => {
  const runtimes: ApiRuntime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  it("keeps tokens private and durably delivers a Home-scoped APNs alert", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      MOCK_ENABLED: "false",
      LOCAL_AUTH_TEST_BYPASS: "false",
    });
    config.apnsTeamId = "ABCDEFGHIJ";
    config.apnsKeyId = "K123456789";
    config.apnsBundleId = "net.nysta.stuga";
    config.apnsPrivateKey = "-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----";
    const runtime = createApi({ config, startBackground: false });
    runtimes.push(runtime);
    const owner = request.agent(runtime.app);
    const session = await owner.post("/api/v1/auth/setup").send(OWNER).expect(201);
    const csrf = session.body.csrfToken as string;

    const saved = await owner.put(`/api/v1/ios-notification-registrations/${REGISTRATION_ID}`)
      .set("x-csrf-token", csrf)
      .send({
        deviceToken: DEVICE_TOKEN,
        environment: "sandbox",
        homeIds: ["house-main"],
        minimumSeverity: "warning",
        includeDetails: false,
      })
      .expect(200);
    expect(saved.body).toMatchObject({
      configured: true,
      registration: {
        id: REGISTRATION_ID,
        homeIds: ["house-main"],
        minimumSeverity: "warning",
        includeDetails: false,
      },
    });
    expect(JSON.stringify(saved.body)).not.toContain(DEVICE_TOKEN);

    const engine = new AlertEngine(runtime.database, new TelemetryBus(), config);
    runtime.database.saveAlertRule({
      id: "ios-alert-rule",
      name: "Private temperature warning",
      sensorId: "sensor-01",
      metric: "temperature",
      operator: "gte",
      threshold: 25,
      durationSeconds: 1,
      severity: "warning",
      enabled: true,
      webhookEnabled: false,
      telegramEnabled: false,
      deliveryPolicy: { ...DEFAULT_ALERT_DELIVERY_POLICY, maxAttempts: 2 },
    });
    const base = Date.now() - 10_000;
    for (const offset of [0, 2_000]) {
      engine.evaluateSample({
        sensorId: "sensor-01",
        metric: "temperature",
        value: 26,
        canonicalUnit: runtime.database.getMeasurementDefinition("temperature")!.unit,
        timestamp: new Date(base + offset).toISOString(),
        source: "api",
        quality: "good",
      });
    }

    const queued = runtime.database.db.prepare(`SELECT channel, destination_id, payload_json
      FROM notification_outbox`).get() as {
        channel: string;
        destination_id: string;
        payload_json: string;
      };
    expect(queued.channel).toBe("apns");
    expect(queued.destination_id).toBe(REGISTRATION_ID);
    expect(queued.payload_json).not.toContain("Private temperature warning");
    expect(queued.payload_json).not.toContain("sensor-01");
    expect(queued.payload_json).not.toContain(DEVICE_TOKEN);
    expect(JSON.parse(queued.payload_json)).toMatchObject({
      aps: { category: "STUGA_ALERT" },
      stuguAlertId: expect.any(String),
    });

    const apns = { send: vi.fn(async () => undefined) };
    const worker = new NotificationOutboxWorker(
      runtime.database,
      config,
      new RuntimeStatus(config, new TelemetryBus(), runtime.database),
      {
        telegram: new TelegramService(),
        fetchImpl: fetch,
        telegramConfigurationGeneration: () => 0,
        apns,
      },
    );
    worker.start();
    await vi.waitFor(() => expect(runtime.database.pendingNotificationCount()).toBe(0));
    await worker.stop();
    expect(apns.send).toHaveBeenCalledOnce();
    expect(apns.send.mock.calls[0]?.[1]).toMatchObject({
      registrationId: REGISTRATION_ID,
      deviceToken: DEVICE_TOKEN,
      environment: "sandbox",
      canAcknowledge: true,
    });

    const event = runtime.database.listAlertEvents()[0]!;
    const rule = runtime.database.getAlertRule("ios-alert-rule")!;
    const bindings = alertNotificationBindings(config, {
      houseLabel: "Main Home",
      sensorLabel: "Living room",
    });
    const readOnly = apnsNotificationSnapshot(
      event,
      rule,
      bindings,
      { ...apns.send.mock.calls[0]![1], canAcknowledge: false },
      bindings.apnsProviderRef,
    );
    expect(JSON.parse(readOnly.payloadJson)).toMatchObject({
      aps: { category: "STUGA_ALERT_READ_ONLY" },
    });

    expect(runtime.database.enqueueAlertFollowup(
      event,
      rule,
      "reminder",
      1,
      bindings,
    )).toBe(1);
    runtime.database.db.prepare(`UPDATE ios_notification_registrations
      SET include_details = 1 WHERE id = ?`).run(REGISTRATION_ID);
    const fencedApns = { send: vi.fn(async () => undefined) };
    const fencedWorker = new NotificationOutboxWorker(
      runtime.database,
      config,
      new RuntimeStatus(config, new TelemetryBus(), runtime.database),
      {
        telegram: new TelegramService(),
        fetchImpl: fetch,
        telegramConfigurationGeneration: () => 0,
        apns: fencedApns,
      },
    );
    fencedWorker.start();
    await vi.waitFor(() => expect(runtime.database.pendingNotificationCount()).toBe(0));
    await fencedWorker.stop();
    expect(fencedApns.send).not.toHaveBeenCalled();

    expect(runtime.database.enqueueAlertFollowup(
      event,
      rule,
      "escalation",
      2,
      bindings,
    )).toBe(1);
    runtime.database.acknowledgeAlert(event.id, new Date().toISOString());
    const inactiveApns = { send: vi.fn(async () => undefined) };
    const inactiveWorker = new NotificationOutboxWorker(
      runtime.database,
      config,
      new RuntimeStatus(config, new TelemetryBus(), runtime.database),
      {
        telegram: new TelegramService(),
        fetchImpl: fetch,
        telegramConfigurationGeneration: () => 0,
        apns: inactiveApns,
      },
    );
    inactiveWorker.start();
    await vi.waitFor(() => expect(runtime.database.pendingNotificationCount()).toBe(0));
    await inactiveWorker.stop();
    expect(inactiveApns.send).not.toHaveBeenCalled();
    expect(runtime.database.listNotificationDeliveries().filter(
      (delivery) => delivery.abandonedAt !== null,
    )).toHaveLength(2);

    const invitation = await owner.post("/api/v1/tenant/members")
      .set("x-csrf-token", csrf)
      .send({ email: "member@example.test", role: "member", grants: [] })
      .expect(201);
    const member = request.agent(runtime.app);
    const memberSession = await member.post("/api/v1/auth/register")
      .send({
        token: invitation.body.registrationToken,
        password: "another correct horse battery staple",
      })
      .expect(201);
    const replacementID = "22222222-2222-4222-8222-222222222222";
    await member.put(`/api/v1/ios-notification-registrations/${replacementID}`)
      .set("x-csrf-token", memberSession.body.csrfToken)
      .send({
        deviceToken: DEVICE_TOKEN,
        environment: "sandbox",
        homeIds: ["house-main"],
        minimumSeverity: "warning",
        includeDetails: false,
      })
      .expect(200);
    const status = await owner.get(`/api/v1/ios-notification-registrations/${REGISTRATION_ID}`)
      .expect(200);
    expect(status.body.registration).toBeNull();
    await member.delete(`/api/v1/ios-notification-registrations/${replacementID}`)
      .set("x-csrf-token", memberSession.body.csrfToken)
      .expect(204);
  });
});
