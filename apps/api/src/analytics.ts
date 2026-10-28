import { HttpError } from "./http-error.js";
import {
  counterDelta,
  maximum,
  mean,
  median,
  medianAbsoluteDeviation,
  minimum,
  quantileSorted,
  sampleStandardDeviation,
  orderedStateSeconds,
  POWER_HOLD_MS,
  stateTimeWeightedMean,
  timeWeightedMean,
} from "@climate-twin/analytics-kernel";
import { analyticsConsumptionBuckets } from "./analytics-consumption.js";
import type {
  AggregationSemantic,
  AnalyticsAggregation,
  AnalyticsCoverageRequest,
  AnalyticsPoint,
  AnalyticsQueryRequest,
  AnalyticsQueryResponse,
  AnalyticsResolution,
  AnalyticsSampleQuality,
  AnalyticsSeries,
  AnalyticsSummary,
  AnalyticsSummaryBasis,
  MeasurementDefinition,
  MeasurementKind,
  MeasurementSample,
  QualityFlag,
} from "@climate-twin/contracts";
import type { HybridArchiveReadState } from "./timeseries/read-facade.js";
import { yieldToEventLoop } from "./timeseries/read-support.js";

/** Samples processed between event-loop yields while shaping a response. */
const SAMPLES_PER_SLICE = 25_000;

const MAX_CUSTOM_RESOLUTION_MINUTES = 1_440;

export const MAX_INTERACTIVE_OUTPUT_POINTS = 100_000;

type BucketResolution = Exclude<AnalyticsResolution, "auto" | "raw">;

export class AnalyticsQueryError extends HttpError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "AnalyticsQueryError";
  }
}

function objectValue(value: unknown, field = "request"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AnalyticsQueryError(400, "INVALID_ANALYTICS_QUERY", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new AnalyticsQueryError(400, "UNKNOWN_ANALYTICS_FIELD", `${field} contains unknown fields: ${unknown.join(", ")}`);
  }
}

function requiredString(value: unknown, field: string, maximum = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new AnalyticsQueryError(400, "INVALID_ANALYTICS_FIELD", `${field} must be a non-empty string of at most ${maximum} characters`);
  }
  return value.trim();
}

function stringList(value: unknown, field: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new AnalyticsQueryError(400, "INVALID_ANALYTICS_FIELD", `${field} must contain between 1 and ${maximum} values`);
  }
  const result = value.map((item, index) => requiredString(item, `${field}[${index}]`));
  if (new Set(result).size !== result.length) {
    throw new AnalyticsQueryError(400, "DUPLICATE_ANALYTICS_FIELD", `${field} cannot contain duplicates`);
  }
  return result;
}

function optionalStringList(value: unknown, field: string, maximum: number): string[] | undefined {
  if (value === undefined) return undefined;
  return stringList(value, field, maximum);
}

function isoDate(value: unknown, field: string): string {
  const text = requiredString(value, field, 100);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new AnalyticsQueryError(400, "INVALID_ANALYTICS_RANGE", `${field} must be an ISO date-time`);
  return new Date(parsed).toISOString();
}

function validTimezone(value: unknown): string {
  const timezone = requiredString(value, "range.timezone", 100);
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
  } catch {
    throw new AnalyticsQueryError(400, "INVALID_ANALYTICS_TIMEZONE", "range.timezone must be a supported IANA timezone");
  }
  return timezone;
}

function analyticsResolution(value: unknown): AnalyticsResolution {
  if (value === "auto" || value === "raw" || value === "1h" || value === "1d") return value;
  if (typeof value === "string") {
    const match = /^(\d{1,4})m$/u.exec(value);
    const minutes = Number(match?.[1]);
    if (Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= MAX_CUSTOM_RESOLUTION_MINUTES) {
      return `${minutes}m`;
    }
  }
  throw new AnalyticsQueryError(
    400,
    "INVALID_ANALYTICS_RESOLUTION",
    `resolution must be auto, raw, 1h, 1d, or a minute interval from 1m to ${MAX_CUSTOM_RESOLUTION_MINUTES}m`,
  );
}

export function analyticsResolutionSeconds(resolution: BucketResolution): number {
  if (resolution === "1h") return 3_600;
  if (resolution === "1d") return 86_400;
  const minutes = Number(/^(\d{1,4})m$/u.exec(resolution)?.[1]);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_CUSTOM_RESOLUTION_MINUTES) {
    throw new AnalyticsQueryError(400, "INVALID_ANALYTICS_RESOLUTION", "resolution is not supported");
  }
  return minutes * 60;
}

