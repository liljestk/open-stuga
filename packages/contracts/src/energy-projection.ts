export const HOME_ENERGY_PROJECTION_ALGORITHM_VERSION = "energy-projection/v1" as const;

/**
 * The next thirty days of a Home's consumption. A weather regression (base
 * load plus heating slope on degree-hours) is used only when it beat "last 30
 * days repeated" in a rolling backtest; otherwise that repeat is the method.
 * The interval and confidence come from the backtest's errors.
 */
export interface HomeEnergyProjection {
  houseId: string;
  generatedAt: string;
  algorithmVersion: typeof HOME_ENERGY_PROJECTION_ALGORITHM_VERSION;
  horizonStart: string;
  horizonDays: number;
  method: "weather-regression" | "recent-average";
  next30DaysKwh: number;
  lowKwh: number;
  highKwh: number;
  dailyKwh: number;
  baseLoadKwhPerDay: number | null;
  heatingSlopeKwhPerDegreeHour: number | null;
  heatingBaseTemperatureC: number;
  /** Days of the horizon covered by the stored weather forecast; recent weather is held after it. */
  forecastDays: number;
  /** Complete days of history behind the projection and its backtest. */
  observedDays: number;
  confidence: "low" | "medium" | "high";
  backtest: {
    origins: number;
    /** Mean absolute percentage error of the chosen method's thirty-day totals. */
    meanAbsolutePercentError: number | null;
    /** The same for "last 30 days repeated". */
    baselineMeanAbsolutePercentError: number | null;
    /** 1 − weather-regression error / repeated-baseline error. */
    skill: number | null;
  };
  estimatedCostEur: number | null;
  lowCostEur: number | null;
  highCostEur: number | null;
  /** Euros per kWh from the last thirty days' priced consumption, with monthly fees added once. */
  priceBasis: "historical" | "unavailable";
}

/** A device whose measured runs could move to cheaper hours. */
export interface EnergyFlexibleLoad {
  sensorId: string;
  sensorName: string;
  runsPerDay: number;
  dailyKwh: number;
  typicalRunMinutes: number;
  /** Energy-weighted price the device paid during its runs in the last week. */
  paidCentsPerKwh: number;
  cheapestWindow: { startAt: string; endAt: string; averagePriceCentsPerKwh: number } | null;
  estimatedDailySavingsEur: number | null;
}
