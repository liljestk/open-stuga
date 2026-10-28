import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import request from "supertest";

import { createApi, type ApiRuntime } from "../src/app.js";

import { config } from "./appTestSupport.js";

describe("Climate Twin API v1", () => {
  let runtime: ApiRuntime;

  beforeEach(() => {
    runtime = createApi({ config, startBackground: false });
  });

  afterEach(async () => {
    await runtime.close();
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

  it("round-trips stable room ids while preserving legacy room-only clients", async () => {
    const legacy = await request(runtime.app).post("/api/v1/sensors").send({
      id: "legacy-room-client",
      houseId: "house-main",
      floorId: "floor-ground",
      name: "Legacy room client",
      room: "Kitchen",
      model: "Test",
      x: 10,
      y: 2,
      z: 1.4,
      tags: [],
      enabled: true,
    }).expect(201);
    expect(legacy.body.sensor).toMatchObject({ roomId: "kitchen", room: "Kitchen" });

    await request(runtime.app).patch("/api/v1/sensors/legacy-room-client")
      .send({ roomId: "living", room: "Kitchen" })
      .expect(422)
      .expect(({ body }) => expect(body.error.code).toBe("SENSOR_ROOM_LABEL_MISMATCH"));

    await request(runtime.app).patch("/api/v1/sensors/legacy-room-client")
      .send({ roomId: null, room: "Near the pantry" })
      .expect(200)
      .expect(({ body }) => expect(body.sensor).toMatchObject({ roomId: null, room: "Near the pantry" }));
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

  it("removes sensor-scoped static context when a sensor is permanently deleted", async () => {
    runtime.database.saveParameter({
      id: "sensor-context",
      houseId: "house-main",
      scopeType: "sensor",
      scopeId: "sensor-01",
      key: "installation_note",
      value: "Mounted beside the window",
      unit: null,
      label: "Installation note",
    });
    runtime.database.saveParameter({
      id: "room-context",
      houseId: "house-main",
      scopeType: "room",
      scopeId: "sensor-01",
      key: "room_note",
      value: "Scope IDs may overlap sensor IDs",
      unit: null,
      label: "Room note",
    });

    await request(runtime.app).delete("/api/v1/sensors/sensor-01").expect(204);

    expect(runtime.database.getSensor("sensor-01")).toBeNull();
    expect(runtime.database.listParameters("house-main").map((parameter) => parameter.id)).toContain("room-context");
    expect(runtime.database.listParameters("house-main").map((parameter) => parameter.id)).not.toContain("sensor-context");
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

  it("imports reviewed RoomPlan geometry with stale-write and raw-image safeguards", async () => {
    const created = await request(runtime.app).post("/api/v1/houses").send({
      id: "house-roomplan",
      name: "Scanned cottage",
      timezone: "Europe/Helsinki",
      floors: [{
        id: "ground",
        name: "Ground floor",
        width: 5,
        height: 4,
        elevation: 0,
        walls: [],
        rooms: [],
      }],
    }).expect(201);

    const floor = {
      id: "ground",
      name: "Ground floor",
      type: "ground",
      width: 5,
      height: 4,
      metersPerPlanUnit: 1,
      elevation: 0,
      ceilingHeight: 2.5,
      wallHeight: 2.5,
      walls: [
        { id: "wall-north", from: { x: 0, y: 0 }, to: { x: 5, y: 0 } },
        { id: "wall-east", from: { x: 5, y: 0 }, to: { x: 5, y: 4 } },
        { id: "wall-south", from: { x: 5, y: 4 }, to: { x: 0, y: 4 } },
        { id: "wall-west", from: { x: 0, y: 4 }, to: { x: 0, y: 0 } },
      ],
      rooms: [{
        id: "room-ground",
        name: "Living room",
        kind: "living",
        points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 4 }],
      }],
      planElements: [{
        id: "door-entry",
        kind: "door",
        label: "Door",
        position: { x: 2.5, y: 0 },
        rotationDegrees: 0,
        width: .9,
        height: 2.1,
        wallId: "wall-north",
      }],
    };
    const payload = {
      source: "apple-roomplan",
      capturedAt: "2026-07-26T10:30:00.000Z",
      expectedHouseUpdatedAt: created.body.house.updatedAt,
      floor,
    };

    const imported = await request(runtime.app)
      .post("/api/v1/houses/house-roomplan/floors/ground/roomplan-import")
      .send(payload)
      .expect(200);
    expect(imported.body.floor).toEqual(floor);
    expect(imported.body.house.floors[0]).toEqual(floor);
    expect(runtime.database.getHouse("house-roomplan")?.floors[0]).toEqual(floor);

    await request(runtime.app)
      .post("/api/v1/houses/house-roomplan/floors/ground/roomplan-import")
      .send({ ...payload, expectedHouseUpdatedAt: "2000-01-01T00:00:00.000Z" })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("ROOMPLAN_STALE_HOME"));

    await request(runtime.app)
      .post("/api/v1/houses/house-roomplan/floors/ground/roomplan-import")
      .send({
        ...payload,
        expectedHouseUpdatedAt: imported.body.house.updatedAt,
        floor: { ...floor, backgroundImage: "data:image/jpeg;base64,not-sent" },
      })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("ROOMPLAN_IMAGE_NOT_ACCEPTED"));

    await request(runtime.app)
      .post("/api/v1/houses/house-roomplan/floors/ground/roomplan-import")
      .send({
        ...payload,
        expectedHouseUpdatedAt: imported.body.house.updatedAt,
        rawScan: { camera: "not accepted" },
      })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("ROOMPLAN_PAYLOAD_NOT_ACCEPTED"));
  });

  it("round-trips architectural plan elements and rejects invalid dimensions or wall attachments", async () => {
    const floor = {
      id: "main", name: "Main", type: "attic", width: 10, height: 8, metersPerPlanUnit: .02, elevation: 0, wallHeight: .9,
      roof: { style: "gable", pitchDegrees: 35, ridgeAxis: "x", overhang: .4, eavesHeight: .9 },
      walls: [{ id: "north", from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }],
      rooms: [{ id: "living", name: "Living room", kind: "living", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }] }],
      planElements: [
        { id: "door-1", kind: "door", label: "Low hatch", position: { x: 4, y: 0 }, rotationDegrees: 0, width: 1, height: .6, wallId: "north", variant: "interior", state: "closed", openFraction: .8, stateBinding: { provider: "home-assistant", externalId: "binary_sensor.entry", connectionId: "house-elements" } },
        { id: "vent-1", kind: "vent", position: { x: 5, y: 4 }, rotationDegrees: 90, width: .5, variant: "supply", state: "open", nominalFlowM3h: 45 },
        { id: "fireplace-1", kind: "fireplace", position: { x: 3, y: 4 }, rotationDegrees: 0, width: 1, verticalExtent: "roof", chimneyHeightAboveRoof: .7, chimneyWidth: .8, chimneyDepth: .5 },
        { id: "escape-1", kind: "fireEscape", label: "North escape", position: { x: 7, y: 0 }, rotationDegrees: 0, width: 1.2, height: 2.4, wallId: "north", variant: "ladder", projection: .7 },
      ],
    };
    const created = await request(runtime.app).post("/api/v1/houses").send({
      id: "house-elements", name: "Element house", timezone: "Europe/Helsinki", floors: [floor],
    }).expect(201);
    expect(created.body.house.floors[0].planElements).toEqual(floor.planElements);
    const persisted = await request(runtime.app).get("/api/v1/houses/house-elements").expect(200);
    expect(persisted.body.house.floors[0].planElements).toEqual(floor.planElements);
    expect(persisted.body.house.floors[0].roof).toEqual(floor.roof);
    expect(persisted.body.house.floors[0].wallHeight).toBe(.9);
    expect(persisted.body.house.floors[0].metersPerPlanUnit).toBe(.02);
    const refreshMappings = vi.spyOn(runtime.homeAssistant, "refreshMappings");
    await request(runtime.app).patch("/api/v1/houses/house-elements").send({ floors: [floor] }).expect(200);
    expect(refreshMappings).toHaveBeenCalledOnce();

    await request(runtime.app).get("/api/v1/houses/house-elements/opening-states?at=2026-07-18T12:00:00.000Z").expect(200).expect(({ body }) => {
      expect(body.snapshot.states).toEqual(expect.arrayContaining([
        expect.objectContaining({ elementId: "door-1", state: "closed", openFraction: 0, source: "manual" }),
        expect.objectContaining({ elementId: "vent-1", state: "open", openFraction: 1, source: "manual" }),
      ]));
      expect(body.snapshot.states.some((state: { elementId: string }) => state.elementId === "escape-1")).toBe(false);
    });
    await request(runtime.app).post("/api/v1/houses/house-elements/opening-states").send({
      floorId: "main", elementId: "door-1", state: "closed", source: "api", observedAt: "2026-07-18T12:00:30.000Z",
    }).expect(201);
    await request(runtime.app).post("/api/v1/houses/house-elements/opening-states").send({
      floorId: "main", elementId: "door-1", state: "open", openFraction: .6, source: "manual", observedAt: "2026-07-18T12:01:00.000Z",
    }).expect(201).expect(({ body }) => expect(body.observation).toMatchObject({ houseId: "house-elements", elementId: "door-1", state: "open", openFraction: .6, source: "manual" }));
    await request(runtime.app).get("/api/v1/houses/house-elements/opening-states?at=2026-07-18T12:02:00.000Z").expect(200)
      .expect(({ body }) => expect(body.snapshot.states.find((state: { elementId: string }) => state.elementId === "door-1"))
        .toMatchObject({ state: "open", openFraction: .6, source: "manual", assumed: false }));
    await request(runtime.app).get("/api/v1/houses/house-elements/opening-states?from=2026-07-18T12:00:00.000Z&to=2026-07-18T12:02:00.000Z&limit=20")
      .expect(200).expect(({ body }) => {
        expect(body).toMatchObject({
          from: "2026-07-18T12:00:00.000Z",
          to: "2026-07-18T12:02:00.000Z",
          snapshot: { at: "2026-07-18T12:02:00.000Z" },
        });
        expect(body.history).toEqual(expect.arrayContaining([
          expect.objectContaining({ state: "closed", observedAt: "2026-07-18T12:00:30.000Z" }),
          expect.objectContaining({ state: "open", observedAt: "2026-07-18T12:01:00.000Z" }),
        ]));
        expect(body.history.map((item: { observedAt: string }) => item.observedAt)).toEqual(
          [...body.history.map((item: { observedAt: string }) => item.observedAt)].sort(),
        );
      });
    await request(runtime.app).get("/api/v1/houses/house-elements/opening-states?from=2026-07-18T12:00:45.000Z&to=2026-07-18T12:02:00.000Z&limit=20")
      .expect(200).expect(({ body }) => {
        expect(body.history).toEqual([
          expect.objectContaining({ state: "closed", observedAt: "2026-07-18T12:00:30.000Z" }),
          expect.objectContaining({ state: "open", observedAt: "2026-07-18T12:01:00.000Z" }),
        ]);
      });
    await request(runtime.app).get("/api/v1/houses/house-elements/opening-states?from=2026-07-18T12:00:45.000Z&to=2026-07-18T12:02:00.000Z&limit=1")
      .expect(200).expect(({ body }) => {
        expect(body.history).toEqual([
          expect.objectContaining({ state: "open", observedAt: "2026-07-18T12:01:00.000Z" }),
        ]);
      });
    await request(runtime.app).get("/api/v1/houses/house-elements/opening-states?from=2026-07-18T12:02:00.000Z&to=2026-07-18T12:00:00.000Z")
      .expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_OPENING_HISTORY_RANGE"));
    await request(runtime.app).post("/api/v1/houses/house-elements/opening-states").send({
      floorId: "main", elementId: "door-1", state: "closed", source: "home-assistant", observedAt: "2026-07-18T12:03:00.000Z", externalId: "binary_sensor.entry",
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_FIELD"));
    expect(() => runtime.database.recordOpeningStateObservation("house-elements", {
      floorId: "main", elementId: "door-1", state: "open", source: "home-assistant",
      observedAt: "2026-07-18T12:03:00.000Z", externalId: "binary_sensor.entry", connectionId: "another-house",
    })).toThrow("configured sensor binding");
    runtime.database.recordOpeningStateObservation("house-elements", {
      floorId: "main", elementId: "door-1", state: "unknown", source: "home-assistant",
      observedAt: "2026-07-18T12:03:00.000Z", externalId: "binary_sensor.entry", connectionId: "house-elements",
    });
    await request(runtime.app).get("/api/v1/houses/house-elements/opening-states?at=2026-07-18T12:02:00.000Z").expect(200)
      .expect(({ body }) => expect(body.snapshot.states.find((state: { elementId: string }) => state.elementId === "door-1"))
        .toMatchObject({ state: "open", source: "manual" }));
    await request(runtime.app).get("/api/v1/houses/house-elements/opening-states?at=2026-07-18T12:04:00.000Z").expect(200)
      .expect(({ body }) => expect(body.snapshot.states.find((state: { elementId: string }) => state.elementId === "door-1"))
        .toMatchObject({ state: "closed", source: "manual" }));

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-invalid-wall-height", name: "Invalid wall", timezone: "UTC",
      floors: [{ ...floor, wallHeight: 0 }],
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_WALL_HEIGHT"));

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-invalid-floor-scale", name: "Invalid scale", timezone: "UTC",
      floors: [{ ...floor, metersPerPlanUnit: 0 }],
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_FLOOR_SCALE"));

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-invalid-roof", name: "Invalid roof", timezone: "UTC",
      floors: [{ ...floor, roof: { ...floor.roof, pitchDegrees: 82 } }],
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_ROOF_PITCH"));

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-invalid-chimney", name: "Invalid chimney", timezone: "UTC",
      floors: [{ ...floor, planElements: [{ ...floor.planElements[2], chimneyHeightAboveRoof: 8 }] }],
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_CHIMNEY_HEIGHT"));

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-invalid-chimney-width", name: "Invalid chimney", timezone: "UTC",
      floors: [{ ...floor, planElements: [{ ...floor.planElements[2], chimneyWidth: 20 }] }],
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_CHIMNEY_DIMENSION"));

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-unattached-fire-escape", name: "Unattached escape", timezone: "UTC",
      floors: [{ ...floor, planElements: [{ ...floor.planElements[3], wallId: "missing" }] }],
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_PLAN_ELEMENT_WALL"));

    for (const [suffix, height] of [["zero", 0], ["negative", -1], ["not-finite", null]] as const) {
      await request(runtime.app).post("/api/v1/houses").send({
        id: `house-invalid-element-height-${suffix}`, name: "Invalid height", timezone: "UTC",
        floors: [{ ...floor, planElements: [{ ...floor.planElements[1], height }] }],
      }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_PLAN_ELEMENT_HEIGHT"));
    }

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-invalid-element", name: "Invalid", timezone: "UTC",
      floors: [{ ...floor, planElements: [{ ...floor.planElements[0], wallId: "missing" }] }],
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_PLAN_ELEMENT_WALL"));

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-invalid-opening-state", name: "Invalid state", timezone: "UTC",
      floors: [{ ...floor, planElements: [{ ...floor.planElements[0], state: "ajar" }] }],
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_OPENING_STATE"));

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-open-fixed-window", name: "Invalid fixed window", timezone: "UTC",
      floors: [{ ...floor, planElements: [{ ...floor.planElements[0], kind: "window", variant: "fixed", state: "open" }] }],
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_OPENING_STATE"));

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-bound-open-passage", name: "Invalid open passage", timezone: "UTC",
      floors: [{ ...floor, planElements: [{ ...floor.planElements[0], variant: "open-passage", state: undefined }] }],
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_OPENING_STATE_BINDING"));

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-duplicate-tapo-contact", name: "Duplicate Tapo contact", timezone: "UTC",
      floors: [{
        ...floor,
        planElements: [
          {
            ...floor.planElements[0],
            position: { x: 3, y: 0 },
            stateBinding: { provider: "tapo", externalId: "contact-entry", connectionId: "hub-main" },
          },
          {
            ...floor.planElements[0],
            id: "door-2",
            position: { x: 7, y: 0 },
            stateBinding: { provider: "tapo", externalId: "contact-entry", connectionId: "hub-main" },
          },
        ],
      }],
    }).expect(409).expect(({ body }) => expect(body.error.code).toBe("DUPLICATE_TAPO_OPENING_BINDING"));

    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-invalid-vent-variant", name: "Invalid vent", timezone: "UTC",
      floors: [{ ...floor, planElements: [{ ...floor.planElements[1], variant: "combustion" }] }],
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_PLAN_ELEMENT_VARIANT"));

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
});