export function parseAnalyticsQueryRequest(value: unknown, now = Date.now()): AnalyticsQueryRequest {
  const body = objectValue(value);
  rejectUnknown(body, [
    "apiVersion", "dataMode", "scope", "measurementIds", "range", "resolution", "aggregation", "qualityFilter", "include",
    "maxPointsPerSeries", "requestId",
  ], "request");
  if (body.apiVersion !== "1.0") throw new AnalyticsQueryError(400, "UNSUPPORTED_ANALYTICS_VERSION", "apiVersion must be 1.0");
  if (body.dataMode !== "live" && body.dataMode !== "demo") {
    throw new AnalyticsQueryError(400, "DATA_MODE_REQUIRED", "dataMode must be explicitly set to live or demo");
  }

  const scopeBody = objectValue(body.scope, "scope");
  rejectUnknown(scopeBody, ["kind", "id", "entityIds"], "scope");
  if (scopeBody.kind !== "house") throw new AnalyticsQueryError(422, "UNSUPPORTED_ANALYTICS_SCOPE", "This release supports house-scoped analytics queries");
  const entityIds = optionalStringList(scopeBody.entityIds, "scope.entityIds", 50);

  const rangeBody = objectValue(body.range, "range");
  rejectUnknown(rangeBody, ["start", "end", "timezone"], "range");
  const start = isoDate(rangeBody.start, "range.start");
  const end = isoDate(rangeBody.end, "range.end");
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (startMs >= endMs) throw new AnalyticsQueryError(400, "INVALID_ANALYTICS_RANGE", "range.start must be before range.end");
  if (endMs > now + 5 * 60_000) throw new AnalyticsQueryError(400, "FUTURE_ANALYTICS_RANGE", "Historical analytics queries cannot end in the future");
  if (endMs - startMs > 10 * 366 * 86_400_000) {
    throw new AnalyticsQueryError(422, "ANALYTICS_RANGE_TOO_LARGE", "Interactive analytics queries are limited to ten years");
  }

  const resolution = analyticsResolution(body.resolution);
  const aggregations: AnalyticsAggregation[] = ["default", "mean", "sum", "delta", "last", "time_weighted_mean", "min", "max"];
  if (!aggregations.includes(body.aggregation as AnalyticsAggregation)) {
    throw new AnalyticsQueryError(400, "INVALID_ANALYTICS_AGGREGATION", "aggregation is not supported");
  }
  if (resolution === "raw" && body.aggregation !== "default" && body.aggregation !== "last") {
    throw new AnalyticsQueryError(422, "RAW_AGGREGATION_NOT_ALLOWED", "Raw queries cannot apply a bucket aggregation");
  }

  let qualityFilter: AnalyticsQueryRequest["qualityFilter"];
  if (body.qualityFilter !== undefined) {
    const qualityBody = objectValue(body.qualityFilter, "qualityFilter");
    rejectUnknown(qualityBody, ["include"], "qualityFilter");
    const include = stringList(qualityBody.include, "qualityFilter.include", 3);
    const allowedQualities = new Set<AnalyticsSampleQuality>(["good", "estimated", "stale"]);
    if (include.some((quality) => !allowedQualities.has(quality as AnalyticsSampleQuality))) {
      throw new AnalyticsQueryError(400, "INVALID_ANALYTICS_QUALITY_FILTER", "qualityFilter.include contains an unsupported quality state");
    }
    qualityFilter = { include: include as AnalyticsSampleQuality[] };
  }

  const includes = body.include === undefined
    ? ["series", "summary", "provenance", "quality"] as const
    : stringList(body.include, "include", 4);
  const allowedIncludes = new Set(["series", "summary", "provenance", "quality"]);
  if (includes.some((item) => !allowedIncludes.has(item))) {
    throw new AnalyticsQueryError(400, "INVALID_ANALYTICS_INCLUDE", "include contains an unsupported section");
  }
  const maxPoints = body.maxPointsPerSeries ?? 800;
  if (!Number.isInteger(maxPoints) || (maxPoints as number) < 100 || (maxPoints as number) > 5_000) {
    throw new AnalyticsQueryError(400, "INVALID_ANALYTICS_POINT_LIMIT", "maxPointsPerSeries must be an integer from 100 to 5000");
  }

  return {
    apiVersion: "1.0",
    dataMode: body.dataMode,
    scope: {
      kind: "house",
      id: requiredString(scopeBody.id, "scope.id"),
      ...(entityIds ? { entityIds } : {}),
    },
    measurementIds: stringList(body.measurementIds, "measurementIds", 8),
    range: { start, end, timezone: validTimezone(rangeBody.timezone) },
    resolution,
    aggregation: body.aggregation as AnalyticsAggregation,
    ...(qualityFilter ? { qualityFilter } : {}),
    include: [...includes] as NonNullable<AnalyticsQueryRequest["include"]>,
    maxPointsPerSeries: maxPoints as number,
    requestId: requiredString(body.requestId, "requestId"),
  };
}

