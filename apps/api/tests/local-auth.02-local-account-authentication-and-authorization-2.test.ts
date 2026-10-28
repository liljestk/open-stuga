import { once } from "node:events";

import type { AddressInfo } from "node:net";

import request from "supertest";

import { afterEach, describe, expect, it } from "vitest";

import type { ApiRuntime } from "../src/app.js";

import { OWNER, authRuntime, sessionCookie, setupOwner, streamTextToEnd } from "./local-authTestSupport.js";

describe("local account authentication and authorization", () => {
  const runtimes: ApiRuntime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  it("restricts Tapo export job cancellation and retry to Owner and Admin roles", async () => {
    const runtime = authRuntime();
    runtimes.push(runtime);
    const owner = await setupOwner(runtime);
    const sensor = runtime.database.listSensors()[0]!;
    const house = runtime.database.getHouse(sensor.houseId)!;
    const job = runtime.database.enqueueTapoHistoryExportJob({
      provider: "private-cloud",
      sensorId: sensor.id,
      expectedDeviceId: "tapo-authz-fixture",
      deviceName: "Authorization fixture",
      timeZone: house.timezone,
      metric: "temperature",
      expectedRecipient: null,
      rangeStart: "2026-07-01T00:00:00.000Z",
      rangeEnd: "2026-07-01T01:00:00.000Z",
      intervalMinutes: 15,
    }).job;
    const invitation = await owner.agent.post("/api/v1/tenant/members")
      .set("x-csrf-token", owner.csrf)
      .send({ email: "member-job-control@example.test", role: "member", grants: [] })
      .expect(201);
    const member = request.agent(runtime.app);
    const registration = await member.post("/api/v1/auth/register").send({
      token: invitation.body.registrationToken,
      password: "member job control password long enough",
    }).expect(201);

    await member.delete(`/api/v1/integrations/tp-link/history-export/jobs/${job.id}`)
      .set("x-csrf-token", registration.body.csrfToken)
      .expect(403, {
        error: { code: "FORBIDDEN", message: "Workspace administration requires an Owner or Admin account" },
      });
    await owner.agent.delete(`/api/v1/integrations/tp-link/history-export/jobs/${job.id}`)
      .set("x-csrf-token", owner.csrf)
      .expect(200)
      .expect(({ body }) => expect(body.job.status).toBe("cancelled"));
    await member.post(`/api/v1/integrations/tp-link/history-export/jobs/${job.id}/retry`)
      .set("x-csrf-token", registration.body.csrfToken)
      .expect(403, {
        error: { code: "FORBIDDEN", message: "Workspace administration requires an Owner or Admin account" },
      });
    await owner.agent.post(`/api/v1/integrations/tp-link/history-export/jobs/${job.id}/retry`)
      .set("x-csrf-token", owner.csrf)
      .expect(200)
      .expect(({ body }) => expect(body.job.status).toBe("queued"));
  });

  it("advertises and permits delivery retry only to Owner and Admin roles", async () => {
    const runtime = authRuntime();
    runtimes.push(runtime);
    const owner = await setupOwner(runtime);
    const terminalAt = "2026-07-31T09:00:00.000Z";
    runtime.database.db.prepare(`INSERT INTO notification_outbox
      (id, subject_kind, subject_id, stage, sequence, channel, destination_id,
       attempts, max_attempts, available_at, created_at, payload_json,
       destination_ref, dead_lettered_at, last_error)
      VALUES (?, 'maintenance', ?, 'due', 0, 'webhook', 'primary', 1, 1, ?, ?, '{}', '{}', ?, ?)`)
      .run("delivery-authz", "maintenance-authz", terminalAt, terminalAt, terminalAt, "terminal failure");

    const invitation = await owner.agent.post("/api/v1/tenant/members")
      .set("x-csrf-token", owner.csrf)
      .send({ email: "member-delivery-retry@example.test", role: "member", grants: [] })
      .expect(201);
    const member = request.agent(runtime.app);
    const registration = await member.post("/api/v1/auth/register").send({
      token: invitation.body.registrationToken,
      password: "member delivery retry password long enough",
    }).expect(201);

    await member.get("/api/v1/notification-deliveries")
      .expect(200)
      .expect(({ body }) => expect(body.deliveries).toContainEqual(expect.objectContaining({
        id: "delivery-authz",
        canRetry: false,
      })));
    await member.post("/api/v1/notification-deliveries/delivery-authz/retry")
      .set("x-csrf-token", registration.body.csrfToken)
      .expect(403, {
        error: { code: "FORBIDDEN", message: "Workspace administration requires an Owner or Admin account" },
      });

    await owner.agent.get("/api/v1/notification-deliveries")
      .expect(200)
      .expect(({ body }) => expect(body.deliveries).toContainEqual(expect.objectContaining({
        id: "delivery-authz",
        canRetry: true,
      })));
    await owner.agent.post("/api/v1/notification-deliveries/delivery-authz/retry")
      .set("x-csrf-token", owner.csrf)
      .expect(200)
      .expect(({ body }) => expect(body.delivery).toMatchObject({
        id: "delivery-authz",
        canRetry: false,
      }));
  });

  it("cleans expired invitations and deleted grants, scans beyond 500 hidden rows, and limits subject churn", async () => {
    const runtime = authRuntime();
    runtimes.push(runtime);
    const owner = await setupOwner(runtime);

    for (let index = 0; index < 501; index += 1) {
      runtime.database.createProperty({ id: `hidden-${String(index).padStart(3, "0")}`, name: `A hidden ${String(index).padStart(3, "0")}` });
    }
    runtime.database.createProperty({ id: "visible-after-500", name: "Z visible" });
    const invite = await owner.agent.post("/api/v1/tenant/members").set("x-csrf-token", owner.csrf).send({
      email: "paged@example.test", role: "guest", grants: [{ scopeType: "property", scopeId: "visible-after-500" }],
    }).expect(201);
    const pagedAgent = request.agent(runtime.app);
    await pagedAgent.post("/api/v1/auth/register").send({
      token: invite.body.registrationToken, password: "paged guest password long",
    }).expect(201);
    const page = await pagedAgent.get("/api/v1/properties?limit=1").expect(200);
    expect(page.body.properties.map((property: { id: string }) => property.id)).toEqual(["visible-after-500"]);

    const expired = await owner.agent.post("/api/v1/tenant/members").set("x-csrf-token", owner.csrf).send({
      email: "expired@example.test", role: "guest", grants: [{ scopeType: "property", scopeId: "property-main" }],
    }).expect(201);
    runtime.database.db.prepare("UPDATE local_workspace_invitations SET expires_at = ? WHERE email = ?")
      .run("2000-01-01T00:00:00.000Z", "expired@example.test");
    await request(runtime.app).post("/api/v1/auth/register").send({
      token: expired.body.registrationToken, password: "expired password long enough",
    }).expect(404);
    expect(runtime.database.db.prepare("SELECT 1 FROM local_workspace_invitations WHERE email = ?").get("expired@example.test")).toBeUndefined();
    expect(runtime.database.db.prepare("SELECT 1 FROM local_guest_access_grants WHERE subject_key = ?").get("expired@example.test")).toBeUndefined();

    const areaInvite = await owner.agent.post("/api/v1/tenant/members").set("x-csrf-token", owner.csrf).send({
      email: "area@example.test", role: "guest", grants: [{ scopeType: "area", scopeId: "area-delete-me" }],
    });
    expect(areaInvite.status).toBe(422);
    runtime.database.createPropertyArea({
      id: "area-delete-me", propertyId: "property-main", name: "Delete me", kind: "other",
      polygon: [{ latitude: 60, longitude: 24 }, { latitude: 60.001, longitude: 24 }, { latitude: 60, longitude: 24.001 }],
    });
    await owner.agent.post("/api/v1/tenant/members").set("x-csrf-token", owner.csrf).send({
      email: "area@example.test", role: "guest", grants: [{ scopeType: "area", scopeId: "area-delete-me" }],
    }).expect(201);
    expect(runtime.database.deletePropertyArea("area-delete-me")).toBe(true);
    expect(runtime.database.db.prepare("SELECT 1 FROM local_guest_access_grants WHERE scope_id = ?").get("area-delete-me")).toBeUndefined();

    // Setup, successful registration, and the expired-token attempt consumed
    // three of this client's 60 aggregate authentication attempts.
    for (let index = 0; index < 57; index += 1) {
      await request(runtime.app).post("/api/v1/auth/login").send({
        email: `rotated-${index}@example.test`, password: "short",
      }).expect(400);
    }
    const limited = await request(runtime.app).post("/api/v1/auth/login").send({
      email: "yet-another@example.test", password: "short",
    }).expect(429);
    expect(limited.headers["retry-after"]).toMatch(/^\d+$/);
  });

  it("signals authorization changes across core, v2, and spatial SSE before clearing cached Guest data", async () => {
    const runtime = authRuntime(true);
    runtimes.push(runtime);
    const owner = await setupOwner(runtime);
    const ownerRow = runtime.database.db.prepare("SELECT id FROM local_auth_users WHERE email = ?")
      .get(OWNER.email) as { id: string };
    const groundTruth = await owner.agent.post("/api/v1/houses/house-main/layers/ground-truth")
      .set("x-csrf-token", owner.csrf)
      .set("x-user", "spoofed-client-actor")
      .send({ label: "Owner observation" })
      .expect(201);
    expect(groundTruth.body.groundTruth.createdBy).toBe(ownerRow.id);

    const invite = await owner.agent.post("/api/v1/tenant/members").set("x-csrf-token", owner.csrf).send({
      email: "stream@example.test", role: "guest", grants: [{ scopeType: "house", scopeId: "house-main" }],
    }).expect(201);
    const registration = await request(runtime.app).post("/api/v1/auth/register").send({
      token: invite.body.registrationToken, password: "stream guest password long",
    }).expect(201);
    const cookie = sessionCookie(registration);

    const server = runtime.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;
      const [coreStream, measurementStream, spatialStream] = await Promise.all([
        fetch(`${base}/api/v1/events`, { headers: { cookie } }),
        fetch(`${base}/api/v2/measurements/events`, { headers: { cookie } }),
        fetch(`${base}/api/v1/layers/events?scopeKind=house&scopeId=house-main`, { headers: { cookie } }),
      ]);
      expect([coreStream.status, measurementStream.status, spatialStream.status]).toEqual([200, 200, 200]);

      await owner.agent.put("/api/v1/tenant/members/stream%40example.test/access")
        .set("x-csrf-token", owner.csrf).send({ grants: [] }).expect(200);
      const now = new Date().toISOString();
      runtime.bus.publish({
        type: "reading",
        data: {
          sensorId: "sensor-01", timestamp: now, temperature: 20, humidity: 40,
          battery: null, source: "api", quality: "good",
        },
      });
      runtime.bus.publishMeasurement({
        sensorId: "sensor-01", metric: "temperature", timestamp: now, value: 20,
        canonicalUnit: "°C", source: "api", quality: "good",
      });
      runtime.spatialLayers!.notifier.publish({
        partition: runtime.spatialLayers!.host.partition,
        scope: { kind: "house", id: "house-main" }, snapshotIds: [], bucketAt: now, emittedAt: now,
      });
      for (const text of await Promise.all([
        streamTextToEnd(coreStream),
        streamTextToEnd(measurementStream),
        streamTextToEnd(spatialStream),
      ])) {
        expect(text).toContain("event: authorization");
        expect(text).toContain('"status":"changed"');
      }

      await owner.agent.put("/api/v1/tenant/members/stream%40example.test/access")
        .set("x-csrf-token", owner.csrf)
        .send({ grants: [{ scopeType: "house", scopeId: "house-main" }] }).expect(200);
      const expiredStream = await fetch(`${base}/api/v1/events`, { headers: { cookie } });
      expect(expiredStream.status).toBe(200);

      await owner.agent.delete("/api/v1/tenant/members/stream%40example.test")
        .set("x-csrf-token", owner.csrf).expect(204);
      runtime.bus.publish({
        type: "reading",
        data: {
          sensorId: "sensor-01", timestamp: new Date().toISOString(), temperature: 20, humidity: 40,
          battery: null, source: "api", quality: "good",
        },
      });
      const expiredText = await streamTextToEnd(expiredStream);
      expect(expiredText).toContain("event: authorization");
      expect(expiredText).toContain('"status":"expired"');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("bounds concurrent SSE connections per authenticated account", async () => {
    const runtime = authRuntime();
    runtimes.push(runtime);
    const setup = await request(runtime.app).post("/api/v1/auth/setup").send(OWNER).expect(201);
    const cookie = sessionCookie(setup);
    const server = runtime.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const controllers: AbortController[] = [];
    const streams: globalThis.Response[] = [];
    try {
      const port = (server.address() as AddressInfo).port;
      for (let index = 0; index < 8; index += 1) {
        const controller = new AbortController();
        controllers.push(controller);
        const stream = await fetch(`http://127.0.0.1:${port}/api/v1/events`, {
          headers: { cookie }, signal: controller.signal,
        });
        expect(stream.status).toBe(200);
        streams.push(stream);
      }
      const limited = await fetch(`http://127.0.0.1:${port}/api/v1/events`, { headers: { cookie } });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("5");
      expect(await limited.json()).toMatchObject({ error: { code: "EVENT_STREAM_LIMIT" } });
    } finally {
      controllers.forEach((controller) => controller.abort());
      await Promise.allSettled(streams.map((stream) => stream.body?.cancel()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
