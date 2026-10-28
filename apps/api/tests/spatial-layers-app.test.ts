import { SystemErrorLog } from "../src/system-error-log.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const runtimes: ApiRuntime[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function enabledRuntime(localAuthTestBypass = true): ApiRuntime {
  const runtime = createApi({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      MOCK_ENABLED: "true",
      LOCAL_AUTH_TEST_BYPASS: String(localAuthTestBypass),
      SPATIAL_LAYERS_ENABLED: "true",
      SPATIAL_LAYERS_DATABASE_PATH: ":memory:",
    }),
    startBackground: false,
  });
  runtimes.push(runtime);
  return runtime;
}

describe("spatial layer application lifecycle", () => {
  it("runs isolated worker inference only through an authenticated bounded Home session", async () => {
    const runtime = enabledRuntime();
    const house = runtime.database.listHouses()[0]!;

    await request(runtime.app).get("/api/v1/layer-engines").expect(200).expect(({ body }) => {
      expect(body.enabled).toBe(true);
      expect(body.engines).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "climate-scalars", maturity: "stable" }),
        expect.objectContaining({ id: "graph-propagation", maturity: "experimental" }),
        expect.objectContaining({ id: "unexplained-activity", maturity: "research" }),
      ]));
    });

    const started = await request(runtime.app)
      .post(`/api/v1/houses/${house.id}/layers/inference-session`)
      .send({ durationMinutes: 60, cadenceMinutes: 10 })
      .expect(201);
    expect(started.body.session).toMatchObject({ houseId: house.id, status: "active", cadenceMinutes: 10 });
    await runtime.spatialLayers!.scheduler.tick();

    await request(runtime.app).post(`/api/v1/houses/${house.id}/layers/infer`).send({}).expect(404);
    await request(runtime.app).post(`/api/v1/properties/${house.propertyId}/layers/infer`).send({}).expect(404);

    const current = await request(runtime.app)
      .get(`/api/v1/houses/${house.id}/layers/current`)
      .expect(200);
    expect(current.body.partition.dataMode).toBe("demo");
    expect(current.body.topology.zones.length).toBeGreaterThan(0);
    expect(current.body.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        layerId: "climate.temperature",
        coordinateFrames: expect.arrayContaining([expect.objectContaining({ id: expect.any(String), version: expect.any(String) })]),
      }),
    ]));
    await request(runtime.app)
      .delete(`/api/v1/houses/${house.id}/layers/inference-session`)
      .expect(200)
      .expect(({ body }) => expect(body.session).toMatchObject({ id: started.body.session.id, status: "stopped" }));
    expect(runtime.database.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'spatial_%'").all()).toEqual([]);
  });

  it("keeps a corrupt optional state database from blocking the core API", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stugu-invalid-spatial-"));
    temporaryDirectories.push(directory);
    const invalidState = join(directory, "invalid.sqlite");
    writeFileSync(invalidState, "this is not a sqlite database", "utf8");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "true",
        SPATIAL_LAYERS_ENABLED: "true", SPATIAL_LAYERS_DATABASE_PATH: invalidState,
      }),
      startBackground: false,
    });
    runtimes.push(runtime);

    await request(runtime.app).get("/api/v1/health").expect(200).expect(({ body }) => expect(body.status).toBe("ok"));
    await request(runtime.app).get("/api/v1/houses").expect(200).expect(({ body }) => expect(body.houses.length).toBeGreaterThan(0));
    await request(runtime.app).get("/api/v1/layer-engines").expect(200).expect({ enabled: false, engines: [] });
    await request(runtime.app).get("/api/v1/houses/house-main/layers/current").expect(503);
  });

  it("keeps a committed core mutation successful when optional spatial scheduling fails", async () => {
    const runtime = enabledRuntime();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(runtime.spatialLayers!.scheduler, "enqueueScope").mockImplementation(() => {
      throw new Error("spatial database unavailable");
    });

    const created = await request(runtime.app)
      .post("/api/v1/properties")
      .send({ id: "property-durable-without-spatial", name: "Durable Property" })
      .expect(201);

    expect(created.body.property.id).toBe("property-durable-without-spatial");
    expect(runtime.database.getProperty("property-durable-without-spatial")).toMatchObject({
      name: "Durable Property",
    });
    expect(new SystemErrorLog(runtime.database).list()).toEqual([expect.objectContaining({
      source: "spatial-layers", code: "NOTIFICATION_FAILED", message: "Optional change notification failed: spatial database unavailable",
    })]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("keeps topology changes dormant until a Home spatial session is active", async () => {
    const runtime = enabledRuntime();
    const house = runtime.database.listHouses()[0]!;
    const spatial = runtime.spatialLayers!;
    const clearJobs = () => spatial.state.db.prepare("DELETE FROM spatial_inference_jobs").run();
    const jobs = () => spatial.state.db.prepare(`SELECT scope_kind, scope_id, reason
      FROM spatial_inference_jobs ORDER BY scope_kind, scope_id`).all() as Array<{
        scope_kind: string;
        scope_id: string;
        reason: string;
      }>;
    const expectNoAmbientJobs = () => expect(jobs()).toEqual([]);

    clearJobs();
    await request(runtime.app).patch(`/api/v1/properties/${house.propertyId}`).send({
      location: { latitude: 60.17, longitude: 24.93, source: "manual" },
    }).expect(200);
    expectNoAmbientJobs();

    clearJobs();
    await request(runtime.app).patch(`/api/v1/houses/${house.id}`).send({
      mapPlacement: {
        latitude: 60.171,
        longitude: 24.931,
        metersPerPlanUnit: 1,
        footprintFloorId: house.floors[0]!.id,
      },
    }).expect(200);
    expectNoAmbientJobs();

    clearJobs();
    await request(runtime.app).put(`/api/v1/houses/${house.id}/layout`).send({ floors: house.floors }).expect(200);
    expectNoAmbientJobs();

    clearJobs();
    await request(runtime.app).put(`/api/v1/houses/${house.id}/floors/${house.floors[0]!.id}`)
      .send(house.floors[0]).expect(200);
    expectNoAmbientJobs();
  });

  it("does not schedule ambient spatial jobs for sensor mutations", async () => {
    const runtime = enabledRuntime();
    const house = runtime.database.listHouses()[0]!;
    const floor = house.floors[0]!;
    const spatial = runtime.spatialLayers!;
    const clearJobs = () => spatial.state.db.prepare("DELETE FROM spatial_inference_jobs").run();
    const jobs = () => spatial.state.db.prepare(`SELECT scope_kind, scope_id, reason
      FROM spatial_inference_jobs ORDER BY scope_kind, scope_id`).all();
    const expected: unknown[] = [];

    clearJobs();
    await request(runtime.app).post("/api/v1/sensors").send({
      id: "spatial-invalidation-sensor",
      houseId: house.id,
      floorId: floor.id,
      name: "Spatial invalidation sensor",
      room: floor.rooms[0]?.name ?? "Unassigned",
      model: "Test",
      x: floor.width / 2,
      y: floor.height / 2,
      z: floor.elevation + 1.2,
      tags: [],
      enabled: true,
    }).expect(201);
    expect(jobs()).toEqual(expected);

    clearJobs();
    await request(runtime.app).patch("/api/v1/sensors/spatial-invalidation-sensor")
      .send({ name: "Updated spatial sensor" }).expect(200);
    expect(jobs()).toEqual(expected);

    clearJobs();
    await request(runtime.app).delete("/api/v1/sensors/spatial-invalidation-sensor").expect(204);
    expect(jobs()).toEqual(expected);
  });

  it("applies guest house grants and does not leak whole-property layer aggregates", async () => {
    const runtime = enabledRuntime(false);
    const house = runtime.database.listHouses()[0]!;
    const owner = request.agent(runtime.app);
    const guest = request.agent(runtime.app);
    const ownerPassword = "owner-password-1234";
    const guestPassword = "guest-password-1234";

    const ownerSession = await owner.post("/api/v1/auth/setup")
      .send({ email: "owner@example.test", password: ownerPassword })
      .expect(201);
    const invitation = await owner.post("/api/v1/tenant/members")
      .set("x-csrf-token", ownerSession.body.csrfToken)
      .send({
        email: "guest@example.test",
        role: "guest",
        grants: [{ scopeType: "house", scopeId: house.id }],
      })
      .expect(201);
    const guestSession = await guest.post("/api/v1/auth/register")
      .send({ email: "guest@example.test", password: guestPassword, token: invitation.body.registrationToken })
      .expect(201);

    await guest.get(`/api/v1/houses/${house.id}/layers/config`).expect(200);
    await guest.get(`/api/v1/houses/${house.id}/layers/current`).expect(200);
    await guest.get(`/api/v1/houses/${house.id}/layers/health`).expect(200);
    await guest.get(`/api/v1/properties/${house.propertyId}/layers/current`).expect(404);
    await guest.get(`/api/v1/properties/${house.propertyId}/layers/health`).expect(404);
    await guest.get(`/api/v1/houses/${house.id}/layers/inference-session`).expect(200);
    const mutation = (method: "post" | "put" | "delete", path: string) => guest[method](path)
      .set("x-csrf-token", guestSession.body.csrfToken)
      .send({});
    await mutation("put", `/api/v1/houses/${house.id}/layers/config`).expect(403);
    await mutation("post", `/api/v1/houses/${house.id}/layers/ground-truth`).expect(403);
    await mutation("post", `/api/v1/houses/${house.id}/layers/inference-session`).expect(403);
    await mutation("delete", `/api/v1/houses/${house.id}/layers/inference-session`).expect(403);
    await mutation("post", `/api/v1/houses/${house.id}/layers/bindings`).expect(403);
    await mutation("post", `/api/v1/houses/${house.id}/layers/calibrations`).expect(403);
    await mutation("post", `/api/v1/houses/${house.id}/layers/calibration-sessions`).expect(403);
    await mutation("post", `/api/v1/houses/${house.id}/layers/context-events`).expect(403);
  });
});
