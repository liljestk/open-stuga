import { mkdtempSync, renameSync, rmSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import express from "express";

import request from "supertest";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ClimateDatabase } from "../src/db.js";

import {
  createLocalSpatialLayerRuntime,
  registerSpatialLayerRoutes,
  sourceDatabaseId,
  SpatialLayerStateStore,
  SpatialSourceIdentityCollisionError,
  type LocalSpatialLayerRuntime,
} from "../src/spatial-layers/index.js";

import { SPATIAL_PARTITION_TABLES, coreDatabases, documentedResponseSchema, expectOpenApiConformance, partition, partitionRowCount, runtimes, scope, seedEverySpatialTable, seededRuntime, snapshot, spatialOpenApiSchemas, temporaryDirectories } from "./spatial-layersTestSupport.js";
// These tests exercise the routes themselves; production wires real grants.
const allowAllSpatialAccess = { authorizeScope: () => true, authorizeMutation: () => true };

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  for (const database of coreDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("local spatial layer API", () => {
  it("provides resolved house/property topology and current layers from the same snapshots", async () => {
    const { runtime, core } = seededRuntime();
    const house = core.listHouses()[0]!;
    const property = core.getProperty(house.propertyId)!;
    const at = new Date().toISOString();
    await runtime.host.inferScope({ kind: "house", id: house.id }, at);
    await runtime.host.inferScope({ kind: "property", id: property.id }, at);
    const app = express();
    app.use(express.json());
    registerSpatialLayerRoutes(app, { runtime, ...allowAllSpatialAccess });

    const houseConfig = await request(app).get(`/api/v1/houses/${house.id}/layers/config`).expect(200);
    expect(houseConfig.body.topology.scope).toEqual({ kind: "house", id: house.id });
    expect(houseConfig.body.topology.zones.length).toBeGreaterThan(0);
    expect(houseConfig.body.assignments).toEqual(expect.arrayContaining([expect.objectContaining({ engineId: "climate-scalars", enabled: true })]));
    expectOpenApiConformance(houseConfig.body, documentedResponseSchema("/houses/{id}/layers/config", "get", 200));

    const currentSnapshotReads = vi.spyOn(runtime.state, "currentSnapshots");
    const houseCurrent = await request(app).get(`/api/v1/houses/${house.id}/layers/current`).expect(200);
    expect(houseCurrent.body.topology.zones).toHaveLength(houseConfig.body.topology.zones.length);
    expect(houseCurrent.body.layers.length).toBeGreaterThan(0);
    expect(houseCurrent.body.health).toEqual(expect.arrayContaining([expect.objectContaining({ engineId: "climate-scalars" })]));
    expect(currentSnapshotReads).toHaveBeenCalledOnce();
    expectOpenApiConformance(houseCurrent.body, spatialOpenApiSchemas.SpatialLayerCurrent!);

    currentSnapshotReads.mockClear();
    const propertyCurrent = await request(app).get(`/api/v1/properties/${property.id}/layers/current`).expect(200);
    expect(propertyCurrent.body.topology.scope).toEqual({ kind: "property", id: property.id });
    const propertyFrame = propertyCurrent.body.topology.frames[0];
    expect(propertyFrame.kind).toBe("property-local-3d");
    if (propertyFrame.unit === "m") expect(propertyFrame.origin).toEqual({ x: 0, y: 0, z: 0 });
    else expect(propertyFrame).toMatchObject({ unit: "normalized" });
    expect(propertyCurrent.body.topology.zones).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "building" })]));
    expect(propertyCurrent.body.layers.length).toBeGreaterThan(0);
    expect(currentSnapshotReads).toHaveBeenCalledOnce();
    expectOpenApiConformance(propertyCurrent.body, spatialOpenApiSchemas.SpatialLayerCurrent!);

    const houseHealth = await request(app).get(`/api/v1/houses/${house.id}/layers/health`).expect(200);
    expect(houseCurrent.body.health).toEqual(houseHealth.body.engines);
    expectOpenApiConformance(houseHealth.body, documentedResponseSchema("/houses/{id}/layers/health", "get", 200));

    const houseHistory = await request(app).get(`/api/v1/houses/${house.id}/layers/history`).query({
      from: new Date(Date.parse(at) - 60_000).toISOString(),
      to: new Date(Date.parse(at) + 60_000).toISOString(),
    }).expect(200);
    expectOpenApiConformance(houseHistory.body, documentedResponseSchema("/houses/{id}/layers/history", "get", 200));
  });

  it("bounds requested layer IDs before synchronous snapshot lookups", async () => {
    const { runtime, core } = seededRuntime();
    const house = core.listHouses()[0]!;
    const app = express();
    app.use(express.json());
    registerSpatialLayerRoutes(app, { runtime, ...allowAllSpatialAccess });

    await request(app)
      .get(`/api/v1/houses/${house.id}/layers/current`)
      .query({ layers: Array.from({ length: 101 }, (_, index) => `layer-${index}`).join(",") })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("TOO_MANY_LAYERS"));
  });

  it("starts, reports, and stops bounded Home inference sessions without deleting retained state", async () => {
    const { runtime, core } = seededRuntime();
    const house = core.listHouses()[0]!;
    await runtime.host.inferScope({ kind: "house", id: house.id }, new Date().toISOString());
    const app = express();
    app.use(express.json());
    registerSpatialLayerRoutes(app, { runtime, ...allowAllSpatialAccess });

    const retainedBefore = runtime.state.db.prepare(`SELECT
      (SELECT COUNT(*) FROM spatial_config_versions) AS configurations,
      (SELECT COUNT(*) FROM spatial_layer_snapshots) AS snapshots`).get() as {
        configurations: number;
        snapshots: number;
      };
    expect(retainedBefore.configurations).toBeGreaterThan(0);
    expect(retainedBefore.snapshots).toBeGreaterThan(0);

    const initial = await request(app)
      .get(`/api/v1/houses/${house.id}/layers/inference-session`)
      .expect(200);
    expect(initial.body).toEqual({ session: null });
    expectOpenApiConformance(initial.body, documentedResponseSchema("/houses/{id}/layers/inference-session", "get", 200));
    await request(app)
      .post(`/api/v1/houses/${house.id}/layers/inference-session`)
      .send({ durationMinutes: 10, cadenceMinutes: 5 })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("INVALID_SESSION_DURATION"));

    const started = await request(app)
      .post(`/api/v1/houses/${house.id}/layers/inference-session`)
      .send({})
      .expect(201);
    expect(started.body.session).toMatchObject({ houseId: house.id, status: "active", cadenceMinutes: 10 });
    expect(Date.parse(started.body.session.expiresAt) - Date.parse(started.body.session.startedAt)).toBe(60 * 60_000);
    expectOpenApiConformance(started.body, documentedResponseSchema("/houses/{id}/layers/inference-session", "post", 201));
    expect(runtime.state.db.prepare(`SELECT scope_kind, scope_id, session_id
      FROM spatial_inference_jobs WHERE status = 'pending'`).get()).toMatchObject({
      scope_kind: "house", scope_id: house.id, session_id: started.body.session.id,
    });
    await request(app)
      .post(`/api/v1/houses/${house.id}/layers/inference-session`)
      .send({})
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("SPATIAL_SESSION_ACTIVE"));

    const status = await request(app)
      .get(`/api/v1/houses/${house.id}/layers/inference-session`)
      .expect(200);
    expect(status.body.session.id).toBe(started.body.session.id);
    expectOpenApiConformance(status.body, documentedResponseSchema("/houses/{id}/layers/inference-session", "get", 200));

    const stopped = await request(app)
      .delete(`/api/v1/houses/${house.id}/layers/inference-session`)
      .expect(200);
    expect(stopped.body.session).toMatchObject({ id: started.body.session.id, status: "stopped" });
    expectOpenApiConformance(stopped.body, documentedResponseSchema("/houses/{id}/layers/inference-session", "delete", 200));
    expect(runtime.state.db.prepare("SELECT status FROM spatial_inference_jobs WHERE session_id = ?")
      .get(started.body.session.id)).toMatchObject({ status: "cancelled" });

    const retainedAfter = runtime.state.db.prepare(`SELECT
      (SELECT COUNT(*) FROM spatial_config_versions) AS configurations,
      (SELECT COUNT(*) FROM spatial_layer_snapshots) AS snapshots`).get();
    expect(retainedAfter).toEqual(retainedBefore);

    await request(app).post(`/api/v1/houses/${house.id}/layers/infer`).send({}).expect(404);
    await request(app).post(`/api/v1/properties/${house.propertyId}/layers/infer`).send({}).expect(404);
    await request(app).post(`/api/v1/properties/${house.propertyId}/layers/inference-session`).send({}).expect(404);
  });

  it("returns documented payloads for spatial binding, session, and context writes", async () => {
    const { runtime, core } = seededRuntime();
    const house = core.listHouses()[0]!;
    const sensor = core.listSensors(house.id)[0]!;
    const app = express();
    app.use(express.json());
    registerSpatialLayerRoutes(app, { runtime, ...allowAllSpatialAccess });
    const overview = await runtime.host.describeScope({ kind: "house", id: house.id });
    const zone = overview.topology.zones[0]!;
    const frame = overview.topology.frames.find((candidate) => candidate.id === zone.frameId)!;

    const binding = await request(app)
      .post(`/api/v1/houses/${house.id}/layers/bindings`)
      .send({ sensorId: sensor.id, zoneId: zone.id, frameId: frame.id, position: zone.centroid, role: "primary" })
      .expect(201);
    expectOpenApiConformance(binding.body, documentedResponseSchema("/houses/{id}/layers/bindings", "post", 201));

    const now = Date.now();
    const session = await request(app)
      .post(`/api/v1/houses/${house.id}/layers/calibration-sessions`)
      .send({
        kind: "co-location",
        status: "completed",
        startAt: new Date(now - 120_000).toISOString(),
        endAt: new Date(now - 60_000).toISOString(),
        intervention: { reference: "portable-standard" },
        notes: "Schema conformance test",
      })
      .expect(201);
    expectOpenApiConformance(session.body, documentedResponseSchema("/houses/{id}/layers/calibration-sessions", "post", 201));

    const context = await request(app)
      .post(`/api/v1/houses/${house.id}/layers/context-events`)
      .send({
        kind: "door-open",
        startAt: new Date(now - 30_000).toISOString(),
        zoneIds: [zone.id],
        strength: 0.5,
        source: "user",
        payload: { reason: "schema-test" },
      })
      .expect(201);
    expectOpenApiConformance(context.body, documentedResponseSchema("/houses/{id}/layers/context-events", "post", 201));
  });

  it("rejects context events for a nonexistent core house without creating experimental state", async () => {
    const { runtime } = seededRuntime();
    const app = express();
    app.use(express.json());
    registerSpatialLayerRoutes(app, { runtime, ...allowAllSpatialAccess });
    const now = new Date().toISOString();

    await request(app)
      .post("/api/v1/houses/missing-house/layers/context-events")
      .send({ kind: "door-open", startAt: now, source: "user" })
      .expect(404);

    expect(runtime.state.listContextEvents(
      runtime.host.partition,
      "missing-house",
      new Date(Date.parse(now) - 60_000).toISOString(),
      new Date(Date.parse(now) + 60_000).toISOString(),
    )).toEqual([]);
  });

  it("round-trips the public co-location calibration method through legacy SQLite encoding", async () => {
    const { runtime, core } = seededRuntime();
    const house = core.listHouses()[0]!;
    const sensor = core.listSensors(house.id)[0]!;
    const app = express();
    app.use(express.json());
    registerSpatialLayerRoutes(app, { runtime, ...allowAllSpatialAccess });

    const created = await request(app)
      .post(`/api/v1/houses/${house.id}/layers/calibrations`)
      .send({
        sensorId: sensor.id,
        temperatureOffsetC: 0.25,
        humidityOffsetPct: -1.5,
        responseLagSeconds: 30,
        confidence: 0.9,
        method: "co-location",
      })
      .expect(201);

    expect(created.body.calibration.method).toBe("co-location");
    expectOpenApiConformance(created.body, documentedResponseSchema("/houses/{id}/layers/calibrations", "post", 201));
    expect(runtime.state.db.prepare("SELECT method FROM spatial_sensor_calibrations WHERE id = ?")
      .get(created.body.calibration.id)).toEqual({ method: "co_location" });

    const listed = await request(app).get(`/api/v1/houses/${house.id}/layers/calibrations`).expect(200);
    expect(listed.body.calibrations).toEqual([expect.objectContaining({ method: "co-location" })]);
    expectOpenApiConformance(listed.body.calibrations[0], spatialOpenApiSchemas.SpatialSensorCalibration!);
  });

  it("rejects undocumented spatial write fields and non-nullable type mismatches", async () => {
    const { runtime, core } = seededRuntime();
    const house = core.listHouses()[0]!;
    const sensor = core.listSensors(house.id)[0]!;
    const app = express();
    app.use(express.json());
    registerSpatialLayerRoutes(app, { runtime, ...allowAllSpatialAccess });
    const overview = await runtime.host.describeScope({ kind: "house", id: house.id });
    const zone = overview.topology.zones[0]!;
    const frame = overview.topology.frames.find((candidate) => candidate.id === zone.frameId)!;

    const cases: Array<{ path: string; method: "post" | "put"; body: Record<string, unknown> }> = [
      {
        method: "put", path: `/api/v1/houses/${house.id}/layers/config`,
        body: { baseVersion: 0, config: {}, undocumented: true },
      },
      {
        method: "post", path: `/api/v1/houses/${house.id}/layers/inference-session`,
        body: { undocumented: true },
      },
      {
        method: "post", path: `/api/v1/houses/${house.id}/layers/ground-truth`,
        body: { label: "occupied", undocumented: true },
      },
      {
        method: "post", path: `/api/v1/houses/${house.id}/layers/ground-truth`,
        body: { label: "occupied", source: null },
      },
      {
        method: "post", path: `/api/v1/houses/${house.id}/layers/bindings`,
        body: { sensorId: sensor.id, zoneId: zone.id, frameId: frame.id, position: { ...zone.centroid, undocumented: 1 }, role: "primary" },
      },
      {
        method: "post", path: `/api/v1/houses/${house.id}/layers/calibrations`,
        body: { id: null, sensorId: sensor.id, temperatureOffsetC: 0, humidityOffsetPct: 0, confidence: 1, method: "manual" },
      },
      {
        method: "post", path: `/api/v1/houses/${house.id}/layers/calibration-sessions`,
        body: { kind: "co-location", status: null },
      },
      {
        method: "post", path: `/api/v1/houses/${house.id}/layers/context-events`,
        body: { kind: "known-empty", source: null },
      },
    ];

    for (const testCase of cases) {
      const call = request(app)[testCase.method](testCase.path).send(testCase.body);
      await call.expect(400).expect(({ body }) => {
        expect(["UNKNOWN_FIELD", "INVALID_FIELD"]).toContain(body.error.code);
      });
    }
  });

  it("validates and commits calibration sessions with children atomically", async () => {
    const { runtime, core } = seededRuntime();
    const house = core.listHouses()[0]!;
    const sensor = core.listSensors(house.id)[0]!;
    const app = express();
    app.use(express.json());
    registerSpatialLayerRoutes(app, { runtime, ...allowAllSpatialAccess });
    const endpoint = `/api/v1/houses/${house.id}/layers/calibration-sessions`;
    const calibration = {
      sensorId: sensor.id,
      temperatureOffsetC: 0.1,
      humidityOffsetPct: -0.5,
      confidence: 0.9,
      method: "co-location",
    };
    const counts = (): { sessions: number; calibrations: number } => ({
      sessions: Number((runtime.state.db.prepare("SELECT COUNT(*) AS count FROM spatial_calibration_sessions").get() as { count: number }).count),
      calibrations: Number((runtime.state.db.prepare("SELECT COUNT(*) AS count FROM spatial_sensor_calibrations").get() as { count: number }).count),
    });

    await request(app).post(endpoint).send({ kind: "co-location", calibrations: {} })
      .expect(400).expect(({ body }) => expect(body.error.code).toBe("INVALID_FIELD"));
    expect(counts()).toEqual({ sessions: 0, calibrations: 0 });

    await request(app).post(endpoint).send({
      kind: "co-location",
      calibrations: [{ ...calibration, undocumented: true }],
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("UNKNOWN_FIELD"));
    expect(counts()).toEqual({ sessions: 0, calibrations: 0 });

    // Both children parse successfully. The second insert then conflicts with
    // the first interval, exercising database rollback rather than pre-parse.
    await request(app).post(endpoint).send({
      kind: "co-location",
      calibrations: [calibration, calibration],
    }).expect(409).expect(({ body }) => expect(body.error.code).toBe("CALIBRATION_INTERVAL_OVERLAP"));
    expect(counts()).toEqual({ sessions: 0, calibrations: 0 });

    const created = await request(app).post(endpoint).send({
      kind: "co-location",
      status: "completed",
      calibrations: [calibration],
    }).expect(201);
    expect(created.body).toMatchObject({
      session: { houseId: house.id, kind: "co-location", status: "completed" },
      calibrations: [{ houseId: house.id, sensorId: sensor.id, method: "co-location" }],
    });
    expect(counts()).toEqual({ sessions: 1, calibrations: 1 });
  });

  it("returns a stable unavailable response without blocking the core API", async () => {
    const app = express();
    app.use(express.json());
    registerSpatialLayerRoutes(app, { runtime: null, ...allowAllSpatialAccess });
    await request(app).get("/api/v1/layer-engines").expect(200).expect({ enabled: false, engines: [] });
    await request(app).get("/api/v1/houses/house-main/layers/current").expect(503)
      .expect(({ body }) => expect(body.error.code).toBe("SPATIAL_LAYERS_UNAVAILABLE"));
  });

  it("keeps identical scope IDs isolated by source database and data mode", () => {
    const store = new SpatialLayerStateStore(":memory:");
    const demoA = { sourceDbId: "a", dataMode: "demo" as const };
    const realA = { sourceDbId: "a", dataMode: "real" as const };
    const demoB = { sourceDbId: "b", dataMode: "demo" as const };
    store.persistSnapshot(demoA, snapshot("demo-a"));
    store.persistSnapshot(realA, snapshot("real-a"));
    store.persistSnapshot(demoB, snapshot("demo-b"));
    expect(store.currentSnapshots(demoA, scope).map((item) => item.inputDigest)).toEqual(["demo-a"]);
    expect(store.currentSnapshots(realA, scope).map((item) => item.inputDigest)).toEqual(["real-a"]);
    expect(store.currentSnapshots(demoB, scope).map((item) => item.inputDigest)).toEqual(["demo-b"]);
    expect(sourceDatabaseId(":memory:", "one")).not.toBe(sourceDatabaseId(":memory:", "two"));
    store.close();
  });

  it("selects the latest current revision with bounded per-layer lookups", () => {
    const store = new SpatialLayerStateStore(":memory:");
    store.persistSnapshot(partition, snapshot("temperature-old", 19, "2026-07-16T11:00:00.000Z"));
    store.persistSnapshot(partition, snapshot("temperature-current", 21), "2026-07-16T12:00:01.000Z");
    store.persistSnapshot(partition, snapshot("temperature-revised", 22), "2026-07-16T12:00:02.000Z");
    store.persistSnapshot(partition, {
      ...snapshot("humidity-current", 55),
      layerId: "climate.relative-humidity",
    });

    expect(store.currentSnapshots(partition, scope).map((item) => [item.layerId, item.inputDigest])).toEqual([
      ["climate.relative-humidity", "humidity-current"],
      ["climate.temperature", "temperature-revised"],
    ]);
    expect(store.currentSnapshots(partition, scope, [
      "missing.layer",
      "climate.temperature",
      "climate.relative-humidity",
      "climate.temperature",
    ]).map((item) => item.layerId)).toEqual([
      "climate.relative-humidity",
      "climate.temperature",
    ]);
    store.close();
  });

  it("uses the ordered latest-run index without temporary sorts", () => {
    const store = new SpatialLayerStateStore(":memory:");
    const parameters = [partition.sourceDbId, partition.dataMode, scope.kind, scope.id];
    const plan = (sql: string, ...values: unknown[]) => (
      store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as unknown as Array<{ detail: string }>
    ).map((row) => row.detail);

    const latestRun = plan(`SELECT * FROM spatial_inference_runs
      WHERE source_db_id = ? AND data_mode = ? AND scope_kind = ? AND scope_id = ? AND engine_id = ?
      ORDER BY started_at DESC LIMIT 1`, ...parameters, "climate-scalars");
    expect(latestRun.join(" ")).toContain("idx_spatial_runs_engine_started");
    expect(latestRun.join(" ")).not.toContain("TEMP B-TREE");

    store.close();
  });

  it("atomically re-keys every legacy spatial table while preserving demo and real partitions", () => {
    const store = new SpatialLayerStateStore(":memory:");
    const legacySourceDbId = "0123456789abcdef01234567";
    const stableSourceDbId = "ee8dd676-0f56-4a7d-8df8-c755ef648e19";
    const legacyDemo = { sourceDbId: legacySourceDbId, dataMode: "demo" as const };
    const legacyReal = { sourceDbId: legacySourceDbId, dataMode: "real" as const };
    const stableDemo = { sourceDbId: stableSourceDbId, dataMode: "demo" as const };
    const stableReal = { sourceDbId: stableSourceDbId, dataMode: "real" as const };
    seedEverySpatialTable(store, legacyDemo, "demo");
    seedEverySpatialTable(store, legacyReal, "real");

    expect(store.rekeyLegacySourceDatabaseId(legacySourceDbId, stableSourceDbId)).toEqual({
      migratedModes: ["demo", "real"],
      migratedRows: SPATIAL_PARTITION_TABLES.length * 2,
    });
    for (const table of SPATIAL_PARTITION_TABLES) {
      expect(partitionRowCount(store, table, legacyDemo), `${table} legacy demo rows`).toBe(0);
      expect(partitionRowCount(store, table, legacyReal), `${table} legacy real rows`).toBe(0);
      expect(partitionRowCount(store, table, stableDemo), `${table} stable demo rows`).toBe(1);
      expect(partitionRowCount(store, table, stableReal), `${table} stable real rows`).toBe(1);
    }
    expect(store.currentSnapshots(stableDemo, scope)[0]?.inputDigest).toBe("snapshot-demo");
    expect(store.currentSnapshots(stableReal, scope)[0]?.inputDigest).toBe("snapshot-real");
    expect(store.rekeyLegacySourceDatabaseId(legacySourceDbId, stableSourceDbId)).toEqual({
      migratedModes: [], migratedRows: 0,
    });
    store.close();
  });

  it("re-keys large partitions in bounded batches without weakening atomicity", () => {
    const store = new SpatialLayerStateStore(":memory:");
    const legacySourceDbId = "legacy-batched-source";
    const stableSourceDbId = "stable-batched-source";
    const legacy = { sourceDbId: legacySourceDbId, dataMode: "real" as const };
    for (let index = 0; index < 300; index += 1) {
      store.putCheckpoint(legacy, scope, `checkpoint-${index}`, { index });
    }

    expect(store.rekeyLegacySourceDatabaseId(legacySourceDbId, stableSourceDbId)).toEqual({
      migratedModes: ["real"],
      migratedRows: 300,
    });
    expect(partitionRowCount(store, "spatial_checkpoints", legacy)).toBe(0);
    expect(partitionRowCount(store, "spatial_checkpoints", { sourceDbId: stableSourceDbId, dataMode: "real" })).toBe(300);
    store.close();
  });

  it("fails closed without partially re-keying when one stable target mode contains state", () => {
    const store = new SpatialLayerStateStore(":memory:");
    const legacySourceDbId = "legacy-source";
    const stableSourceDbId = "stable-source";
    const legacyDemo = { sourceDbId: legacySourceDbId, dataMode: "demo" as const };
    const legacyReal = { sourceDbId: legacySourceDbId, dataMode: "real" as const };
    const stableDemo = { sourceDbId: stableSourceDbId, dataMode: "demo" as const };
    const stableReal = { sourceDbId: stableSourceDbId, dataMode: "real" as const };
    store.putCheckpoint(legacyDemo, scope, "legacy-demo", true);
    store.putCheckpoint(legacyReal, scope, "legacy-real", true);
    store.putCheckpoint(stableReal, scope, "stable-real", true);

    expect(() => store.rekeyLegacySourceDatabaseId(legacySourceDbId, stableSourceDbId))
      .toThrow(SpatialSourceIdentityCollisionError);
    expect(partitionRowCount(store, "spatial_checkpoints", legacyDemo)).toBe(1);
    expect(partitionRowCount(store, "spatial_checkpoints", legacyReal)).toBe(1);
    expect(partitionRowCount(store, "spatial_checkpoints", stableDemo)).toBe(0);
    expect(partitionRowCount(store, "spatial_checkpoints", stableReal)).toBe(1);
    store.close();
  });

  it("uses the persisted core UUID across restart and a core database path move", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stugu-spatial-source-id-"));
    temporaryDirectories.push(directory);
    const originalCorePath = join(directory, "core.sqlite");
    const movedCorePath = join(directory, "moved-core.sqlite");
    const statePath = join(directory, "spatial.sqlite");
    let core: ClimateDatabase | null = null;
    let runtime: LocalSpatialLayerRuntime | null = null;
    try {
      core = new ClimateDatabase(originalCorePath, false);
      const stableSourceDbId = core.telemetryArchiveSourceId();
      const legacySourceDbId = sourceDatabaseId(originalCorePath);
      const legacy = new SpatialLayerStateStore(statePath);
      legacy.putConfiguration({ partition: { sourceDbId: legacySourceDbId, dataMode: "demo" }, scope, baseVersion: 0,
        config: { retained: "legacy" } });
      legacy.close();

      runtime = createLocalSpatialLayerRuntime({
        coreDatabase: core, coreDatabasePath: originalCorePath, dataMode: "demo", statePath,
      });
      expect(runtime.host.partition.sourceDbId).toBe(stableSourceDbId);
      expect(runtime.state.getCurrentConfiguration(runtime.host.partition, scope).config).toEqual({ retained: "legacy" });
      await runtime.stop();
      runtime = null;
      core.close();
      core = null;

      core = new ClimateDatabase(originalCorePath, false);
      runtime = createLocalSpatialLayerRuntime({
        coreDatabase: core, coreDatabasePath: originalCorePath, dataMode: "demo", statePath,
      });
      expect(runtime.host.partition.sourceDbId).toBe(stableSourceDbId);
      expect(runtime.state.getCurrentConfiguration(runtime.host.partition, scope).config).toEqual({ retained: "legacy" });
      await runtime.stop();
      runtime = null;
      core.close();
      core = null;

      renameSync(originalCorePath, movedCorePath);
      core = new ClimateDatabase(movedCorePath, false);
      expect(core.telemetryArchiveSourceId()).toBe(stableSourceDbId);
      runtime = createLocalSpatialLayerRuntime({
        coreDatabase: core, coreDatabasePath: movedCorePath, dataMode: "demo", statePath,
      });
      expect(runtime.host.partition.sourceDbId).toBe(stableSourceDbId);
      expect(runtime.state.getCurrentConfiguration(runtime.host.partition, scope).config).toEqual({ retained: "legacy" });
    } finally {
      await runtime?.stop();
      core?.close();
    }
  });
});
