/**
 * Hourly forecasting models. Both start from the latest reading, never from a
 * window mean, so a forecast is continuous with what was just measured.
 *
 * - Thermal relaxation (temperature with an outdoor driver): the first-order
 *   model x' = m·x + (1 − m)·(outdoor + lift + daily cycle), fitted on recent
 *   hours including heating, plus an AR(1) correction of its one-step errors.
 * - Daily profile (humidity, CO₂, and temperature without outdoor data): an
 *   exponentially weighted hour-of-day profile, with the current deviation
 *   from it decaying at a rate chosen on recent data.
 */
import {
  dailyHarmonics,
  fitCoefficients,
  meanAbsolute,
  relaxationStep,
  rollout,
  searchTimeConstant,
  type RelaxationParameters,
  type RelaxationTransition,
} from "../relaxation-fit.js";

export const HOUR_MS = 3_600_000;
const DAY_HOURS = 24;

export type ForecastModelKind = "thermal-relaxation" | "daily-profile";

/** One hourly value, keyed by the UTC hour start. */
export interface HourlyValue {
  time: number;
  value: number;
}

export type HourlyLookup = (time: number) => number | null;

/**
 * A fitted model. Parameters are estimated on data up to the fit time, but a
 * forecast uses every observation up to its own origin, so a model refitted
 * daily still starts each forecast from the current state.
 */
export interface Forecaster {
  kind: ForecastModelKind;
  /** Values for origin + 1 h … origin + horizon h, starting from `originValue`. */
  forecast(origin: number, originValue: number, horizonHours: number): number[] | null;
}

export function hourStart(time: number): number {
  return Math.floor(time / HOUR_MS) * HOUR_MS;
}

/** Averages samples into UTC hours. */
export function hourlyAverages(samples: ReadonlyArray<{ time: number; value: number }>): HourlyValue[] {
  const buckets = new Map<number, { sum: number; count: number }>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.time) || !Number.isFinite(sample.value)) continue;
    const key = hourStart(sample.time);
    const bucket = buckets.get(key) ?? { sum: 0, count: 0 };
    bucket.sum += sample.value;
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  return [...buckets].map(([time, bucket]) => ({ time, value: bucket.sum / bucket.count }))
    .sort((left, right) => left.time - right.time);
}

export function lookup(values: readonly HourlyValue[]): HourlyLookup {
  const byTime = new Map(values.map((value) => [value.time, value.value]));
  return (time) => byTime.get(time) ?? null;
}

const MIN_THERMAL_TRANSITIONS = 48;
const AR_WINDOW_HOURS = 72;

/**
 * Fits the thermal forecaster on hourly history before `until`. Outdoor values
 * come from `outdoor` (observations in the past, the weather forecast ahead);
 * a missing future hour holds the last known outdoor value.
 */
