import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { ClimateDatabase } from "../src/db.js";

const config: AppConfig = {
  port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: "integration-secrets.test.json", assetDirectory: ".",
  mockEnabled: false, mockIntervalMs: 25, retentionDays: 730, ingestApiKey: null,
  haUrl: null, haToken: null, haEntityMapFile: null,
  tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null, tpLinkDeviceMapFile: null,
  tpLinkPollIntervalMs: 10_000, tpLinkPython: "python", tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
  alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
};

describe("registry-driven measurements API", () => {
  let runtime: ApiRuntime;

  beforeEach(() => { runtime = createApi({ config, startBackground: false }); });
  afterEach(() => runtime.close());

  it("seeds capabilities, validates custom definitions, and disables without orphaning data", async () => {
    const listed = await request(runtime.app).get("/api/v2/measurement-definitions").expect(200);
    expect(listed.body.definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "temperature", unit: "°C", builtin: true, spatialInterpolation: true, forecastSupported: true }),
      expect.objectContaining({ id: "humidity", unit: "%", builtin: true }),
      expect.objectContaining({ id: "co2", unit: "ppm", colorScale: "air-quality", forecastSupported: true }),
    ]));

    const created = await request(runtime.app).post("/api/v2/measurement-definitions").send({
      id: "voc_index", labels: { en: "VOC index" }, unit: "index", precision: 0,
      validMin: 0, validMax: 500, displayMin: 0, displayMax: 300, interpolationDelta: 20,
    }).expect(201);
    expect(created.body.definition).toMatchObject({
      id: "voc_index", builtin: false, enabled: true, colorScale: "sequential",
      spatialInterpolation: false, forecastSupported: false,
    });

    await request(runtime.app).post("/api/v2/measurement-definitions").send({
      id: "__proto__", labels: { en: "Bad" }, unit: "x",
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_MEASUREMENT_ID"));
    await request(runtime.app).patch("/api/v2/measurement-definitions/voc_index").send({ id: "renamed" })
      .expect(409).expect(({ body }) => expect(body.error.code).toBe("IMMUTABLE_FIELD"));

    await request(runtime.app).post("/api/v2/measurements").send({
      sensorId: "sensor-01", metric: "voc_index", value: 42, canonicalUnit: "index", timestamp: "2026-07-14T08:00:00Z",
    }).expect(201);
    await request(runtime.app).patch("/api/v2/measurement-definitions/voc_index").send({ unit: "points" })
      .expect(409).expect(({ body }) => expect(body.error.code).toBe("UNIT_IMMUTABLE"));
    const disabled = await request(runtime.app).delete("/api/v2/measurement-definitions/voc_index").expect(200);
    expect(disabled.body.definition.enabled).toBe(false);
    const history = await request(runtime.app).get("/api/v2/measurements/history")
      .query({ sensorId: "sensor-01", metric: "voc_index", from: "2026-01-01T00:00:00Z", to: "2027-01-01T00:00:00Z" }).expect(200);
    expect(history.body.samples).toHaveLength(1);
  });

  it("persists sensor metric bindings in the normalized registry relation", async () => {
    await request(runtime.app).patch("/api/v1/sensors/sensor-01").send({
      measurementEntityIds: { co2: "sensor.living_co2", humidity: "sensor.living_humidity" },
    }).expect(200);
    const sensor = await request(runtime.app).get("/api/v1/sensors/sensor-01").expect(200);
    expect(sensor.body.sensor.measurementEntityIds).toEqual({ co2: "sensor.living_co2", humidity: "sensor.living_humidity" });
    const rows = runtime.database.db.prepare("SELECT metric, entity_id FROM sensor_measurement_bindings WHERE sensor_id = ? ORDER BY metric")
      .all("sensor-01") as unknown as Array<{ metric: string; entity_id: string }>;
    expect(rows).toEqual([
      { metric: "co2", entity_id: "sensor.living_co2" },
      { metric: "humidity", entity_id: "sensor.living_humidity" },
    ]);
  });

  it("keeps canonical units immutable for samples, sensor bindings, and alert rules", async () => {
    const definition = (id: string) => ({ id, labels: { en: id }, unit: "unit-a", interpolationDelta: 1 });
    for (const id of ["bound_metric", "alert_metric", "unused_metric"]) {
      await request(runtime.app).post("/api/v2/measurement-definitions").send(definition(id)).expect(201);
    }
    await request(runtime.app).patch("/api/v1/sensors/sensor-01").send({
      measurementEntityIds: { bound_metric: "sensor.bound_metric" },
    }).expect(200);
    await request(runtime.app).patch("/api/v2/measurement-definitions/bound_metric").send({ unit: "unit-b" })
      .expect(409).expect(({ body }) => expect(body.error.code).toBe("UNIT_IMMUTABLE"));

    await request(runtime.app).post("/api/v1/alert-rules").send({
      id: "custom-alert", name: "Custom alert", sensorId: "sensor-01", metric: "alert_metric",
      operator: "gte", threshold: 10, durationSeconds: 1, severity: "warning", enabled: true, webhookEnabled: false,
    }).expect(201);
    await request(runtime.app).patch("/api/v2/measurement-definitions/alert_metric").send({ unit: "unit-b" })
      .expect(409).expect(({ body }) => expect(body.error.code).toBe("UNIT_IMMUTABLE"));
    await request(runtime.app).patch("/api/v2/measurement-definitions/unused_metric").send({ unit: "unit-b" })
      .expect(200).expect(({ body }) => expect(body.definition.unit).toBe("unit-b"));
  });

  it("rejects display bounds outside either edge of the valid range", async () => {
    await request(runtime.app).post("/api/v2/measurement-definitions").send({
      id: "bad_display_low", labels: { en: "Bad low" }, unit: "x", validMin: 10, displayMax: 5,
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_RANGE"));
    await request(runtime.app).post("/api/v2/measurement-definitions").send({
      id: "bad_display_high", labels: { en: "Bad high" }, unit: "x", validMax: 50, displayMin: 100,
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_RANGE"));
  });

  it("stores sparse samples independently, keeps latest ordering, deduplicates retries, and rejects batches atomically", async () => {
    const samples = [
      { sensorId: "sensor-01", metric: "co2", value: 900, canonicalUnit: "ppm", timestamp: "2026-07-14T10:02:00Z" },
      { sensorId: "sensor-01", metric: "temperature", value: 21.5, canonicalUnit: "°C", timestamp: "2026-07-14T10:01:00Z" },
      { sensorId: "sensor-01", metric: "humidity", value: 47, canonicalUnit: "%", timestamp: "2026-07-14T10:01:00Z" },
    ];
    await request(runtime.app).post("/api/v2/measurements").send({ samples }).expect(201)
      .expect(({ body }) => expect(body.accepted).toBe(3));
    await request(runtime.app).post("/api/v2/measurements").send({ sample: samples[0] }).expect(201)
      .expect(({ body }) => expect(body.accepted).toBe(0));
    await request(runtime.app).post("/api/v2/measurements").send({
      ...samples[0], value: 700, timestamp: "2026-07-14T09:00:00Z",
    }).expect(201);

    const snapshot = await request(runtime.app).get("/api/v2/measurements/snapshot").query({ houseId: "house-main" }).expect(200);
    const sensor = snapshot.body.snapshot.find((item: { sensorId: string }) => item.sensorId === "sensor-01");
    expect(sensor.measurements.co2).toMatchObject({ value: 900, timestamp: "2026-07-14T10:02:00.000Z" });

    await request(runtime.app).post("/api/v2/measurements").send({ samples: [
      { ...samples[0], value: 950, timestamp: "2026-07-14T10:03:00Z" },
      { ...samples[0], metric: "missing_metric", value: 1, canonicalUnit: "x", timestamp: "2026-07-14T10:04:00Z" },
    ] }).expect(404);
    const history = await request(runtime.app).get("/api/v2/measurements/history").query({
      sensorId: "sensor-01", metric: "co2", from: "2026-07-14T08:00:00Z", to: "2026-07-14T11:00:00Z",
    }).expect(200);
    expect(history.body.samples.map((sample: { value: number }) => sample.value)).toEqual([700, 900]);
  });

  it("allows small sender clock skew but atomically rejects samples too far in the future", async () => {
    const now = Date.now();
    const valid = {
      sensorId: "sensor-01", metric: "co2", value: 700, canonicalUnit: "ppm",
      timestamp: new Date(now).toISOString(),
    };
    await request(runtime.app).post("/api/v2/measurements").send({ samples: [
      valid,
      { ...valid, value: 701, timestamp: new Date(now + 6 * 60_000).toISOString() },
    ] }).expect(422).expect(({ body }) => expect(body.error.code).toBe("TIMESTAMP_TOO_FAR_IN_FUTURE"));
    expect(runtime.database.measurementHistory(
      "sensor-01", "co2", new Date(now - 1_000).toISOString(), new Date(now + 1_000).toISOString(),
    )).toHaveLength(0);

    await request(runtime.app).post("/api/v2/measurements").send({
      ...valid, timestamp: new Date(now + 4 * 60_000).toISOString(),
    }).expect(201);
  });

  it("evaluates alerts only for the arriving metric and exposes explicit forecast capability", async () => {
    const base = Date.now() - 5_000;
    await request(runtime.app).post("/api/v1/alert-rules").send({
      id: "co2-alert", name: "High CO2", sensorId: "sensor-01", metric: "co2", operator: "gte",
      threshold: 800, durationSeconds: 1, severity: "warning", enabled: true, webhookEnabled: false,
    }).expect(201);
    await request(runtime.app).post("/api/v2/measurements").send({
      sensorId: "sensor-01", metric: "humidity", value: 99, canonicalUnit: "%", timestamp: new Date(base).toISOString(),
    }).expect(201);
    expect(runtime.database.listAlertEvents()).toHaveLength(0);
    await request(runtime.app).post("/api/v2/measurements").send({
      sensorId: "sensor-01", metric: "co2", value: 900, canonicalUnit: "ppm", timestamp: new Date(base + 1_000).toISOString(),
    }).expect(201);
    expect(runtime.database.listAlertEvents()).toHaveLength(0);
    await request(runtime.app).post("/api/v2/measurements").send({
      sensorId: "sensor-01", metric: "co2", value: 900, canonicalUnit: "ppm", timestamp: new Date(base + 2_500).toISOString(),
    }).expect(201);
    expect(runtime.database.listAlertEvents()).toEqual([expect.objectContaining({ metric: "co2", value: 900 })]);

    const forecast = await request(runtime.app).get("/api/v2/measurements/forecast")
      .query({ sensorId: "sensor-01", metric: "co2", hours: 2 }).expect(200);
    expect(forecast.body.forecast).toHaveLength(2);
    expect(forecast.body.forecast[0]).toMatchObject({ sensorId: "sensor-01", metric: "co2" });

    await request(runtime.app).post("/api/v2/measurement-definitions").send({
      id: "noise", labels: { en: "Noise" }, unit: "dBA", interpolationDelta: 5,
    }).expect(201);
    await request(runtime.app).get("/api/v2/measurements/forecast").query({ sensorId: "sensor-01", metric: "noise" })
      .expect(422).expect(({ body }) => expect(body.error.code).toBe("FORECAST_UNSUPPORTED"));
  });

  it("keeps stale-quality samples from starting or resolving alert state", async () => {
    const base = Date.now() - 10_000;
    const sample = (value: number, offsetMs: number, quality: "good" | "stale") => ({
      sensorId: "sensor-01",
      metric: "co2",
      value,
      canonicalUnit: "ppm",
      timestamp: new Date(base + offsetMs).toISOString(),
      quality,
    });
    await request(runtime.app).post("/api/v1/alert-rules").send({
      id: "stale-alert", name: "High CO2", sensorId: "sensor-01", metric: "co2", operator: "gte",
      threshold: 800, durationSeconds: 1, severity: "warning", enabled: true, webhookEnabled: false,
    }).expect(201);

    await request(runtime.app).post("/api/v2/measurements").send(sample(900, 0, "stale")).expect(201);
    await request(runtime.app).post("/api/v2/measurements").send(sample(900, 2_000, "good")).expect(201);
    expect(runtime.database.listAlertEvents()).toHaveLength(0);

    await request(runtime.app).post("/api/v2/measurements").send(sample(900, 4_000, "good")).expect(201);
    expect(runtime.database.listAlertEvents(200, true)).toHaveLength(1);
    await request(runtime.app).post("/api/v2/measurements").send(sample(700, 5_000, "stale")).expect(201);
    expect(runtime.database.listAlertEvents(200, true)).toHaveLength(1);

    await request(runtime.app).post("/api/v2/measurements").send(sample(700, 6_000, "good")).expect(201);
    expect(runtime.database.listAlertEvents(200, true)).toHaveLength(0);
    expect(runtime.database.listAlertEvents()[0]?.resolvedAt).toBe(new Date(base + 6_000).toISOString());
  });

  it("imports historical samples without live alerts and safely ignores retried duplicates", async () => {
    await request(runtime.app).post("/api/v1/alert-rules").send({
      id: "import-alert", name: "High imported CO2", sensorId: "sensor-01", metric: "co2", operator: "gte",
      threshold: 800, durationSeconds: 1, severity: "warning", enabled: true, webhookEnabled: false,
    }).expect(201);
    await request(runtime.app).post("/api/v2/measurements").send({
      sensorId: "sensor-01", metric: "co2", value: 700, canonicalUnit: "ppm", timestamp: "2025-01-15T09:00:00Z",
    }).expect(201);
    await request(runtime.app).patch("/api/v1/sensors/sensor-01").send({ enabled: false }).expect(200);
    const payload = { samples: [
      { sensorId: "sensor-01", metric: "co2", value: 701, canonicalUnit: "ppm", timestamp: "2025-01-15T09:00:00Z" },
      { sensorId: "sensor-01", metric: "co2", value: 950, canonicalUnit: "ppm", timestamp: "2025-01-15T10:00:00Z", source: "api", quality: "good" },
    ] };

    await request(runtime.app).post("/api/v2/measurements/import").send(payload).expect(201)
      .expect(({ body }) => expect(body).toEqual({ accepted: 1, ignoredDuplicates: 1 }));
    await request(runtime.app).post("/api/v2/measurements/import").send(payload).expect(201)
      .expect(({ body }) => expect(body).toEqual({ accepted: 0, ignoredDuplicates: 2 }));

    expect(runtime.database.listAlertEvents()).toHaveLength(0);
    expect(runtime.database.measurementHistory(
      "sensor-01", "co2", "2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z",
    )).toEqual([
      expect.objectContaining({ value: 700, source: "api" }),
      expect.objectContaining({ value: 950, source: "import" }),
    ]);
  });

  it("emits realistic registered CO2 samples from the mock engine", () => {
    expect(runtime.database.getLatestMeasurementSample("sensor-01", "co2")).toBeNull();
    const readings = runtime.mock.generate();
    expect(readings[0]?.measurements?.co2).toBeGreaterThanOrEqual(350);
    expect(runtime.database.getLatestMeasurementSample("sensor-01", "co2")).toMatchObject({
      metric: "co2", canonicalUnit: "ppm", source: "mock", quality: "good",
    });
  });

  it("streams accepted generic samples as measurement SSE events", async () => {
    const server = createServer(runtime.app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    const controller = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v2/measurements/events?metric=co2`, { signal: controller.signal });
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("SSE response has no body");
      await request(runtime.app).post("/api/v2/measurements").send({
        sensorId: "sensor-01", metric: "co2", value: 875, canonicalUnit: "ppm", timestamp: "2026-07-14T12:00:00Z",
      }).expect(201);
      const read = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Timed out reading SSE event")), 2_000)),
      ]);
      const payload = new TextDecoder().decode(read.value);
      expect(payload).toContain("event: measurement");
      expect(payload).toContain('"metric":"co2"');
    } finally {
      controller.abort();
      server.close();
    }
  });

  it("purges raw tuples and EAV samples through timestamp-indexed bounded batches", async () => {
    runtime.database.createSensor({
      id: "retention-sensor", houseId: "house-main", floorId: "floor-ground", name: "Retention", room: "Room",
      model: "test", x: 1, y: 1, z: 1, tags: [], enabled: true,
    });
    await request(runtime.app).post("/api/v2/measurements").send({ samples: [
      ...Array.from({ length: 5 }, (_, index) => ({
        sensorId: "retention-sensor", metric: "co2", value: 500 + index, canonicalUnit: "ppm",
        timestamp: `2019-01-0${index + 1}T00:00:00Z`,
      })),
      { sensorId: "retention-sensor", metric: "co2", value: 600, canonicalUnit: "ppm", timestamp: "2021-01-01T00:00:00Z" },
    ] }).expect(201);
    await request(runtime.app).post("/api/v1/readings").send({ readings: [
      { sensorId: "retention-sensor", timestamp: "2019-02-01T00:00:00Z", temperature: 20, humidity: 40 },
      { sensorId: "retention-sensor", timestamp: "2019-02-02T00:00:00Z", temperature: 21, humidity: 41 },
      { sensorId: "retention-sensor", timestamp: "2021-02-01T00:00:00Z", temperature: 22, humidity: 42 },
    ] }).expect(201);

    const indexes = runtime.database.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as unknown as Array<{ name: string }>;
    expect(indexes.map(({ name }) => name)).toEqual(expect.arrayContaining(["idx_measurement_samples_time", "idx_readings_time"]));
    expect(runtime.database.purgeReadingsBefore("2020-01-01T00:00:00.000Z", 2)).toBe(11);
    expect(runtime.database.measurementHistory("retention-sensor", "co2", "2010-01-01T00:00:00Z", "2030-01-01T00:00:00Z")).toHaveLength(1);
    expect(runtime.database.history(["retention-sensor"], "2010-01-01T00:00:00Z", "2030-01-01T00:00:00Z")).toHaveLength(1);
  });

  it("serves truthful and complete version-specific OpenAPI documents", async () => {
    const v1 = await request(runtime.app).get("/api/v1/openapi.json").expect(200);
    expect(v1.body.servers).toEqual([{ url: "/api/v1", description: "Legacy climate tuple API" }]);
    expect(v1.body.paths).toHaveProperty("/houses");
    expect(v1.body.paths).not.toHaveProperty("/measurements");
    expect(v1.body.components.schemas.House.required).not.toContain("orientationDegrees");
    expect(v1.body.components.schemas.House.properties.orientationDegrees).toMatchObject({
      type: "number", minimum: 0, exclusiveMaximum: 360,
    });
    expect(v1.body.components.schemas.HouseCreate.properties.orientationDegrees).not.toHaveProperty("default");
    expect(v1.body.components.schemas.HousePatch.properties.orientationDegrees.oneOf).toEqual([
      { type: "number", minimum: 0, exclusiveMaximum: 360 },
      { type: "null" },
    ]);

    const v2 = await request(runtime.app).get("/api/v2/openapi.json").expect(200);
    expect(v2.body.servers).toEqual([{ url: "/api/v2", description: "Registry-driven measurements API" }]);
    expect(v2.body.paths).toHaveProperty("/measurement-definitions");
    expect(v2.body.paths).toHaveProperty("/measurements/history");
    expect(v2.body.paths).toHaveProperty("/measurements/import");
    expect(v2.body.paths).not.toHaveProperty("/houses");
    expect(v2.body.paths["/measurements"].post.requestBody.content["application/json"].schema.oneOf)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: "array" })]));
    expect(v2.body.paths["/measurement-definitions"].get.parameters.map((item: { name: string }) => item.name)).toContain("includeDisabled");
    expect(v2.body.paths["/measurement-definitions/{id}"].patch.requestBody.content["application/json"].schema.$ref)
      .toBe("#/components/schemas/MeasurementDefinitionPatch");
    expect(v2.body.paths["/measurements/events"].get.parameters.map((item: { name: string }) => item.name))
      .toEqual(["sensorId", "metric"]);
  });
});

describe("legacy measurement migration", () => {
  it("univots each legacy tuple once and preserves counts across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "climate-twin-migration-"));
    const path = join(directory, "legacy.sqlite");
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE houses (id TEXT PRIMARY KEY, name TEXT NOT NULL, timezone TEXT NOT NULL, floors_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE sensors (id TEXT PRIMARY KEY, house_id TEXT NOT NULL REFERENCES houses(id), floor_id TEXT NOT NULL, name TEXT NOT NULL, room TEXT NOT NULL, model TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL, temperature_entity_id TEXT, humidity_entity_id TEXT, battery_entity_id TEXT, tags_json TEXT NOT NULL, enabled INTEGER NOT NULL);
        CREATE TABLE readings (id INTEGER PRIMARY KEY AUTOINCREMENT, sensor_id TEXT NOT NULL REFERENCES sensors(id), timestamp TEXT NOT NULL, temperature REAL NOT NULL, humidity REAL NOT NULL, battery REAL, source TEXT NOT NULL, quality TEXT NOT NULL);
        INSERT INTO houses VALUES ('house', 'House', 'UTC', '[{"id":"floor","name":"Floor","width":10,"height":10,"elevation":0,"walls":[],"rooms":[]}]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
        INSERT INTO sensors VALUES ('sensor', 'house', 'floor', 'Sensor', 'Room', 'Legacy', 1, 1, 1, NULL, NULL, NULL, '[]', 1);
        INSERT INTO readings(sensor_id,timestamp,temperature,humidity,battery,source,quality) VALUES ('sensor','2026-07-14T08:00:00Z',21,45,90,'api','good');
      `);
      legacy.close();

      const migrated = new ClimateDatabase(path, false);
      expect((migrated.db.prepare("SELECT COUNT(*) AS count FROM measurement_samples").get() as { count: number }).count).toBe(2);
      expect((migrated.db.prepare("SELECT value FROM metadata WHERE key = 'measurement_eav_v2'").get() as { value: string }).value).toBe("complete");
      expect((migrated.db.prepare("PRAGMA table_info(houses)").all() as Array<{ name: string }>).map((column) => column.name))
        .toContain("map_placement_json");
      expect(migrated.getHouse("house")).not.toHaveProperty("orientationDegrees");
      expect(migrated.getHouse("house")).not.toHaveProperty("mapPlacement");
      expect(migrated.updateHouse("house", { orientationDegrees: 225 })?.orientationDegrees).toBe(225);
      const mapPlacement = { latitude: 60, longitude: 25, metersPerPlanUnit: 0.5, footprintFloorId: "floor" };
      expect(migrated.updateHouse("house", { mapPlacement })?.mapPlacement).toEqual(mapPlacement);
      migrated.close();

      const reopened = new ClimateDatabase(path, false);
      expect((reopened.db.prepare("SELECT COUNT(*) AS count FROM measurement_samples").get() as { count: number }).count).toBe(2);
      expect(reopened.getHouse("house")?.orientationDegrees).toBe(225);
      expect(reopened.getHouse("house")?.mapPlacement).toEqual(mapPlacement);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
