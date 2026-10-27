import { createHash } from "node:crypto";
import type {
  AnalyticsFinding,
  AnalyticsFindingPeriodEvidence,
  AnalyticsFindingStatistic,
  AnalyticsSeries,
  MeasurementDefinition,
} from "@climate-twin/contracts";
import {
  addLocalDays,
  daysInMonth,
  localDate,
  localDateStart,
  maximum,
  median as kernelMedian,
  minimum,
  type LocalDateParts,
} from "@climate-twin/analytics-kernel";
import {
  peerCountTest,
  peerLevelTest,
  type DailyLevel,
  type HourlyWeather,
  type PeriodObservation,
  type WeatherDriver,
} from "./peer-statistics.js";
import {
  ClimateDatabase,
} from "../db.js";
import {
  HybridTelemetryReader,
  IncompleteTelemetryHistoryError,
} from "../timeseries/read-facade.js";

export const DAILY_ANALYTICS_ALGORITHM_VERSION = "calendar-peer-findings-v4.0.0";

const DAY_MS = 86_400_000;
/** Edge days shorter than this say little about a whole day's level. */
const MIN_DAY_MS = 20 * 3_600_000;

export const HISTORY_LIMIT = 100_000;

export const BASELINE_YEARS = 5;

export const MAX_MEASUREMENT_SERIES = 80;

export const MAX_FINDINGS = 16;

export const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;

export const DEFAULT_STARTUP_JITTER_MS = 30_000;

export type { LocalDateParts };

export interface PeerPeriod {
  key: string;
  year: number;
  start: string;
  end: string;
}

export interface FindingPeriods {
  evaluatedThrough: string;
  current: PeerPeriod;
  baseline: PeerPeriod[];
}

export interface PeriodValue {
  value: number;
  sampleCount: number;
  coverage: number | null;
  statistic: AnalyticsFindingStatistic;
  /** Daily levels for the spread and weather estimates; absent for event counts. */
  daily?: DailyLevel[];
  /** A sum before it was scaled up for missing coverage. */
  unscaledValue?: number;
}

export interface RankedFinding {
  finding: AnalyticsFinding;
  score: number;
}

/** A compared series: it always counts towards the false-discovery control, even when too small to report. */
export interface TestedComparison {
  pValue: number;
  ranked: RankedFinding | null;
}

export interface ComparisonWeather {
  driver: WeatherDriver;
  baseTemperatureC: number;
  /** Hourly outdoor means by period key. */
  hourly: ReadonlyMap<string, HourlyWeather>;
}

export interface DailyAnalyticsFindingsRunSummary {
  startedAt: string;
  completedAt: string;
  houses: number;
  generated: number;
  skipped: number;
  failed: number;
  findings: number;
  lastError: string | null;
}

export interface DailyAnalyticsFindingsWorkerStatus {
  started: boolean;
  running: boolean;
  nextRunAt: string | null;
  lastRun: DailyAnalyticsFindingsRunSummary | null;
}

export interface DailyAnalyticsFindingsWorkerOptions {
  database: ClimateDatabase;
  telemetryReader: HybridTelemetryReader;
  intervalMs?: number;
  startupJitterMs?: number;
  now?: () => number;
  random?: () => number;
}

export { addLocalDays, daysInMonth, localDate, localDateStart, validLocalDate, zonedParts } from "@climate-twin/analytics-kernel";

export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Builds fair month-to-date windows ending at the last completed local date. */
export function dailyFindingPeriods(now: number, timeZone: string): FindingPeriods {
  const today = localDate(now, timeZone);
  const through = addLocalDays(today, -1);
  const currentStart = localDateStart({ year: through.year, month: through.month, day: 1 }, timeZone);
  const currentEnd = localDateStart(addLocalDays(through, 1), timeZone);
  if (currentStart === null || currentEnd === null) throw new Error(`Could not resolve calendar boundaries for ${timeZone}`);
  const period = (year: number): PeerPeriod => {
    const lastDay = Math.min(through.day, daysInMonth(year, through.month));
    const start = localDateStart({ year, month: through.month, day: 1 }, timeZone);
    const end = localDateStart(addLocalDays({ year, month: through.month, day: lastDay }, 1), timeZone);
    if (start === null || end === null) throw new Error(`Could not resolve peer calendar boundaries for ${timeZone}`);
    return {
      key: `${year}-${pad2(through.month)}`,
      year,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    };
  };
  return {
    evaluatedThrough: `${through.year}-${pad2(through.month)}-${pad2(through.day)}`,
    current: {
      key: `${through.year}-${pad2(through.month)}`,
      year: through.year,
      start: new Date(currentStart).toISOString(),
      end: new Date(currentEnd).toISOString(),
    },
    baseline: Array.from({ length: BASELINE_YEARS }, (_, index) => period(through.year - index - 1)),
  };
}

