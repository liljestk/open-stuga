import {
  OPENING_ACTIVITY_ALGORITHM_VERSION,
  type House,
  type OpeningActivityRequest,
  type OpeningActivityResponse,
  type OpeningStateObservation,
} from "@climate-twin/contracts";
import type { HybridTelemetryReader } from "../../timeseries/read-facade.js";
import { deriveOpeningActivity } from "../temporal/opening-intervals.js";

const OPENING_ACTIVITY_LIMIT = 10_000;

export interface OpeningActivityServiceInput {
  house: House;
  request: OpeningActivityRequest;
  telemetryReader: HybridTelemetryReader;
  generatedAt: string;
  signal?: AbortSignal;
}

function mergeObservations(
  initial: readonly OpeningStateObservation[],
  history: readonly OpeningStateObservation[],
): OpeningStateObservation[] {
  return [...new Map([...initial, ...history].map((item) => [item.id, item])).values()]
    .sort((left, right) => (
      left.observedAt.localeCompare(right.observedAt)
      || left.id.localeCompare(right.id)
    ))
    .slice(-OPENING_ACTIVITY_LIMIT);
}

export async function getOpeningActivity(
  input: OpeningActivityServiceInput,
): Promise<OpeningActivityResponse> {
  const initial = await input.telemetryReader.openingStateSnapshot({
    houseId: input.house.id,
    at: input.request.range.start,
    limit: OPENING_ACTIVITY_LIMIT,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const remaining = Math.max(
    1,
    OPENING_ACTIVITY_LIMIT - Math.min(initial.records.length, OPENING_ACTIVITY_LIMIT - 1),
  );
  const history = await input.telemetryReader.openingStateHistory({
    houseId: input.house.id,
    from: input.request.range.start,
    to: input.request.range.end,
    limit: remaining,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const observations = mergeObservations(initial.records, history.records);
  const truncated = initial.records.length >= OPENING_ACTIVITY_LIMIT
    || history.records.length >= remaining;
  const archiveState = history.provenance.archiveState === "merged"
    ? "merged"
    : initial.provenance.archiveState;
  return {
    apiVersion: "1.0",
    requestId: input.request.requestId,
    houseId: input.house.id,
    dataMode: input.request.dataMode,
    range: input.request.range,
    generatedAt: input.generatedAt,
    complete: !truncated,
    truncated,
    archiveState,
    series: deriveOpeningActivity(
      input.house,
      observations,
      input.request.range.start,
      input.request.range.end,
      input.request.elementIds,
    ),
    warnings: truncated
      ? [{
          code: "OPENING_ACTIVITY_TRUNCATED",
          message: "Opening activity reached the server evidence limit.",
          details: { limit: OPENING_ACTIVITY_LIMIT },
        }]
      : [],
    provenance: {
      algorithmKey: "opening-activity",
      algorithmVersion: OPENING_ACTIVITY_ALGORITHM_VERSION,
      evaluatedAt: input.request.range.end,
      sourceIds: [...new Set(observations.map((item) => item.source))].sort(),
      archiveState,
    },
  };
}
