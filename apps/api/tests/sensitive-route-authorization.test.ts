import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import type { GuestAccessGrant, TenantMemberRole } from "@climate-twin/contracts";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { setupOwner } from "./local-authTestSupport.js";

type TestPrincipal = {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
};

async function registerPrincipal(
  runtime: ApiRuntime,
  owner: Awaited<ReturnType<typeof setupOwner>>,
  role: Exclude<TenantMemberRole, "owner">,
  email: string,
  grants: GuestAccessGrant[] = [],
): Promise<TestPrincipal> {
  const invitation = await owner.agent.post("/api/v1/tenant/members")
    .set("x-csrf-token", owner.csrf)
    .send({ email, role, grants })
    .expect(201);
  const agent = request.agent(runtime.app);
  const registration = await agent.post("/api/v1/auth/register")
    .send({
      token: invitation.body.registrationToken,
      password: `${role} route-matrix password`,
    })
    .expect(201);
  return { agent, csrf: registration.body.csrfToken as string };
}

async function expectAdministrativeRoutesAllowed(principal: TestPrincipal): Promise<void> {
  await principal.agent.get("/api/v1/data-export/preview?privacyLevel=full&includeTelemetry=true").expect(200);
  await principal.agent.get("/api/v1/data-export?privacyLevel=structure").expect(200);
  await principal.agent.get("/api/v1/backups/status").expect(200);
  await principal.agent.post("/api/v1/backups").set("x-csrf-token", principal.csrf).send({}).expect(202);
  await principal.agent.get("/api/v1/setup/doctor").expect(200);
}

