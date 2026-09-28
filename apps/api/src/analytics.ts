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

export class AnalyticsQueryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
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

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
}

function median(values: readonly number[]): number | null {
  return percentile([...values].sort((left, right) => left - right), 0.5);
}

/**
 * Bucket and series extents are reduced rather than spread into `Math.min`.
 * A single bucket may legitimately hold tens of thousands of samples at the
 * limits this path accepts, which is past the engine's argument-count ceiling.
 */
function minimumOf(values: readonly number[]): number | null {
  let minimum: number | null = null;
  for (const value of values) if (minimum === null || value < minimum) minimum = value;
  return minimum;
}

function maximumOf(values: readonly number[]): number | null {
  let maximum: number | null = null;
  for (const value of values) if (maximum === null || value > maximum) maximum = value;
  return maximum;
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

function timeWeightedMean(samples: readonly MeasurementSample[], bucketEnd: number, cadenceSeconds: number): number | null {
  if (samples.length === 0) return null;
  if (samples.length === 1) return samples[0]!.value;
  let weighted = 0;
  let duration = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const current = samples[index]!;
    const currentMs = Date.parse(current.timestamp);
    const nextMs = index + 1 < samples.length ? Date.parse(samples[index + 1]!.timestamp) : bucketEnd;
    const seconds = Math.max(0, Math.min(nextMs - currentMs, cadenceSeconds * 1_500) / 1_000);
    weighted += current.value * seconds;
    duration += seconds;
  }
  return duration > 0 ? weighted / duration : samples.at(-1)!.value;
}

function aggregateBucket(
  samples: readonly MeasurementSample[],
  aggregation: Exclude<AnalyticsAggregation, "default">,
  bucketEnd: number,
  cadenceSeconds: number,
): { value: number | null; flags: QualityFlag[] } {
  if (samples.length === 0) return { value: null, flags: ["missing"] };
  const ordered = [...samples].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const values = ordered.map((sample) => sample.value);
  const flags = new Set(sampleFlags(ordered));
  if (aggregation === "last") return { value: ordered.at(-1)!.value, flags: [...flags] };
  if (aggregation === "min") return { value: minimumOf(values), flags: [...flags] };
  if (aggregation === "max") return { value: maximumOf(values), flags: [...flags] };
  if (aggregation === "sum") return { value: values.reduce((sum, value) => sum + value, 0), flags: [...flags] };
  if (aggregation === "time_weighted_mean") {
    return { value: timeWeightedMean(ordered, bucketEnd, cadenceSeconds), flags: [...flags] };
  }
  if (aggregation === "delta") {
    if (ordered.length < 2) return { value: null, flags: ["missing", "low_coverage", ...flags] };
    let delta = 0;
    for (let index = 1; index < ordered.length; index += 1) {
      const change = ordered[index]!.value - ordered[index - 1]!.value;
      if (change >= 0) delta += change;
      else flags.add("counter_reset");
    }
    return { value: delta, flags: [...flags] };
  }
  return { value: values.reduce((sum, value) => sum + value, 0) / values.length, flags: [...flags] };
}

export function buildAnalyticsSummary(
  entityId: string,
  measurementId: string,
  canonicalUnit: string,
  points: readonly AnalyticsPoint[],
  sampleCount: number,
): AnalyticsSummary {
  const values = points.flatMap((point) => point.value === null ? [] : [point.value]);
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
  const standardDeviation = mean === null || values.length < 2
    ? null
    : Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
  const center = median(values);
  const mad = center === null ? null : median(values.map((value) => Math.abs(value - center)));
  return {
    entityId,
    measurementId,
    canonicalUnit,
    count: sampleCount,
    coverage: points.length === 0 ? 0 : points.reduce((sum, point) => sum + point.coverage, 0) / points.length,
    minimum: minimumOf(values),
    maximum: maximumOf(values),
    mean,
    median: center,
    standardDeviation,
    medianAbsoluteDeviation: mad,
    p05: percentile(sorted, 0.05),
    p95: percentile(sorted, 0.95),
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
): Promise<AnalyticsPoint[]> {
  const bucketMs = analyticsResolutionSeconds(resolution) * 1_000;
  const firstBucket = Math.floor(start / bucketMs) * bucketMs;
  const rangeSeconds = (end - start) / 1_000;
  const cadenceSeconds = analyticsBucketCadenceSeconds(samples.length, rangeSeconds);
  const expectedPerBucket = Math.max(1, bucketMs / 1_000 / cadenceSeconds);
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
  const consumption = analyticsConsumptionBuckets(samples, samples[0]?.metric ?? "", bucketMs, end);
  let previousCounterSample: MeasurementSample | undefined;
  for (let timestamp = firstBucket; timestamp < end; timestamp += bucketMs) {
    const values = byBucket.get(timestamp) ?? [];
    const coverage = Math.min(1, values.length / expectedPerBucket);
    const aggregationValues = aggregation === "delta" && previousCounterSample
      ? [previousCounterSample, ...values]
      : values;
    const aggregated = aggregateBucket(aggregationValues, aggregation, timestamp + bucketMs, cadenceSeconds);
    const flags = new Set(aggregated.flags);
    if (coverage < 0.75) flags.add("low_coverage");
    points.push({
      timestamp: new Date(timestamp).toISOString(),
      value: aggregated.value,
      ...(consumption.has(timestamp) ? { consumptionKwh: consumption.get(timestamp) ?? null } : {}),
      minimum: minimumOf(values.map((sample) => sample.value)),
      maximum: maximumOf(values.map((sample) => sample.value)),
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
    cache: { hit: false, keyVersion: "analytics-query-v1" },
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

  for (const entity of input.entities) {
    for (const measurementId of input.request.measurementIds) {
      const definition = analyticsMeasurementDefinition(definitions, measurementId);
      const aggregation = resolution === "raw"
        ? "last"
        : resolveAnalyticsAggregation(definition, input.request.aggregation);
      const samples = samplesBySeries.get(analyticsSeriesKey(entity.id, measurementId)) ?? [];
      if (resolution === "raw" && samples.length > maxPoints) {
        throw new AnalyticsQueryError(
          422,
          "RAW_POINT_LIMIT_EXCEEDED",
          `Raw series ${entity.id}/${measurementId} has ${samples.length} points; select automatic resolution or a shorter range`,
        );
      }
      const points = resolution === "raw"
        ? rawPoints(samples, rangeSeconds)
        : await bucketPoints(samples, start, end, resolution, aggregation);
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
        summary: buildAnalyticsSummary(entity.id, measurementId, definition.unit, points, samples.length),
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
