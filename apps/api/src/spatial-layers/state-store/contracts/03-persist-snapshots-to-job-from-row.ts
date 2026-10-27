import type {
  PersistedSpatialLayerSnapshot,
  SpatialDataPartition,
  SpatialInferenceSession,
  SpatialLayerSnapshotDraft,
  SpatialScope,
} from "../../types.js";
import { SpatialInferenceJob, SqlRow } from "../support/01-far-future-to-spatial-inference-job.js";
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
            sessionId?: string | null;
            now?: string;
        }): SpatialInferenceJob;
    claimDueJobs(partition: SpatialDataPartition, now?: string, limit?: number): SpatialInferenceJob[];
    completeJob(partition: SpatialDataPartition, id: string, lockToken: string, now?: string): boolean;
    failJob(partition: SpatialDataPartition, id: string, lockToken: string, error: string, retryAt: string, maximumAttempts?: number): boolean;
    deferJob(partition: SpatialDataPartition, id: string, lockToken: string, availableAt: string, now?: string): boolean;
    cancelOutstandingJobs(partition: SpatialDataPartition, now?: string): number;
    cancelOutstandingJobsForSession(partition: SpatialDataPartition, sessionId: string, now?: string): number;
    cancelLegacyOutstandingJobs(partition: SpatialDataPartition, now?: string): number;
    recoverInterruptedSessionJobs(partition: SpatialDataPartition, now?: string): number;
    startInferenceSession(input: {
            partition: SpatialDataPartition;
            houseId: string;
            durationMinutes?: number;
            cadenceMinutes?: number;
            now?: string;
            createdBy?: string | null;
        }): SpatialInferenceSession;
    latestInferenceSession(partition: SpatialDataPartition, houseId: string): SpatialInferenceSession | null;
    getInferenceSession(partition: SpatialDataPartition, id: string): SpatialInferenceSession | null;
    hasActiveInferenceSessions(partition: SpatialDataPartition): boolean;
    stopInferenceSession(partition: SpatialDataPartition, houseId: string, now?: string): SpatialInferenceSession | null;
    expireInferenceSessions(partition: SpatialDataPartition, now?: string): SpatialInferenceSession[];
    scheduleDueInferenceSessions(partition: SpatialDataPartition, now?: string, limit?: number, houseId?: string): SpatialInferenceJob[];
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
            sessionId?: string | null;
            now?: string;
        }): SpatialInferenceJob;
    claimDueJobs(partition: SpatialDataPartition, now?: string, limit?: number): SpatialInferenceJob[];
    completeJob(partition: SpatialDataPartition, id: string, lockToken: string, now?: string): boolean;
    failJob(partition: SpatialDataPartition, id: string, lockToken: string, error: string, retryAt: string, maximumAttempts?: number): boolean;
    deferJob(partition: SpatialDataPartition, id: string, lockToken: string, availableAt: string, now?: string): boolean;
    cancelOutstandingJobs(partition: SpatialDataPartition, now?: string): number;
    cancelOutstandingJobsForSession(partition: SpatialDataPartition, sessionId: string, now?: string): number;
    cancelLegacyOutstandingJobs(partition: SpatialDataPartition, now?: string): number;
    recoverInterruptedSessionJobs(partition: SpatialDataPartition, now?: string): number;
    startInferenceSession(input: {
            partition: SpatialDataPartition;
            houseId: string;
            durationMinutes?: number;
            cadenceMinutes?: number;
            now?: string;
            createdBy?: string | null;
        }): SpatialInferenceSession;
    latestInferenceSession(partition: SpatialDataPartition, houseId: string): SpatialInferenceSession | null;
    getInferenceSession(partition: SpatialDataPartition, id: string): SpatialInferenceSession | null;
    hasActiveInferenceSessions(partition: SpatialDataPartition): boolean;
    stopInferenceSession(partition: SpatialDataPartition, houseId: string, now?: string): SpatialInferenceSession | null;
    expireInferenceSessions(partition: SpatialDataPartition, now?: string): SpatialInferenceSession[];
    scheduleDueInferenceSessions(partition: SpatialDataPartition, now?: string, limit?: number, houseId?: string): SpatialInferenceJob[];
    purgeOperationalHistoryBefore(partition: SpatialDataPartition, before: string): {
            snapshots: number;
            runs: number;
            jobs: number;
        };
    getCheckpoint<T>(partition: SpatialDataPartition, scope: SpatialScope, key: string): T | null;
    putCheckpoint(partition: SpatialDataPartition, scope: SpatialScope, key: string, value: unknown, now?: string): void;
    getJob(partition: SpatialDataPartition, id: string): SpatialInferenceJob | null;
  }
}