export function parseAnalyticsCoverageRequest(value: unknown): AnalyticsCoverageRequest {
  const body = objectValue(value);
  rejectUnknown(body, ["apiVersion", "dataMode", "scope", "measurementIds", "requestId"], "request");
  if (body.apiVersion !== "1.0") {
    throw new AnalyticsQueryError(400, "UNSUPPORTED_ANALYTICS_VERSION", "apiVersion must be 1.0");
  }
  if (body.dataMode !== "live" && body.dataMode !== "demo") {
    throw new AnalyticsQueryError(400, "DATA_MODE_REQUIRED", "dataMode must be explicitly set to live or demo");
  }
  const scopeBody = objectValue(body.scope, "scope");
  rejectUnknown(scopeBody, ["kind", "id", "entityIds"], "scope");
  if (scopeBody.kind !== "house") {
    throw new AnalyticsQueryError(422, "UNSUPPORTED_ANALYTICS_SCOPE", "This release supports house-scoped analytics queries");
  }
  const entityIds = optionalStringList(scopeBody.entityIds, "scope.entityIds", 50);
  return {
    apiVersion: "1.0",
    dataMode: body.dataMode,
    scope: {
      kind: "house",
      id: requiredString(scopeBody.id, "scope.id"),
      ...(entityIds ? { entityIds } : {}),
    },
    measurementIds: stringList(body.measurementIds, "measurementIds", 8),
    requestId: requiredString(body.requestId, "requestId"),
  };
}

export function analyticsDefinitionSemantics(definition: MeasurementDefinition): {
  kind: MeasurementKind;
  aggregation: AggregationSemantic;
} {
  if (definition.kind && definition.defaultAggregation) {
    return { kind: definition.kind, aggregation: definition.defaultAggregation };
  }
  if (definition.id === "energy") return { kind: "cumulative_counter", aggregation: "delta" };
  if (definition.id === "power") return { kind: "rate", aggregation: "time_weighted_mean" };
  return { kind: "gauge", aggregation: "mean" };
}

export function resolveAnalyticsAggregation(
  definition: MeasurementDefinition,
  requested: AnalyticsAggregation,
): Exclude<AnalyticsAggregation, "default"> {
  const semantics = analyticsDefinitionSemantics(definition);
  const aggregation = requested === "default" ? semantics.aggregation : requested;
  if (aggregation === "duration" || aggregation === "custom") {
    throw new AnalyticsQueryError(422, "UNSUPPORTED_ANALYTICS_AGGREGATION", `${aggregation} is not available in the interactive query path`);
  }
  const allowed: Record<MeasurementKind, ReadonlySet<string>> = {
    gauge: new Set(["mean", "last", "min", "max"]),
    rate: new Set(["mean", "time_weighted_mean", "last", "min", "max"]),
    increment: new Set(["sum", "last", "min", "max"]),
    cumulative_counter: new Set(["delta", "last", "min", "max"]),
    binary_state: new Set(["last", "mean"]),
    categorical_state: new Set(["last"]),
  };
  if (!allowed[semantics.kind].has(aggregation)) {
    throw new AnalyticsQueryError(
      422,
      "INVALID_MEASUREMENT_AGGREGATION",
      `${aggregation} is not valid for ${definition.id} (${semantics.kind})`,
    );
  }
  return aggregation as Exclude<AnalyticsAggregation, "default">;
}

export function resolveAnalyticsResolution(
  requested: AnalyticsResolution,
  start: string,
  end: string,
  maxPoints: number,
): Exclude<AnalyticsResolution, "auto"> {
  if (requested !== "auto") return requested;
  const durationSeconds = (Date.parse(end) - Date.parse(start)) / 1_000;
  if (durationSeconds <= maxPoints * 60) return "1m";
  for (const candidate of ["5m", "15m", "1h", "1d"] as const) {
    if (Math.ceil(durationSeconds / analyticsResolutionSeconds(candidate)) <= maxPoints) return candidate;
  }
  return "1d";
}

/**
 * Mirrors the archive rollup's `cadence_seconds` expression
 * (`GREATEST(1, range / GREATEST(1, sample_count))`). Bucket coverage — and
 * therefore the LOW_COVERAGE warning and the time-weighted-mean clamp — must
 * not change depending on whether a request was answered from source samples
 * or from the archive rollup, because the reader silently falls back between
 * the two whenever the continuous aggregate lags.
 */
export function analyticsBucketCadenceSeconds(sampleCount: number, rangeSeconds: number): number {
  return Math.max(1, rangeSeconds / Math.max(1, sampleCount));
}

/**
 * Raw series deliberately keep an observed-median cadence. The archive formula
 * above is a relative-density measure that degenerates to a constant coverage
 * of 1 when every sample is its own point, so it cannot describe raw series.
 */
function inferredCadenceSeconds(samples: readonly MeasurementSample[], rangeSeconds: number): number {
  const timestamps = [...new Set(samples.map((sample) => Date.parse(sample.timestamp)).filter(Number.isFinite))]
    .sort((left, right) => left - right);
  const deltas = timestamps.slice(1).map((timestamp, index) => (timestamp - timestamps[index]!) / 1_000)
    .filter((delta) => delta > 0 && delta <= 86_400);
  return Math.max(1, median(deltas) ?? Math.max(60, rangeSeconds / Math.max(1, samples.length)));
}

