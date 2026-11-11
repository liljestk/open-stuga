import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { house, sensor } from "./home-monitoring-test-support.js";
import { authRuntime, setupOwner } from "./local-authTestSupport.js";
import { isAdaptiveSnapshot, isAdaptiveSettings } from "@climate-twin/contracts";
import { AdaptiveMonitoringStore } from "../src/analytics/adaptive-monitoring/store.js";
import { adaptiveFinding, START } from "./adaptive-monitoring-test-support.js";

const runtimes: ApiRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(r => r.close())); });
function apiRuntime() {
  const runtime = createApi({ config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false", LOCAL_AUTH_TEST_BYPASS: "true" }), startBackground: false });
  runtimes.push(runtime);
  runtime.dataMode.activate();
  const home = runtime.database.createHouse({ id: house.id, name: "Cedar cottage", timezone: "UTC", floors: house.floors });
  runtime.database.createSensor(sensor("sensor-one", "Bedroom", { temperatureEntityId: "sensor.test_temperature" }));
  return { runtime, home, path: `/api/v2/monitoring/houses/${home.id}/adaptive` };
}
describe("adaptive monitoring HTTP boundary", () => {
  it("reads off by default without creating settings or querying telemetry", async () => {
    const { runtime, path } = apiRuntime();
    const response = await request(runtime.app).get(`${path}?dataMode=live`).expect(200);
    expect(isAdaptiveSnapshot(response.body)).toBe(true);
    expect(response.body.state).toBe("disabled");
    expect(runtime.database.db.prepare("SELECT COUNT(*) AS count FROM adaptive_settings").get()).toEqual({ count: 0 });
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });
  it("enables shadow, enforces revisions, rejects unknown fields, and cannot self-promote", async () => {
    const { runtime, path } = apiRuntime();
    const response = await request(runtime.app).patch(`${path}/settings`).send({ dataMode: "live", baseRevision: 0, mode: "shadow" }).expect(200);
    expect(isAdaptiveSettings(response.body)).toBe(true);
    await request(runtime.app).patch(`${path}/settings`).send({ dataMode: "live", baseRevision: 0, mode: "off" }).expect(409);
    await request(runtime.app).patch(`${path}/settings`).send({ dataMode: "live", baseRevision: 1, mode: "advisory", promotionReceiptId: "untrusted" }).expect(422);
    await request(runtime.app).patch(`${path}/settings`).send({ dataMode: "live", baseRevision: 1, model: "arbitrary" }).expect(400);
    const snapshot = await request(runtime.app).get(`${path}?dataMode=live`).expect(200);
    expect(snapshot.body.settings.mode).toBe("shadow");
    expect(snapshot.body.streams.items).toHaveLength(1);
    const comparisons = await request(runtime.app).get(`${path}?dataMode=live&kind=sensor-comparison`).expect(200);
    expect(comparisons.body.counts).toEqual({ streams: 0, ready: 0, findings: 0 });
    expect(comparisons.body.state).toBe("collecting");
    await request(runtime.app).get(`${path}?dataMode=live&kind=unknown`).expect(400);
  });
  it("requires an active data mode and authorized Home for reads and writes", async () => {
    const { runtime, path } = apiRuntime();
    await request(runtime.app).get(path).expect(400);
    await request(runtime.app).get(`${path}?dataMode=demo`).expect(409);
    await request(runtime.app).get("/api/v2/monitoring/houses/absent/adaptive?dataMode=live").expect(404);
    await request(runtime.app).post(`${path}/findings/absent/reviews`).send({
      dataMode: "live", baseRevision: 1, idempotencyKey: "test-review", disposition: "useful", note: "",
    }).expect(404);
  });
  it("does not allow a Member to change learning settings", async () => {
    const runtime = authRuntime();
    runtimes.push(runtime);
    const owner = await setupOwner(runtime);
    runtime.dataMode.activate();
    const home = runtime.database.createHouse({ id: house.id, name: "Cedar cottage", timezone: "UTC", floors: house.floors });
    const invitation = await owner.agent.post("/api/v1/tenant/members").set("x-csrf-token", owner.csrf)
      .send({ email: "learning-member@example.test", role: "member", grants: [] }).expect(201);
    const member = request.agent(runtime.app);
    const login = await member.post("/api/v1/auth/register").send({ token: invitation.body.registrationToken, password: "a long example password for learning" }).expect(201);
    const path = `/api/v2/monitoring/houses/${home.id}/adaptive`;
    await member.patch(`${path}/settings`).set("x-csrf-token", login.body.csrfToken)
      .send({ dataMode: "live", baseRevision: 0, mode: "shadow" }).expect(403);
    const snapshot = await member.get(`${path}?dataMode=live`).expect(200);
    expect(snapshot.body.settings.referenceGroups).toEqual([]);
    expect(snapshot.body.settings.promotionReceiptId).toBeNull();
    expect(snapshot.body.streams.items).toEqual([]);
  });
  it("keeps active findings ahead of older history and preserves IDs in revision pages", async () => {
    const { runtime, home, path } = apiRuntime();
    await request(runtime.app).patch(`${path}/settings`).send({ dataMode: "live", baseRevision: 0, mode: "shadow" }).expect(200);
    const store = new AdaptiveMonitoringStore(runtime.database);
    const stream = store.streams(home.id, "live")[0]!;
    const base = adaptiveFinding({ home, stream });
    for (let i = 0; i < 52; i++) store.saveFinding({ ...base, id: `old-${i}`, state: "expired" }, stream.stream.id, "live");
    for (let revision = 1; revision <= 101; revision++) store.saveFinding({ ...base, id: "z-current", revision,
      lastEvidenceAt: new Date(START + 3_600_000).toISOString() }, stream.stream.id, "live");
    const active = await request(runtime.app).get(`${path}/findings?dataMode=live&activeOnly=true`).expect(200);
    expect(active.body.items.map((f: { id: string }) => f.id)).toEqual(["z-current"]);
    const all = await request(runtime.app).get(`${path}/findings?dataMode=live`).expect(200);
    expect(all.body.items[0].id).toBe("z-current"); expect(all.body.nextCursor).toBeTruthy();
    const first = await request(runtime.app).get(`${path}/findings/z-current?dataMode=live`).expect(200);
    expect(first.body.revisions.items).toHaveLength(50);
    expect(first.body.revisions.items.every((f: { id: string }) => f.id === "z-current")).toBe(true);
    const second = await request(runtime.app).get(`${path}/findings/z-current?dataMode=live&cursor=${first.body.revisions.nextCursor}`).expect(200);
    expect(second.body.revisions.items[0].revision).toBe(51);
    await request(runtime.app).get(`${path}/findings?dataMode=live&activeOnly=maybe`).expect(400);
  });
});
