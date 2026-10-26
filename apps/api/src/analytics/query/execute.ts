import type {
  AnalyticsQueryRequest,
  AnalyticsQueryResponse,
  MeasurementDefinition,
  Sensor,
} from "@climate-twin/contracts";
import {
  AnalyticsQueryError,
  buildAnalyticsResponse,
} from "../../analytics.js";
import {
  buildAnalyticsResponseFromRollup,
  planAnalyticsRollup,
  planSummaryRollup,
} from "../../analytics-rollup.js";
import type { HybridTelemetryReader } from "../../timeseries/read-facade.js";
import { mapWithConcurrency } from "../../timeseries/read-support.js";

const DEFAULT_SOURCE_POINT_LIMIT = 250_000;

export interface ExecuteAnalyticsQueryInput {
  request: AnalyticsQueryRequest;
  sensors: readonly Sensor[];
  definitions: readonly MeasurementDefinition[];
  telemetryReader: HybridTelemetryReader;
  generatedAt: string;
  sourcePointLimit?: number;
  /** Long-run reporting interval per series key (`analyticsSeriesKey`), for coverage. */
  expectedIntervalSeconds?: ReadonlyMap<string, number>;
  signal?: AbortSignal;
}

export async function executeAnalyticsQuery(
  input: ExecuteAnalyticsQueryInput,
): Promise<AnalyticsQueryResponse> {
  const entities = input.sensors.map((sensor) => ({ id: sensor.id, label: sensor.name }));
  const rollupPlan = planAnalyticsRollup({
    request: input.request,
    definitions: [...input.definitions],
    entities,
  });
  if (rollupPlan) {
    const rollup = await input.telemetryReader.measurementAnalyticsRollup({
      ...rollupPlan,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (rollup) {
      const summaryPlan = planSummaryRollup(rollupPlan);
      // Summaries are supporting statistics: a base read that is still
      // materializing or fails leaves them on the displayed points.
      const summaryRead = summaryPlan
        ? await input.telemetryReader.measurementAnalyticsRollup({
          ...summaryPlan,
          ...(input.signal ? { signal: input.signal } : {}),
        }).catch((error: unknown) => {
          if (input.signal?.aborted) throw error;
          return null;
        })
        : null;
      return buildAnalyticsResponseFromRollup({
        request: input.request,
        definitions: [...input.definitions],
        entities,
        plan: rollupPlan,
        rollup: rollup.result,
        summaryRollup: summaryPlan && summaryRead ? { resolution: summaryPlan.resolution, result: summaryRead.result } : null,
        ...(input.expectedIntervalSeconds ? { expectedIntervalSeconds: input.expectedIntervalSeconds } : {}),
        archiveState: rollup.archiveState,
        generatedAt: input.generatedAt,
      });
    }
  }
  const sourcePointLimit = input.sourcePointLimit ?? DEFAULT_SOURCE_POINT_LIMIT;
  const boundaryReads = input.request.resolution === "raw" ? [] : await mapWithConcurrency(
    input.sensors.flatMap((sensor) => input.definitions.flatMap((definition) =>
      definition.id === "energy" || definition.id === "power" ? [{ sensor, metric: definition.id }] : [])),
    4,
    async ({ sensor, metric }) => input.telemetryReader.measurementBoundarySamples({
      sensorId: sensor.id, metric: metric as "energy" | "power",
      from: input.request.range.start, to: input.request.range.end,
      qualities: input.request.qualityFilter?.include ?? ["good", "estimated", "stale"],
      ...(input.signal ? { signal: input.signal } : {}),
    }),
  );
  const read = await input.telemetryReader.measurementWindow({
    sensorIds: input.sensors.map((sensor) => sensor.id),
    metrics: input.definitions.map((definition) => definition.id),
    from: input.request.range.start,
    to: new Date(Date.parse(input.request.range.end) - 1).toISOString(),
    limit: sourcePointLimit,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (read.records.length >= sourcePointLimit) {
    throw new AnalyticsQueryError(
      422,
      "ANALYTICS_SOURCE_POINT_LIMIT_EXCEEDED",
      `The source window reached the ${sourcePointLimit}-point limit`,
    );
  }
  return buildAnalyticsResponse({
    request: input.request,
    samples: read.records,
    ...(input.expectedIntervalSeconds ? { expectedIntervalSeconds: input.expectedIntervalSeconds } : {}),
    consumptionBoundarySamples: boundaryReads.flatMap((boundary) => boundary?.records ?? []),
    definitions: [...input.definitions],
    entities,
    archiveState: boundaryReads.some((boundary) => boundary?.provenance.archiveState === "failed") ? "failed"
      : boundaryReads.some((boundary) => boundary?.provenance.archiveState === "not-ready") ? "not-ready"
      : read.provenance.archiveState,
    generatedAt: input.generatedAt,
  });
}
