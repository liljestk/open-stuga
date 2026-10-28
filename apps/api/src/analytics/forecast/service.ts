import { HttpError } from "../../http-error.js";
import { MEASUREMENT_FORECAST_ALGORITHM_VERSION, type House, type MeasurementDefinition, type MeasurementForecastEvaluation, type MeasurementForecastPoint, withSignal } from "@climate-twin/contracts";
import { outdoorLocationKey, type ClimateDatabase } from "../../db.js";
import type { HybridTelemetryReader } from "../../timeseries/read-facade.js";
import { backtestForecaster, BACKTEST_HORIZON_HOURS, pooledCoverage, type BacktestResult } from "./backtest.js";
import {
  HOUR_MS,
  fitProfileForecaster,
  fitThermalForecaster,
  hourStart,
  hourlyAverages,
  type Forecaster,
  type HourlyLookup,
  type HourlyValue,
} from "./models.js";

const HISTORY_DAYS = 14;
const EVALUATION_TTL_MS = 6 * HOUR_MS;
const MAXIMUM_HORIZON_HOURS = 168;
/** The latest reading must be this fresh to anchor a forecast. */
const MAXIMUM_ANCHOR_AGE_MS = 3 * HOUR_MS;

export class ForecastUnavailableError extends HttpError {
  declare readonly code: "UNKNOWN_METRIC" | "FORECAST_UNSUPPORTED";
  declare readonly status: 404 | 422;

  constructor(status: 404 | 422, code: "UNKNOWN_METRIC" | "FORECAST_UNSUPPORTED", message: string) {
    super(status, code, message);
    this.name = "ForecastUnavailableError";
  }
}

export interface MeasurementForecast {
  points: MeasurementForecastPoint[];
  evaluation: MeasurementForecastEvaluation;
}

interface Candidate {
  kind: "thermal-relaxation" | "daily-profile";
  fit: (until: number) => Forecaster | null;
}

function emptyEvaluation({ sensorId, metric, computedAt, history, outdoorDriver }: {
  sensorId: string;
  metric: string;
  computedAt: string;
  history: readonly HourlyValue[];
  outdoorDriver: MeasurementForecastEvaluation["outdoorDriver"];
}): MeasurementForecastEvaluation {
  return {
    algorithmVersion: MEASUREMENT_FORECAST_ALGORITHM_VERSION,
    sensorId,
    metric,
    status: "insufficient-history",
    model: null,
    computedAt,
    historyFrom: history[0] ? new Date(history[0].time).toISOString() : null,
    historyTo: history.at(-1) ? new Date(history.at(-1)!.time).toISOString() : null,
    origins: 0,
    outdoorDriver,
    horizons: [],
    skill6h: null,
    skill24h: null,
    coverage90: null,
  };
}

const skillAt = (result: BacktestResult, hours: number) => (
  result.horizons.find((horizon) => horizon.hours === hours)?.skillVsPersistence ?? null
);

/**
 * Forecasts a measurement from its own recent history. Each model is
 * backtested on the last two weeks; the better one is used, and a forecast
 * that does not beat "no change" at six hours is withheld.
 */
