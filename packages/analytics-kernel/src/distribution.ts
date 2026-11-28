import { maximum, minimum, quantileSorted } from "./statistics.js";

function distributionBins(low: number | null, high: number | null, binCount: number) {
  const bins: Array<{ lower: number; upper: number; count: number }> = [];
  if (low === null || high === null) return bins;
  const count = low === high ? 1 : binCount;
  // Dividing before subtracting also supports opposite finite extremes.
  for (let index = 0; index < count; index += 1) {
    bins.push({
      lower: index === 0 ? low : low * (1 - index / count) + high * (index / count),
      upper: index === count - 1 ? high : low * (1 - (index + 1) / count) + high * ((index + 1) / count),
      count: 0,
    });
  }
  return bins;
}

function countObservation(bins: Array<{ upper: number; count: number }>, value: number): void {
  // Binary search avoids overflow in (value - low) / (high - low).
  let left = 0;
  let right = bins.length - 1;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (value < bins[middle]!.upper) right = middle;
    else left = middle + 1;
  }
  bins[left]!.count += 1;
}

/** Equal-width, unweighted distribution of finite observations, not elapsed time. */
export function numericDistribution(values: readonly number[], binCount = 20) {
  if (!Number.isInteger(binCount) || binCount < 1 || binCount > 100) {
    throw new RangeError("binCount must be an integer between 1 and 100");
  }
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  const low = minimum(sorted);
  const high = maximum(sorted);
  const bins = distributionBins(low, high, binCount);
  for (const value of sorted) countObservation(bins, value);
  return {
    count: sorted.length,
    excludedCount: values.length - sorted.length,
    minimum: low,
    maximum: high,
    p05: quantileSorted(sorted, 0.05),
    p25: quantileSorted(sorted, 0.25),
    median: quantileSorted(sorted, 0.5),
    p75: quantileSorted(sorted, 0.75),
    p95: quantileSorted(sorted, 0.95),
    bins,
  };
}
