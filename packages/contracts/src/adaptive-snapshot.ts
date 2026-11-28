import { ADAPTIVE_METRICS, isAdaptiveMonitoringSettings, type AdaptiveEvidencePurpose,
  type AdaptiveMetric, type AdaptiveMonitoringSettings } from "./adaptive-monitoring.js";
import { isAdaptiveFindingsPage, type AdaptiveFindingsPage } from "./adaptive-findings.js";
import type { DerivedAnalyticsEnvelope } from "./analytics-common.js";
import { isOneOf } from "./literal-values.js";

export const ADAPTIVE_MONITORING_STATES = ["disabled", "collecting", "ready", "stale", "paused", "failed"] as const;
export const ADAPTIVE_STREAM_REASONS = [
  "monitoring-off", "awaiting-evidence", "calibration-pending", "current-evidence", "evidence-gap",
  "qualification-rejected", "reference-placement-unavailable", "worker-paused", "worker-failed",
] as const;
export type AdaptiveMonitoringState = (typeof ADAPTIVE_MONITORING_STATES)[number];
export type AdaptiveStreamReason = (typeof ADAPTIVE_STREAM_REASONS)[number];

export interface AdaptiveStreamStatus {
  sensorId: string;
  metric: AdaptiveMetric;
  purpose: AdaptiveEvidencePurpose;
  epochId: string | null;
  state: AdaptiveMonitoringState;
  reason: AdaptiveStreamReason;
  evaluatedThrough: string | null;
  coverage: number | null;
}

export interface AdaptiveHomeSnapshot extends DerivedAnalyticsEnvelope {
  houseId: string;
  snapshotId: string;
  settings: AdaptiveMonitoringSettings;
  state: AdaptiveMonitoringState;
  evaluatedThrough: string | null;
  counts: Record<AdaptiveMonitoringState | "total", number>;
  streams: { items: AdaptiveStreamStatus[]; nextCursor: string | null };
  findings: AdaptiveFindingsPage;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function date(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isStream(value: unknown): value is AdaptiveStreamStatus {
  return object(value) && typeof value.sensorId === "string" && isOneOf(value.metric, ADAPTIVE_METRICS)
    && isOneOf(value.purpose, ["climate", "sensor-comparison"]) && (value.epochId === null || typeof value.epochId === "string")
    && isOneOf(value.state, ADAPTIVE_MONITORING_STATES) && isOneOf(value.reason, ADAPTIVE_STREAM_REASONS)
    && (value.evaluatedThrough === null || date(value.evaluatedThrough))
    && (value.coverage === null || (typeof value.coverage === "number" && value.coverage >= 0 && value.coverage <= 1));
}

function isCounts(value: unknown): boolean {
  if (!object(value)) return false;
  return [...ADAPTIVE_MONITORING_STATES, "total"].every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0);
}

function isProvenance(value: unknown): boolean {
  return object(value) && typeof value.algorithmKey === "string" && typeof value.algorithmVersion === "string"
    && date(value.evaluatedAt) && Array.isArray(value.sourceIds) && value.sourceIds.every((id) => typeof id === "string");
}

export function isAdaptiveHomeSnapshot(value: unknown): value is AdaptiveHomeSnapshot {
  if (!object(value) || !object(value.streams)) return false;
  const { streams, settings } = value;
  return value.apiVersion === "1.0" && typeof value.snapshotId === "string" && isAdaptiveMonitoringSettings(settings)
    && value.houseId === settings.houseId && value.dataMode === settings.dataMode && isOneOf(value.state, ADAPTIVE_MONITORING_STATES)
    && isOneOf(value.completeness, ["complete", "partial", "unavailable"]) && date(value.generatedAt) && date(value.evaluatedAt)
    && (value.evaluatedThrough === null || date(value.evaluatedThrough)) && isCounts(value.counts)
    && Array.isArray(value.warnings) && value.warnings.every((warning) => object(warning)
      && typeof warning.code === "string" && typeof warning.message === "string")
    && isProvenance(value.provenance) && Array.isArray(streams.items) && streams.items.every(isStream)
    && (streams.nextCursor === null || typeof streams.nextCursor === "string") && isAdaptiveFindingsPage(value.findings);
}
