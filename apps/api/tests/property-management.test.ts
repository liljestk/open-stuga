import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ClimateDatabase } from "../src/db.js";

const polygon = [
  { latitude: 60.17, longitude: 24.93 },
  { latitude: 60.17, longitude: 24.94 },
  { latitude: 60.18, longitude: 24.94 },
  { latitude: 60.18, longitude: 24.93 },
];

async function createMainHouse(runtime: ApiRuntime): Promise<void> {
  await request(runtime.app).post("/api/v1/houses").send({
    id: "house-main",
    propertyId: "property-main",
    name: "Main home",
    timezone: "Europe/Helsinki",
    floors: [{ id: "floor-ground", name: "Ground", width: 10, height: 8, elevation: 0, walls: [], rooms: [] }],
  }).expect(201);
}

describe("local property management", () => {
  let runtime: ApiRuntime;

  beforeEach(() => {
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false" }),
      database: new ClimateDatabase(":memory:", false),
      startBackground: false,
    });
  });

  afterEach(() => runtime.close());

  it("supports an explicitly empty installation with one default property", async () => {
    await runtime.close();
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false" }),
      database: new ClimateDatabase(":memory:", false),
      startBackground: false,
    });
    const session = await request(runtime.app).get("/api/v1/session").expect(200);
    expect(session.body).toEqual({
      authenticated: false,
      principal: { type: "setup-required", email: null },
      tenant: { id: "local", name: "Local Stuga", role: "owner" },
      availableTenants: [{ id: "local", name: "Local Stuga", role: "owner" }],
      readOnly: true,
      grants: [],
      setupRequired: true,
    });

    const properties = await request(runtime.app).get("/api/v1/properties").expect(200);
    expect(properties.body.properties).toEqual([
      expect.objectContaining({ id: "property-main", name: "My property" }),
    ]);
    const houses = await request(runtime.app).get("/api/v1/houses").expect(200);
    expect(houses.body.houses).toEqual([]);
  });

  it("defaults a new home only when property ownership is unambiguous", async () => {
    const home = {
      name: "First home",
      timezone: "Europe/Helsinki",
      floors: [{ id: "ground", name: "Ground", width: 10, height: 8, elevation: 0, walls: [], rooms: [] }],
    };
    const first = await request(runtime.app).post("/api/v1/houses").send({ id: "first-home", ...home }).expect(201);
    expect(first.body.house.propertyId).toBe("property-main");
    expect(() => runtime.database.db.prepare("UPDATE houses SET property_id = NULL WHERE id = ?")
      .run("first-home")).toThrow(/HOUSE_PROPERTY_REQUIRED/);
    expect(() => runtime.database.db.prepare("UPDATE houses SET property_id = ? WHERE id = ?")
      .run("missing-property", "first-home")).toThrow(/HOUSE_PROPERTY_REQUIRED/);
    expect(runtime.database.getHouse("first-home")?.propertyId).toBe("property-main");
    await request(runtime.app).post("/api/v1/properties").send({ id: "property-second", name: "Second" }).expect(201);

    await request(runtime.app).post("/api/v1/houses").send({ id: "ambiguous-home", ...home }).expect(422)
      .expect(({ body }) => expect(body.error.code).toBe("HOUSE_PROPERTY_REQUIRED"));
    await request(runtime.app).post("/api/v1/houses").send({ id: "blank-home", ...home, propertyId: "   " }).expect(400);
    await request(runtime.app).post("/api/v1/houses").send({ id: "missing-home", ...home, propertyId: "missing" }).expect(404);
    await request(runtime.app).post("/api/v1/houses").send({ id: "first-home", ...home, propertyId: "property-second" }).expect(409);

    const filtered = await request(runtime.app).get("/api/v1/houses?propertyId=property-main").expect(200);
    expect(filtered.body.houses.map((house: { id: string }) => house.id)).toEqual(["first-home"]);
  });

  it("persists, moves, and unplaces fixed-position property assets", async () => {
    const created = await request(runtime.app).post("/api/v1/property-areas").send({
      id: "asset-shed",
      propertyId: "property-main",
      name: "Tool shed",
      kind: "building",
      location: { latitude: 60.171, longitude: 24.931 },
      polygon: [],
    }).expect(201);
    expect(created.body.area).toMatchObject({
      id: "asset-shed",
      location: { latitude: 60.171, longitude: 24.931 },
      polygon: [],
    });

    const moved = await request(runtime.app).patch("/api/v1/property-areas/asset-shed").send({
      location: { latitude: 60.172, longitude: 24.932 },
    }).expect(200);
    expect(moved.body.area.location).toEqual({ latitude: 60.172, longitude: 24.932 });
    expect(runtime.database.getPropertyArea("asset-shed")?.location).toEqual({ latitude: 60.172, longitude: 24.932 });

    const unplaced = await request(runtime.app).patch("/api/v1/property-areas/asset-shed").send({ location: null }).expect(200);
    expect(unplaced.body.area).not.toHaveProperty("location");
    expect(runtime.database.getPropertyArea("asset-shed")).not.toHaveProperty("location");

    await request(runtime.app).post("/api/v1/property-areas").send({
      propertyId: "property-main", name: "Invalid pin", kind: "well", location: { latitude: 91, longitude: 24 }, polygon: [],
    }).expect(422).expect(({ body }) => expect(body.error.code).toBe("INVALID_ASSET_LOCATION"));
    await request(runtime.app).post("/api/v1/property-areas").send({
      propertyId: "property-main", name: "Invalid boundary", kind: "well", polygon: [{ latitude: 60, longitude: 24 }],
    }).expect(400);
  });

  it("manages mapped areas, equipment, notes, and area-scoped maintenance end to end", async () => {
    const createdProperty = await request(runtime.app).post("/api/v1/properties").send({
      id: "property-island",
      name: "Island property",
      description: "House, shoreline, and utility areas",
      location: { latitude: 60.17, longitude: 24.93, source: "manual" },
    }).expect(201);
    expect(createdProperty.body.property).toMatchObject({ id: "property-island", description: expect.any(String) });

    const createdHouse = await request(runtime.app).post("/api/v1/houses").send({
      id: "island-house",
      propertyId: "property-island",
      name: "Island house",
      timezone: "Europe/Helsinki",
      floors: [{ id: "ground", name: "Ground", width: 10, height: 8, elevation: 0, walls: [], rooms: [] }],
    }).expect(201);
    expect(createdHouse.body.house.propertyId).toBe("property-island");

    const createdArea = await request(runtime.app).post("/api/v1/property-areas").send({
      id: "area-well",
      propertyId: "property-island",
      name: "North well",
      kind: "well",
      description: "Drinking-water well",
      polygon,
    }).expect(201);
    expect(createdArea.body.area).toMatchObject({ id: "area-well", kind: "well", polygon });

    const createdEquipment = await request(runtime.app).post("/api/v1/area-equipment").send({
      id: "equipment-pump",
      propertyId: "property-island",
      areaId: "area-well",
      name: "Well pump",
      kind: "pump",
      manufacturer: "Example",
      status: "active",
      notes: "Inspect before winter",
    }).expect(201);
    expect(createdEquipment.body.equipment).toMatchObject({
      id: "equipment-pump", propertyId: "property-island", areaId: "area-well", status: "active",
    });

    const createdNote = await request(runtime.app).post("/api/v1/property-notes").send({
      id: "note-pump",
      propertyId: "property-island",
      equipmentId: "equipment-pump",
      kind: "inspection",
      text: "Pressure was stable during the July inspection.",
    }).expect(201);
    expect(createdNote.body.note).toMatchObject({ equipmentId: "equipment-pump", areaId: null, houseId: null });

    const task = await request(runtime.app).post("/api/v1/maintenance-tasks").send({
      id: "task-pump",
      propertyId: "property-island",
      areaId: "area-well",
      equipmentId: "equipment-pump",
      title: "Service well pump",
      basis: "scheduled",
      plannedFor: "2026-08-10",
    }).expect(201);
    expect(task.body).toMatchObject({
      propertyId: "property-island",
      houseId: null,
      areaId: "area-well",
      equipmentId: "equipment-pump",
      revision: 1,
    });

    await request(runtime.app).post("/api/v1/property-areas").send({
      id: "area-garden",
      propertyId: "property-island",
      name: "Garden",
      kind: "garden",
      polygon: polygon.map((point) => ({ ...point, longitude: point.longitude + 0.001 })),
    }).expect(201);
    const movedEquipment = await request(runtime.app).patch("/api/v1/area-equipment/equipment-pump").send({
      areaId: "area-garden",
    }).expect(200);
    expect(movedEquipment.body.equipment).toMatchObject({
      id: "equipment-pump", propertyId: "property-island", areaId: "area-garden",
    });
    expect(runtime.database.getMaintenanceTask("task-pump")).toMatchObject({
      propertyId: "property-island", areaId: "area-garden", equipmentId: "equipment-pump", revision: 2,
    });
    expect(runtime.database.getPropertyNote("note-pump")).toMatchObject({
      propertyId: "property-island", equipmentId: "equipment-pump",
    });

    const taskPatch = await request(runtime.app).patch("/api/v1/maintenance-tasks/task-pump").send({
      baseRevision: 2,
      equipmentId: null,
    }).expect(200);
    expect(taskPatch.body).toMatchObject({ areaId: "area-garden", equipmentId: null, revision: 3 });
    const revisions = await request(runtime.app).get("/api/v1/maintenance-tasks/task-pump/revisions").expect(200);
    expect(revisions.body.revisions[1].changedFields).toContain("areaId");
    expect(revisions.body.revisions[2]).toMatchObject({ changedFields: ["equipmentId"] });

    const filteredAreas = await request(runtime.app)
      .get("/api/v1/property-areas?propertyId=property-island").expect(200);
    expect(filteredAreas.body.areas.map((area: { id: string }) => area.id)).toEqual(["area-garden", "area-well"]);
    const filteredEquipment = await request(runtime.app)
      .get("/api/v1/area-equipment?propertyId=property-island&areaId=area-well").expect(200);
    expect(filteredEquipment.body.equipment).toHaveLength(0);
    const filteredNotes = await request(runtime.app)
      .get("/api/v1/property-notes?equipmentId=equipment-pump").expect(200);
    expect(filteredNotes.body.notes).toHaveLength(1);

    await request(runtime.app).delete("/api/v1/area-equipment/equipment-pump").expect(409);
    await request(runtime.app).delete("/api/v1/property-areas/area-well").expect(204);
    await request(runtime.app).delete("/api/v1/properties/property-island").expect(409);
  });

  it("moves an area aggregate atomically and blocks detaching linked house evidence", async () => {
    await createMainHouse(runtime);
    await request(runtime.app).post("/api/v1/properties").send({ id: "property-other", name: "Other" }).expect(201);
    await request(runtime.app).post("/api/v1/property-areas").send({
      id: "area-main", propertyId: "property-main", name: "Main yard", kind: "yard", polygon,
    }).expect(201);
    await request(runtime.app).post("/api/v1/area-equipment").send({
      id: "equipment-main", areaId: "area-main", name: "Pump", kind: "pump",
    }).expect(201).expect(({ body }) => expect(body.equipment.propertyId).toBe("property-main"));
    await request(runtime.app).post("/api/v1/property-notes").send({
      id: "note-main", propertyId: "property-main", equipmentId: "equipment-main", kind: "note", text: "Keep history",
    }).expect(201);
    await request(runtime.app).post("/api/v1/observations").send({
      id: "observation-main", houseId: "house-main", floorId: "floor-ground", kind: "note", severity: "info", note: "Observed pump",
    }).expect(201);
    await request(runtime.app).post("/api/v1/maintenance-tasks").send({
      id: "task-main",
      propertyId: "property-main",
      houseId: "house-main",
      floorId: "floor-ground",
      areaId: "area-main",
      equipmentId: "equipment-main",
      observationIds: ["observation-main"],
      title: "Inspect pump",
      basis: "condition-based",
    }).expect(201);

    await request(runtime.app).patch("/api/v1/property-areas/area-main")
      .send({ propertyId: "property-other" }).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("PROPERTY_MOVE_HAS_LINKED_EVIDENCE"));
    expect(runtime.database.getPropertyArea("area-main")?.propertyId).toBe("property-main");
    expect(runtime.database.getMaintenanceTask("task-main")).toMatchObject({
      propertyId: "property-main", houseId: "house-main", revision: 1,
    });

    await request(runtime.app).patch("/api/v1/maintenance-tasks/task-main")
      .send({ baseRevision: 1, observationIds: [] }).expect(200);
    await request(runtime.app).patch("/api/v1/property-areas/area-main")
      .send({ propertyId: "property-other" }).expect(200);

    expect(runtime.database.getAreaEquipment("equipment-main")).toMatchObject({
      propertyId: "property-other", areaId: "area-main",
    });
    expect(runtime.database.getPropertyNote("note-main")).toMatchObject({ propertyId: "property-other" });
    expect(runtime.database.getMaintenanceTask("task-main")).toMatchObject({
      propertyId: "property-other",
      houseId: null,
      floorId: null,
      areaId: "area-main",
      equipmentId: "equipment-main",
      revision: 3,
    });
    const latestRevision = runtime.database.listMaintenanceTaskRevisions("task-main").at(-1)!;
    expect(latestRevision.actor).toBe("local-rest");
    expect(latestRevision.changedFields).toEqual(expect.arrayContaining(["propertyId", "houseId", "floorId"]));
  });

  it("supports safe house reassignment, bounded filters, pagination, default-property protection, and normalized blanks", async () => {
    await createMainHouse(runtime);
    const property = await request(runtime.app).post("/api/v1/properties").send({
      id: "property-land",
      name: "Land",
      description: "   ",
    }).expect(201);
    expect(property.body.property.description).toBeNull();

    for (const id of ["land-house-a", "land-house-b"]) {
      await request(runtime.app).post("/api/v1/houses").send({
        id,
        propertyId: "property-land",
        name: id,
        timezone: "Europe/Helsinki",
        floors: [{ id: "ground", name: "Ground", width: 10, height: 8, elevation: 0, walls: [], rooms: [] }],
      }).expect(201);
    }
    await request(runtime.app).post("/api/v1/property-areas").send({
      id: "area-land",
      propertyId: "property-land",
      name: "Field",
      kind: "field",
      polygon,
    }).expect(201);
    const equipment = await request(runtime.app).post("/api/v1/area-equipment").send({
      id: "equipment-land",
      propertyId: "property-land",
      areaId: "area-land",
      name: "Irrigation pump",
      kind: "pump",
      manufacturer: "   ",
      notes: "",
    }).expect(201);
    expect(equipment.body.equipment).toMatchObject({ manufacturer: null, notes: null });

    await request(runtime.app).post("/api/v1/maintenance-tasks").send({
      id: "task-property-only",
      propertyId: "property-land",
      houseId: null,
      areaId: "area-land",
      equipmentId: "equipment-land",
      title: "Service irrigation",
      basis: "scheduled",
    }).expect(201).expect(({ body }) => {
      expect(body).toMatchObject({ propertyId: "property-land", houseId: null });
    });
    await request(runtime.app).post("/api/v1/maintenance-tasks").send({
      propertyId: "property-land",
      houseId: null,
      floorId: "ground",
      title: "Invalid floor task",
      basis: "required",
    }).expect(422);
    await request(runtime.app).post("/api/v1/maintenance-tasks").send({
      propertyId: "property-land",
      observationIds: ["missing-observation"],
      title: "Invalid evidence task",
      basis: "required",
    }).expect(422);

    await request(runtime.app).post("/api/v1/maintenance-tasks").send({
      id: "task-reassign",
      houseId: "land-house-a",
      title: "Reassignable work",
      basis: "required",
    }).expect(201).expect(({ body }) => {
      expect(body).toMatchObject({ propertyId: "property-land", houseId: "land-house-a" });
    });
    await request(runtime.app).patch("/api/v1/maintenance-tasks/task-reassign").send({
      baseRevision: 1,
      houseId: "land-house-b",
    }).expect(200).expect(({ body }) => {
      expect(body).toMatchObject({ propertyId: "property-land", houseId: "land-house-b", revision: 2 });
    });
    await request(runtime.app).patch("/api/v1/maintenance-tasks/task-reassign").send({
      baseRevision: 2,
      houseId: "house-main",
    }).expect(409);
    await request(runtime.app).patch("/api/v1/maintenance-tasks/task-reassign").send({
      baseRevision: 2,
      houseId: null,
    }).expect(200).expect(({ body }) => {
      expect(body).toMatchObject({ propertyId: "property-land", houseId: null, revision: 3 });
    });
    const revisions = await request(runtime.app).get("/api/v1/maintenance-tasks/task-reassign/revisions").expect(200);
    expect(revisions.body.revisions.at(-1).changedFields).toContain("houseId");

    for (const filter of [
      "propertyId=property-land",
      "areaId=area-land",
      "equipmentId=equipment-land",
    ]) {
      const response = await request(runtime.app).get(`/api/v1/maintenance-tasks?${filter}&limit=1&offset=0`).expect(200);
      expect(response.body.maintenanceTasks).toHaveLength(1);
      expect(response.body.maintenanceTasks[0].propertyId).toBe("property-land");
    }
    const firstPage = await request(runtime.app).get("/api/v1/properties?limit=1&offset=0").expect(200);
    const secondPage = await request(runtime.app).get("/api/v1/properties?limit=1&offset=1").expect(200);
    expect(firstPage.body.properties).toHaveLength(1);
    expect(secondPage.body.properties).toHaveLength(1);
    expect(secondPage.body.properties[0].id).not.toBe(firstPage.body.properties[0].id);
    const maintenancePlan = runtime.database.db.prepare(`EXPLAIN QUERY PLAN
      SELECT * FROM maintenance_tasks WHERE property_id = ?
      ORDER BY COALESCE(due_by, planned_for, '9999-12-31'), updated_at DESC, id
      LIMIT ? OFFSET ?`).all("property-land", 500, 0) as unknown as Array<{ detail: string }>;
    const maintenancePlanDetails = maintenancePlan.map((step) => step.detail).join("\n");
    expect(maintenancePlanDetails).toContain("idx_maintenance_tasks_property_list_order");
    expect(maintenancePlanDetails).not.toContain("TEMP B-TREE");
    await request(runtime.app).get("/api/v1/property-notes?limit=501").expect(400);
    await request(runtime.app).delete("/api/v1/properties/property-main").expect(409);
  });

  it("rejects malformed geometry and cross-property resource links", async () => {
    await createMainHouse(runtime);
    await request(runtime.app).post("/api/v1/properties").send({ id: "property-other", name: "Other" }).expect(201);
    await request(runtime.app).post("/api/v1/property-areas").send({
      id: "area-other",
      propertyId: "property-other",
      name: "Other yard",
      kind: "yard",
      polygon,
    }).expect(201);

    const smallParcel = [
      { latitude: 60.17, longitude: 24.93 },
      { latitude: 60.17, longitude: 24.93005 },
      { latitude: 60.17005, longitude: 24.93005 },
      { latitude: 60.17005, longitude: 24.93 },
    ];
    await request(runtime.app).post("/api/v1/property-areas").send({
      id: "area-small-garden",
      propertyId: "property-main",
      name: "Small garden",
      kind: "garden",
      polygon: smallParcel,
    }).expect(201);

    await request(runtime.app).post("/api/v1/property-areas").send({
      propertyId: "property-main",
      name: "Crossing",
      kind: "other",
      polygon: [polygon[0], polygon[2], polygon[1], polygon[3]],
    }).expect(422);
    await request(runtime.app).post("/api/v1/property-areas").send({
      propertyId: "property-main",
      name: "Repeated",
      kind: "other",
      polygon: [polygon[0], polygon[1], polygon[2], polygon[0]],
    }).expect(422);
    await request(runtime.app).post("/api/v1/area-equipment").send({
      propertyId: "property-main",
      areaId: "area-other",
      name: "Wrong pump",
      kind: "pump",
    }).expect(409);
    await request(runtime.app).post("/api/v1/maintenance-tasks").send({
      houseId: "house-main",
      areaId: "area-other",
      title: "Wrong property task",
      basis: "required",
    }).expect(409);

    await request(runtime.app).post("/api/v1/area-equipment").send({
      id: "equipment-scoped",
      propertyId: "property-main",
      areaId: "area-small-garden",
      name: "Scoped pump",
      kind: "pump",
    }).expect(201);
    await request(runtime.app).post("/api/v1/property-notes").send({
      propertyId: "property-main",
      equipmentId: "equipment-scoped",
      kind: "note",
      text: "Keep this equipment in the same property as its note.",
    }).expect(201);
    runtime.database.db.prepare("UPDATE property_areas SET property_id = ? WHERE id = ?")
      .run("property-other", "area-small-garden");
    expect(runtime.database.getPropertyArea("area-small-garden")?.propertyId).toBe("property-other");
    expect(runtime.database.getAreaEquipment("equipment-scoped")).toMatchObject({
      propertyId: "property-other",
      areaId: "area-small-garden",
    });
    expect(runtime.database.listPropertyNotes({ equipmentId: "equipment-scoped" })[0]).toMatchObject({
      propertyId: "property-other",
    });
    runtime.database.db.prepare("UPDATE area_equipment SET property_id = ?, area_id = ? WHERE id = ?")
      .run("property-other", "area-other", "equipment-scoped");
    expect(runtime.database.getAreaEquipment("equipment-scoped")).toMatchObject({
      propertyId: "property-other",
      areaId: "area-other",
    });
  });

  it("allows property-level notes but enforces one target at most", async () => {
    await request(runtime.app).post("/api/v1/property-areas").send({
      id: "area-yard",
      propertyId: "property-main",
      name: "Yard",
      kind: "yard",
      polygon,
    }).expect(201);
    const propertyNote = await request(runtime.app).post("/api/v1/property-notes").send({
      propertyId: "property-main",
      kind: "note",
      text: "General estate note",
    }).expect(201);
    expect(propertyNote.body.note).toMatchObject({ houseId: null, areaId: null, equipmentId: null });

    await request(runtime.app).post("/api/v1/property-notes").send({
      propertyId: "property-main",
      houseId: "house-main",
      areaId: "area-yard",
      kind: "note",
      text: "Ambiguous target",
    }).expect(422);
  });
});

