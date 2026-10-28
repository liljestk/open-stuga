import { HttpError } from "../../http-error.js";
import { maximum, minimum } from "@climate-twin/analytics-kernel";
import type { AnalyticsQueryRequest, AnalyticsQueryResponse, AnalyticsSeries, CalendarComparisonPeriod, CalendarComparisonPoint, CalendarComparisonRequest, CalendarComparisonResponse, CalendarComparisonSeries, CalendarComparisonSummary, CalendarComparisonValue, House, MeasurementDefinition, Sensor } from "@climate-twin/contracts";
import { CALENDAR_COMPARISON_ALGORITHM_VERSION, withSignal } from "@climate-twin/contracts";
import type { HybridTelemetryReader } from "../../timeseries/read-facade.js";
import { IncompleteTelemetryHistoryError } from "../../timeseries/read-facade.js";
import { AnalyticsQueryError } from "../query/analytics-query.js";
import { resolveAnalyticsAggregation } from "../query/analytics-query.js";
import { executeAnalyticsQuery } from "../query/execute.js";
import { appendAnalyticsSeries, calendarAccumulatorValue, calendarComparisonBuckets, calendarComparisonPeriods, createCalendarValueAccumulator, type CalendarValueAccumulator } from "./model.js";
import { compareCodeUnits } from "../../text-order.js";

const resolutionByUnit = {
  day: "1m",
  week: "5m",
  month: "15m",
  year: "1h",
  decade: "1d",
} as const;

const resolutionMilliseconds = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
} as const;

export const MAX_CALENDAR_COMPARISON_RESPONSE_BYTES = 1_000_000;

export class CalendarComparisonSelectionError extends HttpError {
  constructor(message: string) {
    super(422, "CALENDAR_COMPARISON_PERIOD_NOT_AVAILABLE", message);
    this.name = "CalendarComparisonSelectionError";
  }
}

export interface CalendarComparisonServiceInput {
  request: CalendarComparisonRequest;
  house: House;
  sensors: readonly Sensor[];
  definition: MeasurementDefinition;
  telemetryReader: HybridTelemetryReader;
  evaluatedAt: string;
  signal?: AbortSignal;
}

function combinedMode(definition: MeasurementDefinition): "mean" | "sum" {
  return definition.id === "power"
    || definition.id === "energy"
    || definition.kind === "increment"
    || definition.kind === "cumulative_counter"
    ? "sum"
    : "mean";
}

function queryStart(
  period: CalendarComparisonPeriod,
  request: CalendarComparisonRequest,
): string {
  const counter = request.aggregation === "delta"
    || request.aggregation === "default";
  if (!counter) return period.start;
  return new Date(
    Date.parse(period.start) - resolutionMilliseconds[resolutionByUnit[request.unit]],
  ).toISOString();
}

function analyticsRequest(
  input: CalendarComparisonServiceInput,
  period: CalendarComparisonPeriod,
): AnalyticsQueryRequest {
  return {
    apiVersion: "1.0",
    requestId: `${input.request.requestId}:${period.key}`,
    dataMode: input.request.dataMode,
    scope: {
      kind: "house",
      id: input.house.id,
      entityIds: input.sensors.map((sensor) => sensor.id),
    },
    measurementIds: [input.definition.id],
    range: {
      start: input.definition.kind === "cumulative_counter"
        ? queryStart(period, input.request)
        : period.start,
      end: period.end,
      timezone: input.house.timezone,
    },
    resolution: resolutionByUnit[input.request.unit],
    aggregation: input.request.aggregation,
    qualityFilter: input.request.qualityFilter,
    include: ["series", "quality", "provenance"],
    maxPointsPerSeries: 10_000,
  };
}

