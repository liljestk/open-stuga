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
