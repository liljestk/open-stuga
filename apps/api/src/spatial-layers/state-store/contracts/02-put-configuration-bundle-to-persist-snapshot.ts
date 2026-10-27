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
import "../core.js";

declare module "../core.js" {
  interface SpatialLayerStateStoreInternals {
    putConfigurationBundle(input: {
            partition: SpatialDataPartition;
            scope: SpatialScope;
            baseVersion: number;
            config: Record<string, unknown>;
            assignments: Array<Omit<SpatialEngineAssignment, "scope" | "configVersion" | "updatedAt">>;
            createdAt?: string;
            createdBy?: string | null;
        }): {
            configuration: SpatialConfigurationVersion;
            assignments: SpatialEngineAssignment[];
        };
    listAssignments(partition: SpatialDataPartition, scope: SpatialScope, includeDisabled?: boolean): SpatialEngineAssignment[];
    putAssignment(partition: SpatialDataPartition, assignment: SpatialEngineAssignment): SpatialEngineAssignment;
    putAssignments(partition: SpatialDataPartition, assignments: SpatialEngineAssignment[]): SpatialEngineAssignment[];
    addBinding(partition: SpatialDataPartition, binding: StoredSpatialSensorBinding): StoredSpatialSensorBinding;
    listBindings(partition: SpatialDataPartition, houseId: string, from?: string, to?: string): StoredSpatialSensorBinding[];
    addCalibration(partition: SpatialDataPartition, calibration: StoredSpatialSensorCalibration): StoredSpatialSensorCalibration;
    listCalibrations(partition: SpatialDataPartition, houseId: string, from?: string, to?: string): StoredSpatialSensorCalibration[];
    addCalibrationSession(partition: SpatialDataPartition, session: SpatialCalibrationSession): SpatialCalibrationSession;
    addCalibrationSessionBundle(partition: SpatialDataPartition, session: SpatialCalibrationSession, calibrations: StoredSpatialSensorCalibration[]): {
            session: SpatialCalibrationSession;
            calibrations: StoredSpatialSensorCalibration[];
        };
    listCalibrationSessions(partition: SpatialDataPartition, houseId: string): SpatialCalibrationSession[];
    addContextEvent(partition: SpatialDataPartition, event: StoredSpatialContextEvent): StoredSpatialContextEvent;
    listContextEvents(partition: SpatialDataPartition, houseId: string, from: string, to: string): StoredSpatialContextEvent[];
    addGroundTruth(partition: SpatialDataPartition, truth: SpatialGroundTruth): SpatialGroundTruth;
    listGroundTruth(partition: SpatialDataPartition, scope: SpatialScope, from?: string, to?: string): SpatialGroundTruth[];
    startRun(input: Omit<SpatialInferenceRun, "id" | "status" | "finishedAt" | "inputDigest" | "snapshotIds" | "errorCode" | "errorMessage" | "durationMs"> & {
            id?: string;
        }): SpatialInferenceRun;
    finishRun(partition: SpatialDataPartition, id: string, result: {
            status: Exclude<SpatialRunStatus, "running">;
            finishedAt: string;
            inputDigest?: string | null;
            snapshotIds?: string[];
            errorCode?: string | null;
            errorMessage?: string | null;
            durationMs: number;
        }): SpatialInferenceRun;
    latestRun(partition: SpatialDataPartition, scope: SpatialScope, engineId?: string): SpatialInferenceRun | null;
    persistSnapshot(partition: SpatialDataPartition, draft: SpatialLayerSnapshotDraft, createdAt?: string): PersistedSpatialLayerSnapshot;
  }

  interface SpatialLayerStateStoreCore {
    putConfigurationBundle(input: {
            partition: SpatialDataPartition;
            scope: SpatialScope;
            baseVersion: number;
            config: Record<string, unknown>;
            assignments: Array<Omit<SpatialEngineAssignment, "scope" | "configVersion" | "updatedAt">>;
            createdAt?: string;
            createdBy?: string | null;
        }): {
            configuration: SpatialConfigurationVersion;
            assignments: SpatialEngineAssignment[];
        };
    listAssignments(partition: SpatialDataPartition, scope: SpatialScope, includeDisabled?: boolean): SpatialEngineAssignment[];
    putAssignment(partition: SpatialDataPartition, assignment: SpatialEngineAssignment): SpatialEngineAssignment;
    putAssignments(partition: SpatialDataPartition, assignments: SpatialEngineAssignment[]): SpatialEngineAssignment[];
    addBinding(partition: SpatialDataPartition, binding: StoredSpatialSensorBinding): StoredSpatialSensorBinding;
    listBindings(partition: SpatialDataPartition, houseId: string, from?: string, to?: string): StoredSpatialSensorBinding[];
    addCalibration(partition: SpatialDataPartition, calibration: StoredSpatialSensorCalibration): StoredSpatialSensorCalibration;
    listCalibrations(partition: SpatialDataPartition, houseId: string, from?: string, to?: string): StoredSpatialSensorCalibration[];
    addCalibrationSession(partition: SpatialDataPartition, session: SpatialCalibrationSession): SpatialCalibrationSession;
    addCalibrationSessionBundle(partition: SpatialDataPartition, session: SpatialCalibrationSession, calibrations: StoredSpatialSensorCalibration[]): {
            session: SpatialCalibrationSession;
            calibrations: StoredSpatialSensorCalibration[];
        };
    listCalibrationSessions(partition: SpatialDataPartition, houseId: string): SpatialCalibrationSession[];
    addContextEvent(partition: SpatialDataPartition, event: StoredSpatialContextEvent): StoredSpatialContextEvent;
    listContextEvents(partition: SpatialDataPartition, houseId: string, from: string, to: string): StoredSpatialContextEvent[];
    addGroundTruth(partition: SpatialDataPartition, truth: SpatialGroundTruth): SpatialGroundTruth;
    listGroundTruth(partition: SpatialDataPartition, scope: SpatialScope, from?: string, to?: string): SpatialGroundTruth[];
    startRun(input: Omit<SpatialInferenceRun, "id" | "status" | "finishedAt" | "inputDigest" | "snapshotIds" | "errorCode" | "errorMessage" | "durationMs"> & {
            id?: string;
        }): SpatialInferenceRun;
    finishRun(partition: SpatialDataPartition, id: string, result: {
            status: Exclude<SpatialRunStatus, "running">;
            finishedAt: string;
            inputDigest?: string | null;
            snapshotIds?: string[];
            errorCode?: string | null;
            errorMessage?: string | null;
            durationMs: number;
        }): SpatialInferenceRun;
    latestRun(partition: SpatialDataPartition, scope: SpatialScope, engineId?: string): SpatialInferenceRun | null;
    persistSnapshot(partition: SpatialDataPartition, draft: SpatialLayerSnapshotDraft, createdAt?: string): PersistedSpatialLayerSnapshot;
  }
}