function periodValues(
  period: CalendarComparisonPeriod,
  timeZone: string,
  response: AnalyticsQueryResponse,
): {
  buckets: ReturnType<typeof calendarComparisonBuckets>;
  values: Map<string, Map<string, CalendarValueAccumulator>>;
} {
  const buckets = calendarComparisonBuckets(period, timeZone);
  const values = new Map<string, Map<string, CalendarValueAccumulator>>();
  for (const bucket of buckets) {
    const effectiveEnd = new Date(
      Math.min(Date.parse(bucket.end), Date.parse(period.end)),
    ).toISOString();
    if (bucket.start >= effectiveEnd) continue;
    const bySensor = new Map<string, CalendarValueAccumulator>();
    for (const series of response.series) {
      const accumulator = createCalendarValueAccumulator(series.aggregation);
      appendAnalyticsSeries(accumulator, series, {
        start: bucket.start,
        end: effectiveEnd,
      });
      bySensor.set(series.entityId, accumulator);
    }
    values.set(bucket.key, bySensor);
  }
  return { buckets, values };
}

function pointFor(
  bucket: ReturnType<typeof calendarComparisonBuckets>[number],
  accumulator: CalendarValueAccumulator | undefined,
): CalendarComparisonPoint | null {
  const value = accumulator ? calendarAccumulatorValue(accumulator) : null;
  return value ? { bucket, ...value } : null;
}

function combinedPoint(
  bucket: ReturnType<typeof calendarComparisonBuckets>[number],
  values: readonly CalendarComparisonValue[],
  mode: "mean" | "sum",
): CalendarComparisonPoint | null {
  if (values.length === 0) return null;
  const divisor = mode === "mean" ? values.length : 1;
  return {
    bucket,
    value: values.reduce((sum, item) => sum + item.value, 0) / divisor,
    minimum: (minimum(values.map((item) => item.minimum ?? item.value)) ?? Number.POSITIVE_INFINITY),
    maximum: (maximum(values.map((item) => item.maximum ?? item.value)) ?? Number.NEGATIVE_INFINITY),
    sampleCount: values.reduce((sum, item) => sum + item.sampleCount, 0),
    coverage: values.reduce((sum, item) => sum + item.coverage, 0) / values.length,
  };
}

function summarize(
  points: readonly CalendarComparisonPoint[],
  aggregation: AnalyticsSeries["aggregation"],
): CalendarComparisonSummary | null {
  if (points.length === 0) return null;
  const resolved = aggregation === "raw" ? "mean" : aggregation;
  let value: number | null;
  if (resolved === "sum" || resolved === "delta") {
    value = points.reduce((sum, point) => sum + point.value, 0);
  } else if (resolved === "last") {
    value = [...points].sort((left, right) => (
      left.bucket.end.localeCompare(right.bucket.end)
    )).at(-1)!.value;
  } else if (resolved === "min") {
    value = (minimum(points.map((point) => point.value)) ?? Number.POSITIVE_INFINITY);
  } else if (resolved === "max") {
    value = (maximum(points.map((point) => point.value)) ?? Number.NEGATIVE_INFINITY);
  } else {
    const weighted = points.map((point) => ({
      point,
      weight: Math.max(
        0,
        Date.parse(point.bucket.end) - Date.parse(point.bucket.start),
      ) * point.coverage,
    }));
    const weight = weighted.reduce((sum, item) => sum + item.weight, 0);
    value = weight > 0
      ? weighted.reduce((sum, item) => sum + item.point.value * item.weight, 0) / weight
      : null;
  }
  if (value === null || !Number.isFinite(value)) return null;
  const duration = points.reduce((sum, point) => (
    sum + Math.max(0, Date.parse(point.bucket.end) - Date.parse(point.bucket.start))
  ), 0);
  const coveredDuration = points.reduce((sum, point) => (
    sum + Math.max(0, Date.parse(point.bucket.end) - Date.parse(point.bucket.start))
      * point.coverage
  ), 0);
  return {
    value,
    minimum: (minimum(points.map((point) => point.minimum ?? point.value)) ?? Number.POSITIVE_INFINITY),
    maximum: (maximum(points.map((point) => point.maximum ?? point.value)) ?? Number.NEGATIVE_INFINITY),
    sampleCount: points.reduce((sum, point) => sum + point.sampleCount, 0),
    coverage: duration > 0 ? coveredDuration / duration : 0,
    bucketCount: points.length,
  };
}

