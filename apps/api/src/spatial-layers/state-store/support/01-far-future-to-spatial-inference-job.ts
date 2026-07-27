import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  PersistedSpatialLayerSnapshot,
  SpatialConfigurationVersion,
  SpatialCalibrationSession,
  SpatialDataPartition,
  SpatialEngineAssignment,
  SpatialGroundTruth,
  SpatialInferenceRun,
  SpatialLayerSnapshotDraft,
  SpatialRunStatus,
  SpatialScope,
  StoredSpatialContextEvent,
  StoredSpatialSensorBinding,
  StoredSpatialSensorCalibration,
} from "../../types.js";

export const FAR_FUTURE = "9999-12-31T23:59:59.999Z";

export type SqlRow = Record<string, unknown>;

export class SpatialStateValidationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class NonDeterministicSpatialOutputError extends SpatialStateValidationError {
  constructor(layerId: string, bucketAt: string) {
    super(
      409,
      "NON_DETERMINISTIC_ENGINE_OUTPUT",
      `Engine returned different ${layerId} output for the same inputs at ${bucketAt}`,
    );
  }
}

export function deriveSpatialStatePath(coreDatabasePath: string): string {
  if (coreDatabasePath === ":memory:") return ":memory:";
  const absolute = resolve(coreDatabasePath);
  return resolve(dirname(absolute), `${basename(absolute)}.spatial-layers.sqlite`);
}

/** Legacy path-derived identity retained only to migrate pre-UUID spatial state. */
export function sourceDatabaseId(coreDatabasePath: string, memoryInstanceId = "default"): string {
  const material = coreDatabasePath === ":memory:"
    ? `memory:${memoryInstanceId}`
    : `file:${resolve(coreDatabasePath).toLowerCase()}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 24);
}

export class SpatialSourceIdentityCollisionError extends Error {
  readonly code = "SPATIAL_SOURCE_ID_COLLISION";

  constructor(
    readonly legacySourceDbId: string,
    readonly stableSourceDbId: string,
    readonly dataMode: SpatialDataPartition["dataMode"],
  ) {
    super(
      `Cannot migrate the legacy spatial ${dataMode} partition from ${legacySourceDbId} to ${stableSourceDbId}: `
      + "the stable-identity target already contains spatial state",
    );
  }
}

export function parseJson<T>(value: unknown): T {
  if (typeof value !== "string") throw new TypeError("Expected persisted JSON text");
  return JSON.parse(value) as T;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function assertIsoTimestamp(value: string, field: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new SpatialStateValidationError(400, "INVALID_TIMESTAMP", `${field} must be an ISO timestamp`);
  }
}

export function assertInterval(from: string, to: string | null, fromField: string, toField: string): void {
  assertIsoTimestamp(from, fromField);
  if (to !== null) {
    assertIsoTimestamp(to, toField);
    if (Date.parse(to) <= Date.parse(from)) {
      throw new SpatialStateValidationError(400, "INVALID_INTERVAL", `${toField} must be after ${fromField}`);
    }
  }
}

export function scopeParams(scope: SpatialScope): [string, string] {
  return [scope.kind, scope.id];
}

export function partitionParams(partition: SpatialDataPartition): [string, string] {
  return [partition.sourceDbId, partition.dataMode];
}

export function sqlIdentifier(value: string): string {
  if (!/^spatial_[a-z0-9_]+$/i.test(value)) throw new Error(`Unsafe spatial table name ${value}`);
  return `"${value.replaceAll('"', '""')}"`;
}

export function scopeFromRow(row: SqlRow): SpatialScope {
  const kind = String(row.scope_kind);
  if (kind !== "house" && kind !== "property") throw new Error(`Invalid spatial scope kind ${kind}`);
  return { kind, id: String(row.scope_id) };
}

export function partitionFromRow(row: SqlRow): SpatialDataPartition {
  const dataMode = String(row.data_mode);
  if (dataMode !== "demo" && dataMode !== "real") throw new Error(`Invalid spatial data mode ${dataMode}`);
  return { sourceDbId: String(row.source_db_id), dataMode };
}

/**
 * Early spatial databases used a SQL-safe underscore for co-location even
 * though the public contract has always used the hyphenated spelling. Keep
 * that storage encoding so existing databases remain readable without a
 * destructive table rebuild, but never let it escape through the API.
 */
export function calibrationMethodForStorage(method: StoredSpatialSensorCalibration["method"]): string {
  return method === "co-location" ? "co_location" : method;
}

export function calibrationMethodFromStorage(value: unknown): StoredSpatialSensorCalibration["method"] {
  const method = String(value);
  if (method === "co_location" || method === "co-location") return "co-location";
  if (method === "manual" || method === "factory" || method === "estimated") return method;
  throw new Error(`Invalid spatial calibration method ${method}`);
}

export function snapshotFromRow(row: SqlRow): PersistedSpatialLayerSnapshot {
  const payload = parseJson<Pick<PersistedSpatialLayerSnapshot,
    "coordinateFrames" | "reasonCodes" | "zones" | "connections" | "points" | "metadata">>(row.payload_json);
  return {
    id: String(row.id),
    partition: partitionFromRow(row),
    scope: scopeFromRow(row),
    layerId: String(row.layer_id),
    generatedAt: String(row.bucket_at),
    windowStart: String(row.window_start),
    windowEnd: String(row.window_end),
    status: row.status as PersistedSpatialLayerSnapshot["status"],
    model: parseJson<PersistedSpatialLayerSnapshot["model"]>(row.model_json),
    configVersion: String(row.config_version),
    inputDigest: String(row.input_digest),
    qualityScore: Number(row.quality_score),
    warnings: parseJson<string[]>(row.warnings_json),
    coordinateFrames: payload.coordinateFrames,
    reasonCodes: payload.reasonCodes,
    zones: payload.zones,
    connections: payload.connections,
    points: payload.points,
    ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
    revision: Number(row.revision),
    supersedesSnapshotId: row.supersedes_snapshot_id === null ? null : String(row.supersedes_snapshot_id),
    createdAt: String(row.created_at),
  };
}

export function runFromRow(row: SqlRow): SpatialInferenceRun {
  return {
    id: String(row.id),
    partition: partitionFromRow(row),
    scope: scopeFromRow(row),
    engineId: String(row.engine_id),
    engineVersion: String(row.engine_version),
    bucketAt: String(row.bucket_at),
    configVersion: Number(row.config_version),
    status: row.status as SpatialRunStatus,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    inputDigest: row.input_digest === null ? null : String(row.input_digest),
    snapshotIds: parseJson<string[]>(row.snapshot_ids_json),
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
  };
}

export interface SpatialInferenceJob {
  id: string;
  partition: SpatialDataPartition;
  scope: SpatialScope;
  bucketAt: string;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  reason: string;
  availableAt: string;
  attempts: number;
  lastError: string | null;
  lockToken: string | null;
  createdAt: string;
  updatedAt: string;
}
