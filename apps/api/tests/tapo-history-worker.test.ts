import { createHash, createHmac, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ClimateDatabase } from "../src/db.js";
import {
  maxTapoHistoryJobSpanMs,
  parseTapoHistoryCsv,
  TAPO_HISTORY_ACCEPTANCE_REVISION,
  TAPO_HISTORY_API_IMPLEMENTATION_SHA256,
  TAPO_HISTORY_CSV_PARSER_VERSION,
  TAPO_TARGET_RECLAIM_GRACE_MS,
  tapoExportRecipient,
  TapoHistoryExportService,
} from "../src/tapo-history-export.js";

const WORKER_TOKEN = "worker-token-with-at-least-thirty-two-bytes";
const DEPLOYMENT_FINGERPRINT = "1".repeat(64);
const DEPLOYMENT_HEADER = { "x-tapo-deployment-fingerprint": DEPLOYMENT_FINGERPRINT };
const APPROVED_SCHEMA_SIGNATURE = parseTapoHistoryCsv(
  "Time,Temperature(°C),Humidity(%)\n2026-01-15 12:00:00,20,45\n",
  { sensorId: "schema-fixture", timeZone: "Europe/Helsinki" },
).schemaSignature;
const ACCEPTANCE_REVISION = createHash("sha256").update(JSON.stringify({
  acceptanceContract: TAPO_HISTORY_ACCEPTANCE_REVISION,
  apiImplementationSha256: TAPO_HISTORY_API_IMPLEMENTATION_SHA256,
  runtime: {
    node: process.version,
    icu: process.versions.icu ?? null,
    tz: process.versions.tz ?? null,
    cldr: process.versions.cldr ?? null,
    unicode: process.versions.unicode ?? null,
  },
  parser: TAPO_HISTORY_CSV_PARSER_VERSION,
  exportEmail: "owner@gmail.com",
  gmailAccountEmail: "owner@gmail.com",
  gmailClientId: "client-id",
  mailboxCredentialProof: createHmac("sha256", WORKER_TOKEN).update("refresh-token", "utf8").digest("hex"),
})).digest("hex");

function approveTarget(
  database: ClimateDatabase,
  sensorId: string,
  at = new Date(),
): void {
  const from = new Date(at.getTime() - 2 * 60 * 60_000).toISOString();
  const to = new Date(at.getTime() - 15 * 60_000).toISOString();
  const sensor = database.getSensor(sensorId)!;
  const house = database.getHouse(sensor.houseId)!;
  const canary = database.enqueueTapoHistoryExportJob({
    provider: "appium",
    sensorId,
    expectedDeviceId: sensor.tpLinkDeviceId!,
    deviceName: "Cellar",
    timeZone: house.timezone,
    metric: "temperature",
    expectedRecipient: "owner+canary-fixture@gmail.com",
    rangeStart: from,
    rangeEnd: to,
    intervalMinutes: 15,
    dedupeKey: `canary:test:${randomUUID()}`,
  }, at.toISOString()).job;
  const claim = database.claimNextTapoHistoryExportJob(
    "canary-fixture",
    at.toISOString(),
    new Date(at.getTime() + 5 * 60_000).toISOString(),
    ["appium"],
    at.toISOString(),
    {
      canaryOnly: true,
      deploymentFingerprint: DEPLOYMENT_FINGERPRINT,
      acceptanceRevision: ACCEPTANCE_REVISION,
    },
  )!;
  database.transitionTapoHistoryExportJob(canary.id, {
    status: "waiting-email",
    at: new Date(at.getTime() + 1_000).toISOString(),
    leaseToken: claim.leaseToken,
  });
  const timestamp = new Date(Date.parse(from) + 15 * 60_000).toISOString();
  database.completeTapoHistoryExportJobWithSamples(canary.id, [{
    metric: "temperature", value: 20, canonicalUnit: "\u00b0C", timestamp, sourceIdentity: "canary:temperature",
  }, {
    metric: "humidity", value: 45, canonicalUnit: "%", timestamp, sourceIdentity: "canary:humidity",
  }], {
    mailboxMessageId: `canary-mail-${canary.id}`,
    expectedRecipient: canary.expectedRecipient!,
    expectedSubmittedAt: new Date(at.getTime() + 1_000).toISOString(),
    completedAt: new Date(at.getTime() + 2_000).toISOString(),
    sourceArtifactSha256: "c".repeat(64),
    sourceArtifactBytes: 128,
    parserVersion: "canary-fixture-v1",
    sourceSchemaSignature: APPROVED_SCHEMA_SIGNATURE,
  });
  database.approveTapoHistoryDeploymentFromCanary(
    canary.id,
    ACCEPTANCE_REVISION,
    new Date(at.getTime() + 2_000).toISOString(),
  );
}

