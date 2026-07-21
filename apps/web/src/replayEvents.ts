import type { MeasurementSample } from "@climate-twin/contracts";
import type { MeasurementHistory } from "./measurements";

export type ReplayClimateMetric = "temperature" | "humidity";
export type ReplayClimateDirection = "rise" | "drop";
export type ReplayClimateEventSignificance = "major" | "notable";
export type ReplayClimateEventAutoTag = ReplayClimateMetric | ReplayClimateDirection | ReplayClimateEventSignificance;

export interface ReplayClimateEvent {
  id: string;
  kind: "climate";
  timestamp: number;
  sensorId: string;
  metric: ReplayClimateMetric;
  direction: ReplayClimateDirection;
  before: number;
  after: number;
  delta: number;
  score: number;
  /** Additive fields are optional so callers with stored or hand-built legacy events remain compatible. */
  significance?: ReplayClimateEventSignificance;
  autoTags?: ReplayClimateEventAutoTag[];
}

export interface ReplayClimateEventOptions {
  maxEvents?: number;
  /** Inclusive UTC epoch-millisecond bounds for the history that is actually loaded for replay. */
  from?: number;
  to?: number;
}

interface MetricConfig {
  metric: ReplayClimateMetric;
  threshold: number;
}

interface SeriesPoint {
  timestamp: number;
  value: number;
}

interface EventCandidate {
  boundary: number;
  before: number;
  after: number;
  delta: number;
  score: number;
  direction: ReplayClimateDirection;
}

const MINUTE_MS = 60_000;
const BUCKET_MS = 5 * MINUTE_MS;
const WINDOW_MS = 45 * MINUTE_MS;
const MIN_SUPPORT_BUCKETS = 2;
const MIN_CONTINUITY_MS = 20 * MINUTE_MS;
const MAX_CONTINUITY_MS = 60 * MINUTE_MS;
const CLUSTER_GAP_MS = 60 * MINUTE_MS;
const SUSTAINED_FRACTION = 0.75;
const DEFAULT_MAX_EVENTS = 24;
const ABSOLUTE_MAX_EVENTS = 100;
const MAJOR_SCORE_THRESHOLD = 2;

const METRICS: readonly MetricConfig[] = [
  { metric: "temperature", threshold: 1.5 },
  { metric: "humidity", threshold: 8 },
];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]!
    : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function normalizeSeries(
  samples: readonly MeasurementSample[],
  sensorId: string,
  metric: ReplayClimateMetric,
  from: number,
  to: number,
): SeriesPoint[] {
  const valuesByTimestamp = new Map<number, number[]>();
  for (const sample of samples) {
    const timestamp = Date.parse(sample.timestamp);
    if (sample.sensorId !== sensorId || sample.metric !== metric || sample.quality === "stale"
      || !Number.isFinite(timestamp) || timestamp < from || timestamp > to || !Number.isFinite(sample.value)) continue;
    const values = valuesByTimestamp.get(timestamp);
    if (values) values.push(sample.value);
    else valuesByTimestamp.set(timestamp, [sample.value]);
  }
  return [...valuesByTimestamp.entries()]
    .map(([timestamp, values]) => ({ timestamp, value: median(values) }))
    .sort((left, right) => left.timestamp - right.timestamp);
}

function bucketSeries(points: readonly SeriesPoint[]): SeriesPoint[] {
  const valuesByBucket = new Map<number, number[]>();
  for (const point of points) {
    const bucket = Math.floor(point.timestamp / BUCKET_MS) * BUCKET_MS;
    const values = valuesByBucket.get(bucket);
    if (values) values.push(point.value);
    else valuesByBucket.set(bucket, [point.value]);
  }
  return [...valuesByBucket.entries()]
    .map(([timestamp, values]) => ({ timestamp, value: median(values) }))
    .sort((left, right) => left.timestamp - right.timestamp);
}

function typicalCadence(points: readonly SeriesPoint[]): number {
  const gaps = points.slice(1).flatMap((point, index) => {
    const gap = point.timestamp - points[index]!.timestamp;
    return gap > 0 ? [gap] : [];
  });
  return gaps.length ? median(gaps) : MIN_CONTINUITY_MS;
}

function continuityLimit(points: readonly SeriesPoint[]): number {
  return Math.min(MAX_CONTINUITY_MS, Math.max(MIN_CONTINUITY_MS, typicalCadence(points) * 3));
}

function windowsAt(buckets: readonly SeriesPoint[], index: number): {
  before: SeriesPoint[];
  after: SeriesPoint[];
} {
  const boundary = buckets[index]!.timestamp;
  const before: SeriesPoint[] = [];
  const after: SeriesPoint[] = [];
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const point = buckets[cursor]!;
    if (point.timestamp < boundary - WINDOW_MS) break;
    before.push(point);
  }
  before.reverse();
  for (let cursor = index; cursor < buckets.length; cursor += 1) {
    const point = buckets[cursor]!;
    if (point.timestamp >= boundary + WINDOW_MS) break;
    after.push(point);
  }
  return { before, after };
}

function hasUnsupportedGap(points: readonly SeriesPoint[], maximumGap: number): boolean {
  return points.slice(1).some((point, index) => point.timestamp - points[index]!.timestamp > maximumGap);
}

function isSustained(
  after: readonly SeriesPoint[],
  baseline: number,
  direction: ReplayClimateDirection,
  threshold: number,
): boolean {
  const evidenceBoundary = baseline + (direction === "rise" ? 1 : -1) * threshold * SUSTAINED_FRACTION;
  const supporting = after.filter((point) => direction === "rise"
    ? point.value >= evidenceBoundary
    : point.value <= evidenceBoundary);
  return supporting.length >= MIN_SUPPORT_BUCKETS;
}

