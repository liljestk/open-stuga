import { HOME_ENERGY_PROJECTION_ALGORITHM_VERSION, type AnalyticsQueryRequest, type AnalyticsSeries, type HomeEnergyProjection, type House, type Sensor, withSignal } from "@climate-twin/contracts";
import { executeAnalyticsQuery } from "../analytics/query/execute.js";
import { heatingBaseTemperature } from "../analytics/house-parameters.js";
import type { DailyEnergy } from "../analytics/home-performance/energy-index.js";
import { outdoorLocationKey, type ClimateDatabase } from "../db.js";
import type { EnergySummaryCache } from "../energy-summary-cache.js";
import type { HybridTelemetryReader } from "../timeseries/read-facade.js";
import { FORECAST_REACH_DAYS, PROJECTION_HORIZON_DAYS, projectEnergy } from "./projection.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const HISTORY_DAYS = 120;
const MIN_DAY_HOURS = 20;
const MIN_DAY_COVERAGE = 0.8;
const MIN_PRICE_COVERAGE_PERCENT = 80;

/** Sources standing for the whole Home: a whole-Home meter, else independent meters; submeters alone cannot. */
export function homeEnergySources(sensors: readonly Sensor[], withData: ReadonlySet<string>): Sensor[] | null {
  const candidates = sensors.filter((sensor) => sensor.enabled && withData.has(sensor.id));
  const wholeHome = candidates.filter((sensor) => sensor.energyMeterRole === "whole_home")
    .sort((left, right) => left.id.localeCompare(right.id));
  if (wholeHome.length) return wholeHome.slice(0, 1);
  const standalone = candidates.filter((sensor) => (sensor.energyMeterRole ?? "standalone") === "standalone");
  return standalone.length ? standalone : null;
}

/** Each day's kWh for one source: the counter's increments, else integrated power, when the day is covered. */
function sourceDays(series: readonly AnalyticsSeries[], sensorId: string): Map<number, number> {
  const days = new Map<number, number>();
  for (const metric of ["power", "energy"] as const) {
    const points = series.find((item) => item.entityId === sensorId && item.measurementId === metric)?.points ?? [];
    for (const point of points) {
      const kwh = point.consumptionKwh ?? (metric === "energy" ? point.value : null);
      if (kwh === null || kwh === undefined || !Number.isFinite(kwh) || kwh < 0 || point.coverage < MIN_DAY_COVERAGE) continue;
      // Energy is read second, so a covered counter day wins over integrated power.
      days.set(Date.parse(point.timestamp), kwh);
    }
  }
  return days;
}

/** Degree-hours per UTC day below the base, scaled to 24 hours for days with at least 20 known hours. */
export function dailyDegreeHours(
  samples: ReadonlyArray<{ timestamp: string; temperatureC?: number | null | undefined }>,
  baseTemperatureC: number,
): Map<number, number> {
  const hours = new Map<number, { total: number; count: number }>();
  for (const sample of samples) {
    const time = Date.parse(sample.timestamp);
    if (!Number.isFinite(time) || typeof sample.temperatureC !== "number" || !Number.isFinite(sample.temperatureC)) continue;
    const hour = Math.floor(time / HOUR_MS) * HOUR_MS;
    const entry = hours.get(hour) ?? { total: 0, count: 0 };
    entry.total += sample.temperatureC;
    entry.count += 1;
    hours.set(hour, entry);
  }
  const days = new Map<number, { degreeHours: number; hours: number }>();
  for (const [hour, entry] of hours) {
    const dayStart = Math.floor(hour / DAY_MS) * DAY_MS;
    const day = days.get(dayStart) ?? { degreeHours: 0, hours: 0 };
    day.degreeHours += Math.max(0, baseTemperatureC - entry.total / entry.count);
    day.hours += 1;
    days.set(dayStart, day);
  }
  return new Map([...days].flatMap(([dayStart, day]) => (
    day.hours < MIN_DAY_HOURS ? [] : [[dayStart, day.degreeHours * 24 / day.hours] as const]
  )));
}

