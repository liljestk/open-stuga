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

import { SPATIAL_PARTITION_TABLES, TestSchema, coreDatabases, documentedResponseSchema, enableEngine, engineSnapshot, expectOpenApiConformance, partition, partitionRowCount, resolvedSchema, runtimes, schemaConformanceErrors, scope, seedEverySpatialTable, seededRuntime, snapshot, spatialOpenApiPaths, spatialOpenApiSchemas, temporaryDirectories } from "./spatial-layersTestSupport.js";

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  for (const database of coreDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

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
    const directory = mkdtempSync(join(tmpdir(), "stugu-spatial-"));
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
    const archiveOpeningSnapshot = vi.fn(async () => []);
    const archiveOpeningHistory = vi.fn(async () => []);
    const archive: ArchiveTelemetryReader = {
      measurementHistory: vi.fn(async () => []),
      measurementWindow: archiveWindow,
      legacyReadingHistory: vi.fn(async () => []),
      outdoorTemperatureHistory: vi.fn(async () => []),
      openingStateSnapshot: archiveOpeningSnapshot,
      openingStateHistory: archiveOpeningHistory,
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
    const currentProjection = vi.spyOn(core, "listCurrentOpeningStateCandidates");
    await runtime.host.describeScope(houseScope);
    expect(archiveWindow).not.toHaveBeenCalled();
    expect(archiveOpeningSnapshot).not.toHaveBeenCalled();
    expect(archiveOpeningHistory).not.toHaveBeenCalled();
    expect(currentProjection).toHaveBeenCalledOnce();

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
    expect(archiveOpeningSnapshot).toHaveBeenCalledTimes(2);
    expect(archiveOpeningHistory).toHaveBeenCalledOnce();
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

  it("threads cancellation through current topology descriptions", async () => {
    const { runtime, core } = seededRuntime();
    const house = core.listHouses()[0]!;
    const controller = new AbortController();
    const describe = vi.spyOn(runtime.input, "describe");

    await runtime.host.describeScope({ kind: "house", id: house.id }, undefined, controller.signal);
    expect(describe).toHaveBeenCalledWith(expect.objectContaining({
      currentProjection: true,
      signal: controller.signal,
    }));

    controller.abort(new DOMException("Client disconnected", "AbortError"));

    await expect(runtime.host.describeScope(
      { kind: "house", id: house.id },
      undefined,
      controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
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

  it("aborts archive input reads as soon as a spatial session is stopped", async () => {
    const core = new ClimateDatabase(":memory:", true);
    coreDatabases.push(core);
    const house = core.listHouses()[0]!;
    let signalSeen: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const telemetryReader = {
      measurementWindow: vi.fn((query: { signal?: AbortSignal }) => {
        signalSeen = query.signal;
        markStarted();
        return new Promise((_resolve, reject) => {
          query.signal?.addEventListener("abort", () => reject(query.signal?.reason), { once: true });
        });
      }),
      outdoorTemperatureHistory: vi.fn(async () => ({
        records: [],
        provenance: { source: "sqlite", archiveState: "not-configured", complete: true },
      })),
    } as unknown as HybridTelemetryReader;
    const runtime = createLocalSpatialLayerRuntime({
      coreDatabase: core,
      telemetryReader,
      coreDatabasePath: ":memory:",
      sourceDbId: "cancel-input-test",
      dataMode: "demo",
      statePath: ":memory:",
    });
    runtimes.push(runtime);
    const houseScope = { kind: "house" as const, id: house.id };
    const inference = runtime.host.inferScope(houseScope, "2035-01-01T12:00:00.000Z");
    await started;
    runtime.host.cancelScope(houseScope);
    const report = await inference;
    expect(signalSeen?.aborted).toBe(true);
    expect(report.failures).toEqual([expect.objectContaining({ code: "ENGINE_ABORTED" })]);
    expect(runtime.state.latestRun(runtime.host.partition, houseScope)?.status).toBe("skipped");
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
