import type { DataMode } from "./measurement-analytics.js";
import type { DerivedAnalyticsEnvelope } from "./analytics-common.js";
import type { Sensor } from "./sensors-alerts.js";

/** Entity IDs alone do not prove physical independence. Child IDs survive hub/account changes. */
export function adaptiveReferenceDeviceKey(sensor: Pick<Sensor, "tpLinkDeviceId">): string | null {
  return sensor.tpLinkDeviceId ? `tp-link:${sensor.tpLinkDeviceId}` : null;
}

export const ADAPTIVE_MONITORING_VERSION = "adaptive-monitoring-v1.0.0";
export const ADAPTIVE_METRICS = ["temperature", "humidity", "co2"] as const;
export const ADAPTIVE_MODES = ["off", "shadow", "advisory"] as const;
export const ADAPTIVE_STATES = ["disabled", "collecting", "ready", "stale", "paused", "failed"] as const;
export const ADAPTIVE_REVIEW_DISPOSITIONS = ["useful", "not-useful", "expected-change", "uncertain"] as const;
export type AdaptiveMetric = typeof ADAPTIVE_METRICS[number];
export type AdaptiveMode = typeof ADAPTIVE_MODES[number];
export type AdaptiveState = typeof ADAPTIVE_STATES[number];
export type AdaptiveDisposition = typeof ADAPTIVE_REVIEW_DISPOSITIONS[number];
export type AdaptiveKind = "climate-departure" | "sensor-comparison";
export type AdaptiveModelFamily = "daily-profile" | "thermal-relaxation" | "reference-offset";
export const ADAPTIVE_DEFAULTS = {
  minimumCoverage: 0.8, qualificationDays: 28, calibrationHours: 120,
  materiality: { temperature: 1, humidity: 7, co2: 200 },
  workerStreams: 32, deadlineMs: 30_000, maximumInputSamples: 50_000,
} as const;

export interface AdaptiveReferenceGroup {
  sensorId: string;
  peerIds: string[];
  designatedReference: boolean;
}
export interface AdaptiveSettings {
  revision: number;
  mode: AdaptiveMode;
  enabledAt: string | null;
  referenceGroups: AdaptiveReferenceGroup[];
  promotionReceiptId: string | null;
}
export interface AdaptiveSettingsPatch {
  dataMode: DataMode;
  baseRevision: number;
  mode?: AdaptiveMode;
  referenceGroups?: AdaptiveReferenceGroup[];
  resetBaseline?: { sensorId: string; reason: string };
  promotionReceiptId?: string;
}
export interface AdaptiveEvaluation {
  model: AdaptiveModelFamily;
  evaluatedAt: string;
  trainingCutoff: string;
  calibrationHours: number;
  holdoutHours: number;
  coverage: number | null;
  mae: number | null;
  baselineMae: number | null;
  qualified: boolean;
  reason: string;
}
export interface AdaptiveStream {
  id: string;
  sensorId: string;
  sensorName: string;
  floorId: string;
  room: string;
  metric: AdaptiveMetric;
  kind: AdaptiveKind;
  epoch: string;
  epochStartedAt: string;
  state: AdaptiveState;
  reason: string;
  usableHours: number;
  evaluatedThrough: string | null;
  evaluation: AdaptiveEvaluation | null;
}
export interface AdaptiveReview {
  id: string;
  revision: number;
  disposition: AdaptiveDisposition;
  note: string;
  recordedAt: string;
}
export interface AdaptiveFinding {
  id: string;
  revision: number;
  houseId: string;
  propertyId: string;
  sensorId: string;
  sensorName: string;
  floorId: string;
  room: string;
  epoch: string;
  metric: AdaptiveMetric;
  kind: AdaptiveKind;
  direction: "high" | "low";
  severity: "notice";
  state: "candidate" | "presented" | "resolved" | "expired";
  firstEvidenceAt: string;
  lastEvidenceAt: string;
  recordedAt: string;
  freshness: "fresh" | "stale";
  observed: number;
  expected: number;
  low: number;
  high: number;
  unit: string;
  coverage: number;
  sourceIds: string[];
  contextGaps: string[];
  modelId: string;
  review: AdaptiveReview | null;
}
export interface AdaptivePage<T> { items: T[]; nextCursor: string | null }
export interface AdaptiveSnapshot extends DerivedAnalyticsEnvelope {
  houseId: string;
  settings: AdaptiveSettings;
  state: AdaptiveState;
  reason: string;
  evaluatedThrough: string | null;
  streams: AdaptivePage<AdaptiveStream>;
  findings: AdaptivePage<AdaptiveFinding>;
  counts: { streams: number; ready: number; findings: number };
}
export interface AdaptiveFindingDetail {
  finding: AdaptiveFinding;
  revisions: AdaptivePage<AdaptiveFinding>;
}
export interface AdaptiveReviewInput {
  dataMode: DataMode;
  baseRevision: number;
  idempotencyKey: string;
  disposition: AdaptiveDisposition;
  note: string;
}
/** Trusted offline evaluation evidence, never supplied as a browser assertion. */
export interface AdaptivePromotionReceipt {
  id: string;
  algorithmVersion: typeof ADAPTIVE_MONITORING_VERSION;
  configurationDigest: string;
  dataMode: DataMode;
  homeWeeks: number;
  homes: number;
  reviewedFraction: number;
  falseEpisodesPerHomeWeek: number;
  baselineImprovement: number;
  recall: number;
  scoredFraction: number;
  resourceBudgetsPassed: boolean;
  heatingActiveAndInactive: boolean;
  capabilities: Array<{ kind: AdaptiveKind; metric: AdaptiveMetric; reviewedEvents: number }>;
}
