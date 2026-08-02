import type {
  AnalyticsAggregation,
  AnalyticsSeries,
} from "@climate-twin/contracts";

export const CALENDAR_COMPARISON_UNITS = ["day", "week", "month", "year", "decade"] as const;
export type CalendarComparisonUnit = typeof CALENDAR_COMPARISON_UNITS[number];

export interface CalendarComparisonAnchor {
  month: number;
  day: number;
  week: number;
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

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = formatterCache.get(timeZone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  if (formatterCache.size >= 32) formatterCache.delete(formatterCache.keys().next().value!);
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function zonedParts(timestamp: number, timeZone: string): [number, number, number, number, number, number] {
  const parts = zonedFormatter(timeZone).formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((item) => item.type === type)?.value);
  return [part("year"), part("month"), part("day"), part("hour"), part("minute"), part("second")];
}

function localDate(timestamp: number, timeZone: string): LocalDateParts {
  const [year, month, day] = zonedParts(timestamp, timeZone);
  return { year, month, day };
}

function validLocalDate(parts: LocalDateParts): boolean {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return date.getUTCFullYear() === parts.year && date.getUTCMonth() === parts.month - 1 && date.getUTCDate() === parts.day;
}

function addLocalDays(parts: LocalDateParts, days: number): LocalDateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Resolves the first real instant of a local calendar date, including rare midnight offset transitions. */
function localDateStart(parts: LocalDateParts, timeZone: string): number | null {
  if (!validLocalDate(parts)) return null;
  for (let minute = 0; minute <= 180; minute += 30) {
    const hour = Math.floor(minute / 60);
    const localMinute = minute % 60;
    const nominal = Date.UTC(parts.year, parts.month - 1, parts.day, hour, localMinute, 0);
    const offsets = new Set<number>();
    for (let deltaHours = -36; deltaHours <= 36; deltaHours += 6) {
      const probe = nominal + deltaHours * 3_600_000;
      const displayed = zonedParts(probe, timeZone);
      offsets.add(Date.UTC(displayed[0], displayed[1] - 1, displayed[2], displayed[3], displayed[4], displayed[5]) - probe);
    }
    const target = [parts.year, parts.month, parts.day, hour, localMinute, 0];
    const candidates = [...offsets].map((offset) => nominal - offset)
      .filter((candidate) => zonedParts(candidate, timeZone).every((value, index) => value === target[index]))
      .sort((left, right) => left - right);
    if (candidates[0] !== undefined) return candidates[0];
  }
  return null;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isoWeekStart(year: number, week: number): LocalDateParts | null {
  if (!Number.isInteger(week) || week < 1 || week > 53) return null;
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const weekday = januaryFourth.getUTCDay() || 7;
  const monday = new Date(Date.UTC(year, 0, 4 - weekday + 1 + (week - 1) * 7));
  const thursday = new Date(monday.getTime() + 3 * 86_400_000);
  if (thursday.getUTCFullYear() !== year) return null;
  return { year: monday.getUTCFullYear(), month: monday.getUTCMonth() + 1, day: monday.getUTCDate() };
}

function periodCandidate(
  unit: CalendarComparisonUnit,
  startDate: LocalDateParts,
  endDate: LocalDateParts,
  timeZone: string,
  metadata: Omit<CalendarComparisonPeriod, "start" | "end" | "naturalEnd" | "partial">,
  coverageStart: number,
  coverageEnd: number,
  now: number,
): CalendarComparisonPeriod | null {
  const start = localDateStart(startDate, timeZone);
  const naturalEnd = localDateStart(endDate, timeZone);
  if (start === null || naturalEnd === null || start >= naturalEnd || start >= now) return null;
  if (naturalEnd <= coverageStart || start > coverageEnd) return null;
  const end = Math.min(naturalEnd, now);
  if (end <= start) return null;
  return {
    ...metadata,
    unit,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    naturalEnd: new Date(naturalEnd).toISOString(),
    partial: end < naturalEnd,
  };
}

export function calendarComparisonPeriods(input: {
  unit: CalendarComparisonUnit;
  anchor: CalendarComparisonAnchor;
  coverageStart: string;
  coverageEnd: string;
  timeZone: string;
  now?: number;
}): CalendarComparisonPeriod[] {
  const coverageStart = Date.parse(input.coverageStart);
  const coverageEnd = Date.parse(input.coverageEnd);
  const now = input.now ?? Date.now();
  if (![coverageStart, coverageEnd, now].every(Number.isFinite) || coverageStart > coverageEnd) return [];
  const firstYear = localDate(coverageStart, input.timeZone).year;
  const lastYear = localDate(Math.min(coverageEnd, now), input.timeZone).year;
  const candidates: Array<CalendarComparisonPeriod | null> = [];

  if (input.unit === "day") {
    for (let year = firstYear; year <= lastYear; year += 1) {
      const start = { year, month: input.anchor.month, day: input.anchor.day };
      candidates.push(periodCandidate("day", start, addLocalDays(start, 1), input.timeZone, {
        key: `${year}-${pad2(input.anchor.month)}-${pad2(input.anchor.day)}`,
        unit: "day", year, month: input.anchor.month, day: input.anchor.day, week: null, decade: null,
      }, coverageStart, coverageEnd, now));
    }
  } else if (input.unit === "week") {
    for (let year = firstYear - 1; year <= lastYear + 1; year += 1) {
      const start = isoWeekStart(year, input.anchor.week);
      if (!start) continue;
      candidates.push(periodCandidate("week", start, addLocalDays(start, 7), input.timeZone, {
        key: `${year}-W${pad2(input.anchor.week)}`,
        unit: "week", year, month: null, day: null, week: input.anchor.week, decade: null,
      }, coverageStart, coverageEnd, now));
    }
  } else if (input.unit === "month") {
    for (let year = firstYear; year <= lastYear; year += 1) {
      const start = { year, month: input.anchor.month, day: 1 };
      const end = input.anchor.month === 12
        ? { year: year + 1, month: 1, day: 1 }
        : { year, month: input.anchor.month + 1, day: 1 };
      candidates.push(periodCandidate("month", start, end, input.timeZone, {
        key: `${year}-${pad2(input.anchor.month)}`,
        unit: "month", year, month: input.anchor.month, day: null, week: null, decade: null,
      }, coverageStart, coverageEnd, now));
    }
  } else if (input.unit === "year") {
    for (let year = firstYear; year <= lastYear; year += 1) {
      candidates.push(periodCandidate("year", { year, month: 1, day: 1 }, { year: year + 1, month: 1, day: 1 }, input.timeZone, {
        key: String(year), unit: "year", year, month: null, day: null, week: null, decade: null,
      }, coverageStart, coverageEnd, now));
    }
  } else {
    const firstDecade = Math.floor(firstYear / 10) * 10;
    const lastDecade = Math.floor(lastYear / 10) * 10;
    for (let decade = firstDecade; decade <= lastDecade; decade += 10) {
      candidates.push(periodCandidate("decade", { year: decade, month: 1, day: 1 }, { year: decade + 10, month: 1, day: 1 }, input.timeZone, {
        key: `${decade}s`, unit: "decade", year: decade, month: null, day: null, week: null, decade,
      }, coverageStart, coverageEnd, now));
    }
  }

  return candidates.filter((period): period is CalendarComparisonPeriod => period !== null)
    .sort((left, right) => left.start.localeCompare(right.start));
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

function comparisonBucket(
  period: CalendarComparisonPeriod,
  index: number,
  slot: string,
  order: number,
  start: number | null,
  end: number | null,
): CalendarComparisonBucket | null {
  const naturalEnd = Date.parse(period.naturalEnd);
  if (start === null || end === null || !Number.isFinite(naturalEnd) || start >= end || start >= naturalEnd) return null;
  const boundedEnd = Math.min(end, naturalEnd);
  const availableEnd = Date.parse(period.end);
  return {
    key: `${period.key}:${slot}`,
    slot,
    order,
    index,
    start: new Date(start).toISOString(),
    end: new Date(boundedEnd).toISOString(),
    partial: availableEnd > start && availableEnd < boundedEnd,
  };
}

/**
 * Divides one concrete period into aligned, house-local comparison buckets.
 * Month buckets are stable seven-day blocks (1-7, 8-14, 15-21, 22-28,
 * 29-end), which avoids mixing days from adjacent months.
 */
export function calendarComparisonBuckets(
  period: CalendarComparisonPeriod,
  timeZone: string,
): CalendarComparisonBucket[] {
  const periodStart = Date.parse(period.start);
  const naturalEnd = Date.parse(period.naturalEnd);
  if (!Number.isFinite(periodStart) || !Number.isFinite(naturalEnd) || periodStart >= naturalEnd) return [];
  const startDate = localDate(periodStart, timeZone);
  const buckets: Array<CalendarComparisonBucket | null> = [];

  if (period.unit === "day") {
    const occurrences = new Map<string, number>();
    let index = 0;
    for (let start = periodStart; start < naturalEnd; start += 3_600_000) {
      const end = Math.min(start + 3_600_000, naturalEnd);
      const parts = zonedParts(start, timeZone);
      const wallTime = `${pad2(parts[3])}:${pad2(parts[4])}`;
      const occurrence = occurrences.get(wallTime) ?? 0;
      occurrences.set(wallTime, occurrence + 1);
      buckets.push(comparisonBucket(
        period,
        index,
        `hour-${wallTime}-${occurrence}`,
        (parts[3] * 60 + parts[4]) * 10 + occurrence,
        start,
        end,
      ));
      index += 1;
    }
  } else if (period.unit === "week") {
    for (let index = 0; index < 7; index += 1) {
      buckets.push(comparisonBucket(
        period,
        index,
        `day-${index}`,
        index,
        localDateStart(addLocalDays(startDate, index), timeZone),
        localDateStart(addLocalDays(startDate, index + 1), timeZone),
      ));
    }
  } else if (period.unit === "month") {
    for (let index = 0; index < 5; index += 1) {
      buckets.push(comparisonBucket(
        period,
        index,
        `week-${index}`,
        index,
        localDateStart(addLocalDays(startDate, index * 7), timeZone),
        localDateStart(addLocalDays(startDate, (index + 1) * 7), timeZone),
      ));
    }
  } else if (period.unit === "year") {
    for (let index = 0; index < 12; index += 1) {
      const month = index + 1;
      const end = month === 12
        ? { year: period.year + 1, month: 1, day: 1 }
        : { year: period.year, month: month + 1, day: 1 };
      buckets.push(comparisonBucket(
        period,
        index,
        `month-${month}`,
        index,
        localDateStart({ year: period.year, month, day: 1 }, timeZone),
        localDateStart(end, timeZone),
      ));
    }
  } else {
    const decade = period.decade ?? period.year;
    for (let index = 0; index < 10; index += 1) {
      const year = decade + index;
      buckets.push(comparisonBucket(
        period,
        index,
        `year-${index}`,
        index,
        localDateStart({ year, month: 1, day: 1 }, timeZone),
        localDateStart({ year: year + 1, month: 1, day: 1 }, timeZone),
      ));
    }
  }

  return buckets.filter((bucket): bucket is CalendarComparisonBucket => bucket !== null);
}

type ResolvedAggregation = AnalyticsSeries["aggregation"];

export interface CalendarValueAccumulator {
  aggregation: ResolvedAggregation;
  total: number;
  weight: number;
  selected: number | null;
  selectedAt: number;
  minimum: number | null;
  maximum: number | null;
  sampleCount: number;
  coverageWeight: number;
  coverageDuration: number;
}

function resolutionSeconds(resolution: AnalyticsSeries["resolution"]): number {
  if (resolution === "raw") return 1;
  if (resolution === "1h") return 3_600;
  if (resolution === "1d") return 86_400;
  const minutes = Number(/^(\d{1,4})m$/u.exec(resolution)?.[1]);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1_440) {
    throw new RangeError("invalid analytics series resolution");
  }
  return minutes * 60;
}

export interface CalendarAnalyticsRangeSplit {
  middle: string;
  overlapStart: string;
  bucketMilliseconds: number;
}

/** Mirrors the API's automatic UTC bucket selection and splits only on a bucket boundary. */
export function splitCalendarAnalyticsRange(
  start: string,
  end: string,
  maxPoints: number,
): CalendarAnalyticsRangeSplit | null {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs || !Number.isInteger(maxPoints) || maxPoints < 1) {
    return null;
  }
  const duration = endMs - startMs;
  let bucketMilliseconds = 60_000;
  if (duration > maxPoints * bucketMilliseconds) {
    bucketMilliseconds = [300_000, 900_000, 3_600_000, 86_400_000]
      .find((candidate) => Math.ceil(duration / candidate) <= maxPoints) ?? 86_400_000;
  }
  const target = startMs + Math.floor(duration / 2);
  let middle = Math.floor(target / bucketMilliseconds) * bucketMilliseconds;
  if (middle <= startMs) middle += bucketMilliseconds;
  if (middle >= endMs) middle -= bucketMilliseconds;
  if (middle <= startMs || middle >= endMs) return null;
  return {
    middle: new Date(middle).toISOString(),
    overlapStart: new Date(Math.max(startMs, middle - bucketMilliseconds)).toISOString(),
    bucketMilliseconds,
  };
}

export function createCalendarValueAccumulator(aggregation: ResolvedAggregation): CalendarValueAccumulator {
  return {
    aggregation,
    total: 0,
    weight: 0,
    selected: null,
    selectedAt: Number.NEGATIVE_INFINITY,
    minimum: null,
    maximum: null,
    sampleCount: 0,
    coverageWeight: 0,
    coverageDuration: 0,
  };
}

export function appendAnalyticsSeries(
  accumulator: CalendarValueAccumulator,
  series: AnalyticsSeries,
  range?: { start: string; end: string },
): CalendarValueAccumulator {
  const duration = resolutionSeconds(series.resolution);
  const rangeStart = range ? Date.parse(range.start) : Number.NEGATIVE_INFINITY;
  const rangeEnd = range ? Date.parse(range.end) : Number.POSITIVE_INFINITY;
  for (const point of series.points) {
    const pointStart = Date.parse(point.timestamp);
    const pointEnd = pointStart + duration * 1_000;
    const overlapDuration = Math.max(0, Math.min(pointEnd, rangeEnd) - Math.max(pointStart, rangeStart)) / 1_000;
    if (overlapDuration <= 0) continue;
    const adjustedCoverage = Math.min(1, point.coverage * duration / overlapDuration);
    accumulator.sampleCount += point.sampleCount;
    accumulator.coverageWeight += adjustedCoverage * overlapDuration;
    accumulator.coverageDuration += overlapDuration;
    if (point.minimum !== null) accumulator.minimum = accumulator.minimum === null ? point.minimum : Math.min(accumulator.minimum, point.minimum);
    if (point.maximum !== null) accumulator.maximum = accumulator.maximum === null ? point.maximum : Math.max(accumulator.maximum, point.maximum);
    if (point.value === null) continue;
    const aggregation = series.aggregation === "raw" ? "mean" : series.aggregation;
    if (aggregation === "sum" || aggregation === "delta") {
      accumulator.total += point.value;
      accumulator.weight = 1;
    } else if (aggregation === "last") {
      const timestamp = Date.parse(point.timestamp);
      if (timestamp >= accumulator.selectedAt) {
        accumulator.selected = point.value;
        accumulator.selectedAt = timestamp;
      }
    } else if (aggregation === "min") {
      accumulator.selected = accumulator.selected === null ? point.value : Math.min(accumulator.selected, point.value);
    } else if (aggregation === "max") {
      accumulator.selected = accumulator.selected === null ? point.value : Math.max(accumulator.selected, point.value);
    } else {
      const observedDuration = overlapDuration * Math.max(adjustedCoverage, Number.EPSILON);
      accumulator.total += point.value * observedDuration;
      accumulator.weight += observedDuration;
    }
  }
  return accumulator;
}

export interface CalendarComparisonValue {
  value: number;
  minimum: number | null;
  maximum: number | null;
  sampleCount: number;
  coverage: number;
}

export function calendarAccumulatorValue(accumulator: CalendarValueAccumulator): CalendarComparisonValue | null {
  const aggregation = accumulator.aggregation === "raw" ? "mean" : accumulator.aggregation;
  const value = aggregation === "last" || aggregation === "min" || aggregation === "max"
    ? accumulator.selected
    : accumulator.weight > 0 ? accumulator.total / (aggregation === "sum" || aggregation === "delta" ? 1 : accumulator.weight) : null;
  if (value === null || !Number.isFinite(value)) return null;
  return {
    value,
    minimum: accumulator.minimum,
    maximum: accumulator.maximum,
    sampleCount: accumulator.sampleCount,
    coverage: accumulator.coverageDuration > 0 ? accumulator.coverageWeight / accumulator.coverageDuration : 0,
  };
}

export function comparisonAggregationOptions(kind: string | undefined): AnalyticsAggregation[] {
  if (kind === "rate") return ["default", "time_weighted_mean", "mean", "last", "min", "max"];
  if (kind === "increment") return ["default", "sum", "last", "min", "max"];
  if (kind === "cumulative_counter") return ["default", "delta", "last", "min", "max"];
  if (kind === "binary_state") return ["default", "last", "mean"];
  if (kind === "categorical_state") return ["default", "last"];
  return ["default", "mean", "last", "min", "max"];
}
