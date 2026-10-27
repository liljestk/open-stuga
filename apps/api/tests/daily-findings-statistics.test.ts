import { describe, expect, it } from "vitest";
import {
  benjaminiHochberg,
  FALSE_DISCOVERY_RATE,
  hourlyWeather,
  peerCountTest,
  peerLevelTest,
  twoSidedNormalP,
  twoSidedStudentP,
  weatherDriver,
  type PeriodObservation,
} from "../src/daily-analytics-findings/peer-statistics.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const DAYS = 21;
/** Houses check up to 80 series a day; this is how many tests share one false-discovery control. */
const SERIES_PER_RUN = 80;
/** The simulation gates evaluate thousands of synthetic months; coverage instrumentation slows them several-fold. */
const SIMULATION_TIMEOUT_MS = 60_000;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function normal(next: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(next(), 1e-12))) * Math.cos(2 * Math.PI * next());
}

interface Scenario {
  /** Shift of the current period's level. */
  effect: number;
  /** Sd of a year's own level around the long-run level. */
  yearSd: number;
  /** Sd and persistence of day-to-day noise. */
  daySd: number;
  persistence: number;
  /** Level change per degree-hour per day; 0 for no weather response. */
  weatherSlope?: number;
  /** How much colder the current month is than the baseline months (°C). */
  currentColder?: number;
  years?: number;
  /** Year-to-year spread assumed before years are seen (half a notable difference). */
  assumed?: number;
}

/** One month-to-date period: hourly outdoor weather and the daily levels it drives. */
function period(next: () => number, scenario: Scenario, yearIndex: number, current: boolean): PeriodObservation {
  const start = Date.UTC(2026 - yearIndex, 0, 1);
  const end = start + DAYS * DAY;
  const monthMean = -4 + normal(next) * 2 - (current ? scenario.currentColder ?? 0 : 0);
  const samples: Array<{ timestamp: string; temperatureC: number }> = [];
  let front = 0;
  for (let hour = 0; hour < DAYS * 24; hour += 1) {
    if (hour % 24 === 0) front = 0.7 * front + normal(next) * 3;
    const temperatureC = monthMean + front + 3 * Math.sin((2 * Math.PI * (hour % 24 - 9)) / 24);
    samples.push({ timestamp: new Date(start + hour * HOUR).toISOString(), temperatureC });
  }
  const weather = hourlyWeather(samples);
  const yearLevel = 10 + normal(next) * scenario.yearSd + (current ? scenario.effect : 0);
  let noise = 0;
  const daily = Array.from({ length: DAYS }, (_, day) => {
    noise = scenario.persistence * noise + Math.sqrt(1 - scenario.persistence ** 2) * normal(next) * scenario.daySd;
    const dayStart = start + day * DAY;
    const driver = weatherDriver(weather, { start: dayStart, end: dayStart + DAY, driver: "heating-degree-hours", baseTemperatureC: 17 })!;
    return { start: dayStart, end: dayStart + DAY, level: yearLevel + (scenario.weatherSlope ?? 0) * driver + noise };
  });
  return { start, end, level: daily.reduce((sum, day) => sum + day.level, 0) / DAYS, daily, weather };
}

/** Share of series flagged, each run of 80 under one false-discovery control. */
function flaggedRate(seed: number, runs: number, scenario: Scenario, adjust: boolean): number {
  const next = random(seed);
  let flagged = 0;
  for (let run = 0; run < runs; run += 1) {
    const pValues = Array.from({ length: SERIES_PER_RUN }, () => {
      const years = scenario.years ?? 5;
      const result = peerLevelTest({
        current: period(next, scenario, 0, true),
        baseline: Array.from({ length: years }, (_, index) => period(next, scenario, index + 1, false)),
        resolution: 0.005,
        assumedYearSpread: scenario.assumed ?? 0.5,
        adjustFor: adjust ? { driver: "heating-degree-hours", baseTemperatureC: 17 } : null,
      });
      return result?.pValue ?? 1;
    });
    flagged += benjaminiHochberg(pValues).filter((value) => value <= FALSE_DISCOVERY_RATE).length;
  }
  return flagged / (runs * SERIES_PER_RUN);
}

