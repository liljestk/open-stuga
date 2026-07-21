import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import {
  ClimateScalarEngine,
  SpatialLayerEngineRegistry,
  snapshotBase,
  type SpatialLayerEngine,
  type SpatialLayerEngineInput,
  type SpatialLayerEngineManifest,
  type SpatialLayerSnapshot,
} from "@climate-twin/spatial-layers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import { openApiV1Document } from "../src/openapi.js";
import { buildHouseTopology } from "../src/spatial-layers/core-input.js";
import {
  HybridTelemetryReader,
  type ArchiveTelemetryReader,
} from "../src/timeseries/read-facade.js";
import {
  createLocalSpatialLayerRuntime,
  DirectSpatialEngineExecutor,
  deriveSpatialStatePath,
  registerSpatialLayerRoutes,
  sourceDatabaseId,
  SpatialLayerStateStore,
  SpatialSourceIdentityCollisionError,
  SpatialExecutionTimeoutError,
  WorkerThreadSpatialEngineExecutor,
  type LocalSpatialLayerRuntime,
  type SpatialDataPartition,
  type SpatialLayerSnapshotDraft,
} from "../src/spatial-layers/index.js";

const partition: SpatialDataPartition = { sourceDbId: "core-test", dataMode: "demo" };
const scope = { kind: "house" as const, id: "house-test" };
const temporaryDirectories: string[] = [];
const runtimes: LocalSpatialLayerRuntime[] = [];
const coreDatabases: ClimateDatabase[] = [];

type TestSchema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  oneOf?: TestSchema[];
  required?: string[];
  properties?: Record<string, TestSchema>;
  items?: TestSchema;
  additionalProperties?: boolean | TestSchema;
};

const spatialOpenApiSchemas = openApiV1Document.components.schemas as unknown as Record<string, TestSchema>;
const spatialOpenApiPaths = openApiV1Document.paths as unknown as Record<string, Partial<Record<"get" | "post" | "put", {
  responses: Record<string, { content?: Record<string, { schema: TestSchema }> }>;
}>>>;

function documentedResponseSchema(path: string, method: "get" | "post" | "put", status: number): TestSchema {
  const schema = spatialOpenApiPaths[path]?.[method]?.responses[String(status)]?.content?.["application/json"]?.schema;
  if (!schema) throw new Error(`Missing OpenAPI response schema for ${method.toUpperCase()} ${path} ${status}`);
  return schema;
}

function resolvedSchema(schema: TestSchema): TestSchema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.match(/^#\/components\/schemas\/([^/]+)$/)?.[1];
  if (!name || !spatialOpenApiSchemas[name]) throw new Error(`Unresolved test schema ${schema.$ref}`);
  return resolvedSchema(spatialOpenApiSchemas[name]);
}

