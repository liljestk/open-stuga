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
} from "../../analytics-rollup.js";
import type { HybridTelemetryReader } from "../../timeseries/read-facade.js";

const DEFAULT_SOURCE_POINT_LIMIT = 250_000;

export interface ExecuteAnalyticsQueryInput {
  request: AnalyticsQueryRequest;
  sensors: readonly Sensor[];
  definitions: readonly MeasurementDefinition[];
  telemetryReader: HybridTelemetryReader;
  generatedAt: string;
  sourcePointLimit?: number;
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
      return buildAnalyticsResponseFromRollup({
        request: input.request,
        definitions: [...input.definitions],
        entities,
        plan: rollupPlan,
        rollup: rollup.result,
        archiveState: rollup.archiveState,
        generatedAt: input.generatedAt,
      });
    }
  }
  const sourcePointLimit = input.sourcePointLimit ?? DEFAULT_SOURCE_POINT_LIMIT;
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
    definitions: [...input.definitions],
    entities,
    archiveState: read.provenance.archiveState,
    generatedAt: input.generatedAt,
  });
}
