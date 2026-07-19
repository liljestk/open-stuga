import type { House, MeasurementSample, OutdoorTemperatureSample, Property, PropertyArea, Sensor } from "@climate-twin/contracts";
import type {
  SpatialContextEvent,
  SpatialLayerEngine,
  SpatialLayerEngineInput,
  SpatialLayerEngineManifest,
  SpatialLayerSnapshot,
  SpatialScopeRef,
  SpatialSensorBinding,
  SpatialSensorCalibration,
  SpatialTopology,
} from "@climate-twin/spatial-layers";

export type SpatialScope = SpatialScopeRef;
export type SpatialEngineManifest = SpatialLayerEngineManifest;
export type SpatialLayerEnginePort = SpatialLayerEngine;
export type SpatialLayerSnapshotDraft = SpatialLayerSnapshot;

/**
 * The core database has a one-way demo/real boundary. Spatial state still
 * carries an explicit partition so replacement databases cannot reuse learned
 * state from another source database.
 */
export interface SpatialDataPartition {
  dataMode: "real" | "demo";
  /** Stable deployment-specific identity, never a path containing user data. */
  sourceDbId: string;
}

export interface StoredSpatialSensorBinding extends SpatialSensorBinding {
  id: string;
  houseId: string;
  createdAt: string;
}

export interface StoredSpatialSensorCalibration extends SpatialSensorCalibration {
  id: string;
  houseId: string;
  createdAt: string;
}

export interface SpatialCalibrationSession {
  id: string;
  houseId: string;
  kind: "co-location" | "controlled-propagation" | "empty-house-baseline";
  status: "planned" | "running" | "completed" | "cancelled";
  startAt: string;
  endAt: string | null;
  intervention: Record<string, unknown>;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredSpatialContextEvent extends SpatialContextEvent {
  houseId: string;
  source: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface SpatialGroundTruth {
  id: string;
  scope: SpatialScope;
  startAt: string;
  endAt: string | null;
  label: string;
  zoneId: string | null;
  fromZoneId: string | null;
  toZoneId: string | null;
  source: "user" | "optional_sensor" | "controlled_test";
  note: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface SpatialConfigurationVersion {
  scope: SpatialScope;
  version: number;
  config: Record<string, unknown>;
  createdAt: string;
  createdBy: string | null;
}

export interface SpatialEngineAssignment {
  scope: SpatialScope;
  engineId: string;
  engineVersion: string;
  enabled: boolean;
  layerIds: string[];
  configVersion: number;
  updatedAt: string;
}

export interface PersistedSpatialLayerSnapshot extends SpatialLayerSnapshot {
  id: string;
  partition: SpatialDataPartition;
  revision: number;
  supersedesSnapshotId: string | null;
  createdAt: string;
}

export interface SpatialEngineRegistryPort {
  list(): SpatialEngineManifest[];
  resolve(id: string): SpatialLayerEnginePort;
}

export interface SpatialCoreDataset {
  engineInput: SpatialLayerEngineInput;
  house: House | null;
  property: Property | null;
  houses: House[];
  propertyAreas: PropertyArea[];
  sensors: Sensor[];
  sparseSamples: MeasurementSample[];
  outdoorTemperature: OutdoorTemperatureSample[];
  topology: SpatialTopology;
  warnings: string[];
}

export interface SpatialCoreDescription {
  topology: SpatialTopology;
  warnings: string[];
}

/** Deliberately read-only: the research engine cannot mutate core state. */
export interface SpatialCoreInputPort {
  listScopes(): SpatialScope[];
  scopeExists(scope: SpatialScope): boolean;
  housesForScope(scope: SpatialScope): House[];
  describe(request: {
    partition: SpatialDataPartition;
    scope: SpatialScope;
    bucketAt: string;
    configuration: SpatialConfigurationVersion;
    bindings: StoredSpatialSensorBinding[];
  }): Promise<SpatialCoreDescription>;
  load(request: {
    partition: SpatialDataPartition;
    scope: SpatialScope;
    bucketAt: string;
    windowMinutes: number;
    requiredMetrics: string[];
    configuration: SpatialConfigurationVersion;
    bindings: StoredSpatialSensorBinding[];
    calibrations: StoredSpatialSensorCalibration[];
    contextEvents: StoredSpatialContextEvent[];
  }): Promise<SpatialCoreDataset>;
}

export type SpatialRunStatus = "running" | "succeeded" | "failed" | "timed_out" | "skipped";

export interface SpatialInferenceRun {
  id: string;
  partition: SpatialDataPartition;
  scope: SpatialScope;
  engineId: string;
  engineVersion: string;
  bucketAt: string;
  configVersion: number;
  status: SpatialRunStatus;
  startedAt: string;
  finishedAt: string | null;
  inputDigest: string | null;
  snapshotIds: string[];
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number | null;
}

export interface SpatialEngineHealth {
  scope: SpatialScope;
  engineId: string;
  engineVersion: string;
  enabled: boolean;
  state:
    | "healthy"
    | "learning_baseline"
    | "degraded_sensor_data"
    | "configuration_incomplete"
    | "calibration_stale"
    | "error"
    | "disabled"
    | "never_run";
  latestRun: SpatialInferenceRun | null;
  latestSnapshotAt: string | null;
}

export interface SpatialSnapshotNotification {
  partition: SpatialDataPartition;
  scope: SpatialScope;
  snapshotIds: string[];
  bucketAt: string;
  emittedAt: string;
}