function periodSeries(
  input: CalendarComparisonServiceInput,
  period: CalendarComparisonPeriod,
  response: AnalyticsQueryResponse,
): CalendarComparisonSeries[] {
  const { buckets, values } = periodValues(period, input.house.timezone, response);
  const byEntity = new Map(response.series.map((series) => [series.entityId, series]));
  const fallbackAggregation = resolveAnalyticsAggregation(
    input.definition,
    input.request.aggregation,
  );
  const singles = input.sensors.map((sensor): CalendarComparisonSeries => {
    const series = byEntity.get(sensor.id);
    const aggregation = series?.aggregation ?? fallbackAggregation;
    const points = buckets.flatMap((bucket) => {
      const point = pointFor(bucket, values.get(bucket.key)?.get(sensor.id));
      return point ? [point] : [];
    });
    return {
      id: `${period.key}:${sensor.id}`,
      sourceId: sensor.id,
      sourceLabel: sensor.name,
      combination: "single",
      period,
      aggregation,
      points,
      summary: summarize(points, aggregation),
    };
  });
  if (input.sensors.length < 2) return singles;
  const mode = combinedMode(input.definition);
  const aggregation = response.series[0]?.aggregation ?? fallbackAggregation;
  const points = buckets.flatMap((bucket) => {
    const bySensor = values.get(bucket.key);
    if (!bySensor) return [];
    const resolved = input.sensors.flatMap((sensor) => {
      const accumulator = bySensor.get(sensor.id);
      const value = accumulator ? calendarAccumulatorValue(accumulator) : null;
      return value ? [value] : [];
    });
    if (resolved.length !== input.sensors.length) return [];
    const point = combinedPoint(bucket, resolved, mode);
    return point ? [point] : [];
  });
  return [{
    id: `${period.key}:combined`,
    sourceId: "combined",
    sourceLabel: "Combined sensors",
    combination: mode,
    period,
    aggregation,
    points,
    summary: summarize(points, aggregation),
  }, ...singles];
}

function archiveState(
  coverage: Awaited<ReturnType<HybridTelemetryReader["measurementCoverage"]>>,
  responses: readonly AnalyticsQueryResponse[],
) {
  const states = [
    coverage.archiveState,
    ...responses.flatMap((response) => response.provenance.map((item) => item.archiveState)),
  ];
  if (states.includes("failed")) return "failed" as const;
  if (states.includes("not-ready")) return "not-ready" as const;
  if (states.includes("merged")) return "merged" as const;
  return "not-configured" as const;
}

function completedSlots(series: CalendarComparisonSeries): Set<string> {
  return new Set(series.points.flatMap((point) => (
    !point.bucket.partial
      && Date.parse(point.bucket.end) <= Date.parse(series.period.end)
      ? [point.bucket.slot]
      : []
  )));
}

function commonSlots(series: readonly CalendarComparisonSeries[]): Set<string> {
  if (series.length === 0) return new Set();
  const sets = series.map(completedSlots);
  return new Set([...sets[0]!].filter((slot) => sets.every((items) => items.has(slot))));
}

function alignSummaries(
  series: readonly CalendarComparisonSeries[],
): {
  series: CalendarComparisonSeries[];
  comparisons: CalendarComparisonResponse["comparisons"];
} {
  const bySource = new Map<string, CalendarComparisonSeries[]>();
  for (const item of series) {
    const items = bySource.get(item.sourceId) ?? [];
    items.push(item);
    bySource.set(item.sourceId, items);
  }
  const slotsBySource = new Map(
    [...bySource].map(([sourceId, items]) => [sourceId, commonSlots(items)]),
  );
  const aligned = series.map((item) => ({
    ...item,
    summary: summarize(
      item.points.filter((point) => slotsBySource.get(item.sourceId)?.has(point.bucket.slot)),
      item.aggregation,
    ),
  }));
  const alignedById = new Map(aligned.map((item) => [item.id, item]));
  const comparisons = [...bySource].flatMap(([sourceId, items]) => {
    if (items.length !== 2) return [];
    const current = alignedById.get(items[0]!.id)!;
    const baseline = alignedById.get(items[1]!.id)!;
    return [{
      sourceId,
      currentSeriesId: current.id,
      baselineSeriesId: baseline.id,
      commonCompletedBucketCount: slotsBySource.get(sourceId)?.size ?? 0,
      difference: current.summary && baseline.summary
        ? current.summary.value - baseline.summary.value
        : null,
    }];
  });
  return { series: aligned, comparisons };
}

