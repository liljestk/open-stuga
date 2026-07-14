import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createApi, type ApiRuntime } from "../src/app.js";

const config: AppConfig = {
  port: 0,
  apiHost: "127.0.0.1",
  databasePath: ":memory:",
  integrationSecretsFile: "integration-secrets.test.json",
  assetDirectory: ".",
  mockEnabled: false,
  mockIntervalMs: 25,
  retentionDays: 730,
  ingestApiKey: "test-ingest-key",
  haUrl: null,
  haToken: null,
  haEntityMapFile: null,
  tpLinkHost: null,
  tpLinkUsername: null,
  tpLinkPassword: null,
  tpLinkDeviceMapFile: null,
  tpLinkPollIntervalMs: 10_000,
  tpLinkPython: "python",
  tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
  alertWebhookUrl: null,
  alertWebhookBearerToken: null,
  corsOrigin: "http://localhost:5173",
};

describe("Climate Twin API v1", () => {
  let runtime: ApiRuntime;

  beforeEach(() => {
    runtime = createApi({ config, startBackground: false });
  });

  afterEach(() => {
    runtime.close();
  });

  it("binds to loopback by default and honors an explicit API host", () => {
    expect(loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }).apiHost).toBe("127.0.0.1");
    expect(loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", API_HOST: "0.0.0.0" }).apiHost).toBe("0.0.0.0");
    expect(loadConfig({ NODE_ENV: "production", DATABASE_PATH: ":memory:" }).mockEnabled).toBe(true);
    expect(loadConfig({ NODE_ENV: "production", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false" }).mockEnabled).toBe(false);
  });

  it("boots with one digital twin, ten positioned sensors, and durable seed history", async () => {
    const houses = await request(runtime.app).get("/api/v1/houses").expect(200);
    expect(houses.body.houses).toHaveLength(1);
    expect(houses.body.houses[0].floors).toHaveLength(2);

    const snapshots = await request(runtime.app).get("/api/v1/sensors/snapshots").expect(200);
    expect(snapshots.body.sensors).toHaveLength(10);
    expect(snapshots.body.sensors.every((sensor: { reading: unknown }) => sensor.reading !== null)).toBe(true);

    const history = await request(runtime.app)
      .get("/api/v1/history")
      .query({ sensorId: "sensor-01", limit: 500 })
      .expect(200);
    expect(history.body.series[0].readings.length).toBeGreaterThan(250);
  });

  it("validates sensor house/floor membership and each floor's unequal local footprint", async () => {
    const floors = [
      { id: "basement", name: "Basement", width: 8, height: 5, elevation: -3.2, walls: [], rooms: [] },
      { id: "loft", name: "Loft", width: 3, height: 2, elevation: 4.5, walls: [], rooms: [] },
    ];
    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-unequal", name: "Unequal footprints", timezone: "Europe/Helsinki", floors,
    }).expect(201);

    const sensor = (overrides: Record<string, unknown>) => ({
      houseId: "house-unequal", floorId: "basement", name: "Placed sensor", room: "Room", model: "Tapo",
      x: 8, y: 5, z: -2.4, tags: [], enabled: true, ...overrides,
    });
    await request(runtime.app).post("/api/v1/sensors").send(sensor({ id: "basement-boundary" })).expect(201);
    await request(runtime.app).post("/api/v1/sensors").send(sensor({
      id: "loft-below-plane", floorId: "loft", x: 3, y: 2, z: -10,
    })).expect(201);
    await request(runtime.app).post("/api/v1/sensors").send(sensor({
      id: "loft-above-plane", floorId: "loft", x: 1, y: 1, z: 30,
    })).expect(201);

    await request(runtime.app).post("/api/v1/sensors").send(sensor({
      id: "outside-small-loft", floorId: "loft", x: 3.01, y: 1, z: 5,
    })).expect(422).expect(({ body }) => expect(body.error.code).toBe("SENSOR_OUT_OF_BOUNDS"));
    await request(runtime.app).post("/api/v1/sensors").send(sensor({
      id: "missing-house", houseId: "not-a-house",
    })).expect(404).expect(({ body }) => expect(body.error.code).toBe("SENSOR_HOUSE_NOT_FOUND"));
    await request(runtime.app).post("/api/v1/sensors").send(sensor({
      id: "wrong-house-floor", houseId: "house-main", floorId: "basement",
    })).expect(422).expect(({ body }) => expect(body.error.code).toBe("SENSOR_FLOOR_NOT_FOUND"));
    await request(runtime.app).post("/api/v1/sensors").send(sensor({ id: "not-finite", x: "NaN" }))
      .expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_FIELD"));
  });

  it("moves a sensor across houses and floors atomically", async () => {
    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-target", name: "Target", timezone: "Europe/Helsinki",
      floors: [{ id: "target-floor", name: "Target floor", width: 2, height: 1, elevation: -4, walls: [], rooms: [] }],
    }).expect(201);

    const moved = await request(runtime.app).patch("/api/v1/sensors/sensor-01").send({
      houseId: "house-target", floorId: "target-floor", x: 2, y: 1, z: -20,
    }).expect(200);
    expect(moved.body.sensor).toMatchObject({ houseId: "house-target", floorId: "target-floor", x: 2, y: 1, z: -20 });

    await request(runtime.app).patch("/api/v1/sensors/sensor-01").send({ houseId: "house-main" })
      .expect(422).expect(({ body }) => expect(body.error.code).toBe("SENSOR_FLOOR_NOT_FOUND"));
    expect(runtime.database.getSensor("sensor-01")).toMatchObject({ houseId: "house-target", floorId: "target-floor", x: 2, y: 1, z: -20 });

    await request(runtime.app).patch("/api/v1/sensors/sensor-01").send({
      houseId: "house-main", floorId: "floor-upper", x: 14.01, y: 1, z: 50,
    }).expect(422).expect(({ body }) => expect(body.error.code).toBe("SENSOR_OUT_OF_BOUNDS"));
    expect(runtime.database.getSensor("sensor-01")).toMatchObject({ houseId: "house-target", floorId: "target-floor", x: 2, y: 1, z: -20 });

    await request(runtime.app).put("/api/v1/sensors/sensor-01").send({
      houseId: "house-main", floorId: "floor-upper", x: 14, y: 10, z: -100,
    }).expect(200).expect(({ body }) => expect(body).toMatchObject({ houseId: "house-main", floorId: "floor-upper", z: -100 }));
  });

  it("creates, uniquely assigns, and clears direct TP-Link child-device bindings", async () => {
    const created = await request(runtime.app).post("/api/v1/sensors").send({
      id: "sensor-direct",
      houseId: "house-main",
      floorId: "floor-ground",
      name: "Direct sensor",
      room: "Living room",
      model: "Tapo T315",
      x: 1,
      y: 1,
      z: 1.2,
      tpLinkDeviceId: "  child-direct  ",
      tags: [],
      enabled: true,
    }).expect(201);
    expect(created.body.sensor.tpLinkDeviceId).toBe("child-direct");
    expect(runtime.database.getSensor("sensor-direct")?.tpLinkDeviceId).toBe("child-direct");

    await request(runtime.app).patch("/api/v1/sensors/sensor-02").send({ tpLinkDeviceId: "child-direct" })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("TP_LINK_DEVICE_ALREADY_MAPPED"));
    expect(runtime.database.getSensor("sensor-02")).not.toHaveProperty("tpLinkDeviceId");

    const cleared = await request(runtime.app).patch("/api/v1/sensors/sensor-direct")
      .send({ tpLinkDeviceId: null })
      .expect(200);
    expect(cleared.body.sensor).not.toHaveProperty("tpLinkDeviceId");
    expect(runtime.database.getSensor("sensor-direct")).not.toHaveProperty("tpLinkDeviceId");

    await request(runtime.app).patch("/api/v1/sensors/sensor-02").send({ tpLinkDeviceId: "child-direct" })
      .expect(200)
      .expect(({ body }) => expect(body.sensor.tpLinkDeviceId).toBe("child-direct"));
  });

  it("rejects layout changes that orphan or exclude sensors while allowing negative elevations", async () => {
    const original = await request(runtime.app).get("/api/v1/houses/house-main").expect(200);
    const floors = original.body.house.floors as Array<Record<string, unknown>>;
    const upper = floors.find((floor) => floor.id === "floor-upper");
    if (!upper) throw new Error("Seed upper floor missing");

    await request(runtime.app).patch("/api/v1/houses/house-main").send({ floors: [upper] })
      .expect(409).expect(({ body }) => expect(body.error.code).toBe("LAYOUT_ORPHANS_SENSOR"));
    expect(runtime.database.getHouse("house-main")?.floors).toHaveLength(2);

    await request(runtime.app).put("/api/v1/houses/house-main/floors/floor-upper").send({ ...upper, elevation: -8 })
      .expect(200).expect(({ body }) => expect(body.elevation).toBe(-8));
    expect(runtime.database.getSensor("sensor-10")?.z).toBe(5.5);

    await request(runtime.app).put("/api/v1/houses/house-main/floors/floor-upper").send({ ...upper, width: 5, walls: [], rooms: [] })
      .expect(409).expect(({ body }) => expect(body.error.code).toBe("LAYOUT_EXCLUDES_SENSOR"));
    expect(runtime.database.getHouse("house-main")?.floors.find((floor) => floor.id === "floor-upper")?.width).toBe(14);
  });

  it("round-trips architectural plan elements and rejects invalid wall attachments", async () => {
    const floor = {
      id: "main", name: "Main", width: 10, height: 8, elevation: 0,
      walls: [{ id: "north", from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }],
      rooms: [{ id: "living", name: "Living room", kind: "living", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }] }],
      planElements: [
        { id: "door-1", kind: "door", position: { x: 4, y: 0 }, rotationDegrees: 0, width: 1, wallId: "north" },
        { id: "vent-1", kind: "vent", position: { x: 5, y: 4 }, rotationDegrees: 90, width: .5 },
      ],
    };
    const created = await request(runtime.app).post("/api/v1/houses").send({
      id: "house-elements", name: "Element house", timezone: "Europe/Helsinki", floors: [floor],
    }).expect(201);
    expect(created.body.house.floors[0].planElements).toEqual(floor.planElements);

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-invalid-element", name: "Invalid", timezone: "UTC",
      floors: [{ ...floor, planElements: [{ ...floor.planElements[0], wallId: "missing" }] }],
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_PLAN_ELEMENT_WALL"));

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-unattached-opening", name: "Unattached opening", timezone: "UTC",
      floors: [{
        ...floor,
        planElements: [{ id: "window-1", kind: "window", position: { x: 4, y: 0 }, rotationDegrees: 0, width: 1 }],
      }],
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_PLAN_ELEMENT_WALL"));

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-invalid-rooms", name: "Invalid rooms", timezone: "UTC",
      floors: [{ ...floor, rooms: "not-an-array" }],
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_ROOMS"));

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-crossed-room", name: "Crossed room", timezone: "UTC",
      floors: [{
        ...floor,
        rooms: [{
          ...floor.rooms[0],
          points: [{ x: 0, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 3 }, { x: 4, y: 0 }],
        }],
      }],
    }).expect(400).expect(({ body }) => {
      expect(body.error.code).toBe("INVALID_ROOM_GEOMETRY");
      expect(body.error.message).toContain("cannot self-intersect");
    });

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-misaligned-opening", name: "Misaligned", timezone: "UTC",
      floors: [{ ...floor, planElements: [{ ...floor.planElements[0], position: { x: 4, y: 2 } }] }],
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_PLAN_ELEMENT_ALIGNMENT"));

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-attached-vent", name: "Attached vent", timezone: "UTC",
      floors: [{ ...floor, planElements: [{ ...floor.planElements[1], wallId: "north" }] }],
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_PLAN_ELEMENT_WALL"));

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-duplicate-room-name", name: "Duplicate rooms", timezone: "UTC",
      floors: [{
        ...floor,
        rooms: [...floor.rooms, { ...floor.rooms[0], id: "living-duplicate", name: "  LIVING ROOM  " }],
      }],
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("DUPLICATE_ROOM_NAME"));

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-opening-too-wide", name: "Oversized opening", timezone: "UTC",
      floors: [{ ...floor, planElements: [{ ...floor.planElements[0], position: { x: 5, y: 0 }, width: 11 }] }],
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_PLAN_ELEMENT_FIT"));

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-opening-no-clearance", name: "Opening without clearance", timezone: "UTC",
      floors: [{ ...floor, planElements: [{ ...floor.planElements[0], position: { x: .25, y: 0 }, width: 1 }] }],
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_PLAN_ELEMENT_FIT"));
  });

  it("authors and isolates a second house, floor, and positioned sensor", async () => {
    const floor = {
      id: "floor-cottage", name: "Main floor", width: 8, height: 6, elevation: 0,
      walls: [], rooms: [],
    };
    const createdHouse = await request(runtime.app).post("/api/v1/houses").send({
      id: "house-cottage", name: "Cottage", timezone: "Europe/Helsinki", floors: [floor],
    }).expect(201);
    expect(createdHouse.body.house).toMatchObject({ id: "house-cottage", floors: [floor] });

    const createdSensor = await request(runtime.app).post("/api/v1/sensors").send({
      id: "sensor-cottage", houseId: "house-cottage", floorId: "floor-cottage",
      name: "Cottage hall", room: "Hall", model: "Tapo T310", x: 2, y: 3, z: 1.2,
      tags: ["cottage"], enabled: true,
    }).expect(201);
    expect(createdSensor.body.sensor.houseId).toBe("house-cottage");

    const houses = await request(runtime.app).get("/api/v1/houses").expect(200);
    expect(houses.body.houses).toHaveLength(2);
    const cottageSnapshot = await request(runtime.app).get("/api/v1/snapshot?houseId=house-cottage").expect(200);
    expect(cottageSnapshot.body.snapshot).toHaveLength(1);
    expect(cottageSnapshot.body.snapshot[0]).toMatchObject({ id: "sensor-cottage", reading: null });
  });

  it("persists optional house locations and reports the real weather configuration count", async () => {
    const initialStatus = await request(runtime.app).get("/api/v1/integrations/status").expect(200);
    expect(initialStatus.body.weather).toEqual({
      policy: "automatic",
      availableProviders: ["fmi", "open-meteo"],
      provider: "fmi",
      configuredHouses: 0,
      lastSuccessAt: null,
      error: null,
    });

    const located = await request(runtime.app).patch("/api/v1/houses/house-main").send({
      location: { latitude: 60.1699, longitude: 24.9384, label: "  Helsinki  " },
    }).expect(200);
    expect(located.body.house.location).toEqual({ latitude: 60.1699, longitude: 24.9384, label: "Helsinki" });
    expect(runtime.database.getHouse("house-main")?.location).toEqual(located.body.house.location);

    const configuredStatus = await request(runtime.app).get("/api/v1/integrations/status").expect(200);
    expect(configuredStatus.body.weather.configuredHouses).toBe(1);
    expect(configuredStatus.body.weather.lastSuccessAt).toBeNull();

    await request(runtime.app).patch("/api/v1/houses/house-main")
      .send({ location: { latitude: 91, longitude: 24 } })
      .expect(422).expect(({ body }) => expect(body.error.code).toBe("INVALID_LATITUDE"));
    await request(runtime.app).patch("/api/v1/houses/house-main")
      .send({ location: "Helsinki" })
      .expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_FIELD"));

    const cleared = await request(runtime.app).patch("/api/v1/houses/house-main").send({ location: null }).expect(200);
    expect(cleared.body.house).not.toHaveProperty("location");
    const clearedStatus = await request(runtime.app).get("/api/v1/integrations/status").expect(200);
    expect(clearedStatus.body.weather.configuredHouses).toBe(0);
  });

  it("validates new IANA timezones while keeping legacy invalid values readable and repairable", async () => {
    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-invalid-timezone",
      name: "Invalid timezone",
      timezone: "Mars/Olympus_Mons",
      floors: [],
    }).expect(422).expect(({ body }) => expect(body.error.code).toBe("INVALID_TIMEZONE"));

    runtime.database.db.prepare("UPDATE houses SET timezone = ? WHERE id = ?")
      .run("Legacy/Unresolvable", "house-main");
    await request(runtime.app).get("/api/v1/houses/house-main").expect(200).expect(({ body }) => {
      expect(body.house.timezone).toBe("Legacy/Unresolvable");
    });

    await request(runtime.app).patch("/api/v1/houses/house-main")
      .send({ name: "Legacy timezone house" })
      .expect(200)
      .expect(({ body }) => expect(body.house.timezone).toBe("Legacy/Unresolvable"));
    await request(runtime.app).patch("/api/v1/houses/house-main")
      .send({ timezone: "Legacy/Unresolvable" })
      .expect(200);
    await request(runtime.app).patch("/api/v1/houses/house-main")
      .send({ timezone: "Also/Invalid" })
      .expect(422)
      .expect(({ body }) => expect(body.error.code).toBe("INVALID_TIMEZONE"));

    await request(runtime.app).patch("/api/v1/houses/house-main")
      .send({ timezone: "America/New_York" })
      .expect(200)
      .expect(({ body }) => expect(body.house.timezone).toBe("America/New_York"));
  });

  it("persists floor-plan compass orientation and validates its half-open bearing range", async () => {
    const seeded = await request(runtime.app).get("/api/v1/houses/house-main").expect(200);
    expect(seeded.body.house).not.toHaveProperty("orientationDegrees");

    const created = await request(runtime.app).post("/api/v1/houses").send({
      id: "house-oriented",
      name: "Oriented house",
      timezone: "Europe/Helsinki",
      orientationDegrees: 271.25,
      floors: [{ id: "main", name: "Main", width: 10, height: 8, elevation: 0, walls: [], rooms: [] }],
    }).expect(201);
    expect(created.body.house.orientationDegrees).toBe(271.25);
    expect(runtime.database.getHouse("house-oriented")?.orientationDegrees).toBe(271.25);

    const updated = await request(runtime.app).patch("/api/v1/houses/house-oriented")
      .send({ orientationDegrees: 89.5 })
      .expect(200);
    expect(updated.body.house.orientationDegrees).toBe(89.5);
    expect(runtime.database.getHouse("house-oriented")?.orientationDegrees).toBe(89.5);

    await request(runtime.app).patch("/api/v1/houses/house-oriented")
      .send({ orientationDegrees: 360 })
      .expect(422)
      .expect(({ body }) => expect(body.error.code).toBe("INVALID_ORIENTATION"));
    await request(runtime.app).patch("/api/v1/houses/house-oriented")
      .send({ orientationDegrees: -0.01 })
      .expect(422)
      .expect(({ body }) => expect(body.error.code).toBe("INVALID_ORIENTATION"));
    await request(runtime.app).patch("/api/v1/houses/house-oriented")
      .send({ orientationDegrees: "90" })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("INVALID_FIELD"));
    expect(() => runtime.database.updateHouse("house-oriented", { orientationDegrees: Number.NaN }))
      .toThrow("finite compass bearing");
    expect(runtime.database.getHouse("house-oriented")?.orientationDegrees).toBe(89.5);

    const cleared = await request(runtime.app).patch("/api/v1/houses/house-oriented")
      .send({ orientationDegrees: null })
      .expect(200);
    expect(cleared.body.house).not.toHaveProperty("orientationDegrees");
    expect(runtime.database.getHouse("house-oriented")).not.toHaveProperty("orientationDegrees");

    const defaulted = await request(runtime.app).post("/api/v1/houses").send({
      id: "house-default-orientation",
      name: "Default orientation",
      timezone: "UTC",
      floors: [{ id: "main", name: "Main", width: 1, height: 1, elevation: 0, walls: [], rooms: [] }],
    }).expect(201);
    expect(defaulted.body.house).not.toHaveProperty("orientationDegrees");
  });

  it("protects ingestion when configured and stores valid readings", async () => {
    const reading = { sensorId: "sensor-01", temperature: 21.75, humidity: 48.2, battery: 91 };
    await request(runtime.app).post("/api/v1/readings").send(reading).expect(401);
    const created = await request(runtime.app)
      .post("/api/v1/readings")
      .set("x-api-key", "test-ingest-key")
      .send(reading)
      .expect(201);
    expect(created.body.readings[0]).toMatchObject({ ...reading, source: "api", quality: "good" });

    const latest = await request(runtime.app).get("/api/v1/readings/latest?sensorId=sensor-01").expect(200);
    expect(latest.body.readings[0].temperature).toBe(21.75);
  });

  it("allows small sender clock skew but rejects readings too far in the future", async () => {
    const now = Date.now();
    await request(runtime.app).post("/api/v1/readings").set("x-api-key", "test-ingest-key").send({
      sensorId: "sensor-01",
      timestamp: new Date(now + 6 * 60_000).toISOString(),
      temperature: 21,
      humidity: 45,
    }).expect(422).expect(({ body }) => expect(body.error.code).toBe("TIMESTAMP_TOO_FAR_IN_FUTURE"));

    await request(runtime.app).post("/api/v1/readings").set("x-api-key", "test-ingest-key").send({
      sensorId: "sensor-01",
      timestamp: new Date(now + 4 * 60_000).toISOString(),
      temperature: 21,
      humidity: 45,
    }).expect(201);
  });

  it("prevalidates batches atomically and reports unknown or disabled sensors as 4xx", async () => {
    const before = runtime.database.getLatestReading("sensor-01");
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    await request(runtime.app).post("/api/v1/readings").set("x-api-key", "test-ingest-key").send([
      { sensorId: "sensor-01", timestamp, temperature: 33, humidity: 44 },
      { sensorId: "missing-sensor", timestamp, temperature: 33, humidity: 44 },
    ]).expect(404).expect(({ body }) => expect(body.error.code).toBe("UNKNOWN_SENSOR"));
    expect(runtime.database.getLatestReading("sensor-01")?.timestamp).toBe(before?.timestamp);

    runtime.database.updateSensor("sensor-01", { enabled: false });
    await request(runtime.app).post("/api/v1/readings").set("x-api-key", "test-ingest-key")
      .send({ sensorId: "sensor-01", temperature: 21, humidity: 45 })
      .expect(409).expect(({ body }) => expect(body.error.code).toBe("SENSOR_DISABLED"));
  });

  it("deduplicates reading identity without publishing or evaluating duplicates", async () => {
    let readingEvents = 0;
    const unsubscribe = runtime.bus.subscribe((event) => { if (event.type === "reading") readingEvents += 1; });
    const reading = { sensorId: "sensor-01", timestamp: new Date().toISOString(), temperature: 22, humidity: 50 };
    const first = await request(runtime.app).post("/api/v1/readings").set("x-api-key", "test-ingest-key")
      .send({ readings: [reading, reading] }).expect(201);
    expect(first.body.readings).toHaveLength(1);
    expect(first.body.ignoredDuplicates).toBe(1);
    const retry = await request(runtime.app).post("/api/v1/readings").set("x-api-key", "test-ingest-key")
      .send(reading).expect(201);
    expect(retry.body.readings).toHaveLength(0);
    expect(retry.body.ignoredDuplicates).toBe(1);
    expect(readingEvents).toBe(1);
    unsubscribe();
  });

  it("uses chronological latest readings and retains newest limited history in ascending order", async () => {
    const base = Date.now();
    for (const [offsetMs, temperature] of [[60_000, 17], [180_000, 19], [120_000, 18]] as const) {
      await request(runtime.app).post("/api/v1/readings").set("x-api-key", "test-ingest-key").send({
        sensorId: "sensor-01", timestamp: new Date(base + offsetMs).toISOString(), temperature, humidity: 50,
      }).expect(201);
    }
    const latest = await request(runtime.app).get("/api/v1/readings/latest?sensorId=sensor-01").expect(200);
    expect(latest.body.readings[0].temperature).toBe(19);
    const history = await request(runtime.app).get("/api/v1/readings").query({
      sensorId: "sensor-01", from: new Date(base).toISOString(), to: new Date(base + 240_000).toISOString(), limit: 2,
    }).expect(200);
    expect(history.body.readings.map((reading: { temperature: number }) => reading.temperature)).toEqual([18, 19]);
  });

  it("requires a positive bounded integer alert duration on create and update", async () => {
    const rule = {
      name: "Validated duration", sensorId: "sensor-01", metric: "humidity", operator: "gte",
      threshold: 70, severity: "warning", enabled: true, webhookEnabled: false,
    };
    for (const durationSeconds of [undefined, null, 0, -1, 1.5, "10", 31_536_001]) {
      await request(runtime.app).post("/api/v1/alert-rules").send({ ...rule, durationSeconds })
        .expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_FIELD"));
    }

    const created = await request(runtime.app).post("/api/v1/alert-rules")
      .send({ ...rule, durationSeconds: 1 }).expect(201);
    await request(runtime.app).patch(`/api/v1/alert-rules/${String(created.body.id)}`)
      .send({ durationSeconds: 0 })
      .expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_FIELD"));
    expect(runtime.database.getAlertRule(String(created.body.id))?.durationSeconds).toBe(1);
  });

  it("creates, publishes, acknowledges, and resolves sustained alert events", async () => {
    const base = Date.now() - 5_000;
    const ruleResponse = await request(runtime.app).post("/api/v1/alert-rules").send({
      name: "Test humidity", sensorId: "sensor-01", metric: "humidity", operator: "gte",
      threshold: 70, durationSeconds: 1, severity: "critical", enabled: true, webhookEnabled: false,
    }).expect(201);
    expect(ruleResponse.body.id).toBeTypeOf("string");

    await request(runtime.app).post("/api/v1/readings").set("x-api-key", "test-ingest-key")
      .send({ sensorId: "sensor-01", timestamp: new Date(base).toISOString(), temperature: 21, humidity: 81 }).expect(201);
    await request(runtime.app).post("/api/v1/readings").set("x-api-key", "test-ingest-key")
      .send({ sensorId: "sensor-01", timestamp: new Date(base + 1_500).toISOString(), temperature: 21, humidity: 81 }).expect(201);
    const active = await request(runtime.app).get("/api/v1/alert-events?active=true").expect(200);
    expect(active.body.events).toHaveLength(1);
    expect(active.body.events[0]).toMatchObject({ sensorId: "sensor-01", severity: "critical", resolvedAt: null });

    const acknowledged = await request(runtime.app)
      .post(`/api/v1/alert-events/${String(active.body.events[0].id)}/acknowledge`).expect(200);
    expect(acknowledged.body.event.acknowledgedAt).toBeTypeOf("string");

    await request(runtime.app).post("/api/v1/readings").set("authorization", "Bearer test-ingest-key")
      .send({ sensorId: "sensor-01", timestamp: new Date(base + 2_500).toISOString(), temperature: 21, humidity: 45 }).expect(201);
    const noLongerActive = await request(runtime.app).get("/api/v1/alert-events?active=true").expect(200);
    expect(noLongerActive.body.events).toHaveLength(0);
  });

  it("returns bounded forecasts from historical readings", async () => {
    const response = await request(runtime.app).get("/api/v1/forecast?sensorId=sensor-01&hours=6").expect(200);
    expect(response.body.model).toBe("linear-v1");
    expect(response.body.series[0].forecast).toHaveLength(6);
    for (const point of response.body.series[0].forecast) {
      expect(point.humidity).toBeGreaterThanOrEqual(0);
      expect(point.humidity).toBeLessThanOrEqual(100);
      expect(point.temperatureLow).toBeLessThan(point.temperatureHigh);
    }
  });

  it("stores manual observations, static context, and binary twin assets", async () => {
    const observation = await request(runtime.app).post("/api/v1/observations").send({
      houseId: "house-main", floorId: "floor-ground", sensorId: "sensor-04", kind: "leak",
      severity: "warning", note: "Damp patch below supply pipe", x: 11, y: 7.2,
    }).expect(201);
    expect(observation.body.kind).toBe("leak");

    const parameter = await request(runtime.app).post("/api/v1/parameters").send({
      houseId: "house-main", scopeType: "room", scopeId: "utility", key: "pipeMaterial",
      value: "copper", unit: null, label: "Pipe material",
    }).expect(200);
    expect(parameter.body.parameter.value).toBe("copper");

    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const asset = await request(runtime.app).post("/api/v1/assets").send({
      houseId: "house-main", name: "plan.png", mimeType: "image/png", kind: "floor-plan", data: bytes.toString("base64"),
    }).expect(201);
    const downloaded = await request(runtime.app).get(asset.body.url).expect(200);
    expect(Buffer.from(downloaded.body)).toEqual(bytes);
    expect(downloaded.headers["content-security-policy"]).toContain("sandbox");
    expect(downloaded.headers["content-disposition"]).toContain("inline");
  });

  it("rejects active asset MIME types, sandboxes model downloads, and maps oversized JSON to 413", async () => {
    await request(runtime.app).post("/api/v1/assets").send({
      houseId: "house-main", name: "active.html", mimeType: "text/html", kind: "other",
      data: Buffer.from("<script>alert(1)</script>").toString("base64"),
    }).expect(415).expect(({ body }) => expect(body.error.code).toBe("UNSUPPORTED_ASSET_TYPE"));

    const model = await request(runtime.app).post("/api/v1/assets").send({
      houseId: "house-main", name: "house.glb", mimeType: "model/gltf-binary", kind: "model-3d",
      data: Buffer.from("glTF").toString("base64"),
    }).expect(201);
    const downloaded = await request(runtime.app).get(model.body.url).expect(200);
    expect(downloaded.headers["content-disposition"]).toContain("attachment");
    expect(downloaded.headers["content-security-policy"]).toContain("sandbox");

    await request(runtime.app).post("/api/v1/assets").send({ data: "a".repeat(16 * 1024 * 1024) })
      .expect(413).expect(({ body }) => expect(body.error.code).toBe("PAYLOAD_TOO_LARGE"));
  });

  it("exposes a versioned OpenAPI document and redacted integration setup help", async () => {
    const openapi = await request(runtime.app).get("/api/v1/openapi.json").expect(200);
    expect(openapi.body.openapi).toBe("3.1.0");
    expect(openapi.body.paths["/stream"]).toBeDefined();
    expect(openapi.body.paths["/events"]).toBeDefined();
    expect(openapi.body.paths["/snapshot"]).toBeDefined();
    expect(openapi.body.paths["/readings"].get).toBeDefined();
    expect(openapi.body.paths["/integrations/tp-link/devices"].get.operationId).toBe("listTpLinkDevices");
    expect(openapi.body.paths["/sensors/{id}"].patch.requestBody.content["application/json"].schema.$ref).toContain("SensorPatch");
    const sensorCoordinates = openapi.body.components.schemas.SensorInput.properties;
    expect(sensorCoordinates.x.minimum).toBe(0);
    expect(sensorCoordinates.y.minimum).toBe(0);
    expect(sensorCoordinates.z.minimum).toBeUndefined();
    expect(openapi.body.components.schemas.Floor.properties.elevation.minimum).toBeUndefined();
    expect(openapi.body.components.schemas.Floor.properties.elevation.description).toContain("vertical");
    expect(openapi.body.components.schemas.Floor.properties.rooms.items.properties.points.minItems).toBe(3);
    const planElementVariants = openapi.body.components.schemas.Floor.properties.planElements.items.oneOf;
    expect(planElementVariants).toHaveLength(2);
    expect(planElementVariants[0].properties.kind.enum).toEqual(["door", "window"]);
    expect(planElementVariants[0].required).toContain("wallId");
    expect(planElementVariants[1].properties.kind.enum).toEqual(["fireplace", "vent"]);
    expect(planElementVariants[1].not.required).toEqual(["wallId"]);
    expect(openapi.body.components.schemas.SensorInput.properties.z.description).toContain("Floor.elevation");
    expect(openapi.body.components.schemas.SensorInput.properties.tpLinkDeviceId.oneOf).toContainEqual({ type: "null" });
    expect(openapi.body.components.schemas.SensorPatch.properties.tpLinkDeviceId.description).toContain("clear");
    expect(openapi.body.components.schemas.TpLinkDiscoveredDevice.required).toContain("mappedSensorId");
    expect(openapi.body.components.schemas.HouseWeather.properties.provider.enum).toEqual(["fmi", "open-meteo"]);
    expect(openapi.body.components.schemas.HouseWeather.properties.componentStatus.$ref).toContain("WeatherComponentStatuses");
    expect(openapi.body.components.schemas.WeatherComponentStatus.required).toContain("emptyResultIsAuthoritative");
    expect(openapi.body.components.schemas.HouseCreate.properties.timezone.description).toContain("IANA");

    const setup = await request(runtime.app).get("/api/v1/integrations/home-assistant/setup").expect(200);
    expect(JSON.stringify(setup.body)).not.toContain("test-ingest-key");
    expect(setup.body.entityMapSchema.entities[0]).toHaveProperty("temperature");
    const tpLinkSetup = await request(runtime.app).get("/api/v1/integrations/tp-link/setup").expect(200);
    expect(tpLinkSetup.body.sensorPatchSchema).toEqual({ tpLinkDeviceId: "hub-child-device-id" });
    expect(tpLinkSetup.body.notes.join(" ")).toContain("optional legacy fallback");
  });

  it("opens an SSE stream with an immediate integration state event", async () => {
    const server: Server = createServer(runtime.app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const chunk = await response.body?.getReader().read();
    expect(new TextDecoder().decode(chunk?.value)).toContain("event: integration");
    controller.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("generates selectable mock scenarios and can start a replay", async () => {
    await request(runtime.app).post("/api/v1/mock/scenario").send({ scenarioId: "shower" }).expect(200);
    const tick = await request(runtime.app).post("/api/v1/mock/tick").expect(201);
    expect(tick.body.readings).toHaveLength(10);
    expect(tick.body.readings.every((reading: { source: string }) => reading.source === "mock")).toBe(true);

    const replay = await request(runtime.app).post("/api/v1/replay").send({
      sensorIds: ["sensor-01"], from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date().toISOString(), speed: 10_000,
    }).expect(202);
    expect(replay.body.replay.count).toBeGreaterThan(0);
    await request(runtime.app).delete("/api/v1/replay").expect(200);
  });

  it("supports the web client compatibility routes and direct mutation shapes", async () => {
    const snapshot = await request(runtime.app).get("/api/v1/snapshot?houseId=house-main").expect(200);
    expect(snapshot.body.snapshot).toHaveLength(10);

    const readings = await request(runtime.app).get("/api/v1/readings").query({
      sensorId: "sensor-01", from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date().toISOString(), limit: 100,
    }).expect(200);
    expect(readings.body.readings.length).toBeGreaterThan(0);

    const sensor = await request(runtime.app).put("/api/v1/sensors/sensor-01").send({ x: 2.25 }).expect(200);
    expect(sensor.body.id).toBe("sensor-01");
    expect(sensor.body.x).toBe(2.25);

    const integrations = await request(runtime.app).get("/api/v1/integrations/status").expect(200);
    expect(integrations.body).toHaveProperty("homeAssistant.configured", false);
  });
});
