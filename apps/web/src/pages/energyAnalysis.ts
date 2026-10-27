import type {
  AnalyticsQueryResponse,
  AnalyticsSeries,
  HomeEnergyCost,
  HomeEnergySummary,
  MeasurementSample,
  Sensor,
} from "@climate-twin/contracts";
import { POWER_HOLD_MS, counterIncrement, wattMillisecondsToKwh, maximum, minimum } from "@climate-twin/analytics-kernel";
import type { ClimateState } from "../domain";
import type { SeriesPoint } from "../components/SensorAnalyticsPlot";

/** Only server integrals are safe to accumulate after history downsampling. */
export function consumptionHistorySeries(
  responses: readonly AnalyticsQueryResponse[], sensorId: string,
): { points: SeriesPoint[]; partial: boolean } {
  const candidates = responses.flatMap((response) => response.series
    .filter((series) => series.entityId === sensorId)
    .map((series) => ({ response, series })));
  const usable = (series: AnalyticsSeries) => series.points.some((point) => (
    point.consumptionKwh !== undefined && point.consumptionKwh !== null && Number.isFinite(point.consumptionKwh)
  ));
  const selected = candidates.find(({ series }) => series.measurementId === "energy" && series.summary.count >= 2 && usable(series))
    ?? candidates.find(({ series }) => series.measurementId === "power" && usable(series));
  if (!selected) return { points: [], partial: candidates.some(({ series }) => series.summary.count > 0 || series.points.some((point) => point.consumptionKwh === null)) };
  const { response, series } = selected;
  const bucketMs = series.resolution === "1d" ? 86_400_000 : series.resolution === "1h" ? 3_600_000
    : Number(series.resolution.slice(0, -1)) * 60_000;
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) return { points: [], partial: true };
  const from = Date.parse(response.resolvedRange.start);
  const to = Date.parse(response.resolvedRange.end);
  let total = 0;
  let partial = response.warnings.some((warning) => warning.code === "ARCHIVE_DEGRADED");
  const points: SeriesPoint[] = [];
  for (const point of series.points) {
    const value = point.consumptionKwh;
    if (value == null || !Number.isFinite(value) || value < 0) {
      // Empty display buckets and deliberately excluded source qualities are
      // not failed/truncated requests. Missing integral metadata on an actual
      // observation, however, must never fall back to an averaged value.
      if (value === null || point.sampleCount > 0) partial = true;
      continue;
    }
    const at = Date.parse(point.timestamp);
    if (!points.length) points.push({ timestamp: Math.max(from, at), value: 0 });
    total += value;
    points.push({ timestamp: Math.min(to, at + bucketMs), value: total });
  }
  return { points, partial };
}

export interface EnergyConsumerInsight {
  sensor: Sensor;
  consumptionKwh: number;
  sharePercent: number;
  measurementBasis: HomeEnergyCost["measurementBasis"];
}

function finiteTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validSamples(samples: readonly MeasurementSample[]): MeasurementSample[] {
  const byTimestamp = new Map<number, MeasurementSample>();
  for (const sample of samples) {
    const timestamp = finiteTimestamp(sample.timestamp);
    if (timestamp === null || sample.quality === "stale" || !Number.isFinite(sample.value) || sample.value < 0) continue;
    byTimestamp.set(timestamp, sample);
  }
  return [...byTimestamp.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, sample]) => sample);
}

function samplesFor(state: ClimateState, sensorId: string, metric: "energy" | "power"): MeasurementSample[] {
  return validSamples([
    ...(state.measurementHistory[sensorId]?.[metric] ?? []),
    ...([state.latestMeasurements[sensorId]?.[metric]].filter(Boolean) as MeasurementSample[]),
  ]);
}

function counterUsageSeries(samples: readonly MeasurementSample[], from: number, to: number): SeriesPoint[] {
  const ordered = validSamples(samples);
  if (ordered.length < 2) return [];
  let cumulative = 0;
  const points: SeriesPoint[] = [{ timestamp: Math.max(from, Date.parse(ordered[0]!.timestamp)), value: 0 }];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    const previousAt = Date.parse(previous.timestamp);
    const currentAt = Date.parse(current.timestamp);
    if (currentAt <= from || previousAt >= to || currentAt <= previousAt) continue;
    // A decrease is a meter restart: the energy counted since it still counts.
    const fullDelta = counterIncrement(previous.value, current.value).increment;
    const intervalStart = Math.max(from, previousAt);
    const intervalEnd = Math.min(to, currentAt);
    if (intervalEnd <= intervalStart) continue;
    cumulative += fullDelta * (intervalEnd - intervalStart) / (currentAt - previousAt);
    points.push({ timestamp: intervalEnd, value: cumulative });
  }
  return points.length > 1 ? points : [];
}

function integratedPowerSeries(samples: readonly MeasurementSample[], from: number, to: number): SeriesPoint[] {
  const ordered = validSamples(samples);
  if (!ordered.length) return [];
  let cumulative = 0;
  const points: SeriesPoint[] = [{ timestamp: Math.max(from, Date.parse(ordered[0]!.timestamp)), value: 0 }];
  for (let index = 0; index < ordered.length; index += 1) {
    const sample = ordered[index]!;
    const sampleAt = Date.parse(sample.timestamp);
    const nextAt = index + 1 < ordered.length ? Date.parse(ordered[index + 1]!.timestamp) : to;
    const intervalStart = Math.max(from, sampleAt);
    const intervalEnd = Math.min(to, nextAt, sampleAt + POWER_HOLD_MS);
    if (intervalEnd <= intervalStart) continue;
    cumulative += wattMillisecondsToKwh(sample.value, intervalEnd - intervalStart);
    points.push({ timestamp: intervalEnd, value: cumulative });
  }
  return points.length > 1 ? points : [];
}

