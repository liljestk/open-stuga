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
import { SpatialSourceIdentityCollisionError, SpatialStateValidationError, SqlRow, parseJson, partitionParams, scopeParams, sqlIdentifier, stableJson } from "../support/01-far-future-to-spatial-inference-job.js";
import "../core.js";

declare module "../core.js" {
  interface SpatialLayerStateStoreInternals {
    close(): void;
    transaction<T>(operation: () => T): T;
    migrate(): void;
    rekeyLegacySourceDatabaseId(legacySourceDbId: string, stableSourceDbId: string): {
            migratedModes: SpatialDataPartition["dataMode"][];
            migratedRows: number;
        };
    getCurrentConfiguration(partition: SpatialDataPartition, scope: SpatialScope): SpatialConfigurationVersion;
    putConfiguration(input: {
            partition: SpatialDataPartition;
            scope: SpatialScope;
            baseVersion: number;
            config: Record<string, unknown>;
            createdAt?: string;
            createdBy?: string | null;
        }): SpatialConfigurationVersion;
  }

  interface SpatialLayerStateStoreCore {
    close(): void;
    rekeyLegacySourceDatabaseId(legacySourceDbId: string, stableSourceDbId: string): {
            migratedModes: SpatialDataPartition["dataMode"][];
            migratedRows: number;
        };
    getCurrentConfiguration(partition: SpatialDataPartition, scope: SpatialScope): SpatialConfigurationVersion;
    putConfiguration(input: {
            partition: SpatialDataPartition;
            scope: SpatialScope;
            baseVersion: number;
            config: Record<string, unknown>;
            createdAt?: string;
            createdBy?: string | null;
        }): SpatialConfigurationVersion;
  }
}
