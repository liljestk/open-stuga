import { describe, expect, it } from "vitest";
import type { DailyEnergy } from "../src/analytics/home-performance/energy-index.js";
import { backtestProjection, projectEnergy } from "../src/electricity/projection.js";
import { cheapestWindow, flexibleLoadProfile, shiftSavingsEurPerDay, type PowerBucket } from "../src/electricity/flexible-loads.js";

const DAY = 86_400_000;
const START = Date.parse("2025-08-01T00:00:00.000Z");

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

/**
 * An autumn into winter: outdoor temperature falls about 0.15 °C a day with
 * weather fronts, and a heated home uses a base load plus energy per
 * degree-hour below 17 °C.
 */
function heatedAutumn(seed: number, days = 150, options: { slope?: number; trend?: number } = {}): DailyEnergy[] {
  const next = random(seed);
  const slope = options.slope ?? 0.006;
  const trend = options.trend ?? 0.15;
  let front = 0;
  return Array.from({ length: days }, (_, day) => {
    front = 0.75 * front + (next() - 0.5) * 6;
    const outdoorC = 14 - trend * day + front;
    const degreeHours = Math.max(0, 17 - outdoorC) * 24;
    return { dayStart: START + day * DAY, degreeHours, energyKwh: Math.max(0, 9 + slope * degreeHours + (next() - 0.5) * 3) };
  });
}

describe("thirty-day energy projection", () => {
  it("beats repeating the last thirty days through a cooling autumn (gate: skill ≥ 0.25)", () => {
    for (const seed of [1, 2, 3]) {
      const history = heatedAutumn(seed);
      const errors = backtestProjection(history);
      const mean = (values: number[]) => values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length;
      expect(errors.model.length).toBeGreaterThanOrEqual(20);
      expect(1 - mean(errors.model) / mean(errors.baseline), `seed ${seed}`).toBeGreaterThanOrEqual(0.25);
    }
  });

  it("uses the regression with its backtest interval and confidence", () => {
    const history = heatedAutumn(4);
    const projection = projectEnergy({ history: history.slice(0, -30), forecastDegreeHours: history.slice(-30, -20).map((day) => day.degreeHours) })!;
    const actual = history.slice(-30).reduce((sum, day) => sum + day.energyKwh, 0);
    expect(projection.method).toBe("weather-regression");
    expect(projection.heatingSlopeKwhPerDegreeHour).toBeCloseTo(0.006, 2);
    expect(projection.backtest.skill).toBeGreaterThan(0.25);
    expect(projection.lowKwh).toBeLessThanOrEqual(actual);
    expect(projection.highKwh).toBeGreaterThanOrEqual(actual);
    expect(["medium", "high"]).toContain(projection.confidence);
  });

  it("repeats the last thirty days when the weather explains nothing", () => {
    // Summer: no degree-hours, so there is no heating slope to fit.
    const history = heatedAutumn(5, 120, { trend: -0.05 }).map((day) => ({ ...day, degreeHours: 0 }));
    const projection = projectEnergy({ history, forecastDegreeHours: [] })!;
    expect(projection.method).toBe("recent-average");
    expect(projection.heatingSlopeKwhPerDegreeHour).toBeNull();
    const recent = history.slice(-30).reduce((sum, day) => sum + day.energyKwh, 0);
    expect(projection.next30DaysKwh).toBeCloseTo(recent, 6);
  });

  it("has low confidence and a default interval with too little history to backtest", () => {
    const projection = projectEnergy({ history: heatedAutumn(6, 20), forecastDegreeHours: [] })!;
    expect(projection.backtest.origins).toBe(0);
    expect(projection.confidence).toBe("low");
    expect(projection.highKwh / projection.next30DaysKwh).toBeCloseTo(1.25, 6);
  });
});

describe("flexible loads", () => {
  const BUCKET = 5 * 60_000;
  const weekStart = Date.parse("2026-10-19T00:00:00.000Z");
  const week = 7 * DAY;
  /** A dishwasher: 2 kW for 90 minutes each evening at 19:00, idle at 2 W. */
  const dishwasher = (startHour = 19, minutes = 90, watts = 2_000): PowerBucket[] => Array.from({ length: week / BUCKET }, (_, index) => {
    const time = weekStart + index * BUCKET;
    const minuteOfDay = (time - weekStart) % DAY / 60_000;
    const running = minuteOfDay >= startHour * 60 && minuteOfDay < startHour * 60 + minutes;
    return { time, watts: running ? watts : 2 };
  });
  /** Evening peak at 20 c/kWh, nights at 5 c/kWh. */
  const prices = Array.from({ length: 9 * 24 }, (_, hour) => {
    const start = weekStart + hour * 3_600_000;
    const hourOfDay = hour % 24;
    return { start, end: start + 3_600_000, centsPerKwh: hourOfDay >= 17 && hourOfDay < 21 ? 20 : hourOfDay < 6 ? 5 : 10 };
  });

  it("measures runs, what they paid, and what moving them would save", () => {
    const profile = flexibleLoadProfile(dishwasher(), prices, weekStart, weekStart + week)!;
    expect(profile.runs).toBe(7);
    expect(profile.typicalRunMs).toBe(90 * 60_000);
    expect(profile.dailyKwh).toBeCloseTo(3, 1);
    expect(profile.paidCentsPerKwh).toBeCloseTo(20, 6);
    const window = cheapestWindow(prices, profile.typicalRunMs, weekStart + week, weekStart + week + DAY)!;
    expect(window.averageCentsPerKwh).toBe(5);
    expect(new Date(window.start).getUTCHours()).toBeLessThan(6);
    // 3 kWh a day moved from 20 to 5 c/kWh.
    expect(shiftSavingsEurPerDay(profile, window)).toBeCloseTo(0.45, 2);
  });

  it("does not treat continuous or rare loads as shiftable", () => {
    const fridge = dishwasher(0, 20 * 60, 150);
    expect(flexibleLoadProfile(fridge, prices, weekStart, weekStart + week)).toBeNull();
    const rare = dishwasher().map((bucket) => (bucket.time < weekStart + 5 * DAY ? { ...bucket, watts: 2 } : bucket));
    expect(flexibleLoadProfile(rare, prices, weekStart, weekStart + week)).toBeNull();
  });
});
