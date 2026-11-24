import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiRuntime } from "../src/app.js";
import { authRuntime, setupOwner } from "./local-authTestSupport.js";

const path = "/api/v2/monitoring/houses/house-main/adaptive/settings";
const enable = { dataMode: "demo", action: "set-mode", mode: "shadow", baseRevision: 0 } as const;

describe("Adaptive Home settings", () => {
  let runtime: ApiRuntime;
  let owner: Awaited<ReturnType<typeof setupOwner>>;
  beforeEach(async () => { runtime = authRuntime(); owner = await setupOwner(runtime); });
  afterEach(async () => runtime.close());
  const patch = (body: object, url = path) => owner.agent.patch(url).set("x-csrf-token", owner.csrf).send(body);

  it("defaults to off, retains reset history, and returns the original result on retry", async () => {
    const original = await owner.agent.get(`${path}?dataMode=demo`).expect(200);
    expect(original.body).toEqual({
      houseId: "house-main", dataMode: "demo", mode: "off", revision: 0, baseline: null, updatedAt: null,
    });
    expect(original.headers["cache-control"]).toBe("private, no-store");
    const enabled = await patch(enable).expect(200);
    expect(enabled.body).toMatchObject({ mode: "shadow", revision: 1, baseline: { id: expect.any(String) } });
    const reset = { action: "reset-baseline", baseRevision: 1, dataMode: "demo", reason: "Sensor calibration changed" };
    const updated = await patch(reset).expect(200);
    expect(updated.body.revision).toBe(2);
    expect(updated.body.baseline.id).not.toBe(enabled.body.baseline.id);
    expect((await patch(reset).expect(200)).body).toEqual(updated.body);
    expect((await patch(enable).expect(200)).body).toEqual(enabled.body);
    await patch({ ...reset, reason: "Stale replacement" }).expect(409);
    expect((await owner.agent.get(`${path}?dataMode=demo`).expect(200)).body).toEqual(updated.body);
    expect(runtime.database.db.prepare("SELECT reset_reason AS reason FROM adaptive_settings_revisions WHERE revision = 2").get())
      .toEqual({ reason: reset.reason });
    const off = await patch({ ...enable, mode: "off", baseRevision: 2 }).expect(200);
    expect(off.body).toMatchObject({ mode: "off", revision: 3, baseline: null });
    const reenabled = await patch({ ...enable, baseRevision: 3 }).expect(200);
    expect(reenabled.body.baseline.id).not.toBe(updated.body.baseline.id);
  });

  it("protects writes with mode, Home, account, request and CSRF checks", async () => {
    await request(runtime.app).patch(path).send(enable).expect(401);
    await owner.agent.patch(path).send(enable).expect(403);
    await patch({ ...enable, mode: "advisory" }).expect(400);
    await patch({ ...enable, unknown: true }).expect(400);
    await patch({ ...enable, dataMode: "live" }).expect(409);
    await patch(enable, path.replace("house-main", "missing-home")).expect(404);
    await patch({ dataMode: "demo", action: "reset-baseline", baseRevision: 0, reason: " " }).expect(400);
    const invite = await owner.agent.post("/api/v1/tenant/members").set("x-csrf-token", owner.csrf)
      .send({ email: "guest@example.test", role: "guest", grants: [{ scopeType: "house", scopeId: "house-main" }] }).expect(201);
    const guest = request.agent(runtime.app);
    const account = await guest.post("/api/v1/auth/register")
      .send({ token: invite.body.registrationToken, password: "synthetic guest password only" }).expect(201);
    await guest.get(`${path}?dataMode=demo`).expect(403);
    await guest.patch(path).set("x-csrf-token", account.body.csrfToken).send(enable).expect(403);
  });

  it("revokes demo consent on live activation and denies old demo retries", async () => {
    await patch(enable).expect(200);
    runtime.database.activateRealDataMode();
    await patch(enable).expect(409);
    expect((await owner.agent.get(`${path}?dataMode=live`).expect(200)).body)
      .toMatchObject({ mode: "off", revision: 0, baseline: null });
    expect(runtime.database.db.prepare("SELECT count(*) AS count FROM adaptive_settings_revisions").get()).toEqual({ count: 0 });
  });

  it("requires a new opt-in after a shared Home returns to local authority", async () => {
    await patch(enable).expect(200);
    runtime.database.db.prepare("UPDATE houses SET stugby_json = ? WHERE id = ?").run(
      JSON.stringify({ ownership: "shared", syncState: "active" }), "house-main",
    );
    runtime.database.purgeSharedHomeLocalState("house-main");
    await patch({ ...enable, baseRevision: 1 }).expect(404);
    runtime.database.setHouseStugubyLink("house-main", null);
    expect((await owner.agent.get(`${path}?dataMode=demo`).expect(200)).body)
      .toMatchObject({ mode: "off", revision: 2, baseline: null });
    expect((await patch({ ...enable, baseRevision: 2 }).expect(200)).body).toMatchObject({ revision: 3, mode: "shadow" });
  });
});
