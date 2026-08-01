import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ClimateDataValidationError, ClimateDatabase } from "../src/db.js";

const floor = (id: string) => ({
  id,
  name: id,
  width: 8,
  height: 8,
  elevation: 0,
  walls: [],
  rooms: [],
});

describe("immutable telemetry ownership lineage", () => {
  let runtime: ApiRuntime;

  beforeEach(async () => {
    runtime = createApi({
      config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false" }),
      database: new ClimateDatabase(":memory:", false),
      startBackground: false,
    });
    await request(runtime.app).post("/api/v1/properties").send({ id: "lineage-a", name: "Lineage A" }).expect(201);
    await request(runtime.app).post("/api/v1/properties").send({ id: "lineage-b", name: "Lineage B" }).expect(201);
    await request(runtime.app).post("/api/v1/houses").send({
      id: "lineage-house-a",
      propertyId: "lineage-a",
      name: "House A",
      timezone: "UTC",
      floors: [floor("floor-a")],
    }).expect(201);
    await request(runtime.app).post("/api/v1/houses").send({
      id: "lineage-house-b",
      propertyId: "lineage-b",
      name: "House B",
      timezone: "UTC",
      floors: [floor("floor-b")],
    }).expect(201);
    await request(runtime.app).post("/api/v1/sensors").send({
      id: "lineage-sensor",
      houseId: "lineage-house-a",
      floorId: "floor-a",
      name: "Lineage sensor",
      room: "Room",
      model: "Test",
      x: 1,
      y: 1,
      z: 1,
      tags: [],
      enabled: true,
    }).expect(201);
  });

  afterEach(() => runtime.close());

  function addReading(source: "api" | "mock"): void {
    runtime.database.insertReadings([{
      sensorId: "lineage-sensor",
      timestamp: "2026-07-18T10:00:00.000Z",
      temperature: 21,
      humidity: 45,
      battery: 90,
      source,
      quality: "good",
    }]);
  }

  it("rejects moves and hard deletes but permits a non-destructive Home hide", async () => {
    addReading("api");

    await request(runtime.app).patch("/api/v1/sensors/lineage-sensor").send({
      houseId: "lineage-house-b",
      floorId: "floor-b",
      x: 1,
      y: 1,
      z: 1,
    }).expect(409).expect(({ body }) => expect(body.error.code).toBe("TELEMETRY_LINEAGE_REQUIRED"));
    await request(runtime.app).patch("/api/v1/houses/lineage-house-a").send({ propertyId: "lineage-b" })
      .expect(409).expect(({ body }) => expect(body.error.code).toBe("TELEMETRY_LINEAGE_REQUIRED"));

    for (const path of ["/api/v1/sensors/lineage-sensor", "/api/v1/properties/lineage-a"]) {
      await request(runtime.app).delete(path).expect(409)
        .expect(({ body }) => expect(body.error.code).toBe("TELEMETRY_LINEAGE_REQUIRED"));
    }

    await request(runtime.app).delete("/api/v1/houses/lineage-house-a").expect(204);
    expect(runtime.database.getSensor("lineage-sensor")).toBeNull();
    expect(runtime.database.getHouse("lineage-house-a")).toBeNull();
    expect(runtime.database.db.prepare("SELECT COUNT(*) AS count FROM readings WHERE sensor_id = ?")
      .get("lineage-sensor")).toMatchObject({ count: 1 });
    expect(runtime.database.getProperty("lineage-a")).not.toBeNull();
  });

  it("enforces the lineage guard below the HTTP layer", () => {
    addReading("api");
    const conflict = (operation: () => unknown): void => {
      try {
        operation();
        throw new Error("Expected a telemetry lineage conflict");
      } catch (error) {
        expect(error).toBeInstanceOf(ClimateDataValidationError);
        expect((error as ClimateDataValidationError).code).toBe("TELEMETRY_LINEAGE_REQUIRED");
      }
    };

    conflict(() => runtime.database.updateSensor("lineage-sensor", {
      houseId: "lineage-house-b", floorId: "floor-b", x: 1, y: 1, z: 1,
    }));
    conflict(() => runtime.database.updateHouse("lineage-house-a", { propertyId: "lineage-b" }));
    conflict(() => runtime.database.deleteSensor("lineage-sensor"));
    expect(runtime.database.deleteHouse("lineage-house-a")).toBe(true);
    conflict(() => runtime.database.deleteProperty("lineage-a"));
  });

  it("still permits removing mock-only telemetry resources", async () => {
    addReading("mock");
    await request(runtime.app).delete("/api/v1/sensors/lineage-sensor").expect(204);
    await request(runtime.app).delete("/api/v1/houses/lineage-house-a").expect(204);
    expect(runtime.database.db.prepare("SELECT deleted_at FROM houses WHERE id = ?")
      .get("lineage-house-a")).toMatchObject({ deleted_at: expect.any(String) });
  });
});