function schemaConformanceErrors(value: unknown, inputSchema: TestSchema, path = "$"): string[] {
  const schema = resolvedSchema(inputSchema);
  if (schema.oneOf) {
    return schema.oneOf.some((candidate) => schemaConformanceErrors(value, candidate, path).length === 0)
      ? []
      : [`${path} does not match any oneOf branch`];
  }
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) return [`${path} is outside the enum`];
  if (schema.const !== undefined && !Object.is(schema.const, value)) return [`${path} does not equal the const`];

  const actualType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const allowedTypes = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (allowedTypes.length > 0) {
    const matches = allowedTypes.some((type) => type === actualType || (type === "integer" && actualType === "number" && Number.isInteger(value)));
    if (!matches) return [`${path} is ${actualType}; expected ${allowedTypes.join(" or ")}`];
  }

  if (actualType === "array" && schema.items) {
    return (value as unknown[]).flatMap((item, index) => schemaConformanceErrors(item, schema.items!, `${path}[${index}]`));
  }
  if (actualType !== "object") return [];

  const object = value as Record<string, unknown>;
  const properties = schema.properties ?? {};
  const errors = (schema.required ?? [])
    .filter((key) => !Object.hasOwn(object, key))
    .map((key) => `${path}.${key} is required`);
  for (const [key, child] of Object.entries(object)) {
    const childSchema = properties[key];
    if (childSchema) errors.push(...schemaConformanceErrors(child, childSchema, `${path}.${key}`));
    else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not declared`);
    else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      errors.push(...schemaConformanceErrors(child, schema.additionalProperties, `${path}.${key}`));
    }
  }
  return errors;
}

function expectOpenApiConformance(value: unknown, schema: TestSchema): void {
  expect(schemaConformanceErrors(value, schema)).toEqual([]);
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  for (const database of coreDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function snapshot(inputDigest = "input-a", value = 20, generatedAt = "2026-07-16T12:00:00.000Z"): SpatialLayerSnapshotDraft {
  return {
    scope,
    coordinateFrames: [{ id: "frame", version: "1" }],
    layerId: "climate.temperature",
    model: { id: "test-engine", version: "1.0.0", maturity: "experimental" },
    generatedAt,
    windowStart: new Date(Date.parse(generatedAt) - 60 * 60_000).toISOString(),
    windowEnd: generatedAt,
    status: "ready",
    configVersion: "1",
    inputDigest,
    qualityScore: 1,
    warnings: [],
    reasonCodes: ["test"],
    zones: [{
      zoneId: "zone-a",
      frameId: "frame",
      metrics: { temperatureC: { value, unit: "degC", quality: 1 } },
      evidence: [],
      reasonCodes: [],
    }],
    connections: [],
    points: [],
  };
}

const SPATIAL_PARTITION_TABLES = [
  "spatial_config_versions",
  "spatial_sensor_bindings",
  "spatial_sensor_calibrations",
  "spatial_calibration_sessions",
  "spatial_context_events",
  "spatial_engine_assignments",
  "spatial_inference_runs",
  "spatial_layer_snapshots",
  "spatial_ground_truth",
  "spatial_inference_jobs",
  "spatial_checkpoints",
] as const;

function seedEverySpatialTable(
  store: SpatialLayerStateStore,
  value: SpatialDataPartition,
  suffix: string,
): void {
  const createdAt = "2026-07-16T12:00:00.000Z";
  store.putConfiguration({ partition: value, scope, baseVersion: 0, config: { suffix }, createdAt });
  store.putAssignment(value, {
    scope, engineId: `engine-${suffix}`, engineVersion: "1.0.0", enabled: true,
    layerIds: ["climate.temperature"], configVersion: 1, updatedAt: createdAt,
  });
  store.addBinding(value, {
    id: `binding-${suffix}`, houseId: scope.id, sensorId: `sensor-${suffix}`, zoneId: `zone-${suffix}`,
    frameId: `frame-${suffix}`, position: { x: 1, y: 2, z: 3 }, role: "primary",
    activeFrom: "2026-07-16T10:00:00.000Z", createdAt,
  });
  store.addCalibration(value, {
    id: `calibration-${suffix}`, houseId: scope.id, sensorId: `sensor-${suffix}`,
    validFrom: "2026-07-16T10:00:00.000Z", temperatureOffsetC: 0.1, humidityOffsetPct: -0.2,
    confidence: 0.9, method: "manual", createdAt,
  });
  store.addCalibrationSession(value, {
    id: `session-${suffix}`, houseId: scope.id, kind: "co-location", status: "completed",
    startAt: "2026-07-16T10:00:00.000Z", endAt: "2026-07-16T11:00:00.000Z",
    intervention: { suffix }, notes: null, createdAt, updatedAt: createdAt,
  });
  store.addContextEvent(value, {
    id: `context-${suffix}`, houseId: scope.id, kind: "door-open",
    startAt: "2026-07-16T11:00:00.000Z", source: "test", payload: { suffix }, createdAt,
  });
  store.startRun({
    id: `run-${suffix}`, partition: value, scope, engineId: `engine-${suffix}`, engineVersion: "1.0.0",
    bucketAt: createdAt, configVersion: 1, startedAt: createdAt,
  });
  store.persistSnapshot(value, snapshot(`snapshot-${suffix}`), createdAt);
  store.addGroundTruth(value, {
    id: `truth-${suffix}`, scope, startAt: createdAt, endAt: null, label: suffix,
    zoneId: null, fromZoneId: null, toZoneId: null, source: "controlled_test", note: null,
    createdAt, createdBy: "test",
  });
  store.scheduleJob({
    partition: value, scope, bucketAt: "2026-07-16T12:01:00.000Z", reason: suffix,
    availableAt: createdAt, now: createdAt,
  });
  store.putCheckpoint(value, scope, `checkpoint-${suffix}`, { retained: true }, createdAt);
}

function partitionRowCount(store: SpatialLayerStateStore, table: string, value: SpatialDataPartition): number {
  const row = store.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE source_db_id = ? AND data_mode = ?`)
    .get(value.sourceDbId, value.dataMode) as { count: number };
  return Number(row.count);
}

function seededRuntime(registry?: SpatialLayerEngineRegistry): { runtime: LocalSpatialLayerRuntime; core: ClimateDatabase } {
  const core = new ClimateDatabase(":memory:", true);
  const runtime = createLocalSpatialLayerRuntime({
    coreDatabase: core,
    coreDatabasePath: ":memory:",
    sourceDbId: `memory-${runtimes.length}`,
    dataMode: "demo",
    statePath: ":memory:",
    ...(registry ? { registry } : {}),
    ...(registry ? { executor: new DirectSpatialEngineExecutor(registry) } : {}),
  });
  coreDatabases.push(core);
  runtimes.push(runtime);
  return { runtime, core };
}

