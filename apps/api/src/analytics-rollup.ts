import type {
  AnalyticsPoint,
  AnalyticsQueryRequest,
  AnalyticsQueryResponse,
  AnalyticsSampleQuality,
  AnalyticsSeries,
  MeasurementDefinition,
  QualityFlag,
} from "@climate-twin/contracts";
import {
  AnalyticsQueryError,
  MAX_INTERACTIVE_OUTPUT_POINTS,
  buildAnalyticsSummary,
  finalizeAnalyticsResponse,
  resolveAnalyticsAggregation,
  resolveAnalyticsResolution,
} from "./analytics.js";
import type { HybridArchiveReadState } from "./timeseries/read-facade.js";
import type {
  MeasurementAnalyticsResolution,
  MeasurementAnalyticsRollupQuery,
  MeasurementAnalyticsRollupResult,
  MeasurementAnalyticsSeriesRecord,
} from "./timeseries/types.js";

const RESOLUTION_SECONDS: Readonly<Record<MeasurementAnalyticsResolution, number>> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3_600,
  "1d": 86_400,
};

export interface PlanAnalyticsRollupInput {
  request: AnalyticsQueryRequest;
  definitions: MeasurementDefinition[];
  entities: Array<{ id: string; label: string }>;
}

/**
 * Validates a bucketed query before touching source rows and produces the
 * bounded archive query. Raw requests deliberately return null.
 */
export function planAnalyticsRollup(
  input: PlanAnalyticsRollupInput,
): Omit<MeasurementAnalyticsRollupQuery, "excludeSynthetic"> | null {
  const maxPoints = input.request.maxPointsPerSeries ?? 800;
  const resolution = resolveAnalyticsResolution(
    input.request.resolution,
    input.request.range.start,
    input.request.range.end,
    maxPoints,
  );
  if (resolution === "raw") return null;
  const start = Date.parse(input.request.range.start);
  const end = Date.parse(input.request.range.end);
  const bucketMs = RESOLUTION_SECONDS[resolution] * 1_000;
  const bucketCount = Math.ceil((end - Math.floor(start / bucketMs) * bucketMs) / bucketMs);
  if (bucketCount > maxPoints) {
    throw new AnalyticsQueryError(
      422,
      "ANALYTICS_POINT_LIMIT_EXCEEDED",
      `The selected resolution would return ${bucketCount} points per series; choose automatic resolution or a shorter range`,
    );
  }
  const projectedOutputPoints = bucketCount * input.entities.length * input.request.measurementIds.length;
  if (projectedOutputPoints > MAX_INTERACTIVE_OUTPUT_POINTS) {
    throw new AnalyticsQueryError(
      422,
      "ANALYTICS_QUERY_TOO_LARGE",
      `The interactive response would exceed ${MAX_INTERACTIVE_OUTPUT_POINTS} points; reduce the entity, measurement, or time scope`,
    );
  }

  const definitions = new Map(input.definitions.map((definition) => [definition.id, definition]));
  const series = input.entities.flatMap((entity) => input.request.measurementIds.map((measurementId) => {
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
    return {
      sensorId: entity.id,
      metric: measurementId,
      aggregation: resolveAnalyticsAggregation(definition, input.request.aggregation),
    };
  }));
  return {
    series,
    from: input.request.range.start,
    to: input.request.range.end,
    resolution,
    qualities: input.request.qualityFilter?.include ?? ["good", "estimated", "stale"],
  };
}

