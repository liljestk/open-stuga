import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ClimateDatabase } from "../src/db.js";
import { readIntegrationSecrets, writeIntegrationSecrets } from "../src/integration-secrets.js";
import { Nexus433Store } from "../src/nexus433/store.js";

const floor = (id: string) => ({
  id,
  name: "Ground floor",
  type: "ground" as const,
  width: 10,
  height: 8,
  elevation: 0,
  walls: [],
  rooms: [],
});

describe("House soft deletion boundary", () => {
  let directory: string | null = null;
  let runtime: ApiRuntime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  it("migrates an existing House table with a nullable deletion tombstone", () => {
    directory = mkdtempSync(join(tmpdir(), "stugu-house-soft-delete-migration-"));
    const databasePath = join(directory, "legacy.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`CREATE TABLE houses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      timezone TEXT NOT NULL,
      floors_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    legacy.prepare("INSERT INTO houses VALUES (?, ?, ?, ?, ?, ?)").run(
      "legacy-home",
      "Legacy Home",
      "UTC",
      JSON.stringify([floor("legacy-floor")]),
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    legacy.close();

    const database = new ClimateDatabase(databasePath, false);
    expect(database.getHouse("legacy-home")).toMatchObject({ id: "legacy-home", propertyId: "property-main" });
    expect(database.db.prepare("PRAGMA table_info(houses)").all()).toContainEqual(
      expect.objectContaining({ name: "deleted_at" }),
    );
    expect(database.db.prepare("SELECT deleted_at FROM houses WHERE id = ?").get("legacy-home"))
      .toEqual({ deleted_at: null });
    const visibleHousePlan = database.db.prepare(`EXPLAIN QUERY PLAN
      SELECT * FROM houses WHERE deleted_at IS NULL ORDER BY name`).all() as Array<{ detail: string }>;
    expect(visibleHousePlan.some((step) => step.detail.includes("idx_houses_visible_name"))).toBe(true);
    database.db.close();
  });

  it("hides only the selected Home and retains every row inside its boundary", async () => {
    directory = mkdtempSync(join(tmpdir(), "stugu-house-soft-delete-boundary-"));
    const databasePath = join(directory, "climate.sqlite");
    const secretsPath = join(directory, "private", "integration-secrets.json");
    const database = new ClimateDatabase(databasePath, false);
    database.ensureDefaultProperty();
    database.createProperty({ id: "property-other", name: "Other Property" });
    database.createHouse({
      id: "home-target", propertyId: "property-main", name: "A Target Home", timezone: "UTC", floors: [floor("target-floor")],
    });
    database.createHouse({
      id: "home-sibling", propertyId: "property-main", name: "Sibling Home", timezone: "UTC", floors: [floor("sibling-floor")],
    });
    database.createHouse({
      id: "home-other", propertyId: "property-other", name: "Other Home", timezone: "UTC", floors: [floor("other-floor")],
    });
    database.db.close();

    writeIntegrationSecrets(secretsPath, {
      version: 1,
      homeAssistant: { url: "http://legacy-ha.local:8123", token: "legacy-ha-token" },
      tpLink: { host: "192.0.2.30", username: "legacy@example.test", password: "legacy-secret" },
      homeAssistantConnections: [
        { houseId: "home-target", url: "http://target-ha.local:8123", token: "target-ha-token" },
        { houseId: "home-sibling", url: "http://sibling-ha.local:8123", token: "sibling-ha-token" },
      ],
      tpLinkConnections: [
        { id: "target-tapo", houseId: "home-target", host: "192.0.2.10", username: "target@example.test", password: "target-secret" },
        { id: "other-tapo", houseId: "home-other", host: "192.0.2.20", username: "other@example.test", password: "other-secret" },
      ],
      appleNotesGrants: [{
        id: "target-notes",
        tokenHash: `sha256:${"a".repeat(64)}`,
        deviceLabel: "Target phone",
        houseId: "home-target",
        createdAt: "2026-08-01T10:00:00.000Z",
      }],
    });

    runtime = createApi({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: databasePath,
        INTEGRATION_SECRETS_FILE: secretsPath,
        MOCK_ENABLED: "false",
      }),
      database: new ClimateDatabase(databasePath, false),
      startBackground: false,
    });

    const createSensor = (id: string, houseId: string, floorId: string) => request(runtime!.app)
      .post("/api/v1/sensors")
      .send({ id, houseId, floorId, name: id, room: "Room", model: "Test", x: 1, y: 1, z: 1, tags: [], enabled: true })
      .expect(201);
    await createSensor("sensor-target", "home-target", "target-floor");
    await createSensor("sensor-sibling", "home-sibling", "sibling-floor");
    await createSensor("sensor-other", "home-other", "other-floor");
    runtime.database.insertReadings([
      {
        sensorId: "sensor-target", timestamp: "2026-08-01T10:00:00.000Z", temperature: 21, humidity: 45,
        battery: 90, source: "api", quality: "good",
      },
      {
        sensorId: "sensor-sibling", timestamp: "2026-08-01T10:00:00.000Z", temperature: 22, humidity: 44,
        battery: 91, source: "api", quality: "good",
      },
    ]);
    await request(runtime.app).post("/api/v1/observations").send({
      id: "observation-target", houseId: "home-target", floorId: "target-floor",
      kind: "note", severity: "info", note: "Retained target observation",
    }).expect(201);
    await request(runtime.app).post("/api/v1/area-equipment").send({
      id: "equipment-target", houseId: "home-target", name: "Property boiler", kind: "heating",
    }).expect(201);
    await request(runtime.app).post("/api/v1/property-notes").send({
      id: "note-target", propertyId: "property-main", houseId: "home-target",
      kind: "note", text: "Property-owned note retained after the Home is hidden.",
    }).expect(201);
    await request(runtime.app).post("/api/v1/maintenance-tasks").send({
      id: "task-target", propertyId: "property-main", houseId: "home-target", equipmentId: "equipment-target",
      observationIds: ["observation-target"], title: "Inspect retained boiler", basis: "condition-based",
    }).expect(201);
    await request(runtime.app).post("/api/v1/parameters").send({
      houseId: "home-target", scopeType: "house", scopeId: "home-target",
      key: "construction", value: "timber", unit: null, label: "Construction",
    }).expect(200);
    const asset = await request(runtime.app).post("/api/v1/assets").send({
      houseId: "home-target", name: "target-plan.png", mimeType: "image/png", kind: "floor-plan",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
    }).expect(201);
    const nexus433 = new Nexus433Store(runtime.database);
    expect(nexus433.setEnabled("home-target", true)).toMatchObject({ house_id: "home-target", enabled: 1 });

    const unaffectedBefore = {
      properties: runtime.database.db.prepare("SELECT * FROM properties ORDER BY id").all(),
      houses: runtime.database.db.prepare("SELECT * FROM houses WHERE id <> 'home-target' ORDER BY id").all(),
      sensors: runtime.database.db.prepare("SELECT * FROM sensors WHERE house_id <> 'home-target' ORDER BY id").all(),
      readings: runtime.database.db.prepare(`SELECT reading.* FROM readings AS reading
        JOIN sensors AS sensor ON sensor.id = reading.sensor_id WHERE sensor.house_id <> 'home-target' ORDER BY reading.id`).all(),
    };
    const retainedCountsBefore = runtime.database.db.prepare(`SELECT
      (SELECT COUNT(*) FROM houses WHERE id = 'home-target') AS houses,
      (SELECT COUNT(*) FROM sensors WHERE house_id = 'home-target') AS sensors,
      (SELECT COUNT(*) FROM readings WHERE sensor_id = 'sensor-target') AS readings,
      (SELECT COUNT(*) FROM measurement_samples WHERE sensor_id = 'sensor-target') AS measurements,
      (SELECT COUNT(*) FROM observations WHERE house_id = 'home-target') AS observations,
      (SELECT COUNT(*) FROM static_parameters WHERE house_id = 'home-target') AS parameters,
      (SELECT COUNT(*) FROM assets WHERE house_id = 'home-target') AS assets`).get();

    await request(runtime.app).delete("/api/v1/houses/home-target").expect(204);

    expect(runtime.database.db.prepare("SELECT deleted_at FROM houses WHERE id = 'home-target'").get())
      .toMatchObject({ deleted_at: expect.any(String) });
    expect(runtime.database.db.prepare(`SELECT
      (SELECT COUNT(*) FROM houses WHERE id = 'home-target') AS houses,
      (SELECT COUNT(*) FROM sensors WHERE house_id = 'home-target') AS sensors,
      (SELECT COUNT(*) FROM readings WHERE sensor_id = 'sensor-target') AS readings,
      (SELECT COUNT(*) FROM measurement_samples WHERE sensor_id = 'sensor-target') AS measurements,
      (SELECT COUNT(*) FROM observations WHERE house_id = 'home-target') AS observations,
      (SELECT COUNT(*) FROM static_parameters WHERE house_id = 'home-target') AS parameters,
      (SELECT COUNT(*) FROM assets WHERE house_id = 'home-target') AS assets`).get()).toEqual(retainedCountsBefore);
    expect({
      properties: runtime.database.db.prepare("SELECT * FROM properties ORDER BY id").all(),
      houses: runtime.database.db.prepare("SELECT * FROM houses WHERE id <> 'home-target' ORDER BY id").all(),
      sensors: runtime.database.db.prepare("SELECT * FROM sensors WHERE house_id <> 'home-target' ORDER BY id").all(),
      readings: runtime.database.db.prepare(`SELECT reading.* FROM readings AS reading
        JOIN sensors AS sensor ON sensor.id = reading.sensor_id WHERE sensor.house_id <> 'home-target' ORDER BY reading.id`).all(),
    }).toEqual(unaffectedBefore);

    await request(runtime.app).get("/api/v1/houses/home-target").expect(404);
    const houses = await request(runtime.app).get("/api/v1/houses").expect(200);
    expect(houses.body.houses.map((item: { id: string }) => item.id).sort()).toEqual(["home-other", "home-sibling"]);
    const sensors = await request(runtime.app).get("/api/v1/sensors/snapshots").expect(200);
    expect(sensors.body.sensors.map((item: { id: string }) => item.id).sort()).toEqual(["sensor-other", "sensor-sibling"]);
    await request(runtime.app).get("/api/v2/measurements/history?sensorId=sensor-target&metric=temperature").expect(404);
    await request(runtime.app).get("/api/v2/measurements/history?sensorId=sensor-sibling&metric=temperature").expect(200);
    expect(runtime.database.getLatestReading("sensor-target")).toBeNull();
    expect(runtime.database.latestReadings().map((reading) => reading.sensorId)).not.toContain("sensor-target");
    expect(runtime.database.measurementHistory(
      "sensor-target", "temperature", "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z",
    )).toEqual([]);
    expect(runtime.database.insertReadings([{
      sensorId: "sensor-target", timestamp: "2026-08-01T10:01:00.000Z", temperature: 99, humidity: 1,
      battery: 1, source: "api", quality: "good",
    }])).toEqual([]);
    expect(runtime.database.db.prepare("SELECT COUNT(*) AS count FROM readings WHERE sensor_id = 'sensor-target'").get())
      .toEqual({ count: 1 });
    expect(runtime.database.db.prepare(`SELECT house_id, enabled FROM external_source_gateways
      WHERE house_id = 'home-target'`).get()).toEqual({ house_id: "home-target", enabled: 0 });
    expect(nexus433.enabledGateway()).toBeNull();
    expect(nexus433.setEnabled("home-other", true)).toMatchObject({ house_id: "home-other", enabled: 1 });
    await request(runtime.app).get("/api/v1/observations?houseId=home-target").expect(200)
      .expect(({ body }) => expect(body.observations).toEqual([]));
    await request(runtime.app).get("/api/v1/parameters?houseId=home-target").expect(200)
      .expect(({ body }) => expect(body.parameters).toEqual([]));
    await request(runtime.app).get("/api/v1/assets?houseId=home-target").expect(200)
      .expect(({ body }) => expect(body.assets).toEqual([]));
    await request(runtime.app).get(asset.body.url).expect(404);

    await request(runtime.app).get("/api/v1/maintenance-tasks/task-target").expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ id: "task-target", propertyId: "property-main" }));
    await request(runtime.app).get("/api/v1/area-equipment?houseId=home-target").expect(200)
      .expect(({ body }) => expect(body.equipment).toEqual([expect.objectContaining({ id: "equipment-target" })]));
    await request(runtime.app).get("/api/v1/property-notes?houseId=home-target").expect(200)
      .expect(({ body }) => expect(body.notes).toEqual([expect.objectContaining({ id: "note-target" })]));

    await request(runtime.app).patch("/api/v1/area-equipment/equipment-target")
      .send({ houseId: "home-target", areaId: null, name: "Retained property boiler" })
      .expect(200)
      .expect(({ body }) => expect(body.equipment).toMatchObject({
        id: "equipment-target", houseId: "home-target", name: "Retained property boiler",
      }));
    await request(runtime.app).patch("/api/v1/property-notes/note-target")
      .send({
        houseId: "home-target",
        areaId: null,
        equipmentId: null,
        kind: "note",
        text: "The retained note is still editable.",
      })
      .expect(200)
      .expect(({ body }) => expect(body.note).toMatchObject({
        id: "note-target", houseId: "home-target", text: "The retained note is still editable.",
      }));
    await request(runtime.app).patch("/api/v1/maintenance-tasks/task-target")
      .send({
        baseRevision: 1,
        houseId: "home-target",
        floorId: null,
        observationIds: ["observation-target"],
        title: "Inspect the retained property boiler",
      })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        id: "task-target",
        houseId: "home-target",
        observationIds: ["observation-target"],
        revision: 2,
      }));

    await request(runtime.app).patch("/api/v1/maintenance-tasks/task-target")
      .send({ baseRevision: 2, houseId: null, floorId: null, observationIds: [] })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ houseId: null, observationIds: [], revision: 3 }));
    await request(runtime.app).patch("/api/v1/area-equipment/equipment-target")
      .send({ houseId: null })
      .expect(200)
      .expect(({ body }) => expect(body.equipment).toMatchObject({ houseId: null }));
    await request(runtime.app).patch("/api/v1/property-notes/note-target")
      .send({ houseId: "home-sibling" })
      .expect(200)
      .expect(({ body }) => expect(body.note).toMatchObject({ houseId: "home-sibling" }));
    await request(runtime.app).patch("/api/v1/maintenance-tasks/task-target")
      .send({ baseRevision: 3, houseId: "home-sibling" })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ houseId: "home-sibling", revision: 4 }));

    await request(runtime.app).patch("/api/v1/area-equipment/equipment-target")
      .send({ houseId: "home-target" })
      .expect(404);
    await request(runtime.app).patch("/api/v1/property-notes/note-target")
      .send({ houseId: "home-target" })
      .expect(404);
    await request(runtime.app).patch("/api/v1/maintenance-tasks/task-target")
      .send({ baseRevision: 4, houseId: "home-target" })
      .expect(404);

    const secrets = readIntegrationSecrets(secretsPath);
    expect(secrets.homeAssistantConnections).toEqual([
      expect.objectContaining({ houseId: "home-sibling", token: "sibling-ha-token" }),
    ]);
    expect(secrets.homeAssistant).toBeUndefined();
    expect(secrets.homeAssistantLegacyDisabled).toBe(true);
    expect(secrets.tpLinkConnections).toEqual([
      expect.objectContaining({ id: "other-tapo", houseId: "home-other", password: "other-secret" }),
    ]);
    expect(secrets.tpLink).toBeUndefined();
    expect(secrets.tpLinkLegacyDisabled).toBe(true);
    expect(secrets.appleNotesGrants).toEqual([]);
    expect(secrets.hiddenHouseData).toEqual([
      expect.objectContaining({
        houseId: "home-target",
        hiddenAt: expect.any(String),
        homeAssistant: expect.objectContaining({ token: "legacy-ha-token" }),
        tpLink: expect.objectContaining({ password: "legacy-secret" }),
        homeAssistantConnections: [expect.objectContaining({ token: "target-ha-token" })],
        tpLinkConnections: [expect.objectContaining({ password: "target-secret" })],
        appleNotesGrants: [expect.objectContaining({ id: "target-notes" })],
      }),
    ]);
  });
});
