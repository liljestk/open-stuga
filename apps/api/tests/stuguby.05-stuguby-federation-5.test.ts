import { existsSync } from "node:fs";

import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import request from "supertest";

import {
  STUGBY_PROTOCOL_VERSION,
  type StugubyDatasetGrant,
} from "@climate-twin/stuguby-protocol";

import { RunningNode, node, stop } from "./stugubyTestSupport.js";

describe("Stuguby federation", () => {
  const nodes: RunningNode[] = [];

  afterEach(async () => {
    for (const current of nodes.splice(0).reverse()) await stop(current);
  });

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