function sampleFlags(samples: readonly MeasurementSample[]): QualityFlag[] {
  const flags = new Set<QualityFlag>();
  if (samples.some((sample) => sample.quality === "estimated")) flags.add("source_estimated");
  if (samples.some((sample) => sample.quality === "stale")) flags.add("stale");
  return [...flags];
}

/**
 * Delta and time-weighted means read a series as one value per instant, as the
 * archive's ordered rollup does: a reading repeated by a second source counts
 * once, and of conflicting simultaneous readings the last one read stands
 * (local windows return same-instant rows in ingestion order).
 */
function oneReadingPerInstant(samples: readonly MeasurementSample[]): MeasurementSample[] {
  const byInstant = new Map<number, MeasurementSample>();
  for (const sample of samples) byInstant.set(Date.parse(sample.timestamp), sample);
  return [...byInstant.values()];
}

function readsOrderedSeries(aggregation: Exclude<AnalyticsAggregation, "default">): boolean {
  return aggregation === "delta" || aggregation === "time_weighted_mean";
}

function aggregateBucket(
  samples: readonly MeasurementSample[],
  aggregation: Exclude<AnalyticsAggregation, "default">,
  bucketEnd: number,
  cadenceSeconds: number,
  carriedCounter?: MeasurementSample,
  stateSeconds?: number,
): { value: number | null; flags: QualityFlag[] } {
  if (samples.length === 0) return { value: null, flags: ["missing"] };
  const ordered = [...samples].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const values = ordered.map((sample) => sample.value);
  const flags = new Set(sampleFlags(ordered));
  if (aggregation === "last") return { value: ordered.at(-1)!.value, flags: [...flags] };
  if (aggregation === "min") return { value: minimum(values), flags: [...flags] };
  if (aggregation === "max") return { value: maximum(values), flags: [...flags] };
  if (aggregation === "sum") return { value: values.reduce((sum, value) => sum + value, 0), flags: [...flags] };
  if (aggregation === "time_weighted_mean") {
    const readings = ordered.map((sample) => ({ at: Date.parse(sample.timestamp), value: sample.value }));
    // A reading stands for at most one and a half typical sampling intervals,
    // except inside one stored state, where the archive keeps the full gap.
    return {
      value: stateSeconds
        ? stateTimeWeightedMean(readings, bucketEnd, cadenceSeconds * 1_500, stateSeconds * 1_000)
        : timeWeightedMean(readings, bucketEnd, cadenceSeconds * 1_500),
      flags: [...flags],
    };
  }
  if (aggregation === "delta") {
    // The previous bucket's last reading opens this one, so no increment is
    // lost between buckets. Its quality describes that bucket, not this one.
    const readings = carriedCounter ? [carriedCounter.value, ...values] : values;
    if (readings.length < 2) return { value: null, flags: ["missing", "low_coverage", ...flags] };
    const { delta, resets } = counterDelta(readings);
    if (resets > 0) flags.add("counter_reset");
    return { value: delta, flags: [...flags] };
  }
  return { value: mean(values), flags: [...flags] };
}

/** Base buckets for time-weighted summaries: the finest width that keeps at most 10,000 per series. */
const SUMMARY_BASE_POINTS = 10_000;
export function summaryBaseResolution(rangeSeconds: number): "1m" | "15m" | "1h" {
  if (rangeSeconds / 60 <= SUMMARY_BASE_POINTS) return "1m";
  if (rangeSeconds / 900 <= SUMMARY_BASE_POINTS) return "15m";
  return "1h";
}

export interface AnalyticsSummaryOptions {
  basis?: AnalyticsSummaryBasis;
  expectedIntervalSeconds?: number | null;
  /** Displayed points; their mean coverage is used when no reporting interval is known. */
  displayPoints?: readonly AnalyticsPoint[];
  rangeSeconds?: number;
}

/**
 * A base bucket without readings repeats the previous bucket's value for up
 * to the power hold (15 minutes), so a sensor that reports every few minutes
 * is not under-weighted against one that reports every few seconds.
 */
function heldBaseValues(points: readonly AnalyticsPoint[]): number[] {
  const values: number[] = [];
  let last: { value: number; at: number } | null = null;
  for (const point of points) {
    const at = Date.parse(point.timestamp);
    if (point.value !== null) {
      values.push(point.value);
      last = { value: point.value, at };
    } else if (last && at - last.at <= POWER_HOLD_MS) {
      values.push(last.value);
    }
  }
  return values;
}

/**
 * Summary statistics. With a time-weighted base each base bucket stands for
 * the same length of time, so their mean is the time-weighted mean and their
 * quantiles describe the share of time spent at a level; extremes come from
 * the samples themselves.
 */
