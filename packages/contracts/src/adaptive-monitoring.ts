import type { DataMode } from "./measurement-analytics.js";
import { isOneOf } from "./literal-values.js";

/** Engineering defaults for offline evaluation; never an advisory promotion receipt. */
export const ADAPTIVE_MONITORING_VERSION = "adaptive-monitoring/v1" as const;
export const ADAPTIVE_SETTINGS_MODES = ["off", "shadow"] as const;
export type AdaptiveSettingsMode = (typeof ADAPTIVE_SETTINGS_MODES)[number];
export const ADAPTIVE_BASELINE_REASON_LIMIT = 500;
export const ADAPTIVE_REFERENCE_GROUP_LIMIT = 100;
export const ADAPTIVE_REFERENCE_PEER_LIMIT = 8;
export const ADAPTIVE_REFERENCE_SENSOR_ID_LIMIT = 200;

/** Comparable placement is approved explicitly for one target temperature stream. */
export interface AdaptiveReferenceGroup {
  targetSensorId: string;
  kind: "peers" | "reference-thermometer";
  referenceSensorIds: string[];
  placement: string;
}

export interface AdaptiveSettingsScope { houseId: string; dataMode: DataMode }

export interface AdaptiveMonitoringSettings extends AdaptiveSettingsScope {
  mode: AdaptiveSettingsMode;
  revision: number;
  baseline: { id: string; startedAt: string } | null;
  referenceGroups: AdaptiveReferenceGroup[];
  updatedAt: string | null;
}

export type AdaptiveSettingsChange = {
  dataMode: DataMode;
  baseRevision: number;
} & (
  | { action: "set-mode"; mode: AdaptiveSettingsMode }
  | { action: "reset-baseline"; reason: string }
  | { action: "set-reference-groups"; referenceGroups: AdaptiveReferenceGroup[] }
);

function isReferenceSensorId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= ADAPTIVE_REFERENCE_SENSOR_ID_LIMIT
    && value.trim() === value;
}

function isReferenceGroup(value: unknown): value is AdaptiveReferenceGroup {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { targetSensorId, kind, referenceSensorIds, placement } = value as Record<string, unknown>;
  if (!isReferenceSensorId(targetSensorId) || typeof placement !== "string"
    || !placement.trim() || placement.length > ADAPTIVE_BASELINE_REASON_LIMIT
    || !Array.isArray(referenceSensorIds) || !referenceSensorIds.every(isReferenceSensorId)) return false;
  const count = referenceSensorIds.length;
  if (new Set(referenceSensorIds).size !== count || referenceSensorIds.includes(targetSensorId)) return false;
  return kind === "reference-thermometer" ? count === 1
    : kind === "peers" && count >= 2 && count <= ADAPTIVE_REFERENCE_PEER_LIMIT;
}

export function isAdaptiveReferenceGroups(value: unknown): value is AdaptiveReferenceGroup[] {
  return Array.isArray(value) && value.length <= ADAPTIVE_REFERENCE_GROUP_LIMIT
    && value.every(isReferenceGroup) && new Set(value.map((group) => group.targetSensorId)).size === value.length;
}

export function isAdaptiveMonitoringSettings(value: unknown): value is AdaptiveMonitoringSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { houseId, dataMode, mode, revision, baseline, updatedAt, referenceGroups } = value as Record<string, unknown>;
  if (typeof houseId !== "string" || !houseId || !isOneOf(dataMode, ["demo", "live"])
    || !isOneOf(mode, ADAPTIVE_SETTINGS_MODES) || !Number.isSafeInteger(revision) || Number(revision) < 0) return false;
  if (!isAdaptiveReferenceGroups(referenceGroups)) return false;
  if (revision === 0) return mode === "off" && baseline === null && updatedAt === null && referenceGroups.length === 0;
  if (typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt))) return false;
  if (mode === "off") return baseline === null;
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) return false;
  const { id, startedAt } = baseline as Record<string, unknown>;
  return typeof id === "string" && id.length > 0
    && typeof startedAt === "string" && Number.isFinite(Date.parse(startedAt));
}
export const ADAPTIVE_METRICS = ["temperature", "humidity", "co2"] as const;
export type AdaptiveMetric = (typeof ADAPTIVE_METRICS)[number];
export type AdaptiveEvidencePurpose = "climate" | "sensor-comparison";

export interface AdaptiveEvidenceScope extends AdaptiveSettingsScope {
  sensorId: string;
  metric: AdaptiveMetric;
  purpose: AdaptiveEvidencePurpose;
}

/** A prospective boundary. Configuration time and the time the epoch was persisted are separate. */
export interface AdaptiveEvidenceEpoch extends AdaptiveEvidenceScope {
  id: string;
  propertyId: string;
  baselineId: string;
  configurationDigest: string;
  effectiveAt: string;
  recordedAt: string;
}

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
