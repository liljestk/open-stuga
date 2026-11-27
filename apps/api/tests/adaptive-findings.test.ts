import { isAdaptiveFindingDetail, isAdaptiveFindingReview, isAdaptiveFindingsPage, isAdaptiveHomeSnapshot } from "@climate-twin/contracts";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiRuntime } from "../src/app.js";
import { authRuntime, setupOwner } from "./local-authTestSupport.js";

const houseId = "house-main";
const path = "/api/v2/monitoring/houses/house-main/adaptive/findings";
const snapshotPath = "/api/v2/monitoring/houses/house-main/adaptive";
const hour = 3_600_000;

describe("Adaptive Home shadow findings routes", () => {
  let runtime: ApiRuntime;
  let owner: Awaited<ReturnType<typeof setupOwner>>;
  beforeEach(async () => { runtime = authRuntime(); owner = await setupOwner(runtime); });
  afterEach(async () => runtime.close());

  function seedFindings(start = 1700000000000) {
    const db = runtime.database;
    db.changeAdaptiveMonitoringSettings({ houseId, actorUserId: "fixture-owner",
      change: { action: "set-mode", mode: "shadow", baseRevision: 0, dataMode: "demo" } });
    const sensorId = "shadow-fixture";
    db.createSensor({
      id: sensorId, houseId, floorId: db.getHouse(houseId)!.floors[0]!.id, name: "Fixture", model: "Test",
      room: "", x: 1, y: 1, z: 1, tags: [], enabled: true,
      temperatureEntityId: "sensor.fixture_shadow",
    });
    const epoch = db.ensureAdaptiveEvidenceEpoch({ houseId, sensorId, metric: "temperature", dataMode: "demo", purpose: "climate" })!;
    const insert = db.db.prepare(`INSERT INTO adaptive_climate_episode_revisions
      (epoch_id, direction, revision, state, target_hour, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`);
    insert.run(epoch.id, "higher", 1, "candidate", start, start + hour);
    insert.run(epoch.id, "higher", 2, "stale", start + hour, start + 2 * hour);
    insert.run(epoch.id, "lower", 1, "candidate", start, start + hour);
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
    expect(detail.body.evidence).toMatchObject({ availability: "unavailable", items: [] });
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
    await guest.get(`${snapshotPath}?dataMode=demo`).expect(403);
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

  it("combines stream states and findings, with scope counts and independently bound snapshot cursors", async () => {
    const off = await owner.agent.get(`${snapshotPath}?dataMode=demo`).expect(200);
    expect(isAdaptiveHomeSnapshot(off.body)).toBe(true);
    expect(off.body.state).toBe("disabled");
    const epochId = seedFindings();
    const db = runtime.database;
    db.createSensor({ id: "snapshot-warming", houseId, floorId: db.getHouse(houseId)!.floors[0]!.id, name: "Warming",
      model: "Test", room: "", x: 1, y: 1, z: 1, tags: [], enabled: true, temperatureEntityId: "sensor.fixture_warming" });
    const closedThrough = Math.floor(Date.now() / hour) * hour;
    db.db.prepare(`INSERT INTO adaptive_climate_detector_hours
      (epoch_id, target_hour, decided_at, error, calibration_json, admitted, reason)
      VALUES (?, ?, ?, 0, '{}', 1, 'calibrated')`).run(epochId, closedThrough - hour, Date.now());
    const all = await owner.agent.get(snapshotPath).query({ dataMode: "demo" }).expect(200);
    expect(isAdaptiveHomeSnapshot(all.body)).toBe(true);
    expect(all.headers["cache-control"]).toBe("private, no-store");
    expect(all.body.streams.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ sensorId: "shadow-fixture", state: "ready", evaluatedThrough: new Date(closedThrough).toISOString() }),
      expect.objectContaining({ sensorId: "snapshot-warming", state: "collecting" }),
    ]));
    const first = (await owner.agent.get(snapshotPath).query({ dataMode: "demo", limit: 1 }).expect(200)).body;
    expect(first.snapshotId).toBe(all.body.snapshotId);
    expect(first.counts).toEqual(all.body.counts);
    expect(first.streams.items).toHaveLength(1);
    expect(first.findings.items).toHaveLength(1);
    const cursors = { streamCursor: first.streams.nextCursor, findingCursor: first.findings.nextCursor };
    expect(cursors.streamCursor).toBeTypeOf("string");
    expect(cursors.findingCursor).toBeTypeOf("string");
    const next = (await owner.agent.get(snapshotPath).query({ dataMode: "demo", limit: 1, ...cursors }).expect(200)).body;
    expect(next.streams.items[0]).not.toEqual(first.streams.items[0]);
    expect(next.findings.items[0].id).not.toEqual(first.findings.items[0].id);
    await owner.agent.get(snapshotPath).query({ dataMode: "demo", streamCursor: cursors.findingCursor }).expect(400);
    await owner.agent.get(snapshotPath).query({ dataMode: "demo", metric: "humidity", ...cursors }).expect(409);
    db.db.prepare(`INSERT INTO adaptive_climate_episode_revisions
      (epoch_id, direction, revision, state, target_hour, recorded_at) VALUES (?, 'higher', 3, 'resolved', ?, ?)`)
      .run(epochId, closedThrough - hour, Date.now());
    await owner.agent.get(snapshotPath).query({ dataMode: "demo", ...cursors }).expect(409);
    db.updateSensor("shadow-fixture", { x: 2 });
    const fresh = (await owner.agent.get(snapshotPath).query({ dataMode: "demo" }).expect(200)).body;
    expect(fresh.findings.items).toEqual(expect.arrayContaining([expect.objectContaining({ epochId, epochCurrent: false })]));
  });

  it("pages the evidence seen by the detector without substituting a later observation", async () => {
    const start = Math.floor(Date.now() / hour) * hour - 4 * hour;
    const epochId = seedFindings(start);
    const db = runtime.database.db;
    db.prepare(`INSERT INTO adaptive_climate_artifacts
      (epoch_id, algorithm_version, evaluated_through, recorded_at, input_digest, report_json)
      VALUES (?, 'fixture/v1', ?, ?, 'fixture', '{}')`).run(epochId, start - hour, start - hour);
    const predict = db.prepare(`INSERT INTO adaptive_climate_predictions
      (epoch_id, target_hour, issued_at, recorded_at, artifact_version, artifact_cutoff, input_digest, prediction)
      VALUES (?, ?, ?, ?, 'fixture/v1', ?, 'fixture', 20)`);
    const observe = db.prepare(`INSERT INTO adaptive_climate_outcomes
      (epoch_id, target_hour, scored_at, observed_at, observed) VALUES (?, ?, ?, ?, 23)`);
    const decide = db.prepare(`INSERT INTO adaptive_climate_detector_hours
      (epoch_id, target_hour, decided_at, calibration_json, admitted, reason, context_guard_json)
      VALUES (?, ?, ?, '{"bias":1,"threshold":1.5}', 0, ?, ?)`);
    for (const target of [start, start + hour]) predict.run(epochId, target, target - 2_000, target - 1_000, start - hour);
    observe.run(epochId, start, start + hour + 1_000, start + hour + 500);
    decide.run(epochId, start, start + hour + 1_000, "frozen-calibration", null);
    decide.run(epochId, start + hour, start + 2 * hour, "missing-observation", null);
    observe.run(epochId, start + hour, start + 2 * hour + 2_000, start + 2 * hour + 1_000);
    const detail = `${path}/${epochId}.higher`;
    const fresh = (await owner.agent.get(detail).query({ dataMode: "demo", limit: 1 }).expect(200)).body;
    expect(isAdaptiveFindingDetail(fresh)).toBe(true);
    expect(fresh.evidence).toMatchObject({
      quantity: "measurement", availability: "available", nextBefore: new Date(start + hour).toISOString(),
      items: [{ reason: "missing-observation", observed: null, availableAt: null, expected: 21, range: { lower: 19.5, upper: 22.5 } }],
    });
    const older = (await owner.agent.get(detail).query({ dataMode: "demo", limit: 1, beforeEvidenceAt: fresh.evidence.nextBefore }).expect(200)).body;
    expect(older.evidence).toMatchObject({
      items: [{ hour: new Date(start).toISOString(), observed: 23, expected: 21, model: { version: "fixture/v1" } }], nextBefore: null,
    });
    await owner.agent.get(detail).query({ dataMode: "demo", beforeEvidenceAt: "invalid" }).expect(400);
  });

  it("labels reference offsets and withholds evidence when a reference is outside current visibility", async () => {
    seedFindings();
    const db = runtime.database;
    const reference = "reference-fixture";
    db.createSensor({
      id: reference, houseId, floorId: db.getHouse(houseId)!.floors[0]!.id, name: "Reference", model: "Test",
      room: "", x: 1, y: 1, z: 1, tags: [], enabled: true,
    });
    db.changeAdaptiveMonitoringSettings({ houseId, actorUserId: "fixture-owner", change: {
      action: "set-reference-groups", dataMode: "demo", baseRevision: 1,
      referenceGroups: [{ targetSensorId: "shadow-fixture", kind: "reference-thermometer", referenceSensorIds: [reference], placement: "Same room" }],
    } });
    const epoch = db.ensureAdaptiveEvidenceEpoch({ houseId, sensorId: "shadow-fixture", metric: "temperature", dataMode: "demo", purpose: "sensor-comparison" })!;
    const target = Math.floor(Date.now() / hour) * hour - 2 * hour;
    db.db.prepare(`INSERT INTO adaptive_reference_artifacts
      (epoch_id, algorithm_version, evaluated_through, recorded_at, input_digest, result_json)
      VALUES (?, 'fixture/v1', ?, ?, 'fixture', ?)`).run(
      epoch.id, target - hour, target - hour, JSON.stringify({ references: [reference], calibration: { offset: 1, threshold: 0.7 } }),
    );
    db.db.prepare(`INSERT INTO adaptive_reference_episode_revisions
      (epoch_id, direction, revision, state, target_hour, recorded_at) VALUES (?, 'higher', 1, 'candidate', ?, ?)`)
      .run(epoch.id, target, target + hour);
    db.db.prepare(`INSERT INTO adaptive_reference_decisions
      (epoch_id, target_hour, recorded_at, state, direction, pair_offset, pair_available_at, paired_hours, reason)
      VALUES (?, ?, ?, 'candidate', 'higher', 2.3, ?, 20, 'paired')`).run(epoch.id, target, target + hour, target + hour);
    const detail = `${path}/${epoch.id}.higher?dataMode=demo`;
    const response = (await owner.agent.get(detail).expect(200)).body;
    expect(isAdaptiveFindingDetail(response)).toBe(true);
    expect(response.evidence).toMatchObject({
      quantity: "temperature-offset", referenceSensorIds: [reference],
      items: [{ expected: 1, observed: 2.3, coverage: 20 / 24 }],
    });
    db.deleteSensor(reference);
    const historic = (await owner.agent.get(detail).expect(200)).body;
    expect(historic.evidence).toMatchObject({ availability: "unavailable", referenceSensorIds: [], items: [] });
  });
});
