export function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted[middle];
  if (value === undefined) return 0;
  if (sorted.length % 2 === 1) return value;
  return ((sorted[middle - 1] ?? value) + value) / 2;
}

export function mad(values: readonly number[], center = median(values)): number {
  return median(values.map((value) => Math.abs(value - center)));
}

export function robustScale(values: readonly number[]): number {
  return Math.max(1e-6, 1.4826 * mad(values));
}

export function pearson(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  if (length < 3) return 0;
  const x = left.slice(0, length);
  const y = right.slice(0, length);
  const xMean = mean(x);
  const yMean = mean(y);
  let numerator = 0;
  let xSquare = 0;
  let ySquare = 0;
  for (let index = 0; index < length; index += 1) {
    const xDelta = (x[index] ?? 0) - xMean;
    const yDelta = (y[index] ?? 0) - yMean;
    numerator += xDelta * yDelta;
    xSquare += xDelta * xDelta;
    ySquare += yDelta * yDelta;
  }
  const denominator = Math.sqrt(xSquare * ySquare);
  return denominator <= 1e-12 ? 0 : clamp(numerator / denominator, -1, 1);
}

export function isoTime(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Collision-resistant stable digest for replay provenance and idempotency. */
export function stableDigest(value: unknown): string {
  const normalized = stableStringify(value);
  return `sha256-${createHash('sha256').update(normalized).digest('hex')}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export function weightedMean(values: Array<{ value: number; weight: number }>): number | null {
  const usable = values.filter((item) => Number.isFinite(item.value) && item.weight > 0);
  const totalWeight = usable.reduce((total, item) => total + item.weight, 0);
  if (totalWeight <= 0) return null;
  return usable.reduce((total, item) => total + item.value * item.weight, 0) / totalWeight;
}
import { createHash } from 'node:crypto';
