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
export const SYSTEM_VERSION = "0.51.4" as const;

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
  /** 90% interval from past forecast errors at this horizon (widened beyond the 24-hour backtest). */
  low: number;
  high: number;
}

export const MEASUREMENT_FORECAST_ALGORITHM_VERSION = "measurement-forecast/v2" as const;

/** Forecasts that do not beat "no change" in their own backtest are withheld. */
export type MeasurementForecastStatus = "ready" | "no-skill" | "insufficient-history";

export type MeasurementForecastModel = "thermal-relaxation" | "daily-profile";

/** Rolling-origin backtest result at one forecast horizon. */
export interface MeasurementForecastHorizonSkill {
  hours: number;
  samples: number;
  maeModel: number;
  maePersistence: number;
  maeSameTimeYesterday: number | null;
  /** 1 − MAE(model) / MAE(baseline); above 0 beats the baseline. */
  skillVsPersistence: number | null;
  skillVsSameTimeYesterday: number | null;
  /** Half-width of the 90% interval, from past absolute errors at this horizon. */
  intervalHalfWidth: number;
  /** Share of held-out backtest values inside an interval calibrated on earlier origins. */
  intervalCoverage: number | null;
}

export interface MeasurementForecastEvaluation {
  algorithmVersion: typeof MEASUREMENT_FORECAST_ALGORITHM_VERSION;
  sensorId: string;
  metric: Metric;
  status: MeasurementForecastStatus;
  model: MeasurementForecastModel | null;
  computedAt: string;
  historyFrom: string | null;
  historyTo: string | null;
  origins: number;
  /**
   * Outdoor driver of a thermal forecast: the weather forecast, or the last
   * observation held when no forecast is available. Backtests use observed
   * outdoor temperatures, so their skill assumes a good weather forecast.
   */
  outdoorDriver: "weather-forecast" | "held-observation" | null;
  horizons: MeasurementForecastHorizonSkill[];
  skill6h: number | null;
  skill24h: number | null;
  coverage90: number | null;
}

export interface MeasurementSnapshotEntry {
  sensorId: string;
  measurements: Record<Metric, MeasurementSample>;
}

/** Minute resolutions are accepted from 1m through 1440m after runtime validation. */
export type AnalyticsResolution = "auto" | "raw" | "1h" | "1d" | `${number}m`;

export const ANALYTICS_AGGREGATIONS = [
  "default", "mean", "sum", "delta", "last", "time_weighted_mean", "min", "max",
] as const satisfies readonly ("default" | "min" | "max" | AggregationSemantic)[];
export type AnalyticsAggregation = (typeof ANALYTICS_AGGREGATIONS)[number];

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
  /** Energy used in this bucket, computed before aggregation; null means incomplete evidence. */
  consumptionKwh?: number | null;
  minimum: number | null;
  maximum: number | null;
  sampleCount: number;
  coverage: number;
  qualityFlags: QualityFlag[];
}

/**
 * How summary statistics were formed. Level series (time-weighted mean or
 * mean) use fixed-width base buckets in their own aggregation (the finest of
 * 1 minute, 15 minutes or 1 hour that keeps at most 10,000 per series), so
 * each base bucket stands for the same time and the statistics do not change
 * with the displayed resolution. Other aggregations summarize the displayed
 * points.
 */
export type AnalyticsSummaryBasis =
  | { statistics: "time-weighted-base" | "mean-base"; baseResolution: "1m" | "15m" | "1h" }
  | { statistics: "display-points" };

export interface AnalyticsSummary {
  entityId: string;
  measurementId: string;
  canonicalUnit: string;
  count: number;
  /**
   * Mean bucket coverage. Against the sensor's long-run reporting interval
   * when `coverageBasis` is "expected-interval"; otherwise relative to the
   * sample density of the window itself.
   */
  coverage: number;
  basis?: AnalyticsSummaryBasis;
  coverageBasis?: "expected-interval" | "window-density";
  /** The reporting interval coverage was measured against, when known. */
  expectedIntervalSeconds?: number | null;
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
  /** Whether this answer was served from the server's query cache. */
  cache: { hit: boolean; keyVersion: "analytics-query-v2" };
}

export type AnalyticsFindingCategory = "sensor" | "outdoor-weather" | "electricity" | "opening";

export type AnalyticsFindingDirection = "higher" | "lower";

export type AnalyticsFindingStatistic = "mean" | "sum" | "delta" | "open-count";

export type AnalyticsFindingStrength = "notable" | "strong";

/** What set the scale a difference was judged against. */
export type AnalyticsFindingSpreadBasis = "between-years" | "assumed" | "day-to-day" | "resolution" | "counts";

/** How a baseline was moved to the current period's weather before comparing. */
export interface AnalyticsFindingWeatherAdjustment {
  driver: "heating-degree-hours" | "outdoor-temperature";
  /** Outdoor temperature below which degree-hours accumulate. */
  baseTemperatureC?: number;
  /** Change per day (sums) or in the mean, per degree-hour per day or per °C, fitted on the baseline days. */
  slope: number;
  /** Mean daily degree-hours, or mean outdoor °C, in the current period. */
  currentDriver: number;
  baselineDriverMedian: number;
  /** The baseline median before the adjustment. */
  unadjustedBaselineMedian: number;
}

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
  /** A sum before it was scaled up for missing coverage. */
  unscaledValue?: number;
}

/**
 * A descriptive peer-period difference. Temperature and electricity baselines
 * can be moved to the current weather; beyond that it reports association, not
 * causality: no occupancy, tariff, or equipment cause is inferred.
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
  /** The difference in units of the baseline's spread (from v4). */
  zScore?: number;
  /** Benjamini–Hochberg adjusted p-value across every series tested in the same run (from v4). */
  qValue?: number;
  spreadBasis?: AnalyticsFindingSpreadBasis;
  weatherAdjustment?: AnalyticsFindingWeatherAdjustment;
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
  /** Series compared in this run, all counted by the false-discovery control (from v4). */
  seriesTested?: number;
  falseDiscoveryRate?: number;
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
