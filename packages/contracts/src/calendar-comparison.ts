import type {
  AnalyticsAggregation,
  AnalyticsArchiveState,
  AnalyticsQualityFilter,
  AnalyticsSeries,
  DataMode,
} from "./measurement-analytics.js";
import type {
  DerivedAnalyticsCompleteness,
  DerivedAnalyticsProvenance,
  DerivedAnalyticsWarning,
} from "./analytics-common.js";

export const CALENDAR_COMPARISON_ALGORITHM_VERSION = "calendar-comparison-v1.0.0";
export const CALENDAR_COMPARISON_UNITS = ["day", "week", "month", "year", "decade"] as const;
export type CalendarComparisonUnit = typeof CALENDAR_COMPARISON_UNITS[number];

export interface CalendarComparisonAnchor {
  month: number;
  day: number;
  week: number;
}

export interface CalendarComparisonRequest {
  apiVersion: "1.0";
  requestId: string;
  houseId: string;
  dataMode: DataMode;
  sensorIds: string[];
  measurementId: string;
  unit: CalendarComparisonUnit;
  anchor: CalendarComparisonAnchor;
  selectedPeriodKeys?: string[];
  aggregation: AnalyticsAggregation;
  qualityFilter: AnalyticsQualityFilter;
}

export interface CalendarComparisonPeriod {
  key: string;
  unit: CalendarComparisonUnit;
  start: string;
  end: string;
  naturalEnd: string;
  year: number;
  month: number | null;
  day: number | null;
  week: number | null;
  decade: number | null;
  partial: boolean;
}

export interface CalendarComparisonBucket {
  key: string;
  slot: string;
  order: number;
  index: number;
  start: string;
  end: string;
  partial: boolean;
}

export interface CalendarComparisonValue {
  value: number;
  minimum: number | null;
  maximum: number | null;
  sampleCount: number;
  coverage: number;
}

export interface CalendarComparisonPoint extends CalendarComparisonValue {
  bucket: CalendarComparisonBucket;
}

export interface CalendarComparisonSummary extends CalendarComparisonValue {
  bucketCount: number;
}

export interface CalendarComparisonSeries {
  id: string;
  sourceId: "combined" | string;
  sourceLabel: string;
  combination: "single" | "mean" | "sum";
  period: CalendarComparisonPeriod;
  aggregation: AnalyticsSeries["aggregation"];
  points: CalendarComparisonPoint[];
  summary: CalendarComparisonSummary | null;
}

export interface CalendarComparisonDelta {
  sourceId: "combined" | string;
  currentSeriesId: string;
  baselineSeriesId: string;
  commonCompletedBucketCount: number;
  difference: number | null;
}

export interface CalendarComparisonResponse {
  apiVersion: "1.0";
  requestId: string;
  houseId: string;
  dataMode: DataMode;
  measurementId: string;
  unit: CalendarComparisonUnit;
  anchor: CalendarComparisonAnchor;
  aggregation: AnalyticsAggregation;
  qualityFilter: AnalyticsQualityFilter;
  candidates: CalendarComparisonPeriod[];
  selectedPeriods: CalendarComparisonPeriod[];
  series: CalendarComparisonSeries[];
  comparisons: CalendarComparisonDelta[];
  archiveState: AnalyticsArchiveState;
  generatedAt: string;
  evaluatedAt: string;
  completeness: DerivedAnalyticsCompleteness;
  warnings: DerivedAnalyticsWarning[];
  provenance: DerivedAnalyticsProvenance;
}
