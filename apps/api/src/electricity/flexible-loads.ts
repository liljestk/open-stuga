import { withSignal } from "@climate-twin/contracts";
import { median, quantile } from "@climate-twin/analytics-kernel";
import type { EnergyFlexibleLoad, PropertyElectricityPricePoint, Sensor } from "@climate-twin/contracts";
import { HEAT_PUMP_SENSOR_TAG } from "../heat-pump-measurements.js";
import type { HybridTelemetryReader } from "../timeseries/read-facade.js";
import { mapWithConcurrency } from "../timeseries/read-support.js";

/** Days of a device's power history its run profile is measured over. */
export const FLEXIBLE_PROFILE_DAYS = 7;
export const FLEXIBLE_BUCKET_MS = 5 * 60_000;
const MIN_RUN_WATTS = 100;
/** A run must clearly stand above the device's idle draw. */
const IDLE_MULTIPLE = 3;
const MIN_RUN_MS = 10 * 60_000;
const MAX_RUN_MS = 6 * 3_600_000;
const MIN_RUNS = 3;
/** A device drawing power more than half the time is continuous load, not a shiftable one. */
const MAX_DUTY = 0.5;
const MIN_PRICED_SHARE = 0.8;

export interface PowerBucket {
  time: number;
  watts: number;
}

export interface PriceInterval {
  start: number;
  end: number;
  centsPerKwh: number;
}

export interface FlexibleLoadProfile {
  runs: number;
  dailyKwh: number;
  typicalRunMs: number;
  /** Energy-weighted price the device actually paid during its runs. */
  paidCentsPerKwh: number;
}

export interface PriceWindow {
  start: number;
  end: number;
  averageCentsPerKwh: number;
}

function priceAt(prices: readonly PriceInterval[], time: number): number | null {
  let low = 0;
  let high = prices.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const interval = prices[middle]!;
    if (time < interval.start) high = middle - 1;
    else if (time >= interval.end) low = middle + 1;
    else return interval.centsPerKwh;
  }
  return null;
}

/**
 * Measures a device's runs from five-minute mean power: stretches clearly
 * above its idle draw lasting from ten minutes to six hours. Devices that run
 * rarely, or draw power most of the time, have no shiftable profile.
 */
export function flexibleLoadProfile(
  buckets: readonly PowerBucket[],
  prices: readonly PriceInterval[],
  { from, to }: { from: number; to: number },
): FlexibleLoadProfile | null {
  const ordered = buckets.filter((bucket) => Number.isFinite(bucket.watts) && bucket.watts >= 0 && bucket.time >= from && bucket.time < to)
    .sort((left, right) => left.time - right.time);
  if (ordered.length === 0) return null;
  const idle = quantile(ordered.map((bucket) => bucket.watts), 0.1) ?? 0;
  const threshold = Math.max(MIN_RUN_WATTS, idle * IDLE_MULTIPLE);
  const sortedPrices = [...prices].sort((left, right) => left.start - right.start);
  const runs: Array<{ durationMs: number; energyKwh: number; pricedKwh: number; costCents: number }> = [];
  let current: (typeof runs)[number] | null = null;
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const bucket of ordered) {
    const contiguous = bucket.time - previousTime === FLEXIBLE_BUCKET_MS;
    previousTime = bucket.time;
    if (bucket.watts < threshold || !contiguous) {
      if (current) runs.push(current);
      current = null;
      if (bucket.watts < threshold) continue;
    }
    current ??= { durationMs: 0, energyKwh: 0, pricedKwh: 0, costCents: 0 };
    const kwh = bucket.watts * FLEXIBLE_BUCKET_MS / 3_600_000 / 1_000;
    current.durationMs += FLEXIBLE_BUCKET_MS;
    current.energyKwh += kwh;
    const price = priceAt(sortedPrices, bucket.time + FLEXIBLE_BUCKET_MS / 2);
    if (price !== null) {
      current.pricedKwh += kwh;
      current.costCents += kwh * price;
    }
  }
  if (current) runs.push(current);
  const kept = runs.filter((run) => run.durationMs >= MIN_RUN_MS && run.durationMs <= MAX_RUN_MS);
  const runMs = kept.reduce((sum, run) => sum + run.durationMs, 0);
  const energyKwh = kept.reduce((sum, run) => sum + run.energyKwh, 0);
  const pricedKwh = kept.reduce((sum, run) => sum + run.pricedKwh, 0);
  if (kept.length < MIN_RUNS || runMs > (to - from) * MAX_DUTY || energyKwh <= 0 || pricedKwh < energyKwh * MIN_PRICED_SHARE) return null;
  return {
    runs: kept.length,
    dailyKwh: energyKwh / ((to - from) / 86_400_000),
    typicalRunMs: median(kept.map((run) => run.durationMs))!,
    paidCentsPerKwh: kept.reduce((sum, run) => sum + run.costCents, 0) / pricedKwh,
  };
}

