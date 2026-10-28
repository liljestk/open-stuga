import {
  openingObservationEffectiveUntil,
  openingObservationState,
  type House,
  type OpeningActivitySeries,
  type OpeningActivityTarget,
  type OpeningState,
  type OpeningStateBinding,
  type OpeningStateObservation,
} from "@climate-twin/contracts";
import { compareCodeUnits } from "../../text-order.js";

interface OpeningTargetModel {
  target: OpeningActivityTarget;
  binding: OpeningStateBinding | undefined;
}

interface NormalizedObservation {
  observation: OpeningStateObservation;
  timestamp: number;
  state: OpeningState;
}

export function openingActivityTargets(house: House): OpeningTargetModel[] {
  return house.floors.flatMap((floor) => {
    let doorOrdinal = 0;
    let windowOrdinal = 0;
    return (floor.planElements ?? []).flatMap((element) => {
      if (element.kind !== "door" && element.kind !== "window") return [];
      const ordinal = element.kind === "door" ? ++doorOrdinal : ++windowOrdinal;
      if ((element.kind === "door" && element.variant === "open-passage")
        || (element.kind === "window" && element.variant === "fixed")) return [];
      return [{
        target: {
          key: `${floor.id}:${element.id}`,
          floorId: floor.id,
          floorName: floor.name,
          elementId: element.id,
          kind: element.kind,
          label: element.label?.trim() || null,
          ordinal,
        },
        binding: element.stateBinding,
      }];
    });
  });
}

function selectedObservations(
  target: OpeningTargetModel,
  observations: readonly OpeningStateObservation[],
): OpeningStateObservation[] {
  const matchingElement = observations.filter((observation) => (
    observation.floorId === target.target.floorId
    && observation.elementId === target.target.elementId
  ));
  if (target.binding) {
    return matchingElement.filter((observation) => (
      observation.source === target.binding?.provider
      && observation.externalId === target.binding.externalId
      && (!target.binding.connectionId
        || observation.connectionId === target.binding.connectionId)
    ));
  }
  const api = matchingElement.filter((observation) => observation.source === "api");
  return api.length > 0
    ? api
    : matchingElement.filter((observation) => observation.source === "manual");
}

function normalizedObservations(
  target: OpeningTargetModel,
  observations: readonly OpeningStateObservation[],
  to: number,
): NormalizedObservation[] {
  const byIdentityAndTime = new Map<string, NormalizedObservation>();
  for (const observation of selectedObservations(target, observations)) {
    const timestamp = Date.parse(observation.observedAt);
    if (!Number.isFinite(timestamp) || timestamp > to) continue;
    const key = [
      observation.source,
      observation.externalId ?? "",
      observation.connectionId ?? "",
      timestamp,
    ].join("\u0000");
    const item = {
      observation,
      timestamp,
      state: openingObservationState(observation, target.binding),
    };
    const previous = byIdentityAndTime.get(key);
    if (!previous || compareCodeUnits(previous.observation.id, observation.id) < 0) {
      byIdentityAndTime.set(key, item);
    }
  }
  return [...byIdentityAndTime.values()].sort((left, right) => (
    left.timestamp - right.timestamp
    || compareCodeUnits(left.observation.id, right.observation.id)
  ));
}

