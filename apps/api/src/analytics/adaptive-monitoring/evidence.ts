import type { ForecastParameters } from "../forecast/models.js";
import type { AdaptiveEvaluation, AdaptiveFinding, AdaptiveModelFamily, AdaptiveStream, AdaptiveMetric } from "@climate-twin/contracts";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export interface AdaptiveInputBudget { remaining: number }
export interface AdaptivePrediction {
  value: number;
  madeAt: number;
  cutoff: number;
  parameters?: ForecastParameters;
}
export interface AdaptiveHour {
  time: number;
  availableAt: number;
  value: number | null;
  coverage: number;
  sources: string[];
  outdoor: number | null;
  guarded: boolean;
  peer: number | null;
  peerSpread?: number | null;
  predictions: Partial<Record<AdaptiveModelFamily, AdaptivePrediction>>;
  persistence: number | null;
  seasonal: number | null;
  score: { expected: number; threshold: number; residual: number } | null;
  excluded: boolean;
}
export interface AdaptiveStreamRuntime {
  selected: AdaptiveModelFamily | null;
  frozenAt: number | null;
  calibrationBefore: number | null;
  modelId: string | null;
  referenceBaseline?: { offset: number; threshold: number; cutoff: number; samples: number; peerSpread: number };
}
export interface AdaptiveStoredStream {
  stream: AdaptiveStream;
  houseId: string;
  fingerprint: string;
  runtime: AdaptiveStreamRuntime;
}
export interface AdaptiveFitInput {
  anchorBefore?: number | null;
  targetTime?: number;
  metric: AdaptiveMetric;
  hours: AdaptiveHour[];
  until: number;
  frozenAt: number | null;
}
export type AdaptiveFitResult = Partial<Record<AdaptiveModelFamily, AdaptivePrediction>>;
export interface AdaptiveAnalysis {
  evaluation: AdaptiveEvaluation | null;
  selected: AdaptiveModelFamily | null;
  hour: AdaptiveHour;
  runtime: AdaptiveStreamRuntime;
  state: AdaptiveStream["state"];
  reason: string;
  direction: AdaptiveFinding["direction"] | null;
  recovered: boolean;
}
