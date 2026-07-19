import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const observationInput = {
  id: "maintenance-evidence",
  houseId: "house-main",
  floorId: "floor-ground",
  kind: "leak",
  severity: "warning",
  note: "Water below the kitchen sink",
} as const;

const taskInput = {
  id: "repair-sink",
  houseId: "house-main",
  floorId: "floor-ground",
  title: "Repair kitchen sink",
  description: "Inspect the coupling and cabinet",
  basis: "condition-based",
  basisDetail: "Visible water requires corrective work",
  priority: "high",
  plannedFor: "2026-07-18",
  dueBy: "2026-07-20",
  observationIds: [observationInput.id],
} as const;

describe("local maintenance tasks", () => {
  let runtime: ApiRuntime;

  beforeEach(async () => {
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false" }),
      startBackground: false,
    });
    await request(runtime.app).post("/api/v1/observations").send(observationInput).expect(201);
  });

  afterEach(async () => { await runtime.close(); });

  it("creates canonical planned work and exposes collection and item resources", async () => {
    const created = await request(runtime.app).post("/api/v1/maintenance-tasks").send({
      ...taskInput,
      observationIds: [observationInput.id, observationInput.id],
    }).expect(201);

    expect(created.body).toMatchObject({
      ...taskInput,
      observationIds: [observationInput.id],
      status: "planned",
      completionNote: null,
      completedAt: null,
      verificationNote: null,
      verifiedAt: null,
      revision: 1,
    });
    expect(created.body.createdAt).toBe(created.body.updatedAt);

    const collection = await request(runtime.app)
      .get("/api/v1/maintenance-tasks?houseId=house-main")
      .expect(200);
    expect(collection.body).toEqual({ maintenanceTasks: [expect.objectContaining({ id: taskInput.id })] });
    await request(runtime.app).get(`/api/v1/maintenance-tasks/${taskInput.id}`).expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ id: taskInput.id, priority: "high" }));

    await request(runtime.app).post("/api/v1/maintenance-tasks").send({
      houseId: "house-main", title: "Default task", basis: "scheduled",
    }).expect(201).expect(({ body }) => expect(body).toMatchObject({
      floorId: null,
      description: null,
      basisDetail: null,
      priority: "normal",
      plannedFor: null,
      dueBy: null,
      observationIds: [],
      status: "planned",
    }));
  });

  it("validates calendar planning, predictive claims, floors, and same-house evidence", async () => {
    for (const invalid of [
      { ...taskInput, id: "bad-date", plannedFor: "2026-02-30" },
      { ...taskInput, id: "reversed", plannedFor: "2026-07-21", dueBy: "2026-07-20" },
      { ...taskInput, id: "predictive-due", basis: "predictive", dueBy: "2026-07-20" },
    ]) {
      await request(runtime.app).post("/api/v1/maintenance-tasks").send(invalid)
        .expect(422).expect(({ body }) => expect(body.error.code).toMatch(/INVALID_MAINTENANCE_(DATE|SCHEDULE)/));
    }
    await request(runtime.app).post("/api/v1/maintenance-tasks").send({ ...taskInput, id: "bad-floor", floorId: "missing" })
      .expect(422).expect(({ body }) => expect(body.error.code).toBe("MAINTENANCE_FLOOR_NOT_FOUND"));
    await request(runtime.app).post("/api/v1/maintenance-tasks").send({ ...taskInput, id: "bad-observation", observationIds: ["missing"] })
      .expect(404).expect(({ body }) => expect(body.error.code).toBe("MAINTENANCE_OBSERVATION_NOT_FOUND"));

    const secondFloor = { id: "other-floor", name: "Ground", width: 8, height: 8, elevation: 0, walls: [], rooms: [] };
    runtime.database.createHouse({ id: "other-house", name: "Other", timezone: "UTC", floors: [secondFloor] });
    runtime.database.createObservation({
      id: "other-evidence", houseId: "other-house", floorId: secondFloor.id,
      kind: "note", severity: "info", note: "Other house evidence",
    });
    await request(runtime.app).post("/api/v1/maintenance-tasks").send({
      ...taskInput, id: "cross-house", observationIds: ["other-evidence"],
    }).expect(409).expect(({ body }) => expect(body.error.code).toBe("MAINTENANCE_OBSERVATION_SCOPE_MISMATCH"));
  });

  it("keeps collection filters narrow and enforces floor and evidence scope in SQLite", async () => {
    await request(runtime.app).get("/api/v1/maintenance-tasks?houseId=").expect(400);
    await request(runtime.app).get("/api/v1/maintenance-tasks?houseId=house-main&houseId=other").expect(400);

    const floor = { id: "task-floor", name: "Task floor", width: 8, height: 8, elevation: 0, walls: [], rooms: [] };
    runtime.database.createHouse({ id: "task-house", name: "Task house", timezone: "UTC", floors: [floor] });
    runtime.database.createHouse({ id: "evidence-house", name: "Evidence house", timezone: "UTC", floors: [floor] });
    runtime.database.createObservation({
      id: "other-house-evidence", houseId: "evidence-house", floorId: floor.id,
      kind: "note", severity: "info", note: "Evidence in another house",
    });
    runtime.database.createMaintenanceTask({
      id: "floor-bound-task", houseId: "task-house", floorId: floor.id,
      title: "Floor-bound work", basis: "required",
    });

    await request(runtime.app).patch("/api/v1/houses/task-house").send({ floors: [] }).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("LAYOUT_ORPHANS_MAINTENANCE_TASK"));
    expect(() => runtime.database.db.prepare(
      "UPDATE maintenance_tasks SET floor_id = 'missing' WHERE id = 'floor-bound-task'",
    ).run()).toThrow(/MAINTENANCE_FLOOR_NOT_FOUND/);
    expect(() => runtime.database.db.prepare(`INSERT INTO maintenance_task_observations
      (maintenance_task_id, observation_id) VALUES ('floor-bound-task', 'other-house-evidence')`).run())
      .toThrow(/MAINTENANCE_OBSERVATION_SCOPE_MISMATCH/);
  });

  it("returns a conflict for duplicate task identifiers", async () => {
    await request(runtime.app).post("/api/v1/maintenance-tasks").send(taskInput).expect(201);
    await request(runtime.app).post("/api/v1/maintenance-tasks").send(taskInput).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("MAINTENANCE_ID_CONFLICT"));
  });

  it("completes and verifies work with server timestamps while keeping observation resolution independent", async () => {
    await request(runtime.app).post("/api/v1/maintenance-tasks").send(taskInput).expect(201);

    await request(runtime.app).patch(`/api/v1/maintenance-tasks/${taskInput.id}`).send({
      baseRevision: 1,
      status: "completed",
    }).expect(422).expect(({ body }) => expect(body.error.code).toBe("INVALID_MAINTENANCE_LIFECYCLE"));
    await request(runtime.app).patch(`/api/v1/maintenance-tasks/${taskInput.id}`).send({
      baseRevision: 1,
      status: "verified",
      completionNote: "Fixed",
      verificationNote: "Dry",
    }).expect(422).expect(({ body }) => expect(body.error.code).toBe("INVALID_MAINTENANCE_LIFECYCLE"));

    const completed = await request(runtime.app).patch(`/api/v1/maintenance-tasks/${taskInput.id}`).send({
      baseRevision: 1,
      status: "completed",
      completionNote: "  Replaced the failed coupling and dried the cabinet  ",
    }).expect(200);
    expect(completed.body).toMatchObject({
      status: "completed",
      completionNote: "Replaced the failed coupling and dried the cabinet",
      verificationNote: null,
      verifiedAt: null,
      revision: 2,
    });
    expect(completed.body.completedAt).toMatch(/Z$/);

    const verified = await request(runtime.app).patch(`/api/v1/maintenance-tasks/${taskInput.id}`).send({
      baseRevision: 2,
      status: "verified",
      verificationNote: "No moisture returned after 48 hours",
    }).expect(200);
    expect(verified.body).toMatchObject({ status: "verified", revision: 3 });
    expect(verified.body.completedAt).toBe(completed.body.completedAt);
    expect(verified.body.verifiedAt).toMatch(/Z$/);

    const observation = runtime.database.getObservation(observationInput.id);
    expect(observation).toMatchObject({ status: "open", resolutionNote: null, resolvedAt: null });

    const returnedToCompletion = await request(runtime.app).patch(`/api/v1/maintenance-tasks/${taskInput.id}`).send({
      baseRevision: 3,
      status: "completed",
    }).expect(200);
    expect(returnedToCompletion.body).toMatchObject({
      status: "completed",
      completedAt: completed.body.completedAt,
      verificationNote: null,
      verifiedAt: null,
      revision: 4,
    });

    const cancelled = await request(runtime.app).patch(`/api/v1/maintenance-tasks/${taskInput.id}`).send({
      baseRevision: 4,
      status: "cancelled",
    }).expect(200);
    expect(cancelled.body).toMatchObject({
      status: "cancelled",
      completionNote: null,
      completedAt: null,
      verificationNote: null,
      verifiedAt: null,
      revision: 5,
    });
  });

  it("uses optimistic concurrency, preserves no-op revisions, and records append-only actor snapshots", async () => {
    await request(runtime.app).post("/api/v1/maintenance-tasks").send(taskInput).expect(201);

    const noOp = await request(runtime.app).patch(`/api/v1/maintenance-tasks/${taskInput.id}`).send({
      baseRevision: 1,
      priority: "high",
      observationIds: [observationInput.id, observationInput.id],
    }).expect(200);
    expect(noOp.body.revision).toBe(1);

    const updated = await request(runtime.app).patch(`/api/v1/maintenance-tasks/${taskInput.id}`).send({
      baseRevision: 1,
      status: "in-progress",
      description: "Coupling removed",
    }).expect(200);
    expect(updated.body).toMatchObject({ revision: 2, status: "in-progress", description: "Coupling removed" });

    await request(runtime.app).patch(`/api/v1/maintenance-tasks/${taskInput.id}`).send({
      baseRevision: 1,
      title: "Stale title",
    }).expect(409).expect(({ body }) => expect(body.error.code).toBe("MAINTENANCE_REVISION_CONFLICT"));

    const history = await request(runtime.app).get(`/api/v1/maintenance-tasks/${taskInput.id}/revisions`).expect(200);
    expect(history.body.revisions).toHaveLength(2);
    expect(history.body.revisions[0]).toMatchObject({
      maintenanceTaskId: taskInput.id,
      revision: 1,
      actor: "local-rest",
      snapshot: { observationIds: [observationInput.id], revision: 1 },
    });
    expect(history.body.revisions[1]).toMatchObject({
      revision: 2,
      actor: "local-rest",
      changedFields: ["description", "status"],
      snapshot: { description: "Coupling removed", status: "in-progress", revision: 2 },
    });

    const before = runtime.database.listMaintenanceTaskRevisions(taskInput.id);
    expect(() => runtime.database.db.prepare(`INSERT OR REPLACE INTO maintenance_task_revisions
      (maintenance_task_id, revision, changed_at, actor, changed_fields_json, snapshot_json)
      VALUES (?, 1, ?, 'local-mcp', '[]', '{}')`).run(taskInput.id, "2099-01-01T00:00:00.000Z"))
      .toThrow(/MAINTENANCE_TASK_REVISIONS_ARE_APPEND_ONLY/);
    expect(() => runtime.database.db.prepare(
      "DELETE FROM maintenance_task_revisions WHERE maintenance_task_id = ?",
    ).run(taskInput.id)).toThrow(/MAINTENANCE_TASK_REVISIONS_ARE_APPEND_ONLY/);
    expect(runtime.database.listMaintenanceTaskRevisions(taskInput.id)).toEqual(before);
    expect(() => runtime.database.migrate()).not.toThrow();
    expect(runtime.database.listMaintenanceTaskRevisions(taskInput.id)).toEqual(before);
  });

  it("protects linked observations until explicitly unlinked and cascades task history on deletion", async () => {
    await request(runtime.app).post("/api/v1/maintenance-tasks").send(taskInput).expect(201);
    expect(() => runtime.database.db.prepare("DELETE FROM observations WHERE id = ?").run(observationInput.id))
      .toThrow(/FOREIGN KEY constraint failed/);
    await request(runtime.app).delete(`/api/v1/observations/${observationInput.id}`).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("OBSERVATION_LINKED_TO_MAINTENANCE"));

    await request(runtime.app).patch(`/api/v1/maintenance-tasks/${taskInput.id}`).send({
      baseRevision: 1,
      observationIds: [],
    }).expect(200);
    await request(runtime.app).delete(`/api/v1/observations/${observationInput.id}`).expect(204);

    expect(runtime.database.listMaintenanceTaskRevisions(taskInput.id)).toHaveLength(2);
    await request(runtime.app).delete(`/api/v1/maintenance-tasks/${taskInput.id}`).expect(204);
    expect(runtime.database.listMaintenanceTaskRevisions(taskInput.id)).toEqual([]);
    await request(runtime.app).get(`/api/v1/maintenance-tasks/${taskInput.id}`).expect(404);
  });

  it("blocks house deletion until owned maintenance tasks are reassigned or deleted", async () => {
    await request(runtime.app).post("/api/v1/maintenance-tasks").send(taskInput).expect(201);
    expect(runtime.database.listMaintenanceTaskRevisions(taskInput.id)).toHaveLength(1);

    const blocked = await request(runtime.app).delete("/api/v1/houses/house-main").expect(409);
    expect(blocked.body.error.code).toBe("HOUSE_HAS_MAINTENANCE_TASKS");
    expect(runtime.database.getMaintenanceTask(taskInput.id)).not.toBeNull();
    expect(runtime.database.listMaintenanceTaskRevisions(taskInput.id)).toHaveLength(1);

    await request(runtime.app).delete(`/api/v1/maintenance-tasks/${taskInput.id}`).expect(204);
    await request(runtime.app).delete("/api/v1/houses/house-main").expect(204);

    expect(runtime.database.getMaintenanceTask(taskInput.id)).toBeNull();
    expect(runtime.database.getObservation(observationInput.id)).toBeNull();
    expect(runtime.database.listMaintenanceTaskRevisions(taskInput.id)).toEqual([]);
    expect(runtime.database.db.prepare(
      "SELECT COUNT(*) AS count FROM maintenance_task_observations WHERE maintenance_task_id = ?",
    ).get(taskInput.id)).toMatchObject({ count: 0 });
  });

  it("rejects client-owned timestamps, unknown fields, and contradictory lifecycle notes", async () => {
    await request(runtime.app).post("/api/v1/maintenance-tasks").send({
      ...taskInput,
      completedAt: "2000-01-01T00:00:00.000Z",
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_FIELD"));
    await request(runtime.app).post("/api/v1/maintenance-tasks").send({
      ...taskInput,
      id: "too-many-links",
      observationIds: Array.from({ length: 101 }, (_, index) => `observation-${index}`),
    }).expect(400).expect(({ body }) => expect(body.error.message).toContain("at most 100"));
    await request(runtime.app).post("/api/v1/maintenance-tasks").send({
      ...taskInput,
      id: "long-link",
      observationIds: ["x".repeat(201)],
    }).expect(400).expect(({ body }) => expect(body.error.message).toContain("at most 200"));
    await request(runtime.app).post("/api/v1/maintenance-tasks").send(taskInput).expect(201);
    await request(runtime.app).patch(`/api/v1/maintenance-tasks/${taskInput.id}`).send({ baseRevision: 1 })
      .expect(400);
    await request(runtime.app).patch(`/api/v1/maintenance-tasks/${taskInput.id}`).send({
      baseRevision: 1,
      completionNote: "Not complete",
    }).expect(422).expect(({ body }) => expect(body.error.code).toBe("INVALID_MAINTENANCE_LIFECYCLE"));
    await request(runtime.app).patch(`/api/v1/maintenance-tasks/${taskInput.id}`).send({
      baseRevision: 1,
      status: "cancelled",
      completionNote: "Contradictory",
    }).expect(422).expect(({ body }) => expect(body.error.code).toBe("INVALID_MAINTENANCE_LIFECYCLE"));
  });
});
