import { maximum, median as kernelMedian, minimum, nearestRankQuantile } from "@climate-twin/analytics-kernel";

export function round(value: number, precision = 4): number {
  return Number(value.toFixed(precision));
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

/** Thermal fits treat an empty series as zero rather than missing. */
export const median = (values: readonly number[]): number => kernelMedian(values) ?? 0;

/** Nearest-rank percentile, the definition the thermal scores were calibrated against. */
export const percentile = (values: readonly number[], fraction: number): number => (
  nearestRankQuantile(values, fraction) ?? 0
);

export function range(values: number[]): number {
  return values.length ? maximum(values)! - minimum(values)! : 0;
}