function enableEngine(runtime: LocalSpatialLayerRuntime, value: typeof scope, engineId: string): void {
  const assignment = runtime.state.listAssignments(runtime.host.partition, value).find((candidate) => candidate.engineId === engineId);
  if (!assignment) throw new Error(`Missing assignment ${engineId}`);
  runtime.state.putAssignment(runtime.host.partition, { ...assignment, enabled: true });
}

function engineSnapshot(
  input: SpatialLayerEngineInput,
  manifest: SpatialLayerEngineManifest,
  layerId: string,
): SpatialLayerSnapshot {
  return snapshotBase(input, {
    layerId,
    modelId: manifest.id,
    modelVersion: manifest.version,
    maturity: manifest.maturity,
    status: "ready",
    qualityScore: 1,
    reasonCodes: ["dependency-test"],
  });
}

describe("isolated spatial layer state", () => {
  it("stores deterministic idempotent snapshots and explicit late-data revisions", () => {
    const store = new SpatialLayerStateStore(":memory:");
    const first = store.persistSnapshot(partition, snapshot());
    const repeated = store.persistSnapshot(partition, snapshot());
    expect(repeated.id).toBe(first.id);
    expect(repeated.revision).toBe(1);

    const revised = store.persistSnapshot(partition, snapshot("input-b", 21));
    expect(revised.revision).toBe(2);
    expect(revised.supersedesSnapshotId).toBe(first.id);
    expect(store.snapshotHistory({
      partition, scope, from: "2026-07-16T11:00:00.000Z", to: "2026-07-16T13:00:00.000Z", includeSuperseded: true,
    })).toHaveLength(2);
    expect(() => store.persistSnapshot(partition, snapshot("input-b", 22))).toThrow(/different .* output/i);
    store.close();
  });

  it("uses a physically separate SQLite database and leaves core tables untouched", () => {
    const directory = mkdtempSync(join(tmpdir(), "stuga-spatial-"));
    temporaryDirectories.push(directory);
    const corePath = join(directory, "core.sqlite");
    const statePath = deriveSpatialStatePath(corePath);
    const core = new ClimateDatabase(corePath, false);
    const store = new SpatialLayerStateStore(statePath);
    expect(statePath).not.toBe(corePath);
    expect(core.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'spatial_%'").all()).toEqual([]);
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'measurement_samples'").all()).toEqual([]);
    store.putConfiguration({ partition, scope, baseVersion: 0, config: { enabled: true } });
    store.addGroundTruth(partition, {
      id: "restart-truth", scope, startAt: "2026-07-18T10:00:00.000Z", endAt: null,
      label: "occupied", zoneId: "zone-a", fromZoneId: null, toZoneId: null,
      source: "user", note: "Must survive restart", createdAt: "2026-07-18T10:00:00.000Z", createdBy: "owner",
    });
    expect(core.db.prepare("SELECT name FROM sqlite_master WHERE name = 'spatial_config_versions'").get()).toBeUndefined();
    store.close();
    const reopened = new SpatialLayerStateStore(statePath);
    expect(reopened.getCurrentConfiguration(partition, scope)).toMatchObject({
      version: 1,
      config: { enabled: true },
    });
    expect(reopened.listGroundTruth(partition, scope)).toEqual([
      expect.objectContaining({ id: "restart-truth", note: "Must survive restart" }),
    ]);
    expect(reopened.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(reopened.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    reopened.close();
    core.close();
  });

  it("purges derived operational history while retaining configuration and ground truth", () => {
    const store = new SpatialLayerStateStore(":memory:");
    store.putConfiguration({ partition, scope, baseVersion: 0, config: { retained: true }, createdAt: "2026-01-01T00:00:00.000Z" });
    store.addGroundTruth(partition, {
      id: "truth", scope, startAt: "2026-01-01T00:00:00.000Z", endAt: null, label: "house_empty",
      zoneId: null, fromZoneId: null, toZoneId: null, source: "user", note: null,
      createdAt: "2026-01-01T00:00:00.000Z", createdBy: null,
    });
    store.persistSnapshot(partition, snapshot("old", 20, "2026-01-02T00:00:00.000Z"), "2026-01-02T00:00:01.000Z");
    const purged = store.purgeOperationalHistoryBefore(partition, "2026-02-01T00:00:00.000Z");
    expect(purged.snapshots).toBe(1);
    expect(store.getCurrentConfiguration(partition, scope).config).toEqual({ retained: true });
    expect(store.listGroundTruth(partition, scope)).toHaveLength(1);
    store.close();
  });
});

describe("failure-isolated engine host", () => {
  it("derives physical room volume from level calibration without map placement", () => {
    const core = new ClimateDatabase(":memory:", true);
    coreDatabases.push(core);
    const stored = core.listHouses()[0]!;
    const { mapPlacement: _mapPlacement, ...withoutMapPlacement } = stored;
    const floor = { ...stored.floors[0]!, metersPerPlanUnit: .01 };
    const house = { ...withoutMapPlacement, floors: [floor, ...stored.floors.slice(1)] };
    const built = buildHouseTopology({ house, sensors: core.listSensors(house.id), bindings: [], at: new Date().toISOString() });
    const room = floor.rooms[0]!;
    const areaPlanUnits = Math.abs(room.points.reduce((sum, point, index) => {
      const next = room.points[(index + 1) % room.points.length]!;
      return sum + point.x * next.y - next.x * point.y;
    }, 0)) / 2;
    const zone = built.topology.zones.find((candidate) => candidate.roomId === room.id)!;

    expect(zone.volumeM3).toBeCloseTo(areaPlanUnits * .01 ** 2 * (floor.ceilingHeight ?? 2.4), 8);
  });

  it("shares archive and SQLite telemetry with inference while topology descriptions stay telemetry-free", async () => {
    const core = new ClimateDatabase(":memory:", true);
    const house = core.listHouses()[0]!;
    const sensor = core.listSensors(house.id)[0]!;
    const oldAt = "2035-01-01T10:00:00.000Z";
    const overlapAt = "2035-01-01T10:30:00.000Z";
    const bucketAt = "2035-01-01T11:00:00.000Z";
    core.insertMeasurementSamples([
      { sensorId: sensor.id, metric: "temperature", value: 24, canonicalUnit: "°C", timestamp: overlapAt, source: "api", quality: "good" },
      { sensorId: sensor.id, metric: "humidity", value: 48, canonicalUnit: "%", timestamp: overlapAt, source: "api", quality: "good" },
    ]);
    const archiveWindow = vi.fn(async () => [
      { sensorId: sensor.id, metric: "temperature", value: 19, canonicalUnit: "°C", timestamp: oldAt, source: "api", quality: "good" },
      { sensorId: sensor.id, metric: "humidity", value: 42, canonicalUnit: "%", timestamp: oldAt, source: "api", quality: "good" },
      { sensorId: sensor.id, metric: "temperature", value: -99, canonicalUnit: "°C", timestamp: overlapAt, source: "api", quality: "good" },
    ]);
    const archive: ArchiveTelemetryReader = {
      measurementHistory: vi.fn(async () => []),
      measurementWindow: archiveWindow,
      legacyReadingHistory: vi.fn(async () => []),
      outdoorTemperatureHistory: vi.fn(async () => []),
    };
    const telemetryReader = new HybridTelemetryReader({ local: core, archive, archivePhase: () => "ready" });
    const runtime = createLocalSpatialLayerRuntime({
      coreDatabase: core,
      telemetryReader,
      coreDatabasePath: ":memory:",
      sourceDbId: "shared-reader-test",
      dataMode: "demo",
      statePath: ":memory:",
    });
    coreDatabases.push(core);
    runtimes.push(runtime);

    const houseScope = { kind: "house" as const, id: house.id };
    await runtime.host.describeScope(houseScope, bucketAt);
    expect(archiveWindow).not.toHaveBeenCalled();

    const configuration = runtime.state.getCurrentConfiguration(runtime.host.partition, houseScope);
    const dataset = await runtime.input.load({
      partition: runtime.host.partition,
      scope: houseScope,
      bucketAt,
      windowMinutes: 90,
      requiredMetrics: ["temperatureC", "relativeHumidityPct"],
      configuration,
      bindings: [],
      calibrations: [],
      contextEvents: [],
    });

    expect(archiveWindow).toHaveBeenCalledOnce();
    expect(dataset.sparseSamples).toEqual(expect.arrayContaining([
      expect.objectContaining({ sensorId: sensor.id, metric: "temperature", timestamp: oldAt, value: 19 }),
      expect.objectContaining({ sensorId: sensor.id, metric: "humidity", timestamp: oldAt, value: 42 }),
      expect.objectContaining({ sensorId: sensor.id, metric: "temperature", timestamp: overlapAt, value: 24 }),
      expect.objectContaining({ sensorId: sensor.id, metric: "humidity", timestamp: overlapAt, value: 48 }),
    ]));
    expect(dataset.sparseSamples).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ timestamp: overlapAt, value: -99 }),
    ]));
    expect(dataset.engineInput.samples).toEqual(expect.arrayContaining([
      expect.objectContaining({ sensorId: sensor.id, observedAt: oldAt, temperatureC: 19, relativeHumidityPct: 42 }),
      expect.objectContaining({ sensorId: sensor.id, observedAt: overlapAt, temperatureC: 24, relativeHumidityPct: 48 }),
    ]));
  });

  it("loads every opening transition in the inference window while excluding future replay state", async () => {
    const core = new ClimateDatabase(":memory:", true);
    const stored = core.listHouses()[0]!;
    const floors = structuredClone(stored.floors);
    floors[0]!.planElements = [...(floors[0]!.planElements ?? []), {
      id: "history-vent",
      kind: "vent",
      position: { x: 4, y: 5 },
      rotationDegrees: 0,
      width: .3,
      state: "closed",
    }];
    const house = core.updateHouse(stored.id, { floors })!;
    const record = (id: string, state: "open" | "closed", observedAt: string): void => {
      core.recordOpeningStateObservation(house.id, {
        id,
        floorId: floors[0]!.id,
        elementId: "history-vent",
        state,
        source: "manual",
        observedAt,
      });
    };
    record("history-closed-1", "closed", "2035-01-01T11:35:00.000Z");
    record("history-open", "open", "2035-01-01T11:40:00.000Z");
    record("history-closed-2", "closed", "2035-01-01T11:50:00.000Z");
    record("future-open", "open", "2035-01-01T12:05:00.000Z");

    const runtime = createLocalSpatialLayerRuntime({
      coreDatabase: core,
      coreDatabasePath: ":memory:",
      sourceDbId: "opening-history-test",
      dataMode: "demo",
      statePath: ":memory:",
    });
    coreDatabases.push(core);
    runtimes.push(runtime);
    const scope = { kind: "house" as const, id: house.id };
    const configuration = runtime.state.getCurrentConfiguration(runtime.host.partition, scope);
    const dataset = await runtime.input.load({
      partition: runtime.host.partition,
      scope,
      bucketAt: "2035-01-01T12:00:00.000Z",
      windowMinutes: 30,
      requiredMetrics: ["temperatureC", "relativeHumidityPct"],
      configuration,
      bindings: [],
      calibrations: [],
      contextEvents: [],
    });
    const connectionId = `house:${house.id}:vent:${floors[0]!.id}/history-vent`;

    expect(dataset.engineInput.connectionStateIntervals?.filter((interval) => interval.connectionId === connectionId)).toEqual([
      { connectionId, startAt: "2035-01-01T11:30:00.000Z", endAt: "2035-01-01T11:40:00.000Z", enabled: false, openFraction: 0 },
      { connectionId, startAt: "2035-01-01T11:40:00.000Z", endAt: "2035-01-01T11:50:00.000Z", enabled: true, openFraction: 1 },
      { connectionId, startAt: "2035-01-01T11:50:00.000Z", endAt: "2035-01-01T12:00:00.000Z", enabled: false, openFraction: 0 },
    ]);
    expect(dataset.topology.connections.find((connection) => connection.id === connectionId)?.enabled).toBe(false);
  });

  it("hard-terminates blocking research code without blocking the API event loop", async () => {
    const executor = new WorkerThreadSpatialEngineExecutor({
      workerSource: `const { parentPort } = require("node:worker_threads"); parentPort.once("message", () => { while (true) {} });`,
    });
    let eventLoopResponsive = false;
    setTimeout(() => { eventLoopResponsive = true; }, 10);
    const input = {
      scope, topology: { scope, frames: [], zones: [], connections: [], sensorBindings: [] }, samples: [],
      generatedAt: "2026-07-16T12:00:00.000Z", windowStart: "2026-07-16T11:00:00.000Z",
      windowEnd: "2026-07-16T12:00:00.000Z", configVersion: "1",
    } satisfies SpatialLayerEngineInput;
    await expect(executor.execute({ engineId: "blocking", input, timeoutMs: 75, signal: new AbortController().signal }))
      .rejects.toBeInstanceOf(SpatialExecutionTimeoutError);
    expect(eventLoopResponsive).toBe(true);
    executor.close();
  });

  it("does not read or mutate core data when every assigned engine is disabled", async () => {
    let calls = 0;
    const disabled: SpatialLayerEngine = {
      manifest: {
        id: "disabled-research", version: "1.0.0", maturity: "research", title: "Disabled", description: "Disabled",
        supportedScopes: ["house"], requiredMetrics: ["temperatureC", "relativeHumidityPct"], producedLayerIds: ["test.disabled"],
      },
      infer(): SpatialLayerSnapshot[] { calls += 1; return []; },
    };
    const registry = new SpatialLayerEngineRegistry().register(disabled);
    const { runtime, core } = seededRuntime(registry);
    const house = core.listHouses()[0]!;
    const report = await runtime.host.inferScope({ kind: "house", id: house.id }, new Date().toISOString());
    expect(report.status).toBe("disabled");
    expect(calls).toBe(0);
    expect(runtime.state.latestRun(runtime.host.partition, { kind: "house", id: house.id })).toBeNull();
  });

  it("runs disabled computational prerequisites first and passes immutable versioned outputs to the dependent", async () => {
    const order: string[] = [];
    let observedDependencyDigest: string | undefined;
    const prerequisiteManifest: SpatialLayerEngineManifest = {
      id: "test-prerequisite", version: "2.1.0", maturity: "experimental", title: "Prerequisite", description: "Test",
      supportedScopes: ["house"], requiredMetrics: ["temperatureC", "relativeHumidityPct"], producedLayerIds: ["test.prerequisite"],
    };
    const dependentManifest: SpatialLayerEngineManifest = {
      id: "test-dependent", version: "3.2.0", maturity: "research", title: "Dependent", description: "Test",
      supportedScopes: ["house"], requiredMetrics: ["temperatureC", "relativeHumidityPct"], producedLayerIds: ["test.dependent"],
      dependencies: [prerequisiteManifest.id],
    };
    const prerequisite: SpatialLayerEngine = {
      manifest: prerequisiteManifest,
      infer(input) {
        order.push(prerequisiteManifest.id);
        return [engineSnapshot(input, prerequisiteManifest, prerequisiteManifest.producedLayerIds[0]!)];
      },
    };
    const dependent: SpatialLayerEngine = {
      manifest: dependentManifest,
      infer(input) {
        order.push(dependentManifest.id);
        const dependency = input.dependencySnapshots?.[0];
        expect(Object.isFrozen(input.dependencySnapshots)).toBe(true);
        expect(Object.isFrozen(dependency)).toBe(true);
        expect(dependency?.model).toMatchObject({ id: prerequisiteManifest.id, version: prerequisiteManifest.version });
        observedDependencyDigest = dependency?.inputDigest;
        const output = engineSnapshot(input, dependentManifest, dependentManifest.producedLayerIds[0]!);
        output.metadata = { prerequisiteInputDigest: dependency?.inputDigest ?? null };
        return [output];
      },
    };
    const registry = new SpatialLayerEngineRegistry().register(dependent).register(prerequisite);
    const { runtime, core } = seededRuntime(registry);
    const houseScope = { kind: "house" as const, id: core.listHouses()[0]!.id };
    enableEngine(runtime, houseScope, dependentManifest.id);

    const report = await runtime.host.inferScope(houseScope, new Date().toISOString());
    expect(report.status).toBe("succeeded");
    expect(order).toEqual([prerequisiteManifest.id, dependentManifest.id]);
    expect(observedDependencyDigest).toMatch(/^sha256-/);
    expect(report.snapshots.map((item) => item.model.id)).toEqual([dependentManifest.id]);
    expect(report.snapshots[0]?.metadata?.["prerequisiteInputDigest"]).toBe(observedDependencyDigest);
    expect(runtime.state.latestRun(runtime.host.partition, houseScope, prerequisiteManifest.id)?.status).toBe("succeeded");
    expect(runtime.state.currentSnapshots(runtime.host.partition, houseScope).map((item) => item.model.id))
      .toEqual([dependentManifest.id]);
  });

  it("never executes or persists a dependent after its prerequisite fails", async () => {
    let dependentRuns = 0;
    const failingManifest: SpatialLayerEngineManifest = {
      id: "test-failing-prerequisite", version: "1.0.0", maturity: "research", title: "Failing", description: "Test",
      supportedScopes: ["house"], requiredMetrics: [], producedLayerIds: ["test.failing-prerequisite"],
    };
    const dependentManifest: SpatialLayerEngineManifest = {
      id: "test-blocked-dependent", version: "1.0.0", maturity: "research", title: "Blocked", description: "Test",
      supportedScopes: ["house"], requiredMetrics: [], producedLayerIds: ["test.blocked-dependent"],
      dependencies: [failingManifest.id],
    };
    const failing: SpatialLayerEngine = { manifest: failingManifest, infer() { throw new Error("deliberate prerequisite failure"); } };
    const dependent: SpatialLayerEngine = {
      manifest: dependentManifest,
      infer(input) {
        dependentRuns += 1;
        return [engineSnapshot(input, dependentManifest, dependentManifest.producedLayerIds[0]!)];
      },
    };
    const { runtime, core } = seededRuntime(new SpatialLayerEngineRegistry().register(dependent).register(failing));
    const houseScope = { kind: "house" as const, id: core.listHouses()[0]!.id };
    enableEngine(runtime, houseScope, dependentManifest.id);

    const report = await runtime.host.inferScope(houseScope, new Date().toISOString());
    expect(report.status).toBe("failed");
    expect(report.failures).toEqual([
      expect.objectContaining({ engineId: failingManifest.id, code: "ENGINE_FAILURE" }),
      expect.objectContaining({ engineId: dependentManifest.id, code: "DEPENDENCY_FAILED" }),
    ]);
    expect(dependentRuns).toBe(0);
    expect(report.snapshots).toEqual([]);
    expect(runtime.state.latestRun(runtime.host.partition, houseScope, dependentManifest.id)?.status).toBe("skipped");
    expect(runtime.state.currentSnapshots(runtime.host.partition, houseScope)).toEqual([]);
  });

  it("suppresses an enabled dependent whose declared prerequisite is missing", async () => {
    let dependentRuns = 0;
    const dependent: SpatialLayerEngine = {
      manifest: {
        id: "test-missing-dependent", version: "1.0.0", maturity: "research", title: "Missing", description: "Test",
        supportedScopes: ["house"], requiredMetrics: [], producedLayerIds: ["test.missing-dependent"],
        dependencies: ["not-registered"],
      },
      infer() { dependentRuns += 1; return []; },
    };
    const { runtime, core } = seededRuntime(new SpatialLayerEngineRegistry().register(dependent));
    const houseScope = { kind: "house" as const, id: core.listHouses()[0]!.id };
    enableEngine(runtime, houseScope, dependent.manifest.id);

    const report = await runtime.host.inferScope(houseScope, new Date().toISOString());
    expect(report.status).toBe("failed");
    expect(report.failures).toEqual([
      expect.objectContaining({ engineId: dependent.manifest.id, code: "DEPENDENCY_CONFIGURATION_ERROR" }),
    ]);
    expect(dependentRuns).toBe(0);
    expect(report.snapshots).toEqual([]);
  });

  it("contains a failing engine, persists healthy layers, and never writes core telemetry", async () => {
    const failing: SpatialLayerEngine = {
      manifest: {
        id: "failing-engine", version: "1.0.0", maturity: "experimental", title: "Failing", description: "Test failure",
        supportedScopes: ["house"], requiredMetrics: ["temperatureC", "relativeHumidityPct"], producedLayerIds: ["test.failure"],
      },
      infer(): SpatialLayerSnapshot[] { throw new Error("deliberate failure"); },
    };
    const registry = new SpatialLayerEngineRegistry().register(new ClimateScalarEngine()).register(failing);
    const { runtime, core } = seededRuntime(registry);
    const house = core.listHouses()[0]!;
    const houseScope = { kind: "house" as const, id: house.id };
    enableEngine(runtime, houseScope, "failing-engine");
    const before = Number((core.db.prepare("SELECT COUNT(*) AS count FROM measurement_samples").get() as { count: number }).count);
    const report = await runtime.host.inferScope(houseScope, new Date().toISOString());
    const after = Number((core.db.prepare("SELECT COUNT(*) AS count FROM measurement_samples").get() as { count: number }).count);
    expect(report.status).toBe("partial");
    expect(report.failures).toEqual([expect.objectContaining({ engineId: "failing-engine", code: "ENGINE_FAILURE" })]);
    expect(report.snapshots.length).toBeGreaterThan(0);
    expect(after).toBe(before);
  });

  it("discards in-flight demo results when the core activates real mode", async () => {
    let release: ((snapshots: SpatialLayerSnapshot[]) => void) | undefined;
    let started: (() => void) | undefined;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const deferred: SpatialLayerEngine = {
      manifest: {
        id: "deferred", version: "1.0.0", maturity: "experimental", title: "Deferred", description: "Race test",
        supportedScopes: ["house"], requiredMetrics: ["temperatureC", "relativeHumidityPct"], producedLayerIds: ["test.deferred"],
      },
      infer(input: SpatialLayerEngineInput): Promise<SpatialLayerSnapshot[]> {
        started?.();
        return new Promise((resolve) => {
          release = () => resolve([{
            scope: input.scope, coordinateFrames: input.topology.frames.map((frame) => ({ id: frame.id, version: frame.version })),
            layerId: "test.deferred", model: { id: "deferred", version: "1.0.0", maturity: "experimental" },
            generatedAt: input.generatedAt, windowStart: input.windowStart, windowEnd: input.windowEnd, status: "ready",
            configVersion: input.configVersion, inputDigest: "demo-input", qualityScore: 1, warnings: [], reasonCodes: [],
            zones: [], connections: [], points: [],
          }]);
        });
      },
    };
    const { runtime, core } = seededRuntime(new SpatialLayerEngineRegistry().register(deferred));
    const houseScope = { kind: "house" as const, id: core.listHouses()[0]!.id };
    enableEngine(runtime, houseScope, "deferred");
    const demoPartition = runtime.host.partition;
    const pending = runtime.host.inferScope(houseScope, new Date().toISOString());
    await began;
    runtime.handleDataModeActivated("real");
    const report = await pending;
    release?.([]);
    expect(report.failures).toEqual([expect.objectContaining({ code: "DATA_MODE_CHANGED" })]);
    expect(runtime.state.currentSnapshots(demoPartition, houseScope)).toEqual([]);
    expect(runtime.state.currentSnapshots(runtime.host.partition, houseScope)).toEqual([]);
    expect(runtime.state.latestRun(demoPartition, houseScope, "deferred")?.status).toBe("skipped");
  });
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
    registerSpatialLayerRoutes(app, { runtime });

    const houseConfig = await request(app).get(`/api/v1/houses/${house.id}/layers/config`).expect(200);
    expect(houseConfig.body.topology.scope).toEqual({ kind: "house", id: house.id });
    expect(houseConfig.body.topology.zones.length).toBeGreaterThan(0);
    expect(houseConfig.body.assignments).toEqual(expect.arrayContaining([expect.objectContaining({ engineId: "climate-scalars", enabled: true })]));
    expectOpenApiConformance(houseConfig.body, documentedResponseSchema("/houses/{id}/layers/config", "get", 200));

    const houseCurrent = await request(app).get(`/api/v1/houses/${house.id}/layers/current`).expect(200);
    expect(houseCurrent.body.topology.zones).toHaveLength(houseConfig.body.topology.zones.length);
    expect(houseCurrent.body.layers.length).toBeGreaterThan(0);
    expectOpenApiConformance(houseCurrent.body, spatialOpenApiSchemas.SpatialLayerCurrent!);

    const propertyCurrent = await request(app).get(`/api/v1/properties/${property.id}/layers/current`).expect(200);
    expect(propertyCurrent.body.topology.scope).toEqual({ kind: "property", id: property.id });
    const propertyFrame = propertyCurrent.body.topology.frames[0];
    expect(propertyFrame.kind).toBe("property-local-3d");
    if (propertyFrame.unit === "m") expect(propertyFrame.origin).toEqual({ x: 0, y: 0, z: 0 });
    else expect(propertyFrame).toMatchObject({ unit: "normalized" });
    expect(propertyCurrent.body.topology.zones).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "building" })]));
    expect(propertyCurrent.body.layers.length).toBeGreaterThan(0);
    expectOpenApiConformance(propertyCurrent.body, spatialOpenApiSchemas.SpatialLayerCurrent!);

    const houseHealth = await request(app).get(`/api/v1/houses/${house.id}/layers/health`).expect(200);
    expectOpenApiConformance(houseHealth.body, documentedResponseSchema("/houses/{id}/layers/health", "get", 200));

    const houseHistory = await request(app).get(`/api/v1/houses/${house.id}/layers/history`).query({
      from: new Date(Date.parse(at) - 60_000).toISOString(),
      to: new Date(Date.parse(at) + 60_000).toISOString(),
    }).expect(200);
    expectOpenApiConformance(houseHistory.body, documentedResponseSchema("/houses/{id}/layers/history", "get", 200));
  });

  it("returns inference reports that conform to the documented flattened snapshot schema", async () => {
    const { runtime, core } = seededRuntime();
    const house = core.listHouses()[0]!;
    const app = express();
    app.use(express.json());
    registerSpatialLayerRoutes(app, { runtime });

    const inferred = await request(app)
      .post(`/api/v1/houses/${house.id}/layers/infer`)
      .send({ bucketAt: new Date().toISOString() })
      .expect(200);

    expect(inferred.body.snapshots.length).toBeGreaterThan(0);
    expect(inferred.body.snapshots[0]).not.toHaveProperty("payload");
    expectOpenApiConformance(inferred.body, spatialOpenApiSchemas.SpatialLayerInferenceResult!);
  });

  it("returns documented payloads for spatial binding, session, and context writes", async () => {
    const { runtime, core } = seededRuntime();
    const house = core.listHouses()[0]!;
    const sensor = core.listSensors(house.id)[0]!;
    const app = express();
    app.use(express.json());
    registerSpatialLayerRoutes(app, { runtime });
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
    registerSpatialLayerRoutes(app, { runtime });
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
    registerSpatialLayerRoutes(app, { runtime });

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
    registerSpatialLayerRoutes(app, { runtime });
    const overview = await runtime.host.describeScope({ kind: "house", id: house.id });
    const zone = overview.topology.zones[0]!;
    const frame = overview.topology.frames.find((candidate) => candidate.id === zone.frameId)!;

    const cases: Array<{ path: string; method: "post" | "put"; body: Record<string, unknown> }> = [
      {
        method: "put", path: `/api/v1/houses/${house.id}/layers/config`,
        body: { baseVersion: 0, config: {}, undocumented: true },
      },
      {
        method: "post", path: `/api/v1/houses/${house.id}/layers/infer`,
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
    registerSpatialLayerRoutes(app, { runtime });
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
    registerSpatialLayerRoutes(app, { runtime: null });
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
    const directory = mkdtempSync(join(tmpdir(), "stuga-spatial-source-id-"));
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
