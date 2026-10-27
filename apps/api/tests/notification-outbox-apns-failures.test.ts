import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APNSDeliveryError } from "../src/apns.js";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { TelemetryBus } from "../src/events.js";
import { DEFAULT_ALERT_DELIVERY_POLICY } from "../src/notification-policy.js";
import { NotificationOutboxWorker, type NotificationDeliveryFailure } from "../src/outbox.js";
import { AlertEngine, RuntimeStatus } from "../src/services.js";
import { TelegramService } from "../src/telegram.js";

const OWNER = { email: "owner@example.test", password: "correct horse battery staple" };
const REGISTRATION_ID = "22222222-2222-4222-8222-222222222222";

describe("APNs outbox failures", () => {
  const runtimes: ApiRuntime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  async function queuedApnsAlert() {
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
    await owner.put(`/api/v1/ios-notification-registrations/${REGISTRATION_ID}`)
      .set("x-csrf-token", session.body.csrfToken as string)
      .send({
        deviceToken: "cd".repeat(32),
        environment: "sandbox",
        homeIds: ["house-main"],
        minimumSeverity: "warning",
        includeDetails: false,
      })
      .expect(200);
    runtime.database.saveAlertRule({
      id: "apns-failure-rule",
      name: "Temperature warning",
      sensorId: "sensor-01",
      metric: "temperature",
      operator: "gte",
      threshold: 25,
      durationSeconds: 1,
      severity: "warning",
      enabled: true,
      webhookEnabled: false,
      telegramEnabled: false,
      deliveryPolicy: { ...DEFAULT_ALERT_DELIVERY_POLICY, maxAttempts: 3 },
    });
    const engine = new AlertEngine(runtime.database, new TelemetryBus(), config);
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
    expect(runtime.database.pendingNotificationCount()).toBe(1);
    return { runtime, config };
  }

  function registrationEnabled(runtime: ApiRuntime): number {
    return (runtime.database.db.prepare("SELECT enabled FROM ios_notification_registrations WHERE id = ?")
      .get(REGISTRATION_ID) as { enabled: number }).enabled;
  }

  it("dead-letters a terminal APNs rejection and disables an invalid device token", async () => {
    const { runtime, config } = await queuedApnsAlert();
    const failures: NotificationDeliveryFailure[] = [];
    const apns = { send: vi.fn(async () => { throw new APNSDeliveryError("Device token is no longer valid", true, "BadDeviceToken"); }) };
    const worker = new NotificationOutboxWorker(
      runtime.database,
      config,
      new RuntimeStatus(config, new TelemetryBus(), runtime.database),
      new TelegramService(),
      fetch,
      () => 0,
      apns,
      (failure) => failures.push(failure),
    );
    worker.start();
    await vi.waitFor(() => expect(runtime.database.pendingNotificationCount()).toBe(0));
    await worker.stop();

    expect(apns.send).toHaveBeenCalledOnce();
    expect(failures).toEqual([{ channel: "apns", subjectKind: "alert", message: "Device token is no longer valid", terminal: true }]);
    expect(runtime.database.listNotificationDeliveries(10)[0]).toMatchObject({
      channel: "apns",
      deadLetteredAt: expect.any(String),
      lastError: "Device token is no longer valid",
    });
    expect(registrationEnabled(runtime)).toBe(0);
  });

  it("retries a transient APNs failure and keeps the registration enabled", async () => {
    const { runtime, config } = await queuedApnsAlert();
    const failures: NotificationDeliveryFailure[] = [];
    const apns = { send: vi.fn(async () => { throw new APNSDeliveryError("APNs is temporarily unavailable", false, "ServiceUnavailable"); }) };
    const worker = new NotificationOutboxWorker(
      runtime.database,
      config,
      new RuntimeStatus(config, new TelemetryBus(), runtime.database),
      new TelegramService(),
      fetch,
      () => 0,
      apns,
      (failure) => failures.push(failure),
    );
    worker.start();
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    await worker.stop();

    expect(apns.send).toHaveBeenCalledOnce();
    expect(failures).toEqual([{ channel: "apns", subjectKind: "alert", message: "APNs is temporarily unavailable", terminal: false }]);
    expect(runtime.database.listNotificationDeliveries(10)[0]).toMatchObject({
      attempts: 1,
      deadLetteredAt: null,
      deliveredAt: null,
      lastError: "APNs is temporarily unavailable",
    });
    expect(Date.parse(runtime.database.listNotificationDeliveries(10)[0]!.availableAt)).toBeGreaterThan(Date.now());
    expect(registrationEnabled(runtime)).toBe(1);
  });
});
