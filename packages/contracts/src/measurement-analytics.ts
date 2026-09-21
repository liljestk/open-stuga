/** Registry identifier for a measurement type (for example `temperature` or `co2`). */
export type Metric = string;

export type MeasurementColorScale = "thermal" | "humidity" | "air-quality" | "sequential";

/** Analytics partitions use `live`; the legacy integration status calls the same mode `real`. */
export type DataMode = "live" | "demo";

export type TruthClass =
  | "observed"
  | "derived"
  | "estimated"
  | "inferred"
  | "forecast"
  | "simulated";

export type ConfidenceLevel = "none" | "very_low" | "low" | "medium" | "high";

export type QualityFlag =
  | "missing"
  | "stale"
  | "duplicate"
  | "out_of_order"
  | "clock_skew"
  | "out_of_physical_range"
  | "implausible_rate"
  | "spike"
  | "flatline"
  | "sensor_reset"
  | "counter_reset"
  | "source_estimated"
  | "interpolated"
  | "calibrated"
  | "placement_unknown"
  | "weather_remote"
  | "estimated_pressure"
  | "topology_incomplete"
  | "low_coverage";

export type MeasurementKind =
  | "gauge"
  | "rate"
  | "increment"
  | "cumulative_counter"
  | "binary_state"
  | "categorical_state";

export type AggregationSemantic =
  | "mean"
  | "sum"
  | "delta"
  | "last"
  | "time_weighted_mean"
  | "duration"
  | "custom";

/** Product release version. Pre-1.0 minor releases may contain breaking changes. */
export const SYSTEM_VERSION = "0.41.3" as const;

export interface MeasurementDefinition {
  id: Metric;
  labels: Record<string, string>;
  unit: string;
  /** Optional during the pre-1.0 registry migration; persisted definitions always populate these fields. */
  dimension?: string;
  allowedUnits?: string[];
  kind?: MeasurementKind;
  defaultAggregation?: AggregationSemantic;
  genericHistoryEnabled?: boolean;
  genericStatsEnabled?: boolean;
  precision: number;
  validMin: number | null;
  validMax: number | null;
  displayMin: number | null;
  displayMax: number | null;
  interpolationDelta: number;
  colorScale: MeasurementColorScale;
  builtin: boolean;
  enabled: boolean;
  spatialInterpolation: boolean;
  forecastSupported: boolean;
}

export type MeasurementDefinitionInput = Pick<MeasurementDefinition, "id" | "labels" | "unit">
  & Partial<Omit<MeasurementDefinition, "id" | "labels" | "unit" | "builtin">>;

export type MeasurementDefinitionPatch = Partial<Omit<MeasurementDefinition, "id" | "builtin">>;

export interface MeasurementSample {
  sensorId: string;
  metric: Metric;
  value: number;
  canonicalUnit: string;
  timestamp: string;
  source: "mock" | "home-assistant" | "tp-link" | "tuya" | "nexus433" | "gree" | "api" | "import" | "replay";
  quality: "good" | "estimated" | "stale";
}

export type MeasurementSampleInput = Pick<MeasurementSample, "sensorId" | "metric" | "value">
  & Partial<Pick<MeasurementSample, "canonicalUnit" | "timestamp" | "source" | "quality">>;

export interface MeasurementForecastPoint {
  sensorId: string;
  metric: Metric;
  timestamp: string;
  value: number;
  low: number;
  high: number;
}

export interface MeasurementSnapshotEntry {
  sensorId: string;
  measurements: Record<Metric, MeasurementSample>;
}

/** Minute resolutions are accepted from 1m through 1440m after runtime validation. */
export type AnalyticsResolution = "auto" | "raw" | "1h" | "1d" | `${number}m`;

export type AnalyticsAggregation = "default" | Exclude<AggregationSemantic, "duration" | "custom"> | "min" | "max";

export type AnalyticsSampleQuality = MeasurementSample["quality"];

export interface AnalyticsQualityFilter {
  /** Only samples with one of these source quality states participate in values and summaries. */
  include: AnalyticsSampleQuality[];
}

export interface AnalyticsEntityScope {
  kind: "house";
  id: string;
  /** Omit to include every enabled sensor in the house. */
  entityIds?: string[];
}

export interface AnalyticsQueryRequest {
  apiVersion: "1.0";
  dataMode: DataMode;
  scope: AnalyticsEntityScope;
  measurementIds: string[];
  range: {
    start: string;
    end: string;
    timezone: string;
  };
  resolution: AnalyticsResolution;
  aggregation: AnalyticsAggregation;
  qualityFilter?: AnalyticsQualityFilter;
  include?: Array<"series" | "summary" | "provenance" | "quality">;
  maxPointsPerSeries?: number;
  requestId: string;
}

/** Lightweight scope used to discover the complete recorded analytics span before calendar comparison. */
export interface AnalyticsCoverageRequest {
  apiVersion: "1.0";
  dataMode: DataMode;
  scope: AnalyticsEntityScope;
  measurementIds: string[];
  requestId: string;
}

export type AnalyticsArchiveState = "not-configured" | "not-ready" | "merged" | "failed";

