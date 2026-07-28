import type {
  OpeningState,
  OpeningStateBinding,
  OpeningStateObservation,
  OpeningStateSource,
} from "@climate-twin/contracts";

const DEFAULT_PROVIDER_STALE_MS = 15 * 60_000;

export interface OpeningAnalyticsTarget {
  key: string;
  floorId: string;
  floorName: string;
  elementId: string;
  kind: "door" | "window";
  label: string;
  binding: OpeningStateBinding | undefined;
}

export interface OpeningTimelineSegment {
  state: Exclude<OpeningState, "unknown">;
  startedAt: number;
  endedAt: number;
}

export interface OpeningStateRecord {
  id: string;
  observedAt: number;
  state: OpeningState;
  source: OpeningStateSource;
  transition: "opened" | "closed" | "unknown" | "initial";
}

export interface OpeningAnalyticsSeries {
  target: OpeningAnalyticsTarget;
  segments: OpeningTimelineSegment[];
  records: OpeningStateRecord[];
  observationCount: number;
  openedCount: number;
  closedCount: number;
  confirmedOpenMs: number;
  longestOpenMs: number;
  currentState: OpeningState;
  currentSince: number | null;
  lastObservedAt: number | null;
}

interface NormalizedObservation {
  observation: OpeningStateObservation;
  timestamp: number;
  state: OpeningState;
}

function matchingObservations(
  target: OpeningAnalyticsTarget,
  observations: readonly OpeningStateObservation[],
): OpeningStateObservation[] {
  const matchingElement = observations.filter((observation) => (
    observation.floorId === target.floorId && observation.elementId === target.elementId
  ));
  if (target.binding) {
    return matchingElement.filter((observation) => (
      observation.source === target.binding?.provider
      && observation.externalId === target.binding.externalId
      && (target.binding.connectionId === undefined
        || observation.connectionId === target.binding.connectionId)
    ));
  }
  const api = matchingElement.filter((observation) => observation.source === "api");
  return api.length > 0
    ? api
    : matchingElement.filter((observation) => observation.source === "manual");
}

function normalizedState(state: OpeningState, binding: OpeningStateBinding | undefined): OpeningState {
  if (!binding?.invert || state === "unknown") return state;
  return state === "open" ? "closed" : "open";
}

function normalizedObservations(
  target: OpeningAnalyticsTarget,
  observations: readonly OpeningStateObservation[],
  to: number,
): NormalizedObservation[] {
  return matchingObservations(target, observations)
    .flatMap((observation) => {
      const timestamp = Date.parse(observation.observedAt);
      return Number.isFinite(timestamp) && timestamp <= to
        ? [{ observation, timestamp, state: normalizedState(observation.state, target.binding) }]
        : [];
    })
    .sort((left, right) => (
      left.timestamp - right.timestamp || left.observation.id.localeCompare(right.observation.id)
    ));
}

function observationValidUntil(
  item: NormalizedObservation,
  binding: OpeningStateBinding | undefined,
): number {
  const declared = item.observation.validUntil
    ? Date.parse(item.observation.validUntil)
    : Number.POSITIVE_INFINITY;
  if (item.observation.validUntil && !Number.isFinite(declared)) return item.timestamp;
  if (!binding) return declared;
  const staleMs = Math.max(1_000, (binding.staleAfterSeconds ?? DEFAULT_PROVIDER_STALE_MS / 1_000) * 1_000);
  return Math.min(declared, item.timestamp + staleMs);
}

function mergeSegments(segments: OpeningTimelineSegment[]): OpeningTimelineSegment[] {
  const merged: OpeningTimelineSegment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (previous && previous.state === segment.state && segment.startedAt <= previous.endedAt) {
      previous.endedAt = Math.max(previous.endedAt, segment.endedAt);
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

function timelineSegments(
  items: readonly NormalizedObservation[],
  binding: OpeningStateBinding | undefined,
  from: number,
  to: number,
): OpeningTimelineSegment[] {
  const segments = items.flatMap((item, index) => {
    if (item.state === "unknown") return [];
    const nextTimestamp = items[index + 1]?.timestamp ?? to;
    const startedAt = Math.max(from, item.timestamp);
    const endedAt = Math.min(to, nextTimestamp, observationValidUntil(item, binding));
    return endedAt > startedAt
      ? [{ state: item.state, startedAt, endedAt }]
      : [];
  });
  return mergeSegments(segments);
}

function stateRecords(
  items: readonly NormalizedObservation[],
  from: number,
  to: number,
): Pick<OpeningAnalyticsSeries, "records" | "openedCount" | "closedCount"> {
  const records: OpeningStateRecord[] = [];
  let previous: OpeningState | null = null;
  let openedCount = 0;
  let closedCount = 0;
  for (const item of items) {
    const changed = item.state !== previous;
    if (changed && item.timestamp >= from && item.timestamp <= to) {
      const transition = item.state === "unknown"
        ? "unknown"
        : previous === "closed" && item.state === "open"
          ? "opened"
          : previous === "open" && item.state === "closed"
            ? "closed"
            : "initial";
      if (transition === "opened") openedCount += 1;
      if (transition === "closed") closedCount += 1;
      records.push({
        id: item.observation.id,
        observedAt: item.timestamp,
        state: item.state,
        source: item.observation.source,
        transition,
      });
    }
    previous = item.state;
  }
  return { records, openedCount, closedCount };
}

export function deriveOpeningAnalytics(
  targets: readonly OpeningAnalyticsTarget[],
  observations: readonly OpeningStateObservation[],
  from: number,
  to: number,
): OpeningAnalyticsSeries[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  return targets.flatMap((target) => {
    const items = normalizedObservations(target, observations, to);
    if (!target.binding && items.length === 0) return [];
    const segments = timelineSegments(items, target.binding, from, to);
    const records = stateRecords(items, from, to);
    const last = items.at(-1);
    const currentState = last
      && last.state !== "unknown"
      && observationValidUntil(last, target.binding) >= to
      ? last.state
      : "unknown";
    const currentSegment = currentState === "unknown"
      ? undefined
      : [...segments].reverse().find((segment) => segment.state === currentState && segment.endedAt >= to);
    const openSegments = segments.filter((segment) => segment.state === "open");
    return [{
      target,
      segments,
      records: records.records,
      observationCount: items.filter((item) => item.timestamp >= from).length,
      openedCount: records.openedCount,
      closedCount: records.closedCount,
      confirmedOpenMs: openSegments.reduce((sum, segment) => sum + segment.endedAt - segment.startedAt, 0),
      longestOpenMs: openSegments.reduce((longest, segment) => (
        Math.max(longest, segment.endedAt - segment.startedAt)
      ), 0),
      currentState,
      currentSince: currentSegment?.startedAt ?? null,
      lastObservedAt: last?.timestamp ?? null,
    }];
  });
}
