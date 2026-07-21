import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { readIntegrationSecrets, writeIntegrationSecrets } from "../src/integration-secrets.js";

describe("durable non-secret integration metadata", () => {
  let directory: string | null = null;
  let runtime: ApiRuntime | null = null;
  const successfulDraftTest = async () => ({ ok: true, connected: true, message: "validated" });

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  function paths(prefix: string): { databasePath: string; secretsPath: string } {
    directory = mkdtempSync(join(tmpdir(), prefix));
    return {
      databasePath: join(directory, "climate.sqlite"),
      secretsPath: join(directory, "private", "integration-secrets.json"),
    };
  }

  function boot(databasePath: string, secretsPath: string, extra: NodeJS.ProcessEnv = {}): ApiRuntime {
    runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: databasePath,
        INTEGRATION_SECRETS_FILE: secretsPath,
        MOCK_ENABLED: "false",
        ...extra,
      }),
      startBackground: false,
      homeAssistantCredentialTester: successfulDraftTest,
      tpLinkCredentialTester: successfulDraftTest,
    });
    return runtime;
  }

  async function restart(databasePath: string, secretsPath: string, extra: NodeJS.ProcessEnv = {}): Promise<ApiRuntime> {
    await runtime?.close();
    runtime = null;
    return boot(databasePath, secretsPath, extra);
  }

  it("migrates existing protected metadata, sanitizes endpoints, and retains retirement history", async () => {
    const { databasePath, secretsPath } = paths("stuga-integration-metadata-");
    const notesHash = `sha256:${createHash("sha256").update("notes-secret").digest("hex")}`;
    writeIntegrationSecrets(secretsPath, {
      version: 1,
      homeAssistantConnections: [{
        houseId: "house-main",
        url: "http://homeassistant.local:8123/proxy/?capability=must-not-enter-sqlite#private",
        token: "ha-secret",
      }],
      tpLinkConnections: [{
        id: "tp-main", houseId: "house-main", host: "192.168.1.42",
        username: "owner@example.test", password: "tp-secret",
      }],
      webhook: { url: "https://hooks.example.test/alert?key=webhook-secret", bearerToken: "webhook-bearer" },
      telegram: { botToken: "123456:telegram-secret", chatId: "9007199254740993" },
      appleNotesGrants: [{
        id: "notes-main", tokenHash: notesHash, deviceLabel: "Owner iPhone",
        houseId: "house-main", createdAt: "2026-07-18T10:00:00.000Z",
      }],
    });
    const first = boot(databasePath, secretsPath);

    expect(first.integrationMetadata.list({ activeOnly: true })).toHaveLength(5);
    expect(first.integrationMetadata.get("home-assistant", "house:house-main")).toMatchObject({
      endpoint: "http://homeassistant.local:8123/proxy",
      houseId: "house-main",
      active: true,
      secretSource: "protected-file",
    });
    expect(first.integrationMetadata.get("tp-link", "tp-main")).toMatchObject({
      endpoint: "192.168.1.42", houseId: "house-main", active: true,
    });
    expect(first.integrationMetadata.get("webhook", "singleton")).toMatchObject({
      endpoint: null, label: null, active: true,
    });
    const serializedMetadata = JSON.stringify(first.integrationMetadata.list());
    for (const secret of ["capability", "ha-secret", "owner@example.test", "tp-secret", "webhook-secret", "webhook-bearer", "9007199254740993", notesHash]) {
      expect(serializedMetadata).not.toContain(secret);
    }

    const reopened = await restart(databasePath, secretsPath);
    expect(reopened.integrationMetadata.list({ activeOnly: true })).toHaveLength(5);
    writeIntegrationSecrets(secretsPath, { version: 1 });
    const retired = await restart(databasePath, secretsPath);
    expect(retired.integrationMetadata.list({ activeOnly: true })).toEqual([]);
    expect(retired.integrationMetadata.list()).toHaveLength(5);
    expect(retired.integrationMetadata.list().every((record) => record.retiredAt !== null)).toBe(true);
    expect((retired.database.db.prepare(
      "SELECT COUNT(*) AS count FROM integration_metadata_revisions WHERE event = 'retired' AND reason = 'credential-absent'",
    ).get() as { count: number }).count).toBe(5);
  });

  it("does not prune after a missing protected file but retires stale metadata after a validated empty snapshot", async () => {
    const { databasePath, secretsPath } = paths("stuga-integration-metadata-missing-");
    writeIntegrationSecrets(secretsPath, {
      version: 1,
      homeAssistantConnections: [{ houseId: "house-main", url: "http://ha.local:8123", token: "ha-secret" }],
    });
    boot(databasePath, secretsPath);
    await runtime!.close();
    runtime = null;
    rmSync(secretsPath);

    const withoutSecrets = boot(databasePath, secretsPath);
    expect(withoutSecrets.status.value.homeAssistant.configured).toBe(false);
    expect(withoutSecrets.integrationMetadata.get("home-assistant", "house:house-main")).toMatchObject({ active: true });
    writeIntegrationSecrets(secretsPath, { version: 1 });
    const withValidatedAbsence = await restart(databasePath, secretsPath);
    expect(withValidatedAbsence.integrationMetadata.get("home-assistant", "house:house-main")).toMatchObject({
      active: false,
      retiredAt: expect.any(String),
    });
  });

  it("repairs secret-first configure and disconnect faults during restart reconciliation", async () => {
    const { databasePath, secretsPath } = paths("stuga-integration-metadata-fault-");
    const first = boot(databasePath, secretsPath);
    first.database.db.exec(`CREATE TRIGGER reject_integration_metadata_insert
      BEFORE INSERT ON integration_metadata WHEN NEW.kind = 'home-assistant'
      BEGIN SELECT RAISE(ABORT, 'forced integration metadata insert failure'); END`);
    await request(first.app).put("/api/v1/integrations/home-assistant/config")
      .send({ houseId: "house-main", url: "http://ha.local:8123", token: "ha-secret" }).expect(500);
    expect(readIntegrationSecrets(secretsPath).homeAssistantConnections).toHaveLength(1);
    expect(first.integrationMetadata.get("home-assistant", "house:house-main")).toBeNull();
    first.database.db.exec("DROP TRIGGER reject_integration_metadata_insert");

    const recovered = await restart(databasePath, secretsPath);
    expect(recovered.integrationMetadata.get("home-assistant", "house:house-main")).toMatchObject({ active: true });
    recovered.database.db.exec(`CREATE TRIGGER reject_integration_metadata_retire
      BEFORE UPDATE OF retired_at ON integration_metadata
      WHEN OLD.kind = 'home-assistant' AND NEW.retired_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'forced integration metadata retire failure'); END`);
    await request(recovered.app).delete("/api/v1/integrations/home-assistant/config/house-main").expect(500);
    expect(readIntegrationSecrets(secretsPath).homeAssistantConnections).toEqual([]);
    expect(recovered.integrationMetadata.get("home-assistant", "house:house-main")).toMatchObject({ active: true });
    recovered.database.db.exec("DROP TRIGGER reject_integration_metadata_retire");

    const reconciled = await restart(databasePath, secretsPath);
    expect(reconciled.integrationMetadata.get("home-assistant", "house:house-main")).toMatchObject({
      active: false,
      retiredAt: expect.any(String),
    });
  });

  it("mirrors environment webhook credentials for protected backup and restores them with no SQLite secret copy", async () => {
    const { databasePath, secretsPath } = paths("stuga-webhook-backup-");
    const webhookUrl = "https://hooks.example.test/notify?capability=restore-secret";
    const webhookBearer = "webhook-bearer-secret";
    const fromEnvironment = boot(databasePath, secretsPath, {
      ALERT_WEBHOOK_URL: webhookUrl,
      ALERT_WEBHOOK_BEARER_TOKEN: webhookBearer,
    });
    expect(fromEnvironment.status.value.webhook.configured).toBe(true);
    expect(readIntegrationSecrets(secretsPath)).toMatchObject({
      version: 1,
      metadataSnapshotIncomplete: true,
      webhookDestinations: [{ id: "primary", url: webhookUrl, bearerToken: webhookBearer }],
    });
    expect(fromEnvironment.integrationMetadata.get("webhook", "singleton")).toMatchObject({
      active: true,
      secretSource: "environment",
      endpoint: null,
    });
    expect(JSON.stringify(fromEnvironment.integrationMetadata.list())).not.toContain("restore-secret");
    expect(JSON.stringify(fromEnvironment.integrationMetadata.list())).not.toContain(webhookBearer);

    const restored = await restart(databasePath, secretsPath);
    expect(restored.status.value.webhook.configured).toBe(true);
    expect(restored.integrationMetadata.get("webhook", "singleton")).toMatchObject({
      active: true,
      secretSource: "protected-file",
      endpoint: null,
    });
  });

  it("reconciles every environment webhook destination without persisting secret material in SQLite", async () => {
    const { databasePath, secretsPath } = paths("stuga-webhook-destinations-");
    const destinations = [
      {
        id: "operations",
        url: "https://ops.example.test/notify?capability=ops-secret",
        bearerToken: "ops-bearer-secret",
      },
      {
        id: "archive",
        url: "https://archive.example.test/events?capability=archive-secret",
        signingSecret: "archive-signing-secret".padEnd(32, "x"),
      },
    ];
    const fromEnvironment = boot(databasePath, secretsPath, {
      ALERT_WEBHOOK_DESTINATIONS_JSON: JSON.stringify(destinations),
    });

    expect(fromEnvironment.status.value.webhook.destinations?.map((destination) => destination.id))
      .toEqual(["operations", "archive"]);
    expect(readIntegrationSecrets(secretsPath).webhookDestinations).toEqual(destinations);
    expect(fromEnvironment.integrationMetadata.get("webhook", "destination:operations")).toMatchObject({
      active: true,
      secretSource: "environment",
      endpoint: null,
    });
    expect(fromEnvironment.integrationMetadata.get("webhook", "destination:archive")).toMatchObject({
      active: true,
      secretSource: "environment",
      endpoint: null,
    });
    const sqliteMetadata = JSON.stringify(fromEnvironment.integrationMetadata.list());
    for (const secret of ["ops-secret", "ops-bearer-secret", "archive-secret", destinations[1]!.signingSecret]) {
      expect(sqliteMetadata).not.toContain(secret);
    }

    const restored = await restart(databasePath, secretsPath);
    expect(restored.integrationMetadata.get("webhook", "destination:operations")).toMatchObject({
      active: true,
      secretSource: "protected-file",
    });
    expect(restored.integrationMetadata.get("webhook", "destination:archive")).toMatchObject({
      active: true,
      secretSource: "protected-file",
    });
  });
});
