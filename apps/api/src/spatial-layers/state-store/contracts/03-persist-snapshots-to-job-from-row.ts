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
import { SpatialInferenceJob, SqlRow, assertInterval, assertIsoTimestamp, parseJson, partitionFromRow, partitionParams, scopeFromRow, scopeParams, snapshotFromRow, stableJson } from "../support/01-far-future-to-spatial-inference-job.js";
import "../core.js";

declare module "../core.js" {
  interface SpatialLayerStateStoreInternals {
    persistSnapshots(partition: SpatialDataPartition, drafts: SpatialLayerSnapshotDraft[], createdAt?: string): PersistedSpatialLayerSnapshot[];
    currentSnapshots(partition: SpatialDataPartition, scope: SpatialScope, layerIds?: string[]): PersistedSpatialLayerSnapshot[];
    snapshotHistory(input: {
            partition: SpatialDataPartition;
            scope: SpatialScope;
            from: string;
            to: string;
            layerIds?: string[];
            includeSuperseded?: boolean;
            limit?: number;
        }): PersistedSpatialLayerSnapshot[];
    scheduleJob(input: {
            partition: SpatialDataPartition;
            scope: SpatialScope;
            bucketAt: string;
            reason: string;
            availableAt?: string;
            allowReopen?: boolean;
            now?: string;
        }): SpatialInferenceJob;
    claimDueJobs(partition: SpatialDataPartition, now?: string, limit?: number): SpatialInferenceJob[];
    completeJob(partition: SpatialDataPartition, id: string, lockToken: string, now?: string): boolean;
    failJob(partition: SpatialDataPartition, id: string, lockToken: string, error: string, retryAt: string, maximumAttempts?: number): boolean;
    cancelOutstandingJobs(partition: SpatialDataPartition, now?: string): number;
    purgeOperationalHistoryBefore(partition: SpatialDataPartition, before: string): {
            snapshots: number;
            runs: number;
            jobs: number;
        };
    getCheckpoint<T>(partition: SpatialDataPartition, scope: SpatialScope, key: string): T | null;
    putCheckpoint(partition: SpatialDataPartition, scope: SpatialScope, key: string, value: unknown, now?: string): void;
    getJob(partition: SpatialDataPartition, id: string): SpatialInferenceJob | null;
    jobFromRow(row: SqlRow): SpatialInferenceJob;
  }

  interface SpatialLayerStateStoreCore {
    persistSnapshots(partition: SpatialDataPartition, drafts: SpatialLayerSnapshotDraft[], createdAt?: string): PersistedSpatialLayerSnapshot[];
    currentSnapshots(partition: SpatialDataPartition, scope: SpatialScope, layerIds?: string[]): PersistedSpatialLayerSnapshot[];
    snapshotHistory(input: {
            partition: SpatialDataPartition;
            scope: SpatialScope;
            from: string;
            to: string;
            layerIds?: string[];
            includeSuperseded?: boolean;
            limit?: number;
        }): PersistedSpatialLayerSnapshot[];
    scheduleJob(input: {
            partition: SpatialDataPartition;
            scope: SpatialScope;
            bucketAt: string;
            reason: string;
            availableAt?: string;
            allowReopen?: boolean;
            now?: string;
        }): SpatialInferenceJob;
    claimDueJobs(partition: SpatialDataPartition, now?: string, limit?: number): SpatialInferenceJob[];
    completeJob(partition: SpatialDataPartition, id: string, lockToken: string, now?: string): boolean;
    failJob(partition: SpatialDataPartition, id: string, lockToken: string, error: string, retryAt: string, maximumAttempts?: number): boolean;
    cancelOutstandingJobs(partition: SpatialDataPartition, now?: string): number;
    purgeOperationalHistoryBefore(partition: SpatialDataPartition, before: string): {
            snapshots: number;
            runs: number;
            jobs: number;
        };
    getCheckpoint<T>(partition: SpatialDataPartition, scope: SpatialScope, key: string): T | null;
    putCheckpoint(partition: SpatialDataPartition, scope: SpatialScope, key: string, value: unknown, now?: string): void;
  }
}