export function buildAnalyticsSummary(
  entityId: string,
  measurementId: string,
  canonicalUnit: string,
  points: readonly AnalyticsPoint[],
  sampleCount: number,
  options: AnalyticsSummaryOptions = {},
): AnalyticsSummary {
  const timeWeighted = options.basis?.statistics === "time-weighted-base" || options.basis?.statistics === "mean-base";
  const values = timeWeighted ? heldBaseValues(points) : points.flatMap((point) => point.value === null ? [] : [point.value]);
  const sorted = [...values].sort((left, right) => left - right);
  const center = median(values);
  const coveragePoints = options.displayPoints ?? points;
  // Readings against the expected count when the reporting interval is known;
  // otherwise the displayed buckets' relative density.
  const coverage = options.expectedIntervalSeconds && options.rangeSeconds
    ? Math.min(1, sampleCount * options.expectedIntervalSeconds / options.rangeSeconds)
    : coveragePoints.length === 0 ? 0 : coveragePoints.reduce((sum, point) => sum + point.coverage, 0) / coveragePoints.length;
  const extremes = (key: "minimum" | "maximum") => points.flatMap((point) => point[key] === null ? [] : [point[key]!]);
  return {
    entityId,
    measurementId,
    canonicalUnit,
    count: sampleCount,
    coverage,
    ...(options.basis ? { basis: options.basis } : {}),
    coverageBasis: options.expectedIntervalSeconds ? "expected-interval" : "window-density",
    expectedIntervalSeconds: options.expectedIntervalSeconds ?? null,
    minimum: timeWeighted ? minimum(extremes("minimum")) : minimum(values),
    maximum: timeWeighted ? maximum(extremes("maximum")) : maximum(values),
    mean: mean(values),
    median: center,
    standardDeviation: sampleStandardDeviation(values),
    medianAbsoluteDeviation: medianAbsoluteDeviation(values, center),
    p05: quantileSorted(sorted, 0.05),
    p95: quantileSorted(sorted, 0.95),
  };
}

function rawPoints(samples: readonly MeasurementSample[], rangeSeconds: number): AnalyticsPoint[] {
  const cadence = inferredCadenceSeconds(samples, rangeSeconds);
  const expected = Math.max(1, Math.round(rangeSeconds / cadence));
  const seriesCoverage = Math.min(1, samples.length / expected);
  return [...samples].sort((left, right) => left.timestamp.localeCompare(right.timestamp)).map((sample) => ({
    timestamp: sample.timestamp,
    value: sample.value,
    minimum: sample.value,
    maximum: sample.value,
    sampleCount: 1,
    coverage: seriesCoverage,
    qualityFlags: sampleFlags([sample]),
  }));
}

async function bucketPoints(
  samples: readonly MeasurementSample[],
  start: number,
  end: number,
  resolution: BucketResolution,
  aggregation: Exclude<AnalyticsAggregation, "default">,
  consumptionSamples: readonly MeasurementSample[] = samples,
  options: { stateSeconds?: number; expectedIntervalSeconds?: number } = {},
): Promise<AnalyticsPoint[]> {
  const bucketMs = analyticsResolutionSeconds(resolution) * 1_000;
  const firstBucket = Math.floor(start / bucketMs) * bucketMs;
  const rangeSeconds = (end - start) / 1_000;
  const cadenceSeconds = analyticsBucketCadenceSeconds(samples.length, rangeSeconds);
  // Coverage compares with the sensor's long-run reporting interval when it is
  // known; the in-window density only says how full a bucket is relative to
  // the rest of the window.
  const expectedPerBucket = Math.max(1, bucketMs / 1_000 / (options.expectedIntervalSeconds ?? cadenceSeconds));
  const byBucket = new Map<number, MeasurementSample[]>();
  let sliceRemaining = SAMPLES_PER_SLICE;
  for (const sample of samples) {
    const timestamp = Date.parse(sample.timestamp);
    const bucket = Math.floor(timestamp / bucketMs) * bucketMs;
    const values = byBucket.get(bucket) ?? [];
    values.push(sample);
    byBucket.set(bucket, values);
    if (--sliceRemaining === 0) {
      sliceRemaining = SAMPLES_PER_SLICE;
      await yieldToEventLoop();
    }
  }
  const points: AnalyticsPoint[] = [];
  // The archive integrates consumption only in its ordered rollup, so the
  // mergeable aggregations carry none on either path.
  const consumption = readsOrderedSeries(aggregation)
    ? analyticsConsumptionBuckets(consumptionSamples, consumptionSamples[0]?.metric ?? "", bucketMs, end, start)
    : new Map<number, number | null>();
  let previousCounterSample: MeasurementSample | undefined;
  for (let timestamp = firstBucket; timestamp < end; timestamp += bucketMs) {
    const values = byBucket.get(timestamp) ?? [];
    const coverage = Math.min(1, values.length / expectedPerBucket);
    const aggregated = aggregateBucket(values, aggregation, timestamp + bucketMs, cadenceSeconds,
      aggregation === "delta" ? previousCounterSample : undefined, options.stateSeconds);
    const flags = new Set(aggregated.flags);
    if (coverage < 0.75) flags.add("low_coverage");
    points.push({
      timestamp: new Date(timestamp).toISOString(),
      value: aggregated.value,
      ...(consumption.has(timestamp) ? { consumptionKwh: consumption.get(timestamp) ?? null } : {}),
      minimum: minimum(values.map((sample) => sample.value)),
      maximum: maximum(values.map((sample) => sample.value)),
      sampleCount: values.length,
      coverage,
      qualityFlags: [...flags],
    });
    if (aggregation === "delta" && values.length > 0) {
      previousCounterSample = [...values].sort((left, right) => left.timestamp.localeCompare(right.timestamp)).at(-1);
    }
  }
  return points;
}