/** Baseline medians are taken over non-empty peer sets; an empty set has none. */
export const median = (values: readonly number[]): number => kernelMedian(values) ?? Number.NaN;

export function rounded(value: number, precision = 6): number {
  return Number(value.toFixed(precision));
}

export function periodEvidence(period: PeerPeriod, value: PeriodValue): AnalyticsFindingPeriodEvidence {
  return {
    ...period,
    value: rounded(value.value),
    sampleCount: value.sampleCount,
    coverage: value.coverage === null ? null : rounded(Math.max(0, Math.min(1, value.coverage))),
    ...(value.unscaledValue === undefined ? {} : { unscaledValue: rounded(value.unscaledValue) }),
  };
}

/** Daily buckets clipped to the period, as levels: means and deltas as they are, sums scaled by their coverage. */
function dailyLevels(
  points: AnalyticsSeries["points"],
  statistic: AnalyticsFindingStatistic,
  window: Pick<PeerPeriod, "start" | "end">,
): DailyLevel[] {
  const periodStart = Date.parse(window.start);
  const periodEnd = Date.parse(window.end);
  return points.flatMap((point) => {
    const bucket = Date.parse(point.timestamp);
    const start = Math.max(bucket, periodStart);
    const end = Math.min(bucket + DAY_MS, periodEnd);
    if (point.value === null || end - start < MIN_DAY_MS || point.coverage < 0.5) return [];
    return [{ start, end, level: statistic === "sum" ? point.value / Math.min(1, point.coverage) : point.value }];
  });
}

/** `window` is the period of a one-day-resolution series; with it, daily levels are kept. */
export function aggregateAnalyticsSeries(series: AnalyticsSeries, window?: Pick<PeerPeriod, "start" | "end">): PeriodValue | null {
  const points = series.points.filter((point) => point.value !== null);
  if (points.length === 0) return null;
  const aggregation = series.aggregation === "raw" ? "mean" : series.aggregation;
  let value: number;
  if (aggregation === "sum" || aggregation === "delta") {
    value = points.reduce((total, point) => total + point.value!, 0);
  } else if (aggregation === "last") {
    value = points.at(-1)!.value!;
  } else if (aggregation === "min") {
    value = minimum(points.map((point) => point.value!))!;
  } else if (aggregation === "max") {
    value = maximum(points.map((point) => point.value!))!;
  } else {
    const weights = points.map((point) => Math.max(point.coverage, Number.EPSILON));
    const weight = weights.reduce((total, item) => total + item, 0);
    value = points.reduce((total, point, index) => total + point.value! * weights[index]!, 0) / weight;
  }
  const sampleCount = points.reduce((total, point) => total + point.sampleCount, 0);
  const coverage = series.points.length === 0
    ? 0
    : series.points.reduce((total, point) => total + point.coverage, 0) / series.points.length;
  const statistic: AnalyticsFindingStatistic = aggregation === "sum" ? "sum" : aggregation === "delta" ? "delta" : "mean";
  // Power integrated into energy loses whatever a gap hides; a counter's delta catches up when readings resume.
  const scale = statistic === "sum" && coverage > 0 && coverage < 1 ? 1 / coverage : 1;
  return {
    value: value * scale,
    ...(scale === 1 ? {} : { unscaledValue: value }),
    sampleCount,
    coverage,
    statistic,
    ...(window ? { daily: dailyLevels(series.points, statistic, window) } : {}),
  };
}

export function usable(value: PeriodValue | null): value is PeriodValue {
  if (!value || !Number.isFinite(value.value) || value.coverage === null || value.coverage < 0.5) return false;
  return value.statistic === "sum" ? value.sampleCount >= 1 : value.sampleCount >= 2;
}

