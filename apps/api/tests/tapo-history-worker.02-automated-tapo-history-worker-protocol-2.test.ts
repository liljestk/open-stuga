import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiRuntime } from "../src/app.js";

import { loadConfig } from "../src/config.js";

import { ClimateDatabase } from "../src/db.js";

import {
  TapoHistoryExportService,
} from "../src/tapo-history-export.js";

import { DEPLOYMENT_FINGERPRINT, WORKER_TOKEN, approveTarget } from "./tapo-history-workerTestSupport.js";

describe("automated Tapo history worker protocol", () => {
  let runtime: ApiRuntime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
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
