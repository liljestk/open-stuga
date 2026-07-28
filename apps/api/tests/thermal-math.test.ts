import { describe, expect, it } from "vitest";
import { median } from "../src/thermal-math.js";

function sortedMedian(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

describe("thermal fitting math", () => {
  it("selects the exact median without sorting every robust-fit pass", () => {
    let state = 0x5eed;
    const random = () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
    for (let length = 1; length <= 128; length += 1) {
      const values = Array.from({ length }, () => Math.round((random() - 0.5) * 20));
      expect(median(values)).toBeCloseTo(sortedMedian(values), 12);
    }
  });
});
