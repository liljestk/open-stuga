import { median, medianAbsoluteDeviation } from "@climate-twin/analytics-kernel";
import { DEFAULT_HEATING_BASE_TEMPERATURE_C } from "../analytics/house-parameters.js";

const HOUR_MS = 3_600_000;
/** Scales a median absolute deviation to the standard deviation of normal data. */
const MAD_SCALE = 1.4826;
/** A median of normal values has π/2 times the variance of their mean. */
const MEDIAN_VARIANCE_FACTOR = Math.PI / 2;
/** Day-to-day persistence above this is treated as this, so a month always counts as a few independent days. */
const MAX_DAILY_AUTOCORRELATION = 0.8;
const MIN_WEATHER_PAIRS = 10;
const MIN_NOISE_DAYS = 3;
/** A weather slope must be at least this many standard errors above zero before a baseline is moved. */
const MIN_WEATHER_T = 2;
/**
 * Pseudo-years at the assumed spread pooled with the baseline years' own
 * variation, so one or two earlier years cannot claim to vary less than a
 * difference that matters in practice.
 */
const PRIOR_YEARS = 2;

/** Expected share of reported findings that are chance differences. */
export const FALSE_DISCOVERY_RATE = 0.1;

export type WeatherDriver = "heating-degree-hours" | "outdoor-temperature";
export type PeerSpreadBasis = "between-years" | "assumed" | "day-to-day" | "resolution" | "counts";

/** Hour start (ms) → mean outdoor temperature in that hour. */
export type HourlyWeather = ReadonlyMap<number, number>;

/** One day of a period, in the period's comparable level units. */
export interface DailyLevel {
  start: number;
  end: number;
  level: number;
}

export interface PeriodObservation {
  start: number;
  end: number;
  /** The mean, or the total per day for sums and deltas. */
  level: number;
  daily: readonly DailyLevel[];
  weather?: HourlyWeather | null;
}

export interface PeerWeatherAdjustment {
  driver: WeatherDriver;
  baseTemperatureC?: number;
  /** Level change per unit of the driver (per degree-hour per day, or per °C). */
  slope: number;
  currentDriver: number;
  baselineDrivers: number[];
}

export interface PeerTestResult {
  /** Baseline levels, moved to the current period's weather when that applied. */
  baselineLevels: number[];
  zScore: number;
  pValue: number;
  spreadBasis: PeerSpreadBasis;
  weather: PeerWeatherAdjustment | null;
}

export function hourlyWeather(samples: ReadonlyArray<{ timestamp: string; temperatureC: number }>): Map<number, number> {
  const sums = new Map<number, { total: number; count: number }>();
  for (const sample of samples) {
    const time = Date.parse(sample.timestamp);
    if (!Number.isFinite(time) || !Number.isFinite(sample.temperatureC)) continue;
    const hour = Math.floor(time / HOUR_MS) * HOUR_MS;
    const entry = sums.get(hour) ?? { total: 0, count: 0 };
    entry.total += sample.temperatureC;
    entry.count += 1;
    sums.set(hour, entry);
  }
  return new Map([...sums].map(([hour, entry]) => [hour, entry.total / entry.count]));
}

/**
 * The weather over [start, end): heating degree-hours per day below the base,
 * or the mean outdoor temperature. Null when fewer than half the hours are known.
 */
export function weatherDriver(
  weather: HourlyWeather,
  start: number,
  end: number,
  driver: WeatherDriver,
  baseTemperatureC = DEFAULT_HEATING_BASE_TEMPERATURE_C,
): number | null {
  let total = 0;
  let count = 0;
  for (let hour = Math.ceil(start / HOUR_MS) * HOUR_MS; hour < end; hour += HOUR_MS) {
    const temperature = weather.get(hour);
    if (temperature === undefined) continue;
    total += driver === "heating-degree-hours" ? Math.max(0, baseTemperatureC - temperature) * 24 : temperature;
    count += 1;
  }
  return count > 0 && count >= (end - start) / HOUR_MS / 2 ? total / count : null;
}