export function fitThermalForecaster(
  history: readonly HourlyValue[],
  outdoor: HourlyLookup,
  until: number,
): Forecaster | null {
  const series = history.filter((point) => point.time <= until);
  const transitions: RelaxationTransition[] = [];
  for (let index = 1; index < series.length; index += 1) {
    const previous = series[index - 1]!;
    const current = series[index]!;
    if (current.time - previous.time !== HOUR_MS) continue;
    const drive = outdoor(previous.time);
    if (drive === null) continue;
    transitions.push({
      fromTime: previous.time,
      toTime: current.time,
      value: previous.value,
      nextValue: current.value,
      knownDrive: drive,
      regressors: [1, ...dailyHarmonics(previous.time)],
      dtHours: 1,
      weight: 1,
    });
  }
  if (transitions.length < MIN_THERMAL_TRANSITIONS) return null;
  const split = Math.floor(transitions.length * 0.75);
  const training = transitions.slice(0, split);
  const tuning = transitions.slice(split);
  const search = searchTimeConstant((tauHours) => {
    const coefficients = fitCoefficients(training, tauHours, 0.02);
    return coefficients ? meanAbsolute(rollout(tuning, { tauHours, coefficients }).residuals) : null;
  }, 2, 1_000, 24);
  if (!search) return null;
  const coefficients = fitCoefficients(transitions, search.tauHours, 0.02);
  if (!coefficients) return null;
  const parameters: RelaxationParameters = { tauHours: search.tauHours, coefficients };
  // AR(1) on recent one-step errors: what the model keeps missing right now
  // (heating, an open window) fades out with the fitted persistence.
  const recent = transitions.filter((transition) => transition.toTime > until - AR_WINDOW_HOURS * HOUR_MS);
  const residuals = recent.map((transition) => transition.nextValue - relaxationStep(transition.value, transition, parameters));
  let numerator = 0;
  let denominator = 0;
  for (let index = 1; index < residuals.length; index += 1) {
    numerator += residuals[index - 1]! * residuals[index]!;
    denominator += residuals[index - 1]! * residuals[index - 1]!;
  }
  const persistence = denominator > 0 ? Math.max(0, Math.min(0.98, numerator / denominator)) : 0;
  const observed = lookup(history);
  /** The model's last one-step error, measured on the hour ending at the origin. */
  const residualAt = (origin: number): number => {
    const end = hourStart(origin);
    const previous = observed(end - HOUR_MS);
    const current = observed(end);
    const drive = outdoor(end - HOUR_MS);
    if (previous === null || current === null || drive === null) return 0;
    return current - relaxationStep(previous, { knownDrive: drive, regressors: [1, ...dailyHarmonics(end - HOUR_MS)], dtHours: 1 }, parameters);
  };
  const lastKnownOutdoor = (origin: number): number | null => {
    for (let hours = 0; hours <= 6; hours += 1) {
      const value = outdoor(hourStart(origin) - hours * HOUR_MS);
      if (value !== null) return value;
    }
    return null;
  };
  return {
    kind: "thermal-relaxation",
    forecast(origin, originValue, horizonHours) {
      const values: number[] = [];
      const lastResidual = residualAt(origin);
      let state = originValue;
      let held = lastKnownOutdoor(origin);
      for (let step = 1; step <= horizonHours; step += 1) {
        const time = hourStart(origin) + (step - 1) * HOUR_MS;
        const drive = outdoor(time) ?? held;
        if (drive === null) return null;
        held = drive;
        state = relaxationStep(state, { knownDrive: drive, regressors: [1, ...dailyHarmonics(time)], dtHours: 1 }, parameters)
          + lastResidual * persistence ** step;
        values.push(state);
      }
      return values;
    },
  };
}

const MIN_PROFILE_DAYS = 3;
const LEVEL_WEIGHTS = [0.02, 0.05, 0.1];
const TREND_WEIGHTS = [0, 0.02];
const SEASON_WEIGHTS = [0.1, 0.2, 0.35];
const DECAY_CANDIDATES = [0.5, 0.7, 0.85, 0.92];
/** Share of the same hour yesterday blended in, chosen separately for 1–12 h and 13–24 h. */
const BLEND_CANDIDATES = [0, 0.25, 0.5, 0.75];
const SHORT_BLEND_HOURS = 12;
const TREND_DAMPING = 0.98;
const SELECTION_DAYS = 5;

interface SeasonalState {
  level: number;
  trend: number;
  season: number[];
}

/** Σ φʲ for j = 1…k: how much of today's trend a damped trend keeps after k hours. */
const DAMPED_STEPS = Array.from({ length: 169 }, (_, steps) => {
  let sum = 0;
  for (let step = 1; step <= steps; step += 1) sum += TREND_DAMPING ** step;
  return sum;
});

/**
 * Additive Holt–Winters with a damped trend and a 24-hour season, run hour by
 * hour. Returns the state after each observed hour, so every origin sees only
 * its own past.
 */
function holtWinters(
  series: readonly HourlyValue[],
  { alpha, beta, gamma }: { alpha: number; beta: number; gamma: number },
): Map<number, SeasonalState> {
  const states = new Map<number, SeasonalState>();
  const firstDay = series.filter((point) => point.time < series[0]!.time + DAY_HOURS * HOUR_MS);
  const level0 = firstDay.reduce((sum, point) => sum + point.value, 0) / firstDay.length;
  const season = new Array<number>(DAY_HOURS).fill(0);
  for (const point of firstDay) season[new Date(point.time).getUTCHours()] = point.value - level0;
  let level = level0;
  let trend = 0;
  for (const point of series) {
    const hour = new Date(point.time).getUTCHours();
    const previousLevel = level;
    level = alpha * (point.value - season[hour]!) + (1 - alpha) * (level + TREND_DAMPING * trend);
    trend = beta * (level - previousLevel) + (1 - beta) * TREND_DAMPING * trend;
    season[hour] = gamma * (point.value - level) + (1 - gamma) * season[hour]!;
    states.set(point.time, { level, trend, season: [...season] });
  }
  return states;
}

