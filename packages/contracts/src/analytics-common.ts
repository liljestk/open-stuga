import type { AnalyticsArchiveState, DataMode } from "./measurement-analytics.js";

export type DerivedAnalyticsCompleteness = "complete" | "partial" | "unavailable";

export type AnalyticsWarningDetailValue = string | number | boolean | null;

export interface DerivedAnalyticsWarning {
  code: string;
  message: string;
  details?: Readonly<Record<string, AnalyticsWarningDetailValue>>;
}

export interface DerivedAnalyticsProvenance {
  algorithmKey: string;
  algorithmVersion: string;
  evaluatedAt: string;
  sourceIds: string[];
  archiveState?: AnalyticsArchiveState;
}

export interface DerivedAnalyticsCache {
  hit: boolean;
  coalesced: boolean;
  keyVersion: string;
  ttlSeconds: number;
}

export interface DerivedAnalyticsEnvelope {
  apiVersion: "1.0";
  dataMode: DataMode;
  generatedAt: string;
  evaluatedAt: string;
  completeness: DerivedAnalyticsCompleteness;
  warnings: DerivedAnalyticsWarning[];
  provenance: DerivedAnalyticsProvenance;
}

export type DurableDerivedAnalyticsKind =
  | "thermal-isolation"
  | "moisture-response"
  | "home-performance";

export type DurableDerivedAnalyticsState =
  | "idle"
  | "ready"
  | "queued"
  | "refreshing"
  | "failed";

/**
 * A constant-time read of an immutable, locally persisted derived result.
 * `result` is the last successful artifact and remains available while a newer
 * identity is queued, running, or failed.
 */
export interface DurableDerivedAnalyticsResponse<Result> {
  apiVersion: "1.0";
  kind: DurableDerivedAnalyticsKind;
  houseId: string;
  dataMode: DataMode;
  windowDays: number;
  cutoff: string;
  state: DurableDerivedAnalyticsState;
  stale: boolean;
  result: Result | null;
  artifact: null | {
    id: number;
    generatedAt: string;
    cutoff: string;
    algorithmVersion: string;
    evidenceVersion: string;
  };
  job: null | {
    requestedAt: string;
    startedAt: string | null;
    completedAt: string | null;
    nextAttemptAt: string | null;
    attemptCount: number;
    errorCode: string | null;
    errorMessage: string | null;
  };
}
