import type {
  AnalyticsArchiveState,
  DataMode,
} from "./measurement-analytics.js";
import type {
  OpeningState,
  OpeningStateSource,
} from "./building-structure.js";
import type {
  DerivedAnalyticsProvenance,
  DerivedAnalyticsWarning,
} from "./analytics-common.js";

export const OPENING_ACTIVITY_ALGORITHM_VERSION = "opening-activity-v2.0.0";

export interface OpeningActivityRequest {
  apiVersion: "1.0";
  requestId: string;
  houseId: string;
  dataMode: DataMode;
  range: {
    start: string;
    end: string;
  };
  elementIds?: string[];
}

export interface OpeningActivityTarget {
  key: string;
  floorId: string;
  floorName: string;
  elementId: string;
  kind: "door" | "window";
  label: string | null;
  ordinal: number;
}

export interface OpeningActivitySegment {
  state: Exclude<OpeningState, "unknown">;
  startedAt: string;
  endedAt: string;
}

export interface OpeningActivityRecord {
  id: string;
  observedAt: string;
  state: OpeningState;
  source: OpeningStateSource;
  transition: "opened" | "closed" | "unknown" | "initial";
}

export interface OpeningActivitySeries {
  target: OpeningActivityTarget;
  segments: OpeningActivitySegment[];
  records: OpeningActivityRecord[];
  observationCount: number;
  openedCount: number;
  closedCount: number;
  confirmedOpenMs: number;
  longestOpenMs: number;
  currentState: OpeningState;
  currentSince: string | null;
  lastObservedAt: string | null;
}

export interface OpeningActivityResponse {
  apiVersion: "1.0";
  requestId: string;
  houseId: string;
  dataMode: DataMode;
  range: {
    start: string;
    end: string;
  };
  generatedAt: string;
  complete: boolean;
  truncated: boolean;
  archiveState: AnalyticsArchiveState;
  series: OpeningActivitySeries[];
  warnings: DerivedAnalyticsWarning[];
  provenance: DerivedAnalyticsProvenance;
}
