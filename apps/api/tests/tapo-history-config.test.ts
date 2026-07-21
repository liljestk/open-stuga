import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const BASE_ENV = { NODE_ENV: "test", DATABASE_PATH: ":memory:" } as const;

describe("Tapo history automation configuration", () => {
  it("loads worker and OAuth credentials from files without requiring inline secrets", () => {
    const directory = mkdtempSync(join(tmpdir(), "stuga-tapo-history-config-"));
    const workerToken = join(directory, "worker-token");
    const clientSecret = join(directory, "client-secret");
    const refreshToken = join(directory, "refresh-token");
    try {
      writeFileSync(workerToken, `${"w".repeat(48)}\n`);
      writeFileSync(clientSecret, "oauth-client-secret\n");
      writeFileSync(refreshToken, "oauth-refresh-token\n");
      expect(loadConfig({
        ...BASE_ENV,
        TAPO_HISTORY_ENABLED: "true",
        TAPO_HISTORY_WORKER_TOKEN_FILE: workerToken,
        TAPO_HISTORY_EXPORT_EMAIL: "Owner+Exports@Gmail.com",
        TAPO_HISTORY_GMAIL_CLIENT_ID: "oauth-client-id",
        TAPO_HISTORY_GMAIL_CLIENT_SECRET_FILE: clientSecret,
        TAPO_HISTORY_GMAIL_REFRESH_TOKEN_FILE: refreshToken,
        TAPO_HISTORY_EXPORT_INTERVAL_MINUTES: "30",
      })).toMatchObject({
        tapoHistoryEnabled: true,
        tapoHistoryWorkerToken: "w".repeat(48),
        tapoHistoryExportEmail: "owner+exports@gmail.com",
        tapoHistoryGmailAccountEmail: "owner@gmail.com",
        tapoHistoryGmailClientSecret: "oauth-client-secret",
        tapoHistoryGmailRefreshToken: "oauth-refresh-token",
        tapoHistoryExportIntervalMinutes: 30,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects incomplete, weak, conflicting, and insecure configuration", () => {
    expect(() => loadConfig({
      ...BASE_ENV, TAPO_HISTORY_WORKER_TOKEN: "too-short",
    })).toThrow(/at least 32/);
    expect(() => loadConfig({
      ...BASE_ENV, TAPO_HISTORY_GMAIL_CLIENT_ID: "client-only",
    })).toThrow(/client id, client secret, and refresh token/);
    expect(() => loadConfig({
      ...BASE_ENV,
      TAPO_HISTORY_GMAIL_CLIENT_ID: "client",
      TAPO_HISTORY_GMAIL_CLIENT_SECRET: "secret",
      TAPO_HISTORY_GMAIL_REFRESH_TOKEN: "refresh",
    })).toThrow(/requires TAPO_HISTORY_EXPORT_EMAIL/);
    expect(() => loadConfig({
      ...BASE_ENV, TAPO_HISTORY_PRIVATE_ENDPOINT: "http://history.example.com", TAPO_HISTORY_PRIVATE_TOKEN: "secret",
    })).toThrow(/must use HTTPS/);
    expect(() => loadConfig({
      ...BASE_ENV, TAPO_HISTORY_EXPORT_INTERVAL_MINUTES: "5",
    })).toThrow(/1, 15, 30, 60, 360, 720, or 1440/);
    expect(() => loadConfig({ ...BASE_ENV, TAPO_HISTORY_MAX_EXPORT_DAYS: "0" }))
      .toThrow(/TAPO_HISTORY_MAX_EXPORT_DAYS/);
    expect(() => loadConfig({ ...BASE_ENV, TAPO_HISTORY_MAX_EXPORT_DAYS: "731" }))
      .toThrow(/TAPO_HISTORY_MAX_EXPORT_DAYS/);
    expect(() => loadConfig({ ...BASE_ENV, TAPO_HISTORY_MAX_PENDING_EMAILS: "0" }))
      .toThrow(/TAPO_HISTORY_MAX_PENDING_EMAILS/);
    expect(() => loadConfig({ ...BASE_ENV, TAPO_HISTORY_MAX_PENDING_EMAILS: "11" }))
      .toThrow(/TAPO_HISTORY_MAX_PENDING_EMAILS/);
    expect(() => loadConfig({ ...BASE_ENV, TAPO_HISTORY_GMAIL_ACCOUNT_EMAIL: "not-an-email" }))
      .toThrow(/TAPO_HISTORY_GMAIL_ACCOUNT_EMAIL/);
    expect(() => loadConfig({
      ...BASE_ENV, TAPO_HISTORY_ENABLED: "true", TAPO_HISTORY_EXPORT_EMAIL: "owner@example.com",
    })).toThrow(/complete app worker\/email\/Gmail tuple/u);
    expect(() => loadConfig({
      ...BASE_ENV,
      TAPO_HISTORY_EXPORT_EMAIL: `${"x".repeat(40)}@example.com`,
      TAPO_HISTORY_EMAIL_TAG_PREFIX: "twenty-character-tag",
    })).toThrow(/too long for the per-attempt correlation tag/u);
  });

  it("loads bounded export pacing and an explicit Gmail mailbox identity", () => {
    expect(loadConfig({
      ...BASE_ENV,
      TAPO_HISTORY_MAX_EXPORT_DAYS: "14",
      TAPO_HISTORY_MAX_PENDING_EMAILS: "3",
      TAPO_HISTORY_GMAIL_ACCOUNT_EMAIL: "mailbox@example.com",
    })).toMatchObject({
      tapoHistoryMaxExportDays: 14,
      tapoHistoryMaxPendingEmails: 3,
      tapoHistoryGmailAccountEmail: "mailbox@example.com",
    });
  });

  it("treats absent optional Compose secret files as disabled but fails paired configuration", () => {
    const missing = join(tmpdir(), `stuga-missing-tapo-${process.pid}-${Date.now()}`);
    expect(loadConfig({
      ...BASE_ENV,
      TAPO_HISTORY_WORKER_TOKEN_FILE: join(missing, "worker-token"),
      TAPO_HISTORY_GMAIL_CLIENT_SECRET_FILE: join(missing, "gmail-client-secret"),
      TAPO_HISTORY_GMAIL_REFRESH_TOKEN_FILE: join(missing, "gmail-refresh-token"),
      TAPO_HISTORY_PRIVATE_TOKEN_FILE: join(missing, "private-token"),
    })).toMatchObject({
      tapoHistoryWorkerToken: null,
      tapoHistoryGmailClientSecret: null,
      tapoHistoryGmailRefreshToken: null,
      tapoHistoryPrivateToken: null,
    });
    expect(() => loadConfig({
      ...BASE_ENV,
      TAPO_HISTORY_GMAIL_CLIENT_ID: "client-id",
      TAPO_HISTORY_GMAIL_CLIENT_SECRET_FILE: join(missing, "gmail-client-secret"),
      TAPO_HISTORY_GMAIL_REFRESH_TOKEN_FILE: join(missing, "gmail-refresh-token"),
    })).toThrow(/client id, client secret, and refresh token/);
  });
});
