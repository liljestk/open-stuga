import { isAdaptiveFindingDetail, isAdaptiveFindingReview, isAdaptiveFindingsPage } from "@climate-twin/contracts";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiRuntime } from "../src/app.js";
import { authRuntime, setupOwner } from "./local-authTestSupport.js";

const houseId = "house-main";
const path = "/api/v2/monitoring/houses/house-main/adaptive/findings";

describe("Adaptive Home shadow findings routes", () => {
  let runtime: ApiRuntime;
  let owner: Awaited<ReturnType<typeof setupOwner>>;
  beforeEach(async () => { runtime = authRuntime(); owner = await setupOwner(runtime); });
  afterEach(async () => runtime.close());

  function seedFindings() {
    const db = runtime.database;
    db.changeAdaptiveMonitoringSettings({ houseId, actorUserId: "fixture-owner",
      change: { action: "set-mode", mode: "shadow", baseRevision: 0, dataMode: "demo" } });
    const sensorId = "shadow-fixture";
    db.createSensor({
      id: sensorId, houseId, floorId: db.getHouse(houseId)!.floors[0]!.id, name: "Fixture", model: "Test",
      room: "", x: 1, y: 1, z: 1, tags: [], enabled: true,
    });
    const epoch = db.ensureAdaptiveEvidenceEpoch({ houseId, sensorId, metric: "temperature", dataMode: "demo", purpose: "climate" })!;
    const insert = db.db.prepare(`INSERT INTO adaptive_climate_episode_revisions
      (epoch_id, direction, revision, state, target_hour, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`);
    insert.run(epoch.id, "higher", 1, "candidate", 1700000000000, 1700003600000);
    insert.run(epoch.id, "higher", 2, "stale", 1700003600000, 1700007200000);
    insert.run(epoch.id, "lower", 1, "candidate", 1700000000000, 1700003600000);
    return epoch.id;
  }

  it("paginates stored episodes and revisions and exposes historical epoch status", async () => {
    const epochId = seedFindings();
    const first = await owner.agent.get(path).query({ dataMode: "demo", limit: 1 }).expect(200);
    expect(first.headers["cache-control"]).toBe("private, no-store");
    expect(isAdaptiveFindingsPage(first.body)).toBe(true);
    expect(first.body.items).toMatchObject([{ id: `${epochId}.higher`, state: "stale", revision: 2, epochCurrent: true }]);
    const cursor = first.body.nextCursor;
    expect(cursor).toBeTypeOf("string");
    const second = await owner.agent.get(path).query({ dataMode: "demo", cursor }).expect(200);
    expect(second.body).toMatchObject({ items: [{ id: `${epochId}.lower` }], nextCursor: null });
    await owner.agent.get(path).query({ dataMode: "demo", state: "candidate", cursor }).expect(400);
    const filtered = await owner.agent.get(path).query({ dataMode: "demo", state: "candidate", metric: "temperature" }).expect(200);
    expect(filtered.body.items).toMatchObject([{ id: `${epochId}.lower` }]);
    const detail = await owner.agent.get(`${path}/${epochId}.higher`).query({ dataMode: "demo", limit: 1 }).expect(200);
    expect(isAdaptiveFindingDetail(detail.body)).toBe(true);
    expect(detail.body.revisions).toMatchObject({ items: [{ revision: 2, state: "stale" }], nextBeforeRevision: 2 });
    const previous = await owner.agent.get(`${path}/${epochId}.higher`).query({ dataMode: "demo", beforeRevision: 2 }).expect(200);
    expect(previous.body.revisions).toMatchObject({ items: [{ revision: 1, state: "candidate" }], nextBeforeRevision: null });
    runtime.database.updateSensor("shadow-fixture", { x: 2 });
    const historic = await owner.agent.get(`${path}/${epochId}.higher?dataMode=demo`).expect(200);
    expect(historic.body.finding.epochCurrent).toBe(false);
  });

  it("requires the active data mode and rejects requests from guests", async () => {
    const epochId = seedFindings();
    await request(runtime.app).get(`${path}?dataMode=demo`).expect(401);
    await owner.agent.get(path).expect(400);
    await owner.agent.get(`${path}?dataMode=live`).expect(409);
    await owner.agent.get(`${path}/invalid?dataMode=demo`).expect(404);
    const invite = await owner.agent.post("/api/v1/tenant/members").set("x-csrf-token", owner.csrf)
      .send({ email: "guest@example.test", role: "guest", grants: [{ scopeType: "house", scopeId: houseId }] }).expect(201);
    const guest = request.agent(runtime.app);
    await guest.post("/api/v1/auth/register")
      .send({ token: invite.body.registrationToken, password: "synthetic guest password only" }).expect(201);
    await guest.get(`${path}?dataMode=demo`).expect(403);
    await guest.get(`${path}/${epochId}.higher?dataMode=demo`).expect(403);
  });

  it("records private review revisions, handles exact retries and fences stale finding revisions", async () => {
    const epochId = seedFindings();
    const detailPath = `${path}/${epochId}.higher`;
    const reviewPath = `${detailPath}/reviews?dataMode=demo`;
    const initial = { baseRevision: 2, idempotencyKey: "first-review", disposition: "useful", note: "  Fixture note  ", reportedRecovery: true };
    const post = (body: object) => owner.agent.post(reviewPath).set("x-csrf-token", owner.csrf).send(body);
    await owner.agent.post(reviewPath).send(initial).expect(403);
    await post({ ...initial, note: "x".repeat(1001) }).expect(400);
    await post({ ...initial, unknown: true }).expect(400);
    await post({ ...initial, baseRevision: 1 }).expect(409);
    const first = (await post(initial).expect(200)).body;
    expect(isAdaptiveFindingReview(first)).toBe(true);
    expect(first).toMatchObject({ findingRevision: 2, note: "Fixture note", reportedRecovery: true, supersedesReviewId: null });
    expect((await post(initial).expect(200)).body).toEqual(first);
    await post({ ...initial, disposition: "not-useful" }).expect(409);

    const repeat = { baseRevision: 2, idempotencyKey: "second-review", disposition: "uncertain" };
    const revised = (await post(repeat).expect(200)).body;
    expect(revised).toMatchObject({ supersedesReviewId: first.id, disposition: "uncertain", note: null, reportedRecovery: false });
    const detail = (await owner.agent.get(`${detailPath}?dataMode=demo`).expect(200)).body;
    expect(detail.finding).toMatchObject({ state: "stale", revision: 2 });
    expect(detail.latestReview).toEqual(revised);

    const invite = await owner.agent.post("/api/v1/tenant/members").set("x-csrf-token", owner.csrf)
      .send({ email: "other-admin@example.test", role: "admin" }).expect(201);
    const admin = request.agent(runtime.app);
    await admin.post("/api/v1/auth/register")
      .send({ token: invite.body.registrationToken, password: "synthetic admin password only" }).expect(201);
    expect((await admin.get(`${detailPath}?dataMode=demo`).expect(200)).body.latestReview).toBeNull();

    runtime.database.db.prepare(`INSERT INTO adaptive_climate_episode_revisions
      (epoch_id, direction, revision, state, target_hour, recorded_at) VALUES (?, 'higher', 3, 'resolved', ?, ?)`)
      .run(epochId, 1700007200000, 1700010800000);
    await post({ ...repeat, idempotencyKey: "stale-review" }).expect(409);
    expect((await post(repeat).expect(200)).body).toEqual(revised);
    expect(runtime.database.db.prepare("SELECT count(*) AS count FROM adaptive_finding_reviews").get()).toEqual({ count: 2 });
    runtime.database.activateRealDataMode();
    await post(repeat).expect(409);
    expect(runtime.database.db.prepare("SELECT count(*) AS count FROM adaptive_finding_reviews").get()).toEqual({ count: 0 });
  });
});
