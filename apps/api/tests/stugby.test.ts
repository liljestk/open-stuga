import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { MeasurementSample } from "@climate-twin/contracts";
import {
  STUGBY_PROTOCOL_VERSION,
  assertSafeFederationPayload,
  validateDatasetPayload,
  validateWireEvent,
  type StugbyDatasetGrant,
} from "@climate-twin/stugby-protocol";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { StugbyService } from "../src/stugby/service.js";
import { StugbyStore } from "../src/stugby/store.js";

interface RunningNode {
  runtime: ApiRuntime;
  server: Server;
  url: string;
  directory: string;
}

async function node(
  name: string,
  startBackground = false,
  stugbyFetcher?: typeof fetch,
  publicOrigin?: string,
): Promise<RunningNode> {
  const directory = mkdtempSync(join(tmpdir(), "stugby-test-"));
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: ":memory:",
    ASSET_DIRECTORY: directory,
    STUGBY_NODE_NAME: name,
    STUGBY_SYNC_INTERVAL_MS: "300000",
    SPATIAL_LAYERS_ENABLED: "false",
    ...(publicOrigin ? { STUGBY_PUBLIC_ORIGIN: publicOrigin } : {}),
  });
  const runtime = createApi({ config, startBackground, ...(stugbyFetcher ? { stugbyFetcher } : {}) });
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

