import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { StugubyDatasetGrant } from "@climate-twin/stuguby-protocol";
import { node, stop, type RunningNode } from "./stugubyTestSupport.js";

const directoryDataset: StugubyDatasetGrant = {
  dataset: "home.directory.v1",
  enabled: true,
  includeLocalIds: false,
  allowReplicaCache: true,
  retentionDays: 30,
};

describe("Stuguby Home retirement", () => {
  const nodes: RunningNode[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const current of nodes.splice(0).reverse()) await stop(current);
  });

  it("queues a revocation before hiding an authoritative Home and purges its remote replica", async () => {
    const coordinator = await node("Retirement coordinator");
    const publisher = await node("Retirement publisher");
    nodes.push(coordinator, publisher);

    const created = await request(coordinator.runtime.app).post("/api/v1/stugbys")
      .send({ name: "Retirement Stuguby" }).expect(201);
    const stugubyId = created.body.id as string;
    const coordinatorPropertyId = coordinator.runtime.database.getHouse("house-main")!.propertyId;
    await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/property/adopt`)
      .send({ localPropertyId: coordinatorPropertyId }).expect(201);
    const invitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/invitations`).send({ role: "participant" }).expect(201);
    await request(publisher.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);

    const grant = await request(publisher.runtime.app).post(`/api/v1/stugbys/${stugubyId}/grants`).send({
      localHouseId: "house-main",
      audience: { kind: "members", nodeIds: [coordinator.runtime.stuguby!.identity.nodeId] },
      datasets: [directoryDataset],
    }).expect(201);
    const projectionSync = await request(publisher.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`);
    expect(projectionSync.status, JSON.stringify(projectionSync.body)).toBe(200);

    const publisherNodeId = publisher.runtime.stuguby!.identity.nodeId;
    const projection = coordinator.runtime.stuguby!.store.getHomeProjection(
      stugubyId,
      publisherNodeId,
      grant.body.publicationId as string,
    )!;
    expect(coordinator.runtime.database.getHouse(projection.localHouseId)).not.toBeNull();

    const now = new Date().toISOString();
    const insertCommand = publisher.runtime.database.db.prepare(`INSERT INTO stugby_home_commands
      (id,stugby_id,authority_node_id,publication_id,command_json,status,result_json,attempts,next_attempt_at,created_at,updated_at)
      VALUES (?,?,?,?,?,'pending',NULL,0,?,?,?)`);
    insertCommand.run(
      "retired-home-command",
      stugubyId,
      publisherNodeId,
      grant.body.publicationId,
      "{}",
      now,
      now,
      now,
    );
    insertCommand.run(
      "unrelated-home-command",
      stugubyId,
      publisherNodeId,
      "unrelated-publication",
      "{}",
      now,
      now,
      now,
    );

    await request(publisher.runtime.app).delete("/api/v1/houses/house-main").expect(204);

    expect(publisher.runtime.database.db.prepare("SELECT deleted_at FROM houses WHERE id='house-main'").get())
      .toMatchObject({ deleted_at: expect.any(String) });
    expect(publisher.runtime.stuguby!.store.getGrant(grant.body.id)).toMatchObject({
      revokedAt: expect.any(String),
      epoch: Number(grant.body.epoch) + 1,
    });
    expect(publisher.runtime.database.db.prepare("SELECT id,status FROM stugby_home_commands ORDER BY id").all())
      .toEqual([
        { id: "retired-home-command", status: "cancelled" },
        { id: "unrelated-home-command", status: "pending" },
      ]);
    expect(publisher.runtime.stuguby!.store.dueOutbox(250).map((item) => item.event))
      .toContainEqual(expect.objectContaining({
        schema: "stuguby.grant.v2",
        operation: "tombstone",
        grantId: grant.body.id,
        grantEpoch: Number(grant.body.epoch) + 1,
      }));

    publisher.runtime.database.db.prepare("DELETE FROM stugby_home_commands WHERE id='unrelated-home-command'").run();
    const purgeSync = await request(publisher.runtime.app).post(`/api/v1/stugbys/${stugubyId}/sync`);
    expect(purgeSync.status, JSON.stringify(purgeSync.body)).toBe(200);
    expect(coordinator.runtime.stuguby!.store.listRemoteResources(stugubyId)
      .filter((resource) => resource.publicationId === grant.body.publicationId)).toEqual([]);
    expect(coordinator.runtime.stuguby!.store.getHomeProjection(
      stugubyId,
      publisherNodeId,
      grant.body.publicationId,
    )).toBeNull();
    expect(coordinator.runtime.database.getHouse(projection.localHouseId)).toBeNull();
  }, 20_000);

  it("rolls back federation retirement and leaves the Home visible when tombstone staging fails", async () => {
    const coordinator = await node("Retryable retirement coordinator");
    const recipient = await node("Retryable retirement recipient");
    nodes.push(coordinator, recipient);

    const created = await request(coordinator.runtime.app).post("/api/v1/stugbys")
      .send({ name: "Retryable retirement" }).expect(201);
    const stugubyId = created.body.id as string;
    const propertyId = coordinator.runtime.database.getHouse("house-main")!.propertyId;
    await request(coordinator.runtime.app).post(`/api/v1/stugbys/${stugubyId}/property/adopt`)
      .send({ localPropertyId: propertyId }).expect(201);
    const invitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/invitations`).send({ role: "participant" }).expect(201);
    await request(recipient.runtime.app).post("/api/v1/stugbys/join").send({
      coordinatorUrl: coordinator.url,
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
    }).expect(201);

    const grant = coordinator.runtime.stuguby!.store.listGrants(
      stugubyId,
      coordinator.runtime.stuguby!.identity.nodeId,
    ).find((candidate) => candidate.localHouseId === "house-main" && !candidate.revokedAt)!;
    const deletionFault = vi.spyOn(coordinator.runtime.stuguby!.store, "expectDeletion")
      .mockImplementation(() => { throw new Error("simulated deletion receipt failure"); });

    await request(coordinator.runtime.app).delete("/api/v1/houses/house-main").expect(500);
    expect(coordinator.runtime.database.getHouse("house-main")).not.toBeNull();
    expect(coordinator.runtime.database.db.prepare("SELECT deleted_at FROM houses WHERE id='house-main'").get())
      .toEqual({ deleted_at: null });
    expect(coordinator.runtime.stuguby!.store.getGrant(grant.id)).toMatchObject({
      epoch: grant.epoch,
      revision: grant.revision,
      revokedAt: null,
    });

    deletionFault.mockRestore();
    await request(coordinator.runtime.app).delete("/api/v1/houses/house-main").expect(204);
    expect(coordinator.runtime.stuguby!.store.getGrant(grant.id)?.revokedAt).not.toBeNull();
  }, 20_000);
});
