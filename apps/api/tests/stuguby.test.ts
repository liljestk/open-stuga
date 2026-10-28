import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import request from "supertest";

import {
  STUGBY_MEDIA_TYPE,
  STUGBY_PROTOCOL_VERSION,
  assertSafeFederationPayload,
  validateDatasetPayload,
  validateWireEvent,
} from "@climate-twin/stuguby-protocol";

import { createApi } from "../src/app.js";

import { loadConfig } from "../src/config.js";

import { StugubyService } from "../src/stuguby/service.js";

import { StugubyStore } from "../src/stuguby/store.js";

import { RunningNode, node, stop } from "./stugubyTestSupport.js";

describe("Stuguby federation", () => {
  const nodes: RunningNode[] = [];

  afterEach(async () => {
    for (const current of nodes.splice(0).reverse()) await stop(current);
  });

  it("enforces the federation data-plane exclusions recursively", () => {
    expect(() => assertSafeFederationPayload({ floor: { stateBinding: { provider: "home-assistant" } } })).toThrow(/outside the federation data plane/);
    expect(() => assertSafeFederationPayload({ credentials: { password: "no" } })).toThrow(/outside the federation data plane/);
    expect(() => assertSafeFederationPayload({ homeAssistantUrl: "https://integration.invalid" })).toThrow(/outside the federation data plane/);
    expect(() => assertSafeFederationPayload({ provider: "home-assistant", accountIdentity: "person@example.test" })).toThrow(/outside the federation data plane/);
    expect(() => assertSafeFederationPayload({ remoteControl: { command: "open" } })).toThrow(/outside the federation data plane/);
    expect(() => validateDatasetPayload("home.telemetry.v1", {
      publicationId: "home-1",
      chunkId: "chunk-1",
      from: "2026-07-22T00:00:00.000Z",
      to: "2026-07-22T00:01:00.000Z",
      complete: true,
      samples: [{ sensorPublicationId: "sensor-1", metricId: "temperature", timestamp: "2026-07-22T00:00:00.000Z", value: 21.5, quality: "good" }],
    })).not.toThrow();
    expect(() => validateDatasetPayload("home.directory.v1", {
      publicationId: "home-1", name: "House", timezone: "Europe/Helsinki", undocumented: "not allowed",
    })).toThrow(/not part of the protocol schema/);
    expect(() => validateDatasetPayload("home.recovery.v1", {
      publicationId: "home-1",
      chunkId: "weather-1",
      generation: 1,
      kind: "weather-history",
      complete: true,
      records: [{
        weatherKey: "weather-1",
        locationKey: "60.1,24.9",
        timestamp: "2026-07-22T00:00:00.000Z",
        temperatureC: "cold",
        source: "api",
        fetchedAt: "2026-07-22T00:01:00.000Z",
        stationId: null,
        stationName: null,
        conditions: null,
      }],
    })).toThrow(/temperatureC must be a finite number/);

    const event = {
      protocolVersion: STUGBY_PROTOCOL_VERSION,
      stugubyId: "stuguby-1",
      eventId: "event-1",
      eventKind: "member.updated",
      authorityNodeId: "node-1",
      streamId: "members",
      sequence: 1,
      schema: "stuguby.member.v2",
      resourceId: "node-1",
      operation: "upsert",
      revision: 1,
      grantId: null,
      grantEpoch: null,
      occurredAt: "2026-07-22T00:00:00.000Z",
      payload: {
        stugubyId: "stuguby-1", nodeId: "node-1", displayName: "Node", role: "participant", state: "active",
        publicKey: "public-key", keyFingerprint: "fingerprint", joinedAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:00:00.000Z",
      },
      payloadHash: "0".repeat(64),
    };
    expect(() => validateWireEvent({ ...event, sequence: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe integer/);
    expect(() => validateWireEvent({ ...event, revision: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe integer/);
  });

  it("pins coordinator creation to the server-owned public origin", async () => {
    const coordinator = await node("Pinned coordinator", false, undefined, "https://stuguby.example.test");
    const unconfigured = await node("Participant only");
    nodes.push(coordinator, unconfigured);

    const index = await request(coordinator.runtime.app).get("/api/v1/stugbys").expect(200);
    expect(index.body.publicOrigin).toBe("https://stuguby.example.test");
    const created = await request(coordinator.runtime.app).post("/api/v1/stugbys").send({
      name: "Pinned Stuguby",
      coordinatorUrl: "https://attacker.example.test",
    }).expect(201);
    expect(created.body.coordinatorUrl).toBe("https://stuguby.example.test");

    const unavailable = await request(unconfigured.runtime.app)
      .post("/api/v1/stugbys")
      .set("host", "unconfigured.example.test")
      .send({ name: "No public origin" })
      .expect(503);
    expect(unavailable.body.error.code).toBe("STUGBY_PUBLIC_ORIGIN_REQUIRED");

    const localOnly = await request(unconfigured.url).post("/api/v1/stugbys")
      .send({ name: "Local-only Stuguby" }).expect(201);
    const unavailableInvitation = await request(unconfigured.runtime.app)
      .post(`/api/v1/stugbys/${localOnly.body.id}/invitations`)
      .set("host", "unconfigured.example.test")
      .send({ role: "participant" })
      .expect(503);
    expect(unavailableInvitation.body.error.code).toBe("STUGBY_PUBLIC_ORIGIN_REQUIRED");

    const unavailableAdmission = await request(unconfigured.runtime.app)
      .post("/api/v1/stugby-protocol/join")
      .set("host", "unconfigured.example.test")
      .set("content-type", STUGBY_MEDIA_TYPE)
      .send("{}")
      .expect(503);
    expect(unavailableAdmission.body.error.code).toBe("STUGBY_PUBLIC_ORIGIN_REQUIRED");
  });

  it("fails closed instead of publishing bounded SQLite history as complete", async () => {
    const runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        TIMESERIES_ENABLED: "true",
        RETENTION_DAYS: "30",
      }),
      startBackground: false,
    });
    try {
      const created = await request(runtime.app).post("/api/v1/stugbys")
        .send({ name: "Archived history" }).expect(201);
      const result = await request(runtime.app)
        .post(`/api/v1/stugbys/${created.body.id as string}/grants`)
        .send({
          localHouseId: "house-main",
          audience: { kind: "all-members", nodeIds: [] },
          datasets: [{
            dataset: "home.telemetry.v1",
            enabled: true,
            includeLocalIds: false,
            allowReplicaCache: true,
            retentionDays: 30,
            telemetry: {
              sensorPublicationIds: [],
              metricIds: [],
              historyFrom: "2000-01-01T00:00:00.000Z",
              live: true,
              maxSamplesPerHour: 1_000,
            },
          }],
          housePolicy: {
            editPolicy: "read-only",
            recoveryMode: "none",
            designatedSuccessorNodeId: null,
          },
        }).expect(409);
      expect(result.body.error.code).toBe("ARCHIVED_TELEMETRY_EXPORT_UNAVAILABLE");
      expect(runtime.stuguby!.store.listGrants(created.body.id as string)).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it("persists an admin-confirmed coordinator origin when deployment configuration has none", async () => {
    const originProbe = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: { code: "STUGBY_PUBLIC_ORIGIN_REQUIRED" },
    }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }));
    const coordinator = await node("UI-configured coordinator", false, originProbe);
    nodes.push(coordinator);

    const configured = await request(coordinator.runtime.app)
      .put("/api/v1/stugbys/configuration")
      .send({ publicOrigin: "https://stugu.example.test" })
      .expect(200);
    expect(configured.body.publicOrigin).toBe("https://stugu.example.test");
    expect(coordinator.runtime.stuguby.store.getNodePublicOrigin()).toBe("https://stugu.example.test");
    expect(originProbe).toHaveBeenCalledWith(
      "https://stugu.example.test/api/v1/stugby-protocol/join",
      expect.objectContaining({ method: "POST", redirect: "manual" }),
    );

    const created = await request(coordinator.runtime.app)
      .post("/api/v1/stugbys")
      .set("host", "private-node.example.test")
      .send({ name: "Configured in setup" })
      .expect(201);
    expect(created.body.coordinatorUrl).toBe("https://stugu.example.test");

    const restarted = new StugubyService({
      database: coordinator.runtime.database,
      store: new StugubyStore(coordinator.runtime.database.db, coordinator.runtime.stuguby.identity.nodeId),
      keys: coordinator.runtime.stuguby.keys,
      bus: coordinator.runtime.bus,
      assetDirectory: coordinator.directory,
    });
    expect(restarted.publicOrigin).toBe("https://stugu.example.test");
  });

  it("checks a UI-configured address before saving it", async () => {
    const coordinator = await node(
      "Unreachable coordinator",
      false,
      async () => new Response("Cloudflare login", { status: 403, headers: { "content-type": "text/html" } }),
    );
    nodes.push(coordinator);

    const response = await request(coordinator.runtime.app)
      .put("/api/v1/stugbys/configuration")
      .send({ publicOrigin: "https://stugu.example.test" })
      .expect(422);

    expect(response.body.error.code).toBe("STUGBY_ADDRESS_UNREACHABLE");
    expect(response.body.error.message).toMatch(/could not reach its secure address/u);
    expect(coordinator.runtime.stuguby.store.getNodePublicOrigin()).toBeNull();
  });

  it("does not let the UI replace a deployment-managed coordinator origin", async () => {
    const coordinator = await node("Managed coordinator", false, undefined, "https://managed.example.test");
    nodes.push(coordinator);

    const response = await request(coordinator.runtime.app)
      .put("/api/v1/stugbys/configuration")
      .send({ publicOrigin: "https://replacement.example.test" })
      .expect(409);
    expect(response.body.error.code).toBe("STUGBY_PUBLIC_ORIGIN_MANAGED");
  });

  it("requires Cloudflare coordinator provisioning before accepting its suggested origin", async () => {
    const uiOnly = await node(
      "UI-only Cloudflare node",
      false,
      undefined,
      undefined,
      "https://stugu.example.test",
    );
    nodes.push(uiOnly);

    const index = await request(uiOnly.runtime.app)
      .get("/api/v1/stugbys")
      .set("host", "stugu.example.test")
      .expect(200);
    expect(index.body).toMatchObject({
      publicOrigin: null,
      suggestedPublicOrigin: "https://stugu.example.test",
      publicOriginConfigurable: false,
    });
    const response = await request(uiOnly.runtime.app)
      .put("/api/v1/stugbys/configuration")
      .send({ publicOrigin: "https://stugu.example.test" })
      .expect(409);
    expect(response.body.error.code).toBe("STUGBY_COORDINATOR_PROVISIONING_REQUIRED");
  });

  it("deletes a closed local-only Stuguby and its federation records", async () => {
    const coordinator = await node("Disposable coordinator");
    nodes.push(coordinator);
    const created = await request(coordinator.url).post("/api/v1/stugbys")
      .send({ name: "Disposable Stuguby" }).expect(201);
    const invitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${created.body.id}/invitations`)
      .send({ role: "participant" }).expect(201);
    coordinator.runtime.stuguby.store.publicationId(created.body.id, "home", "home-local");
    const digest = "a".repeat(64);
    coordinator.runtime.stuguby.store.registerBlob(digest, 1, "image/png", digest);
    coordinator.runtime.stuguby.store.registerBlobReference(created.body.id, digest, "retired-grant", 1, "local");
    await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${created.body.id}/property/adopt`)
      .send({ localPropertyId: "property-main" }).expect(201);
    await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${created.body.id}/property/disconnect`)
      .send({ confirmation: "DISCONNECT" }).expect(200);
    expect(coordinator.runtime.database.getProperty("property-main")?.stuguby)
      .toMatchObject({ syncState: "detached" });

    await request(coordinator.runtime.app).delete(`/api/v1/stugbys/${created.body.id}`).expect(204);

    await request(coordinator.runtime.app).get(`/api/v1/stugbys/${created.body.id}`).expect(404);
    expect(coordinator.runtime.database.getProperty("property-main")?.stuguby).toBeUndefined();
    expect(coordinator.runtime.stuguby.store.getInvitation(invitation.body.id)).toBeNull();
    expect(coordinator.runtime.stuguby.store.getBlob(digest)).toBeNull();
    for (const table of [
      "stugby_federations",
      "stugby_members",
      "stugby_invitations",
      "stugby_publication_ids",
      "stugby_shared_properties",
      "stugby_blob_references",
      "stugby_audit_events",
    ]) {
      const row = coordinator.runtime.database.db.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${table === "stugby_federations" ? "id" : "stugby_id"}=?`)
        .get(created.body.id) as { count: number };
      expect(row.count, table).toBe(0);
    }
    expect(coordinator.runtime.database.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("refuses to delete a Stuguby while membership or sharing is active", async () => {
    const coordinator = await node("Protected coordinator");
    nodes.push(coordinator);
    const created = await request(coordinator.url).post("/api/v1/stugbys")
      .send({ name: "Protected Stuguby" }).expect(201);
    coordinator.runtime.stuguby.store.upsertMember({
      stugubyId: created.body.id,
      nodeId: "00000000-0000-4000-8000-000000000001",
      displayName: "Connected participant",
      role: "participant",
      state: "active",
      publicKey: "participant-public-key",
      keyFingerprint: "0".repeat(64),
      joinedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const memberConflict = await request(coordinator.runtime.app)
      .delete(`/api/v1/stugbys/${created.body.id}`).expect(409);
    expect(memberConflict.body.error.code).toBe("STUGBY_MEMBERS_ACTIVE");

    coordinator.runtime.stuguby.store.upsertMember({
      ...coordinator.runtime.stuguby.store.getMember(created.body.id, "00000000-0000-4000-8000-000000000001")!,
      state: "revoked",
      updatedAt: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    coordinator.runtime.stuguby.store.upsertGrant({
      id: "00000000-0000-4000-8000-000000000002",
      stugubyId: created.body.id,
      authorityNodeId: coordinator.runtime.stuguby.identity.nodeId,
      publicationId: "00000000-0000-4000-8000-000000000003",
      localHouseId: "home-local",
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [],
      epoch: 1,
      revision: 1,
      expiresAt: null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const sharingConflict = await request(coordinator.runtime.app)
      .delete(`/api/v1/stugbys/${created.body.id}`).expect(409);
    expect(sharingConflict.body.error.code).toBe("STUGBY_SHARING_ACTIVE");
    await request(coordinator.runtime.app).get(`/api/v1/stugbys/${created.body.id}`).expect(200);
  });

  it("repins an unjoined loopback coordinator and revokes origin-bound invitations", async () => {
    const coordinator = await node("Migrating coordinator");
    nodes.push(coordinator);
    const created = await request(coordinator.url).post("/api/v1/stugbys")
      .send({ name: "Migrating Stuguby" }).expect(201);
    const staleInvitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${created.body.id}/invitations`)
      .send({ role: "participant" }).expect(201);
    expect(new URL(staleInvitation.body.joinUrl).origin).toBe(coordinator.url);

    const migrated = new StugubyService({
      database: coordinator.runtime.database,
      store: coordinator.runtime.stuguby.store,
      keys: coordinator.runtime.stuguby.keys,
      bus: coordinator.runtime.bus,
      assetDirectory: coordinator.directory,
      publicOrigin: "https://stuguby.example.test",
    });

    expect(migrated.getStuguby(created.body.id).coordinatorUrl).toBe("https://stuguby.example.test");
    expect(migrated.store.getInvitation(staleInvitation.body.id)?.revokedAt).not.toBeNull();
    expect(migrated.store.listAudit(created.body.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "coordinator.origin.updated",
        details: expect.objectContaining({ revokedInvitations: 1 }),
      }),
    ]));
    const freshInvitation = migrated.createInvitation(created.body.id, { role: "participant" });
    expect(new URL(freshInvitation.joinUrl).origin).toBe("https://stuguby.example.test");
  });

  it("fails closed instead of moving a coordinator that already has another node", async () => {
    const coordinator = await node("Established coordinator");
    nodes.push(coordinator);
    const created = await request(coordinator.url).post("/api/v1/stugbys")
      .send({ name: "Established Stuguby" }).expect(201);
    coordinator.runtime.stuguby.store.upsertMember({
      stugubyId: created.body.id,
      nodeId: "00000000-0000-4000-8000-000000000001",
      displayName: "Existing participant",
      role: "participant",
      state: "active",
      publicKey: "existing-public-key",
      keyFingerprint: "0".repeat(64),
      joinedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const reconfigured = new StugubyService({
      database: coordinator.runtime.database,
      store: coordinator.runtime.stuguby.store,
      keys: coordinator.runtime.stuguby.keys,
      bus: coordinator.runtime.bus,
      assetDirectory: coordinator.directory,
      publicOrigin: "https://replacement.example.test",
    });

    expect(reconfigured.getStuguby(created.body.id).coordinatorUrl).toBe(coordinator.url);
    expect(() => reconfigured.createInvitation(created.body.id, { role: "participant" }))
      .toThrow(/does not match this server's configured public origin/u);
  });

  it("makes one-time admission atomic and recoverable after a lost join response", async () => {
    let loseFirstJoinResponse = true;
    const lossyFetcher: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (loseFirstJoinResponse && String(input).endsWith("/api/v1/stugby-protocol/join")) {
        loseFirstJoinResponse = false;
        await response.arrayBuffer();
        throw new Error("simulated lost join response");
      }
      return response;
    };
    const coordinator = await node("Idempotent coordinator");
    const participant = await node("Idempotent participant", false, lossyFetcher);
    const otherNode = await node("Different node");
    nodes.push(coordinator, participant, otherNode);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "Reliable join" }).expect(201);
    const invitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${created.body.id}/invitations`).send({ role: "participant" }).expect(201);

    const invitationUrl = new URL(invitation.body.joinUrl);
    expect(invitationUrl.pathname).toBe("/invite-bootstrap");
    expect(invitationUrl.hash).toBe(`#${invitation.body.id}.${invitation.body.joinSecret}`);
    const handoff = readFileSync(new URL("../../web/public/invite-bootstrap.js", import.meta.url), "utf8");
    expect(handoff).toContain("The secret stays in this tab and is not sent to this server.");
    expect(handoff).not.toMatch(/\bfetch\s*\(/u);

    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(500);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);
    const localResponseRetry = await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);
    expect(localResponseRetry.body.id).toBe(created.body.id);

    expect(coordinator.runtime.stuguby.store.listMembers(created.body.id)
      .filter((member) => member.nodeId === participant.runtime.stuguby.identity.nodeId)).toHaveLength(1);
    const wrongIdentity = await request(otherNode.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(401);
    expect(wrongIdentity.body.error.code).toBe("INVALID_INVITATION");
  });

  it("keeps invitation names or emails private to the Stugu that assigned them", async () => {
    const coordinator = await node("Private-label coordinator");
    const participant = await node("Stugu");
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys")
      .send({ name: "Labelled Stuguby" }).expect(201);
    const invitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${created.body.id}/invitations`)
      .send({ role: "participant", localLabel: "anna@example.test" }).expect(201);
    expect(invitation.body.localLabel).toBe("anna@example.test");

    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);

    const coordinatorDetail = await request(coordinator.runtime.app)
      .get(`/api/v1/stugbys/${created.body.id}`).expect(200);
    expect(coordinatorDetail.body.members).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: participant.runtime.stuguby.identity.nodeId,
        displayName: "Stugu",
        localLabel: "anna@example.test",
      }),
    ]));
    expect(coordinator.runtime.stuguby.store.listMembers(created.body.id)
      .find((member) => member.nodeId === participant.runtime.stuguby.identity.nodeId))
      .not.toHaveProperty("localLabel");

    const participantDetail = await request(participant.runtime.app)
      .get(`/api/v1/stugbys/${created.body.id}`).expect(200);
    expect(participantDetail.body.members.every((member: { localLabel: string | null }) => member.localLabel === null)).toBe(true);

    await request(coordinator.runtime.app)
      .patch(`/api/v1/stugbys/${created.body.id}/members/${participant.runtime.stuguby.identity.nodeId}/label`)
      .send({ localLabel: "Anna's cottage" }).expect(200);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${created.body.id}/sync`).expect(200);
    const participantAfterSync = await request(participant.runtime.app)
      .get(`/api/v1/stugbys/${created.body.id}`).expect(200);
    expect(participantAfterSync.body.members.every((member: { localLabel: string | null }) => member.localLabel === null)).toBe(true);
  });

  it("rejects non-UUID replay identifiers before persistence", async () => {
    const coordinator = await node("Replay coordinator");
    nodes.push(coordinator);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "Replay bounds" }).expect(201);
    expect(() => coordinator.runtime.stuguby.authenticateMachineRequest(created.body.id, {
      method: "GET",
      path: `/api/v1/stugby-protocol/stugbys/${created.body.id}/events`,
      body: new Uint8Array(),
      nodeId: coordinator.runtime.stuguby.identity.nodeId,
      timestamp: new Date().toISOString(),
      requestId: "x".repeat(8_000),
      signature: "not-used-for-an-invalid-id",
    })).toThrow(/request id must be a UUID/i);
  });

  it("allows only one active share grant per Home in a Stuguby", async () => {
    const coordinator = await node("Unique Home grant coordinator");
    nodes.push(coordinator);
    const created = await request(coordinator.url).post("/api/v1/stugbys")
      .send({ name: "Unique Home grants" }).expect(201);
    const stugubyId = created.body.id as string;
    const input = {
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [{
        dataset: "home.directory.v1",
        enabled: true,
        includeLocalIds: false,
        allowReplicaCache: true,
        retentionDays: 30,
      }],
    };

    const first = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/grants`).send(input).expect(201);
    const duplicate = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/grants`).send(input).expect(409);
    expect(duplicate.body.error.code).toBe("HOME_ALREADY_SHARED");
    expect(coordinator.runtime.stuguby.store.listGrants(stugubyId)
      .filter((grant) => !grant.revokedAt)).toHaveLength(1);

    await request(coordinator.runtime.app)
      .delete(`/api/v1/stugbys/${stugubyId}/grants/${first.body.id}`).expect(200);
    await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/grants`).send(input).expect(201);
  });
});