/**
 * Converts a lifetime/resetting counter to interval consumption. When a plug
 * exposes only power, it uses the same 15-minute zero-order hold as the server
 * cost calculation so gaps cannot silently inflate consumption.
 */
export function electricityUsageSeries(
  state: ClimateState,
  sensorId: string,
  from: number,
  to: number,
): SeriesPoint[] {
  const counter = counterUsageSeries(samplesFor(state, sensorId, "energy"), from, to);
  return counter.length ? counter : integratedPowerSeries(samplesFor(state, sensorId, "power"), from, to);
}

/**
 * Zero-order-hold fill for instantaneous metrics. Integrations write a sample
 * only on change plus a periodic heartbeat, so a steady load can legitimately
 * skip chart buckets while it is still being measured. Empty buckets between
 * samples borrow the last known value, bounded by the same 15-minute hold the
 * server-side cost integration uses, so heartbeat phase never reads as an
 * outage — while a genuinely silent sensor still leaves an honest gap.
 */
export function holdSeriesForBuckets(
  points: readonly SeriesPoint[],
  bucketMs: number,
  from: number,
  to: number,
  holdMs = POWER_HOLD_MS,
): SeriesPoint[] {
  if (!points.length) return [...points];
  const realBuckets = new Set<number>();
  for (const point of points) realBuckets.add(Math.floor(point.timestamp / bucketMs));
  const result = [...points];
  let cursor = 0;
  const firstBucket = Math.floor(Math.max(points[0]!.timestamp, from) / bucketMs);
  const lastBucket = Math.floor(Math.min(to, points.at(-1)!.timestamp + holdMs) / bucketMs);
  for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
    if (realBuckets.has(bucket)) continue;
    const bucketStart = bucket * bucketMs;
    while (cursor + 1 < points.length && points[cursor + 1]!.timestamp < bucketStart) cursor += 1;
    const last = points[cursor]!;
    if (last.timestamp >= bucketStart) continue;
    if (bucketStart - last.timestamp > holdMs) continue;
    if (bucketStart < from || bucketStart > to) continue;
    result.push({ timestamp: bucketStart, value: last.value });
  }
  return result.sort((left, right) => left.timestamp - right.timestamp);
}

/** Sum cumulative series at shared bucket boundaries using last-known values. */
export function aggregateCumulativeSeries(
  series: Array<{ sensorId: string; points: SeriesPoint[] }>,
  bucketMs: number,
): Array<SeriesPoint & { low: number; high: number; sensorCount: number }> {
  if (!series.length) return [];
  const timestamps = new Set<number>();
  for (const item of series) {
    for (const point of item.points) timestamps.add(Math.ceil(point.timestamp / bucketMs) * bucketMs);
  }
  const latestAvailableTimestamp = (maximum(series.flatMap((item) => item.points.map((point) => point.timestamp))) ?? Number.NEGATIVE_INFINITY);
  const cursors = new Map<string, number>();
  return [...timestamps].sort((left, right) => left - right).flatMap((timestamp) => {
    const bucketEnd = Math.min(timestamp, latestAvailableTimestamp);
    const values: number[] = [];
    for (const item of series) {
      let cursor = cursors.get(item.sensorId) ?? 0;
      while (cursor + 1 < item.points.length && item.points[cursor + 1]!.timestamp <= bucketEnd) cursor += 1;
      cursors.set(item.sensorId, cursor);
      const point = item.points[cursor];
      if (point && point.timestamp <= bucketEnd) values.push(point.value);
    }
    if (values.length !== series.length) return [];
    return [{
      timestamp: bucketEnd,
      value: values.reduce((sum, value) => sum + value, 0),
      low: (minimum(values) ?? Number.POSITIVE_INFINITY),
      high: (maximum(values) ?? Number.NEGATIVE_INFINITY),
      sensorCount: values.length,
    }];
  });
}

export function buildConsumerInsights(
  summary: HomeEnergySummary | null,
  sensors: readonly Sensor[],
): EnergyConsumerInsight[] {
  if (!summary) return [];
  const byId = new Map(sensors.map((sensor) => [sensor.id, sensor]));
  const usable = summary.contributions.filter((cost) => cost.consumptionKwh !== null && cost.consumptionKwh >= 0 && byId.has(cost.sensorId));
  const total = usable.reduce((sum, cost) => sum + (cost.consumptionKwh ?? 0), 0);
  return usable.map((cost) => ({
    sensor: byId.get(cost.sensorId)!,
    consumptionKwh: cost.consumptionKwh ?? 0,
    sharePercent: total > 0 ? (cost.consumptionKwh ?? 0) / total * 100 : 0,
    measurementBasis: cost.measurementBasis,
  })).sort((left, right) => right.consumptionKwh - left.consumptionKwh || left.sensor.name.localeCompare(right.sensor.name));
}
