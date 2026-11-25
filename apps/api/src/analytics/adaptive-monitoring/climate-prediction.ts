import type { AdaptiveHourlyEvidence, AdaptiveMetric } from "@climate-twin/contracts";
import {
  fitThermalForecastParameters, HOUR_MS, lookup, profileForecaster, thermalForecaster, tuneProfileForecast,
  type HourlyValue, type ProfileForecastParameters, type ThermalForecastParameters,
} from "../forecast/models.js";

const DAY_MS = 24 * HOUR_MS;
const FIT_WINDOW_MS = 14 * DAY_MS;
const MAX_ORIGIN_AGE_HOURS = 3;

export type ClimateModelPolicy =
  | { kind: "daily-profile"; parameters: ProfileForecastParameters }
  | { kind: "thermal-relaxation"; tauHours: number };

/** Weather must be a closed observed hour with provenance, under the active weather location. */
export interface AdaptiveOutdoorHour extends HourlyValue { availableAt: number }

export interface ClimateInputs {
  target: ReadonlyMap<number, AdaptiveHourlyEvidence>;
  outdoor: ReadonlyMap<number, AdaptiveOutdoorHour>;
}

function visibleHours(
  series: ReadonlyMap<number, AdaptiveOutdoorHour>,
  { at, from, to }: { at: number; from: number; to: number },
): HourlyValue[] {
  const visible: HourlyValue[] = [];
  for (let time = from; time < to; time += HOUR_MS) {
    const point = series.get(time);
    if (point && point.availableAt <= at) visible.push({ time, value: point.value });
  }
  return visible;
}

export function outdoorHours(points: readonly AdaptiveOutdoorHour[]): Map<number, AdaptiveOutdoorHour> {
  const seen = new Set<number>();
  const valid = new Map<number, AdaptiveOutdoorHour>();
  for (const point of points) {
    if (seen.has(point.time)) {
      valid.delete(point.time);
      continue;
    }
    seen.add(point.time);
    if (Number.isSafeInteger(point.time) && point.time % HOUR_MS === 0 && Number.isFinite(point.value)
      && Number.isSafeInteger(point.availableAt) && point.availableAt >= point.time + HOUR_MS) valid.set(point.time, point);
  }
  return valid;
}

export function tuneClimatePolicies(input: ClimateInputs, metric: AdaptiveMetric, at: number): ClimateModelPolicy[] {
  const window = { at, from: at - 7 * DAY_MS, to: at };
  const history = visibleHours(input.target, window);
  const candidates: ClimateModelPolicy[] = [];
  const profile = tuneProfileForecast(history, at - HOUR_MS);
  if (profile) candidates.push({ kind: "daily-profile", parameters: profile });
  if (metric === "temperature") {
    const thermal = fitThermalForecastParameters(history, {
      outdoor: lookup(visibleHours(input.outdoor, window)), until: at - HOUR_MS,
    });
    if (thermal) candidates.push({ kind: "thermal-relaxation", tauHours: thermal.tauHours });
  }
  return candidates;
}

function recentKnownTarget(target: ClimateInputs["target"], at: number): AdaptiveHourlyEvidence | null {
  for (let lag = 1; lag <= MAX_ORIGIN_AGE_HOURS; lag++) {
    const point = target.get(at - lag * HOUR_MS);
    if (point && point.availableAt <= at) return point;
  }
  return null;
}

export interface ClimateBaselinePredictions {
  persistence: number | null;
  seasonal: number | null;
}

export function climateBaselines(target: ClimateInputs["target"], at: number): ClimateBaselinePredictions {
  const seasonal = target.get(at - DAY_MS);
  return {
    persistence: recentKnownTarget(target, at)?.value ?? null,
    seasonal: seasonal && seasonal.availableAt <= at ? seasonal.value : null,
  };
}

/** Parameters are fitted at most once each UTC day against preceding observations. */
export class CausalClimatePredictor {
  #fitAt = Number.NEGATIVE_INFINITY;
  #thermal: ThermalForecastParameters | null = null;

  constructor(private readonly input: ClimateInputs, private readonly policy: ClimateModelPolicy) {}

  #thermalParameters(at: number, tauHours: number): ThermalForecastParameters | null {
    const day = Math.floor(at / DAY_MS) * DAY_MS;
    if (day !== this.#fitAt) {
      this.#fitAt = day;
      const window = { at: day, from: day - FIT_WINDOW_MS, to: day };
      this.#thermal = fitThermalForecastParameters(visibleHours(this.input.target, window), {
        outdoor: lookup(visibleHours(this.input.outdoor, window)), until: day - HOUR_MS, fixedTauHours: tauHours,
      });
    }
    return this.#thermal;
  }

  predict(at: number): number | null {
    const origin = recentKnownTarget(this.input.target, at);
    if (!origin) return null;
    const window = { at, from: at - FIT_WINDOW_MS, to: at };
    const history = visibleHours(this.input.target, window);
    const steps = (at - origin.time) / HOUR_MS;
    return this.#forecast(history, window)?.forecast(origin.time, origin.value, steps)?.at(-1) ?? null;
  }

  #forecast(history: HourlyValue[], window: { at: number; from: number; to: number }) {
    if (this.policy.kind === "daily-profile") return profileForecaster(history, this.policy.parameters);
    const parameters = this.#thermalParameters(window.at, this.policy.tauHours);
    const outdoor = lookup(visibleHours(this.input.outdoor, window));
    return parameters && thermalForecaster(history, outdoor, parameters);
  }
}