export function electricityDefinition(definition: MeasurementDefinition): boolean {
  const dimension = (definition.dimension ?? "").toLowerCase();
  const id = definition.id.toLowerCase();
  return dimension === "power" || dimension === "energy"
    || id === "power" || id === "energy"
    || /(?:electric|power|energy|consumption)/u.test(id);
}

/** The smallest difference from `baseline` that `threshold` calls notable. */
export function notableDifference(input: {
  category: AnalyticsFinding["category"];
  metric: string;
  definition?: MeasurementDefinition;
  baseline: number;
}): number {
  const metric = input.metric.toLowerCase();
  if (input.category === "opening") return 3;
  if (metric.includes("temperature")) return 1;
  if (metric.includes("humidity")) return 5;
  if (metric === "co2" || metric.includes("carbon")) return 100;
  const relative = Math.abs(input.baseline);
  if (input.category === "electricity") {
    const unit = input.definition?.unit.toLowerCase() ?? "";
    const minimum = unit.includes("kwh") ? 0.5 : unit === "w" || unit.includes("watt") ? 50 : 10 ** -(input.definition?.precision ?? 1);
    return Math.max(minimum, relative * 0.1);
  }
  const minimum = Math.max(input.definition?.interpolationDelta ?? 0, 10 ** -(input.definition?.precision ?? 1));
  return Math.max(minimum, relative * 0.2);
}

export function threshold(input: {
  category: AnalyticsFinding["category"];
  metric: string;
  definition?: MeasurementDefinition;
  baseline: number;
  difference: number;
}): { notable: boolean; strong: boolean; score: number } {
  const absolute = Math.abs(input.difference);
  const relative = Math.abs(input.baseline) < 1e-9 ? null : absolute / Math.abs(input.baseline);
  const metric = input.metric.toLowerCase();
  if (input.category === "opening") {
    return { notable: absolute >= 3, strong: absolute >= 10, score: absolute / 3 };
  }
  if (metric.includes("temperature")) {
    return { notable: absolute >= 1, strong: absolute >= 2, score: absolute };
  }
  if (metric.includes("humidity")) {
    return { notable: absolute >= 5, strong: absolute >= 10, score: absolute / 5 };
  }
  if (metric === "co2" || metric.includes("carbon")) {
    return { notable: absolute >= 100, strong: absolute >= 250, score: absolute / 100 };
  }
  if (input.category === "electricity") {
    const unit = input.definition?.unit.toLowerCase() ?? "";
    const minimum = unit.includes("kwh") ? 0.5 : unit === "w" || unit.includes("watt") ? 50 : 10 ** -(input.definition?.precision ?? 1);
    const notable = absolute >= minimum && (relative === null || relative >= 0.1);
    return { notable, strong: notable && (relative === null ? absolute >= minimum * 3 : relative >= 0.25), score: relative ?? absolute / minimum };
  }
  const minimum = Math.max(input.definition?.interpolationDelta ?? 0, 10 ** -(input.definition?.precision ?? 1));
  const notable = absolute >= minimum && (relative === null || relative >= 0.2);
  return { notable, strong: notable && (relative === null ? absolute >= minimum * 3 : relative >= 0.4), score: relative ?? absolute / minimum };
}

export function findingId(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);
}

/** Half the smallest step a definition's precision can show, the least spread a difference is judged against. */
export function measurementResolution(definition?: MeasurementDefinition): number {
  return 0.5 * 10 ** -(definition?.precision ?? 1);
}

