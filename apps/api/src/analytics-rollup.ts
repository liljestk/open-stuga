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
  analyticsMeasurementDefinition,
  analyticsSeriesKey,
  buildAnalyticsSummary,
  finalizeAnalyticsResponse,
  analyticsResolutionSeconds,
  resolveAnalyticsAggregation,
  resolveAnalyticsQueryShape,
} from "./analytics.js";
import type { HybridArchiveReadState } from "./timeseries/read-facade.js";
import type {
  MeasurementAnalyticsAggregation,
  MeasurementAnalyticsResolution,
  MeasurementAnalyticsRollupQuery,
  MeasurementAnalyticsRollupResult,
  MeasurementAnalyticsSeriesRecord,
} from "./timeseries/types.js";

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
  const shape = resolveAnalyticsQueryShape({
    request: input.request,
    entityCount: input.entities.length,
  });
  if (shape.resolution === "raw") return null;
  const definitions = new Map(input.definitions.map((definition) => [definition.id, definition]));
  const series = input.entities.flatMap((entity) => input.request.measurementIds.map((measurementId) => ({
    sensorId: entity.id,
    metric: measurementId,
    aggregation: resolveAnalyticsAggregation(
      analyticsMeasurementDefinition(definitions, measurementId),
      input.request.aggregation,
    ),
  })));
  return {
    series,
    from: input.request.range.start,
    to: input.request.range.end,
    resolution: shape.resolution,
    qualities: input.request.qualityFilter?.include ?? ["good", "estimated", "stale"],
  };
}

function rollupPoints(
  series: MeasurementAnalyticsSeriesRecord | undefined,
  start: number,
  end: number,
  resolution: MeasurementAnalyticsResolution,
  aggregation: MeasurementAnalyticsAggregation,
): AnalyticsPoint[] {
  const bucketMs = analyticsResolutionSeconds(resolution) * 1_000;
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
    // Stored states count every decrease; only a counter's decrease is a reset.
    if (aggregation === "delta" && (bucket?.counterResetCount ?? 0) > 0) flags.add("counter_reset");
    if (coverage < 0.75) flags.add("low_coverage");
    points.push({
      timestamp: new Date(timestamp).toISOString(),
      value: bucket?.value ?? null,
      ...(bucket?.consumptionKwh !== undefined ? { consumptionKwh: bucket.consumptionKwh } : {}),
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
  /**
   * The plan `planAnalyticsRollup` produced for this exact request. Passing it
   * in keeps the admission guards from running a second time per request and
   * guarantees the response is described by the plan the archive actually ran.
   */
  plan: Omit<MeasurementAnalyticsRollupQuery, "excludeSynthetic">;
  rollup: MeasurementAnalyticsRollupResult;
  archiveState: HybridArchiveReadState;
  generatedAt?: string;
}

export function buildAnalyticsResponseFromRollup(
  input: BuildAnalyticsRollupResponseInput,
): AnalyticsQueryResponse {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const plan = input.plan;
  const start = Date.parse(input.request.range.start);
  const end = Date.parse(input.request.range.end);
  const definitions = new Map(input.definitions.map((definition) => [definition.id, definition]));
  const records = new Map(input.rollup.series.map((series) => [
    analyticsSeriesKey(series.sensorId, series.metric),
    series,
  ]));
  const aggregationBySeries = new Map(plan.series.map((series) => [
    analyticsSeriesKey(series.sensorId, series.metric),
    series.aggregation,
  ]));
  const series: AnalyticsSeries[] = [];
  for (const entity of input.entities) {
    for (const measurementId of input.request.measurementIds) {
      const definition = definitions.get(measurementId)!;
      const key = analyticsSeriesKey(entity.id, measurementId);
      const record = records.get(key);
      const aggregation = aggregationBySeries.get(key)!;
      const points = rollupPoints(record, start, end, plan.resolution, aggregation);
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
