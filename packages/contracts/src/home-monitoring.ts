import type { Metric } from "./measurement-analytics.js";
import type {
  DerivedAnalyticsCompleteness,
  DerivedAnalyticsProvenance,
  DerivedAnalyticsWarning,
} from "./analytics-common.js";

export const HOME_MONITORING_ALGORITHM_VERSION = "home-monitoring-v2.0.0";

export type HomeMonitoringStatus =
  | "action-required"
  | "inspection-recommended"
  | "monitoring-ok"
  | "unknown";

export type HomeMonitoringBlockerKind =
  | "critical-alert"
  | "warning-alert"
  | "information-alert"
  | "no-sensors"
  | "missing-data"
  | "stale-data"
  | "source-disconnected"
  | "estimated-data"
  | "aging-data";

export type HomePulseStatus = "critical" | "attention" | "watch" | "steady" | "unknown";
export type HomeInsightKind =
  | "active-alert"
  | "humidity"
  | "indoor-air"
  | "temperature"
  | "temperature-balance"
  | "sensor-coverage"
  | "setup";
export type HomeInsightSeverity = "critical" | "warning" | "notice" | "info";
export type HomeInsightConfidenceLevel = "high" | "medium" | "low";
export type HomeInsightFreshnessState = "fresh" | "estimated" | "aging" | "stale" | "unknown";

export interface HomePulseCoverage {
  enabledSensors: number;
  freshSensors: number;
  estimatedSensors: number;
  agingSensors: number;
  staleSensors: number;
  sensorsWithoutData: number;
}

export interface HomeInsightFreshness {
  state: HomeInsightFreshnessState;
  evidenceAt: string | null;
  ageMinutes: number | null;
}

export interface HomeMonitoringBlocker {
  id: string;
  kind: HomeMonitoringBlockerKind;
  code: `monitoring.blocker.${HomeMonitoringBlockerKind}`;
  parameters: Record<string, string | number | boolean | null>;
  fallbackMessage: string;
  count: number;
  sensorIds: string[];
  evidenceAt: string | null;
  acknowledged: boolean;
}

export interface HomeMonitoringSummary {
  houseId: string;
  generatedAt: string;
  status: HomeMonitoringStatus;
  pulseStatus: HomePulseStatus;
  coverage: HomePulseCoverage;
  activeAlertCount: number;
  blockers: HomeMonitoringBlocker[];
}

export interface HomePulseSensorCoverage {
  sensorId: string;
  freshness: HomeInsightFreshness;
  requiredMetrics: Metric[];
}

export interface HomeInsightTarget {
  houseId: string;
  sensorId?: string;
  sensorName?: string;
  floorId?: string;
  floorName?: string;
  room?: string;
}

export interface HomeInsightEvidence {
  label: string;
  value: number | string;
  unit?: string;
  metric?: Metric;
  sensorId?: string;
  observedAt?: string;
}

export interface HomeInsight {
  id: string;
  rank: number;
  kind: HomeInsightKind;
  severity: HomeInsightSeverity;
  priority: number;
  titleCode: `monitoring.insight.${HomeInsightKind}.title`;
  summaryCode: `monitoring.insight.${HomeInsightKind}.summary`;
  actionCode: `monitoring.insight.${HomeInsightKind}.action`;
  parameters: Record<string, string | number | boolean | null>;
  fallbackTitle: string;
  fallbackSummary: string;
  fallbackAction: string;
  target: HomeInsightTarget;
  evidence: HomeInsightEvidence[];
  freshness: HomeInsightFreshness;
  confidence: {
    level: HomeInsightConfidenceLevel;
    score: number;
    reasonCode: `monitoring.confidence.${HomeInsightConfidenceLevel}`;
    fallbackReason: string;
  };
  safetyNote?: string;
}

interface HomeMonitoringEnvelope {
  apiVersion: "1.0";
  dataMode: "live" | "demo";
  algorithm: {
    key: "home-monitoring";
    version: typeof HOME_MONITORING_ALGORITHM_VERSION;
  };
  generatedAt: string;
  evaluatedAt: string;
  completeness: DerivedAnalyticsCompleteness;
  warnings: DerivedAnalyticsWarning[];
  provenance: DerivedAnalyticsProvenance;
}

export interface HomeMonitoringCollectionResponse extends HomeMonitoringEnvelope {
  houses: HomeMonitoringSummary[];
}

export interface HomeMonitoringDetailResponse extends HomeMonitoringEnvelope {
  house: HomeMonitoringSummary;
  sensorCoverage: HomePulseSensorCoverage[];
  insights: HomeInsight[];
  advisoryCode: "monitoring.advisory";
  fallbackAdvisory: string;
}
