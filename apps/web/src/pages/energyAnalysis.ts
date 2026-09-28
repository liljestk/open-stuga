import type {
  AnalyticsQueryResponse,
  AnalyticsSeries,
  HomeEnergyCost,
  HomeEnergySummary,
  MeasurementSample,
  Sensor,
} from "@climate-twin/contracts";
import type { ClimateState } from "../domain";
import type { SeriesPoint } from "../components/SensorAnalyticsPlot";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const POWER_HOLD_MS = 15 * 60_000;
const COVERAGE_EDGE_TOLERANCE_MS = 5 * 60_000;
const MIN_HISTORICAL_PRICE_COVERAGE_PERCENT = 80;

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

interface DailyRate {
  kwh: number;
  observedDays: number;
}

export interface EnergyProjection {
  dailyKwh: number;
  next30DaysKwh: number;
  lowKwh: number;
  highKwh: number;
  estimatedCostEur: number | null;
  lowCostEur: number | null;
  highCostEur: number | null;
  observedDays: number;
  confidence: "low" | "medium" | "high";
  priceBasis: "historical" | "current" | "unavailable";
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
    const fullDelta = current.value >= previous.value ? current.value - previous.value : current.value;
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
    cumulative += sample.value * (intervalEnd - intervalStart) / HOUR_MS / 1_000;
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
  const latestAvailableTimestamp = Math.max(...series.flatMap((item) => item.points.map((point) => point.timestamp)));
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
      low: Math.min(...values),
      high: Math.max(...values),
      sensorCount: values.length,
    }];
  });
}

function costCoverageDays(cost: HomeEnergyCost): number | null {
  if (cost.consumptionKwh === null || cost.consumptionKwh < 0) return null;
  const start = cost.measurementCoverageFrom ? finiteTimestamp(cost.measurementCoverageFrom) : null;
  const end = cost.measurementCoverageUntil ? finiteTimestamp(cost.measurementCoverageUntil) : null;
  if (start === null || end === null || end <= start) return null;
  return Math.max((end - start) / DAY_MS, 1 / 24);
}

function summaryDailyRate(summary: HomeEnergySummary | null): DailyRate | null {
  if (!summary || summary.consumptionKwh === null) return null;
  const usable = summary.contributions.flatMap((cost) => {
    const days = costCoverageDays(cost);
    return days === null || cost.consumptionKwh === null ? [] : [{ days, kwh: cost.consumptionKwh }];
  });
  if (usable.length) {
    return {
      kwh: usable.reduce((sum, item) => sum + item.kwh / item.days, 0),
      observedDays: Math.min(...usable.map((item) => item.days)),
    };
  }
  const from = finiteTimestamp(summary.from);
  const to = finiteTimestamp(summary.to);
  if (from === null || to === null || to <= from) return null;
  const observedDays = Math.max((to - from) / DAY_MS, 1 / 24);
  return { kwh: summary.consumptionKwh / observedDays, observedDays };
}

function selectedSourceCount(summary: HomeEnergySummary): number {
  return Math.max(0, summary.totalSources - summary.excludedSourceCount);
}

function summarySourcesComplete(summary: HomeEnergySummary | null): boolean {
  return Boolean(summary
    && summary.aggregationMode !== "submeters_only"
    && summary.failedSourceCount === 0
    && summary.sourceCount === selectedSourceCount(summary)
    && summary.contributions.length === selectedSourceCount(summary));
}

function summaryCoversRequestedWindow(summary: HomeEnergySummary | null): boolean {
  if (!summary || !summarySourcesComplete(summary)) return false;
  const requestedFrom = finiteTimestamp(summary.from);
  const requestedTo = finiteTimestamp(summary.to);
  if (requestedFrom === null || requestedTo === null) return false;
  return summary.contributions.every((cost) => {
    const coverageFrom = cost.measurementCoverageFrom ? finiteTimestamp(cost.measurementCoverageFrom) : null;
    const coverageUntil = cost.measurementCoverageUntil ? finiteTimestamp(cost.measurementCoverageUntil) : null;
    return coverageFrom !== null && coverageUntil !== null
      && coverageFrom <= requestedFrom + COVERAGE_EDGE_TOLERANCE_MS
      && coverageUntil >= requestedTo - COVERAGE_EDGE_TOLERANCE_MS;
  });
}

