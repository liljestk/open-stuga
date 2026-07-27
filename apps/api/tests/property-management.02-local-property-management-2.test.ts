import { mkdtempSync, rmSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";

import request from "supertest";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApi, type ApiRuntime } from "../src/app.js";

import { loadConfig } from "../src/config.js";

import { ClimateDatabase } from "../src/db.js";

import { createMainHouse, polygon } from "./property-managementTestSupport.js";

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
  it("upgrades the legacy Area-only equipment table without losing records", () => {
    const migrated = new ClimateDatabase(":memory:", false);
    try {
      migrated.createPropertyArea({
        id: "legacy-area",
        propertyId: "property-main",
        name: "Legacy yard",
        kind: "yard",
        polygon,
      });
      migrated.createAreaEquipment({
        id: "legacy-equipment",
        areaId: "legacy-area",
        name: "Legacy tractor",
        kind: "vehicle",
      });
      migrated.db.exec(`PRAGMA foreign_keys = OFF;
        DROP TABLE area_equipment;
        CREATE TABLE area_equipment (
          id TEXT PRIMARY KEY,
          property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
          area_id TEXT NOT NULL REFERENCES property_areas(id) ON DELETE RESTRICT,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          manufacturer TEXT,
          model TEXT,
          serial_number TEXT,
          status TEXT NOT NULL,
          notes TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );`);
      const timestamp = new Date().toISOString();
      migrated.db.prepare(`INSERT INTO area_equipment
        (id, property_id, area_id, name, kind, manufacturer, model, serial_number, status, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 'active', NULL, ?, ?)`)
        .run("legacy-equipment", "property-main", "legacy-area", "Legacy tractor", "vehicle", timestamp, timestamp);
      (migrated as unknown as { migrateEquipmentPlacementTable(): void }).migrateEquipmentPlacementTable();
      migrated.migrate();
      expect(migrated.getAreaEquipment("legacy-equipment")).toMatchObject({
        propertyId: "property-main",
        areaId: "legacy-area",
        houseId: null,
        name: "Legacy tractor",
      });
      const columns = migrated.db.prepare("PRAGMA table_info(area_equipment)").all() as Array<{
        name: string;
        notnull: number;
      }>;
      expect(columns.find((column) => column.name === "area_id")?.notnull).toBe(0);
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["house_id", "location_json"]));
      expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      migrated.close();
    }
  });

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
    const directory = mkdtempSync(join(tmpdir(), "stugu-property-migration-"));
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
