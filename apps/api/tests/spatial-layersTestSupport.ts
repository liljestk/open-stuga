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

export const partition: SpatialDataPartition = { sourceDbId: "core-test", dataMode: "demo" };

export const scope = { kind: "house" as const, id: "house-test" };

export const temporaryDirectories: string[] = [];

export const runtimes: LocalSpatialLayerRuntime[] = [];

export const coreDatabases: ClimateDatabase[] = [];

export type TestSchema = {
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

export const spatialOpenApiSchemas = openApiV1Document.components.schemas as unknown as Record<string, TestSchema>;

export const spatialOpenApiPaths = openApiV1Document.paths as unknown as Record<string, Partial<Record<"get" | "post" | "put", {
  responses: Record<string, { content?: Record<string, { schema: TestSchema }> }>;
}>>>;

export function documentedResponseSchema(path: string, method: "get" | "post" | "put", status: number): TestSchema {
  const schema = spatialOpenApiPaths[path]?.[method]?.responses[String(status)]?.content?.["application/json"]?.schema;
  if (!schema) throw new Error(`Missing OpenAPI response schema for ${method.toUpperCase()} ${path} ${status}`);
  return schema;
}

export function resolvedSchema(schema: TestSchema): TestSchema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.match(/^#\/components\/schemas\/([^/]+)$/)?.[1];
  if (!name || !spatialOpenApiSchemas[name]) throw new Error(`Unresolved test schema ${schema.$ref}`);
  return resolvedSchema(spatialOpenApiSchemas[name]);
}

export function schemaConformanceErrors(value: unknown, inputSchema: TestSchema, path = "$"): string[] {
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

export function expectOpenApiConformance(value: unknown, schema: TestSchema): void {
  expect(schemaConformanceErrors(value, schema)).toEqual([]);
}

export function snapshot(inputDigest = "input-a", value = 20, generatedAt = "2026-07-16T12:00:00.000Z"): SpatialLayerSnapshotDraft {
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

export const SPATIAL_PARTITION_TABLES = [
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

export function seedEverySpatialTable(
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

export function partitionRowCount(store: SpatialLayerStateStore, table: string, value: SpatialDataPartition): number {
  const row = store.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE source_db_id = ? AND data_mode = ?`)
    .get(value.sourceDbId, value.dataMode) as { count: number };
  return Number(row.count);
}

export function seededRuntime(registry?: SpatialLayerEngineRegistry): { runtime: LocalSpatialLayerRuntime; core: ClimateDatabase } {
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

export function enableEngine(runtime: LocalSpatialLayerRuntime, value: typeof scope, engineId: string): void {
  const assignment = runtime.state.listAssignments(runtime.host.partition, value).find((candidate) => candidate.engineId === engineId);
  if (!assignment) throw new Error(`Missing assignment ${engineId}`);
  runtime.state.putAssignment(runtime.host.partition, { ...assignment, enabled: true });
}

export function engineSnapshot(
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
