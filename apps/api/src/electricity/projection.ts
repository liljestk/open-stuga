import { quantile } from "@climate-twin/analytics-kernel";
import { heatingRegression, type DailyEnergy } from "../analytics/home-performance/energy-index.js";

const DAY_MS = 86_400_000;
export const PROJECTION_HORIZON_DAYS = 30;
/** Days of history a projection is fitted on. */
const FIT_DAYS = 60;
/** The least history a backtest origin is fitted on. */
const MIN_FIT_DAYS = 21;
const ORIGIN_STEP_DAYS = 3;
/** Days ahead the weather forecast usually reaches; beyond it, recent weather is held. */
export const FORECAST_REACH_DAYS = 10;
const PERSISTENCE_DAYS = 14;
const MIN_HELD_FORECAST_DAYS = 5;
/** A horizon missing more days than this cannot be scored. */
const MAX_MISSING_HORIZON_DAYS = 3;
const MIN_INTERVAL_ORIGINS = 5;
const DEFAULT_RELATIVE_HALF_WIDTH = 0.25;

export type ProjectionMethod = "weather-regression" | "recent-average";

export interface ProjectionBacktest {
  origins: number;
  /** Signed relative errors of the chosen method, (projected − actual) / actual. */
  relativeErrors: number[];
  meanAbsolutePercentError: number | null;
  baselineMeanAbsolutePercentError: number | null;
  /** 1 − model MAE / "last 30 days repeated" MAE. */
  skill: number | null;
}

export interface EnergyProjectionResult {
  method: ProjectionMethod;
  next30DaysKwh: number;
  lowKwh: number;
  highKwh: number;
  dailyKwh: number;
  baseLoadKwhPerDay: number | null;
  heatingSlopeKwhPerDegreeHour: number | null;
  observedDays: number;
  confidence: "low" | "medium" | "high";
  backtest: ProjectionBacktest;
}

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Thirty days of the history after `origin`, or null when too many are missing. */
function horizonActual(byDay: ReadonlyMap<number, DailyEnergy>, origin: number): number | null {
  let total = 0;
  let present = 0;
  for (let day = 0; day < PROJECTION_HORIZON_DAYS; day += 1) {
    const observed = byDay.get(origin + day * DAY_MS);
    if (!observed) continue;
    total += observed.energyKwh;
    present += 1;
  }
  return PROJECTION_HORIZON_DAYS - present > MAX_MISSING_HORIZON_DAYS ? null : total * PROJECTION_HORIZON_DAYS / present;
}

/** "Last 30 days repeated": the fitted days' daily mean, thirty times over. */
function repeatedRecent(fit: readonly DailyEnergy[]): number {
  return mean(fit.slice(-PROJECTION_HORIZON_DAYS).map((day) => day.energyKwh)) * PROJECTION_HORIZON_DAYS;
}

/**
 * Base load plus heating slope applied to the horizon's degree-hours. Without
 * a heating response (summer, or no weather), it is the recent daily mean.
 */
function regressionProjection(fit: readonly DailyEnergy[], horizonDegreeHours: readonly number[]) {
  const regression = heatingRegression(fit.slice(-FIT_DAYS));
  if (!regression || regression.slope <= 0) return null;
  const total = horizonDegreeHours.reduce((sum, degreeHours) => (
    sum + Math.max(0, regression.baseLoadKwhPerDay + regression.slope * degreeHours)
  ), 0);
  return { total, regression };
}

/**
 * Forecast degree-hours where they reach, then held: the forecast's own mean
 * when it covers most of its reach (fresher than observations, which lag a
 * seasonal trend), otherwise the mean of the last two weeks.
 */
export function horizonDegreeHours(recent: readonly DailyEnergy[], forecast: readonly number[]): number[] {
  const held = forecast.length >= MIN_HELD_FORECAST_DAYS
    ? mean(forecast)
    : recent.length ? mean(recent.slice(-PERSISTENCE_DAYS).map((day) => day.degreeHours)) : 0;
  return Array.from({ length: PROJECTION_HORIZON_DAYS }, (_, day) => forecast[day] ?? held);
}

/**
 * Rolling-origin backtest over the history: each origin fits on the days
 * before it and projects the next thirty, with the observed weather standing
 * in for the forecast as far as a forecast reaches and held recent weather
 * after that, as at run time.
 */
