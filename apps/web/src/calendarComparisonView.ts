import type {
  AnalyticsSeries,
  MeasurementDefinition,
  Sensor,
} from "@climate-twin/contracts";
import {
  calendarAccumulatorValue,
  type CalendarComparisonBucket,
  type CalendarComparisonPeriod,
  type CalendarComparisonValue,
  type CalendarValueAccumulator,
} from "./calendarComparison";

export interface LoadedCalendarComparison {
  periods: CalendarComparisonPeriod[];
  buckets: Map<string, CalendarComparisonBucket[]>;
  values: Map<string, Map<string, Map<string, CalendarValueAccumulator>>>;
  complete: boolean;
  archiveState: string;
}

export type CalendarComparisonSource = "combined" | string;

export interface CalendarChartPoint extends CalendarComparisonValue {
  period: CalendarComparisonPeriod;
  bucket: CalendarComparisonBucket;
  aggregation: AnalyticsSeries["aggregation"];
}

export interface CalendarPeriodSeries {
  id: string;
  period: CalendarComparisonPeriod;
  points: CalendarChartPoint[];
}

export interface CalendarSeriesSummary extends CalendarComparisonValue {
  bucketCount: number;
}

export function combinedCalendarMode(definition: MeasurementDefinition): "mean" | "sum" {
  return definition.id === "power" || definition.id === "energy"
    || definition.kind === "increment" || definition.kind === "cumulative_counter"
    ? "sum"
    : "mean";
}

function bucketValue(
  loaded: LoadedCalendarComparison,
  period: CalendarComparisonPeriod,
  bucket: CalendarComparisonBucket,
  sensors: Sensor[],
  source: CalendarComparisonSource,
  definition: MeasurementDefinition,
): CalendarChartPoint | null {
  const bySensor = loaded.values.get(period.key)?.get(bucket.key);
  if (!bySensor) return null;
  if (source !== "combined") {
    const accumulator = bySensor.get(source);
    const value = accumulator ? calendarAccumulatorValue(accumulator) : null;
    return value ? { period, bucket, aggregation: accumulator!.aggregation, ...value } : null;
  }

  const values = sensors.flatMap((sensor) => {
    const accumulator = bySensor.get(sensor.id);
    const value = accumulator ? calendarAccumulatorValue(accumulator) : null;
    return accumulator && value ? [{ accumulator, value }] : [];
  });
  // Keep an identical sensor population in every displayed aggregate bucket.
  if (values.length !== sensors.length || values.length === 0) return null;
  const mode = combinedCalendarMode(definition);
  const divisor = mode === "mean" ? values.length : 1;
  return {
    period,
    bucket,
    aggregation: values[0]!.accumulator.aggregation,
    value: values.reduce((sum, item) => sum + item.value.value, 0) / divisor,
    minimum: Math.min(...values.map((item) => item.value.minimum ?? item.value.value)),
    maximum: Math.max(...values.map((item) => item.value.maximum ?? item.value.value)),
    sampleCount: values.reduce((sum, item) => sum + item.value.sampleCount, 0),
    coverage: values.reduce((sum, item) => sum + item.value.coverage, 0) / values.length,
  };
}

export function calendarPeriodSeries(
  loaded: LoadedCalendarComparison | null,
  sensors: Sensor[],
  source: CalendarComparisonSource,
  definition: MeasurementDefinition,
): CalendarPeriodSeries[] {
  if (!loaded) return [];
  return loaded.periods.map((period) => ({
    id: period.key,
    period,
    points: (loaded.buckets.get(period.key) ?? []).flatMap((bucket) => {
      const point = bucketValue(loaded, period, bucket, sensors, source, definition);
      return point ? [point] : [];
    }),
  }));
}

export function commonCompletedCalendarSlots(series: CalendarPeriodSeries[]): Set<string> {
  if (series.length === 0) return new Set();
  const completed = series.map((item) => new Set(item.points.flatMap((point) => (
    !point.bucket.partial && Date.parse(point.bucket.end) <= Date.parse(item.period.end)
      ? [point.bucket.slot]
      : []
  ))));
  return new Set([...completed[0]!].filter((slot) => completed.every((slots) => slots.has(slot))));
}

export function summarizeCalendarSeries(
  series: CalendarPeriodSeries,
  slots?: ReadonlySet<string>,
): CalendarSeriesSummary | null {
  const points = series.points.filter((point) => !slots || slots.has(point.bucket.slot));
  if (points.length === 0) return null;
  const aggregation = points[0]!.aggregation === "raw" ? "mean" : points[0]!.aggregation;
  let value: number | null = null;
  if (aggregation === "sum" || aggregation === "delta") {
    value = points.reduce((sum, point) => sum + point.value, 0);
  } else if (aggregation === "last") {
    value = [...points].sort((left, right) => left.bucket.end.localeCompare(right.bucket.end)).at(-1)!.value;
  } else if (aggregation === "min") {
    value = Math.min(...points.map((point) => point.value));
  } else if (aggregation === "max") {
    value = Math.max(...points.map((point) => point.value));
  } else {
    const weighted = points.map((point) => ({
      point,
      weight: Math.max(0, Date.parse(point.bucket.end) - Date.parse(point.bucket.start)) * point.coverage,
    }));
    const weight = weighted.reduce((sum, item) => sum + item.weight, 0);
    value = weight > 0
      ? weighted.reduce((sum, item) => sum + item.point.value * item.weight, 0) / weight
      : null;
  }
  if (value === null || !Number.isFinite(value)) return null;
  const duration = points.reduce(
    (sum, point) => sum + Math.max(0, Date.parse(point.bucket.end) - Date.parse(point.bucket.start)),
    0,
  );
  const coveredDuration = points.reduce(
    (sum, point) => sum + Math.max(0, Date.parse(point.bucket.end) - Date.parse(point.bucket.start)) * point.coverage,
    0,
  );
  return {
    value,
    minimum: Math.min(...points.map((point) => point.minimum ?? point.value)),
    maximum: Math.max(...points.map((point) => point.maximum ?? point.value)),
    sampleCount: points.reduce((sum, point) => sum + point.sampleCount, 0),
    coverage: duration > 0 ? coveredDuration / duration : 0,
    bucketCount: points.length,
  };
}