/** Day-to-day weather response, fitted within each year so a year-level shift is not mistaken for weather. */
function weatherSlope(groups: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>): { slope: number; t: number } | null {
  const centered: Array<{ x: number; y: number }> = [];
  let groupsUsed = 0;
  for (const group of groups) {
    if (group.length < 2) continue;
    const meanX = group.reduce((sum, pair) => sum + pair.x, 0) / group.length;
    const meanY = group.reduce((sum, pair) => sum + pair.y, 0) / group.length;
    for (const pair of group) centered.push({ x: pair.x - meanX, y: pair.y - meanY });
    groupsUsed += 1;
  }
  const sxx = centered.reduce((sum, pair) => sum + pair.x * pair.x, 0);
  const degreesOfFreedom = centered.length - groupsUsed - 1;
  if (centered.length < MIN_WEATHER_PAIRS || degreesOfFreedom < 1 || sxx <= 1e-12) return null;
  const slope = centered.reduce((sum, pair) => sum + pair.x * pair.y, 0) / sxx;
  const residual = centered.reduce((sum, pair) => sum + (pair.y - slope * pair.x) ** 2, 0);
  const standardError = Math.sqrt(residual / degreesOfFreedom / sxx);
  return { slope, t: standardError > 0 ? slope / standardError : Number.POSITIVE_INFINITY };
}

/** Variance of a baseline median relative to a single period's variance. */
const medianVariance = (count: number): number => (count >= 3 ? MEDIAN_VARIANCE_FACTOR : 1) / count;

/** Two-sided normal tail probability (Abramowitz–Stegun 7.1.26, absolute error below 1.5e-7). */
export function twoSidedNormalP(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
    * Math.exp(-x * x);
  return Math.max(0, Math.min(1, erfc));
}

/** Two-sided Student-t tail probability for whole degrees of freedom (Abramowitz–Stegun 26.7.3–4). */
export function twoSidedStudentP(t: number, degreesOfFreedom: number): number {
  const freedom = Math.max(1, Math.round(degreesOfFreedom));
  const theta = Math.atan(Math.abs(t) / Math.sqrt(freedom));
  const cosine = Math.cos(theta);
  const cosineSquared = cosine * cosine;
  let sum = 1;
  let term = 1;
  let probability: number;
  if (freedom % 2 === 1) {
    for (let k = 3; k <= freedom - 2; k += 2) {
      term *= cosineSquared * (k - 1) / k;
      sum += term;
    }
    probability = freedom === 1 ? 2 * theta / Math.PI : (2 / Math.PI) * (theta + Math.sin(theta) * cosine * sum);
  } else {
    for (let k = 2; k <= freedom - 2; k += 2) {
      term *= cosineSquared * (k - 1) / k;
      sum += term;
    }
    probability = Math.sin(theta) * sum;
  }
  return Math.max(0, Math.min(1, 1 - probability));
}

/** Benjamini–Hochberg adjusted p-values, in input order. */
export function benjaminiHochberg(pValues: readonly number[]): number[] {
  const count = pValues.length;
  const order = pValues.map((_, index) => index).sort((left, right) => pValues[left]! - pValues[right]!);
  const adjusted = new Array<number>(count);
  let running = 1;
  for (let rank = count; rank >= 1; rank -= 1) {
    const index = order[rank - 1]!;
    running = Math.min(running, (pValues[index]! * count) / rank);
    adjusted[index] = running;
  }
  return adjusted;
}

/**
 * Compares a period's level with the same period in earlier years, centred on
 * their median. The spread is the larger of how much the baseline years vary
 * (pooled with `assumedYearSpread` as a prior) and what day-to-day noise alone
 * would produce, never below the source's resolution; a spread that rests on
 * few years is judged on Student-t tails. Temperature and electricity can first
 * be moved to the current period's weather using a slope fitted on the
 * baseline days.
 */