function mergeSegments(
  segments: OpeningActivitySeries["segments"],
): OpeningActivitySeries["segments"] {
  const merged: OpeningActivitySeries["segments"] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (previous && previous.state === segment.state
      && Date.parse(segment.startedAt) <= Date.parse(previous.endedAt)) {
      if (segment.endedAt > previous.endedAt) previous.endedAt = segment.endedAt;
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
): OpeningActivitySeries["segments"] {
  const segments = items.flatMap((item, index) => {
    if (item.state === "unknown") return [];
    const nextTimestamp = items[index + 1]?.timestamp ?? Number.POSITIVE_INFINITY;
    const effectiveUntil = openingObservationEffectiveUntil(
      item.observation,
      binding,
      nextTimestamp,
    );
    const startedAt = Math.max(from, item.timestamp);
    const endedAt = Math.min(to, effectiveUntil);
    return endedAt > startedAt
      ? [{
          state: item.state,
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
        }]
      : [];
  });
  return mergeSegments(segments);
}

function stateRecords(
  items: readonly NormalizedObservation[],
  binding: OpeningStateBinding | undefined,
  from: number,
  to: number,
): Pick<OpeningActivitySeries, "records" | "openedCount" | "closedCount"> {
  const records: OpeningActivitySeries["records"] = [];
  let previous: NormalizedObservation | null = null;
  let openedCount = 0;
  let closedCount = 0;
  for (const item of items) {
    const previousEffective = previous !== null
      && previous.state !== "unknown"
      && item.timestamp < openingObservationEffectiveUntil(previous.observation, binding);
    const changed = !previousEffective || item.state !== previous?.state;
    if (changed && item.timestamp >= from && item.timestamp < to) {
      const transition = item.state === "unknown"
        ? "unknown"
        : previousEffective && previous?.state === "closed" && item.state === "open"
          ? "opened"
          : previousEffective && previous?.state === "open" && item.state === "closed"
            ? "closed"
            : "initial";
      if (transition === "opened") openedCount += 1;
      if (transition === "closed") closedCount += 1;
      records.push({
        id: item.observation.id,
        observedAt: item.observation.observedAt,
        state: item.state,
        source: item.observation.source,
        transition,
      });
    }
    previous = item;
  }
  return { records, openedCount, closedCount };
}

function deriveSeries(
  target: OpeningTargetModel,
  observations: readonly OpeningStateObservation[],
  from: number,
  to: number,
): OpeningActivitySeries | null {
  const items = normalizedObservations(target, observations, to);
  if (!target.binding && items.length === 0) return null;
  const segments = timelineSegments(items, target.binding, from, to);
  const records = stateRecords(items, target.binding, from, to);
  const last = items.at(-1);
  const lastEffectiveUntil = last
    ? openingObservationEffectiveUntil(last.observation, target.binding)
    : Number.NEGATIVE_INFINITY;
  const currentState = last
    && last.state !== "unknown"
    && last.timestamp <= to
    && to < lastEffectiveUntil
    ? last.state
    : "unknown";
  const currentSegment = currentState === "unknown"
    ? undefined
    : [...segments].reverse().find((segment) => (
        segment.state === currentState && Date.parse(segment.endedAt) >= to
      ));
  const openSegments = segments.filter((segment) => segment.state === "open");
  return {
    target: target.target,
    segments,
    records: records.records,
    observationCount: items.filter((item) => item.timestamp >= from && item.timestamp < to).length,
    openedCount: records.openedCount,
    closedCount: records.closedCount,
    confirmedOpenMs: openSegments.reduce((sum, segment) => (
      sum + Date.parse(segment.endedAt) - Date.parse(segment.startedAt)
    ), 0),
    longestOpenMs: openSegments.reduce((longest, segment) => (
      Math.max(longest, Date.parse(segment.endedAt) - Date.parse(segment.startedAt))
    ), 0),
    currentState,
    currentSince: currentSegment?.startedAt ?? null,
    lastObservedAt: last?.observation.observedAt ?? null,
  };
}

export function deriveOpeningActivity(
  house: House,
  observations: readonly OpeningStateObservation[],
  from: string,
  to: string,
  elementIds?: readonly string[],
): OpeningActivitySeries[] {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new RangeError("Opening activity requires a valid half-open range");
  }
  const selected = elementIds ? new Set(elementIds) : null;
  return openingActivityTargets(house)
    .filter((target) => !selected || selected.has(target.target.elementId))
    .flatMap((target) => {
      const series = deriveSeries(target, observations, fromMs, toMs);
      return series ? [series] : [];
    });
}