function summariesUseSameSources(left: HomeEnergySummary | null, right: HomeEnergySummary | null): boolean {
  if (!left || !right) return true;
  const ids = (summary: HomeEnergySummary) => summary.contributions
    .filter((cost) => cost.consumptionKwh !== null)
    .map((cost) => cost.sensorId)
    .sort()
    .join("\u0000");
  return ids(left) === ids(right);
}

export function buildEnergyProjection(
  recentSummary: HomeEnergySummary | null,
  rollingSummary: HomeEnergySummary | null,
  currentPriceEurPerKwh: number | null,
): EnergyProjection | null {
  const recent = summaryDailyRate(recentSummary);
  const rolling = summaryDailyRate(rollingSummary);
  if (!recent && !rolling) return null;

  const rollingWeight = rolling && recent ? Math.min(0.8, Math.max(0.35, rolling.observedDays / 14)) : rolling ? 1 : 0;
  const dailyKwh = Math.max(0, (rolling?.kwh ?? 0) * rollingWeight + (recent?.kwh ?? 0) * (1 - rollingWeight));
  const observedDays = rolling?.observedDays ?? recent?.observedDays ?? 0;
  const disagreement = rolling && recent && dailyKwh > 0 ? Math.abs(rolling.kwh - recent.kwh) / dailyKwh : 0;
  const historyPenalty = 1 - Math.min(1, observedDays / 14);
  const uncertainty = Math.min(0.45, Math.max(0.1, 0.1 + historyPenalty * 0.2 + disagreement * 0.35));
  const next30DaysKwh = dailyKwh * 30;
  const lowKwh = Math.max(0, next30DaysKwh * (1 - uncertainty));
  const highKwh = next30DaysKwh * (1 + uncertainty);

  const historicalPrice = rollingSummary?.priceCoveragePercent !== undefined
    && rollingSummary.priceCoveragePercent >= MIN_HISTORICAL_PRICE_COVERAGE_PERCENT
    && rollingSummary?.costEur !== null && rollingSummary?.costEur !== undefined
    && rollingSummary.pricedConsumptionKwh !== null && rollingSummary.pricedConsumptionKwh > 0
    && Number.isFinite(rollingSummary.costEur)
    ? rollingSummary.costEur / rollingSummary.pricedConsumptionKwh
    : null;
  const price = historicalPrice ?? (currentPriceEurPerKwh !== null && Number.isFinite(currentPriceEurPerKwh)
    ? currentPriceEurPerKwh : null);
  const costUncertainty = Math.min(0.7, uncertainty + (historicalPrice === null ? 0.3 : 0.15));
  const estimatedCostEur = price === null ? null : next30DaysKwh * price;
  const costBounds = estimatedCostEur === null ? null : [
    estimatedCostEur * (1 - costUncertainty),
    estimatedCostEur * (1 + costUncertainty),
  ].sort((left, right) => left - right);
  const sameSources = summariesUseSameSources(recentSummary, rollingSummary);
  const confidence = observedDays >= 14 && summaryCoversRequestedWindow(rollingSummary) && sameSources
    ? "high"
    : observedDays >= 3 && summarySourcesComplete(rollingSummary) && sameSources
      ? "medium"
      : "low";
  return {
    dailyKwh,
    next30DaysKwh,
    lowKwh,
    highKwh,
    estimatedCostEur,
    lowCostEur: costBounds?.[0] ?? null,
    highCostEur: costBounds?.[1] ?? null,
    observedDays,
    confidence,
    priceBasis: historicalPrice !== null ? "historical" : price !== null ? "current" : "unavailable",
  };
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