export function comparisonFinding(input: {
  category: AnalyticsFinding["category"];
  subjectId: string;
  subjectLabel: string;
  metric: string;
  unit: string;
  definition?: MeasurementDefinition;
  currentPeriod: PeerPeriod;
  current: PeriodValue;
  baselinePeriods: PeerPeriod[];
  baseline: PeriodValue[];
  weather?: ComparisonWeather | null;
}): TestedComparison | null {
  // Sums and deltas compare as totals per day, so a leap day does not count as a difference.
  const perDay = input.current.statistic === "sum" || input.current.statistic === "delta";
  const days = (period: PeerPeriod) => (perDay ? (Date.parse(period.end) - Date.parse(period.start)) / DAY_MS : 1);
  const observation = (period: PeerPeriod, value: PeriodValue): PeriodObservation => ({
    start: Date.parse(period.start),
    end: Date.parse(period.end),
    level: value.value / days(period),
    daily: value.daily ?? [],
    weather: input.weather?.hourly.get(period.key) ?? null,
  });
  const test = input.current.statistic === "open-count"
    ? peerCountTest(input.current.value, input.baseline.map((item) => item.value))
    : peerLevelTest({
        current: observation(input.currentPeriod, input.current),
        baseline: input.baseline.map((value, index) => observation(input.baselinePeriods[index]!, value)),
        resolution: measurementResolution(input.definition),
        // Before enough years are seen, assume they vary by half a notable difference.
        assumedYearSpread: notableDifference({
          category: input.category,
          metric: input.metric,
          ...(input.definition ? { definition: input.definition } : {}),
          baseline: median(input.baseline.map((item) => item.value)),
        }) / 2 / days(input.currentPeriod),
        adjustFor: input.weather ? { driver: input.weather.driver, baseTemperatureC: input.weather.baseTemperatureC } : null,
      });
  if (!test) return null;
  const baselineMedian = median(test.baselineLevels.map((level, index) => level * days(input.baselinePeriods[index]!)));
  const difference = input.current.value - baselineMedian;
  const significance = threshold({
    category: input.category,
    metric: input.metric,
    ...(input.definition ? { definition: input.definition } : {}),
    baseline: baselineMedian,
    difference,
  });
  if (Math.abs(difference) < 1e-12 || !significance.notable) return { pValue: test.pValue, ranked: null };
  const baselineEvidence = input.baseline.map((value, index) => periodEvidence(input.baselinePeriods[index]!, value));
  const weather = test.weather;
  return {
    pValue: test.pValue,
    ranked: {
      score: significance.score + (significance.strong ? 1 : 0),
      finding: {
        id: findingId([input.category, input.subjectId, input.metric, input.currentPeriod.key]),
        category: input.category,
        subjectId: input.subjectId,
        subjectLabel: input.subjectLabel,
        metric: input.metric,
        unit: input.unit,
        statistic: input.current.statistic,
        direction: difference > 0 ? "higher" : "lower",
        strength: significance.strong ? "strong" : "notable",
        current: periodEvidence(input.currentPeriod, input.current),
        baseline: baselineEvidence,
        baselineMedian: rounded(baselineMedian),
        absoluteDifference: rounded(Math.abs(difference)),
        percentDifference: Math.abs(baselineMedian) < 1e-9 ? null : rounded(Math.abs(difference / baselineMedian) * 100, 3),
        zScore: rounded(test.zScore, 3),
        spreadBasis: test.spreadBasis,
        ...(weather ? {
          weatherAdjustment: {
            driver: weather.driver,
            ...(weather.baseTemperatureC === undefined ? {} : { baseTemperatureC: weather.baseTemperatureC }),
            slope: rounded(weather.slope),
            currentDriver: rounded(weather.currentDriver, 3),
            baselineDriverMedian: rounded(median(weather.baselineDrivers), 3),
            unadjustedBaselineMedian: rounded(median(input.baseline.map((item) => item.value))),
          },
        } : {}),
      },
    },
  };
}

export const OUTDOOR_TEMPERATURE_DEFINITION: MeasurementDefinition = {
  id: "outdoor_temperature",
  labels: { en: "Outdoor temperature" },
  unit: "°C",
  dimension: "temperature",
  allowedUnits: ["°C"],
  kind: "gauge",
  defaultAggregation: "mean",
  genericHistoryEnabled: true,
  genericStatsEnabled: true,
  precision: 1,
  validMin: -100,
  validMax: 100,
  displayMin: -30,
  displayMax: 40,
  interpolationDelta: 0.5,
  colorScale: "thermal",
  builtin: false,
  enabled: true,
  spatialInterpolation: false,
  forecastSupported: false,
};

export function errorMessage(error: unknown): string {
  if (error instanceof IncompleteTelemetryHistoryError) return "Historical telemetry is temporarily unavailable";
  if (error instanceof Error && error.message.startsWith("Could not resolve")) return error.message;
  return "One or more analytics sources could not be processed";
}
