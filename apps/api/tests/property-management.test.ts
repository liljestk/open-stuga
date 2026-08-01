import { mkdtempSync, rmSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";

import request from "supertest";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApi, type ApiRuntime } from "../src/app.js";

import { loadConfig } from "../src/config.js";

import { ClimateDatabase, outdoorLocationKey } from "../src/db.js";

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
      tenant: { id: "local", name: "Local Stugu", role: "owner" },
      availableTenants: [{ id: "local", name: "Local Stugu", role: "owner" }],
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

  it("uses Property weather by default while preserving advanced Home overrides", async () => {
    const home = {
      id: "weather-home",
      propertyId: "property-main",
      name: "Weather home",
      timezone: "Europe/Helsinki",
      floors: [{ id: "ground", name: "Ground", width: 10, height: 8, elevation: 0, walls: [], rooms: [] }],
    };
    await request(runtime.app).post("/api/v1/houses").send(home).expect(201)
      .expect(({ body }) => expect(body.house).not.toHaveProperty("location"));
    const placed = await request(runtime.app).post("/api/v1/houses").send({
      ...home,
      id: "placed-weather-home",
      name: "Placed weather home",
      mapPlacement: { latitude: 60.1, longitude: 24.8, metersPerPlanUnit: 0.1 },
    }).expect(201);
    expect(placed.body.house.location).toMatchObject({
      latitude: 60.1,
      longitude: 24.8,
      source: "map-placement",
      userOverridden: false,
    });

    await request(runtime.app).patch("/api/v1/properties/property-main").send({
      location: { latitude: 60.17, longitude: 24.94, label: "Helsinki" },
    }).expect(200);
    expect(runtime.database.getHouse(home.id)?.location).toMatchObject({
      latitude: 60.17,
      longitude: 24.94,
      source: "property-location",
      userOverridden: false,
    });
    expect(runtime.database.getHouse("placed-weather-home")?.location).toMatchObject({
      latitude: 60.17,
      longitude: 24.94,
      source: "property-location",
    });

    await request(runtime.app).patch(`/api/v1/houses/${home.id}`).send({
      location: { latitude: 61.5, longitude: 25.25, source: "manual", userOverridden: true },
    }).expect(200);
    await request(runtime.app).patch("/api/v1/properties/property-main").send({
      location: { latitude: 62.1, longitude: 26.2, label: "New default" },
    }).expect(200);
    expect(runtime.database.getHouse(home.id)?.location).toMatchObject({
      latitude: 61.5,
      longitude: 25.25,
      source: "manual",
      userOverridden: true,
    });

    const inherited = await request(runtime.app).post("/api/v1/houses").send({
      ...home,
      id: "inherited-weather-home",
      name: "Inherited weather home",
    }).expect(201);
    expect(inherited.body.house.location).toMatchObject({
      latitude: 62.1,
      longitude: 26.2,
      source: "property-location",
    });
    const reset = await request(runtime.app).patch(`/api/v1/houses/${home.id}`).send({ location: null }).expect(200);
    expect(reset.body.house.location).toMatchObject({ latitude: 62.1, longitude: 26.2, source: "property-location" });
  });

  it("updates inherited weather without erasing prior location-keyed Home history", async () => {
    const firstLocation = { latitude: 60.17, longitude: 24.94, label: "Helsinki" };
    await request(runtime.app).patch("/api/v1/properties/property-main")
      .send({ location: firstLocation })
      .expect(200);
    await request(runtime.app).post("/api/v1/houses").send({
      id: "weather-history-home",
      propertyId: "property-main",
      name: "Weather history home",
      timezone: "Europe/Helsinki",
      floors: [{ id: "ground", name: "Ground", width: 10, height: 8, elevation: 0, walls: [], rooms: [] }],
    }).expect(201);

    const firstKey = outdoorLocationKey(firstLocation);
    runtime.database.upsertOutdoorTemperatureSample({
      houseId: "weather-history-home",
      locationKey: firstKey,
      timestamp: "2026-07-14T08:00:00.000Z",
      temperatureC: 17.5,
      source: "api",
      fetchedAt: "2026-07-14T08:01:00.000Z",
      stationId: null,
      stationName: null,
    });
    runtime.database.noteWeatherOutage(
      "weather-history-home",
      firstKey,
      "fmi",
      "observation",
      "Historical test outage",
      "2026-07-14T09:00:00.000Z",
    );
    runtime.database.db.prepare(`INSERT INTO analytics_daily_findings
      (house_id, data_mode, evaluated_through, generated_at, algorithm_version, snapshot_json, last_attempt_at, last_error)
      VALUES (?, 'live', ?, ?, 'test-v1', '{}', ?, NULL)`)
      .run(
        "weather-history-home",
        "2026-07-14T10:00:00.000Z",
        "2026-07-14T10:01:00.000Z",
        "2026-07-14T10:01:00.000Z",
      );

    const nextLocation = { latitude: 62.1, longitude: 26.2, label: "New default" };
    await request(runtime.app).patch("/api/v1/properties/property-main")
      .send({ location: nextLocation })
      .expect(200);

    expect(runtime.database.getHouse("weather-history-home")?.location).toMatchObject({
      ...nextLocation,
      source: "property-location",
      userOverridden: false,
    });
    expect(outdoorLocationKey(runtime.database.getHouse("weather-history-home")?.location))
      .not.toBe(firstKey);
    expect(runtime.database.outdoorTemperatureHistory(
      "weather-history-home",
      firstKey,
      "2026-07-14T00:00:00.000Z",
      "2026-07-15T00:00:00.000Z",
    )).toHaveLength(1);
    expect(runtime.database.listWeatherOutages("weather-history-home", firstKey)).toHaveLength(1);
    expect(runtime.database.db.prepare("SELECT 1 FROM analytics_daily_findings WHERE house_id = ?")
      .get("weather-history-home")).toBeUndefined();
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

  it("keeps an inventory item's saved Home, Area, pin, and live tracking identity separate", async () => {
    await createMainHouse(runtime);
    await request(runtime.app).post("/api/v1/property-areas").send({
      id: "area-yard",
      propertyId: "property-main",
      name: "Yard",
      kind: "yard",
      polygon,
    }).expect(201);

    const unassigned = await request(runtime.app).post("/api/v1/area-equipment").send({
      id: "equipment-unassigned",
      propertyId: "property-main",
      name: "Portable generator",
      kind: "generator",
      location: { latitude: 60.171, longitude: 24.931 },
    }).expect(201);
    expect(unassigned.body.equipment).toMatchObject({
      propertyId: "property-main",
      areaId: null,
      houseId: null,
      location: { latitude: 60.171, longitude: 24.931 },
    });

    const atHome = await request(runtime.app).post("/api/v1/area-equipment").send({
      id: "equipment-home",
      houseId: "house-main",
      name: "Boiler",
      kind: "heating",
    }).expect(201);
    expect(atHome.body.equipment).toMatchObject({
      propertyId: "property-main",
      areaId: null,
      houseId: "house-main",
    });
    await request(runtime.app).post("/api/v1/area-equipment").send({
      areaId: "area-yard",
      houseId: "house-main",
      name: "Ambiguous",
      kind: "tool",
    }).expect(422).expect(({ body }) => expect(body.error.code).toBe("INVALID_EQUIPMENT_LOCATION"));

    const homeFilter = await request(runtime.app)
      .get("/api/v1/area-equipment?houseId=house-main").expect(200);
    expect(homeFilter.body.equipment.map((item: { id: string }) => item.id)).toEqual(["equipment-home"]);
    const atArea = await request(runtime.app).patch("/api/v1/area-equipment/equipment-home").send({
      areaId: "area-yard",
    }).expect(200);
    expect(atArea.body.equipment).toMatchObject({ areaId: "area-yard", houseId: null });

    const backHome = await request(runtime.app).patch("/api/v1/area-equipment/equipment-home").send({
      houseId: "house-main",
    }).expect(200);
    expect(backHome.body.equipment).toMatchObject({ areaId: null, houseId: "house-main" });

    const manuallyPlaced = await request(runtime.app).patch("/api/v1/area-equipment/equipment-home").send({
      areaId: null,
      houseId: null,
      location: { latitude: 60.172, longitude: 24.932 },
    }).expect(200);
    expect(manuallyPlaced.body.equipment).toMatchObject({
      areaId: null,
      houseId: null,
      location: { latitude: 60.172, longitude: 24.932 },
    });
    await request(runtime.app).patch("/api/v1/area-equipment/equipment-home").send({
      location: { latitude: 95, longitude: 24 },
    }).expect(422).expect(({ body }) => expect(body.error.code).toBe("INVALID_EQUIPMENT_LOCATION"));

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-secondary",
      propertyId: "property-main",
      name: "Secondary Home",
      timezone: "Europe/Helsinki",
      floors: [{ id: "floor-secondary", name: "Ground", type: "ground", width: 10, height: 8, elevation: 0, walls: [], rooms: [] }],
    }).expect(201);
    await request(runtime.app).post("/api/v1/observations").send({
      id: "observation-equipment-home",
      houseId: "house-main",
      floorId: "floor-ground",
      kind: "maintenance",
      severity: "info",
      note: "Boiler observed in the main Home",
    }).expect(201);
    await request(runtime.app).post("/api/v1/maintenance-tasks").send({
      id: "task-equipment-home",
      propertyId: "property-main",
      houseId: "house-main",
      equipmentId: "equipment-home",
      observationIds: ["observation-equipment-home"],
      title: "Inspect boiler",
      basis: "condition-based",
    }).expect(201);
    await request(runtime.app).patch("/api/v1/area-equipment/equipment-home").send({
      houseId: "house-secondary",
    }).expect(409).expect(({ body }) => {
      expect(body.error.code).toBe("MAINTENANCE_OBSERVATION_SCOPE_MISMATCH");
    });
    expect(runtime.database.getAreaEquipment("equipment-home")).toMatchObject({
      areaId: null,
      houseId: null,
      location: { latitude: 60.172, longitude: 24.932 },
    });
  });

  it("stores optional equipment photos, documents, and relevant links", async () => {
    await request(runtime.app).post("/api/v1/area-equipment").send({
      id: "equipment-boiler",
      propertyId: "property-main",
      name: "Boiler",
      kind: "heating",
    }).expect(201);

    const before = await request(runtime.app)
      .get("/api/v1/properties/property-main/inventory")
      .expect(200);
    expect(before.body.inventory).toMatchObject({ attachments: [], links: [] });

    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const photo = await request(runtime.app)
      .post("/api/v1/area-equipment/equipment-boiler/attachments")
      .send({
        kind: "photo",
        name: "Boiler front.png",
        mimeType: "image/png",
        data: `data:image/png;base64,${png}`,
      })
      .expect(201);
    expect(photo.body).toMatchObject({
      attachment: {
        equipmentId: "equipment-boiler",
        kind: "photo",
        name: "Boiler front.png",
        mimeType: "image/png",
        size: expect.any(Number),
      },
      url: expect.stringContaining(`/equipment-boiler/attachments/${photo.body.attachment.id}`),
    });
    await request(runtime.app)
      .post("/api/v1/area-equipment/equipment-boiler/attachments")
      .send({
        kind: "photo",
        name: "Unsafe.svg",
        mimeType: "image/svg+xml",
        data: Buffer.from("<svg/>").toString("base64"),
      })
      .expect(415)
      .expect(({ body }) => expect(body.error.code).toBe("UNSUPPORTED_ATTACHMENT_TYPE"));
    await request(runtime.app)
      .post("/api/v1/area-equipment/equipment-boiler/attachments")
      .send({
        kind: "document",
        name: "Broken.pdf",
        mimeType: "application/pdf",
        data: "not base64",
      })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("INVALID_ATTACHMENT"));

    const manualBytes = Buffer.from("%PDF-1.4\nTest manual\n", "utf8");
    const manual = await request(runtime.app)
      .post("/api/v1/area-equipment/equipment-boiler/attachments")
      .send({
        kind: "document",
        name: "Installation manual.pdf",
        mimeType: "application/pdf",
        data: manualBytes.toString("base64"),
      })
      .expect(201);
    expect(manual.body.attachment).toMatchObject({
      equipmentId: "equipment-boiler",
      kind: "document",
      size: manualBytes.length,
    });

    const createdLink = await request(runtime.app)
      .post("/api/v1/area-equipment/equipment-boiler/links")
      .send({ label: "Manufacturer support", url: "https://example.test/boiler" })
      .expect(201);
    expect(createdLink.body.link).toMatchObject({
      equipmentId: "equipment-boiler",
      label: "Manufacturer support",
      url: "https://example.test/boiler",
    });
    await request(runtime.app)
      .post("/api/v1/area-equipment/equipment-boiler/links")
      .send({ label: "Unsafe", url: "javascript:alert(1)" })
      .expect(422)
      .expect(({ body }) => expect(body.error.code).toBe("INVALID_EQUIPMENT_LINK"));

    await request(runtime.app)
      .get("/api/v1/area-equipment/equipment-boiler/attachments")
      .expect(200)
      .expect(({ body }) => {
        expect(body.attachments).toHaveLength(2);
        expect(body.attachments).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: photo.body.attachment.id, kind: "photo" }),
          expect.objectContaining({ id: manual.body.attachment.id, kind: "document" }),
        ]));
      });
    await request(runtime.app)
      .get("/api/v1/area-equipment/equipment-boiler/links")
      .expect(200)
      .expect(({ body }) => expect(body.links).toEqual([
        expect.objectContaining({ id: createdLink.body.link.id }),
      ]));

    const downloaded = await request(runtime.app)
      .get(`/api/v1/area-equipment/equipment-boiler/attachments/${manual.body.attachment.id}`)
      .expect(200);
    expect(downloaded.headers["content-type"]).toMatch(/^application\/pdf/);
    expect(downloaded.headers["content-disposition"]).toContain("attachment;");
    expect(downloaded.headers["content-disposition"]).toContain("filename*=UTF-8''");
    expect(Buffer.from(downloaded.body)).toEqual(manualBytes);
    await request(runtime.app)
      .get(`/api/v1/area-equipment/another-item/attachments/${manual.body.attachment.id}`)
      .expect(404);

    const updatedLink = await request(runtime.app)
      .patch(`/api/v1/area-equipment/equipment-boiler/links/${createdLink.body.link.id}`)
      .send({ label: "Service and support" })
      .expect(200);
    expect(updatedLink.body.link).toMatchObject({
      label: "Service and support",
      url: "https://example.test/boiler",
    });

    const after = await request(runtime.app)
      .get("/api/v1/properties/property-main/inventory")
      .expect(200);
    expect(after.body.inventory.attachments).toHaveLength(2);
    expect(after.body.inventory.links).toEqual([
      expect.objectContaining({ label: "Service and support" }),
    ]);
    expect(after.body.inventory.syncToken).not.toBe(before.body.inventory.syncToken);

    await request(runtime.app)
      .delete(`/api/v1/area-equipment/equipment-boiler/attachments/${photo.body.attachment.id}`)
      .expect(204);
    await request(runtime.app)
      .delete(`/api/v1/area-equipment/equipment-boiler/links/${createdLink.body.link.id}`)
      .expect(204);
    await request(runtime.app).delete("/api/v1/area-equipment/equipment-boiler").expect(204);
    expect(runtime.database.listEquipmentAttachments({ equipmentId: "equipment-boiler" })).toEqual([]);
    expect(runtime.database.listEquipmentLinks({ equipmentId: "equipment-boiler" })).toEqual([]);
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
    const inventoryBeforeMove = await request(runtime.app)
      .get("/api/v1/properties/property-island/inventory").expect(200);
    expect(inventoryBeforeMove.body.inventory).toMatchObject({
      propertyId: "property-island",
      syncToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      areas: [expect.objectContaining({ id: "area-well" })],
      equipment: [expect.objectContaining({ id: "equipment-pump", areaId: "area-well" })],
    });
    await request(runtime.app)
      .get("/api/v1/properties/property-island/inventory")
      .set("If-None-Match", inventoryBeforeMove.headers.etag)
      .expect(304);
    await request(runtime.app)
      .get("/api/v1/properties/property-island/inventory")
      .set("If-None-Match", `W/${inventoryBeforeMove.headers.etag}`)
      .expect(304);

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
    const inventoryAfterMove = await request(runtime.app)
      .get("/api/v1/properties/property-island/inventory").expect(200);
    expect(inventoryAfterMove.body.inventory.syncToken)
      .not.toBe(inventoryBeforeMove.body.inventory.syncToken);
    expect(inventoryAfterMove.body.inventory.equipment).toEqual([
      expect.objectContaining({ id: "equipment-pump", areaId: "area-garden" }),
    ]);
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
});