/** The cheapest window of `durationMs` starting on a price boundary within [from, until). */
export function cheapestWindow(
  prices: readonly PriceInterval[],
  { durationMs, from, until }: { durationMs: number; from: number; until: number },
): PriceWindow | null {
  const sorted = [...prices].sort((left, right) => left.start - right.start);
  let best: PriceWindow | null = null;
  for (const candidate of sorted) {
    const start = Math.max(candidate.start, from);
    const end = start + durationMs;
    if (start < candidate.start || end > until) continue;
    let covered = 0;
    let cost = 0;
    for (const interval of sorted) {
      const overlap = Math.min(end, interval.end) - Math.max(start, interval.start);
      if (overlap <= 0) continue;
      covered += overlap;
      cost += overlap * interval.centsPerKwh;
    }
    if (covered < durationMs) continue;
    const averageCentsPerKwh = cost / covered;
    if (!best || averageCentsPerKwh < best.averageCentsPerKwh) best = { start, end, averageCentsPerKwh };
  }
  return best;
}

/** What moving the measured daily runs into the window would save per day, in euros. */
export function shiftSavingsEurPerDay(profile: FlexibleLoadProfile, window: PriceWindow): number {
  return profile.dailyKwh * Math.max(0, profile.paidCentsPerKwh - window.averageCentsPerKwh) / 100;
}

const MAX_FLEXIBLE_DEVICES = 12;
const FLEXIBLE_READ_CONCURRENCY = 2;

/**
 * Profiles each device meter's last week of runs and prices moving them into
 * the cheapest upcoming window of the same length. Whole-Home meters and heat
 * pumps are not devices whose runs can simply move.
 */
export async function measureFlexibleLoads(input: {
  reader: Pick<HybridTelemetryReader, "measurementHistoryBucketed">;
  sensors: readonly Sensor[];
  prices: readonly PropertyElectricityPricePoint[];
  now: number;
  signal?: AbortSignal;
}): Promise<EnergyFlexibleLoad[]> {
  const from = input.now - FLEXIBLE_PROFILE_DAYS * 86_400_000;
  const intervals = input.prices.flatMap((price) => {
    const start = Date.parse(price.startAt);
    const end = Date.parse(price.endAt);
    return Number.isFinite(start) && Number.isFinite(end) && end > start && Number.isFinite(price.effectivePriceCentsPerKwh)
      ? [{ start, end, centsPerKwh: price.effectivePriceCentsPerKwh }]
      : [];
  });
  const devices = input.sensors.filter((sensor) => sensor.enabled && sensor.energyMeterRole !== "whole_home"
    && !(sensor.tags ?? []).includes(HEAT_PUMP_SENSOR_TAG)).slice(0, MAX_FLEXIBLE_DEVICES);
  const loads = await mapWithConcurrency(devices, FLEXIBLE_READ_CONCURRENCY, async (sensor) => {
    const read = await input.reader.measurementHistoryBucketed({
      sensorId: sensor.id, metric: "power", from: new Date(from).toISOString(), to: new Date(input.now).toISOString(),
      bucketSeconds: FLEXIBLE_BUCKET_MS / 1_000, limit: FLEXIBLE_PROFILE_DAYS * 288 + 2,
      ...withSignal(input.signal),
    }).catch(() => null);
    if (!read) return null;
    const profile = flexibleLoadProfile(
      read.records.map((record) => ({ time: Date.parse(record.timestamp), watts: record.value })),
      intervals.filter((interval) => interval.end <= input.now + FLEXIBLE_BUCKET_MS),
      { from, to: input.now },
    );
    if (!profile) return null;
    const window = cheapestWindow(intervals, { durationMs: profile.typicalRunMs, from: input.now, until: input.now + 86_400_000 });
    const load: EnergyFlexibleLoad = {
      sensorId: sensor.id,
      sensorName: sensor.name,
      runsPerDay: Number((profile.runs / FLEXIBLE_PROFILE_DAYS).toFixed(2)),
      dailyKwh: Number(profile.dailyKwh.toFixed(3)),
      typicalRunMinutes: Math.round(profile.typicalRunMs / 60_000),
      paidCentsPerKwh: Number(profile.paidCentsPerKwh.toFixed(3)),
      cheapestWindow: window ? {
        startAt: new Date(window.start).toISOString(),
        endAt: new Date(window.end).toISOString(),
        averagePriceCentsPerKwh: Number(window.averageCentsPerKwh.toFixed(3)),
      } : null,
      estimatedDailySavingsEur: window ? Number(shiftSavingsEurPerDay(profile, window).toFixed(2)) : null,
    };
    return load;
  });
  return loads.filter((load): load is EnergyFlexibleLoad => load !== null)
    .sort((left, right) => (right.estimatedDailySavingsEur ?? 0) - (left.estimatedDailySavingsEur ?? 0)
      || left.sensorName.localeCompare(right.sensorName));
}