async function expectAdministrativeRoutesDenied(principal: TestPrincipal): Promise<void> {
  for (const path of [
    "/api/v1/data-export/preview?privacyLevel=full&includeTelemetry=true",
    "/api/v1/data-export?privacyLevel=full&includeTelemetry=true",
    "/api/v1/backups/status",
    "/api/v1/setup/doctor",
  ]) {
    const response = await principal.agent.get(path).expect(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  }
  await principal.agent.post("/api/v1/backups")
    .set("x-csrf-token", principal.csrf)
    .send({})
    .expect(403);
}

describe("sensitive route authorization", () => {
  let runtime: ApiRuntime | null = null;
  let temporaryRoot: string | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = null;
  });

  it("limits exports, backup operations, and setup diagnostics to Owner and Admin", async () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "stugu-sensitive-routes-"));
    runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        MOCK_ENABLED: "false",
        LOCAL_AUTH_TEST_BYPASS: "false",
        BACKUP_OPERATIONS_DIRECTORY: join(temporaryRoot, "operations"),
        BACKUP_DIRECTORY: join(temporaryRoot, "backups"),
      }),
      startBackground: false,
    });
    const owner = await setupOwner(runtime);
    const admin = await registerPrincipal(runtime, owner, "admin", "admin-routes@example.test");
    const member = await registerPrincipal(runtime, owner, "member", "member-routes@example.test");
    const narrowGuest = await registerPrincipal(
      runtime,
      owner,
      "guest",
      "narrow-guest-routes@example.test",
      [{ scopeType: "house", scopeId: "house-main" }],
    );
    const noGrantGuest = await registerPrincipal(
      runtime,
      owner,
      "guest",
      "no-grant-guest-routes@example.test",
    );

    await expectAdministrativeRoutesAllowed(owner);
    await expectAdministrativeRoutesAllowed(admin);
    await expectAdministrativeRoutesDenied(member);
    await expectAdministrativeRoutesDenied(narrowGuest);
    await expectAdministrativeRoutesDenied(noGrantGuest);
  });

  it("returns sensor labels only when the signed-in principal can see that sensor", async () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "stugu-sensor-label-routes-"));
    runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        MOCK_ENABLED: "false",
        LOCAL_AUTH_TEST_BYPASS: "false",
        BACKUP_OPERATIONS_DIRECTORY: join(temporaryRoot, "operations"),
      }),
      startBackground: false,
    });
    const owner = await setupOwner(runtime);
    const admin = await registerPrincipal(runtime, owner, "admin", "admin-label@example.test");
    const member = await registerPrincipal(runtime, owner, "member", "member-label@example.test");
    const houseGuest = await registerPrincipal(
      runtime,
      owner,
      "guest",
      "house-guest-label@example.test",
      [{ scopeType: "house", scopeId: "house-main" }],
    );
    const noGrantGuest = await registerPrincipal(runtime, owner, "guest", "no-grant-label@example.test");

    for (const principal of [owner, admin, member, houseGuest]) {
      await principal.agent.get("/api/v1/sensors/sensor-01/label")
        .expect(200)
        .expect(({ body }) => expect(body.label.sensorId).toBe("sensor-01"));
    }
    const hidden = await noGrantGuest.agent.get("/api/v1/sensors/sensor-01/label").expect(404);
    expect(hidden.body.error.code).toBe("NOT_FOUND");
  });

  it("keeps global playbook configuration private while preserving scoped alert guidance", async () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "stugu-action-playbook-routes-"));
    runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        MOCK_ENABLED: "false",
        LOCAL_AUTH_TEST_BYPASS: "false",
        BACKUP_OPERATIONS_DIRECTORY: join(temporaryRoot, "operations"),
      }),
      startBackground: false,
    });
    const owner = await setupOwner(runtime);
    const guestEmail = "scoped-playbook-guest@example.test";
    const guest = await registerPrincipal(
      runtime,
      owner,
      "guest",
      guestEmail,
      [{ scopeType: "house", scopeId: "house-main" }],
    );
    await owner.agent.post("/api/v1/houses")
      .set("x-csrf-token", owner.csrf)
      .send({
        id: "house-private-playbooks",
        name: "Private Home",
        timezone: "Europe/Helsinki",
        floors: [{
          id: "floor-private-playbooks",
          name: "Main",
          width: 4,
          height: 4,
          elevation: 0,
          walls: [],
          rooms: [],
        }],
      })
      .expect(201);
    await owner.agent.post("/api/v1/sensors")
      .set("x-csrf-token", owner.csrf)
      .send({
        id: "sensor-private-playbooks",
        houseId: "house-private-playbooks",
        floorId: "floor-private-playbooks",
        name: "Private sensor",
        room: "Main",
        model: "Test",
        x: 2,
        y: 2,
        z: 1,
        tags: [],
        enabled: true,
      })
      .expect(201);

    const playbook = runtime.database.saveActionPlaybook({
      name: "Private ventilation procedure",
      description: "Workspace-authored instructions for sustained humidity.",
      instructions: ["Open the extractor vent", "Check again after ten minutes"],
      metric: "humidity",
      goal: "decrease",
      minimumImprovement: 2,
      targetValue: null,
      waitSeconds: 600,
      verificationWindowSeconds: 900,
    });
    const visibleRule = runtime.database.saveAlertRule({
      id: "rule-visible-playbooks",
      name: "Visible humidity alert",
      sensorId: "sensor-01",
      metric: "humidity",
      operator: "gte",
      threshold: 65,
      durationSeconds: 60,
      severity: "warning",
      enabled: true,
      webhookEnabled: false,
      telegramEnabled: false,
    });
    const hiddenRule = runtime.database.saveAlertRule({
      id: "rule-hidden-playbooks",
      name: "Hidden humidity alert",
      sensorId: "sensor-private-playbooks",
      metric: "humidity",
      operator: "gte",
      threshold: 65,
      durationSeconds: 60,
      severity: "warning",
      enabled: true,
      webhookEnabled: false,
      telegramEnabled: false,
    });
    const visibleEvent = runtime.database.createAlertEvent({
      ruleId: visibleRule.id,
      sensorId: "sensor-01",
      metric: "humidity",
      value: 70,
      threshold: 65,
      severity: "warning",
      startedAt: "2026-08-01T12:00:00.000Z",
    });
    const hiddenEvent = runtime.database.createAlertEvent({
      ruleId: hiddenRule.id,
      sensorId: "sensor-private-playbooks",
      metric: "humidity",
      value: 70,
      threshold: 65,
      severity: "warning",
      startedAt: "2026-08-01T12:00:00.000Z",
    });

    await owner.agent.get("/api/v1/action-playbooks")
      .expect(200)
      .expect(({ body }) => expect(body.playbooks).toContainEqual(expect.objectContaining({ id: playbook.id })));
    const globalList = await guest.agent.get("/api/v1/action-playbooks").expect(403);
    expect(globalList.body.error.code).toBe("GUEST_READ_ONLY");

    await guest.agent.get(`/api/v1/alerts/${visibleEvent.id}/action-playbooks`)
      .expect(200)
      .expect(({ body }) => expect(body.playbooks).toContainEqual(expect.objectContaining({
        id: playbook.id,
        instructions: playbook.instructions,
      })));
    const hidden = await guest.agent.get(`/api/v1/alerts/${hiddenEvent.id}/action-playbooks`).expect(404);
    const missing = await guest.agent.get("/api/v1/alerts/missing-alert/action-playbooks").expect(404);
    expect(hidden.body).toEqual(missing.body);

    await owner.agent.put(`/api/v1/tenant/members/${encodeURIComponent(guestEmail)}/access`)
      .set("x-csrf-token", owner.csrf)
      .send({ grants: [] })
      .expect(200);
    const revoked = await guest.agent.get(`/api/v1/alerts/${visibleEvent.id}/action-playbooks`).expect(404);
    expect(revoked.body).toEqual(missing.body);
  });
});
