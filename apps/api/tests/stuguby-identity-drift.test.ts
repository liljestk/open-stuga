import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { loadOrCreateStugubyNodeKeys } from "../src/stuguby/identity.js";
import { StugubyService } from "../src/stuguby/service.js";
import { StugubyStore } from "../src/stuguby/store.js";
import { type RunningNode, node, stop } from "./stugubyTestSupport.js";

describe("Stuguby identity drift safeguards", () => {
  const nodes: RunningNode[] = [];

  afterEach(async () => {
    for (const current of nodes.splice(0).reverse()) await stop(current);
  });

  async function adoptedCoordinator(): Promise<{ coordinator: RunningNode; stugubyId: string }> {
    const coordinator = await node("Identity-safe coordinator");
    nodes.push(coordinator);
    const created = await request(coordinator.url).post("/api/v1/stugbys")
      .send({ name: "Identity-safe Stuguby" }).expect(201);
    await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${created.body.id}/property/adopt`)
      .send({}).expect(201);
    return { coordinator, stugubyId: created.body.id as string };
  }

  it("does not backfill duplicate grants under a regenerated node identity", async () => {
    const { coordinator, stugubyId } = await adoptedCoordinator();
    const originalGrants = coordinator.runtime.stuguby.store.listGrants(stugubyId);
    const driftedKeys = loadOrCreateStugubyNodeKeys(null, "Regenerated identity");
    const drifted = new StugubyService({
      database: coordinator.runtime.database,
      store: new StugubyStore(coordinator.runtime.database.db, driftedKeys.identity.nodeId),
      keys: driftedKeys,
      bus: coordinator.runtime.bus,
      assetDirectory: coordinator.directory,
    });

    expect(drifted.store.isCoordinator(stugubyId)).toBe(false);
    let identityError: unknown;
    try {
      drifted.backfillRecommendedHomeOverviews(stugubyId);
    } catch (error) {
      identityError = error;
    }
    expect(identityError).toMatchObject({ code: "STUGBY_IDENTITY_MISMATCH" });
    expect(coordinator.runtime.stuguby.store.listGrants(stugubyId)).toEqual(originalGrants);
  });

  it("removes only active grants whose authority is no longer a member", async () => {
    const { coordinator, stugubyId } = await adoptedCoordinator();
    const store = coordinator.runtime.stuguby.store;
    const createdGrant = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/grants`)
      .send({
        localHouseId: "house-main",
        audience: { kind: "all-members", nodeIds: [] },
        datasets: [{
          dataset: "home.directory.v1",
          enabled: true,
          includeLocalIds: false,
          allowReplicaCache: true,
          retentionDays: 30,
        }],
      }).expect(201);
    const valid = store.getGrant(createdGrant.body.id as string)!;
    const orphan = {
      ...valid,
      id: randomUUID(),
      authorityNodeId: randomUUID(),
      publicationId: randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.upsertGrant(orphan);

    const protectedResponse = await request(coordinator.runtime.app)
      .delete(`/api/v1/stugbys/${stugubyId}/grants/${valid.id}/invalid`)
      .expect(409);
    expect(protectedResponse.body.error.code).toBe("GRANT_AUTHORITY_ACTIVE");
    expect(store.getGrant(valid.id)).not.toBeNull();

    await request(coordinator.runtime.app)
      .delete(`/api/v1/stugbys/${stugubyId}/grants/${orphan.id}/invalid`)
      .expect(200, { removed: true, grantId: orphan.id });
    expect(store.getGrant(orphan.id)).toBeNull();
    expect(store.getGrant(valid.id)).not.toBeNull();
    expect(store.listAudit(stugubyId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "grant.invalid-removed", subjectId: orphan.id }),
    ]));
  });
});