function rollupPoints(
  series: MeasurementAnalyticsSeriesRecord | undefined,
  start: number,
  end: number,
  resolution: MeasurementAnalyticsResolution,
): AnalyticsPoint[] {
  const bucketMs = RESOLUTION_SECONDS[resolution] * 1_000;
  const firstBucket = Math.floor(start / bucketMs) * bucketMs;
  const cadenceSeconds = Math.max(1, series?.cadenceSeconds ?? 60);
  const expectedPerBucket = Math.max(1, bucketMs / 1_000 / cadenceSeconds);
  const byBucket = new Map((series?.buckets ?? []).map((bucket) => [Date.parse(bucket.bucketStart), bucket]));
  const points: AnalyticsPoint[] = [];
  for (let timestamp = firstBucket; timestamp < end; timestamp += bucketMs) {
    const bucket = byBucket.get(timestamp);
    const coverage = Math.min(1, (bucket?.sampleCount ?? 0) / expectedPerBucket);
    const flags = new Set<QualityFlag>();
    if (!bucket || bucket.value === null) flags.add("missing");
    if ((bucket?.estimatedSampleCount ?? 0) > 0) flags.add("source_estimated");
    if ((bucket?.staleSampleCount ?? 0) > 0) flags.add("stale");
    if ((bucket?.counterResetCount ?? 0) > 0) flags.add("counter_reset");
    if (coverage < 0.75) flags.add("low_coverage");
    points.push({
      timestamp: new Date(timestamp).toISOString(),
      value: bucket?.value ?? null,
      minimum: bucket?.minimum ?? null,
      maximum: bucket?.maximum ?? null,
      sampleCount: bucket?.sampleCount ?? 0,
      coverage,
      qualityFlags: [...flags],
    });
  }
  return points;
}

export interface BuildAnalyticsRollupResponseInput extends PlanAnalyticsRollupInput {
  rollup: MeasurementAnalyticsRollupResult;
  archiveState: HybridArchiveReadState;
  generatedAt?: string;
}

export function buildAnalyticsResponseFromRollup(
  input: BuildAnalyticsRollupResponseInput,
): AnalyticsQueryResponse {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const plan = planAnalyticsRollup(input);
  if (!plan) {
    throw new AnalyticsQueryError(422, "RAW_ROLLUP_NOT_ALLOWED", "Raw analytics requests require source observations");
  }
  const start = Date.parse(input.request.range.start);
  const end = Date.parse(input.request.range.end);
  const definitions = new Map(input.definitions.map((definition) => [definition.id, definition]));
  const records = new Map(input.rollup.series.map((series) => [
    JSON.stringify([series.sensorId, series.metric]),
    series,
  ]));
  const aggregationBySeries = new Map(plan.series.map((series) => [
    JSON.stringify([series.sensorId, series.metric]),
    series.aggregation,
  ]));
  const series: AnalyticsSeries[] = [];
  for (const entity of input.entities) {
    for (const measurementId of input.request.measurementIds) {
      const definition = definitions.get(measurementId)!;
      const key = JSON.stringify([entity.id, measurementId]);
      const record = records.get(key);
      const aggregation = aggregationBySeries.get(key)!;
      const points = rollupPoints(record, start, end, plan.resolution);
      const provenance = {
        algorithmKey: "analytics-bucket-rollup",
        algorithmVersion: "1.0.0",
        generatedAt,
        inputStart: input.request.range.start,
        inputEnd: input.request.range.end,
        sourceIds: record && record.sampleCount > 0 ? [entity.id] : [],
        archiveState: input.archiveState,
      };
      series.push({
        entityId: entity.id,
        entityLabel: entity.label,
        measurementId,
        canonicalUnit: definition.unit,
        truthClass: "derived",
        aggregation,
        resolution: plan.resolution,
        points,
        summary: buildAnalyticsSummary(
          entity.id,
          measurementId,
          definition.unit,
          points,
          record?.sampleCount ?? 0,
        ),
        provenance,
      });
    }
  }
  return finalizeAnalyticsResponse({
    request: input.request,
    resolution: plan.resolution,
    series,
    archiveState: input.archiveState,
    excludedSampleCount: input.rollup.series.reduce((sum, item) => sum + item.excludedSampleCount, 0),
    includedQualities: [...plan.qualities] as AnalyticsSampleQuality[],
    generatedAt,
  });
}
