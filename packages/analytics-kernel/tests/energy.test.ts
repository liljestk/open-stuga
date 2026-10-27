import { describe, expect, it } from "vitest";
import {
  POWER_HOLD_MS,
  averageWattsToKwh,
  consumptionBuckets,
  counterDelta,
  counterIncrement,
  spreadAcrossHours,
  timeWeightedMean,
  wattMillisecondsToKwh,
} from "../src/index.js";

const minute = 60_000;
const quarter = 15 * minute;

describe("counter readings", () => {
  it("treats a decrease as a restart and keeps the energy counted since it", () => {
    expect(counterIncrement(100, 103)).toEqual({ increment: 3, reset: false });
    expect(counterIncrement(103, 2)).toEqual({ increment: 2, reset: true });
    expect(counterIncrement(103, -1)).toEqual({ increment: 0, reset: true });
    expect(counterDelta([100, 102, 0.5, 1.5])).toEqual({ delta: 3.5, resets: 1 });
    expect(counterDelta([100])).toEqual({ delta: null, resets: 0 });
  });
});

describe("unit conversions", () => {
  it("converts held and averaged loads to kWh", () => {
    expect(wattMillisecondsToKwh(1_000, 3_600_000)).toBe(1);
    expect(wattMillisecondsToKwh(2_000, quarter)).toBe(0.5);
    expect(averageWattsToKwh(500, 2)).toBe(1);
  });
});

describe("hourly spreading", () => {
  it("splits an interval across UTC hours by overlap", () => {
    const hour = 3_600_000;
    const shares = new Map<number, number>();
    spreadAcrossHours(hour / 2, 2 * hour + hour / 4, 7, (start, share) => shares.set(start, share));
    expect([...shares.keys()]).toEqual([0, hour, 2 * hour]);
    expect(shares.get(0)).toBeCloseTo(7 * 0.5 / 1.75, 12);
    expect(shares.get(hour)).toBeCloseTo(7 / 1.75, 12);
    expect(shares.get(2 * hour)).toBeCloseTo(7 * 0.25 / 1.75, 12);
    let calls = 0;
    spreadAcrossHours(hour, hour, 1, () => { calls += 1; });
    spreadAcrossHours(2 * hour, hour, 1, () => { calls += 1; });
    expect(calls).toBe(0);
  });
});

describe("consumption buckets", () => {
  it("credits counter increments to the later reading's bucket and prorates the opening interval", () => {
    const buckets = consumptionBuckets([
      { at: 0, value: 100 },
      { at: 10 * minute, value: 102 },
      { at: 20 * minute, value: 0.5 },
      { at: 35 * minute, value: 1.5 },
    ], "counter", quarter, 35 * minute, 5 * minute);
    expect([...buckets]).toEqual([
      [0, 1],
      [quarter, 0.5],
      [2 * quarter, 1],
    ]);
  });

  it("holds power for at most fifteen minutes and splits it across buckets", () => {
    const buckets = consumptionBuckets([
      { at: 0, value: 1_000 },
      { at: 10 * minute, value: 2_000 },
    ], "power", quarter, 60 * minute);
    expect(buckets.get(0)).toBeCloseTo(wattMillisecondsToKwh(1_000, 10 * minute) + wattMillisecondsToKwh(2_000, 5 * minute), 12);
    expect(buckets.get(quarter)).toBeCloseTo(wattMillisecondsToKwh(2_000, POWER_HOLD_MS - 5 * minute), 12);
    expect(buckets.has(2 * quarter)).toBe(false);
  });

  it("refuses to choose between conflicting simultaneous readings or recover usage from net power", () => {
    expect(consumptionBuckets([
      { at: 0, value: 100 },
      { at: 5 * minute, value: 101 },
      { at: 5 * minute, value: 102 },
    ], "counter", quarter, quarter).get(0)).toBeNull();
    expect(consumptionBuckets([
      { at: 0, value: 100 },
      { at: 5 * minute, value: 101 },
      { at: 5 * minute, value: 101 },
    ], "counter", quarter, quarter).get(0)).toBe(1);
    expect(consumptionBuckets([{ at: 0, value: -50 }], "power", quarter, quarter).get(0)).toBeNull();
  });
});

describe("time-weighted mean", () => {
  it("holds each value until the next reading but never across a gap longer than the cap", () => {
    const readings = [{ at: 0, value: 10 }, { at: 5 * minute, value: 20 }, { at: 60 * minute, value: 30 }];
    expect(timeWeightedMean(readings, 61 * minute, 5 * minute)).toBeCloseTo((10 * 5 + 20 * 5 + 30) / 11, 12);
    expect(timeWeightedMean([{ at: 0, value: 7 }], quarter, minute)).toBe(7);
    expect(timeWeightedMean([], quarter, minute)).toBeNull();
  });
});
