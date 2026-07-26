import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { MeasurementSample } from "@climate-twin/contracts";
import {
  STUGBY_DATASETS,
  STUGBY_MEDIA_TYPE,
  STUGBY_PROTOCOL_VERSION,
  assertSafeFederationPayload,
  validateDatasetPayload,
  validateWireEvent,
  type StugubyDatasetGrant,
} from "@climate-twin/stuguby-protocol";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { StugubyService } from "../src/stuguby/service.js";
import { StugubyStore } from "../src/stuguby/store.js";

interface RunningNode {
  runtime: ApiRuntime;
  server: Server;
  url: string;
  directory: string;
}

async function node(
  name: string,
  startBackground = false,
  stugubyFetcher?: typeof fetch,
  publicOrigin?: string,
  cloudflarePublicOrigin?: string,
): Promise<RunningNode> {
  const directory = mkdtempSync(join(tmpdir(), "stuguby-test-"));
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: ":memory:",
    ASSET_DIRECTORY: directory,
    STUGBY_NODE_NAME: name,
    STUGBY_SYNC_INTERVAL_MS: "300000",
    SPATIAL_LAYERS_ENABLED: "false",
    ...(publicOrigin ? { STUGBY_PUBLIC_ORIGIN: publicOrigin } : {}),
    ...(cloudflarePublicOrigin ? { CLOUDFLARE_ACCESS_PUBLIC_ORIGIN: cloudflarePublicOrigin } : {}),
  });
  const runtime = createApi({ config, startBackground, ...(stugubyFetcher ? { stugubyFetcher } : {}) });
  const server = createServer(runtime.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return { runtime, server, url: `http://127.0.0.1:${address.port}`, directory };
}

async function stop(value: RunningNode): Promise<void> {
  await value.runtime.close();
  await new Promise<void>((resolve, reject) => value.server.close((error) => error ? reject(error) : resolve()));
  rmSync(value.directory, { recursive: true, force: true });
}

function editableHomeDatasets(): StugubyDatasetGrant[] {
  return [
    "home.directory.v1",
    "home.location.v1",
    "home.structure.v1",
    "home.sensor-catalog.v1",
    "home.notes.v1",
    "home.observations.v1",
  ].map((dataset) => ({
    dataset: dataset as StugubyDatasetGrant["dataset"],
    enabled: true,
    includeLocalIds: false,
    allowReplicaCache: true,
    retentionDays: 30,
  }));
}

