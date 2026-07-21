import type {
  AggregationSemantic,
  AnalyticsAggregation,
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

const RESOLUTION_SECONDS = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3_600,
  "1d": 86_400,
} as const;

const MAX_INTERACTIVE_OUTPUT_POINTS = 100_000;

type BucketResolution = keyof typeof RESOLUTION_SECONDS;

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

  const resolutions: AnalyticsResolution[] = ["auto", "raw", "1m", "5m", "15m", "1h", "1d"];
  if (!resolutions.includes(body.resolution as AnalyticsResolution)) {
    throw new AnalyticsQueryError(400, "INVALID_ANALYTICS_RESOLUTION", "resolution is not supported");
  }
  const aggregations: AnalyticsAggregation[] = ["default", "mean", "sum", "delta", "last", "time_weighted_mean", "min", "max"];
  if (!aggregations.includes(body.aggregation as AnalyticsAggregation)) {
    throw new AnalyticsQueryError(400, "INVALID_ANALYTICS_AGGREGATION", "aggregation is not supported");
  }
  if (body.resolution === "raw" && body.aggregation !== "default" && body.aggregation !== "last") {
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
    resolution: body.resolution as AnalyticsResolution,
    aggregation: body.aggregation as AnalyticsAggregation,
    ...(qualityFilter ? { qualityFilter } : {}),
    include: [...includes] as NonNullable<AnalyticsQueryRequest["include"]>,
    maxPointsPerSeries: maxPoints as number,
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

function resolvedAggregation(definition: MeasurementDefinition, requested: AnalyticsAggregation): Exclude<AnalyticsAggregation, "default"> {
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
    if (Math.ceil(durationSeconds / RESOLUTION_SECONDS[candidate]) <= maxPoints) return candidate;
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
  if (aggregation === "min") return { value: Math.min(...values), flags: [...flags] };
  if (aggregation === "max") return { value: Math.max(...values), flags: [...flags] };
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

function summary(
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
    minimum: values.length === 0 ? null : Math.min(...values),
    maximum: values.length === 0 ? null : Math.max(...values),
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

function bucketPoints(
  samples: readonly MeasurementSample[],
  start: number,
  end: number,
  resolution: BucketResolution,
  aggregation: Exclude<AnalyticsAggregation, "default">,
): AnalyticsPoint[] {
  const bucketMs = RESOLUTION_SECONDS[resolution] * 1_000;
  const firstBucket = Math.floor(start / bucketMs) * bucketMs;
  const rangeSeconds = (end - start) / 1_000;
  const cadenceSeconds = inferredCadenceSeconds(samples, rangeSeconds);
  const expectedPerBucket = Math.max(1, bucketMs / 1_000 / cadenceSeconds);
  const byBucket = new Map<number, MeasurementSample[]>();
  for (const sample of samples) {
    const timestamp = Date.parse(sample.timestamp);
    const bucket = Math.floor(timestamp / bucketMs) * bucketMs;
    const values = byBucket.get(bucket) ?? [];
    values.push(sample);
    byBucket.set(bucket, values);
  }
  const points: AnalyticsPoint[] = [];
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
      minimum: values.length === 0 ? null : Math.min(...values.map((sample) => sample.value)),
      maximum: values.length === 0 ? null : Math.max(...values.map((sample) => sample.value)),
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

export interface BuildAnalyticsResponseInput {
  request: AnalyticsQueryRequest;
  samples: MeasurementSample[];
  definitions: MeasurementDefinition[];
  entities: Array<{ id: string; label: string }>;
  archiveState: HybridArchiveReadState;
  generatedAt?: string;
}

export function buildAnalyticsResponse(input: BuildAnalyticsResponseInput): AnalyticsQueryResponse {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const maxPoints = input.request.maxPointsPerSeries ?? 800;
  const resolution = resolveAnalyticsResolution(
    input.request.resolution,
    input.request.range.start,
    input.request.range.end,
    maxPoints,
  );
  const start = Date.parse(input.request.range.start);
  const end = Date.parse(input.request.range.end);
  const rangeSeconds = (end - start) / 1_000;
  const includedQualities = input.request.qualityFilter?.include ?? ["good", "estimated", "stale"];
  const includedQualitySet = new Set(includedQualities);
  const includedSamples = input.samples.filter((sample) => includedQualitySet.has(sample.quality));
  const excludedSampleCount = input.samples.length - includedSamples.length;
  const bucketMs = resolution === "raw" ? null : RESOLUTION_SECONDS[resolution] * 1_000;
  const bucketCount = bucketMs === null ? null : Math.ceil((end - Math.floor(start / bucketMs) * bucketMs) / bucketMs);
  if (bucketCount !== null && bucketCount > maxPoints) {
    throw new AnalyticsQueryError(
      422,
      "ANALYTICS_POINT_LIMIT_EXCEEDED",
      `The selected resolution would return ${bucketCount} points per series; choose automatic resolution or a shorter range`,
    );
  }
  const projectedOutputPoints = resolution === "raw"
    ? includedSamples.length
    : (bucketCount ?? 0) * input.entities.length * input.request.measurementIds.length;
  if (projectedOutputPoints > MAX_INTERACTIVE_OUTPUT_POINTS) {
    throw new AnalyticsQueryError(
      422,
      "ANALYTICS_QUERY_TOO_LARGE",
      `The interactive response would exceed ${MAX_INTERACTIVE_OUTPUT_POINTS} points; reduce the entity, measurement, or time scope`,
    );
  }
  const definitions = new Map(input.definitions.map((definition) => [definition.id, definition]));
  const series: AnalyticsSeries[] = [];

  for (const entity of input.entities) {
    for (const measurementId of input.request.measurementIds) {
      const definition = definitions.get(measurementId);
      if (!definition) throw new AnalyticsQueryError(404, "UNKNOWN_ANALYTICS_MEASUREMENT", `Unknown measurement: ${measurementId}`);
      if (definition.genericStatsEnabled === false || definition.genericHistoryEnabled === false) {
        throw new AnalyticsQueryError(422, "ANALYTICS_MEASUREMENT_DISABLED", `Analytics is disabled for measurement: ${measurementId}`);
      }
      const aggregation = resolution === "raw" ? "last" : resolvedAggregation(definition, input.request.aggregation);
      const samples = includedSamples.filter((sample) => sample.sensorId === entity.id && sample.metric === measurementId);
      if (resolution === "raw" && samples.length > maxPoints) {
        throw new AnalyticsQueryError(
          422,
          "RAW_POINT_LIMIT_EXCEEDED",
          `Raw series ${entity.id}/${measurementId} has ${samples.length} points; select automatic resolution or a shorter range`,
        );
      }
      const points = resolution === "raw"
        ? rawPoints(samples, rangeSeconds)
        : bucketPoints(samples, start, end, resolution, aggregation);
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
        summary: summary(entity.id, measurementId, definition.unit, points, samples.length),
        provenance,
      });
    }
  }

  const summaries = series.map((item) => item.summary);
  const totalPoints = series.reduce((sum, item) => sum + item.points.length, 0);
  const coverage = totalPoints === 0
    ? 0
    : series.reduce((sum, item) => sum + item.points.reduce((pointSum, point) => pointSum + point.coverage, 0), 0) / totalPoints;
  const provenance = [...new Map(series.map((item) => [JSON.stringify(item.provenance), item.provenance])).values()];
  const warnings = [
    ...(coverage < 0.75 ? [{ code: "LOW_COVERAGE", message: "One or more series has limited coverage in the selected range." }] : []),
    ...(input.archiveState === "failed" || input.archiveState === "not-ready"
      ? [{ code: "ARCHIVE_DEGRADED", message: "The response may rely only on locally retained telemetry." }]
      : []),
    ...(excludedSampleCount > 0
      ? [{ code: "QUALITY_FILTER_EXCLUDED", message: `${excludedSampleCount} source samples were excluded by the selected quality filter.` }]
      : []),
  ];
  return {
    apiVersion: "1.0",
    requestId: input.request.requestId,
    dataMode: input.request.dataMode,
    resolvedRange: input.request.range,
    resolution,
    series,
    summaries,
    quality: {
      coverage,
      seriesCount: series.length,
      sampleCount: summaries.reduce((sum, item) => sum + item.count, 0),
      excludedSampleCount,
      includedQualities,
      lowCoverageSeries: summaries.filter((item) => item.coverage < 0.75).length,
    },
    provenance,
    warnings,
    generatedAt,
    cache: { hit: false, keyVersion: "analytics-query-v1" },
  };
}