export function finalizeAnalyticsResponse(input: {
  request: AnalyticsQueryRequest;
  resolution: Exclude<AnalyticsResolution, "auto">;
  series: AnalyticsSeries[];
  archiveState: HybridArchiveReadState;
  excludedSampleCount: number;
  includedQualities: AnalyticsSampleQuality[];
  generatedAt: string;
}): AnalyticsQueryResponse {
  const summaries = input.series.map((item) => item.summary);
  const totalPoints = input.series.reduce((sum, item) => sum + item.points.length, 0);
  const coverage = totalPoints === 0
    ? 0
    : input.series.reduce(
      (sum, item) => sum + item.points.reduce((pointSum, point) => pointSum + point.coverage, 0),
      0,
    ) / totalPoints;
  const provenance = [
    ...new Map(input.series.map((item) => [JSON.stringify(item.provenance), item.provenance])).values(),
  ];
  const warnings = [
    ...(coverage < 0.75
      ? [{ code: "LOW_COVERAGE", message: "One or more series has limited coverage in the selected range." }]
      : []),
    ...(input.archiveState === "failed" || input.archiveState === "not-ready"
      ? [{ code: "ARCHIVE_DEGRADED", message: "The response may rely only on locally retained telemetry." }]
      : []),
    ...(input.excludedSampleCount > 0
      ? [{
        code: "QUALITY_FILTER_EXCLUDED",
        message: `${input.excludedSampleCount} source samples were excluded by the selected quality filter.`,
      }]
      : []),
  ];
  return {
    apiVersion: "1.0",
    requestId: input.request.requestId,
    dataMode: input.request.dataMode,
    resolvedRange: input.request.range,
    resolution: input.resolution,
    series: input.series,
    summaries,
    quality: {
      coverage,
      seriesCount: input.series.length,
      sampleCount: summaries.reduce((sum, item) => sum + item.count, 0),
      excludedSampleCount: input.excludedSampleCount,
      includedQualities: input.includedQualities,
      lowCoverageSeries: summaries.filter((item) => item.coverage < 0.75).length,
    },
    provenance,
    warnings,
    generatedAt: input.generatedAt,
    cache: { hit: false, keyVersion: "analytics-query-v2" },
  };
}

export interface AnalyticsQueryShape {
  resolution: Exclude<AnalyticsResolution, "auto">;
  maxPointsPerSeries: number;
  /** Null for raw requests, which are bounded per series by their sample count. */
  bucketCount: number | null;
}

/**
 * The single admission ladder for both response builders. `buildAnalyticsResponse`
 * reads source samples and `buildAnalyticsResponseFromRollup` reads archive
 * buckets, but a request that is too large has to fail identically on either
 * path — the reader chooses between them without the caller's knowledge.
 */
export function resolveAnalyticsQueryShape(input: {
  request: AnalyticsQueryRequest;
  entityCount: number;
}): AnalyticsQueryShape {
  const maxPointsPerSeries = input.request.maxPointsPerSeries ?? 800;
  const resolution = resolveAnalyticsResolution(
    input.request.resolution,
    input.request.range.start,
    input.request.range.end,
    maxPointsPerSeries,
  );
  if (resolution === "raw") return { resolution, maxPointsPerSeries, bucketCount: null };
  const start = Date.parse(input.request.range.start);
  const end = Date.parse(input.request.range.end);
  const bucketMs = analyticsResolutionSeconds(resolution) * 1_000;
  const bucketCount = Math.ceil((end - Math.floor(start / bucketMs) * bucketMs) / bucketMs);
  if (bucketCount > maxPointsPerSeries) {
    throw new AnalyticsQueryError(
      422,
      "ANALYTICS_POINT_LIMIT_EXCEEDED",
      input.request.resolution === "auto"
        // Automatic selection already picked the coarsest supported bucket, so
        // repeating the standard "choose automatic resolution" advice would be
        // telling the caller to do what it just did.
        ? `The requested range needs ${bucketCount} points per series at the coarsest supported resolution; choose a shorter range or raise maxPointsPerSeries`
        : `The selected resolution would return ${bucketCount} points per series; choose automatic resolution or a shorter range`,
    );
  }
  if (bucketCount * input.entityCount * input.request.measurementIds.length > MAX_INTERACTIVE_OUTPUT_POINTS) {
    throw new AnalyticsQueryError(
      422,
      "ANALYTICS_QUERY_TOO_LARGE",
      `The interactive response would exceed ${MAX_INTERACTIVE_OUTPUT_POINTS} points; reduce the entity, measurement, or time scope`,
    );
  }
  return { resolution, maxPointsPerSeries, bucketCount };
}