describe("daily finding statistics", () => {
  it("computes normal tails and Benjamini–Hochberg adjustments", () => {
    expect(twoSidedNormalP(0)).toBeCloseTo(1, 6);
    expect(twoSidedNormalP(1.959964)).toBeCloseTo(0.05, 5);
    expect(twoSidedNormalP(-3)).toBeCloseTo(0.0027, 4);
    // Reference values of the Student-t distribution.
    expect(twoSidedStudentP(2.776445, 4)).toBeCloseTo(0.05, 5);
    expect(twoSidedStudentP(12.7062, 1)).toBeCloseTo(0.05, 4);
    expect(twoSidedStudentP(2.446912, 6)).toBeCloseTo(0.05, 5);
    expect(twoSidedStudentP(4.302653, 2)).toBeCloseTo(0.05, 5);
    expect(twoSidedStudentP(3.182446, 3)).toBeCloseTo(0.05, 5);
    expect(benjaminiHochberg([0.01, 0.04, 0.03, 0.5])).toEqual([0.04, 0.04 * 4 / 3, 0.04 * 4 / 3, 0.5].map((value) => expect.closeTo(value, 9)));
  });

  it("rarely flags months that differ only by chance (gate: false-positive rate ≤ 1%)", () => {
    const noisyYears = flaggedRate(11, 6, { effect: 0, yearSd: 0.6, daySd: 0.8, persistence: 0.6 }, false);
    const fewYears = flaggedRate(12, 6, { effect: 0, yearSd: 0.6, daySd: 0.8, persistence: 0.6, years: 2 }, false);
    expect(noisyYears).toBeLessThanOrEqual(0.01);
    // With two baseline years the year-to-year spread is unknown, so this is the weakest case.
    expect(fewYears).toBeLessThanOrEqual(0.05);
  }, SIMULATION_TIMEOUT_MS);

  it("detects a real shift well beyond the years' normal spread (gate: detection rate ≥ 90%)", () => {
    expect(flaggedRate(21, 3, { effect: 3, yearSd: 0.6, daySd: 0.8, persistence: 0.6 }, false)).toBeGreaterThanOrEqual(0.9);
  }, SIMULATION_TIMEOUT_MS);

  it("does not report a cold month as more electricity once weather is adjusted", () => {
    // 0.02 kWh per degree-hour per day, current month 8 °C colder than its peers, as in a hard winter.
    const scenario: Scenario = { effect: 0, yearSd: 0.3, daySd: 0.6, persistence: 0.4, weatherSlope: 0.02, currentColder: 8 };
    const unadjusted = flaggedRate(31, 3, scenario, false);
    const adjusted = flaggedRate(31, 3, scenario, true);
    expect(unadjusted).toBeGreaterThan(0.5);
    expect(adjusted).toBeLessThanOrEqual(0.02);
    // A real increase on top of the cold is still found.
    expect(flaggedRate(32, 3, { ...scenario, effect: 3 }, true)).toBeGreaterThanOrEqual(0.9);
  }, SIMULATION_TIMEOUT_MS);

  it("adjusts with a slope fitted on the baseline days and reports it", () => {
    const next = random(41);
    const scenario: Scenario = { effect: 0, yearSd: 0.1, daySd: 0.3, persistence: 0.2, weatherSlope: 0.02, currentColder: 5 };
    const result = peerLevelTest({
      current: period(next, scenario, 0, true),
      baseline: [1, 2, 3, 4, 5].map((year) => period(next, scenario, year, false)),
      resolution: 0.005,
      assumedYearSpread: 0.5,
      adjustFor: { driver: "heating-degree-hours", baseTemperatureC: 17 },
    })!;
    expect(result.weather?.driver).toBe("heating-degree-hours");
    expect(result.weather!.slope).toBeCloseTo(0.02, 2);
    expect(result.weather!.currentDriver).toBeGreaterThan(Math.max(...result.weather!.baselineDrivers) - 1);
    expect(Math.abs(result.zScore)).toBeLessThan(3);
  });

  it("tests event counts on the square-root scale", () => {
    expect(peerCountTest(13, [3])!.pValue).toBeLessThan(0.05);
    expect(peerCountTest(5, [3])!.pValue).toBeGreaterThan(0.3);
    // Five quiet years make a busy month clearer; a wildly varying history makes it less so.
    expect(peerCountTest(13, [3, 4, 2, 3, 4])!.pValue).toBeLessThan(peerCountTest(13, [3])!.pValue);
    expect(peerCountTest(13, [1, 12, 2, 15, 3])!.pValue).toBeGreaterThan(0.1);
  });
});