export class MeasurementForecastService {
  constructor(
    private readonly database: ClimateDatabase,
    private readonly telemetryReader?: HybridTelemetryReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async forecast(input: { sensorId: string; metric: string; hours: number; signal?: AbortSignal }): Promise<MeasurementForecast> {
    const definition = this.definition(input.metric);
    const now = this.now();
    const computedAt = now.toISOString();
    const from = new Date(now.getTime() - HISTORY_DAYS * 24 * HOUR_MS).toISOString();
    const history = await this.history(input.sensorId, input.metric, from, computedAt, input.signal);
    const latest = this.database.getLatestMeasurementSample(input.sensorId, input.metric);
    const anchorTime = latest ? Date.parse(latest.timestamp) : Number.NaN;
    const sensor = this.database.getSensor(input.sensorId);
    const house = sensor ? this.database.getHouse(sensor.houseId) : null;
    const outdoor = input.metric === "temperature" && house
      ? await this.outdoor(house, from, now, input.signal)
      : null;
    const candidates: Candidate[] = [];
    if (outdoor) {
      candidates.push({ kind: "thermal-relaxation", fit: (until) => fitThermalForecaster(history, outdoor.lookup, until) });
    }
    candidates.push({ kind: "daily-profile", fit: (until) => fitProfileForecaster(history, until) });

    const evaluation = this.cachedEvaluation(input.sensorId, input.metric, now, outdoor?.driver ?? null)
      ?? this.evaluate(input.sensorId, input.metric, computedAt, history, candidates, outdoor?.driver ?? null);
    const fresh = latest !== null && Number.isFinite(anchorTime) && now.getTime() - anchorTime <= MAXIMUM_ANCHOR_AGE_MS;
    if (evaluation.status !== "ready" || !fresh) return { points: [], evaluation };
    const candidate = candidates.find((item) => item.kind === evaluation.model);
    const forecaster = candidate?.fit(anchorTime) ?? null;
    const hours = Math.max(1, Math.min(MAXIMUM_HORIZON_HOURS, Math.floor(input.hours)));
    const values = forecaster?.forecast(anchorTime, latest.value, hours) ?? null;
    if (!values) return { points: [], evaluation };
    return { points: this.points(input.sensorId, input.metric, definition, anchorTime, values, evaluation), evaluation };
  }

  private definition(metric: string): MeasurementDefinition {
    const definition = this.database.getMeasurementDefinition(metric);
    if (!definition) throw new ForecastUnavailableError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${metric}`);
    if (!definition.forecastSupported) {
      throw new ForecastUnavailableError(422, "FORECAST_UNSUPPORTED", `Forecasting is not enabled for metric: ${metric}`);
    }
    return definition;
  }

  private async history(sensorId: string, metric: string, from: string, to: string, signal?: AbortSignal): Promise<HourlyValue[]> {
    const samples = this.telemetryReader
      ? (await this.telemetryReader.measurementHistoryBucketed({
        sensorId, metric, from, to, bucketSeconds: 3_600, limit: HISTORY_DAYS * 24 + 2,
        ...withSignal(signal),
      })).records
      : this.database.measurementHistory(sensorId, metric, from, to, 50_000);
    return hourlyAverages(samples
      .filter((sample) => sample.quality !== "stale")
      .map((sample) => ({ time: Date.parse(sample.timestamp), value: sample.value })));
  }

  /** Observed outdoor temperature in the past, the stored weather forecast ahead. */
  private async outdoor(house: House, from: string, now: Date, signal?: AbortSignal): Promise<{
    lookup: HourlyLookup;
    driver: MeasurementForecastEvaluation["outdoorDriver"];
  } | null> {
    if (!house.location) return null;
    const locationKey = outdoorLocationKey(house.location);
    const observed = this.telemetryReader
      ? (await this.telemetryReader.outdoorTemperatureHistory({
        houseId: house.id, locationKey, from, to: now.toISOString(), limit: 50_000,
        ...withSignal(signal),
      })).records
      : this.database.outdoorTemperatureHistory(house.id, locationKey, from, now.toISOString(), 50_000);
    const past = hourlyAverages(observed.map((sample) => ({ time: Date.parse(sample.timestamp), value: sample.temperatureC })));
    if (past.length < 48) return null;
    const forecast = this.database.getWeatherSnapshot(house.id, locationKey)?.weather?.forecast ?? [];
    const ahead = hourlyAverages(forecast
      .filter((point) => Number.isFinite(point.temperatureC) && Date.parse(point.timestamp) >= hourStart(now.getTime()))
      .map((point) => ({ time: Date.parse(point.timestamp), value: point.temperatureC! })));
    const values = new Map(past.map((point) => [point.time, point.value]));
    for (const point of ahead) values.set(point.time, point.value);
    return {
      lookup: (time) => values.get(time) ?? null,
      driver: ahead.length ? "weather-forecast" : "held-observation",
    };
  }

  private cachedEvaluation(
    sensorId: string,
    metric: string,
    now: Date,
    outdoorDriver: MeasurementForecastEvaluation["outdoorDriver"],
  ): MeasurementForecastEvaluation | null {
    const cached = this.database.latestForecastEvaluation(sensorId, metric);
    if (!cached || cached.algorithmVersion !== MEASUREMENT_FORECAST_ALGORITHM_VERSION) return null;
    if (now.getTime() - Date.parse(cached.computedAt) > EVALUATION_TTL_MS) return null;
    return { ...cached, outdoorDriver };
  }

  private evaluate(
    sensorId: string,
    metric: string,
    computedAt: string,
    history: readonly HourlyValue[],
    candidates: readonly Candidate[],
    outdoorDriver: MeasurementForecastEvaluation["outdoorDriver"],
  ): MeasurementForecastEvaluation {
    let best: { kind: Candidate["kind"]; result: BacktestResult } | null = null;
    for (const candidate of candidates) {
      const result = backtestForecaster(history, candidate.fit);
      if (!result) continue;
      const skill = skillAt(result, 6) ?? Number.NEGATIVE_INFINITY;
      if (!best || skill > (skillAt(best.result, 6) ?? Number.NEGATIVE_INFINITY)) best = { kind: candidate.kind, result };
    }
    const evaluation = best
      ? {
        ...emptyEvaluation({ sensorId, metric, computedAt, history, outdoorDriver }),
        status: (skillAt(best.result, 6) ?? 0) > 0 ? "ready" as const : "no-skill" as const,
        model: best.kind,
        origins: best.result.origins,
        horizons: best.result.horizons,
        skill6h: skillAt(best.result, 6),
        skill24h: skillAt(best.result, 24),
        coverage90: pooledCoverage(best.result.horizons),
      }
      : emptyEvaluation({ sensorId, metric, computedAt, history, outdoorDriver });
    this.database.saveForecastEvaluation(evaluation);
    return evaluation;
  }

  private points(
    sensorId: string,
    metric: string,
    definition: MeasurementDefinition,
    anchorTime: number,
    values: number[],
    evaluation: MeasurementForecastEvaluation,
  ): MeasurementForecastPoint[] {
    const clamp = (value: number) => Math.max(definition.validMin ?? -Infinity, Math.min(definition.validMax ?? Infinity, value));
    const round = (value: number) => Number(value.toFixed(definition.precision));
    const widths = new Map(evaluation.horizons.map((horizon) => [horizon.hours, horizon.intervalHalfWidth]));
    const lastWidth = widths.get(BACKTEST_HORIZON_HOURS) ?? Math.max(0, ...widths.values());
    return values.map((value, index) => {
      const hours = index + 1;
      // Past the backtested day the interval grows like a random walk.
      const width = widths.get(hours) ?? lastWidth * Math.sqrt(hours / BACKTEST_HORIZON_HOURS);
      return {
        sensorId,
        metric,
        timestamp: new Date(anchorTime + hours * HOUR_MS).toISOString(),
        value: round(clamp(value)),
        low: round(clamp(value - width)),
        high: round(clamp(value + width)),
      };
    });
  }
}