/** Resolves a requested measurement, rejecting unknown and analytics-disabled ids alike. */
export function analyticsMeasurementDefinition(
  definitions: ReadonlyMap<string, MeasurementDefinition>,
  measurementId: string,
): MeasurementDefinition {
  const definition = definitions.get(measurementId);
  if (!definition) {
    throw new AnalyticsQueryError(404, "UNKNOWN_ANALYTICS_MEASUREMENT", `Unknown measurement: ${measurementId}`);
  }
  if (definition.genericStatsEnabled === false || definition.genericHistoryEnabled === false) {
    throw new AnalyticsQueryError(
      422,
      "ANALYTICS_MEASUREMENT_DISABLED",
      `Analytics is disabled for measurement: ${measurementId}`,
    );
  }
  return definition;
}

/**
 * Series identity key. Identifiers are caller-supplied text, so this uses the
 * same JSON encoding as the telemetry reader's record keys rather than a
 * separator character a caller could embed in an id.
 */
export function analyticsSeriesKey(sensorId: string, measurementId: string): string {
  return JSON.stringify([sensorId, measurementId]);
}

export interface BuildAnalyticsResponseInput {
  request: AnalyticsQueryRequest;
  samples: MeasurementSample[];
  /** Long-run reporting interval per series key, for coverage. */
  expectedIntervalSeconds?: ReadonlyMap<string, number>;
  /** Range anchors affect consumption only, never half-open observation statistics. */
  consumptionBoundarySamples?: MeasurementSample[];
  definitions: MeasurementDefinition[];
  entities: Array<{ id: string; label: string }>;
  archiveState: HybridArchiveReadState;
  generatedAt?: string;
}