describe("automated Tapo history worker protocol", () => {
  let runtime: ApiRuntime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  it("keeps worker routes disabled by default and route-scopes the bearer token", async () => {
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false" }),
      startBackground: false,
    });
    await request(runtime.app).get("/api/v1/internal/tapo-history/jobs/claim?workerId=runner-1")
      .set("authorization", `Bearer ${WORKER_TOKEN}`).expect(404);
    await request(runtime.app).get("/API/V1/INTERNAL/TAPO-HISTORY/jobs/claim?workerId=runner-1")
      .set("authorization", `Bearer ${WORKER_TOKEN}`).expect(404);
  });

  it("leases one job, fences stale updates, and exposes operator controls without the lease token", async () => {
    const config = loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false",
      TAPO_HISTORY_ENABLED: "true",
      TAPO_HISTORY_WORKER_TOKEN: WORKER_TOKEN,
      TAPO_HISTORY_EXPORT_EMAIL: "owner@gmail.com",
      TAPO_HISTORY_GMAIL_CLIENT_ID: "client-id",
      TAPO_HISTORY_GMAIL_CLIENT_SECRET: "client-secret",
      TAPO_HISTORY_GMAIL_REFRESH_TOKEN: "refresh-token",
    });
    runtime = createApi({ config, startBackground: false, tapoHistoryDeviceNameFor: () => "Cellar" });
    const sensor = runtime.database.listSensors()[0]!;
    runtime.database.updateSensor(sensor.id, { tpLinkDeviceId: "t315-cellar", tpLinkConnectionId: "connection-1" });
    approveTarget(runtime.database, sensor.id);
    const from = "2026-01-15T10:00:00.000Z";
    const to = "2026-01-15T11:00:00.000Z";
    await expect(runtime.tapoHistory.recoverHistory(sensor.id, "temperature", from, to)).resolves.toMatchObject({
      state: "partial", samples: [],
    });

    await request(runtime.app).get("/api/v1/internal/tapo-history/jobs/claim?workerId=runner-1")
      .set("authorization", "Bearer wrong").expect(401);
    const claimed = await request(runtime.app).get(`/api/v1/internal/tapo-history/jobs/claim?workerId=runner-1&deploymentFingerprint=${DEPLOYMENT_FINGERPRINT}`)
      .set("authorization", `Bearer ${WORKER_TOKEN}`).set(DEPLOYMENT_HEADER).expect(200);
    const claimedJob = claimed.body.job;
    const leaseToken = claimed.body.leaseToken as string;
    expect(claimed.body).toEqual({
      job: expect.any(Object), leaseToken: expect.any(String), serverNow: expect.any(String),
    });
    expect(claimedJob).toMatchObject({
      status: "claimed", sensorId: sensor.id, deviceId: "t315-cellar", metric: "temperature",
      timeZone: "Europe/Helsinki",
      expectedRecipient: expect.stringMatching(/^owner\+stuga-[a-f0-9]{32}@gmail\.com$/),
    });
    expect(claimedJob).not.toHaveProperty("dedupeKey");
    expect(claimedJob.expectedRecipient).not.toBe(tapoExportRecipient("owner@gmail.com", claimedJob.id));

    await request(runtime.app).post(`/api/v1/internal/tapo-history/jobs/${claimedJob.id}/heartbeat`)
      .set("authorization", `Bearer ${WORKER_TOKEN}`)
      .set(DEPLOYMENT_HEADER)
      .send({ workerId: "runner-2", leaseToken }).expect(409);
    await request(runtime.app).post(`/api/v1/internal/tapo-history/jobs/${claimedJob.id}/status`)
      .set("authorization", `Bearer ${WORKER_TOKEN}`)
      .set(DEPLOYMENT_HEADER)
      .send({ workerId: "runner-1", leaseToken, status: "running" }).expect(200);
    await request(runtime.app).post(`/api/v1/internal/tapo-history/jobs/${claimedJob.id}/heartbeat`)
      .set("authorization", `Bearer ${WORKER_TOKEN}`)
      .set(DEPLOYMENT_HEADER)
      .send({ workerId: "runner-1", leaseToken }).expect(200);
    await request(runtime.app).post(`/api/v1/internal/tapo-history/jobs/${claimedJob.id}/status`)
      .set("authorization", `Bearer ${WORKER_TOKEN}`)
      .set(DEPLOYMENT_HEADER)
      .send({
        workerId: "runner-1",
        leaseToken,
        status: "waiting-email",
        detail: `accepted for ${claimedJob.expectedRecipient}`,
      }).expect(200);

    const listed = await request(runtime.app).get("/api/v1/integrations/tp-link/history-export/jobs").expect(200);
    expect(listed.body).toMatchObject({
      enabled: true,
      jobs: expect.arrayContaining([expect.objectContaining({
        id: claimedJob.id, status: "waiting-email", expectedRecipient: null, mailboxMessageId: null, leaseOwner: null,
      })]),
    });
    expect(JSON.stringify(listed.body)).not.toContain(leaseToken);
    expect(JSON.stringify(listed.body)).not.toContain(claimedJob.expectedRecipient);
    expect(listed.body.jobs[0]).not.toHaveProperty("dedupeKey");
    await request(runtime.app).delete(`/api/v1/integrations/tp-link/history-export/jobs/${claimedJob.id}`).expect(200)
      .expect(({ body }) => expect(body.job.status).toBe("cancelled"));
    await request(runtime.app).post(`/api/v1/integrations/tp-link/history-export/jobs/${claimedJob.id}/retry`).expect(200)
      .expect(({ body }) => expect(body.job.status).toBe("queued"));
  });

  it("atomically permits only one outstanding Appium export by default across workers", async () => {
    const database = new ClimateDatabase(":memory:");
    const sensor = database.listSensors()[0]!;
    database.updateSensor(sensor.id, { tpLinkDeviceId: "t315-cellar", tpLinkConnectionId: "connection-1" });
    const service = new TapoHistoryExportService(loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false",
      TAPO_HISTORY_ENABLED: "true", TAPO_HISTORY_WORKER_TOKEN: WORKER_TOKEN,
      TAPO_HISTORY_EXPORT_EMAIL: "owner@gmail.com",
      TAPO_HISTORY_GMAIL_CLIENT_ID: "client-id",
      TAPO_HISTORY_GMAIL_CLIENT_SECRET: "client-secret",
      TAPO_HISTORY_GMAIL_REFRESH_TOKEN: "refresh-token",
    }), database, { deviceNameFor: () => "Cellar" });
    try {
      approveTarget(database, sensor.id);
      await service.recoverHistory(sensor.id, "temperature", "2026-01-15T09:00:00Z", "2026-01-15T11:00:00Z");
      await service.recoverHistory(sensor.id, "temperature", "2026-01-16T09:00:00Z", "2026-01-16T11:00:00Z");

      const first = service.claim("runner-1", DEPLOYMENT_FINGERPRINT)!;
      expect(first.job.status).toBe("claimed");
      expect(service.claim("runner-2", DEPLOYMENT_FINGERPRINT)).toBeNull();

      service.updateFromWorker(first.job.id, first.leaseToken, { status: "waiting-email" });
      expect(service.claim("runner-2", DEPLOYMENT_FINGERPRINT)).toBeNull();

      service.cancel(first.job.id);
      const second = service.claim("runner-2", DEPLOYMENT_FINGERPRINT);
      expect(second?.job.id).not.toBe(first.job.id);
      expect(second?.job.status).toBe("claimed");
    } finally {
      await service.stop();
      database.close();
    }
  });

  it("correlates a Gmail CSV by plus-address and stages it for the gap coordinator", async () => {
    const database = new ClimateDatabase(":memory:");
    const sensor = database.listSensors()[0]!;
    database.updateSensor(sensor.id, { tpLinkDeviceId: "t315-cellar", tpLinkConnectionId: "connection-1" });
    const csv = `Time,Temperature(\u00b0C),Humidity(%)\n${[
      "11:00", "11:15", "11:30", "11:45", "12:00", "12:15", "12:30", "12:45", "13:00",
    ].map((time) => `2026-01-15 ${time}:00,21.5,44`).join("\n")}\n`;
    let recipient = "";
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "access", expires_in: 3600 });
      if (url.endsWith("/users/me/profile")) return Response.json({ emailAddress: "owner@gmail.com" });
      if (url.includes("/users/me/messages?")) return Response.json({ messages: [{ id: "mail-1" }] });
      if (url.includes("/users/me/messages/mail-1?")) return Response.json({
        id: "mail-1",
        internalDate: String(Date.now()),
        payload: {
          headers: [{ name: "To", value: `Stuga export <${recipient}>` }],
          parts: [{ filename: "Tapo_sensor_data.csv", body: { data: Buffer.from(csv).toString("base64url"), size: csv.length } }],
        },
      });
      return new Response("not found", { status: 404 });
    });
    const config = loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false",
      TAPO_HISTORY_ENABLED: "true", TAPO_HISTORY_WORKER_TOKEN: WORKER_TOKEN,
      TAPO_HISTORY_EXPORT_EMAIL: "owner@gmail.com",
      TAPO_HISTORY_GMAIL_CLIENT_ID: "client-id",
      TAPO_HISTORY_GMAIL_CLIENT_SECRET: "client-secret",
      TAPO_HISTORY_GMAIL_REFRESH_TOKEN: "refresh-token",
    });
    const ready = vi.fn();
    const service = new TapoHistoryExportService(config, database, {
      fetcher, onHistoryReady: ready, deviceNameFor: () => "Cellar",
    });
    try {
      approveTarget(database, sensor.id);
      const from = "2026-01-15T09:00:00.000Z";
      const to = "2026-01-15T11:00:00.000Z";
      await service.recoverHistory(sensor.id, "temperature", from, to);
      const claim = service.claim("runner-1", DEPLOYMENT_FINGERPRINT)!;
      recipient = claim.job.expectedRecipient!;
      service.updateFromWorker(claim.job.id, claim.leaseToken, { status: "waiting-email" });
      service.start();
      await service.stop();

      expect(database.getTapoHistoryExportJob(claim.job.id)).toMatchObject({
        status: "completed", mailboxMessageId: "mail-1", stagedSampleCount: 18,
      });
      const recovered = await service.recoverHistory(sensor.id, "temperature", from, to);
      expect(recovered).toMatchObject({
        state: "complete", samples: expect.arrayContaining([
          expect.objectContaining({ metric: "temperature", value: 21.5 }),
        ]),
      });
      expect(recovered.samples).toHaveLength(9);
      service.consumeRecovered(sensor.id, "temperature", from, to);
      expect(database.getTapoHistoryExportJob(claim.job.id)?.consumedSampleCount).toBe(9);
      expect(ready).toHaveBeenCalledOnce();
    } finally {
      await service.stop();
      database.close();
    }
  });

  it("queues a fresh owner canary without making it reusable recovery data", async () => {
    const config = loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false",
      TAPO_HISTORY_ENABLED: "true", TAPO_HISTORY_WORKER_TOKEN: WORKER_TOKEN,
      TAPO_HISTORY_EXPORT_EMAIL: "owner@gmail.com",
      TAPO_HISTORY_GMAIL_CLIENT_ID: "client-id",
      TAPO_HISTORY_GMAIL_CLIENT_SECRET: "client-secret",
      TAPO_HISTORY_GMAIL_REFRESH_TOKEN: "refresh-token",
    });
    runtime = createApi({ config, startBackground: false, tapoHistoryDeviceNameFor: () => "Cellar" });
    const sensor = runtime.database.listSensors()[0]!;
    runtime.database.updateSensor(sensor.id, { tpLinkDeviceId: "t315-cellar", tpLinkConnectionId: "connection-1" });
    const to = new Date(Date.now() - 60_000);
    const from = new Date(to.getTime() - 2 * 60 * 60_000);
    const queued = await request(runtime.app).post("/api/v1/integrations/tp-link/history-export/canary")
      .send({ sensorId: sensor.id, metric: "temperature", from: from.toISOString(), to: to.toISOString() })
      .expect(202);
    expect(queued.body.job).toMatchObject({ status: "queued", canary: true, timeZone: "Europe/Helsinki" });
    const canary = runtime.database.getTapoHistoryExportJob(queued.body.job.id)!;
    expect(canary.dedupeKey).toMatch(/^canary:/u);

    await expect(runtime.tapoHistory.recoverHistory(
      sensor.id, "temperature", from.toISOString(), to.toISOString(),
    )).resolves.toMatchObject({ state: "partial" });
    const jobs = runtime.tapoHistory.listJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs.some((job) => job.dedupeKey.startsWith("automation:"))).toBe(true);

    await request(runtime.app).post("/api/v1/integrations/tp-link/history-export/canary")
      .send({
        sensorId: sensor.id,
        metric: "temperature",
        from: new Date(to.getTime() - 8 * 24 * 60 * 60_000).toISOString(),
        to: to.toISOString(),
      })
      .expect(422);
  });

  it("accepts an explicit bounded backfill request and rejects data outside Tapo's two-year window", async () => {
    const config = loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false",
      TAPO_HISTORY_ENABLED: "true", TAPO_HISTORY_WORKER_TOKEN: WORKER_TOKEN,
      TAPO_HISTORY_EXPORT_EMAIL: "owner@gmail.com",
      TAPO_HISTORY_GMAIL_CLIENT_ID: "client-id",
      TAPO_HISTORY_GMAIL_CLIENT_SECRET: "client-secret",
      TAPO_HISTORY_GMAIL_REFRESH_TOKEN: "refresh-token",
    });
    runtime = createApi({ config, startBackground: false, tapoHistoryDeviceNameFor: () => "Cellar" });
    const sensor = runtime.database.listSensors()[0]!;
    runtime.database.updateSensor(sensor.id, { tpLinkDeviceId: "t315-cellar", tpLinkConnectionId: "connection-1" });
    const now = Date.now();
    await request(runtime.app).post("/api/v1/integrations/tp-link/history-export/backfill")
      .send({
        sensorId: sensor.id,
        metric: "temperature",
        from: new Date(now - 3 * 60 * 60_000).toISOString(),
        to: new Date(now - 60 * 60_000).toISOString(),
      })
      .expect(202)
      .expect(({ body }) => expect(body.gap).toMatchObject({
        sensorId: sensor.id, metric: "temperature", source: "tp-link", recoveryState: "pending",
      }));
    await request(runtime.app).post("/api/v1/integrations/tp-link/history-export/backfill")
      .send({
        sensorId: sensor.id,
        metric: "temperature",
        from: new Date(now - 800 * 24 * 60 * 60_000).toISOString(),
        to: new Date(now - 799 * 24 * 60 * 60_000).toISOString(),
      })
      .expect(422);
  });

  it("blocks ordinary claims until the exact target is canaried and keeps manual recertification revoked after cancel", async () => {
    const database = new ClimateDatabase(":memory:");
    const sensor = database.listSensors()[0]!;
    database.updateSensor(sensor.id, { tpLinkDeviceId: "t315-cellar", tpLinkConnectionId: "connection-1" });
    let alias = "Cellar";
    const service = new TapoHistoryExportService(loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false",
      TAPO_HISTORY_ENABLED: "true", TAPO_HISTORY_WORKER_TOKEN: WORKER_TOKEN,
      TAPO_HISTORY_EXPORT_EMAIL: "owner@gmail.com",
      TAPO_HISTORY_GMAIL_CLIENT_ID: "client-id",
      TAPO_HISTORY_GMAIL_CLIENT_SECRET: "client-secret",
      TAPO_HISTORY_GMAIL_REFRESH_TOKEN: "refresh-token",
    }), database, { deviceNameFor: () => alias });
    try {
      const from = "2026-01-15T09:00:00.000Z";
      const to = "2026-01-15T11:00:00.000Z";
      await service.recoverHistory(sensor.id, "temperature", from, to);
      expect(service.claim("runner-before-canary", DEPLOYMENT_FINGERPRINT)).toBeNull();

      approveTarget(database, sensor.id);
      const approved = service.claim("runner-approved", DEPLOYMENT_FINGERPRINT)!;
      expect(approved.job.canary).toBe(false);
      const waiting = service.updateFromWorker(approved.job.id, approved.leaseToken, { status: "waiting-email" })!;
      database.revokeTapoHistoryCanaryApprovalsForJobTarget(approved.job.id);
      expect(() => database.completeTapoHistoryExportJobWithSamples(approved.job.id, [], {
        mailboxMessageId: "mail-after-relock",
        expectedRecipient: waiting.expectedRecipient!,
        expectedSubmittedAt: waiting.submittedAt!,
        sourceArtifactSha256: "e".repeat(64),
        sourceArtifactBytes: 1,
        parserVersion: "test-parser",
        sourceSchemaSignature: APPROVED_SCHEMA_SIGNATURE,
      })).toThrow(/approval was revoked/u);
      expect(database.listTapoHistoryExportStagedSamples({ jobId: approved.job.id })).toHaveLength(0);
      const canary = service.createCanary(
        sensor.id,
        "temperature",
        new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
        new Date(Date.now() - 10 * 60_000).toISOString(),
      );
      expect(database.getTapoHistoryExportJob(approved.job.id)).toMatchObject({
        status: "needs-attention",
        attentionReason: expect.stringMatching(/relocked/u),
      });
      service.cancel(canary.id);

      await service.recoverHistory(sensor.id, "temperature", "2026-01-16T09:00:00.000Z", "2026-01-16T11:00:00.000Z");
      expect(service.claim("runner-after-cancelled-recert", DEPLOYMENT_FINGERPRINT)).toBeNull();

      // An approval for the old alias cannot authorize a newly queued target.
      approveTarget(database, sensor.id);
      alias = "Renamed cellar";
      await service.recoverHistory(sensor.id, "temperature", "2026-01-17T09:00:00.000Z", "2026-01-17T11:00:00.000Z");
      expect(service.claim("runner-wrong-alias", DEPLOYMENT_FINGERPRINT)).toBeNull();
    } finally {
      await service.stop();
      database.close();
    }
  });

  it("keeps the physical target fenced when manual recertification interrupts a running export", async () => {
    const database = new ClimateDatabase(":memory:");
    const sensor = database.listSensors()[0]!;
    database.updateSensor(sensor.id, { tpLinkDeviceId: "t315-cellar", tpLinkConnectionId: "connection-1" });
    let now = new Date("2026-01-15T12:00:00.000Z");
    const service = new TapoHistoryExportService(loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false",
      TAPO_HISTORY_ENABLED: "true", TAPO_HISTORY_WORKER_TOKEN: WORKER_TOKEN,
      TAPO_HISTORY_EXPORT_EMAIL: "owner@gmail.com",
      TAPO_HISTORY_GMAIL_CLIENT_ID: "client-id",
      TAPO_HISTORY_GMAIL_CLIENT_SECRET: "client-secret",
      TAPO_HISTORY_GMAIL_REFRESH_TOKEN: "refresh-token",
      TAPO_HISTORY_WORKER_LEASE_MS: "300000",
    }), database, { now: () => now, deviceNameFor: () => "Cellar" });
    try {
      approveTarget(database, sensor.id, now);
      await service.recoverHistory(
        sensor.id, "temperature", "2026-01-15T09:00:00.000Z", "2026-01-15T11:00:00.000Z",
      );
      const workerId = "tapo-target-physical-fixture";
      const running = service.claim(workerId, DEPLOYMENT_FINGERPRINT)!;
      expect(service.updateFromWorker(running.job.id, running.leaseToken, { status: "running" }))
        .toMatchObject({ status: "running" });

      const canary = service.createCanary(
        sensor.id,
        "temperature",
        new Date(now.getTime() - 3 * 60 * 60_000).toISOString(),
        new Date(now.getTime() - 10 * 60_000).toISOString(),
      );
      expect(database.getTapoHistoryExportJob(running.job.id)).toMatchObject({
        status: "needs-attention",
        leaseOwner: workerId,
        leaseExpiresAt: running.job.leaseExpiresAt,
      });

      const reclaimAt = Date.parse(running.job.leaseExpiresAt!) + TAPO_TARGET_RECLAIM_GRACE_MS;
      now = new Date(reclaimAt - 1);
      expect(service.claim(workerId, DEPLOYMENT_FINGERPRINT)).toBeNull();
      now = new Date(reclaimAt);
      expect(service.claim(workerId, DEPLOYMENT_FINGERPRINT)).toMatchObject({
        job: { id: canary.id, canary: true, status: "claimed" },
      });
    } finally {
      await service.stop();
      database.close();
    }
  });

  it("automatically queues a renewal canary while retaining the still-fresh approval", async () => {
    const database = new ClimateDatabase(":memory:");
    const sensor = database.listSensors()[0]!;
    database.updateSensor(sensor.id, { tpLinkDeviceId: "t315-cellar", tpLinkConnectionId: "connection-1" });
    let now = new Date("2026-01-01T12:00:00.000Z");
    const service = new TapoHistoryExportService(loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false",
      TAPO_HISTORY_ENABLED: "true", TAPO_HISTORY_WORKER_TOKEN: WORKER_TOKEN,
      TAPO_HISTORY_EXPORT_EMAIL: "owner@gmail.com",
      TAPO_HISTORY_GMAIL_CLIENT_ID: "client-id",
      TAPO_HISTORY_GMAIL_CLIENT_SECRET: "client-secret",
      TAPO_HISTORY_GMAIL_REFRESH_TOKEN: "refresh-token",
    }), database, { now: () => now, deviceNameFor: () => "Cellar" });
    try {
      approveTarget(database, sensor.id, now);
      now = new Date("2026-01-25T12:00:00.000Z");
      await service.recoverHistory(
        sensor.id, "temperature", "2026-01-20T09:00:00.000Z", "2026-01-20T11:00:00.000Z",
      );
      const claim = service.claim("renewal-runner", DEPLOYMENT_FINGERPRINT)!;
      expect(claim.job.dedupeKey).toMatch(/^canary:renewal:/u);
      expect(database.hasRecentTapoHistoryCanaryApproval(
        DEPLOYMENT_FINGERPRINT,
        new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString(),
      )).toBe(true);
    } finally {
      await service.stop();
      database.close();
    }
  });

  it("splits long one-minute outages below the atomic staging ceiling", async () => {
    const database = new ClimateDatabase(":memory:");
    const sensor = database.listSensors()[0]!;
    database.updateSensor(sensor.id, { tpLinkDeviceId: "t315-cellar", tpLinkConnectionId: "connection-1" });
    const service = new TapoHistoryExportService(loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false",
      TAPO_HISTORY_ENABLED: "true", TAPO_HISTORY_WORKER_TOKEN: WORKER_TOKEN,
      TAPO_HISTORY_EXPORT_EMAIL: "owner@gmail.com",
      TAPO_HISTORY_GMAIL_CLIENT_ID: "client-id",
      TAPO_HISTORY_GMAIL_CLIENT_SECRET: "client-secret",
      TAPO_HISTORY_GMAIL_REFRESH_TOKEN: "refresh-token",
      TAPO_HISTORY_EXPORT_INTERVAL_MINUTES: "1",
    }), database, { deviceNameFor: () => "Cellar" });
    try {
      const from = "2026-01-01T00:00:00.000Z";
      const to = "2026-07-20T00:00:00.000Z";
      await service.recoverHistory(sensor.id, "temperature", from, to);
      const first = service.listJobs()[0]!;
      expect(Date.parse(first.to) - Date.parse(first.from)).toBe(maxTapoHistoryJobSpanMs(1));
      expect(Date.parse(first.to)).toBeLessThan(Date.parse(to));
    } finally {
      await service.stop();
      database.close();
    }
  });

  it("caps coarse-interval app jobs at the documented two-year export limit", () => {
    expect(maxTapoHistoryJobSpanMs(1)).toBeLessThan(30 * 24 * 60 * 60_000);
    expect(maxTapoHistoryJobSpanMs(60)).toBe(30 * 24 * 60 * 60_000);
    expect(maxTapoHistoryJobSpanMs(360)).toBe(30 * 24 * 60 * 60_000);
    expect(maxTapoHistoryJobSpanMs(1_440, 730)).toBe(730 * 24 * 60 * 60_000);
  });

  it("keeps private-adapter metric evidence separate and requires cadence coverage", async () => {
    const database = new ClimateDatabase(":memory:");
    const sensor = database.listSensors()[0]!;
    database.updateSensor(sensor.id, { tpLinkDeviceId: "t315-cellar", tpLinkConnectionId: "connection-1" });
    let call = 0;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      call += 1;
      const body = JSON.parse(String(init?.body)) as { deviceId: string; from: string; to: string };
      const metric = ["temperature", "humidity", "power"][call - 1]!;
      const value = metric === "temperature" ? 20 : metric === "humidity" ? 45 : 12;
      return Response.json({
        deviceId: body.deviceId,
        state: "complete",
        rangeStart: body.from,
        rangeEnd: body.to,
        samples: [0, 15, 30].map((minutes) => ({
          timestamp: new Date(Date.parse(body.from) + minutes * 60_000).toISOString(),
          [metric]: value + minutes / 100,
        })),
      });
    });
    const service = new TapoHistoryExportService(loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false",
      TAPO_HISTORY_ENABLED: "true",
      TAPO_HISTORY_PRIVATE_ENDPOINT: "https://history.example.test/v1/query",
      TAPO_HISTORY_PRIVATE_TOKEN: "private-token",
    }), database, { fetcher, privateResolver: async () => ["1.1.1.1"] });
    try {
      const from = "2026-01-15T09:00:00.000Z";
      const to = "2026-01-15T09:30:00.000Z";
      await expect(service.recoverHistory(sensor.id, "temperature", from, to)).resolves.toMatchObject({ state: "complete" });
      await expect(service.recoverHistory(sensor.id, "humidity", from, to)).resolves.toMatchObject({ state: "complete" });
      await expect(service.recoverHistory(sensor.id, "power", from, to)).resolves.toMatchObject({ state: "complete" });
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(service.listJobs().map((job) => job.metric).sort()).toEqual(["humidity", "power", "temperature"]);
    } finally {
      await service.stop();
      database.close();
    }
  });

  it("keeps a private-adapter outage retryable without requiring a process restart", async () => {
    const database = new ClimateDatabase(":memory:");
    const sensor = database.listSensors()[0]!;
    database.updateSensor(sensor.id, { tpLinkDeviceId: "t315-cellar", tpLinkConnectionId: "connection-1" });
    let attempt = 0;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      attempt += 1;
      if (attempt === 1) throw new Error("temporary endpoint outage");
      const body = JSON.parse(String(init?.body)) as { deviceId: string; from: string; to: string };
      return Response.json({
        deviceId: body.deviceId,
        state: "complete",
        rangeStart: body.from,
        rangeEnd: body.to,
        samples: [0, 15, 30].map((minutes) => ({
          timestamp: new Date(Date.parse(body.from) + minutes * 60_000).toISOString(),
          temperature: 20 + minutes / 100,
        })),
      });
    });
    const service = new TapoHistoryExportService(loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false",
      TAPO_HISTORY_ENABLED: "true",
      TAPO_HISTORY_PRIVATE_ENDPOINT: "https://history.example.test/v1/query",
      TAPO_HISTORY_PRIVATE_TOKEN: "private-token",
    }), database, { fetcher, privateResolver: async () => ["1.1.1.1"] });
    try {
      const from = "2026-01-15T09:00:00.000Z";
      const to = "2026-01-15T09:30:00.000Z";
      await expect(service.recoverHistory(sensor.id, "temperature", from, to)).resolves.toMatchObject({
        state: "partial", error: expect.stringMatching(/temporarily unavailable/u),
      });
      await expect(service.recoverHistory(sensor.id, "temperature", from, to)).resolves.toMatchObject({ state: "complete" });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      await service.stop();
      database.close();
    }
  });

  it("fences a queued job when its snapshotted device binding or unique alias changes", async () => {
    const database = new ClimateDatabase(":memory:");
    const sensor = database.listSensors()[0]!;
    database.updateSensor(sensor.id, { tpLinkDeviceId: "t315-cellar", tpLinkConnectionId: "connection-1" });
    let liveAlias = "Cellar";
    const service = new TapoHistoryExportService(loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false",
      TAPO_HISTORY_ENABLED: "true", TAPO_HISTORY_WORKER_TOKEN: WORKER_TOKEN,
      TAPO_HISTORY_EXPORT_EMAIL: "owner@gmail.com",
      TAPO_HISTORY_GMAIL_CLIENT_ID: "client-id",
      TAPO_HISTORY_GMAIL_CLIENT_SECRET: "client-secret",
      TAPO_HISTORY_GMAIL_REFRESH_TOKEN: "refresh-token",
    }), database, { deviceNameFor: () => liveAlias });
    try {
      approveTarget(database, sensor.id);
      const from = "2026-01-15T09:00:00.000Z";
      const to = "2026-01-15T11:00:00.000Z";
      await service.recoverHistory(sensor.id, "temperature", from, to);
      const original = service.listJobs()[0]!;
      database.updateSensor(sensor.id, { tpLinkDeviceId: "t315-replacement", tpLinkConnectionId: "connection-1" });
      liveAlias = "Renamed cellar";
      expect(service.claim("runner-1", DEPLOYMENT_FINGERPRINT)).toBeNull();
      expect(database.getTapoHistoryExportJob(original.id)).toMatchObject({
        status: "needs-attention",
        attentionReason: expect.stringMatching(/alias or immutable device binding changed/),
      });
      await service.recoverHistory(sensor.id, "temperature", from, to);
      expect(service.listJobs()).toEqual(expect.arrayContaining([
        expect.objectContaining({ deviceName: "Cellar", status: "needs-attention" }),
        expect.objectContaining({ deviceName: "Renamed cellar", status: "queued" }),
      ]));
    } finally {
      await service.stop();
      database.close();
    }
  });

  it("revokes target approval and queues recertification when the vendor CSV schema drifts", async () => {
    const database = new ClimateDatabase(":memory:");
    const sensor = database.listSensors()[0]!;
    database.updateSensor(sensor.id, { tpLinkDeviceId: "t315-cellar", tpLinkConnectionId: "connection-1" });
    const csv = `Time,Temperature(°F),Humidity(%)\n${[
      "11:00", "11:15", "11:30", "11:45", "12:00", "12:15", "12:30", "12:45", "13:00",
    ].map((time) => `2026-01-15 ${time}:00,70,44`).join("\n")}\n`;
    let recipient = "";
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "access", expires_in: 3600 });
      if (url.endsWith("/users/me/profile")) return Response.json({ emailAddress: "owner@gmail.com" });
      if (url.includes("/users/me/messages?")) return Response.json({ messages: [{ id: "schema-drift-mail" }] });
      if (url.includes("/users/me/messages/schema-drift-mail?")) return Response.json({
        id: "schema-drift-mail",
        internalDate: String(Date.now()),
        payload: {
          headers: [{ name: "Delivered-To", value: recipient }],
          parts: [{ filename: "data.csv", body: { data: Buffer.from(csv).toString("base64url"), size: csv.length } }],
        },
      });
      return new Response("not found", { status: 404 });
    });
    const service = new TapoHistoryExportService(loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false",
      TAPO_HISTORY_ENABLED: "true", TAPO_HISTORY_WORKER_TOKEN: WORKER_TOKEN,
      TAPO_HISTORY_EXPORT_EMAIL: "owner@gmail.com",
      TAPO_HISTORY_GMAIL_CLIENT_ID: "client-id",
      TAPO_HISTORY_GMAIL_CLIENT_SECRET: "client-secret",
      TAPO_HISTORY_GMAIL_REFRESH_TOKEN: "refresh-token",
    }), database, { fetcher, deviceNameFor: () => "Cellar" });
    try {
      approveTarget(database, sensor.id);
      await service.recoverHistory(
        sensor.id, "temperature", "2026-01-15T09:00:00.000Z", "2026-01-15T11:00:00.000Z",
      );
      const claim = service.claim("schema-drift-runner", DEPLOYMENT_FINGERPRINT)!;
      recipient = claim.job.expectedRecipient!;
      service.updateFromWorker(claim.job.id, claim.leaseToken, { status: "waiting-email" });

      service.start();
      await service.stop();

      expect(database.getTapoHistoryExportJob(claim.job.id)).toMatchObject({
        status: "needs-attention",
        attentionReason: expect.stringMatching(/schema changed/u),
        stagedSampleCount: 0,
      });
      expect(database.hasRecentTapoHistoryCanaryApproval(
        DEPLOYMENT_FINGERPRINT,
        new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
      )).toBe(false);
      expect(database.listTapoHistoryExportJobs({ statuses: ["queued"] })).toEqual(expect.arrayContaining([
        expect.objectContaining({ canary: true, dedupeKey: expect.stringMatching(/^canary:renewal:/u) }),
      ]));
    } finally {
      await service.stop();
      database.close();
    }
  });

  it("does not create an unattended app job without mailbox ingestion and retries timed-out email", async () => {
    const database = new ClimateDatabase(":memory:");
    const sensor = database.listSensors()[0]!;
    database.updateSensor(sensor.id, { tpLinkDeviceId: "t315-cellar", tpLinkConnectionId: "connection-1" });
    const base = {
      NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false",
      TAPO_HISTORY_ENABLED: "true", TAPO_HISTORY_WORKER_TOKEN: WORKER_TOKEN,
      TAPO_HISTORY_EXPORT_EMAIL: "owner@gmail.com", TAPO_HISTORY_EMAIL_TIMEOUT_MS: "60000",
    };
    expect(() => loadConfig(base)).toThrow(/complete app worker\/email\/Gmail tuple/u);

    let now = new Date("2026-01-15T12:00:00.000Z");
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "access", expires_in: 3600 });
      }
      if (url.endsWith("/users/me/profile")) return Response.json({ emailAddress: "owner@gmail.com" });
      return Response.json({ messages: [] });
    });
    const service = new TapoHistoryExportService(loadConfig({
      ...base,
      TAPO_HISTORY_GMAIL_CLIENT_ID: "client-id",
      TAPO_HISTORY_GMAIL_CLIENT_SECRET: "client-secret",
      TAPO_HISTORY_GMAIL_REFRESH_TOKEN: "refresh-token",
    }), database, { fetcher, now: () => now, deviceNameFor: () => "Cellar" });
    try {
      approveTarget(database, sensor.id, now);
      await service.recoverHistory(
        sensor.id, "temperature", "2026-01-15T09:00:00Z", "2026-01-15T11:00:00Z",
      );
      const first = service.claim("runner-1", DEPLOYMENT_FINGERPRINT)!;
      const firstRecipient = first.job.expectedRecipient;
      service.updateFromWorker(first.job.id, first.leaseToken, { status: "waiting-email" });
      expect(database.getTapoHistoryExportJob(first.job.id)?.submittedAt).toBe("2026-01-15T12:00:00.000Z");
      now = new Date("2026-01-15T12:02:00.000Z");
      service.start();
      await service.stop();
      expect(database.getTapoHistoryExportJob(first.job.id)).toMatchObject({
        status: "failed", lastError: expect.stringMatching(/correlated Tapo export email/), attemptCount: 1,
      });
      expect(service.claim("runner-2", DEPLOYMENT_FINGERPRINT)).toBeNull();
      now = new Date("2026-01-15T12:03:00.000Z");
      const second = service.claim("runner-2", DEPLOYMENT_FINGERPRINT)!;
      expect(second).toMatchObject({ job: { id: first.job.id, status: "claimed", attemptCount: 2 } });
      expect(second.job.expectedRecipient).not.toBe(firstRecipient);
      expect(second.job.submittedAt).toBeNull();
    } finally {
      await service.stop();
      database.close();
    }
  });

  it("does not burn a mobile attempt while Gmail OAuth is unavailable past the email deadline", async () => {
    const database = new ClimateDatabase(":memory:");
    const sensor = database.listSensors()[0]!;
    database.updateSensor(sensor.id, { tpLinkDeviceId: "t315-cellar", tpLinkConnectionId: "connection-1" });
    let now = new Date("2026-01-15T12:00:00.000Z");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("unavailable", { status: 503 }));
    const service = new TapoHistoryExportService(loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false",
      TAPO_HISTORY_ENABLED: "true", TAPO_HISTORY_WORKER_TOKEN: WORKER_TOKEN,
      TAPO_HISTORY_EXPORT_EMAIL: "owner@gmail.com", TAPO_HISTORY_EMAIL_TIMEOUT_MS: "60000",
      TAPO_HISTORY_GMAIL_CLIENT_ID: "client-id",
      TAPO_HISTORY_GMAIL_CLIENT_SECRET: "client-secret",
      TAPO_HISTORY_GMAIL_REFRESH_TOKEN: "refresh-token",
      TAPO_HISTORY_MAX_PENDING_EMAILS: "10",
    }), database, { fetcher, now: () => now, deviceNameFor: () => "Cellar" });
    try {
      approveTarget(database, sensor.id, now);
      const jobIds: string[] = [];
      for (const [from, to] of [
        ["2026-01-15T09:00:00Z", "2026-01-15T11:00:00Z"],
        ["2026-01-16T09:00:00Z", "2026-01-16T11:00:00Z"],
      ]) {
        await service.recoverHistory(sensor.id, "temperature", from, to);
        const claim = service.claim("runner-1", DEPLOYMENT_FINGERPRINT)!;
        service.updateFromWorker(claim.job.id, claim.leaseToken, { status: "waiting-email" });
        jobIds.push(claim.job.id);
      }
      now = new Date("2026-01-15T12:02:00.000Z");

      service.start();
      await service.stop();

      for (const jobId of jobIds) {
        expect(database.getTapoHistoryExportJob(jobId)).toMatchObject({
          status: "waiting-email", attemptCount: 1, submittedAt: "2026-01-15T12:00:00.000Z",
        });
      }
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      await service.stop();
      database.close();
    }
  });

  it("shares one bounded Gmail request budget across every waiting job in a poll", async () => {
    const database = new ClimateDatabase(":memory:");
    const sensor = database.listSensors()[0]!;
    database.updateSensor(sensor.id, { tpLinkDeviceId: "t315-cellar", tpLinkConnectionId: "connection-1" });
    const recipients = new Map<string, string>();
    let page = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "access", expires_in: 3600 });
      }
      if (url.endsWith("/users/me/profile")) return Response.json({ emailAddress: "owner@gmail.com" });
      if (url.includes("/users/me/messages?")) {
        page += 1;
        const recipient = /to:([^ ]+)/u.exec(new URL(url).searchParams.get("q") ?? "")?.[1] ?? "missing@example.test";
        const messages = Array.from({ length: 25 }, (_, index) => ({ id: `page-${page}-message-${index}` }));
        for (const message of messages) recipients.set(message.id, recipient);
        return Response.json({ messages });
      }
      const id = /\/messages\/([^?]+)\?/u.exec(url)?.[1] ?? "missing";
      return Response.json({
        id,
        internalDate: String(Date.now()),
        payload: {
          headers: [{ name: "Delivered-To", value: recipients.get(id) ?? "missing@example.test" }],
          parts: [{ filename: "poison.csv", body: { data: "", size: 9 * 1024 * 1024 } }],
        },
      });
    });
    const service = new TapoHistoryExportService(loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false",
      TAPO_HISTORY_ENABLED: "true", TAPO_HISTORY_WORKER_TOKEN: WORKER_TOKEN,
      TAPO_HISTORY_EXPORT_EMAIL: "owner@gmail.com",
      TAPO_HISTORY_GMAIL_CLIENT_ID: "client-id",
      TAPO_HISTORY_GMAIL_CLIENT_SECRET: "client-secret",
      TAPO_HISTORY_GMAIL_REFRESH_TOKEN: "refresh-token",
      TAPO_HISTORY_MAX_PENDING_EMAILS: "10",
    }), database, { fetcher, deviceNameFor: () => "Cellar" });
    try {
      approveTarget(database, sensor.id);
      for (const [from, to] of [
        ["2026-01-15T09:00:00.000Z", "2026-01-15T11:00:00.000Z"],
        ["2026-01-16T09:00:00.000Z", "2026-01-16T11:00:00.000Z"],
      ]) {
        await service.recoverHistory(sensor.id, "temperature", from, to);
        const claim = service.claim("runner-1", DEPLOYMENT_FINGERPRINT)!;
        service.updateFromWorker(claim.job.id, claim.leaseToken, { status: "waiting-email" });
      }

      service.start();
      await service.stop();

      // OAuth is outside the mailbox scan tracker; the poll itself performs at
      // most forty Gmail API requests across both jobs.
      expect(fetcher).toHaveBeenCalledTimes(40);
      expect(service.listJobs().filter((job) => !job.canary).map((job) => job.status).sort())
        .toEqual(["needs-attention", "waiting-email"]);
    } finally {
      await service.stop();
      database.close();
    }
  });

  it("keeps a cancelled physical-target lease fenced through the Appium command grace period", async () => {
    const database = new ClimateDatabase(":memory:");
    const sensor = database.listSensors()[0]!;
    database.updateSensor(sensor.id, { tpLinkDeviceId: "t315-cellar", tpLinkConnectionId: "connection-1" });
    let now = new Date("2026-01-15T12:00:00.000Z");
    const service = new TapoHistoryExportService(loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false",
      TAPO_HISTORY_ENABLED: "true", TAPO_HISTORY_WORKER_TOKEN: WORKER_TOKEN,
      TAPO_HISTORY_EXPORT_EMAIL: "owner@gmail.com",
      TAPO_HISTORY_GMAIL_CLIENT_ID: "client-id",
      TAPO_HISTORY_GMAIL_CLIENT_SECRET: "client-secret",
      TAPO_HISTORY_GMAIL_REFRESH_TOKEN: "refresh-token",
      TAPO_HISTORY_WORKER_LEASE_MS: "300000",
    }), database, { now: () => now, deviceNameFor: () => "Cellar" });
    try {
      approveTarget(database, sensor.id, now);
      await service.recoverHistory(
        sensor.id, "temperature", "2026-01-15T09:00:00Z", "2026-01-15T11:00:00Z",
      );
      const first = service.claim("stable-physical-target", DEPLOYMENT_FINGERPRINT)!;
      expect(first.job.leaseExpiresAt).toBe("2026-01-15T12:05:00.000Z");
      expect(service.cancel(first.job.id)).toMatchObject({ status: "cancelled" });
      expect(service.retry(first.job.id)).toMatchObject({
        status: "queued", availableAt: "2026-01-15T12:07:05.000Z",
      });

      now = new Date("2026-01-15T12:07:04.999Z");
      expect(service.claim("stable-physical-target", DEPLOYMENT_FINGERPRINT)).toBeNull();
      now = new Date("2026-01-15T12:07:05.000Z");
      expect(service.claim("stable-physical-target", DEPLOYMENT_FINGERPRINT)).toMatchObject({
        job: { id: first.job.id, status: "claimed", attemptCount: 1 },
      });
    } finally {
      await service.stop();
      database.close();
    }
  });
});
