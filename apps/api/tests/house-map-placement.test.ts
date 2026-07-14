import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { AppConfig } from "../src/config.js";
import { createApi, type ApiRuntime } from "../src/app.js";
import { outdoorLocationKey } from "../src/db.js";

const config: AppConfig = {
  port: 0,
  apiHost: "127.0.0.1",
  databasePath: ":memory:",
  integrationSecretsFile: "integration-secrets.test.json",
  assetDirectory: ".",
  mockEnabled: false,
  mockIntervalMs: 25,
  retentionDays: 730,
  ingestApiKey: null,
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
  corsOrigin: null,
};

const floors = [
  { id: "ground", name: "Ground", width: 12, height: 8, elevation: 0, walls: [], rooms: [] },
  { id: "upper", name: "Upper", width: 10, height: 7, elevation: 3, walls: [], rooms: [] },
];

describe("house map placement", () => {
  let runtime: ApiRuntime;

  beforeEach(() => {
    runtime = createApi({ config: { ...config }, startBackground: false });
  });

  afterEach(() => {
    runtime.close();
  });

  it("round-trips independent precise placement through create, read, update, and clear", async () => {
    const initial = {
      latitude: 60.16995,
      longitude: 24.93845,
      metersPerPlanUnit: 0.5,
      footprintFloorId: "ground",
    };
    const created = await request(runtime.app).post("/api/v1/houses").send({
      id: "house-map",
      name: "Mapped house",
      timezone: "Europe/Helsinki",
      floors,
      mapPlacement: initial,
    }).expect(201);
    expect(created.body.house.mapPlacement).toEqual(initial);
    expect(created.body.house).not.toHaveProperty("location");
    expect(runtime.database.getHouse("house-map")?.mapPlacement).toEqual(initial);

    const updatedPlacement = {
      latitude: 60.17001,
      longitude: 24.93902,
      metersPerPlanUnit: 0.25,
      footprintFloorId: "upper",
    };
    await request(runtime.app).patch("/api/v1/houses/house-map")
      .send({ mapPlacement: updatedPlacement })
      .expect(200)
      .expect(({ body }) => expect(body.house.mapPlacement).toEqual(updatedPlacement));
    await request(runtime.app).get("/api/v1/houses/house-map")
      .expect(200)
      .expect(({ body }) => expect(body.house.mapPlacement).toEqual(updatedPlacement));

    const cleared = await request(runtime.app).patch("/api/v1/houses/house-map")
      .send({ mapPlacement: null })
      .expect(200);
    expect(cleared.body.house).not.toHaveProperty("mapPlacement");
    expect(runtime.database.getHouse("house-map")).not.toHaveProperty("mapPlacement");
  });

  it("rejects invalid coordinates, scale, and footprint floor references atomically", async () => {
    const valid = {
      latitude: 60,
      longitude: 25,
      metersPerPlanUnit: 1,
      footprintFloorId: "ground",
    };
    await request(runtime.app).post("/api/v1/houses").send({
      id: "house-validation",
      name: "Validation house",
      timezone: "UTC",
      floors,
      mapPlacement: valid,
    }).expect(201);

    const invalidCases = [
      [{ ...valid, latitude: 90.01 }, "INVALID_MAP_PLACEMENT_LATITUDE"],
      [{ ...valid, longitude: -180.01 }, "INVALID_MAP_PLACEMENT_LONGITUDE"],
      [{ ...valid, metersPerPlanUnit: 0 }, "INVALID_MAP_PLACEMENT_SCALE"],
      [{ ...valid, footprintFloorId: "missing" }, "MAP_PLACEMENT_FLOOR_NOT_FOUND"],
    ] as const;
    for (const [mapPlacement, code] of invalidCases) {
      await request(runtime.app).patch("/api/v1/houses/house-validation")
        .send({ mapPlacement })
        .expect(422)
        .expect(({ body }) => expect(body.error.code).toBe(code));
      expect(runtime.database.getHouse("house-validation")?.mapPlacement).toEqual(valid);
    }

    await request(runtime.app).patch("/api/v1/houses/house-validation")
      .send({ mapPlacement: { ...valid, footprintFloorId: "" } })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("INVALID_FIELD"));
    await request(runtime.app).patch("/api/v1/houses/house-validation")
      .send({ floors: [floors[1]] })
      .expect(422)
      .expect(({ body }) => expect(body.error.code).toBe("MAP_PLACEMENT_FLOOR_NOT_FOUND"));
    expect(() => runtime.database.updateHouse("house-validation", {
      mapPlacement: { ...valid, metersPerPlanUnit: Number.NaN },
    })).toThrow("positive finite number");
    expect(runtime.database.getHouse("house-validation")?.mapPlacement).toEqual(valid);
  });

  it("preserves outdoor temperature history for placement-only changes", async () => {
    const location = { latitude: 60.1699, longitude: 24.9384 };
    await request(runtime.app).patch("/api/v1/houses/house-main").send({ location }).expect(200);
    const locationKey = outdoorLocationKey(location);
    runtime.database.upsertOutdoorTemperatureSample({
      houseId: "house-main",
      locationKey,
      timestamp: "2026-07-14T08:00:00.000Z",
      temperatureC: 17.5,
      source: "mock",
      fetchedAt: "2026-07-14T08:01:00.000Z",
      stationId: null,
      stationName: null,
    });

    await request(runtime.app).patch("/api/v1/houses/house-main").send({
      mapPlacement: {
        latitude: 60.1701,
        longitude: 24.939,
        metersPerPlanUnit: 0.5,
        footprintFloorId: "floor-ground",
      },
    }).expect(200);
    expect(runtime.database.outdoorTemperatureHistory(
      "house-main",
      locationKey,
      "2026-07-14T00:00:00.000Z",
      "2026-07-15T00:00:00.000Z",
    )).toHaveLength(1);

    await request(runtime.app).patch("/api/v1/houses/house-main")
      .send({ location: { latitude: 61, longitude: 25 } })
      .expect(200);
    expect(runtime.database.outdoorTemperatureHistory(
      "house-main",
      locationKey,
      "2026-07-14T00:00:00.000Z",
      "2026-07-15T00:00:00.000Z",
    )).toHaveLength(0);
  });

  it("documents map placement independently from weather location", async () => {
    const openapi = await request(runtime.app).get("/api/v1/openapi.json").expect(200);
    expect(openapi.body.components.schemas.HouseMapPlacement.required)
      .toEqual(["latitude", "longitude", "metersPerPlanUnit"]);
    expect(openapi.body.components.schemas.HouseMapPlacement.properties.metersPerPlanUnit.exclusiveMinimum).toBe(0);
    expect(openapi.body.components.schemas.House.properties.mapPlacement.$ref)
      .toBe("#/components/schemas/HouseMapPlacement");
    expect(openapi.body.components.schemas.HousePatch.properties.mapPlacement.oneOf)
      .toContainEqual({ type: "null" });
  });
});