function candidatesForSeries(points: readonly SeriesPoint[], threshold: number): EventCandidate[] {
  const buckets = bucketSeries(points);
  const maximumGap = continuityLimit(points);
  const candidates: EventCandidate[] = [];
  for (let index = 0; index < buckets.length; index += 1) {
    const boundary = buckets[index]!.timestamp;
    const { before: beforePoints, after: afterPoints } = windowsAt(buckets, index);
    if (beforePoints.length < MIN_SUPPORT_BUCKETS || afterPoints.length < MIN_SUPPORT_BUCKETS) continue;
    if (hasUnsupportedGap([...beforePoints, ...afterPoints], maximumGap)) continue;

    const before = median(beforePoints.map((point) => point.value));
    const after = median(afterPoints.map((point) => point.value));
    const delta = after - before;
    if (Math.abs(delta) < threshold) continue;
    const direction: ReplayClimateDirection = delta < 0 ? "drop" : "rise";
    if (!isSustained(afterPoints, before, direction, threshold)) continue;
    candidates.push({
      boundary,
      before,
      after,
      delta,
      score: Math.abs(delta) / threshold,
      direction,
    });
  }
  return candidates;
}

function strongestCandidate(candidates: readonly EventCandidate[]): EventCandidate {
  return candidates.reduce((strongest, candidate) => candidate.score > strongest.score
    || candidate.score === strongest.score && candidate.boundary < strongest.boundary
    ? candidate
    : strongest);
}

function clusterCandidates(candidates: readonly EventCandidate[]): EventCandidate[] {
  if (!candidates.length) return [];
  const clusters: EventCandidate[][] = [];
  for (const candidate of candidates) {
    const current = clusters.at(-1);
    const previous = current?.at(-1);
    if (current && previous && previous.direction === candidate.direction
      && candidate.boundary - previous.boundary <= CLUSTER_GAP_MS) {
      current.push(candidate);
    } else {
      clusters.push([candidate]);
    }
  }
  return clusters.map(strongestCandidate);
}

function lowerBound(points: readonly SeriesPoint[], timestamp: number): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle]!.timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function onsetTimestamp(points: readonly SeriesPoint[], candidate: EventCandidate): number {
  const midpoint = (candidate.before + candidate.after) / 2;
  const end = candidate.boundary + WINDOW_MS;
  for (let index = lowerBound(points, candidate.boundary); index < points.length; index += 1) {
    const point = points[index]!;
    if (point.timestamp >= end) break;
    if (candidate.direction === "drop" ? point.value <= midpoint : point.value >= midpoint) {
      return point.timestamp;
    }
  }
  return candidate.boundary;
}

function eventForCandidate(
  sensorId: string,
  metric: ReplayClimateMetric,
  points: readonly SeriesPoint[],
  candidate: EventCandidate,
): ReplayClimateEvent {
  const timestamp = onsetTimestamp(points, candidate);
  const significance: ReplayClimateEventSignificance = candidate.score >= MAJOR_SCORE_THRESHOLD ? "major" : "notable";
  return {
    id: `climate:${metric}:${candidate.direction}:${sensorId}:${new Date(timestamp).toISOString()}`,
    kind: "climate",
    timestamp,
    sensorId,
    metric,
    direction: candidate.direction,
    before: candidate.before,
    after: candidate.after,
    delta: candidate.delta,
    score: candidate.score,
    significance,
    autoTags: [metric, candidate.direction, significance],
  };
}

function eventOrder(left: ReplayClimateEvent, right: ReplayClimateEvent): number {
  return left.timestamp - right.timestamp || compareText(left.id, right.id);
}

function eventPriority(left: ReplayClimateEvent, right: ReplayClimateEvent): number {
  return right.score - left.score || right.timestamp - left.timestamp || compareText(left.id, right.id);
}

function requestedEventLimit(options: ReplayClimateEventOptions | undefined): number {
  const requested = options?.maxEvents;
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_MAX_EVENTS;
  return Math.min(ABSOLUTE_MAX_EVENTS, Math.max(0, Math.trunc(requested)));
}

function requestedEventWindow(options: ReplayClimateEventOptions | undefined): { from: number; to: number } {
  const from = typeof options?.from === "number" && Number.isFinite(options.from)
    ? options.from
    : Number.NEGATIVE_INFINITY;
  const to = typeof options?.to === "number" && Number.isFinite(options.to)
    ? options.to
    : Number.POSITIVE_INFINITY;
  return { from, to };
}

/**
 * Finds sustained, replayable indoor temperature and humidity changes.
 * Detection always uses canonical values, so display-unit preferences cannot
 * change which events are found.
 */
export function detectReplayClimateEvents(
  history: MeasurementHistory,
  sensorIds: string[],
  options?: ReplayClimateEventOptions,
): ReplayClimateEvent[] {
  const limit = requestedEventLimit(options);
  if (limit === 0) return [];
  const window = requestedEventWindow(options);
  if (window.from > window.to) return [];

  const events = [...new Set(sensorIds)].sort(compareText).flatMap((sensorId) => METRICS.flatMap(({ metric, threshold }) => {
    const points = normalizeSeries(history[sensorId]?.[metric] ?? [], sensorId, metric, window.from, window.to);
    if (points.length < MIN_SUPPORT_BUCKETS * 2) return [];
    return clusterCandidates(candidatesForSeries(points, threshold))
      .map((candidate) => eventForCandidate(sensorId, metric, points, candidate));
  }));

  return events
    .sort(eventPriority)
    .slice(0, limit)
    .sort(eventOrder);
}
