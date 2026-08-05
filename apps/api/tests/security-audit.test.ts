import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { SECURITY_AUDIT_SUBJECT_TYPES } from "@climate-twin/contracts";
import { createApi, type ApiRuntime } from "../src/app.js";
import { ClimateDatabase } from "../src/db.js";
import { loadConfig } from "../src/config.js";

const OWNER = { email: "owner@example.test", password: "correct horse battery staple" };

describe("security audit trail and credential lifecycle drills", () => {
  let directory: string | null = null;
  let runtime: ApiRuntime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  it("accepts every audited subject type the contract declares", () => {
    const database = new ClimateDatabase(":memory:", true);
    try {
      for (const subjectType of SECURITY_AUDIT_SUBJECT_TYPES) {
        const event = database.recordSecurityAuditEvent({
          eventType: "system.update.requested",
          actorUserId: null,
          actorRole: "owner",
          subjectType,
          subjectId: `subject-${subjectType}`,
        });
        expect(event.subjectType).toBe(subjectType);
      }
      expect(database.listSecurityAuditEvents(100)).toHaveLength(SECURITY_AUDIT_SUBJECT_TYPES.length);
    } finally {
      database.close();
    }
  });

  it("widens the subject constraint of a database created before system auditing existed", () => {
    directory = mkdtempSync(join(tmpdir(), "stugu-audit-migration-"));
    const databasePath = join(directory, "legacy.sqlite");
    const legacy = new ClimateDatabase(databasePath, true);
    legacy.recordSecurityAuditEvent({
      eventType: "auth.login",
      actorUserId: null,
      actorRole: "owner",
      subjectType: "account",
      subjectId: "owner@example.test",
    });
    legacy.close();

    // Restore the original four-value CHECK to reproduce an appliance upgraded in place.
    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      DROP TABLE IF EXISTS security_audit_events_legacy;
      CREATE TABLE security_audit_events_legacy (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('succeeded', 'denied')),
        actor_user_id TEXT,
        actor_role TEXT CHECK(actor_role IS NULL OR actor_role IN ('owner', 'admin', 'member', 'guest', 'service')),
        subject_type TEXT NOT NULL CHECK(subject_type IN ('account', 'workspace-member', 'integration', 'integration-grant')),
        subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 512),
        details_json TEXT NOT NULL CHECK(json_valid(details_json) AND json_type(details_json) = 'object'),
        created_at TEXT NOT NULL
      );
      INSERT INTO security_audit_events_legacy SELECT * FROM security_audit_events;
      DROP TABLE security_audit_events;
      ALTER TABLE security_audit_events_legacy RENAME TO security_audit_events;
    `);
    raw.close();

    const migrated = new ClimateDatabase(databasePath, false);
    try {
      expect(migrated.listSecurityAuditEvents(100)).toHaveLength(1);
      const event = migrated.recordSecurityAuditEvent({
        eventType: "system.update.requested",
        actorUserId: null,
        actorRole: "owner",
        subjectType: "system-update",
        subjectId: "host-generation-15",
      });
      expect(event.subjectType).toBe("system-update");
      expect(migrated.listSecurityAuditEvents(100)).toHaveLength(2);
    } finally {
      migrated.close();
    }
  });

  it("rolls back the audit-table rebuild when a later migration statement fails", () => {
    const database = new ClimateDatabase(":memory:", true);
    try {
      database.recordSecurityAuditEvent({
        eventType: "auth.login",
        actorUserId: null,
        actorRole: "owner",
        subjectType: "account",
        subjectId: "owner@example.test",
      });
      database.db.exec(`
        DROP INDEX idx_security_audit_events_created;
        DROP INDEX idx_security_audit_events_type_created;
        ALTER TABLE security_audit_events RENAME TO security_audit_events_current;
        CREATE TABLE security_audit_events (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('succeeded', 'denied')),
          actor_user_id TEXT,
          actor_role TEXT CHECK(actor_role IS NULL OR actor_role IN ('owner', 'admin', 'member', 'guest', 'service')),
          subject_type TEXT NOT NULL CHECK(subject_type IN ('account', 'workspace-member', 'integration', 'integration-grant')),
          subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 512),
          details_json TEXT NOT NULL CHECK(json_valid(details_json) AND json_type(details_json) = 'object'),
          created_at TEXT NOT NULL
        );
        INSERT INTO security_audit_events SELECT * FROM security_audit_events_current;
        DROP TABLE security_audit_events_current;
        CREATE TABLE idx_security_audit_events_created(blocker INTEGER);
      `);

      expect(() => database.migrateSecurityAuditSubjectTypes()).toThrow();
      const schema = database.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'security_audit_events'",
      ).get() as { sql: string };
      expect(schema.sql).toContain("'integration-grant'");
      expect(schema.sql).not.toContain("'system-update'");
      expect(database.listSecurityAuditEvents(100)).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("records authentication and membership outcomes without exposing secrets", async () => {
    runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        MOCK_ENABLED: "false",
        LOCAL_AUTH_TEST_BYPASS: "false",
      }),
      startBackground: false,
    });
    const owner = request.agent(runtime.app);
    const setup = await owner.post("/api/v1/auth/setup").send(OWNER).expect(201);
    const csrf = setup.body.csrfToken as string;

    const rejectedPassword = "definitely the wrong password";
    await request(runtime.app).post("/api/v1/auth/login")
      .send({ email: OWNER.email, password: rejectedPassword }).expect(401);

    const invitation = await owner.post("/api/v1/tenant/members")
      .set("x-csrf-token", csrf)
      .send({ email: "member@example.test", role: "member", grants: [] })
      .expect(201);
    const registrationToken = invitation.body.registrationToken as string;
    const member = request.agent(runtime.app);
    await member.post("/api/v1/auth/register")
      .send({ token: registrationToken, password: "member password long enough" })
      .expect(201);
    await member.get("/api/v1/security/audit-events").expect(403);

    await owner.delete("/api/v1/tenant/members/member%40example.test")
      .set("x-csrf-token", csrf)
      .expect(204);

    const audit = await owner.get("/api/v1/security/audit-events?limit=100&offset=0").expect(200);
    expect(audit.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "auth.owner.created",
        outcome: "succeeded",
        actorRole: "owner",
        subjectType: "account",
        subjectId: OWNER.email,
      }),
      expect.objectContaining({
        eventType: "auth.login",
        outcome: "denied",
        actorUserId: null,
        subjectId: OWNER.email,
        details: { reason: "INVALID_CREDENTIALS" },
      }),
      expect.objectContaining({
        eventType: "membership.invitation.created",
        subjectId: "member@example.test",
        details: { role: "member", grantCount: 0 },
      }),
      expect.objectContaining({
        eventType: "auth.invitation.accepted",
        subjectId: "member@example.test",
      }),
      expect.objectContaining({
        eventType: "membership.revoked",
        subjectId: "member@example.test",
      }),
    ]));
    const serializedAudit = JSON.stringify(audit.body);
    expect(serializedAudit).not.toContain(OWNER.password);
    expect(serializedAudit).not.toContain(rejectedPassword);
    expect(serializedAudit).not.toContain(registrationToken);
  });

  it("rotates and revokes saved credentials, then preserves only secret-free audit evidence across restart", async () => {
    directory = mkdtempSync(join(tmpdir(), "stugu-security-drill-"));
    const databasePath = join(directory, "climate.sqlite");
    const secretsPath = join(directory, "private", "integrations.json");
    const configEnvironment = {
      NODE_ENV: "test",
      DATABASE_PATH: databasePath,
      INTEGRATION_SECRETS_FILE: secretsPath,
      MOCK_ENABLED: "false",
    } as const;
    const successfulCredentialTest = async () => ({ ok: true, connected: true, message: "validated" });
    runtime = createApi({
      config: loadConfig(configEnvironment),
      startBackground: false,
      homeAssistantCredentialTester: successfulCredentialTest,
      tpLinkCredentialTester: successfulCredentialTest,
    });

    const oldHaToken = "old-home-assistant-secret";
    const newHaToken = "new-home-assistant-secret";
    await request(runtime.app).put("/api/v1/integrations/home-assistant/config")
      .send({ url: "http://homeassistant.local:8123", token: oldHaToken }).expect(200);
    await request(runtime.app).put("/api/v1/integrations/home-assistant/config")
      .send({ url: "http://homeassistant.local:8123", token: newHaToken }).expect(200);
    expect(readFileSync(secretsPath, "utf8")).not.toContain(oldHaToken);
    expect(readFileSync(secretsPath, "utf8")).toContain(newHaToken);
    await request(runtime.app).delete("/api/v1/integrations/home-assistant/config/house-main").expect(200);

    const oldTpPassword = "old-tp-link-secret";
    const newTpPassword = "new-tp-link-secret";
    const firstTpLink = await request(runtime.app).put("/api/v1/integrations/tp-link/config")
      .send({ host: "192.168.1.42", username: "devices@example.test", password: oldTpPassword })
      .expect(200);
    const rotatedTpLink = await request(runtime.app).put("/api/v1/integrations/tp-link/config")
      .send({ host: "192.168.1.42", username: "devices@example.test", password: newTpPassword })
      .expect(200);
    expect(rotatedTpLink.body.connectionId).toBe(firstTpLink.body.connectionId);
    expect(readFileSync(secretsPath, "utf8")).not.toContain(oldTpPassword);
    expect(readFileSync(secretsPath, "utf8")).toContain(newTpPassword);
    await request(runtime.app).delete(`/api/v1/integrations/tp-link/config/${firstTpLink.body.connectionId}`).expect(200);

    const appleGrant = await request(runtime.app).post("/api/v1/integrations/apple-notes/grants")
      .send({ houseId: "house-main", deviceLabel: "Rotation drill phone" }).expect(201);
    const appleToken = appleGrant.body.token as string;
    await request(runtime.app).delete(`/api/v1/integrations/apple-notes/grants/${appleGrant.body.id}`).expect(200);

    const finalSecrets = readFileSync(secretsPath, "utf8");
    for (const secret of [oldHaToken, newHaToken, oldTpPassword, newTpPassword, appleToken]) {
      expect(finalSecrets).not.toContain(secret);
    }

    await runtime.close();
    runtime = createApi({ config: loadConfig(configEnvironment), startBackground: false });
    const audit = await request(runtime.app).get("/api/v1/security/audit-events?limit=500").expect(200);
    const credentialLifecycle = audit.body.events.map((event: { eventType: string; subjectId: string }) => (
      `${event.eventType}:${event.subjectId}`
    ));
    expect(credentialLifecycle).toEqual(expect.arrayContaining([
      "integration.credentials.configured:home-assistant:house-main",
      "integration.credentials.rotated:home-assistant:house-main",
      "integration.credentials.revoked:home-assistant:house-main",
      `integration.credentials.configured:tp-link:${firstTpLink.body.connectionId}`,
      `integration.credentials.rotated:tp-link:${firstTpLink.body.connectionId}`,
      `integration.credentials.revoked:tp-link:${firstTpLink.body.connectionId}`,
      `integration.grant.issued:apple-notes:${appleGrant.body.id}`,
      `integration.grant.revoked:apple-notes:${appleGrant.body.id}`,
    ]));
    const serializedAudit = JSON.stringify(audit.body);
    for (const forbidden of [
      oldHaToken, newHaToken, "homeassistant.local", oldTpPassword, newTpPassword,
      "devices@example.test", "192.168.1.42", appleToken,
    ]) {
      expect(serializedAudit).not.toContain(forbidden);
    }
  });
});
