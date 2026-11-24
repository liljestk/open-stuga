import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiRuntime } from "../src/app.js";
import { authRuntime, setupOwner } from "./local-authTestSupport.js";

const path = "/api/v2/monitoring/houses/house-main/adaptive/settings";
const enable = { dataMode: "demo", action: "set-mode", mode: "shadow", baseRevision: 0 } as const;
const peers = {
  targetSensorId: "target-temperature",
  kind: "peers",
  referenceSensorIds: ["peer-b", "peer-a"],
  placement: "Same interior wall and height",
};

describe("Adaptive Home settings", () => {
  let runtime: ApiRuntime;
  let owner: Awaited<ReturnType<typeof setupOwner>>;
  beforeEach(async () => { runtime = authRuntime(); owner = await setupOwner(runtime); });
  afterEach(async () => runtime.close());
  const patch = (body: object, url = path) => owner.agent.patch(url).set("x-csrf-token", owner.csrf).send(body);

  it("defaults to off, retains reset history, and returns the original result on retry", async () => {
    const original = await owner.agent.get(`${path}?dataMode=demo`).expect(200);
    expect(original.body).toEqual({
      houseId: "house-main", dataMode: "demo", mode: "off", revision: 0, baseline: null, updatedAt: null, referenceGroups: [],
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
    await patch(enable).expect(409);
    expect((await owner.agent.get(`${path}?dataMode=demo`).expect(200)).body)
      .toMatchObject({ mode: "off", revision: 2, baseline: null });
    expect((await patch({ ...enable, baseRevision: 2 }).expect(200)).body).toMatchObject({ revision: 3, mode: "shadow" });
  });

  function addTemperatureSensor(id: string, options: { enabled?: boolean; houseId?: string } = {}) {
    const houseId = options.houseId ?? "house-main";
    runtime.database.createSensor({
      id, houseId, floorId: runtime.database.getHouse(houseId)!.floors[0]!.id,
      room: "", name: id, model: "Test", x: 1, y: 1, z: 1,
      tags: [], enabled: options.enabled ?? true, temperatureEntityId: `sensor.${id}`,
    });
  }

  it("versions approved placements and only resets the baseline when the group changes", async () => {
    for (const id of ["target-temperature", "peer-a", "peer-b"]) addTemperatureSensor(id);
    const enabled = await patch(enable).expect(200);
    const change = { action: "set-reference-groups", dataMode: "demo", baseRevision: 1, referenceGroups: [peers] };
    const approved = await patch(change).expect(200);
    const canonical = { ...peers, referenceSensorIds: ["peer-a", "peer-b"] };
    expect(approved.body.referenceGroups).toEqual([canonical]);
    expect(approved.body.baseline.id).not.toBe(enabled.body.baseline.id);
    expect((await patch({ ...change, referenceGroups: [canonical] }).expect(200)).body).toEqual(approved.body);
    const unchanged = await patch({ ...change, baseRevision: 2 }).expect(200);
    expect(unchanged.body.baseline).toEqual(approved.body.baseline);
    const thermometer = { ...peers, kind: "reference-thermometer", referenceSensorIds: ["peer-b"] };
    const replaced = await patch({ ...change, baseRevision: 3, referenceGroups: [thermometer] }).expect(200);
    expect(replaced.body.referenceGroups).toEqual([thermometer]);
    const cleared = await patch({ ...change, baseRevision: 4, referenceGroups: [] }).expect(200);
    expect(cleared.body.referenceGroups).toEqual([]);
    expect(cleared.body.baseline.id).not.toBe(replaced.body.baseline.id);
  });

  it("rejects ambiguous references, known aliases, and unavailable sensors", async () => {
    addTemperatureSensor("target-temperature");
    addTemperatureSensor("peer-a");
    addTemperatureSensor("peer-b");
    addTemperatureSensor("disabled", { enabled: false });
    const floors = runtime.database.getHouse("house-main")!.floors;
    runtime.database.createHouse({ id: "other-home", name: "Other Home", timezone: "UTC", floors });
    addTemperatureSensor("cross-home", { houseId: "other-home" });
    runtime.database.db.prepare("UPDATE sensors SET tp_link_device_id = ?, tp_link_connection_id = id WHERE id IN (?, ?)")
      .run("legacy-shared-device", "peer-a", "peer-b");
    const change = { action: "set-reference-groups", dataMode: "demo", baseRevision: 0 };
    for (const ids of [["peer-a"], ["peer-a", "peer-a"], ["target-temperature", "peer-a"],
      ["peer-a", "missing"], ["peer-a", "disabled"], ["peer-a", "cross-home"], ["peer-a", "peer-b"]]) {
      await patch({ ...change, referenceGroups: [{ ...peers, referenceSensorIds: ids }] }).expect(400);
    }
    await patch({ ...change, referenceGroups: [peers, peers] }).expect(400);
    await patch({ ...change, referenceGroups: [{ ...peers, placement: " " }] }).expect(400);
    expect((await owner.agent.get(`${path}?dataMode=demo`).expect(200)).body.revision).toBe(0);
  });

  it("revokes approved groups on shared authority even while monitoring is off", async () => {
    for (const id of ["target-temperature", "peer-a", "peer-b"]) addTemperatureSensor(id);
    const change = { action: "set-reference-groups", dataMode: "demo", baseRevision: 0, referenceGroups: [peers] };
    await patch(change).expect(200);
    runtime.database.db.prepare("UPDATE houses SET stugby_json = ? WHERE id = ?").run(
      JSON.stringify({ ownership: "shared", syncState: "active" }), "house-main",
    );
    runtime.database.purgeSharedHomeLocalState("house-main");
    runtime.database.setHouseStugubyLink("house-main", null);
    await patch(change).expect(409);
    expect((await owner.agent.get(`${path}?dataMode=demo`).expect(200)).body)
      .toMatchObject({ revision: 2, mode: "off", referenceGroups: [] });
  });

  it("retains the prior baseline when migrating existing revisions", async () => {
    const enabled = await patch(enable).expect(200);
    runtime.database.db.exec("ALTER TABLE adaptive_settings_revisions DROP COLUMN reference_groups_json");
    runtime.database.migrate();
    expect((await owner.agent.get(`${path}?dataMode=demo`).expect(200)).body).toEqual(enabled.body);
  });
});
