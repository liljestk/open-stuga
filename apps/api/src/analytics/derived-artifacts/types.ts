import type {
  DataMode,
  DurableDerivedAnalyticsKind,
  HomePerformanceResponse,
  MoistureResponseResult,
  ThermalIsolationResult,
} from "@climate-twin/contracts";

export type DerivedResult =
  | ThermalIsolationResult
  | MoistureResponseResult
  | HomePerformanceResponse;

export interface DerivedIdentity {
  identityKey: string;
  kind: DurableDerivedAnalyticsKind;
  houseId: string;
  dataMode: DataMode;
  windowDays: number;
  cutoff: string;
  algorithmVersion: string;
  evidenceVersion: string;
}

export interface StoredDerivedArtifact extends DerivedIdentity {
  id: number;
  generatedAt: string;
  result: DerivedResult;
}

export type DerivedJobStatus = "pending" | "running" | "succeeded" | "failed";

export interface StoredDerivedJob extends DerivedIdentity {
  status: DerivedJobStatus;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  nextAttemptAt: string | null;
  attemptCount: number;
  errorCode: string | null;
  errorMessage: string | null;
}

/** A durable analytics operation crossed the irreversible demo/live boundary. */
export class DerivedAnalyticsDataModeError extends Error {
  readonly code = "ANALYTICS_DATA_MODE_MISMATCH";

  constructor(
    readonly requestedMode: DataMode,
    readonly activeMode: DataMode,
  ) {
    super(`Derived analytics requested ${requestedMode} data while ${activeMode} data is active`);
    this.name = "DerivedAnalyticsDataModeError";
  }
}

/** The durable job was canceled or replaced before its result could publish. */
export class DerivedAnalyticsJobFencedError extends Error {
  readonly code = "DERIVED_ANALYTICS_JOB_FENCED";

  constructor(identityKey: string) {
    super(`Derived analytics job ${identityKey} is no longer publishable`);
    this.name = "DerivedAnalyticsJobFencedError";
  }
}