export async function compareCalendarPeriods(
  input: CalendarComparisonServiceInput,
): Promise<CalendarComparisonResponse> {
  const coverage = await input.telemetryReader.measurementCoverage({
    sensorIds: input.sensors.map((sensor) => sensor.id),
    metrics: [input.definition.id],
    ...withSignal(input.signal),
  });
  if (!coverage.complete) {
    // `merged` with incomplete coverage is an internal reader failure, not
    // evidence that a shortened calendar comparison is safe.
    const archiveState = coverage.archiveState === "merged" ? "failed" : coverage.archiveState;
    throw new IncompleteTelemetryHistoryError(archiveState);
  }
  const matching = coverage.records.filter((record) => (
    record.metric === input.definition.id
    && input.sensors.some((sensor) => sensor.id === record.sensorId)
  ));
  const starts = matching.map((record) => record.start).sort(compareCodeUnits);
  const ends = matching.map((record) => record.end).sort(compareCodeUnits);
  const candidates = starts[0] && ends.at(-1)
    ? calendarComparisonPeriods({
        unit: input.request.unit,
        anchor: input.request.anchor,
        coverageStart: starts[0],
        coverageEnd: ends.at(-1)!,
        timeZone: input.house.timezone,
        now: Date.parse(input.evaluatedAt),
      })
    : [];
  const byKey = new Map(candidates.map((period) => [period.key, period]));
  const requested = input.request.selectedPeriodKeys;
  if (requested?.some((key) => !byKey.has(key))) {
    throw new CalendarComparisonSelectionError(
      "A selected calendar period is outside the available Home history",
    );
  }
  const selectedPeriods = requested
    ? requested.map((key) => byKey.get(key)!)
    : candidates.slice(-2).reverse();
  const responses = await Promise.all(selectedPeriods.map((period) => (
    executeAnalyticsQuery({
      request: analyticsRequest(input, period),
      sensors: input.sensors,
      definitions: [input.definition],
      telemetryReader: input.telemetryReader,
      generatedAt: input.evaluatedAt,
      ...withSignal(input.signal),
    })
  )));
  const state = archiveState(coverage, responses);
  const derived = alignSummaries(selectedPeriods.flatMap((period, index) => (
    periodSeries(input, period, responses[index]!)
  )));
  const partial = !coverage.complete || selectedPeriods.some((period) => period.partial);
  const result: CalendarComparisonResponse = {
    apiVersion: "1.0",
    requestId: input.request.requestId,
    houseId: input.house.id,
    dataMode: input.request.dataMode,
    measurementId: input.definition.id,
    unit: input.request.unit,
    anchor: input.request.anchor,
    aggregation: input.request.aggregation,
    qualityFilter: input.request.qualityFilter,
    candidates,
    selectedPeriods,
    series: derived.series,
    comparisons: derived.comparisons,
    archiveState: state,
    generatedAt: input.evaluatedAt,
    evaluatedAt: input.evaluatedAt,
    completeness: partial ? "partial" : "complete",
    warnings: responses.flatMap((response) => response.warnings),
    provenance: {
      algorithmKey: "calendar-comparison",
      algorithmVersion: CALENDAR_COMPARISON_ALGORITHM_VERSION,
      evaluatedAt: input.evaluatedAt,
      sourceIds: input.sensors.map((sensor) => sensor.id),
      archiveState: state,
    },
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_CALENDAR_COMPARISON_RESPONSE_BYTES) {
    throw new AnalyticsQueryError(
      422,
      "CALENDAR_COMPARISON_RESPONSE_TOO_LARGE",
      "Calendar comparison exceeds the deterministic response limit",
    );
  }
  return result;
}
