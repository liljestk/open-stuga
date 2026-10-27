/**
 * Daily energy regressed on heating degree-hours: a base load that does not
 * depend on the weather plus a heating slope. The slope is the energy index,
 * and comparing slopes between halves of the window keeps a change in base
 * load (a new appliance, a sauna evening) from reading as a change in the
 * building's heating performance.
 */

const DAY_MS = 86_400_000;
const MIN_DAY_HOURS = 20;
export const MIN_REGRESSION_DAYS = 7;
const MIN_HALF_DAYS = 5;
const MAX_AUTOCORRELATION = 0.8;
/** One-sided 95% normal quantile, for 90% two-sided intervals. */
const Z_95 = 1.6448536269514722;

export interface DailyEnergy {
  dayStart: number;
  energyKwh: number;
  degreeHours: number;
}

export interface HeatingRegression {
  baseLoadKwhPerDay: number;
  slope: number;
  standardError: number;
  days: number;
}

/** Student-t 95% quantile (Cornish–Fisher expansion; within 1% from two degrees of freedom). */
export function studentT95(degreesOfFreedom: number): number {
  const v = Math.max(1, degreesOfFreedom);
  const z = Z_95;
  return z + (z ** 3 + z) / (4 * v) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * v ** 2)
    + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * v ** 3);
}

/** 24-hour days counted from `from`, kept when at least 20 hours have both energy and weather, scaled to a full day. */
export function dailyEnergy(
  energyByHour: ReadonlyMap<number, number>,
  outdoorByHour: ReadonlyMap<number, number>,
  from: number,
  baseTemperatureC: number,
): DailyEnergy[] {
  const days = new Map<number, { energy: number; degreeHours: number; hours: number }>();
  for (const [hour, outsideC] of outdoorByHour) {
    const energy = energyByHour.get(hour);
    if (energy === undefined || hour < from) continue;
    const dayStart = from + Math.floor((hour - from) / DAY_MS) * DAY_MS;
    const day = days.get(dayStart) ?? { energy: 0, degreeHours: 0, hours: 0 };
    day.energy += energy;
    day.degreeHours += Math.max(0, baseTemperatureC - outsideC);
    day.hours += 1;
    days.set(dayStart, day);
  }
  return [...days].flatMap(([dayStart, day]) => (day.hours < MIN_DAY_HOURS ? [] : [{
    dayStart,
    energyKwh: day.energy * 24 / day.hours,
    degreeHours: day.degreeHours * 24 / day.hours,
  }])).sort((left, right) => left.dayStart - right.dayStart);
}

/**
 * Ordinary least squares of daily energy on degree-hours. The slope's standard
 * error is widened for day-to-day persistence in the residuals.
 */
export function heatingRegression(days: readonly DailyEnergy[], minimumDays = MIN_REGRESSION_DAYS): HeatingRegression | null {
  const count = days.length;
  if (count < Math.max(3, minimumDays)) return null;
  const meanX = days.reduce((sum, day) => sum + day.degreeHours, 0) / count;
  const meanY = days.reduce((sum, day) => sum + day.energyKwh, 0) / count;
  const sxx = days.reduce((sum, day) => sum + (day.degreeHours - meanX) ** 2, 0);
  // Without days that differ in heating need, the slope is not identified.
  if (sxx < count * 1) return null;
  const slope = days.reduce((sum, day) => sum + (day.degreeHours - meanX) * (day.energyKwh - meanY), 0) / sxx;
  const base = meanY - slope * meanX;
  const residuals = days.map((day) => day.energyKwh - base - slope * day.degreeHours);
  const residualSquares = residuals.reduce((sum, value) => sum + value * value, 0);
  const lagged = residuals.slice(1).reduce((sum, value, index) => sum + value * residuals[index]!, 0);
  const autocorrelation = residualSquares > 0 ? Math.max(0, Math.min(MAX_AUTOCORRELATION, lagged / residualSquares)) : 0;
  const inflation = Math.sqrt((1 + autocorrelation) / (1 - autocorrelation));
  return {
    baseLoadKwhPerDay: base,
    slope,
    standardError: Math.sqrt(residualSquares / (count - 2) / sxx) * inflation,
    days: count,
  };
}

export interface EnergyIndexComparison {
  changePercent: number;
  lowPercent: number;
  highPercent: number;
}

/** Change in the heating slope from the first to the second half of the window, with a 90% interval. */
export function slopeComparison(days: readonly DailyEnergy[], midpoint: number): EnergyIndexComparison | null {
  const first = heatingRegression(days.filter((day) => day.dayStart + DAY_MS / 2 < midpoint), MIN_HALF_DAYS);
  const second = heatingRegression(days.filter((day) => day.dayStart + DAY_MS / 2 >= midpoint), MIN_HALF_DAYS);
  if (!first || !second || first.slope <= 0) return null;
  const difference = second.slope - first.slope;
  const halfWidth = studentT95(Math.min(first.days, second.days) - 2)
    * Math.sqrt(first.standardError ** 2 + second.standardError ** 2);
  return {
    changePercent: difference / first.slope * 100,
    lowPercent: (difference - halfWidth) / first.slope * 100,
    highPercent: (difference + halfWidth) / first.slope * 100,
  };
}
