/** Engineering defaults for offline evaluation; never an advisory promotion receipt. */
export const ADAPTIVE_MONITORING_VERSION = "adaptive-monitoring/v1" as const;
export const ADAPTIVE_METRICS = ["temperature", "humidity", "co2"] as const;
export type AdaptiveMetric = (typeof ADAPTIVE_METRICS)[number];
export const ADAPTIVE_MATERIALITY: Readonly<Record<AdaptiveMetric, number>> = Object.freeze({
  temperature: 1,
  humidity: 7,
  co2: 200,
});

/** A closed UTC hour. availableAt is when that complete value was available. */
export interface AdaptiveHourlyEvidence {
  time: number;
  availableAt: number;
  value: number;
  coverage: number;
  quality: "good" | "estimated" | "stale";
  source: "observed" | "demo" | "replay";
  epochId: string;
  archiveComplete: boolean;
}

export type AdaptiveAbstentionReason =
  | "missing-target"
  | "insufficient-history"
  | "insufficient-calibration"
  | "context-guard"
  | "expired-model";

export interface AdaptiveResidualCalibration {
  bias: number;
  scale: number;
  threshold: number;
  count: number;
}

export interface AdaptiveReplayPoint {
  time: number;
  predictedAt: number;
  predicted: number | null;
  observed: number | null;
  calibration: AdaptiveResidualCalibration | null;
  direction: "higher" | "lower" | null;
  episode: "none" | "candidate" | "resolved" | "stale" | "expired";
  reason: AdaptiveAbstentionReason | null;
}

export interface AdaptiveReplayResult {
  algorithmVersion: typeof ADAPTIVE_MONITORING_VERSION;
  /** Historical replay cannot establish prospective availability or efficacy. */
  purpose: "retrospective-baseline";
  advisoryEligible: false;
  baseline: "persistence" | "same-hour-yesterday";
  points: AdaptiveReplayPoint[];
  scoredHours: number;
  abstainedHours: number;
  candidateEpisodes: number;
}