export class EnergyProjectionService {
  constructor(
    private readonly database: ClimateDatabase,
    private readonly telemetryReader: HybridTelemetryReader,
    private readonly summaries: EnergySummaryCache,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async project(house: House, sensors: readonly Sensor[], signal?: AbortSignal): Promise<HomeEnergyProjection | null> {
    const now = this.now();
    const horizonStart = Math.floor(now.getTime() / DAY_MS) * DAY_MS + DAY_MS;
    const historyStart = horizonStart - (HISTORY_DAYS + 1) * DAY_MS;
    const historyEnd = horizonStart - DAY_MS;
    const coverage = await this.telemetryReader.measurementCoverage({
      sensorIds: sensors.map((sensor) => sensor.id),
      metrics: ["energy", "power"],
      ...withSignal(signal),
    });
    const sources = homeEnergySources(sensors, new Set(coverage.records.map((record) => record.sensorId)));
    const definitions = ["energy", "power"].flatMap((metric) => {
      const definition = this.database.getMeasurementDefinition(metric);
      return definition ? [definition] : [];
    });
    if (!sources || definitions.length === 0) return null;

    const request: AnalyticsQueryRequest = {
      apiVersion: "1.0",
      dataMode: this.database.isRealDataMode() ? "live" : "demo",
      scope: { kind: "house", id: house.id, entityIds: sources.map((sensor) => sensor.id) },
      measurementIds: definitions.map((definition) => definition.id),
      range: { start: new Date(historyStart).toISOString(), end: new Date(historyEnd).toISOString(), timezone: "UTC" },
      resolution: "1d",
      aggregation: "default",
      qualityFilter: { include: ["good", "estimated"] },
      include: ["series", "quality", "provenance"],
      maxPointsPerSeries: HISTORY_DAYS + 2,
      requestId: `energy-projection-${house.id}`,
    };
    const response = await executeAnalyticsQuery({
      request,
      sensors: sources,
      definitions,
      telemetryReader: this.telemetryReader,
      generatedAt: now.toISOString(),
      ...withSignal(signal),
    });
    const perSource = sources.map((sensor) => sourceDays(response.series, sensor.id));
    const baseTemperatureC = heatingBaseTemperature(this.database.listParameters(house.id), house.id);
    const locationKey = house.location ? outdoorLocationKey(house.location) : null;
    const observedWeather = locationKey
      ? dailyDegreeHours((await this.telemetryReader.outdoorTemperatureHistory({
        houseId: house.id, locationKey, from: new Date(historyStart).toISOString(), to: new Date(historyEnd).toISOString(), limit: 100_000,
        ...withSignal(signal),
      })).records, baseTemperatureC)
      : new Map<number, number>();
    const history: DailyEnergy[] = [];
    for (let dayStart = historyStart; dayStart < historyEnd; dayStart += DAY_MS) {
      const values = perSource.map((days) => days.get(dayStart));
      const degreeHours = observedWeather.get(dayStart);
      if (values.some((value) => value === undefined)) continue;
      history.push({
        dayStart,
        energyKwh: values.reduce<number>((sum, value) => sum + value!, 0),
        // Without weather the regression has nothing to fit and the recent average is used.
        degreeHours: degreeHours ?? 0,
      });
    }
    const forecastWeather = locationKey
      ? dailyDegreeHours(this.database.getWeatherSnapshot(house.id, locationKey)?.weather?.forecast ?? [], baseTemperatureC)
      : new Map<number, number>();
    const forecastDegreeHours: number[] = [];
    for (let day = 0; day < FORECAST_REACH_DAYS; day += 1) {
      const value = forecastWeather.get(horizonStart + day * DAY_MS);
      if (value === undefined) break;
      forecastDegreeHours.push(value);
    }
    const result = projectEnergy({ history, forecastDegreeHours });
    if (!result) return null;

    const summary = await this.summaries.get({
      houseId: house.id,
      propertyId: house.propertyId,
      timeZone: house.timezone,
      sensors,
      from: new Date(historyEnd - 30 * DAY_MS).toISOString(),
      to: new Date(historyEnd).toISOString(),
      ...withSignal(signal),
    }).then((read) => read.summary).catch(() => null);
    const pricePerKwh = summary && summary.costEur !== null && summary.pricedConsumptionKwh !== null
      && summary.pricedConsumptionKwh > 0 && summary.priceCoveragePercent >= MIN_PRICE_COVERAGE_PERCENT
      ? summary.costEur / summary.pricedConsumptionKwh
      : null;
    const fees = summary?.costBreakdown?.feesEur ?? 0;
    const roundTo = (value: number, digits = 2) => Number(value.toFixed(digits));
    const rounded = (value: number | null, digits = 2) => (value === null ? null : roundTo(value, digits));
    const cost = pricePerKwh === null ? null : (kwh: number) => kwh * pricePerKwh + fees;
    return {
      houseId: house.id,
      generatedAt: now.toISOString(),
      algorithmVersion: HOME_ENERGY_PROJECTION_ALGORITHM_VERSION,
      horizonStart: new Date(horizonStart).toISOString(),
      horizonDays: PROJECTION_HORIZON_DAYS,
      method: result.method,
      next30DaysKwh: roundTo(result.next30DaysKwh),
      lowKwh: roundTo(result.lowKwh),
      highKwh: roundTo(result.highKwh),
      dailyKwh: roundTo(result.dailyKwh, 3),
      baseLoadKwhPerDay: rounded(result.baseLoadKwhPerDay, 3),
      heatingSlopeKwhPerDegreeHour: rounded(result.heatingSlopeKwhPerDegreeHour, 5),
      heatingBaseTemperatureC: baseTemperatureC,
      forecastDays: forecastDegreeHours.length,
      observedDays: result.observedDays,
      confidence: result.confidence,
      backtest: {
        origins: result.backtest.origins,
        meanAbsolutePercentError: rounded(result.backtest.meanAbsolutePercentError, 1),
        baselineMeanAbsolutePercentError: rounded(result.backtest.baselineMeanAbsolutePercentError, 1),
        skill: rounded(result.backtest.skill, 3),
      },
      ...projectedCosts(cost, result),
      priceBasis: pricePerKwh === null ? "unavailable" : "historical",
    };
  }
}

/** Cost at the historical unit price; all null when no reliable price exists. */
function projectedCosts(
  cost: ((kwh: number) => number) | null,
  kwh: { next30DaysKwh: number; lowKwh: number; highKwh: number },
): { estimatedCostEur: number | null; lowCostEur: number | null; highCostEur: number | null } {
  if (!cost) return { estimatedCostEur: null, lowCostEur: null, highCostEur: null };
  const roundTo = (value: number) => Number(value.toFixed(2));
  const [low, high] = [cost(kwh.lowKwh), cost(kwh.highKwh)];
  return {
    estimatedCostEur: roundTo(cost(kwh.next30DaysKwh)),
    // Negative prices turn more energy into a lower cost.
    lowCostEur: roundTo(Math.min(low, high)),
    highCostEur: roundTo(Math.max(low, high)),
  };
}