interface ProfileChoice {
  states: Map<number, SeasonalState>;
  alpha: number;
  beta: number;
  gamma: number;
  decay: number;
  shortBlend: number;
  longBlend: number;
}

function profileForecast(
  choice: ProfileChoice,
  state: SeasonalState,
  { values, origin, originValue, step }: { values: HourlyLookup; origin: number; originValue: number; step: number },
): number {
  const surprise = originValue - (state.level + state.season[new Date(origin).getUTCHours()]!);
  const time = origin + step * HOUR_MS;
  const seasonal = state.level + DAMPED_STEPS[Math.min(step, 168)]! * state.trend
    + state.season[new Date(time).getUTCHours()]! + surprise * choice.decay ** step;
  const yesterday = step <= DAY_HOURS ? values(time - DAY_HOURS * HOUR_MS) : null;
  const blend = step <= SHORT_BLEND_HOURS ? choice.shortBlend : choice.longBlend;
  return yesterday === null ? seasonal : (1 - blend) * seasonal + blend * yesterday;
}

/**
 * Daily-profile forecaster: additive Holt–Winters (level, damped trend and a
 * 24-hour season, all exponentially smoothed), starting from the latest
 * reading whose surprise fades at a fitted rate, blended with the same hour
 * yesterday for horizons up to a day. Every weight is chosen out of sample on
 * up to the last five days of origins.
 */
export function fitProfileForecaster(history: readonly HourlyValue[], until: number): Forecaster | null {
  const series = history.filter((point) => point.time <= until);
  if (!series.length || (until - series[0]!.time) / (DAY_HOURS * HOUR_MS) < MIN_PROFILE_DAYS) return null;
  const values = lookup(series);
  const selectionFrom = Math.max(hourStart(until) - SELECTION_DAYS * DAY_HOURS * HOUR_MS, series[0]!.time + DAY_HOURS * HOUR_MS);
  const selectionError = (choice: ProfileChoice): number => {
    let error = 0;
    let count = 0;
    for (let origin = selectionFrom; origin < hourStart(until); origin += 3 * HOUR_MS) {
      const state = choice.states.get(origin);
      const originValue = values(origin);
      if (!state || originValue === null) continue;
      for (let step = 1; step <= DAY_HOURS && origin + step * HOUR_MS <= until; step += 1) {
        const actual = values(origin + step * HOUR_MS);
        if (actual === null) continue;
        error += Math.abs(actual - profileForecast(choice, state, { values, origin, originValue, step }));
        count += 1;
      }
    }
    return count > 0 ? error / count : Number.POSITIVE_INFINITY;
  };
  // Stage one: smoothing and fade without blending; stage two: the blends.
  let best: (ProfileChoice & { error: number }) | null = null;
  for (const alpha of LEVEL_WEIGHTS) {
    for (const beta of TREND_WEIGHTS) {
      for (const gamma of SEASON_WEIGHTS) {
        const states = holtWinters(series, { alpha, beta, gamma });
        for (const decay of DECAY_CANDIDATES) {
          const choice = { states, alpha, beta, gamma, decay, shortBlend: 0, longBlend: 0 };
          const error = selectionError(choice);
          if (Number.isFinite(error) && (!best || error < best.error)) best = { ...choice, error };
        }
      }
    }
  }
  if (best) {
    const smoothed = best;
    for (const shortBlend of BLEND_CANDIDATES) {
      for (const longBlend of BLEND_CANDIDATES) {
        const choice = { ...smoothed, shortBlend, longBlend };
        const error = selectionError(choice);
        if (error < best.error) best = { ...choice, error };
      }
    }
  }
  if (!best) return null;
  // A state after hour t depends only on data up to t, so running the chosen
  // weights over all history lets each origin start from its own present.
  const chosen = { ...best, states: holtWinters(history, best) };
  const observed = lookup(history);
  return {
    kind: "daily-profile",
    forecast(origin, originValue, horizonHours) {
      const state = chosen.states.get(hourStart(origin));
      if (!state) return null;
      return Array.from({ length: horizonHours }, (_, index) => (
        profileForecast(chosen, state, { values: observed, origin: hourStart(origin), originValue, step: index + 1 })
      ));
    },
  };
}
