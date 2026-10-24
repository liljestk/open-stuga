import { describe, expect, it } from "vitest";
import {
  maximum,
  mean,
  median,
  medianAbsoluteDeviation,
  minimum,
  nearestRankQuantile,
  quantile,
  quantileSorted,
  sampleStandardDeviation,
  weightedMean,
} from "../src/index.js";

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("summary statistics", () => {
  it("returns null for empty input instead of inventing a value", () => {
    for (const statistic of [minimum, maximum, mean, median, medianAbsoluteDeviation, sampleStandardDeviation]) {
      expect(statistic([])).toBeNull();
    }
    expect(quantile([], 0.5)).toBeNull();
    expect(nearestRankQuantile([], 0.5)).toBeNull();
  });

  it("matches R's default (type 7) quantiles", () => {
    const values = [7, 1, 3, 9, 5, 2];
    // quantile(c(7,1,3,9,5,2), c(0, .05, .25, .5, .95, 1)) in R.
    expect(quantile(values, 0)).toBe(1);
    expect(quantile(values, 0.05)).toBeCloseTo(1.25, 12);
    expect(quantile(values, 0.25)).toBeCloseTo(2.25, 12);
    expect(quantile(values, 0.5)).toBe(4);
    expect(quantile(values, 0.95)).toBeCloseTo(8.5, 12);
    expect(quantile(values, 1)).toBe(9);
    expect(quantileSorted([1, 2, 3, 5, 7, 9], 0.25)).toBeCloseTo(2.25, 12);
  });

  it("keeps the observed-value nearest-rank definition used by thermal scores", () => {
    expect(nearestRankQuantile([10, 20, 30, 40], 0.1)).toBe(10);
    expect(nearestRankQuantile([10, 20, 30, 40], 0.5)).toBe(20);
    expect(nearestRankQuantile([10, 20, 30, 40], 0.9)).toBe(40);
  });

  it("rejects probabilities outside the unit interval", () => {
    expect(() => quantile([1], 1.5)).toThrow(RangeError);
    expect(() => nearestRankQuantile([1], Number.NaN)).toThrow(RangeError);
  });

  it("finds the median by selection exactly as a full sort would", () => {
    const random = seeded(42);
    for (const length of [1, 2, 3, 10, 101, 1_000, 4_096]) {
      const values = Array.from({ length }, () => Math.round(random() * 1_000) / 10);
      const sorted = [...values].sort((left, right) => left - right);
      const middle = Math.floor(length / 2);
      const expected = length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
      const before = [...values];
      expect(median(values)).toBe(expected);
      expect(values).toEqual(before);
    }
  });

  it("measures dispersion around the median and the mean", () => {
    expect(medianAbsoluteDeviation([1, 1, 2, 2, 4, 6, 9])).toBe(1);
    expect(sampleStandardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138089935, 9);
    expect(sampleStandardDeviation([5])).toBeNull();
    expect(weightedMean([1, 3], [3, 1])).toBe(1.5);
    expect(weightedMean([1], [0])).toBeNull();
  });

  it("reduces series larger than the engine's spread-argument limit", () => {
    const values = Array.from({ length: 300_000 }, (_, index) => index % 1_000);
    expect(minimum(values)).toBe(0);
    expect(maximum(values)).toBe(999);
  });
});