describe("Stugby federation", () => {
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

    const event = {
      protocolVersion: STUGBY_PROTOCOL_VERSION,
      stugbyId: "stugby-1",
      eventId: "event-1",
      eventKind: "member.updated",
      authorityNodeId: "node-1",
      streamId: "members",
      sequence: 1,
      schema: "stugby.member.v1",
      resourceId: "node-1",
      operation: "upsert",
      revision: 1,
      grantId: null,
      grantEpoch: null,
      occurredAt: "2026-07-22T00:00:00.000Z",
      payload: {
        stugbyId: "stugby-1", nodeId: "node-1", displayName: "Node", role: "participant", state: "active",
        publicKey: "public-key", keyFingerprint: "fingerprint", joinedAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:00:00.000Z",
      },
      payloadHash: "0".repeat(64),
    };
    expect(() => validateWireEvent({ ...event, sequence: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe integer/);
    expect(() => validateWireEvent({ ...event, revision: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe integer/);
  });

  it("pins coordinator creation to the server-owned public origin", async () => {
    const coordinator = await node("Pinned coordinator", false, undefined, "https://stugby.example.test");
    const unconfigured = await node("Participant only");
    nodes.push(coordinator, unconfigured);

    const index = await request(coordinator.runtime.app).get("/api/v1/stugbys").expect(200);
    expect(index.body.publicOrigin).toBe("https://stugby.example.test");
    const created = await request(coordinator.runtime.app).post("/api/v1/stugbys").send({
      name: "Pinned Stugby",
      coordinatorUrl: "https://attacker.example.test",
    }).expect(201);
    expect(created.body.coordinatorUrl).toBe("https://stugby.example.test");

    const unavailable = await request(unconfigured.runtime.app)
      .post("/api/v1/stugbys")
      .set("host", "unconfigured.example.test")
      .send({ name: "No public origin" })
      .expect(503);
    expect(unavailable.body.error.code).toBe("STUGBY_PUBLIC_ORIGIN_REQUIRED");
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

    expect(coordinator.runtime.stugby.store.listMembers(created.body.id)
      .filter((member) => member.nodeId === participant.runtime.stugby.identity.nodeId)).toHaveLength(1);
    const wrongIdentity = await request(otherNode.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(401);
    expect(wrongIdentity.body.error.code).toBe("INVALID_INVITATION");
  });

  it("rejects non-UUID replay identifiers before persistence", async () => {
    const coordinator = await node("Replay coordinator");
    nodes.push(coordinator);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "Replay bounds" }).expect(201);
    expect(() => coordinator.runtime.stugby.authenticateMachineRequest(created.body.id, {
      method: "GET",
      path: `/api/v1/stugby-protocol/stugbys/${created.body.id}/events`,
      body: new Uint8Array(),
      nodeId: coordinator.runtime.stugby.identity.nodeId,
      timestamp: new Date().toISOString(),
      requestId: "x".repeat(8_000),
      signature: "not-used-for-an-invalid-id",
    })).toThrow(/request id must be a UUID/i);
  });

  it("rolls back grant state, epochs, events, deletion expectations, and audit when publication fails", async () => {
    const coordinator = await node("Atomic grant coordinator");
    const participant = await node("Atomic grant publisher");
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "Atomic grants" }).expect(201);
    const stugbyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugbyId}/invitations`)
      .send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);

    const store = participant.runtime.stugby.store;
    const datasets: StugbyDatasetGrant[] = [
      { dataset: "home.directory.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 },
    ];
    const originalEnqueue = store.enqueueOutbox.bind(store);
    let enqueueCalls = 0;
    const createFault = vi.spyOn(store, "enqueueOutbox").mockImplementation((...args) => {
      originalEnqueue(...args);
      enqueueCalls += 1;
      if (enqueueCalls === 2) throw new Error("simulated snapshot enqueue failure");
    });
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugbyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets,
    }).expect(500);
    createFault.mockRestore();
    expect(store.listGrants(stugbyId)).toEqual([]);
    expect(store.dueOutbox(250)).toEqual([]);
    expect(store.listAudit(stugbyId).some((event) => event.eventType === "grant.created")).toBe(false);

    const grantResponse = await request(participant.runtime.app).post(`/api/v1/stugbys/${stugbyId}/grants`).send({
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
    await request(participant.runtime.app).put(`/api/v1/stugbys/${stugbyId}/grants/${grantId}`).send({
      baseRevision: 1,
      audience: { kind: "all-members", nodeIds: [] },
      datasets: datasets.map((dataset) => ({ ...dataset, includeLocalIds: true })),
      expiresAt: null,
    }).expect(500);
    updateFault.mockRestore();
    expect(store.getGrant(grantId)).toMatchObject({ epoch: 1, revision: 1, revokedAt: null });
    expect(store.dueOutbox(250)).toEqual([]);
    expect(store.listAudit(stugbyId).some((event) => event.eventType === "grant.updated")).toBe(false);

    const updated = await request(participant.runtime.app).put(`/api/v1/stugbys/${stugbyId}/grants/${grantId}`).send({
      baseRevision: 1,
      audience: { kind: "all-members", nodeIds: [] },
      datasets: datasets.map((dataset) => ({ ...dataset, includeLocalIds: true })),
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
    await request(participant.runtime.app).delete(`/api/v1/stugbys/${stugbyId}/grants/${grantId}`).expect(500);
    revokeFault.mockRestore();
    expect(store.getGrant(grantId)).toMatchObject({ epoch: 3, revision: 3, revokedAt: null });
    expect(store.dueOutbox(250)).toEqual([]);
    expect(store.listAudit(stugbyId).some((event) => event.eventType === "grant.revoked")).toBe(false);

    const expiresAt = new Date(Date.now() + 250).toISOString();
    const expiring = await request(participant.runtime.app).post(`/api/v1/stugbys/${stugbyId}/grants`).send({
      localHouseId: "house-main",
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
    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugbyId}/sync`).expect(500);
    expiryFault.mockRestore();
    expect(store.getGrant(expiring.body.id)).toMatchObject({ epoch: 1, revision: 1, revokedAt: null });
    expect(store.dueOutbox(250)).toEqual([]);
    expect(store.listAudit(stugbyId)
      .some((event) => event.eventType === "grant.expired" && event.subjectId === expiring.body.id)).toBe(false);
  });

  it("rolls back property revisions and member state until every required event and activation snapshot is durable", async () => {
    const coordinator = await node("Atomic membership coordinator");
    const participant = await node("Atomic membership participant");
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "Atomic membership" }).expect(201);
    const stugbyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugbyId}/invitations`)
      .send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);

    const store = coordinator.runtime.stugby.store;
    const nodeId = participant.runtime.stugby.identity.nodeId;
    const originalAppend = store.appendEventForMember.bind(store);
    const propertyBefore = store.getSharedProperty(stugbyId)!;
    const eventIdsBeforeProperty = store.eventPage(stugbyId, nodeId, 0, 250).events.map((event) => event.eventId);
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
    await request(coordinator.runtime.app).put(`/api/v1/stugbys/${stugbyId}/property`).send(propertyInput).expect(500);
    propertyFault.mockRestore();
    expect(store.getSharedProperty(stugbyId)).toEqual(propertyBefore);
    expect(store.eventPage(stugbyId, nodeId, 0, 250).events.map((event) => event.eventId)).toEqual(eventIdsBeforeProperty);
    expect(store.listAudit(stugbyId).some((event) => event.eventType === "shared-property.updated")).toBe(false);
    await request(coordinator.runtime.app).put(`/api/v1/stugbys/${stugbyId}/property`).send(propertyInput).expect(200);
    expect(store.getSharedProperty(stugbyId)).toMatchObject({ name: "Atomic shared grounds", revision: 2 });

    const eventsBeforeSuspension = store.eventPage(stugbyId, nodeId, 0, 250).events.map((event) => event.eventId);
    const memberFault = vi.spyOn(store, "appendEventForMember").mockImplementation((...args) => {
      originalAppend(...args);
      throw new Error("simulated final member event failure");
    });
    await request(coordinator.runtime.app).patch(`/api/v1/stugbys/${stugbyId}/members/${nodeId}`)
      .send({ role: "participant", state: "suspended" }).expect(500);
    memberFault.mockRestore();
    expect(store.getMember(stugbyId, nodeId)?.state).toBe("active");
    expect(store.eventPage(stugbyId, nodeId, 0, 250).events.map((event) => event.eventId)).toEqual(eventsBeforeSuspension);
    expect(store.listAudit(stugbyId).filter((event) => event.eventType === "member.updated")).toHaveLength(0);
    await request(coordinator.runtime.app).patch(`/api/v1/stugbys/${stugbyId}/members/${nodeId}`)
      .send({ role: "participant", state: "suspended" }).expect(200);

    await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugbyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [{ dataset: "home.directory.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 }],
    }).expect(201);
    const eventsBeforeActivation = store.eventPage(stugbyId, nodeId, 0, 250).events.map((event) => event.eventId);
    const memberAuditBeforeActivation = store.listAudit(stugbyId)
      .filter((event) => event.eventType === "member.updated").length;
    let activationAppends = 0;
    const activationFault = vi.spyOn(store, "appendEventForMember").mockImplementation((...args) => {
      originalAppend(...args);
      activationAppends += 1;
      if (activationAppends === 4) throw new Error("simulated activation snapshot failure");
    });
    await request(coordinator.runtime.app).patch(`/api/v1/stugbys/${stugbyId}/members/${nodeId}`)
      .send({ role: "participant", state: "active" }).expect(500);
    activationFault.mockRestore();
    expect(store.getMember(stugbyId, nodeId)?.state).toBe("suspended");
    expect(store.eventPage(stugbyId, nodeId, 0, 250).events.map((event) => event.eventId)).toEqual(eventsBeforeActivation);
    expect(store.listAudit(stugbyId).filter((event) => event.eventType === "member.updated"))
      .toHaveLength(memberAuditBeforeActivation);
    await request(coordinator.runtime.app).patch(`/api/v1/stugbys/${stugbyId}/members/${nodeId}`)
      .send({ role: "participant", state: "active" }).expect(200);
    expect(store.getMember(stugbyId, nodeId)?.state).toBe("active");
  });

  it("replaces an existing signed notification stream for the same member", async () => {
    const coordinator = await node("Stream coordinator");
    nodes.push(coordinator);
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const releaseFirst = coordinator.runtime.stugby.replaceNotificationStream("stugby-1", "node-1", firstClose);
    const releaseSecond = coordinator.runtime.stugby.replaceNotificationStream("stugby-1", "node-1", secondClose);

    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).not.toHaveBeenCalled();
    releaseFirst();
    const thirdClose = vi.fn();
    const releaseThird = coordinator.runtime.stugby.replaceNotificationStream("stugby-1", "node-1", thirdClose);
    expect(secondClose).toHaveBeenCalledOnce();
    releaseSecond();
    await coordinator.runtime.stugby.stop();
    expect(thirdClose).toHaveBeenCalledOnce();
    releaseThird();
  });

  it("caps historical telemetry independently in each UTC hour across all selected metrics", async () => {
    const coordinator = await node("History cap coordinator");
    const participant = await node("History cap publisher");
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "History caps" }).expect(201);
    const stugbyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugbyId}/invitations`)
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

    await request(participant.runtime.app).post(`/api/v1/stugbys/${stugbyId}/grants`).send({
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
    const published = participant.runtime.stugby.store.dueOutbox(250)
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
    const stugbyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugbyId}/invitations`)
      .send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);
    const grant = await request(participant.runtime.app).post(`/api/v1/stugbys/${stugbyId}/grants`).send({
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
    const originalStore = participant.runtime.stugby.store;
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
    const publishLive = (service: StugbyService, sample: MeasurementSample): void => {
      (service as unknown as { publishLiveTelemetry(value: MeasurementSample): void }).publishLiveTelemetry(sample);
    };
    publishLive(participant.runtime.stugby, liveSample(1));
    publishLive(participant.runtime.stugby, liveSample(2));

    const restartedStore = new StugbyStore(participant.runtime.database.db, participant.runtime.stugby.identity.nodeId);
    const restarted = new StugbyService({
      database: participant.runtime.database,
      store: restartedStore,
      keys: participant.runtime.stugby.keys,
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
      name: "Lake Stugby",
      description: "Three independently managed households",
    }).expect(201);
    const stugbyId = created.body.id as string;

    const inviteA = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugbyId}/invitations`)
      .send({ role: "participant" }).expect(201);
    const inviteB = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugbyId}/invitations`)
      .send({ role: "viewer" }).expect(201);

    await request(household.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: inviteA.body.id,
      joinSecret: inviteA.body.joinSecret,
    }).expect(201);
    const duplicateInvite = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugbyId}/invitations`)
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

    const viewerGrant = await request(unsharedHousehold.runtime.app).post(`/api/v1/stugbys/${stugbyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [{ dataset: "home.directory.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 }],
    }).expect(403);
    expect(viewerGrant.body.error.code).toBe("PUBLISHING_FORBIDDEN");
    const viewerProperty = await request(unsharedHousehold.runtime.app).put(`/api/v1/stugbys/${stugbyId}/property`).send({
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
      .get(`/api/v1/stugbys/${stugbyId}/publications/house-main`).expect(200);
    expect(publicationCatalog.body.house).toMatchObject({ localHouseId: "house-main", name: house.name });
    expect(publicationCatalog.body.sensors.length).toBeGreaterThan(0);
    expect(JSON.stringify(publicationCatalog.body)).not.toMatch(/provider|connection|entity|credential/i);

    const datasets: StugbyDatasetGrant[] = [
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
    const grantResponse = await request(household.runtime.app).post(`/api/v1/stugbys/${stugbyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "members", nodeIds: [coordinator.runtime.stugby!.identity.nodeId] },
      datasets,
    }).expect(201);
    const annexGrant = await request(household.runtime.app).post(`/api/v1/stugbys/${stugbyId}/grants`).send({
      localHouseId: "house-annex",
      audience: { kind: "members", nodeIds: [coordinator.runtime.stugby!.identity.nodeId] },
      datasets: [{ dataset: "home.directory.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 }],
    }).expect(201);

    await request(household.runtime.app).post(`/api/v1/stugbys/${stugbyId}/sync`).expect(200);

    const coordinatorDetail = await request(coordinator.runtime.app).get(`/api/v1/stugbys/${stugbyId}`).expect(200);
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
    expect(coordinator.runtime.stugby!.store.remoteTelemetry({ stugbyId }).length).toBeGreaterThan(0);
    const floorPlanDigest = (coordinatorDetail.body.remoteResources
      .find((resource: { schema: string }) => resource.schema === "home.floorplan.v1")
      .payload.assets[0].image.digest) as string;
    expect(coordinator.runtime.stugby!.store.getBlob(floorPlanDigest)).not.toBeNull();
    const directories = coordinator.runtime.stugby!.store.listRemoteResources(stugbyId)
      .filter((resource) => resource.schema === "home.directory.v1");
    expect(directories).toHaveLength(2);
    expect(new Set(directories.map((resource) => resource.publicationId)).size).toBe(2);

    const updatedDatasets = datasets.map((dataset) => dataset.dataset === "home.directory.v1"
      ? { ...dataset, includeLocalIds: true }
      : dataset);
    const updatedGrant = await request(household.runtime.app).put(`/api/v1/stugbys/${stugbyId}/grants/${grantResponse.body.id}`).send({
      baseRevision: grantResponse.body.revision,
      audience: { kind: "members", nodeIds: [coordinator.runtime.stugby!.identity.nodeId] },
      datasets: updatedDatasets,
      expiresAt: null,
    }).expect(200);
    expect(updatedGrant.body).toMatchObject({ epoch: 3, revision: 3 });
    await request(household.runtime.app).post(`/api/v1/stugbys/${stugbyId}/sync`).expect(200);
    const localIdProjection = coordinator.runtime.stugby!.store.listRemoteResources(stugbyId)
      .find((resource) => resource.schema === "home.directory.v1" && resource.publicationId === grantResponse.body.publicationId);
    expect(localIdProjection?.payload).toMatchObject({ localHouseId: "house-main" });
    expect(coordinator.runtime.stugby!.store.getGrant(grantResponse.body.id)?.localHouseId).toBeUndefined();

    await request(unsharedHousehold.runtime.app).post(`/api/v1/stugbys/${stugbyId}/sync`).expect(200);
    const unsharedBefore = await request(unsharedHousehold.runtime.app).get(`/api/v1/stugbys/${stugbyId}`).expect(200);
    expect(unsharedBefore.body.remoteResources).toEqual([]);

    const property = coordinator.runtime.stugby!.store.getSharedProperty(stugbyId)!;
    await request(coordinator.runtime.app).put(`/api/v1/stugbys/${stugbyId}/property`).send({
      baseRevision: property.revision,
      property: {
        name: "Lake Stugby shared grounds",
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
    await request(unsharedHousehold.runtime.app).post(`/api/v1/stugbys/${stugbyId}/sync`).expect(200);
    const unsharedAfter = await request(unsharedHousehold.runtime.app).get(`/api/v1/stugbys/${stugbyId}`).expect(200);
    expect(unsharedAfter.body.sharedProperty.name).toBe("Lake Stugby shared grounds");
    expect(unsharedAfter.body.sharedProperty.maintenance[0].title).toContain("common well");
    await request(coordinator.runtime.app)
      .patch(`/api/v1/stugbys/${stugbyId}/members/${unsharedHousehold.runtime.stugby!.identity.nodeId}`)
      .send({ role: "viewer", state: "revoked" }).expect(200);
    await request(unsharedHousehold.runtime.app).post(`/api/v1/stugbys/${stugbyId}/sync`).expect(200);
    const departed = await request(unsharedHousehold.runtime.app).get(`/api/v1/stugbys/${stugbyId}`).expect(200);
    expect(departed.body.stugby.localMemberState).toBe("revoked");
    expect(departed.body.sharedProperty).toBeNull();

    await request(household.runtime.app).delete(`/api/v1/stugbys/${stugbyId}/grants/${grantResponse.body.id}`).expect(200);
    await request(household.runtime.app).delete(`/api/v1/stugbys/${stugbyId}/grants/${annexGrant.body.id}`).expect(200);
    await request(household.runtime.app).post(`/api/v1/stugbys/${stugbyId}/sync`).expect(200);
    expect(coordinator.runtime.stugby!.store.listRemoteResources(stugbyId)).toEqual([]);
    expect(coordinator.runtime.stugby!.store.remoteTelemetry({ stugbyId })).toEqual([]);
    expect(coordinator.runtime.stugby!.store.getBlob(floorPlanDigest)).toBeNull();
    expect(existsSync(join(coordinator.directory, "stugby", floorPlanDigest))).toBe(false);
    expect(coordinator.runtime.stugby!.store.listDeletionReceipts(stugbyId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ grantId: grantResponse.body.id, nodeId: coordinator.runtime.stugby!.identity.nodeId }),
    ]));
  }, 30_000);

  it("uses SSE availability hints to pull durable property events without waiting for the polling interval", async () => {
    const coordinator = await node("SSE coordinator", true);
    const participant = await node("SSE participant", true);
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({
      name: "SSE Stugby",
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
    expect(participant.runtime.stugby!.store.listRemoteResources(created.body.id))
      .toEqual(expect.arrayContaining([expect.objectContaining({ schema: "home.directory.v1" })]));

    const property = coordinator.runtime.stugby!.store.getSharedProperty(created.body.id)!;
    await request(coordinator.runtime.app).put(`/api/v1/stugbys/${created.body.id}/property`).send({
      baseRevision: property.revision,
      property: { name: "SSE-delivered common grounds", description: null, location: null, areas: [], equipment: [], notes: [], maintenance: [] },
    }).expect(200);

    await vi.waitFor(() => {
      expect(participant.runtime.stugby!.store.getSharedProperty(created.body.id)?.name).toBe("SSE-delivered common grounds");
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
    const syncing = participant.runtime.stugby.syncAll();
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
    const floorEvent = coordinator.runtime.stugby.store.eventPage(
      created.body.id,
      participant.runtime.stugby.identity.nodeId,
      0,
      250,
    ).events.find((event) => event.schema === "home.floorplan.v1");
    const digest = (floorEvent?.payload as { assets?: Array<{ image?: { digest?: string } }> } | null)?.assets?.[0]?.image?.digest;
    expect(digest).toMatch(/^[a-f0-9]{64}$/);

    replaceBlob = true;
    const failed = await request(participant.runtime.app).post(`/api/v1/stugbys/${created.body.id}/sync`).expect(502);
    expect(failed.body.error.code).toBe("REMOTE_BLOB_TOO_LARGE");
    expect(participant.runtime.stugby.store.getBlob(digest!)).toBeNull();
  });

  it("retires superseded local floor-plan blobs on update and revoke", async () => {
    const coordinator = await node("Blob retirement coordinator");
    const participant = await node("Blob retirement publisher");
    nodes.push(coordinator, participant);
    const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "Blob retirement" }).expect(201);
    const stugbyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugbyId}/invitations`)
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
    const dataset: StugbyDatasetGrant = {
      dataset: "home.floorplan.v1",
      enabled: true,
      includeLocalIds: false,
      allowReplicaCache: true,
      retentionDays: 30,
    };
    const grant = await request(participant.runtime.app).post(`/api/v1/stugbys/${stugbyId}/grants`).send({
      localHouseId: house.id,
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [dataset],
    }).expect(201);
    const store = participant.runtime.stugby.store;
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
    await request(participant.runtime.app).put(`/api/v1/stugbys/${stugbyId}/grants/${grant.body.id}`).send({
      baseRevision: 1,
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [dataset],
      expiresAt: null,
    }).expect(200);
    const secondFloorPlan = store.dueOutbox(250)
      .find((item) => item.event.schema === "home.floorplan.v1" && item.event.grantEpoch === 3)!;
    const secondDigest = (secondFloorPlan.event.payload as unknown as {
      assets: Array<{ image: { digest: string } }>;
    }).assets[0]!.image.digest;
    expect(secondDigest).not.toBe(firstDigest);
    expect(store.getBlob(firstDigest)).toBeNull();
    expect(existsSync(join(participant.directory, "stugby", firstDigest))).toBe(false);
    expect(store.getBlob(secondDigest)).not.toBeNull();

    await request(participant.runtime.app).delete(`/api/v1/stugbys/${stugbyId}/grants/${grant.body.id}`).expect(200);
    expect(store.getBlob(secondDigest)).toBeNull();
    expect(existsSync(join(participant.directory, "stugby", secondDigest))).toBe(false);
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
      name: "Receipt transaction Stugby",
    }).expect(201);
    const stugbyId = created.body.id as string;
    const invitation = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugbyId}/invitations`)
      .send({ role: "participant" }).expect(201);
    await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url, invitationId: invitation.body.id, joinSecret: invitation.body.joinSecret,
    }).expect(201);
    const grant = await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugbyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "all-members", nodeIds: [] },
      datasets: [{ dataset: "home.directory.v1", enabled: true, includeLocalIds: false, allowReplicaCache: true, retentionDays: 30 }],
    }).expect(201);
    const store = coordinator.runtime.stugby.store;
    const nodeId = participant.runtime.stugby.identity.nodeId;
    const eventIdsBeforeRevoke = store.eventPage(stugbyId, nodeId, 0, 250).events.map((event) => event.eventId);
    const originalExpectation = store.expectDeletion.bind(store);
    const revokeFault = vi.spyOn(store, "expectDeletion").mockImplementation((...args) => {
      originalExpectation(...args);
      throw new Error("simulated pending-deletion failure");
    });
    await request(coordinator.runtime.app).delete(`/api/v1/stugbys/${stugbyId}/grants/${grant.body.id}`).expect(500);
    revokeFault.mockRestore();
    expect(store.getGrant(grant.body.id)).toMatchObject({ epoch: 1, revision: 1, revokedAt: null });
    expect(store.pendingDeletions(stugbyId, nodeId)).toBe(0);
    expect(store.eventPage(stugbyId, nodeId, 0, 250).events.map((event) => event.eventId)).toEqual(eventIdsBeforeRevoke);
    expect(store.listAudit(stugbyId).some((event) => event.eventType === "grant.revoked")).toBe(false);

    await request(coordinator.runtime.app).delete(`/api/v1/stugbys/${stugbyId}/grants/${grant.body.id}`).expect(200);

    const actor = store.getMember(stugbyId, nodeId)!;
    const receipt = {
      stugbyId,
      nodeId,
      grantId: grant.body.id as string,
      grantEpoch: 2,
      deletedAt: new Date().toISOString(),
    };
    const eventIdsBefore = store.eventPage(stugbyId, nodeId, 0, 250).events.map((event) => event.eventId);
    const originalRelease = store.releaseDeletionBlobAccess.bind(store);
    const receiptFault = vi.spyOn(store, "releaseDeletionBlobAccess").mockImplementation((...args) => {
      originalRelease(...args);
      throw new Error("simulated receipt cleanup failure");
    });
    expect(() => coordinator.runtime.stugby.recordDeletionReceipt(actor, receipt)).toThrow(/simulated receipt cleanup failure/);
    receiptFault.mockRestore();

    expect(store.getDeletionReceipt(stugbyId, nodeId, receipt.grantId, receipt.grantEpoch)).toBeNull();
    expect(store.pendingDeletions(stugbyId, nodeId)).toBe(1);
    expect(store.eventPage(stugbyId, nodeId, 0, 250).events.map((event) => event.eventId)).toEqual(eventIdsBefore);
    expect(store.listAudit(stugbyId).some((event) => event.eventType === "deletion.acknowledged")).toBe(false);

    coordinator.runtime.stugby.recordDeletionReceipt(actor, receipt);
    coordinator.runtime.stugby.recordDeletionReceipt(actor, receipt);
    expect(store.getDeletionReceipt(stugbyId, nodeId, receipt.grantId, receipt.grantEpoch)).toEqual(receipt);
    expect(store.pendingDeletions(stugbyId, nodeId)).toBe(0);
    expect(store.listAudit(stugbyId).filter((event) => event.eventType === "deletion.acknowledged")).toHaveLength(1);
    expect(() => coordinator.runtime.stugby.recordDeletionReceipt(actor, {
      ...receipt,
      deletedAt: new Date(Date.parse(receipt.deletedAt) + 1_000).toISOString(),
    })).toThrow(/different deletion receipt is already pinned/i);
    expect(store.getDeletionReceipt(stugbyId, nodeId, receipt.grantId, receipt.grantEpoch)).toEqual(receipt);
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
      name: "Deletion receipt Stugby",
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
    expect(participant.runtime.stugby!.store.listRemoteResources(created.body.id)).toHaveLength(1);

    await request(coordinator.runtime.app).delete(`/api/v1/stugbys/${created.body.id}/grants/${grant.body.id}`).expect(200);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${created.body.id}/sync`).expect(500);
    expect(participant.runtime.stugby!.store.listRemoteResources(created.body.id)).toEqual([]);
    expect(coordinator.runtime.stugby!.store.pendingDeletions(
      created.body.id,
      participant.runtime.stugby!.identity.nodeId,
    )).toBe(0);
    expect(coordinator.runtime.stugby!.store.listDeletionReceipts(created.body.id)).toHaveLength(1);
    await request(participant.runtime.app).post(`/api/v1/stugbys/${created.body.id}/sync`).expect(200);
    expect(coordinator.runtime.stugby!.store.pendingDeletions(created.body.id, participant.runtime.stugby!.identity.nodeId)).toBe(0);
    expect(coordinator.runtime.stugby!.store.listAudit(created.body.id)
      .filter((event) => event.eventType === "deletion.acknowledged")).toHaveLength(1);
  });
});