function fullRecoveryDatasets(): StugubyDatasetGrant[] {
  return STUGBY_DATASETS.map((dataset) => ({
    dataset,
    enabled: true,
    includeLocalIds: false,
    allowReplicaCache: true,
    retentionDays: 3_650,
    ...(dataset === "home.telemetry.v1" ? {
      telemetry: {
        sensorPublicationIds: [],
        metricIds: [],
        historyFrom: "2000-01-01T00:00:00.000Z",
        live: true,
        maxSamplesPerHour: 1_000_000,
      },
    } : {}),
  }));
}

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

  it("rolls back grant state, epochs, events, deletion expectations, and audit when publication fails", async () => {
    const coordinator = await node("Atomic grant coordinator");
    const participant = await node("Atomic grant publisher");
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "Atomic grants" }).expect(201);
    const stugubyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/invitations`)
      .send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);

    const store = participant.runtime.stuguby.store;
    const datasets: StugubyDatasetGrant[] = [
      { dataset: "home.directory.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 },
    ];
    const originalEnqueue = store.enqueueOutbox.bind(store);
    let enqueueCalls = 0;
    const createFault = vi.spyOn(store, "enqueueOutbox").mockImplementation((...args) => {
      originalEnqueue(...args);
      enqueueCalls += 1;
      if (enqueueCalls === 2) throw new Error("simulated snapshot enqueue failure");
    });
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets,
    }).expect(500);
    createFault.mockRestore();
    expect(store.listGrants(stugubyId)).toEqual([]);
    expect(store.dueOutbox(250)).toEqual([]);
    expect(store.listAudit(stugubyId).some((event) => event.eventType === "grant.created")).toBe(false);

    const grantResponse = await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets,
    }).expect(201);
    const grantId = grantResponse.body.id as string;
    const firstControl = store.dueOutbox(250).find((item) => item.event.streamId === `grant:${grantId}`);
    expect(firstControl?.event.sequence).toBe(1);
    store.acknowledgeOutbox(store.dueOutbox(250).map((item) => item.id));

    enqueueCalls = 0;
    const updateFault = vi.spyOn(store, "enqueueOutbox").mockImplementation((...args) => {
      originalEnqueue(...args);
      enqueueCalls += 1;
      if (enqueueCalls === 3) throw new Error("simulated updated snapshot enqueue failure");
    });
    await request(participant.runtime.app).put(`/api/v1/stugbys/${stugubyId}/grants/${grantId}`).send({
      baseRevision: 1,
      audience: { kind: "all-members", nodeIds: [] },
      datasets: datasets.map((dataset) => ({ ...dataset, includeLocalIds: true })),
      housePolicy: { editPolicy: "read-only", recoveryMode: "none", designatedSuccessorNodeId: null },
      expiresAt: null,
    }).expect(500);
    updateFault.mockRestore();
    expect(store.getGrant(grantId)).toMatchObject({ epoch: 1, revision: 1, revokedAt: null });
    expect(store.dueOutbox(250)).toEqual([]);
    expect(store.listAudit(stugubyId).some((event) => event.eventType === "grant.updated")).toBe(false);

    const updated = await request(participant.runtime.app).put(`/api/v1/stugbys/${stugubyId}/grants/${grantId}`).send({
      baseRevision: 1,
      audience: { kind: "all-members", nodeIds: [] },
      datasets: datasets.map((dataset) => ({ ...dataset, includeLocalIds: true })),
      housePolicy: { editPolicy: "read-only", recoveryMode: "none", designatedSuccessorNodeId: null },
      expiresAt: null,
    }).expect(200);
    expect(updated.body).toMatchObject({ epoch: 3, revision: 3 });
    expect(store.dueOutbox(250)
      .filter((item) => item.event.streamId === `grant:${grantId}`)
      .map((item) => item.event.sequence)).toEqual([2, 3]);
    store.acknowledgeOutbox(store.dueOutbox(250).map((item) => item.id));

    const revokeFault = vi.spyOn(store, "enqueueOutbox").mockImplementation((...args) => {
      originalEnqueue(...args);
      throw new Error("simulated revocation enqueue failure");
    });
    await request(participant.runtime.app).delete(`/api/v1/stugbys/${stugubyId}/grants/${grantId}`).expect(500);
    revokeFault.mockRestore();
    expect(store.getGrant(grantId)).toMatchObject({ epoch: 3, revision: 3, revokedAt: null });
    expect(store.dueOutbox(250)).toEqual([]);
    expect(store.listAudit(stugubyId).some((event) => event.eventType === "grant.revoked")).toBe(false);

    const mainHouse = participant.runtime.database.getHouse("house-main")!;
    participant.runtime.database.createHouse({
      id: "house-expiring-grant",
      propertyId: mainHouse.propertyId,
      name: "Expiring grant Home",
      timezone: mainHouse.timezone,
      floors: [{
        id: "floor-expiring-grant",
        name: "Ground",
        width: 8,
        height: 6,
        elevation: 0,
        walls: [],
        rooms: [],
      }],
    });
    const expiresAt = new Date(Date.now() + 250).toISOString();
    const expiring = await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-expiring-grant",
      audience: { kind: "all-members", nodeIds: [] },
      datasets,
      expiresAt,
    }).expect(201);
    store.acknowledgeOutbox(store.dueOutbox(250).map((item) => item.id));
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, Date.parse(expiresAt) - Date.now() + 25)));
    const expiryFault = vi.spyOn(store, "enqueueOutbox").mockImplementation((...args) => {
      originalEnqueue(...args);
      throw new Error("simulated expiry enqueue failure");
    });
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(500);
    expiryFault.mockRestore();
    expect(store.getGrant(expiring.body.id)).toMatchObject({ epoch: 1, revision: 1, revokedAt: null });
    expect(store.dueOutbox(250)).toEqual([]);
    expect(store.listAudit(stugubyId)
      .some((event) => event.eventType === "grant.expired" && event.subjectId === expiring.body.id)).toBe(false);
  });

  it("rolls back property revisions and member state until every required event and activation snapshot is durable", async () => {
    const coordinator = await node("Atomic membership coordinator");
    const participant = await node("Atomic membership participant");
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "Atomic membership" }).expect(201);
    const stugubyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/invitations`)
      .send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);

    const store = coordinator.runtime.stuguby.store;
    const nodeId = participant.runtime.stuguby.identity.nodeId;
    const originalAppend = store.appendEventForMember.bind(store);
    const propertyBefore = store.getSharedProperty(stugubyId)!;
    const eventIdsBeforeProperty = store.eventPage(stugubyId, nodeId, 0, 250).events.map((event) => event.eventId);
    const propertyFault = vi.spyOn(store, "appendEventForMember").mockImplementation((...args) => {
      originalAppend(...args);
      throw new Error("simulated property event failure");
    });
    const propertyInput = {
      baseRevision: propertyBefore.revision,
      property: {
        name: "Atomic shared grounds",
        description: null,
        location: null,
        areas: [],
        equipment: [],
        notes: [],
        maintenance: [],
      },
    };
    await request(coordinator.runtime.app).put(`/api/v1/stugbys/${stugubyId}/property`).send(propertyInput).expect(500);
    propertyFault.mockRestore();
    expect(store.getSharedProperty(stugubyId)).toEqual(propertyBefore);
    expect(store.eventPage(stugubyId, nodeId, 0, 250).events.map((event) => event.eventId)).toEqual(eventIdsBeforeProperty);
    expect(store.listAudit(stugubyId).some((event) => event.eventType === "shared-property.updated")).toBe(false);
    await request(coordinator.runtime.app).put(`/api/v1/stugbys/${stugubyId}/property`).send(propertyInput).expect(200);
    expect(store.getSharedProperty(stugubyId)).toMatchObject({ name: "Atomic shared grounds", revision: 2 });

    const eventsBeforeSuspension = store.eventPage(stugubyId, nodeId, 0, 250).events.map((event) => event.eventId);
    const memberFault = vi.spyOn(store, "appendEventForMember").mockImplementation((...args) => {
      originalAppend(...args);
      throw new Error("simulated final member event failure");
    });
    await request(coordinator.runtime.app).patch(`/api/v1/stugbys/${stugubyId}/members/${nodeId}`)
      .send({ role: "participant", state: "suspended" }).expect(500);
    memberFault.mockRestore();
    expect(store.getMember(stugubyId, nodeId)?.state).toBe("active");
    expect(store.eventPage(stugubyId, nodeId, 0, 250).events.map((event) => event.eventId)).toEqual(eventsBeforeSuspension);
    expect(store.listAudit(stugubyId).filter((event) => event.eventType === "member.updated")).toHaveLength(0);
    await request(coordinator.runtime.app).patch(`/api/v1/stugbys/${stugubyId}/members/${nodeId}`)
      .send({ role: "participant", state: "suspended" }).expect(200);

    await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [{ dataset: "home.directory.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 }],
    }).expect(201);
    const eventsBeforeActivation = store.eventPage(stugubyId, nodeId, 0, 250).events.map((event) => event.eventId);
    const memberAuditBeforeActivation = store.listAudit(stugubyId)
      .filter((event) => event.eventType === "member.updated").length;
    let activationAppends = 0;
    const activationFault = vi.spyOn(store, "appendEventForMember").mockImplementation((...args) => {
      originalAppend(...args);
      activationAppends += 1;
      if (activationAppends === 4) throw new Error("simulated activation snapshot failure");
    });
    await request(coordinator.runtime.app).patch(`/api/v1/stugbys/${stugubyId}/members/${nodeId}`)
      .send({ role: "participant", state: "active" }).expect(500);
    activationFault.mockRestore();
    expect(store.getMember(stugubyId, nodeId)?.state).toBe("suspended");
    expect(store.eventPage(stugubyId, nodeId, 0, 250).events.map((event) => event.eventId)).toEqual(eventsBeforeActivation);
    expect(store.listAudit(stugubyId).filter((event) => event.eventType === "member.updated"))
      .toHaveLength(memberAuditBeforeActivation);
    await request(coordinator.runtime.app).patch(`/api/v1/stugbys/${stugubyId}/members/${nodeId}`)
      .send({ role: "participant", state: "active" }).expect(200);
    expect(store.getMember(stugubyId, nodeId)?.state).toBe("active");
  });

  it("replaces an existing signed notification stream for the same member", async () => {
    const coordinator = await node("Stream coordinator");
    nodes.push(coordinator);
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const releaseFirst = coordinator.runtime.stuguby.replaceNotificationStream("stuguby-1", "node-1", firstClose);
    const releaseSecond = coordinator.runtime.stuguby.replaceNotificationStream("stuguby-1", "node-1", secondClose);

    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).not.toHaveBeenCalled();
    releaseFirst();
    const thirdClose = vi.fn();
    const releaseThird = coordinator.runtime.stuguby.replaceNotificationStream("stuguby-1", "node-1", thirdClose);
    expect(secondClose).toHaveBeenCalledOnce();
    releaseSecond();
    await coordinator.runtime.stuguby.stop();
    expect(thirdClose).toHaveBeenCalledOnce();
    releaseThird();
  });

  it("caps historical telemetry independently in each UTC hour across all selected metrics", async () => {
    const coordinator = await node("History cap coordinator");
    const participant = await node("History cap publisher");
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "History caps" }).expect(201);
    const stugubyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/invitations`)
      .send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);

    participant.runtime.database.db.prepare("DELETE FROM measurement_samples").run();
    const currentHour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const denseHour = currentHour - 2 * 3_600_000;
    const sparseHour = currentHour - 3_600_000;
    const samples: MeasurementSample[] = [];
    for (let index = 0; index < 6; index += 1) {
      for (const [metric, canonicalUnit] of [["temperature", "°C"], ["humidity", "%"]] as const) {
        samples.push({
          sensorId: "sensor-01",
          metric,
          value: index,
          canonicalUnit,
          timestamp: new Date(denseHour + index * 60_000).toISOString(),
          source: "api",
          quality: "good",
        });
      }
    }
    for (const [index, [metric, canonicalUnit]] of ([["temperature", "°C"], ["humidity", "%"]] as const).entries()) {
      samples.push({
        sensorId: "sensor-01",
        metric,
        value: 100 + index,
        canonicalUnit,
        timestamp: new Date(sparseHour + index * 60_000).toISOString(),
        source: "api",
        quality: "good",
      });
    }
    for (let index = 0; index < 5; index += 1) {
      samples.push({
        sensorId: "sensor-01",
        metric: "temperature",
        value: 200 + index,
        canonicalUnit: "°C",
        timestamp: new Date(currentHour + index * 60_000).toISOString(),
        source: "api",
        quality: "good",
      });
    }
    participant.runtime.database.insertMeasurementSamples(samples);

    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [{
        dataset: "home.telemetry.v1",
        enabled: true,
        includeLocalIds: false,
        allowReplicaCache: true,
        retentionDays: 7,
        telemetry: {
          sensorPublicationIds: [],
          metricIds: ["temperature", "humidity"],
          historyFrom: new Date(denseHour).toISOString(),
          live: true,
          maxSamplesPerHour: 3,
        },
      }],
    }).expect(201);
    const published = participant.runtime.stuguby.store.dueOutbox(250)
      .filter((item) => item.event.schema === "home.telemetry.v1")
      .flatMap((item) => (item.event.payload as unknown as { samples: Array<{ timestamp: string }> }).samples);
    const counts = new Map<string, number>();
    for (const sample of published) {
      const hour = new Date(sample.timestamp).toISOString().slice(0, 13);
      counts.set(hour, (counts.get(hour) ?? 0) + 1);
    }
    expect(counts.get(new Date(denseHour).toISOString().slice(0, 13))).toBe(3);
    expect(counts.get(new Date(sparseHour).toISOString().slice(0, 13))).toBe(2);
    expect(counts.has(new Date(currentHour).toISOString().slice(0, 13))).toBe(false);
    expect([...counts.values()].every((count) => count <= 3)).toBe(true);
  });

  it("keeps the live per-grant UTC-hour cap after recreating the service", async () => {
    const coordinator = await node("Live cap coordinator");
    const participant = await node("Live cap publisher");
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "Live caps" }).expect(201);
    const stugubyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/invitations`)
      .send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);
    const grant = await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [{
        dataset: "home.telemetry.v1",
        enabled: true,
        includeLocalIds: false,
        allowReplicaCache: true,
        retentionDays: 7,
        telemetry: {
          sensorPublicationIds: [],
          metricIds: ["temperature"],
          historyFrom: null,
          live: true,
          maxSamplesPerHour: 2,
        },
      }],
    }).expect(201);
    const originalStore = participant.runtime.stuguby.store;
    originalStore.acknowledgeOutbox(originalStore.dueOutbox(250).map((item) => item.id));
    const previousHour = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;
    const liveSample = (offset: number): MeasurementSample => ({
      sensorId: "sensor-01",
      metric: "temperature",
      value: offset,
      canonicalUnit: "°C",
      timestamp: new Date(previousHour + offset * 60_000).toISOString(),
      source: "api",
      quality: "good",
    });
    const publishLive = (service: StugubyService, sample: MeasurementSample): void => {
      (service as unknown as { publishLiveTelemetry(value: MeasurementSample): void }).publishLiveTelemetry(sample);
    };
    publishLive(participant.runtime.stuguby, liveSample(1));
    publishLive(participant.runtime.stuguby, liveSample(2));

    const restartedStore = new StugubyStore(participant.runtime.database.db, participant.runtime.stuguby.identity.nodeId);
    const restarted = new StugubyService({
      database: participant.runtime.database,
      store: restartedStore,
      keys: participant.runtime.stuguby.keys,
      bus: participant.runtime.bus,
      assetDirectory: participant.directory,
      syncIntervalMs: 300_000,
    });
    publishLive(restarted, liveSample(3));
    publishLive(restarted, {
      ...liveSample(4),
      timestamp: new Date(previousHour + 3_600_000 + 60_000).toISOString(),
    });

    const events = restartedStore.dueOutbox(250)
      .filter((item) => item.event.schema === "home.telemetry.v1" && item.event.grantId === grant.body.id);
    expect(events).toHaveLength(3);
    const counts = new Map<string, number>();
    for (const item of events) {
      const payload = item.event.payload as unknown as { samples: Array<{ timestamp: string }> };
      const hour = new Date(payload.samples[0]!.timestamp).toISOString().slice(0, 13);
      counts.set(hour, (counts.get(hour) ?? 0) + 1);
    }
    expect(counts.get(new Date(previousHour).toISOString().slice(0, 13))).toBe(2);
    expect(counts.get(new Date(previousHour + 3_600_000).toISOString().slice(0, 13))).toBe(1);
  });

  it("joins independent nodes, shares only granted datasets, syncs common property, and purges on revoke", async () => {
    const coordinator = await node("Common property coordinator");
    const household = await node("Household A");
    const unsharedHousehold = await node("Household B");
    nodes.push(coordinator, household, unsharedHousehold);

    const created = await request(coordinator.url).post("/api/v1/stugbys").send({
      name: "Lake Stuguby",
      description: "Three independently managed households",
    }).expect(201);
    const stugubyId = created.body.id as string;

    const inviteA = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/invitations`)
      .send({ role: "participant" }).expect(201);
    const inviteB = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/invitations`)
      .send({ role: "viewer" }).expect(201);

    await request(household.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: inviteA.body.id,
      joinSecret: inviteA.body.joinSecret,
    }).expect(201);
    const duplicateInvite = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/invitations`)
      .send({ role: "participant" }).expect(201);
    const duplicateJoin = await request(household.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: duplicateInvite.body.id,
      joinSecret: duplicateInvite.body.joinSecret,
    }).expect(409);
    expect(duplicateJoin.body.error.code).toBe("NODE_ALREADY_MEMBER");
    await request(unsharedHousehold.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: inviteB.body.id,
      joinSecret: inviteB.body.joinSecret,
    }).expect(201);

    const viewerGrant = await request(unsharedHousehold.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [{ dataset: "home.directory.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 }],
    }).expect(403);
    expect(viewerGrant.body.error.code).toBe("PUBLISHING_FORBIDDEN");
    const viewerProperty = await request(unsharedHousehold.runtime.app).put(`/api/v1/stugbys/${stugubyId}/property`).send({
      baseRevision: 1,
      property: { name: "Unauthorized", description: null, location: null, areas: [], equipment: [], notes: [], maintenance: [] },
    }).expect(403);
    expect(viewerProperty.body.error.code).toBe("PROPERTY_WRITE_FORBIDDEN");

    const house = household.runtime.database.getHouse("house-main")!;
    household.runtime.database.createHouse({
      id: "house-annex",
      propertyId: house.propertyId,
      name: "Household A annex",
      timezone: house.timezone,
      floors: [{ id: "annex-floor", name: "Ground", width: 8, height: 6, elevation: 0, walls: [], rooms: [] }],
    });
    household.runtime.database.updateHouse(house.id, {
      location: { latitude: 60.1699, longitude: 24.9384, label: "Shared shore" },
      floors: house.floors.map((floor, index) => index === 0 ? {
        ...floor,
        backgroundImage: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X2NDNwAAAABJRU5ErkJggg==",
      } : floor),
    });
    const publicationCatalog = await request(household.runtime.app)
      .get(`/api/v1/stugbys/${stugubyId}/publications/house-main`).expect(200);
    expect(publicationCatalog.body.house).toMatchObject({ localHouseId: "house-main", name: house.name });
    expect(publicationCatalog.body.sensors.length).toBeGreaterThan(0);
    expect(JSON.stringify(publicationCatalog.body)).not.toMatch(/provider|connection|entity|credential/i);

    const datasets: StugubyDatasetGrant[] = [
      { dataset: "home.directory.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 },
      { dataset: "home.location.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 },
      { dataset: "home.structure.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 },
      { dataset: "home.floorplan.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 },
      { dataset: "home.sensor-catalog.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 },
      { dataset: "home.notes.v1", enabled: true, includeLocalIds: false, allowReplicaCache: false, retentionDays: 0 },
      {
        dataset: "home.telemetry.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 7,
        telemetry: {
          sensorPublicationIds: [], metricIds: ["temperature"],
          historyFrom: new Date(Date.now() - 2 * 3_600_000).toISOString(), live: true, maxSamplesPerHour: 5_000,
        },
      },
    ];
    const grantResponse = await request(household.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "members", nodeIds: [coordinator.runtime.stuguby!.identity.nodeId] },
      datasets,
    }).expect(201);
    const annexGrant = await request(household.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-annex",
      audience: { kind: "members", nodeIds: [coordinator.runtime.stuguby!.identity.nodeId] },
      datasets: [{ dataset: "home.directory.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 }],
    }).expect(201);

    await request(household.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);

    const coordinatorDetail = await request(coordinator.runtime.app).get(`/api/v1/stugbys/${stugubyId}`).expect(200);
    const schemas = coordinatorDetail.body.remoteResources.map((resource: { schema: string }) => resource.schema);
    expect(schemas).toEqual(expect.arrayContaining([
      "home.directory.v1", "home.location.v1", "home.structure.v1", "home.floorplan.v1", "home.sensor-catalog.v1",
    ]));
    expect(schemas).not.toContain("home.notes.v1");
    expect(schemas).not.toContain("home.telemetry.v1");
    const serialized = JSON.stringify(coordinatorDetail.body.remoteResources);
    expect(serialized).not.toMatch(/stateBinding|connectionId|entityId|credentials|password|remoteControl|command/i);
    expect(serialized).not.toMatch(/localHouseId|localFloorId|localSensorId/);
    expect(coordinatorDetail.body.remoteResources.find((resource: { schema: string }) => resource.schema === "home.location.v1").payload)
      .toMatchObject({ latitude: 60.1699, longitude: 24.9384 });
    expect(coordinator.runtime.stuguby!.store.remoteTelemetry({ stugubyId }).length).toBeGreaterThan(0);
    const floorPlanDigest = (coordinatorDetail.body.remoteResources
      .find((resource: { schema: string }) => resource.schema === "home.floorplan.v1")
      .payload.assets[0].image.digest) as string;
    expect(coordinator.runtime.stuguby!.store.getBlob(floorPlanDigest)).not.toBeNull();
    const directories = coordinator.runtime.stuguby!.store.listRemoteResources(stugubyId)
      .filter((resource) => resource.schema === "home.directory.v1");
    expect(directories).toHaveLength(2);
    expect(new Set(directories.map((resource) => resource.publicationId)).size).toBe(2);

    const updatedDatasets = datasets.map((dataset) => dataset.dataset === "home.directory.v1"
      ? { ...dataset, includeLocalIds: true }
      : dataset);
    const updatedGrant = await request(household.runtime.app).put(`/api/v1/stugbys/${stugubyId}/grants/${grantResponse.body.id}`).send({
      baseRevision: grantResponse.body.revision,
      audience: { kind: "members", nodeIds: [coordinator.runtime.stuguby!.identity.nodeId] },
      datasets: updatedDatasets,
      housePolicy: { editPolicy: "read-only", recoveryMode: "none", designatedSuccessorNodeId: null },
      expiresAt: null,
    }).expect(200);
    expect(updatedGrant.body).toMatchObject({ epoch: 3, revision: 3 });
    await request(household.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    const localIdProjection = coordinator.runtime.stuguby!.store.listRemoteResources(stugubyId)
      .find((resource) => resource.schema === "home.directory.v1" && resource.publicationId === grantResponse.body.publicationId);
    expect(localIdProjection?.payload).toMatchObject({ localHouseId: "house-main" });
    expect(coordinator.runtime.stuguby!.store.getGrant(grantResponse.body.id)?.localHouseId).toBeUndefined();

    await request(unsharedHousehold.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    const unsharedBefore = await request(unsharedHousehold.runtime.app).get(`/api/v1/stugbys/${stugubyId}`).expect(200);
    expect(unsharedBefore.body.remoteResources).toEqual([]);

    const property = coordinator.runtime.stuguby!.store.getSharedProperty(stugubyId)!;
    await request(coordinator.runtime.app).put(`/api/v1/stugbys/${stugubyId}/property`).send({
      baseRevision: property.revision,
      property: {
        name: "Lake Stuguby shared grounds",
        description: "Common well and shore",
        location: { latitude: 60.17, longitude: 24.94, label: "Common parcel" },
        areas: [], equipment: [], notes: [],
        maintenance: [{
          id: "maint-1", title: "Inspect the common well", description: null, areaId: null, equipmentId: null,
          state: "planned", dueAt: null, completedAt: null,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }],
      },
    }).expect(200);
    await request(unsharedHousehold.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    const unsharedAfter = await request(unsharedHousehold.runtime.app).get(`/api/v1/stugbys/${stugubyId}`).expect(200);
    expect(unsharedAfter.body.sharedProperty.name).toBe("Lake Stuguby shared grounds");
    expect(unsharedAfter.body.sharedProperty.maintenance[0].title).toContain("common well");
    await request(coordinator.runtime.app)
      .patch(`/api/v1/stugbys/${stugubyId}/members/${unsharedHousehold.runtime.stuguby!.identity.nodeId}`)
      .send({ role: "viewer", state: "revoked" }).expect(200);
    await request(unsharedHousehold.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    const departed = await request(unsharedHousehold.runtime.app).get(`/api/v1/stugbys/${stugubyId}`).expect(200);
    expect(departed.body.stuguby.localMemberState).toBe("revoked");
    expect(departed.body.sharedProperty).toBeNull();

    await request(household.runtime.app).delete(`/api/v1/stugbys/${stugubyId}/grants/${grantResponse.body.id}`).expect(200);
    await request(household.runtime.app).delete(`/api/v1/stugbys/${stugubyId}/grants/${annexGrant.body.id}`).expect(200);
    expect(household.runtime.database.getHouse("house-main")?.stuguby).toBeUndefined();
    expect(household.runtime.database.getHouse("house-annex")?.stuguby).toBeUndefined();
    await request(household.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    expect(coordinator.runtime.stuguby!.store.listRemoteResources(stugubyId)).toEqual([]);
    expect(coordinator.runtime.stuguby!.store.remoteTelemetry({ stugubyId })).toEqual([]);
    expect(coordinator.runtime.stuguby!.store.getBlob(floorPlanDigest)).toBeNull();
    expect(existsSync(join(coordinator.directory, "stuguby", floorPlanDigest))).toBe(false);
    expect(coordinator.runtime.stuguby!.store.listDeletionReceipts(stugubyId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ grantId: grantResponse.body.id, nodeId: coordinator.runtime.stuguby!.identity.nodeId }),
    ]));
  }, 30_000);

  it("keeps every Host and Client authoritative for its Homes while sharing read-only overviews in the Host Property", async () => {
    const coordinator = await node("Adoption coordinator");
    const participant = await node("Adoption participant");
    const observer = await node("Adoption observer");
    nodes.push(coordinator, participant, observer);
    const localHome = participant.runtime.database.getHouse("house-main")!;
    const sourcePropertyId = localHome.propertyId;
    const hostPropertyId = coordinator.runtime.database.getHouse("house-main")!.propertyId;

    const created = await request(coordinator.url).post("/api/v1/stugbys")
      .send({ name: "Adoption Stuguby" }).expect(201);
    const stugubyId = created.body.id as string;
    const connected = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/property/adopt`)
      .send({ localPropertyId: hostPropertyId }).expect(201);
    expect(connected.body.localPropertyId).toBe(hostPropertyId);
    const hostOverview = coordinator.runtime.stuguby!.store.listGrants(
      stugubyId,
      coordinator.runtime.stuguby!.identity.nodeId,
    ).find((candidate) => candidate.localHouseId === "house-main");
    expect(hostOverview).toMatchObject({
      audience: { kind: "all-members", nodeIds: [] },
      housePolicy: {
        editPolicy: "read-only",
        recoveryMode: "none",
        designatedSuccessorNodeId: null,
      },
    });
    expect(hostOverview?.datasets.map((dataset) => dataset.dataset)).toEqual([
      "home.directory.v1",
      "home.structure.v1",
      "home.sensor-catalog.v1",
    ]);
    const hostSpareProperty = coordinator.runtime.database.createProperty({ name: "Host spare" });
    const blockedHostMigration = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/property/migrate`)
      .send({ sourcePropertyId: hostSpareProperty.id, confirmation: "MIGRATE" }).expect(409);
    expect(blockedHostMigration.body.error.code).toBe("HOST_PROPERTY_MIGRATION_NOT_ALLOWED");

    const legacyHostHome = coordinator.runtime.database.createHouse({
      id: "legacy-host-home",
      propertyId: hostPropertyId,
      name: "Legacy Host Home",
      timezone: "Europe/Helsinki",
      floors: [],
    });
    coordinator.runtime.database.setHouseStugubyLink(legacyHostHome.id, {
      stugubyId,
      authorityNodeId: coordinator.runtime.stuguby!.identity.nodeId,
      publicationId: coordinator.runtime.stuguby!.store.publicationId(stugubyId, "home", legacyHostHome.id),
      ownership: "local",
      editPolicy: "editable",
      syncState: "current",
      authorityEpoch: 1,
      pendingChangeCount: 0,
      conflictCount: 0,
      recoveryState: "not-enabled",
    });
    expect(coordinator.runtime.stuguby!.store.listGrants(
      stugubyId,
      coordinator.runtime.stuguby!.identity.nodeId,
    ).some((candidate) => candidate.localHouseId === legacyHostHome.id)).toBe(false);
    await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    expect(coordinator.runtime.stuguby!.store.listGrants(
      stugubyId,
      coordinator.runtime.stuguby!.identity.nodeId,
    ).some((candidate) => candidate.localHouseId === legacyHostHome.id)).toBe(true);

    const invitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/invitations`).send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);
    const observerInvitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/invitations`).send({ role: "participant" }).expect(201);
    await request(observer.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: observerInvitation.body.id,
      joinSecret: observerInvitation.body.joinSecret,
    }).expect(201);

    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    await request(observer.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    const adoptedResponse = await request(participant.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/property/adopt`).send({}).expect(201);
    await request(observer.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/property/adopt`).send({}).expect(201);
    const adoptedPropertyId = adoptedResponse.body.localPropertyId as string;
    const adoptedDetail = await request(participant.runtime.app).get(`/api/v1/stugbys/${stugubyId}`).expect(200);
    const hostProjection = adoptedDetail.body.homeProjections
      .find((candidate: { authorityNodeId: string }) => candidate.authorityNodeId === coordinator.runtime.stuguby!.identity.nodeId);
    const sharedHomeId = hostProjection.localHouseId as string;

    expect(adoptedPropertyId).not.toBe(sourcePropertyId);
    expect(participant.runtime.database.getProperty(sourcePropertyId)).not.toBeNull();
    expect(participant.runtime.database.getHouse(localHome.id)?.propertyId).toBe(sourcePropertyId);
    expect(participant.runtime.database.getHouse(sharedHomeId)).toMatchObject({
      propertyId: adoptedPropertyId,
      stuguby: { ownership: "shared", editPolicy: "read-only", syncState: "current" },
    });
    const createdOwnedHome = await request(participant.runtime.app).post("/api/v1/houses").send({
      propertyId: adoptedPropertyId,
      name: "Client-built Home",
      timezone: "Europe/Helsinki",
      floors: [{
        id: "client-built-ground",
        name: "Ground floor",
        type: "ground",
        width: 10,
        height: 8,
        elevation: 0,
        walls: [],
        rooms: [],
        planElements: [],
      }],
    }).expect(201);
    expect(createdOwnedHome.body.house.stuguby).toMatchObject({
      stugubyId,
      ownership: "local",
      syncState: "current",
    });
    expect(participant.runtime.stuguby!.store.listGrants(
      stugubyId,
      participant.runtime.stuguby!.identity.nodeId,
    ).some((candidate) => candidate.localHouseId === createdOwnedHome.body.house.id)).toBe(true);
    const blocked = await request(participant.runtime.app)
      .patch(`/api/v1/houses/${sharedHomeId}`).send({ name: "Must not change" }).expect(403);
    expect(blocked.body.error.code).toBe("HOME_READ_ONLY");
    const migrationRequired = await request(participant.runtime.app)
      .patch(`/api/v1/houses/${localHome.id}`).send({ propertyId: adoptedPropertyId }).expect(409);
    expect(migrationRequired.body.error.code).toBe("STUGBY_PROPERTY_MIGRATION_REQUIRED");

    const firstPropertyEdit = await request(participant.runtime.app).patch(`/api/v1/properties/${adoptedPropertyId}`)
      .send({ description: "First queued description" });
    expect(firstPropertyEdit.status, JSON.stringify(firstPropertyEdit.body)).toBe(200);
    const finalPropertyEdit = await request(participant.runtime.app).patch(`/api/v1/properties/${adoptedPropertyId}`)
      .send({ description: "Final queued description" });
    expect(finalPropertyEdit.status, JSON.stringify(finalPropertyEdit.body)).toBe(200);
    expect(participant.runtime.stuguby.store.propertyCommandCounts(stugubyId)).toEqual({
      pending: 1,
      conflicts: 0,
    });
    const queuedPropertySync = await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`);
    expect(queuedPropertySync.status, JSON.stringify(queuedPropertySync.body)).toBe(200);
    expect(coordinator.runtime.stuguby.store.getSharedProperty(stugubyId)?.description).toBe("Final queued description");
    expect(participant.runtime.stuguby.store.propertyCommandCounts(stugubyId)).toEqual({
      pending: 0,
      conflicts: 0,
    });

    const migrated = await request(participant.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/property/migrate`)
      .send({ sourcePropertyId, confirmation: "MIGRATE" }).expect(200);
    expect(migrated.body.moved.houseIds).toEqual([localHome.id]);
    expect(migrated.body.createdGrants).toHaveLength(1);
    expect(migrated.body.createdGrants[0]).toMatchObject({
      localHouseId: localHome.id,
      audience: { kind: "all-members", nodeIds: [] },
      housePolicy: { editPolicy: "read-only" },
    });
    expect(participant.runtime.database.getProperty(sourcePropertyId)).toBeNull();
    expect(participant.runtime.database.getHouse(localHome.id)).toMatchObject({
      propertyId: adoptedPropertyId,
      stuguby: { ownership: "local" },
    });
    await request(participant.runtime.app)
      .patch(`/api/v1/houses/${localHome.id}`).send({ name: "Client-owned Home" }).expect(200);
    expect(participant.runtime.database.getHouse(localHome.id)).toMatchObject({
      name: "Client-owned Home",
      stuguby: { ownership: "local", editPolicy: "editable" },
    });

    const propertySync = await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`);
    expect(propertySync.status, JSON.stringify(propertySync.body)).toBe(200);
    const hostAfterClientShare = await request(coordinator.runtime.app)
      .get(`/api/v1/stugbys/${stugubyId}`).expect(200);
    const clientHomesOnHost = hostAfterClientShare.body.homeProjections
      .filter((candidate: { authorityNodeId: string }) => candidate.authorityNodeId === participant.runtime.stuguby!.identity.nodeId)
      .map((candidate: { localHouseId: string }) => coordinator.runtime.database.getHouse(candidate.localHouseId));
    expect(clientHomesOnHost).toEqual(expect.arrayContaining([
      expect.objectContaining({
        propertyId: hostPropertyId,
        name: "Client-owned Home",
        stuguby: expect.objectContaining({ ownership: "shared", editPolicy: "read-only" }),
      }),
      expect.objectContaining({
        propertyId: hostPropertyId,
        name: "Client-built Home",
        stuguby: expect.objectContaining({ ownership: "shared", editPolicy: "read-only" }),
      }),
    ]));

    await request(observer.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    const observerDetail = await request(observer.runtime.app).get(`/api/v1/stugbys/${stugubyId}`).expect(200);
    const clientHomesOnObserver = observerDetail.body.homeProjections
      .filter((candidate: { authorityNodeId: string }) => candidate.authorityNodeId === participant.runtime.stuguby!.identity.nodeId)
      .map((candidate: { localHouseId: string }) => observer.runtime.database.getHouse(candidate.localHouseId));
    expect(clientHomesOnObserver).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "Client-owned Home",
        stuguby: expect.objectContaining({ ownership: "shared", editPolicy: "read-only" }),
      }),
      expect.objectContaining({
        name: "Client-built Home",
        stuguby: expect.objectContaining({ ownership: "shared", editPolicy: "read-only" }),
      }),
    ]));

    await request(participant.runtime.app)
      .delete(`/api/v1/stugbys/${stugubyId}/grants/${migrated.body.createdGrants[0].id}`).expect(200);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    const movedHomeGrantHistory = participant.runtime.stuguby!.store.listGrants(
      stugubyId,
      participant.runtime.stuguby!.identity.nodeId,
    ).filter((candidate) => candidate.localHouseId === localHome.id);
    expect(movedHomeGrantHistory).toHaveLength(1);
    expect(movedHomeGrantHistory[0]?.revokedAt).not.toBeNull();
    expect(participant.runtime.database.getHouse(localHome.id)?.stuguby).toMatchObject({
      ownership: "local",
    });

    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/property/disconnect`)
      .send({ confirmation: "DISCONNECT" }).expect(200);
    expect(participant.runtime.database.getHouse(sharedHomeId)).toBeNull();
    expect(participant.runtime.database.getHouse(localHome.id)).toMatchObject({
      propertyId: adoptedPropertyId,
    });
    expect(participant.runtime.database.getHouse(localHome.id)?.stuguby).toBeUndefined();
    expect(participant.runtime.database.getHouse(createdOwnedHome.body.house.id)?.stuguby).toBeUndefined();
    expect(participant.runtime.database.getProperty(adoptedPropertyId)?.stuguby).toMatchObject({
      syncState: "detached",
    });
    expect(participant.runtime.stuguby!.store.listGrants(
      stugubyId,
      participant.runtime.stuguby!.identity.nodeId,
    ).every((candidate) => candidate.revokedAt !== null)).toBe(true);
  }, 30_000);

  it("keeps shared Property entities on one local record across create, edit, and delete", async () => {
    const coordinator = await node("Equipment coordinator");
    const participant = await node("Equipment participant");
    nodes.push(coordinator, participant);
    const hostPropertyId = coordinator.runtime.database.getHouse("house-main")!.propertyId;
    const created = await request(coordinator.url).post("/api/v1/stugbys")
      .send({ name: "Equipment Stuguby" }).expect(201);
    const stugubyId = created.body.id as string;
    await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/property/adopt`)
      .send({ localPropertyId: hostPropertyId }).expect(201);

    const createdArea = await request(coordinator.runtime.app).post("/api/v1/property-areas").send({
      propertyId: hostPropertyId,
      name: "Machine yard",
      kind: "yard",
      polygon: [
        { latitude: 60, longitude: 24 },
        { latitude: 60.001, longitude: 24 },
        { latitude: 60, longitude: 24.001 },
      ],
    }).expect(201);
    const hostArea = createdArea.body.area;
    expect(coordinator.runtime.database.listPropertyAreas(hostPropertyId)
      .filter((item) => item.name === "Machine yard")).toEqual([
      expect.objectContaining({ id: hostArea.id }),
    ]);
    const createdEquipment = await request(coordinator.runtime.app).post("/api/v1/area-equipment").send({
      propertyId: hostPropertyId,
      areaId: hostArea.id,
      name: "Host tractor",
      kind: "vehicle",
    }).expect(201);
    const createdHomeEquipment = await request(coordinator.runtime.app).post("/api/v1/area-equipment").send({
      propertyId: hostPropertyId,
      houseId: "house-main",
      location: { latitude: 60.171, longitude: 24.931 },
      name: "Home generator",
      kind: "generator",
    }).expect(201);
    const createdPortableEquipment = await request(coordinator.runtime.app).post("/api/v1/area-equipment").send({
      propertyId: hostPropertyId,
      name: "Portable saw",
      kind: "tool",
    }).expect(201);
    expect(coordinator.runtime.database.listAreaEquipment({ propertyId: hostPropertyId })
      .filter((item) => item.name === "Host tractor")).toEqual([
      expect.objectContaining({ id: createdEquipment.body.equipment.id, areaId: hostArea.id }),
    ]);
    const createdNote = await request(coordinator.runtime.app).post("/api/v1/property-notes").send({
      propertyId: hostPropertyId,
      equipmentId: createdEquipment.body.equipment.id,
      kind: "inspection",
      text: "Check the hydraulic lines.",
    }).expect(201);
    expect(coordinator.runtime.database.listPropertyNotes({ propertyId: hostPropertyId })
      .filter((item) => item.text === "Check the hydraulic lines.")).toEqual([
      expect.objectContaining({
        id: createdNote.body.note.id,
        equipmentId: createdEquipment.body.equipment.id,
      }),
    ]);
    const createdTask = await request(coordinator.runtime.app).post("/api/v1/maintenance-tasks").send({
      propertyId: hostPropertyId,
      areaId: hostArea.id,
      equipmentId: createdEquipment.body.equipment.id,
      title: "Service the tractor",
      basis: "scheduled",
    }).expect(201);
    expect(coordinator.runtime.database.listMaintenanceTasks({ propertyId: hostPropertyId })
      .filter((item) => item.title === "Service the tractor")).toEqual([
      expect.objectContaining({
        id: createdTask.body.id,
        areaId: hostArea.id,
        equipmentId: createdEquipment.body.equipment.id,
      }),
    ]);

    const invitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/invitations`)
      .send({ role: "property-manager" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    const adoption = await request(participant.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/property/adopt`).send({}).expect(201);
    const participantPropertyId = adoption.body.localPropertyId as string;
    const projectedEquipment = participant.runtime.database.listAreaEquipment({
      propertyId: participantPropertyId,
    }).find((item) => item.name === "Host tractor")!;
    const projectedHomeEquipment = participant.runtime.database.listAreaEquipment({
      propertyId: participantPropertyId,
    }).find((item) => item.name === "Home generator")!;
    const projectedPortableEquipment = participant.runtime.database.listAreaEquipment({
      propertyId: participantPropertyId,
    }).find((item) => item.name === "Portable saw")!;
    const projectedHome = participant.runtime.database.listHouses(participantPropertyId)
      .find((house) => house.stuguby?.publicationId);
    expect(projectedHome).toBeDefined();
    expect(projectedHomeEquipment).toMatchObject({
      id: projectedHomeEquipment.id,
      houseId: projectedHome!.id,
      location: { latitude: 60.171, longitude: 24.931 },
    });
    expect(participant.runtime.database.listAreaEquipment({ propertyId: participantPropertyId })
      .filter((item) => item.name === "Home generator")).toHaveLength(1);

    await request(participant.runtime.app)
      .patch(`/api/v1/area-equipment/${projectedEquipment.id}`)
      .send({ name: "Member-updated tractor" }).expect(200);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    await request(participant.runtime.app)
      .patch(`/api/v1/area-equipment/${projectedPortableEquipment.id}`)
      .send({ houseId: projectedHome!.id }).expect(200);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);

    expect(coordinator.runtime.database.listAreaEquipment({ propertyId: hostPropertyId })
      .filter((item) => item.name.includes("tractor"))).toEqual([
      expect.objectContaining({ name: "Member-updated tractor", areaId: hostArea.id }),
    ]);
    expect(participant.runtime.database.listAreaEquipment({ propertyId: participantPropertyId })
      .filter((item) => item.name.includes("tractor"))).toEqual([
      expect.objectContaining({
        id: projectedEquipment.id,
        name: "Member-updated tractor",
        areaId: projectedEquipment.areaId,
      }),
    ]);
    expect(coordinator.runtime.database.listAreaEquipment({ propertyId: hostPropertyId })
      .filter((item) => item.name === "Portable saw")).toEqual([
      expect.objectContaining({ id: createdPortableEquipment.body.equipment.id, areaId: null, houseId: "house-main" }),
    ]);
    expect(participant.runtime.database.listAreaEquipment({ propertyId: participantPropertyId })
      .filter((item) => item.name === "Portable saw")).toEqual([
      expect.objectContaining({
        id: projectedPortableEquipment.id,
        areaId: null,
        houseId: projectedHome!.id,
      }),
    ]);

    await request(coordinator.runtime.app)
      .delete(`/api/v1/property-notes/${createdNote.body.note.id}`).expect(204);
    await request(coordinator.runtime.app)
      .delete(`/api/v1/maintenance-tasks/${createdTask.body.id}`).expect(204);
    await request(coordinator.runtime.app)
      .delete(`/api/v1/area-equipment/${createdHomeEquipment.body.equipment.id}`).expect(204);
    await request(coordinator.runtime.app)
      .delete(`/api/v1/area-equipment/${createdPortableEquipment.body.equipment.id}`).expect(204);
    await request(coordinator.runtime.app)
      .delete(`/api/v1/area-equipment/${createdEquipment.body.equipment.id}`).expect(204);
    await request(coordinator.runtime.app)
      .delete(`/api/v1/property-areas/${hostArea.id}`).expect(204);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    expect(coordinator.runtime.database.listPropertyAreas(hostPropertyId)
      .filter((item) => item.name === "Machine yard")).toEqual([]);
    expect(coordinator.runtime.database.listAreaEquipment({ propertyId: hostPropertyId })
      .filter((item) => item.name.includes("tractor"))).toEqual([]);
    expect(participant.runtime.database.listPropertyAreas(participantPropertyId)
      .filter((item) => item.name === "Machine yard")).toEqual([]);
    expect(participant.runtime.database.listAreaEquipment({ propertyId: participantPropertyId })
      .filter((item) => item.name.includes("tractor"))).toEqual([]);
    expect(participant.runtime.database.listAreaEquipment({ propertyId: participantPropertyId })
      .filter((item) => item.name === "Home generator")).toEqual([]);
    expect(participant.runtime.database.listAreaEquipment({ propertyId: participantPropertyId })
      .filter((item) => item.name === "Portable saw")).toEqual([]);
  }, 30_000);

  it("queues editable Home changes offline and reports a Server-wins conflict without detaching", async () => {
    let coordinatorOnline = true;
    const participantFetch: typeof fetch = async (input, init) => {
      if (!coordinatorOnline) throw new Error("simulated coordinator outage");
      return fetch(input, init);
    };
    const coordinator = await node("Editable Home coordinator");
    const participant = await node("Editable Home participant", false, participantFetch);
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys")
      .send({ name: "Editable Homes" }).expect(201);
    const stugubyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/invitations`).send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);
    await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "members", nodeIds: [participant.runtime.stuguby.identity.nodeId] },
      datasets: editableHomeDatasets(),
      housePolicy: { editPolicy: "editable", recoveryMode: "none", designatedSuccessorNodeId: null },
    }).expect(201);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/property/adopt`).send({}).expect(201);
    const detail = await request(participant.runtime.app).get(`/api/v1/stugbys/${stugubyId}`).expect(200);
    const sharedHomeId = detail.body.homeProjections[0].localHouseId as string;
    const localPropertyId = participant.runtime.database.listProperties()
      .find((property) => property.id !== participant.runtime.database.getHouse(sharedHomeId)?.propertyId)!.id;
    const blockedMove = await request(participant.runtime.app).patch(`/api/v1/houses/${sharedHomeId}`)
      .send({ propertyId: localPropertyId }).expect(409);
    expect(blockedMove.body.error.code).toBe("STUGBY_HOME_PROPERTY_MANAGED");
    const sharedSensorId = participant.runtime.database.listSensors(sharedHomeId)[0]!.id;
    const localHouseId = participant.runtime.database.listHouses()
      .find((candidate) => candidate.id !== sharedHomeId)!.id;
    const blockedSensorMove = await request(participant.runtime.app).patch(`/api/v1/sensors/${sharedSensorId}`)
      .send({ houseId: localHouseId }).expect(409);
    expect(blockedSensorMove.body.error.code).toBe("STUGBY_SENSOR_HOME_MANAGED");
    const sharedFloors = participant.runtime.database.getHouse(sharedHomeId)!.floors;
    const blockedFloorPlanAsset = await request(participant.runtime.app)
      .put(`/api/v1/houses/${sharedHomeId}/layout`)
      .send({ floors: sharedFloors.map((floor, index) => index === 0
        ? { ...floor, backgroundImage: "data:image/png;base64,iVBORw0KGgo=" }
        : floor) })
      .expect(403);
    expect(blockedFloorPlanAsset.body.error.code).toBe("HOME_FLOORPLAN_ASSET_LOCAL_AUTHORITY");

    coordinatorOnline = false;
    await request(participant.runtime.app).patch(`/api/v1/houses/${sharedHomeId}`)
      .send({ name: "Queued client name" }).expect(200);
    await request(participant.runtime.app).patch(`/api/v1/sensors/${sharedSensorId}`)
      .send({ name: "Queued client sensor", model: "Shared sensor model", tags: ["client-updated"] })
      .expect(200);
    expect(participant.runtime.database.getHouse(sharedHomeId)?.stuguby).toMatchObject({
      syncState: "pending",
      pendingChangeCount: 1,
    });
    const failedSync = await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`);
    expect(failedSync.status).toBeGreaterThanOrEqual(500);
    expect(participant.runtime.stuguby.store.getPropertyAdoption(stugubyId)?.state).toBe("adopted");
    expect(participant.runtime.database.getHouse(sharedHomeId)?.stuguby).toMatchObject({
      ownership: "shared",
      syncState: "offline",
      pendingChangeCount: 1,
    });

    coordinatorOnline = true;
    participant.runtime.database.db.prepare(
      "UPDATE stugby_home_commands SET next_attempt_at=? WHERE stugby_id=? AND status='pending'",
    ).run("2000-01-01T00:00:00.000Z", stugubyId);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    expect(coordinator.runtime.database.getHouse("house-main")?.name).toBe("Queued client name");
    expect(coordinator.runtime.database.listSensors("house-main")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "Queued client sensor",
        model: "Shared sensor model",
        tags: ["client-updated"],
      }),
    ]));
    expect(participant.runtime.database.getHouse(sharedHomeId)?.stuguby).toMatchObject({
      syncState: "current",
      pendingChangeCount: 0,
    });

    await request(participant.runtime.app).patch(`/api/v1/houses/${sharedHomeId}`)
      .send({ name: "Client overlap" }).expect(200);
    await request(coordinator.runtime.app).patch("/api/v1/houses/house-main")
      .send({ name: "Server wins" }).expect(200);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    const conflicted = await request(participant.runtime.app).get(`/api/v1/stugbys/${stugubyId}`).expect(200);
    expect(conflicted.body.homeCommandCounts).toEqual({ pending: 0, conflicts: 1 });
    expect(coordinator.runtime.database.getHouse("house-main")?.name).toBe("Server wins");
    expect(participant.runtime.database.getHouse(sharedHomeId)).toMatchObject({
      name: "Server wins",
      stuguby: { ownership: "shared", syncState: "conflict", conflictCount: 1 },
    });
  }, 30_000);

  it("promotes a designated full-recovery Home with telemetry and assets but no integration bindings", async () => {
    const coordinator = await node("Recovery coordinator");
    const participant = await node("Recovery successor");
    nodes.push(coordinator, participant);
    const sensor = coordinator.runtime.database.listSensors("house-main")[0]!;
    coordinator.runtime.database.updateSensor(sensor.id, {
      temperatureEntityId: "sensor.private_temperature",
      tpLinkDeviceId: "private-device-id",
    });
    const sampleAt = "2026-07-24T10:00:00.000Z";
    coordinator.runtime.database.insertMeasurementSamples([{
      sensorId: sensor.id,
      metric: "temperature",
      value: 19.75,
      canonicalUnit: "°C",
      timestamp: sampleAt,
      source: "api",
      quality: "good",
    }]);
    const weatherAt = "2026-07-24T09:30:00.000Z";
    const weatherLocationKey = "60.1699,24.9384";
    coordinator.runtime.database.upsertOutdoorTemperatureSample({
      houseId: "house-main",
      locationKey: weatherLocationKey,
      timestamp: weatherAt,
      temperatureC: 11.25,
      source: "fmi-backfill",
      fetchedAt: "2026-07-24T10:05:00.000Z",
      stationId: "helsinki-test",
      stationName: "Helsinki test",
    });
    const gltfBytes = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, scenes: [] }));
    coordinator.runtime.database.createAsset({
      houseId: "house-main",
      name: "cottage.gltf",
      mimeType: "model/gltf+json",
      kind: "model-3d",
      data: gltfBytes,
    });

    const created = await request(coordinator.url).post("/api/v1/stugbys")
      .send({ name: "Recovery Stuguby" }).expect(201);
    const stugubyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/invitations`).send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);
    await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "members", nodeIds: [participant.runtime.stuguby.identity.nodeId] },
      datasets: fullRecoveryDatasets(),
      housePolicy: {
        editPolicy: "read-only",
        recoveryMode: "full",
        designatedSuccessorNodeId: participant.runtime.stuguby.identity.nodeId,
      },
    }).expect(201);
    const alternate = await node("Alternate recovery successor");
    nodes.push(alternate);
    const alternateInvitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/invitations`).send({ role: "participant" }).expect(201);
    await request(alternate.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: alternateInvitation.body.id,
      joinSecret: alternateInvitation.body.joinSecret,
    }).expect(201);
    const competingSuccessor = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/grants`).send({
        localHouseId: "house-main",
        audience: { kind: "members", nodeIds: [alternate.runtime.stuguby.identity.nodeId] },
        datasets: fullRecoveryDatasets(),
        housePolicy: {
          editPolicy: "read-only",
          recoveryMode: "full",
          designatedSuccessorNodeId: alternate.runtime.stuguby.identity.nodeId,
        },
      }).expect(409);
    expect(competingSuccessor.body.error.code).toBe("HOME_SUCCESSOR_ALREADY_DESIGNATED");

    const recoveryAssetEvent = coordinator.runtime.stuguby.store.eventPage(
      stugubyId,
      participant.runtime.stuguby.identity.nodeId,
      0,
      250,
    ).events.find((event) => event.schema === "home.recovery.v1"
      && (event.payload as { kind?: string } | null)?.kind === "assets")!;
    const recoveryAssetRecord = (recoveryAssetEvent.payload as unknown as {
      records: Array<{ digest: string }>;
    }).records[0]!;
    expect(recoveryAssetRecord).toMatchObject({
      name: "cottage.gltf",
      mimeType: "model/gltf+json",
      kind: "model-3d",
    });
    expect(coordinator.runtime.stuguby.store.getBlob(recoveryAssetRecord.digest)).toMatchObject({
      digest: recoveryAssetRecord.digest,
      mediaType: "model/gltf+json",
      byteLength: gltfBytes.byteLength,
    });
    expect(coordinator.runtime.stuguby.store.canReadBlob(
      stugubyId,
      recoveryAssetRecord.digest,
      participant.runtime.stuguby.identity.nodeId,
    )).toBe(true);

    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`).expect(200);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/property/adopt`).send({}).expect(201);
    const detail = await request(participant.runtime.app).get(`/api/v1/stugbys/${stugubyId}`).expect(200);
    expect(detail.body.homeProjections[0]).toMatchObject({
      recoveryMode: "full",
      recoveryState: "ready",
      designatedSuccessorNodeId: participant.runtime.stuguby.identity.nodeId,
    });
    participant.runtime.database.db.prepare(
      "UPDATE stugby_remote_resources SET received_at='2000-01-01T00:00:00.000Z' WHERE stugby_id=?",
    ).run(stugubyId);
    participant.runtime.database.db.prepare(
      "UPDATE stugby_remote_telemetry SET received_at='2000-01-01T00:00:00.000Z' WHERE stugby_id=?",
    ).run(stugubyId);
    participant.runtime.stuguby.store.enforceRetention(stugubyId);
    expect(participant.runtime.stuguby.store.listRemoteResources(stugubyId))
      .toEqual(expect.arrayContaining([expect.objectContaining({ schema: "home.recovery.v1" })]));
    expect(participant.runtime.stuguby.store.remoteTelemetryCount(
      stugubyId,
      coordinator.runtime.stuguby.identity.nodeId,
      detail.body.homeProjections[0].publicationId,
    )).toBeGreaterThan(0);
    const recoveredHomeId = detail.body.homeProjections[0].localHouseId as string;
    const projectedSensor = participant.runtime.database.listSensors(recoveredHomeId)[0]!;
    expect(projectedSensor.temperatureEntityId).toBeUndefined();
    expect(projectedSensor.tpLinkDeviceId).toBeUndefined();

    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/property/disconnect`)
      .send({ confirmation: "DISCONNECT" }).expect(200);
    expect(participant.runtime.database.getHouse(recoveredHomeId)?.stuguby).toMatchObject({
      ownership: "local",
      syncState: "detached",
      recoveryState: "ready",
    });
    expect(participant.runtime.database.measurementHistory(
      projectedSensor.id,
      "temperature",
      "2026-07-24T09:00:00.000Z",
      "2026-07-24T11:00:00.000Z",
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ timestamp: sampleAt, value: 19.75, source: "import" }),
    ]));
    expect(participant.runtime.database.outdoorTemperatureHistory(
      recoveredHomeId,
      weatherLocationKey,
      "2026-07-24T09:00:00.000Z",
      "2026-07-24T10:00:00.000Z",
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ timestamp: weatherAt, temperatureC: 11.25, source: "fmi-backfill" }),
    ]));
    const recoveredAsset = participant.runtime.database.listAssets(recoveredHomeId)[0]!;
    expect(recoveredAsset).toMatchObject({
      name: "cottage.gltf",
      mimeType: "model/gltf+json",
      kind: "model-3d",
    });
    expect(Buffer.from(participant.runtime.database.getAsset(recoveredAsset.id)!.data)).toEqual(gltfBytes);
    expect(JSON.stringify({
      house: participant.runtime.database.getHouse(recoveredHomeId),
      sensors: participant.runtime.database.listSensors(recoveredHomeId),
    })).not.toMatch(/private_temperature|private-device-id/);

    const recoveredPropertyId = participant.runtime.database.getHouse(recoveredHomeId)!.propertyId;
    const successor = await request(participant.url).post("/api/v1/stugbys")
      .send({ name: "Successor Stuguby" }).expect(201);
    await request(participant.runtime.app)
      .post(`/api/v1/stugbys/${successor.body.id}/property/adopt`)
      .send({ localPropertyId: recoveredPropertyId })
      .expect(201);
    expect(participant.runtime.database.getProperty(recoveredPropertyId)?.stuguby).toMatchObject({
      stugubyId: successor.body.id,
      isAuthority: true,
      syncState: "current",
    });
    expect(participant.runtime.database.getHouse(recoveredHomeId)?.stuguby).toMatchObject({
      stugubyId: successor.body.id,
      ownership: "local",
      syncState: "current",
    });
    expect(participant.runtime.stuguby.store.getPropertyAdoption(stugubyId)).toBeNull();
  }, 30_000);

  it("uses SSE availability hints to pull durable property events without waiting for the polling interval", async () => {
    const coordinator = await node("SSE coordinator", true);
    const participant = await node("SSE participant", true);
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({
      name: "SSE Stuguby",
    }).expect(201);
    await request(coordinator.runtime.app).post(`/api/v1/stugbys/${created.body.id}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [{ dataset: "home.directory.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 }],
    }).expect(201);
    const invitation = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${created.body.id}/invitations`)
      .send({ role: "property-manager" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${created.body.id}/sync`).expect(200);
    expect(participant.runtime.stuguby!.store.listRemoteResources(created.body.id))
      .toEqual(expect.arrayContaining([expect.objectContaining({ schema: "home.directory.v1" })]));

    const property = coordinator.runtime.stuguby!.store.getSharedProperty(created.body.id)!;
    await request(coordinator.runtime.app).put(`/api/v1/stugbys/${created.body.id}/property`).send({
      baseRevision: property.revision,
      property: { name: "SSE-delivered common grounds", description: null, location: null, areas: [], equipment: [], notes: [], maintenance: [] },
    }).expect(200);

    await vi.waitFor(() => {
      expect(participant.runtime.stuguby!.store.getSharedProperty(created.body.id)?.name).toBe("SSE-delivered common grounds");
    }, { timeout: 8_000, interval: 50 });
  }, 15_000);

  it("aborts and drains an in-flight federation sync before closing SQLite", async () => {
    let blockSync = false;
    let observedAbort = false;
    let markFetchStarted: (() => void) | null = null;
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    const blockingFetcher: typeof fetch = async (input, init) => {
      if (!blockSync) return fetch(input, init);
      markFetchStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("Expected federation fetch to have an abort signal"));
          return;
        }
        const abort = (): void => {
          observedAbort = true;
          reject(signal.reason ?? new Error("Federation fetch aborted"));
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    };
    const coordinator = await node("Shutdown coordinator");
    const participant = await node("Shutdown participant", false, blockingFetcher);
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "Shutdown drain" }).expect(201);
    const invitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${created.body.id}/invitations`).send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url, invitationId: invitation.body.id, joinSecret: invitation.body.joinSecret,
    }).expect(201);

    blockSync = true;
    const syncing = participant.runtime.stuguby.syncAll();
    await fetchStarted;
    await participant.runtime.close();
    await syncing;
    expect(observedAbort).toBe(true);
  });

  it("bounds coordinator blob responses by the signed floor-plan byte length", async () => {
    let replaceBlob = false;
    const oversizedBlobFetcher: typeof fetch = async (input, init) => {
      if (replaceBlob && init?.method === "GET" && String(input).includes("/blobs/")) {
        return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "1000000" },
        });
      }
      return fetch(input, init);
    };
    const coordinator = await node("Blob coordinator");
    const participant = await node("Blob participant", false, oversizedBlobFetcher);
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "Blob bounds" }).expect(201);
    const invitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${created.body.id}/invitations`).send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url, invitationId: invitation.body.id, joinSecret: invitation.body.joinSecret,
    }).expect(201);
    const house = coordinator.runtime.database.getHouse("house-main")!;
    coordinator.runtime.database.updateHouse(house.id, {
      floors: house.floors.map((floor, index) => index === 0 ? {
        ...floor,
        backgroundImage: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X2NDNwAAAABJRU5ErkJggg==",
      } : floor),
    });
    await request(coordinator.runtime.app).post(`/api/v1/stugbys/${created.body.id}/grants`).send({
      localHouseId: house.id,
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [{ dataset: "home.floorplan.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 }],
    }).expect(201);
    const floorEvent = coordinator.runtime.stuguby.store.eventPage(
      created.body.id,
      participant.runtime.stuguby.identity.nodeId,
      0,
      250,
    ).events.find((event) => event.schema === "home.floorplan.v1");
    const digest = (floorEvent?.payload as { assets?: Array<{ image?: { digest?: string } }> } | null)?.assets?.[0]?.image?.digest;
    expect(digest).toMatch(/^[a-f0-9]{64}$/);

    replaceBlob = true;
    const failed = await request(participant.runtime.app).post(`/api/v1/stugbys/${created.body.id}/sync`).expect(502);
    expect(failed.body.error.code).toBe("REMOTE_BLOB_TOO_LARGE");
    expect(participant.runtime.stuguby.store.getBlob(digest!)).toBeNull();
  });

  it("retires superseded local floor-plan blobs on update and revoke", async () => {
    const coordinator = await node("Blob retirement coordinator");
    const participant = await node("Blob retirement publisher");
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "Blob retirement" }).expect(201);
    const stugubyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/invitations`)
      .send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);
    const house = participant.runtime.database.getHouse("house-main")!;
    participant.runtime.database.updateHouse(house.id, {
      floors: house.floors.map((floor, index) => index === 0 ? {
        ...floor,
        backgroundImage: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X2NDNwAAAABJRU5ErkJggg==",
      } : floor),
    });
    const dataset: StugubyDatasetGrant = {
      dataset: "home.floorplan.v1",
      enabled: true,
      includeLocalIds: false,
      allowReplicaCache: true,
      retentionDays: 30,
    };
    const grant = await request(participant.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: house.id,
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [dataset],
    }).expect(201);
    const store = participant.runtime.stuguby.store;
    const firstFloorPlan = store.dueOutbox(250)
      .find((item) => item.event.schema === "home.floorplan.v1" && item.event.grantEpoch === 1)!;
    const firstDigest = (firstFloorPlan.event.payload as unknown as {
      assets: Array<{ image: { digest: string } }>;
    }).assets[0]!.image.digest;
    expect(store.getBlob(firstDigest)).not.toBeNull();

    const updatedHouse = participant.runtime.database.getHouse(house.id)!;
    participant.runtime.database.updateHouse(house.id, {
      floors: updatedHouse.floors.map((floor, index) => index === 0 ? {
        ...floor,
        backgroundImage: "data:image/png;base64,iVBORw0KGgo=",
      } : floor),
    });
    await request(participant.runtime.app).put(`/api/v1/stugbys/${stugubyId}/grants/${grant.body.id}`).send({
      baseRevision: 1,
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [dataset],
      housePolicy: { editPolicy: "read-only", recoveryMode: "none", designatedSuccessorNodeId: null },
      expiresAt: null,
    }).expect(200);
    const secondFloorPlan = store.dueOutbox(250)
      .find((item) => item.event.schema === "home.floorplan.v1" && item.event.grantEpoch === 3)!;
    const secondDigest = (secondFloorPlan.event.payload as unknown as {
      assets: Array<{ image: { digest: string } }>;
    }).assets[0]!.image.digest;
    expect(secondDigest).not.toBe(firstDigest);
    expect(store.getBlob(firstDigest)).toBeNull();
    expect(existsSync(join(participant.directory, "stuguby", firstDigest))).toBe(false);
    expect(store.getBlob(secondDigest)).not.toBeNull();

    await request(participant.runtime.app).delete(`/api/v1/stugbys/${stugubyId}/grants/${grant.body.id}`).expect(200);
    expect(store.getBlob(secondDigest)).toBeNull();
    expect(existsSync(join(participant.directory, "stuguby", secondDigest))).toBe(false);
  });

  it("rejects oversized or non-progressing coordinator event pages", async () => {
    let responseMode: "normal" | "non-progressing" | "oversized" = "normal";
    const guardedFetcher: typeof fetch = async (input, init) => {
      if (init?.method === "GET" && String(input).includes("/events?cursor=")) {
        if (responseMode === "non-progressing") {
          return new Response(JSON.stringify({
            protocolVersion: STUGBY_PROTOCOL_VERSION,
            events: [],
            cursor: 0,
            hasMore: true,
          }), { headers: { "content-type": "application/json" } });
        }
        if (responseMode === "oversized") {
          return new Response("{}", {
            headers: { "content-type": "application/json", "content-length": "5000000" },
          });
        }
      }
      return fetch(input, init);
    };
    const coordinator = await node("Page coordinator");
    const participant = await node("Page participant", false, guardedFetcher);
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "Page bounds" }).expect(201);
    const invitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${created.body.id}/invitations`).send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url, invitationId: invitation.body.id, joinSecret: invitation.body.joinSecret,
    }).expect(201);

    responseMode = "non-progressing";
    const stalled = await request(participant.runtime.app).post(`/api/v1/stugbys/${created.body.id}/sync`).expect(502);
    expect(stalled.body.error.code).toBe("INVALID_EVENT_PAGE");
    responseMode = "oversized";
    const oversized = await request(participant.runtime.app).post(`/api/v1/stugbys/${created.body.id}/sync`).expect(502);
    expect(oversized.body.error.code).toBe("REMOTE_RESPONSE_TOO_LARGE");
  });

  it("rolls back every deletion-receipt side effect and pins an accepted receipt exactly", async () => {
    const coordinator = await node("Receipt transaction coordinator");
    const participant = await node("Receipt transaction participant");
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({
      name: "Receipt transaction Stuguby",
    }).expect(201);
    const stugubyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/invitations`)
      .send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url, invitationId: invitation.body.id, joinSecret: invitation.body.joinSecret,
    }).expect(201);
    const grant = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [{ dataset: "home.directory.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 }],
    }).expect(201);
    const store = coordinator.runtime.stuguby.store;
    const nodeId = participant.runtime.stuguby.identity.nodeId;
    const eventIdsBeforeRevoke = store.eventPage(stugubyId, nodeId, 0, 250).events.map((event) => event.eventId);
    const originalExpectation = store.expectDeletion.bind(store);
    const revokeFault = vi.spyOn(store, "expectDeletion").mockImplementation((...args) => {
      originalExpectation(...args);
      throw new Error("simulated pending-deletion failure");
    });
    await request(coordinator.runtime.app).delete(`/api/v1/stugbys/${stugubyId}/grants/${grant.body.id}`).expect(500);
    revokeFault.mockRestore();
    expect(store.getGrant(grant.body.id)).toMatchObject({ epoch: 1, revision: 1, revokedAt: null });
    expect(store.pendingDeletions(stugubyId, nodeId)).toBe(0);
    expect(store.eventPage(stugubyId, nodeId, 0, 250).events.map((event) => event.eventId)).toEqual(eventIdsBeforeRevoke);
    expect(store.listAudit(stugubyId).some((event) => event.eventType === "grant.revoked")).toBe(false);

    await request(coordinator.runtime.app).delete(`/api/v1/stugbys/${stugubyId}/grants/${grant.body.id}`).expect(200);

    const actor = store.getMember(stugubyId, nodeId)!;
    const receipt = {
      stugubyId,
      nodeId,
      grantId: grant.body.id as string,
      grantEpoch: 2,
      deletedAt: new Date().toISOString(),
    };
    const eventIdsBefore = store.eventPage(stugubyId, nodeId, 0, 250).events.map((event) => event.eventId);
    const originalRelease = store.releaseDeletionBlobAccess.bind(store);
    const receiptFault = vi.spyOn(store, "releaseDeletionBlobAccess").mockImplementation((...args) => {
      originalRelease(...args);
      throw new Error("simulated receipt cleanup failure");
    });
    expect(() => coordinator.runtime.stuguby.recordDeletionReceipt(actor, receipt)).toThrow(/simulated receipt cleanup failure/);
    receiptFault.mockRestore();

    expect(store.getDeletionReceipt(stugubyId, nodeId, receipt.grantId, receipt.grantEpoch)).toBeNull();
    expect(store.pendingDeletions(stugubyId, nodeId)).toBe(1);
    expect(store.eventPage(stugubyId, nodeId, 0, 250).events.map((event) => event.eventId)).toEqual(eventIdsBefore);
    expect(store.listAudit(stugubyId).some((event) => event.eventType === "deletion.acknowledged")).toBe(false);

    coordinator.runtime.stuguby.recordDeletionReceipt(actor, receipt);
    coordinator.runtime.stuguby.recordDeletionReceipt(actor, receipt);
    expect(store.getDeletionReceipt(stugubyId, nodeId, receipt.grantId, receipt.grantEpoch)).toEqual(receipt);
    expect(store.pendingDeletions(stugubyId, nodeId)).toBe(0);
    expect(store.listAudit(stugubyId).filter((event) => event.eventType === "deletion.acknowledged")).toHaveLength(1);
    expect(() => coordinator.runtime.stuguby.recordDeletionReceipt(actor, {
      ...receipt,
      deletedAt: new Date(Date.parse(receipt.deletedAt) + 1_000).toISOString(),
    })).toThrow(/different deletion receipt is already pinned/i);
    expect(store.getDeletionReceipt(stugubyId, nodeId, receipt.grantId, receipt.grantEpoch)).toEqual(receipt);
  });

  it("retries an identical durable deletion receipt after the coordinator commits but its response is lost", async () => {
    let loseReceiptResponse = true;
    const participantFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (loseReceiptResponse && String(input).endsWith("/deletion-receipts") && init?.method === "POST") {
        loseReceiptResponse = false;
        await response.arrayBuffer();
        throw new Error("simulated lost deletion-receipt response");
      }
      return response;
    };
    const coordinator = await node("Receipt coordinator");
    const participant = await node("Receipt participant", false, participantFetch);
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({
      name: "Deletion receipt Stuguby",
    }).expect(201);
    const invitation = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${created.body.id}/invitations`)
      .send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url, invitationId: invitation.body.id, joinSecret: invitation.body.joinSecret,
    }).expect(201);
    const grant = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${created.body.id}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [{ dataset: "home.directory.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 }],
    }).expect(201);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${created.body.id}/sync`).expect(200);
    expect(participant.runtime.stuguby!.store.listRemoteResources(created.body.id)).toHaveLength(1);

    await request(coordinator.runtime.app).delete(`/api/v1/stugbys/${created.body.id}/grants/${grant.body.id}`).expect(200);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${created.body.id}/sync`).expect(500);
    expect(participant.runtime.stuguby!.store.listRemoteResources(created.body.id)).toEqual([]);
    expect(coordinator.runtime.stuguby!.store.pendingDeletions(
      created.body.id,
      participant.runtime.stuguby!.identity.nodeId,
    )).toBe(0);
    expect(coordinator.runtime.stuguby!.store.listDeletionReceipts(created.body.id)).toHaveLength(1);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${created.body.id}/sync`).expect(200);
    expect(coordinator.runtime.stuguby!.store.pendingDeletions(created.body.id, participant.runtime.stuguby!.identity.nodeId)).toBe(0);
    expect(coordinator.runtime.stuguby!.store.listAudit(created.body.id)
      .filter((event) => event.eventType === "deletion.acknowledged")).toHaveLength(1);
  });
});
