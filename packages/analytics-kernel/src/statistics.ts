/**
 * The single definition of every summary statistic Stugu analytics reports.
 * Inputs are plain numbers; nothing spreads a series into `Math.min`/`Math.max`,
 * so a bucket may hold more values than the engine's argument-count ceiling.
 * Empty input yields `null` — callers that need another sentinel adapt it.
 */

function assertProbability(probability: number): void {
  if (!(probability >= 0 && probability <= 1)) {
    throw new RangeError("quantile probability must be between 0 and 1");
  }
}

export function minimum(values: readonly number[]): number | null {
  let result: number | null = null;
  for (const value of values) if (result === null || value < result) result = value;
  return result;
}

export function maximum(values: readonly number[]): number | null {
  let result: number | null = null;
  for (const value of values) if (result === null || value > result) result = value;
  return result;
}

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : sum(values) / values.length;
}

/** Bessel-corrected standard deviation; undefined below two values. */
export function sampleStandardDeviation(values: readonly number[], center = mean(values)): number | null {
  if (center === null || values.length < 2) return null;
  let squares = 0;
  for (const value of values) squares += (value - center) ** 2;
  return Math.sqrt(squares / (values.length - 1));
}

/** Weighted arithmetic mean; non-positive total weight has no mean. */
export function weightedMean(values: readonly number[], weights: readonly number[]): number | null {
  if (values.length !== weights.length) throw new RangeError("values and weights must have the same length");
  let weighted = 0;
  let total = 0;
  for (let index = 0; index < values.length; index += 1) {
    weighted += values[index]! * weights[index]!;
    total += weights[index]!;
  }
  return total > 0 ? weighted / total : null;
}

/**
 * Linear-interpolation quantile of ascending values (Hyndman–Fan type 7, the
 * R and NumPy default). Callers that already hold a sorted copy avoid a sort.
 */
export function quantileSorted(sorted: readonly number[], probability: number): number | null {
  assertProbability(probability);
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export function quantile(values: readonly number[], probability: number): number | null {
  return quantileSorted([...values].sort((left, right) => left - right), probability);
}

/**
 * Nearest-rank quantile (Hyndman–Fan type 1): always an observed value. The
 * thermal and moisture scores were calibrated against this definition.
 */
export function nearestRankQuantile(values: readonly number[], probability: number): number | null {
  assertProbability(probability);
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * probability) - 1))]!;
}

/** Hoare selection of the `nth` order statistic; reorders `values` in place. */
function selectNth(values: number[], nth: number): number {
  let left = 0;
  let right = values.length - 1;
  while (left < right) {
    const pivot = values[Math.floor((left + right) / 2)]!;
    let low = left;
    let high = right;
    while (low <= high) {
      while (values[low]! < pivot) low += 1;
      while (values[high]! > pivot) high -= 1;
      if (low <= high) {
        [values[low], values[high]] = [values[high]!, values[low]!];
        low += 1;
        high -= 1;
      }
    }
    if (nth <= high) right = high;
    else if (nth >= low) left = low;
    else break;
  }
  return values[nth]!;
}

/** Midpoint of the two central order statistics, found in linear time. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const working = [...values];
  const middle = Math.floor(working.length / 2);
  const upper = selectNth(working, middle);
  return working.length % 2 === 1 ? upper : (selectNth(working, middle - 1) + upper) / 2;
}

/** Unscaled median absolute deviation around `center` (the median by default). */
export function medianAbsoluteDeviation(values: readonly number[], center = median(values)): number | null {
  if (center === null) return null;
  return median(values.map((value) => Math.abs(value - center)));
}
