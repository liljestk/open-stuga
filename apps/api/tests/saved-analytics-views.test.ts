import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnalyticsViewDefinition } from "@climate-twin/contracts";
import type { ApiRuntime } from "../src/app.js";
import { authRuntime, setupOwner } from "./local-authTestSupport.js";
import { SavedAnalyticsViews } from "../src/analytics/saved-views/store.js";

const definition: AnalyticsViewDefinition = {
  metric: "temperature", sensorIds: ["sensor-01"], range: { kind: "relative", value: "24h" },
  resolution: "auto", aggregation: "default", qualityPreset: "reliable", weatherObservationsVisible: true, weatherForecastVisible: false,
};
const input = { name: "Bedroom comparison", houseId: "house-main", dataMode: "live", definition };
const base = "/api/v2/analytics/views";
const query = "houseId=house-main&dataMode=live";
describe("private saved analytics views", () => {
  let runtime: ApiRuntime;
  let owner: Awaited<ReturnType<typeof setupOwner>>;
  beforeEach(async () => { runtime = authRuntime(); owner = await setupOwner(runtime); runtime.database.activateRealDataMode(); });
  afterEach(async () => runtime.close());
  const create = () => owner.agent.post(base).set("x-csrf-token", owner.csrf).send(input).expect(201);

  it("persists definitions, uses one response shape, and rejects stale replacement and deletion", async () => {
    const created = (await create()).body.view;
    expect(created).toMatchObject({ name: input.name, revision: 1, definition });
    expect(JSON.stringify(created)).not.toContain("userId");
    const list = await owner.agent.get(`${base}?${query}`).expect(200);
    expect(list.headers["cache-control"]).toBe("private, no-store");
    expect(list.body.views).toEqual([created]);
    const updated = await owner.agent.put(`${base}/${created.id}`).set("x-csrf-token", owner.csrf).send({ ...input, name: "New name", baseRevision: 1 }).expect(200);
    expect(updated.body.view.revision).toBe(2);
    await owner.agent.put(`${base}/${created.id}`).set("x-csrf-token", owner.csrf).send({ ...input, baseRevision: 1 }).expect(409);
    await owner.agent.delete(`${base}/${created.id}?${query}&baseRevision=1`).set("x-csrf-token", owner.csrf).expect(409);
    const userId = runtime.database.db.prepare("SELECT user_id FROM local_workspace_members WHERE role = 'owner'").get() as { user_id: string };
    expect(new SavedAnalyticsViews(runtime.database.db).get({ userId: userId.user_id, houseId: "house-main", dataMode: "live" }, created.id).revision).toBe(2);
    await owner.agent.delete(`${base}/${created.id}?${query}&baseRevision=2`).set("x-csrf-token", owner.csrf).expect(204);
    expect((await owner.agent.get(`${base}?${query}`).expect(200)).body.views).toEqual([]);
  });

  it("does not expose one account's views to another account or allow guessed-id writes", async () => {
    const created = (await create()).body.view;
    const invite = await owner.agent.post("/api/v1/tenant/members").set("x-csrf-token", owner.csrf).send({ email: "member@example.test", role: "member", grants: [] }).expect(201);
    const other = request.agent(runtime.app);
    const registration = await other.post("/api/v1/auth/register").send({ token: invite.body.registrationToken, password: "test member password long enough" }).expect(201);
    expect((await other.get(`${base}?${query}`).expect(200)).body.views).toEqual([]);
    await other.put(`${base}/${created.id}`).set("x-csrf-token", registration.body.csrfToken).send({ ...input, baseRevision: 1 }).expect(404);
    await other.delete(`${base}/${created.id}?${query}&baseRevision=1`).set("x-csrf-token", registration.body.csrfToken).expect(404);
  });

  it("checks mode, Home, sensors, body fields and CSRF before accepting a definition", async () => {
    await request(runtime.app).get(`${base}?${query}`).expect(401);
    await owner.agent.post(base).send(input).expect(403);
    await owner.agent.get(`${base}?houseId=house-main&dataMode=demo`).expect(409);
    const send = (body: object) => owner.agent.post(base).set("x-csrf-token", owner.csrf).send(body);
    await send({ ...input, private: true }).expect(400);
    await send({ ...input, houseId: "unknown-home" }).expect(404);
    await send({ ...input, definition: { ...definition, sensorIds: ["unknown-sensor"] } }).expect(404);
    await send({ ...input, definition: { ...definition, range: { kind: "absolute", start: "2026-10-02T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" } } }).expect(400);
  });

  it("withholds views after sensor scope changes and denies retired Homes", async () => {
    await create();
    runtime.database.db.prepare("DELETE FROM sensors WHERE id = ?").run("sensor-01");
    expect((await owner.agent.get(`${base}?${query}`).expect(200)).body.views).toEqual([]);
    runtime.database.db.prepare("UPDATE houses SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), "house-main");
    await owner.agent.get(`${base}?${query}`).expect(404);
    await owner.agent.post(base).set("x-csrf-token", owner.csrf).send(input).expect(404);
  });

  it("cascades private definitions when workspace membership is removed", async () => {
    await create();
    runtime.database.db.exec("DELETE FROM local_workspace_members WHERE role = 'owner'");
    expect(runtime.database.db.prepare("SELECT count(*) AS count FROM saved_analytics_views").get()).toEqual({ count: 0 });
  });

  it("keeps Guest reads private and denies writes even with a valid CSRF token", async () => {
    await create();
    const invite = await owner.agent.post("/api/v1/tenant/members").set("x-csrf-token", owner.csrf)
      .send({ email: "guest@example.test", role: "guest", grants: [{ scopeType: "house", scopeId: "house-main" }] }).expect(201);
    const guest = request.agent(runtime.app);
    const registration = await guest.post("/api/v1/auth/register").send({ token: invite.body.registrationToken, password: "synthetic guest password only" }).expect(201);
    expect((await guest.get(`${base}?${query}`).expect(200)).body.views).toEqual([]);
    await guest.post(base).set("x-csrf-token", registration.body.csrfToken).send(input).expect(403);
  });
});
