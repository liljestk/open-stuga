import { POWER_HOLD_MS, wattMillisecondsToKwh } from "@climate-twin/analytics-kernel";
import type { ClimateDatabase } from "../db.js";
import type { EnergyCostAggregateRecord, PowerCostAggregateQuery } from "../timeseries/types.js";
import { SQLITE_EFFECTIVE_PRICE_END } from "./support/electricity-price-overlap.js";
import { HourlyUsageAccumulator } from "../electricity/hourly-usage.js";

interface Sample { timestamp: string; value: number }
interface Price { start_at: string; end_at: string; cents: number }

/** Integrate ordered held samples once, seeking only prices that can overlap. */
export function localPowerCostAggregate(database: Pick<ClimateDatabase, "db">, query: PowerCostAggregateQuery): EnergyCostAggregateRecord {
  const result: EnergyCostAggregateRecord = { deltaCount: 0, consumptionKwh: 0, pricedConsumptionKwh: 0,
    spotCostEur: 0, hourly: [], totalDurationMs: 0, pricedDurationMs: 0, maximumIntervalDurationMs: 0,
    coverageFrom: null, coverageUntil: null };
  const hours = new HourlyUsageAccumulator();
  const from = Date.parse(query.from), to = Date.parse(query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return result;
  const prices = (database.db.prepare(`SELECT price.start_at, ${SQLITE_EFFECTIVE_PRICE_END} AS end_at,
      price.raw_price_cents_per_kwh AS cents
    FROM electricity_price_points AS price
    WHERE price.property_id = ? AND price.start_at >= COALESCE((
      SELECT boundary.start_at FROM electricity_price_points AS boundary
      WHERE boundary.property_id = ? AND boundary.start_at <= ?
      ORDER BY boundary.start_at DESC LIMIT 1
    ), ?) AND price.start_at < ? AND price.end_at > ? ORDER BY price.start_at`)
    .all(query.propertyId, query.propertyId, query.from, query.from, query.to, query.from) as unknown as Price[])
    .map(price => ({ from: Date.parse(price.start_at), to: Date.parse(price.end_at), cents: price.cents }))
    .filter(price => Number.isFinite(price.from) && Number.isFinite(price.to) && price.to > price.from);
  let priceIndex = 0;
  let coverageFrom = Infinity, coverageUntil = -Infinity;
  const integrate = (sample: Sample, nextAt: number) => {
    const at = Date.parse(sample.timestamp);
    const start = Math.max(from, at), end = Math.min(to, nextAt, at + POWER_HOLD_MS);
    if (!Number.isFinite(at) || !Number.isFinite(sample.value) || sample.value < 0 || sample.value >= 1e308 || end <= start) return;
    const duration = end - start;
    result.deltaCount++;
    const kwh = wattMillisecondsToKwh(sample.value, duration);
    result.consumptionKwh += kwh;
    hours.addUsage(start, end, kwh);
    result.totalDurationMs += duration;
    result.maximumIntervalDurationMs = Math.max(result.maximumIntervalDurationMs, duration);
    coverageFrom = Math.min(coverageFrom, start); coverageUntil = Math.max(coverageUntil, end);
    while (priceIndex < prices.length && prices[priceIndex]!.to <= start) priceIndex++;
    for (let index = priceIndex; index < prices.length && prices[index]!.from < end; index++) {
      const price = prices[index]!;
      const overlap = Math.min(end, price.to) - Math.max(start, price.from);
      if (overlap <= 0) continue;
      const pricedKwh = wattMillisecondsToKwh(sample.value, overlap);
      result.pricedConsumptionKwh += pricedKwh;
      result.spotCostEur += pricedKwh * price.cents / 100;
      result.pricedDurationMs += overlap;
      hours.addSpotPriced(Math.max(start, price.from), Math.min(end, price.to), pricedKwh, price.cents);
    }
  };
  const synthetic = query.excludeSynthetic ? 1 : 0;
  let pending = database.db.prepare(`SELECT timestamp,value FROM measurement_samples
    WHERE sensor_id=? AND metric='power' AND quality<>'stale' AND timestamp<=?
      AND (?=0 OR source NOT IN ('mock','replay')) ORDER BY timestamp DESC,id DESC LIMIT 1`)
    .get(query.sensorId, query.from, synthetic) as unknown as Sample | undefined;
  const samples = database.db.prepare(`SELECT timestamp,value FROM measurement_samples
    WHERE sensor_id=? AND metric='power' AND quality<>'stale' AND timestamp>? AND timestamp<=?
      AND (?=0 OR source NOT IN ('mock','replay')) ORDER BY timestamp ASC,id ASC`)
    .iterate(query.sensorId, query.from, query.to, synthetic);
  for (const row of samples) {
    const sample = row as unknown as Sample;
    // The last ID at one timestamp has authority, matching the SQL cost contract.
    if (pending && sample.timestamp !== pending.timestamp) integrate(pending, Date.parse(sample.timestamp));
    pending = sample;
  }
  if (pending) integrate(pending, to);
  result.hourly = hours.toArray();
  if (result.deltaCount > 0) {
    result.coverageFrom = new Date(coverageFrom).toISOString();
    result.coverageUntil = new Date(coverageUntil).toISOString();
  }
  return result;
}
