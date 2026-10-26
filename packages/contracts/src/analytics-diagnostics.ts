/** Operations whose live latency the appliance keeps, named like the release benchmark's scenarios. */
export type AnalyticsLatencyOperation =
  | "query-24h"
  | "query-7d"
  | "query-30d"
  | "query-365d"
  | "energy-summary-30d";

/**
 * p95 latency targets in milliseconds for a Raspberry Pi-class appliance.
 * Cold answers are computed; warm ones repeat a request and come from the
 * server cache. The release benchmark checks both; the appliance's live
 * evidence, a mix of the two, is held to the cold target.
 */
export const ANALYTICS_LATENCY_TARGETS_MS: Readonly<Record<AnalyticsLatencyOperation, { cold: number; warm: number }>> = {
  "query-24h": { cold: 400, warm: 100 },
  "query-7d": { cold: 800, warm: 100 },
  "query-30d": { cold: 1_500, warm: 100 },
  "query-365d": { cold: 3_000, warm: 150 },
  "energy-summary-30d": { cold: 2_000, warm: 100 },
};

export interface AnalyticsLatencyEvidence {
  operation: AnalyticsLatencyOperation;
  requests: number;
  /** Upper edge of the histogram bucket holding the percentile. */
  p50Ms: number | null;
  p95Ms: number | null;
  targetP95Ms: number;
  meetsTarget: boolean | null;
}

export interface AnalyticsForecastEvidence {
  metric: string;
  sensors: number;
  /** Daily backtests stored in the window, each over the two weeks before it. */
  evaluations: number;
  withheld: number;
  medianSkill6h: number | null;
  medianSkill24h: number | null;
  medianCoverage90: number | null;
  /** Positive skill at 6 h and 24 h with 90% intervals covering 85–95%. */
  meetsTarget: boolean | null;
}

export interface AnalyticsBillEvidence {
  invoices: number;
  reconciled: number;
  outsideTolerance: number;
  incomplete: number;
  medianAbsoluteErrorPercent: number | null;
  tolerancePercent: number;
  /** At least three invoices reconciled and none outside tolerance. */
  meetsTarget: boolean | null;
}

export interface AnalyticsProjectionEvidence {
  method: "weather-regression" | "recent-average";
  origins: number;
  meanAbsolutePercentError: number | null;
  baselineMeanAbsolutePercentError: number | null;
  skill: number | null;
  /** The weather model beat repeating the last 30 days. */
  meetsTarget: boolean | null;
}

export interface AnalyticsFindingsEvidence {
  evaluatedThrough: string;
  seriesTested: number | null;
  findings: number;
  falseDiscoveryRate: number | null;
}

/**
 * Evidence collected on this appliance over time: how the analytics actually
 * performed for this Home. It never leaves the appliance.
 */
export interface AnalyticsDiagnostics {
  houseId: string;
  generatedAt: string;
  windowDays: number;
  latency: AnalyticsLatencyEvidence[];
  forecasts: AnalyticsForecastEvidence[];
  bills: AnalyticsBillEvidence;
  projection: AnalyticsProjectionEvidence | null;
  findings: AnalyticsFindingsEvidence | null;
}