describe("legacy property migration", () => {
  it("repairs non-empty orphan ownership IDs throughout an area aggregate", () => {
    const database = new ClimateDatabase(":memory:", false);
    try {
      database.createPropertyArea({ id: "legacy-area", propertyId: "property-main", name: "Legacy yard", kind: "yard", polygon });
      database.createAreaEquipment({ id: "legacy-equipment", areaId: "legacy-area", name: "Legacy pump", kind: "pump" });
      database.createPropertyNote({
        id: "legacy-note", propertyId: "property-main", equipmentId: "legacy-equipment", kind: "note", text: "Legacy context",
      });
      database.createMaintenanceTask({
        id: "legacy-task", propertyId: "property-main", areaId: "legacy-area", equipmentId: "legacy-equipment",
        title: "Legacy work", basis: "scheduled",
      });
      database.db.exec("PRAGMA foreign_keys = OFF");
      database.db.prepare("UPDATE property_areas SET property_id = ? WHERE id = ?")
        .run("missing-property", "legacy-area");
      database.db.exec("PRAGMA foreign_keys = ON");
      expect(database.db.prepare("PRAGMA foreign_key_check").all()).not.toEqual([]);

      database.migrate();

      expect(database.getPropertyArea("legacy-area")?.propertyId).toBe("property-main");
      expect(database.getAreaEquipment("legacy-equipment")?.propertyId).toBe("property-main");
      expect(database.getPropertyNote("legacy-note")?.propertyId).toBe("property-main");
      expect(database.getMaintenanceTask("legacy-task")).toMatchObject({
        propertyId: "property-main",
        revision: 2,
      });
      expect(database.listMaintenanceTaskRevisions("legacy-task").at(-1)).toMatchObject({
        actor: "system-service",
        changedFields: ["propertyId"],
        snapshot: { propertyId: "property-main", revision: 2 },
      });
      expect(database.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      database.migrate();
      expect(database.getPropertyArea("legacy-area")?.propertyId).toBe("property-main");
      expect(database.listMaintenanceTaskRevisions("legacy-task")).toHaveLength(2);
    } finally {
      database.db.exec("PRAGMA foreign_keys = ON");
      database.close();
    }
  });

  it("fails closed when maintenance revision history is orphaned", () => {
    const database = new ClimateDatabase(":memory:", false);
    try {
      database.db.exec("PRAGMA foreign_keys = OFF");
      database.db.prepare(`INSERT INTO maintenance_task_revisions
        (maintenance_task_id, revision, changed_at, actor, changed_fields_json, snapshot_json)
        VALUES (?, 1, ?, 'local-migration', '[]', '{}')`)
        .run("missing-task", new Date().toISOString());
      database.db.exec("PRAGMA foreign_keys = ON");

      expect(() => database.migrate()).toThrow(/ORPHANED_MAINTENANCE_REVISION/);
      expect(database.db.prepare(`SELECT maintenance_task_id, revision FROM maintenance_task_revisions
        WHERE maintenance_task_id = ?`).get("missing-task"))
        .toMatchObject({ maintenance_task_id: "missing-task", revision: 1 });
    } finally {
      database.db.exec("PRAGMA foreign_keys = ON");
      database.close();
    }
  });

  it("creates and idempotently backfills the default property for pre-property databases", () => {
    const directory = mkdtempSync(join(tmpdir(), "stuga-property-migration-"));
    const path = join(directory, "legacy.sqlite");
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`CREATE TABLE houses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        timezone TEXT NOT NULL,
        floors_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE maintenance_tasks (
        id TEXT PRIMARY KEY,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        floor_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        basis TEXT NOT NULL,
        basis_detail TEXT,
        priority TEXT NOT NULL,
        planned_for TEXT,
        due_by TEXT,
        status TEXT NOT NULL,
        completion_note TEXT,
        completed_at TEXT,
        verification_note TEXT,
        verified_at TEXT,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE maintenance_task_revisions (
        maintenance_task_id TEXT NOT NULL REFERENCES maintenance_tasks(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        changed_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        changed_fields_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY (maintenance_task_id, revision)
      );
      CREATE TRIGGER prevent_equipment_area_scope_orphans
        BEFORE UPDATE ON houses
        WHEN EXISTS (SELECT 1 FROM maintenance_tasks)
        BEGIN SELECT 1; END;
      CREATE TRIGGER cascade_property_area_scope_move
        AFTER UPDATE ON houses
        BEGIN UPDATE maintenance_tasks SET updated_at = NEW.updated_at WHERE house_id = NEW.id; END`);
      const timestamp = new Date().toISOString();
      legacy.prepare(`INSERT INTO houses
        (id, name, timezone, floors_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run("legacy-house", "Legacy", "Europe/Helsinki", JSON.stringify([]), timestamp, timestamp);
      legacy.prepare(`INSERT INTO maintenance_tasks(
        id, house_id, floor_id, title, description, basis, basis_detail, priority, planned_for, due_by,
        status, completion_note, completed_at, verification_note, verified_at, revision, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, NULL, ?, NULL, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, 1, ?, ?)`)
        .run("legacy-task", "legacy-house", "Inspect legacy roof", "required", "normal", "planned", timestamp, timestamp);
      legacy.prepare(`INSERT INTO maintenance_task_revisions(
        maintenance_task_id, revision, changed_at, actor, changed_fields_json, snapshot_json
      ) VALUES (?, 1, ?, 'local-rest', ?, ?)`)
        .run("legacy-task", timestamp, JSON.stringify(["title"]), JSON.stringify({
          id: "legacy-task",
          houseId: "legacy-house",
          floorId: null,
          areaId: null,
          equipmentId: null,
          title: "Inspect legacy roof",
          description: null,
          basis: "required",
          basisDetail: null,
          priority: "normal",
          plannedFor: null,
          dueBy: null,
          observationIds: [],
          status: "planned",
          completionNote: null,
          completedAt: null,
          verificationNote: null,
          verifiedAt: null,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        }));
      legacy.close();

      const migrated = new ClimateDatabase(path, false);
      expect(migrated.getProperty("property-main")).toMatchObject({ name: "My property" });
      expect(migrated.getHouse("legacy-house")).toMatchObject({ propertyId: "property-main" });
      expect(migrated.getMaintenanceTask("legacy-task")).toMatchObject({
        propertyId: "property-main",
        houseId: "legacy-house",
      });
      expect(migrated.listMaintenanceTaskRevisions("legacy-task")[0]?.snapshot).toMatchObject({
        propertyId: "property-main",
        houseId: "legacy-house",
      });
      const houseColumn = (migrated.db.prepare("PRAGMA table_info(maintenance_tasks)").all() as Array<{
        name: string;
        notnull: number;
      }>).find((column) => column.name === "house_id");
      expect(houseColumn?.notnull).toBe(0);
      expect(() => migrated.migrate()).not.toThrow();
      migrated.close();

      const reopened = new ClimateDatabase(path, false);
      expect(reopened.listProperties().filter((property) => property.id === "property-main")).toHaveLength(1);
      expect(reopened.getHouse("legacy-house")?.propertyId).toBe("property-main");
      expect(reopened.getMaintenanceTask("legacy-task")).toMatchObject({
        propertyId: "property-main",
        houseId: "legacy-house",
      });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
