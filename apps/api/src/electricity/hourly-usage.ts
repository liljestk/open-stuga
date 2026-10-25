import { spreadAcrossHours } from "@climate-twin/analytics-kernel";
import type { HourlyEnergyUsage } from "../timeseries/types.js";

/** Collects usage and raw-spot-priced usage per UTC hour, spreading each interval evenly. */
export class HourlyUsageAccumulator {
  readonly #hours = new Map<number, HourlyEnergyUsage>();

  #hour(hourStart: number): HourlyEnergyUsage {
    let usage = this.#hours.get(hourStart);
    if (!usage) {
      usage = { hourStart, kwh: 0, spotPricedKwh: 0, spotCostCents: 0 };
      this.#hours.set(hourStart, usage);
    }
    return usage;
  }

  addUsage(startMs: number, endMs: number, kwh: number): void {
    spreadAcrossHours(startMs, endMs, kwh, (hourStart, share) => {
      this.#hour(hourStart).kwh += share;
    });
  }

  addSpotPriced(startMs: number, endMs: number, kwh: number, rawCentsPerKwh: number): void {
    spreadAcrossHours(startMs, endMs, kwh, (hourStart, share) => {
      const usage = this.#hour(hourStart);
      usage.spotPricedKwh += share;
      usage.spotCostCents += share * rawCentsPerKwh;
    });
  }

  toArray(): HourlyEnergyUsage[] {
    return [...this.#hours.values()].sort((left, right) => left.hourStart - right.hourStart);
  }
}

/** Parses the `[hourStartMs, kwh, spotPricedKwh, spotCostCents]` rows the cost SQL returns. */
export function hourlyUsageFromRows(value: unknown): HourlyEnergyUsage[] {
  const rows = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!Array.isArray(row) || row.length < 4) return [];
    const [hourStart, kwh, spotPricedKwh, spotCostCents] = row.map(Number) as [number, number, number, number];
    return [hourStart, kwh, spotPricedKwh, spotCostCents].every(Number.isFinite)
      ? [{ hourStart, kwh, spotPricedKwh, spotCostCents }]
      : [];
  }).sort((left, right) => left.hourStart - right.hourStart);
}