export function backtestProjection(history: readonly DailyEnergy[]): {
  model: number[];
  baseline: number[];
} {
  const byDay = new Map(history.map((day) => [day.dayStart, day]));
  const model: number[] = [];
  const baseline: number[] = [];
  if (history.length < MIN_FIT_DAYS + PROJECTION_HORIZON_DAYS) return { model, baseline };
  const first = history[0]!.dayStart;
  const last = history.at(-1)!.dayStart;
  for (let origin = first + MIN_FIT_DAYS * DAY_MS; origin + (PROJECTION_HORIZON_DAYS - 1) * DAY_MS <= last; origin += ORIGIN_STEP_DAYS * DAY_MS) {
    const actual = horizonActual(byDay, origin);
    const fit = history.filter((day) => day.dayStart < origin && day.dayStart >= origin - FIT_DAYS * DAY_MS);
    if (actual === null || actual <= 0 || fit.length < MIN_FIT_DAYS) continue;
    const observed = Array.from({ length: FORECAST_REACH_DAYS }, (_, day) => byDay.get(origin + day * DAY_MS)?.degreeHours);
    const forecast = observed.every((value) => value !== undefined) ? observed as number[] : [];
    const projected = regressionProjection(fit, horizonDegreeHours(fit, forecast))?.total ?? repeatedRecent(fit);
    model.push((projected - actual) / actual);
    baseline.push((repeatedRecent(fit) - actual) / actual);
  }
  return { model, baseline };
}

/**
 * Projects the next thirty days. The weather regression is used only when it
 * beat "last 30 days repeated" in the backtest; its interval and confidence
 * come from the backtest's errors rather than from how complete the data is.
 */
export function projectEnergy(input: {
  history: readonly DailyEnergy[];
  forecastDegreeHours: readonly number[];
}): EnergyProjectionResult | null {
  const history = [...input.history].sort((left, right) => left.dayStart - right.dayStart);
  if (history.length === 0) return null;
  const errors = backtestProjection(history);
  const absolute = (values: number[]) => values.length ? mean(values.map(Math.abs)) : null;
  const modelError = absolute(errors.model);
  const baselineError = absolute(errors.baseline);
  const skill = modelError !== null && baselineError !== null && baselineError > 0 ? 1 - modelError / baselineError : null;
  const recent = history.filter((day) => day.dayStart > history.at(-1)!.dayStart - FIT_DAYS * DAY_MS);
  const regression = skill !== null && skill > 0
    ? regressionProjection(recent, horizonDegreeHours(recent, input.forecastDegreeHours))
    : null;
  const method: ProjectionMethod = regression ? "weather-regression" : "recent-average";
  const next30DaysKwh = regression ? regression.total : repeatedRecent(recent);
  const relativeErrors = method === "weather-regression" ? errors.model : errors.baseline;
  // actual = projected / (1 + error), so the error quantiles bound the actual total.
  const [low, high] = relativeErrors.length >= MIN_INTERVAL_ORIGINS
    ? [
      next30DaysKwh / (1 + Math.max(quantile(relativeErrors, 0.95)!, -0.9)),
      next30DaysKwh / (1 + Math.max(quantile(relativeErrors, 0.05)!, -0.9)),
    ]
    : [next30DaysKwh * (1 - DEFAULT_RELATIVE_HALF_WIDTH), next30DaysKwh * (1 + DEFAULT_RELATIVE_HALF_WIDTH)];
  const chosenError = absolute(relativeErrors);
  const confidence = chosenError === null
    ? "low"
    : relativeErrors.length >= 8 && chosenError <= 0.1 ? "high" : relativeErrors.length >= 3 && chosenError <= 0.2 ? "medium" : "low";
  return {
    method,
    next30DaysKwh,
    lowKwh: Math.max(0, Math.min(low!, next30DaysKwh)),
    highKwh: Math.max(high!, next30DaysKwh),
    dailyKwh: next30DaysKwh / PROJECTION_HORIZON_DAYS,
    baseLoadKwhPerDay: regression ? regression.regression.baseLoadKwhPerDay : null,
    heatingSlopeKwhPerDegreeHour: regression ? regression.regression.slope : null,
    observedDays: history.length,
    confidence,
    backtest: {
      origins: relativeErrors.length,
      relativeErrors,
      meanAbsolutePercentError: chosenError === null ? null : chosenError * 100,
      baselineMeanAbsolutePercentError: baselineError === null ? null : baselineError * 100,
      skill,
    },
  };
}