export interface AnalyticsCoverageSeries {
  entityId: string;
  entityLabel: string;
  measurementId: string;
  start: string;
  end: string;
}

export interface AnalyticsCoverageResponse {
  apiVersion: "1.0";
  requestId: string;
  dataMode: DataMode;
  /** Earliest and latest selected sample across every returned series. */
  range: { start: string | null; end: string | null };
  series: AnalyticsCoverageSeries[];
  /** False means an unavailable archive may contain older periods than those returned here. */
  complete: boolean;
  archiveState: AnalyticsArchiveState;
  generatedAt: string;
}

export interface AnalyticsProvenance {
  algorithmKey: string;
  algorithmVersion: string;
  generatedAt: string;
  inputStart: string;
  inputEnd: string;
  sourceIds: string[];
  archiveState: AnalyticsArchiveState;
}

export interface AnalyticsPoint {
  timestamp: string;
  value: number | null;
  minimum: number | null;
  maximum: number | null;
  sampleCount: number;
  coverage: number;
  qualityFlags: QualityFlag[];
}

export interface AnalyticsSummary {
  entityId: string;
  measurementId: string;
  canonicalUnit: string;
  count: number;
  coverage: number;
  minimum: number | null;
  maximum: number | null;
  mean: number | null;
  median: number | null;
  standardDeviation: number | null;
  medianAbsoluteDeviation: number | null;
  p05: number | null;
  p95: number | null;
}

export interface AnalyticsSeries {
  entityId: string;
  entityLabel: string;
  measurementId: string;
  canonicalUnit: string;
  truthClass: TruthClass;
  /** Raw means no aggregation was applied; all other values describe the bucket rollup. */
  aggregation: "raw" | Exclude<AnalyticsAggregation, "default">;
  resolution: Exclude<AnalyticsResolution, "auto">;
  points: AnalyticsPoint[];
  summary: AnalyticsSummary;
  provenance: AnalyticsProvenance;
}

export interface AnalyticsQueryQualitySummary {
  coverage: number;
  seriesCount: number;
  sampleCount: number;
  excludedSampleCount: number;
  includedQualities: AnalyticsSampleQuality[];
  lowCoverageSeries: number;
}

export interface AnalyticsWarning {
  code: string;
  message: string;
}

export interface AnalyticsQueryResponse {
  apiVersion: "1.0";
  requestId: string;
  dataMode: DataMode;
  resolvedRange: AnalyticsQueryRequest["range"];
  resolution: Exclude<AnalyticsResolution, "auto">;
  series: AnalyticsSeries[];
  summaries: AnalyticsSummary[];
  quality: AnalyticsQueryQualitySummary;
  provenance: AnalyticsProvenance[];
  warnings: AnalyticsWarning[];
  generatedAt: string;
  cache: { hit: false; keyVersion: "analytics-query-v1" };
}

export type AnalyticsFindingCategory = "sensor" | "outdoor-weather" | "electricity" | "opening";

export type AnalyticsFindingDirection = "higher" | "lower";

export type AnalyticsFindingStatistic = "mean" | "sum" | "delta" | "open-count";

export type AnalyticsFindingStrength = "notable" | "strong";

/** One like-for-like calendar window retained as auditable evidence for a daily finding. */
export interface AnalyticsFindingPeriodEvidence {
  key: string;
  year: number;
  start: string;
  end: string;
  value: number;
  sampleCount: number;
  /** Null for event streams whose continuous source uptime cannot be reconstructed. */
  coverage: number | null;
}

/**
 * A descriptive peer-period difference. It deliberately reports association,
 * not causality: no weather, occupancy, tariff, or equipment cause is inferred.
 */
export interface AnalyticsFinding {
  id: string;
  category: AnalyticsFindingCategory;
  subjectId: string;
  subjectLabel: string;
  metric: string;
  unit: string;
  statistic: AnalyticsFindingStatistic;
  direction: AnalyticsFindingDirection;
  strength: AnalyticsFindingStrength;
  current: AnalyticsFindingPeriodEvidence;
  baseline: AnalyticsFindingPeriodEvidence[];
  baselineMedian: number;
  absoluteDifference: number;
  percentDifference: number | null;
}

export interface DailyAnalyticsFindingsSnapshot {
  apiVersion: "1.0";
  houseId: string;
  dataMode: DataMode;
  periodKind: "month-to-date";
  /** Last fully completed date in the house timezone, formatted YYYY-MM-DD. */
  evaluatedThrough: string;
  algorithmVersion: string;
  generatedAt: string;
  findings: AnalyticsFinding[];
  warnings: Array<"archive-incomplete" | "source-truncated" | "scope-limited">;
}

export interface DailyAnalyticsFindingsStatus {
  state: "pending" | "ready" | "failed" | "stale-algorithm";
  lastAttemptAt: string | null;
  lastError: string | null;
  expectedAlgorithmVersion?: string;
  actualAlgorithmVersion?: string;
}

export interface DailyAnalyticsFindingsResponse {
  snapshot: DailyAnalyticsFindingsSnapshot | null;
  status: DailyAnalyticsFindingsStatus;
}
