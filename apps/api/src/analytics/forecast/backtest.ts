import { quantile } from "@climate-twin/analytics-kernel";
import type { MeasurementForecastHorizonSkill } from "@climate-twin/contracts";
import { HOUR_MS, hourStart, lookup, type Forecaster, type HourlyValue } from "./models.js";

export const BACKTEST_HORIZON_HOURS = 24;
const ORIGIN_STEP_HOURS = 3;
const MINIMUM_TRAINING_HOURS = 72;
const REFIT_EVERY_HOURS = 24;
const INTERVAL_LEVEL = 0.9;
const MINIMUM_ORIGINS = 8;
/** Interval widths follow the last three days of errors, so they track a model that improves or degrades. */
const CALIBRATION_ORIGINS = 24;
const MINIMUM_CALIBRATION_ERRORS = 12;

export interface BacktestResult {
  origins: number;
  horizons: MeasurementForecastHorizonSkill[];
}

interface HorizonError {
  originTime: number;
  model: number;
  persistence: number;
  sameTimeYesterday: number | null;
}

const meanAbsolute = (values: readonly number[]) => values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length;

function skill(model: number, baseline: number | null): number | null {
  return baseline === null || baseline <= 0 ? null : Number((1 - model / baseline).toFixed(4));
}

/** Conformal quantile of absolute errors with the finite-sample correction. */
function conformalHalfWidth(absoluteErrors: readonly number[]): number {
  if (!absoluteErrors.length) return 0;
  const level = Math.min(1, INTERVAL_LEVEL * (1 + 1 / absoluteErrors.length));
  return quantile(absoluteErrors, level) ?? 0;
}

/**
 * Rolling-origin backtest: every three hours after a three-day warm-up the
 * model is fitted on the data before the origin (refitted daily), forecasts
 * 24 hours, and is compared with what was measured, with "no change" and with
 * the same hour yesterday.
 *
 * Intervals are rolling conformal: the half-width at a horizon is the 90%
 * quantile of the absolute errors of the latest 24 origins whose outcome was
 * already known. Coverage replays exactly that rule over the backtest, so it
 * measures the intervals as they would have been shown.
 */
export function backtestForecaster(
  series: readonly HourlyValue[],
  fit: (until: number) => Forecaster | null,
): BacktestResult | null {
  if (series.length < MINIMUM_TRAINING_HOURS) return null;
  const values = lookup(series);
  const first = series[0]!.time;
  const last = series.at(-1)!.time;
  const errors = Array.from({ length: BACKTEST_HORIZON_HOURS }, (): HorizonError[] => []);
  let forecaster: Forecaster | null = null;
  let fittedAt = Number.NEGATIVE_INFINITY;
  let origins = 0;
  for (let origin = hourStart(first + MINIMUM_TRAINING_HOURS * HOUR_MS); origin < last; origin += ORIGIN_STEP_HOURS * HOUR_MS) {
    const originValue = values(origin);
    if (originValue === null) continue;
    if (!forecaster || origin - fittedAt >= REFIT_EVERY_HOURS * HOUR_MS) {
      forecaster = fit(origin);
      fittedAt = origin;
    }
    if (!forecaster) continue;
    const predicted = forecaster.forecast(origin, originValue, BACKTEST_HORIZON_HOURS);
    if (!predicted) continue;
    let used = false;
    for (let step = 1; step <= BACKTEST_HORIZON_HOURS; step += 1) {
      const time = origin + step * HOUR_MS;
      const actual = values(time);
      const prediction = predicted[step - 1];
      if (actual === null || prediction === undefined || !Number.isFinite(prediction)) continue;
      const yesterday = values(time - 24 * HOUR_MS);
      errors[step - 1]!.push({
        originTime: origin,
        model: actual - prediction,
        persistence: actual - originValue,
        sameTimeYesterday: yesterday === null ? null : actual - yesterday,
      });
      used = true;
    }
    if (used) origins += 1;
  }
  if (origins < MINIMUM_ORIGINS) return null;
  let widest = 0;
  const horizons = errors.flatMap((bucket, index): MeasurementForecastHorizonSkill[] => {
    if (!bucket.length) return [];
    const hours = index + 1;
    let covered = 0;
    let checked = 0;
    for (let item = 0; item < bucket.length; item += 1) {
      const current = bucket[item]!;
      // Only errors whose outcome was measured by this origin may set its interval.
      const known = bucket.slice(0, item)
        .filter((earlier) => earlier.originTime + hours * HOUR_MS <= current.originTime)
        .slice(-CALIBRATION_ORIGINS);
      if (known.length < MINIMUM_CALIBRATION_ERRORS) continue;
      checked += 1;
      if (Math.abs(current.model) <= conformalHalfWidth(known.map((error) => Math.abs(error.model)))) covered += 1;
    }
    // The interval shown now uses the latest errors; it never narrows with a longer horizon.
    widest = Math.max(widest, conformalHalfWidth(bucket.slice(-CALIBRATION_ORIGINS).map((error) => Math.abs(error.model))));
    const maeModel = meanAbsolute(bucket.map((error) => error.model));
    const maePersistence = meanAbsolute(bucket.map((error) => error.persistence));
    const seasonal = bucket.flatMap((error) => error.sameTimeYesterday === null ? [] : [error.sameTimeYesterday]);
    const maeSameTimeYesterday = seasonal.length ? meanAbsolute(seasonal) : null;
    return [{
      hours,
      samples: bucket.length,
      maeModel: Number(maeModel.toFixed(4)),
      maePersistence: Number(maePersistence.toFixed(4)),
      maeSameTimeYesterday: maeSameTimeYesterday === null ? null : Number(maeSameTimeYesterday.toFixed(4)),
      skillVsPersistence: skill(maeModel, maePersistence),
      skillVsSameTimeYesterday: skill(maeModel, maeSameTimeYesterday),
      intervalHalfWidth: Number(widest.toFixed(4)),
      intervalCoverage: checked ? Number((covered / checked).toFixed(4)) : null,
    }];
  });
  return { origins, horizons };
}

/** Coverage pooled over every horizon's replayed intervals, weighted by samples. */
export function pooledCoverage(horizons: readonly MeasurementForecastHorizonSkill[]): number | null {
  let covered = 0;
  let samples = 0;
  for (const horizon of horizons) {
    if (horizon.intervalCoverage === null) continue;
    covered += horizon.intervalCoverage * horizon.samples;
    samples += horizon.samples;
  }
  return samples ? Number((covered / samples).toFixed(4)) : null;
}