export async function buildAnalyticsResponse(input: BuildAnalyticsResponseInput): Promise<AnalyticsQueryResponse> {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const { resolution, maxPointsPerSeries: maxPoints } = resolveAnalyticsQueryShape({
    request: input.request,
    entityCount: input.entities.length,
  });
  const start = Date.parse(input.request.range.start);
  const end = Date.parse(input.request.range.end);
  const rangeSeconds = (end - start) / 1_000;
  const includedQualities = input.request.qualityFilter?.include ?? ["good", "estimated", "stale"];
  const includedQualitySet = new Set(includedQualities);
  const definitions = new Map(input.definitions.map((definition) => [definition.id, definition]));
  // One yielding pass applies the half-open range (aggregation stays correct
  // even when a telemetry backend uses an inclusive upper read bound), the
  // quality filter, and the per-series partition that keeps the series loop
  // linear in the sample count — without pinning the event loop for a whole
  // quarter-million-sample window.
  const samplesBySeries = new Map<string, MeasurementSample[]>();
  let rangeSampleCount = 0;
  let includedSampleCount = 0;
  let sliceRemaining = SAMPLES_PER_SLICE;
  for (const sample of input.samples) {
    if (--sliceRemaining === 0) {
      sliceRemaining = SAMPLES_PER_SLICE;
      await yieldToEventLoop();
    }
    const timestamp = Date.parse(sample.timestamp);
    if (timestamp < start || timestamp >= end) continue;
    rangeSampleCount += 1;
    if (!includedQualitySet.has(sample.quality)) continue;
    includedSampleCount += 1;
    const key = analyticsSeriesKey(sample.sensorId, sample.metric);
    const bucket = samplesBySeries.get(key);
    if (bucket) bucket.push(sample);
    else samplesBySeries.set(key, [sample]);
  }
  const excludedSampleCount = rangeSampleCount - includedSampleCount;
  const boundariesBySeries = new Map<string, MeasurementSample[]>();
  for (const sample of input.consumptionBoundarySamples ?? []) {
    if (!includedQualitySet.has(sample.quality)) continue;
    const key = analyticsSeriesKey(sample.sensorId, sample.metric);
    const group = boundariesBySeries.get(key) ?? [];
    group.push(sample);
    boundariesBySeries.set(key, group);
  }
  // Bucketed sizes are bounded by the shared shape guard above. Raw responses
  // are bounded by their own sample count, which is only known here.
  if (resolution === "raw" && includedSampleCount > MAX_INTERACTIVE_OUTPUT_POINTS) {
    throw new AnalyticsQueryError(
      422,
      "ANALYTICS_QUERY_TOO_LARGE",
      `The interactive response would exceed ${MAX_INTERACTIVE_OUTPUT_POINTS} points; reduce the entity, measurement, or time scope`,
    );
  }
  const series: AnalyticsSeries[] = [];
  const aggregations = input.request.measurementIds.map((measurementId) => (
    resolveAnalyticsAggregation(analyticsMeasurementDefinition(definitions, measurementId), input.request.aggregation)
  ));
  const timeWeightedIds = input.request.measurementIds.filter((_, index) => aggregations[index] === "time_weighted_mean");
  const levelIds = input.request.measurementIds.filter((_, index) => aggregations[index] === "time_weighted_mean" || aggregations[index] === "mean");
  // The archive reads stored states of these widths; matching them keeps both paths equal.
  const stateSeconds = resolution === "raw" ? undefined : orderedStateSeconds(analyticsResolutionSeconds(resolution), {
    power: input.request.measurementIds.includes("power"),
    timeWeighted: timeWeightedIds.length > 0,
  });
  const baseResolution = summaryBaseResolution(rangeSeconds);
  const baseStateSeconds = orderedStateSeconds(analyticsResolutionSeconds(baseResolution), {
    power: timeWeightedIds.includes("power"),
    timeWeighted: true,
  });

  for (const entity of input.entities) {
    for (const measurementId of input.request.measurementIds) {
      const definition = analyticsMeasurementDefinition(definitions, measurementId);
      const expectedIntervalSeconds = input.expectedIntervalSeconds?.get(analyticsSeriesKey(entity.id, measurementId));
      const aggregation = resolution === "raw"
        ? "last"
        : resolveAnalyticsAggregation(definition, input.request.aggregation);
      const seriesSamples = samplesBySeries.get(analyticsSeriesKey(entity.id, measurementId)) ?? [];
      const samples = resolution !== "raw" && readsOrderedSeries(aggregation)
        ? oneReadingPerInstant(seriesSamples)
        : seriesSamples;
      if (resolution === "raw" && samples.length > maxPoints) {
        throw new AnalyticsQueryError(
          422,
          "RAW_POINT_LIMIT_EXCEEDED",
          `Raw series ${entity.id}/${measurementId} has ${samples.length} points; select automatic resolution or a shorter range`,
        );
      }
      const points = resolution === "raw"
        ? rawPoints(samples, rangeSeconds)
        : await bucketPoints(samples, start, end, resolution, aggregation,
          [...seriesSamples, ...(boundariesBySeries.get(analyticsSeriesKey(entity.id, measurementId)) ?? [])],
          { ...(stateSeconds ? { stateSeconds } : {}), ...(expectedIntervalSeconds ? { expectedIntervalSeconds } : {}) });
      const level = levelIds.includes(measurementId);
      const levelAggregation = resolveAnalyticsAggregation(definition, input.request.aggregation) as "time_weighted_mean" | "mean";
      const summaryPoints = !level
        ? points
        : resolution === baseResolution
          ? points
          : await bucketPoints(levelAggregation === "time_weighted_mean" ? oneReadingPerInstant(seriesSamples) : seriesSamples,
            start, end, baseResolution, levelAggregation, seriesSamples,
            { stateSeconds: baseStateSeconds, ...(expectedIntervalSeconds ? { expectedIntervalSeconds } : {}) });
      const provenance = {
        algorithmKey: resolution === "raw" ? "analytics-raw-series" : "analytics-bucket-rollup",
        algorithmVersion: "1.0.0",
        generatedAt,
        inputStart: input.request.range.start,
        inputEnd: input.request.range.end,
        sourceIds: [...new Set(samples.map((sample) => sample.sensorId))],
        archiveState: input.archiveState,
      };
      series.push({
        entityId: entity.id,
        entityLabel: entity.label,
        measurementId,
        canonicalUnit: definition.unit,
        truthClass: resolution === "raw" ? "observed" : "derived",
        aggregation: resolution === "raw" ? "raw" : aggregation,
        resolution,
        points,
        summary: buildAnalyticsSummary(entity.id, measurementId, definition.unit, summaryPoints, samples.length, {
          basis: level
            ? { statistics: levelAggregation === "time_weighted_mean" ? "time-weighted-base" : "mean-base", baseResolution }
            : { statistics: "display-points" },
          expectedIntervalSeconds: expectedIntervalSeconds ?? null,
          displayPoints: points,
          rangeSeconds,
        }),
        provenance,
      });
    }
  }

  return finalizeAnalyticsResponse({
    request: input.request,
    resolution,
    series,
    archiveState: input.archiveState,
    excludedSampleCount,
    includedQualities: [...includedQualities],
    generatedAt,
  });
}
