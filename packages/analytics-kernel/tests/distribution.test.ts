import { describe, expect, it } from "vitest";
import { numericDistribution } from "../src/distribution.js";

describe("numeric distributions", () => {
  it("does not convert absent or nonfinite evidence to zero", () => {
    expect(numericDistribution([NaN, Infinity, -Infinity])).toMatchObject({ count: 0, excludedCount: 3, median: null, bins: [] });
    expect(numericDistribution([])).toMatchObject({ count: 0, minimum: null });
  });

  it("counts bin boundaries once and includes the final endpoint", () => {
    const result = numericDistribution([0, 1, 2, 3, 4], 4);
    expect(result.bins.map((bin) => bin.count)).toEqual([1, 1, 1, 2]);
    expect(result).toMatchObject({ p25: 1, median: 2, p75: 3 });
  });

  it("retains a constant series as one bin", () => {
    expect(numericDistribution([7, 7, 7]).bins).toEqual([{ lower: 7, upper: 7, count: 3 }]);
  });

  it("handles finite extreme ranges without overflowing the bin arithmetic", () => {
    const result = numericDistribution([-Number.MAX_VALUE, 0, Number.MAX_VALUE], 2);
    expect(result.bins.every((bin) => Number.isFinite(bin.lower) && Number.isFinite(bin.upper))).toBe(true);
    expect(result.bins.map((bin) => bin.count)).toEqual([1, 2]);
  });

  it("keeps all observations in bounded bins without modifying input", () => {
    const input = Array.from({ length: 100_000 }, (_, index) => index % 101);
    const result = numericDistribution(input);
    expect(result.bins).toHaveLength(20);
    expect(result.bins.reduce((count, bin) => count + bin.count, 0)).toBe(input.length);
    expect(input[0]).toBe(0);
    expect(() => numericDistribution(input, 101)).toThrow(RangeError);
  });
});