export function peerLevelTest(input: {
  current: PeriodObservation;
  baseline: readonly PeriodObservation[];
  resolution: number;
  /** Year-to-year spread assumed before any years are seen, in level units. */
  assumedYearSpread: number;
  adjustFor?: { driver: WeatherDriver; baseTemperatureC: number } | null;
}): PeerTestResult | null {
  const count = input.baseline.length;
  if (count === 0) return null;
  let weather: PeerWeatherAdjustment | null = null;
  const dayDriver = (period: PeriodObservation, day: DailyLevel): number | null => (
    input.adjustFor && period.weather
      ? weatherDriver(period.weather, day.start, day.end, input.adjustFor.driver, input.adjustFor.baseTemperatureC)
      : null
  );
  if (input.adjustFor) {
    const { driver, baseTemperatureC } = input.adjustFor;
    const periodDriver = (period: PeriodObservation) => (
      period.weather ? weatherDriver(period.weather, period.start, period.end, driver, baseTemperatureC) : null
    );
    const currentDriver = periodDriver(input.current);
    const baselineDrivers = input.baseline.map(periodDriver);
    if (currentDriver !== null && baselineDrivers.every((value) => value !== null)) {
      const fit = weatherSlope(input.baseline.map((period) => period.daily.flatMap((day) => {
        const x = dayDriver(period, day);
        return x === null ? [] : [{ x, y: day.level }];
      })));
      if (fit && fit.slope > 0 && fit.t >= MIN_WEATHER_T) {
        weather = {
          driver,
          ...(driver === "heating-degree-hours" ? { baseTemperatureC } : {}),
          slope: fit.slope,
          currentDriver,
          baselineDrivers: baselineDrivers as number[],
        };
      }
    }
  }
  const baselineLevels = input.baseline.map((period, index) => (
    weather ? period.level + weather.slope * (weather.currentDriver - weather.baselineDrivers[index]!) : period.level
  ));
  const baselineMedian = median(baselineLevels)!;

  // Day-to-day noise after weather, with persistence shrinking the effective day count.
  const residuals = [input.current, ...input.baseline].map((period) => {
    const levels = period.daily.flatMap((day) => {
      if (!weather) return [day.level];
      const x = dayDriver(period, day);
      return x === null ? [] : [day.level - weather.slope * x];
    });
    const center = median(levels);
    return center === null ? [] : levels.map((level) => level - center);
  });
  const pooled = residuals.flat();
  const lagged = residuals.reduce((sum, series) => sum + series.slice(1).reduce((inner, value, index) => inner + value * series[index]!, 0), 0);
  const energy = pooled.reduce((sum, value) => sum + value * value, 0);
  const autocorrelation = energy > 0 ? Math.max(0, Math.min(MAX_DAILY_AUTOCORRELATION, lagged / energy)) : 0;
  const effective = (days: number) => Math.max(1, days * (1 - autocorrelation) / (1 + autocorrelation));
  const currentDays = residuals[0]!.length;
  const baselineDays = residuals.slice(1).reduce((sum, series) => sum + series.length, 0) / count;
  let dayVariance: number | null = null;
  if (currentDays >= MIN_NOISE_DAYS && baselineDays >= MIN_NOISE_DAYS) {
    const spread = MAD_SCALE * (median(pooled.map(Math.abs)) ?? 0);
    dayVariance = spread ** 2 * (1 / effective(currentDays) + medianVariance(count) / effective(baselineDays));
  }
  const baselineMean = baselineLevels.reduce((sum, level) => sum + level, 0) / count;
  const sampleSquares = baselineLevels.reduce((sum, level) => sum + (level - baselineMean) ** 2, 0);
  const yearFreedom = PRIOR_YEARS + count - 1;
  const yearSpreadSquared = (PRIOR_YEARS * input.assumedYearSpread ** 2 + sampleSquares) / yearFreedom;
  const yearVariance = yearSpreadSquared * (1 + medianVariance(count));
  const floor = input.resolution ** 2;
  const variance = Math.max(dayVariance ?? 0, yearVariance, floor);
  const spreadBasis: PeerSpreadBasis = variance === floor
    ? "resolution"
    : yearVariance >= (dayVariance ?? 0) ? count >= 2 ? "between-years" : "assumed" : "day-to-day";
  const zScore = (input.current.level - baselineMedian) / Math.sqrt(variance);
  const pValue = spreadBasis === "between-years" || spreadBasis === "assumed"
    ? twoSidedStudentP(zScore, yearFreedom)
    : twoSidedNormalP(zScore);
  return { baselineLevels, zScore, pValue, spreadBasis, weather };
}

/**
 * Compares event counts on the variance-stabilised square-root scale, where a
 * Poisson count has unit variance; extra spread between baseline years widens it.
 */
export function peerCountTest(current: number, baseline: readonly number[]): PeerTestResult | null {
  const count = baseline.length;
  if (count === 0) return null;
  const transform = (value: number) => 2 * Math.sqrt(Math.max(0, value) + 3 / 8);
  const transformed = baseline.map(transform);
  const yearSpread = count >= 3 ? MAD_SCALE * (medianAbsoluteDeviation(transformed) ?? 0) : 0;
  const variance = Math.max(1, yearSpread ** 2) * (1 + medianVariance(count));
  const zScore = (transform(current) - median(transformed)!) / Math.sqrt(variance);
  return {
    baselineLevels: [...baseline],
    zScore,
    pValue: twoSidedNormalP(zScore),
    spreadBasis: yearSpread > 1 ? "between-years" : "counts",
    weather: null,
  };
}
