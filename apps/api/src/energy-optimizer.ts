import type { EnergySummaryCache } from "./energy-summary-cache.js";
import type {
  EnergyOptimizationInsight,
  EnergyOptimizationReport,
  EnergyOptimizationWindow,
  PropertyElectricityPricePoint,
} from "@climate-twin/contracts";
import type { ClimateDatabase } from "./db.js";
import { EnergyCostService } from "./energy-cost.js";
import { databaseTariffContext } from "./electricity/tariff-context.js";
import { HybridTelemetryReader } from "./timeseries/read-facade.js";
import { OPTIMIZER_POWER_HOLD_MS } from "./energy-optimizer-power.js";
import { FLEXIBLE_PROFILE_DAYS, measureFlexibleLoads } from "./electricity/flexible-loads.js";

const POWER_SAMPLE_LIMIT = 200_000;

function durationWeightedPrice(prices: readonly PropertyElectricityPricePoint[]): number | null {
  const duration = prices.reduce((sum, price) => sum + Date.parse(price.endAt) - Date.parse(price.startAt), 0);
  return duration > 0 ? prices.reduce((sum, price) => sum
    + price.effectivePriceCentsPerKwh * (Date.parse(price.endAt) - Date.parse(price.startAt)), 0) / duration : null;
}

function rankedWindows(
  prices: PropertyElectricityPricePoint[],
  hours: number,
): EnergyOptimizationWindow[] {
  const average = durationWeightedPrice(prices);
  if (average === null) return [];
  const candidates: EnergyOptimizationWindow[] = [];
  for (let start = 0; start < prices.length; start += 1) {
    const first = prices[start]!;
    const from = Date.parse(first.startAt);
    const desiredEnd = from + hours * 3_600_000;
    let cursor = from;
    let weightedPrice = 0;
    for (let index = start; index < prices.length && cursor < desiredEnd; index += 1) {
      const price = prices[index]!;
      // A missing or overlapping interval cannot establish a usable window.
      if (Date.parse(price.startAt) !== cursor) break;
      const end = Math.min(desiredEnd, Date.parse(price.endAt));
      weightedPrice += price.effectivePriceCentsPerKwh * (end - cursor);
      cursor = end;
    }
    if (cursor !== desiredEnd) continue;
    const value = weightedPrice / (desiredEnd - from);
    candidates.push({
      startAt: first.startAt,
      endAt: new Date(desiredEnd).toISOString(),
      averagePriceCentsPerKwh: Number(value.toFixed(3)),
      relativeToAveragePercent: average === 0 ? 0 : Number(((value - average) / Math.abs(average) * 100).toFixed(1)),
      rank: value < average && value <= average - Math.abs(average) * 0.3
        ? "best" : value <= average ? "good" : "expensive",
    });
  }
  const selected: EnergyOptimizationWindow[] = [];
  for (const candidate of candidates.sort((left, right) => left.averagePriceCentsPerKwh - right.averagePriceCentsPerKwh)) {
    if (selected.some((existing) => Date.parse(existing.startAt) < Date.parse(candidate.endAt)
      && Date.parse(candidate.startAt) < Date.parse(existing.endAt))) continue;
    selected.push(candidate);
    if (selected.length === 3) break;
  }
  return selected.sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
}

export class EnergyOptimizer {
  private telemetryReader: HybridTelemetryReader | null;
  private summaryCache: EnergySummaryCache | null = null;

  constructor(private readonly database: ClimateDatabase, telemetryReader?: HybridTelemetryReader | null) {
    this.telemetryReader = telemetryReader ?? null;
  }

  setTelemetryReader(telemetryReader: HybridTelemetryReader): void {
    this.telemetryReader = telemetryReader;
  }

  /** Daily summaries then come from the same cache as the Energy page's. */
  setSummaryCache(summaryCache: EnergySummaryCache): void {
    this.summaryCache = summaryCache;
  }

  async report(
    propertyId: string,
    windowHours = 2,
    now = new Date(),
    signal?: AbortSignal,
  ): Promise<EnergyOptimizationReport> {
    const property = this.database.getProperty(propertyId);
    if (!property) throw new Error("Property not found");
    const hours = Math.max(1, Math.min(12, Math.round(windowHours)));
    // A week of prices values each device's measured runs; the report's own price coverage still starts a day back.
    const priceFrom = new Date(now.getTime() - FLEXIBLE_PROFILE_DAYS * 24 * 3_600_000).toISOString();
    const reportPricesFrom = now.getTime() - 24 * 3_600_000;
    const priceUntil = new Date(now.getTime() + 72 * 3_600_000).toISOString();
    const houses = this.database.listHouses(propertyId);
    const sensors = houses.flatMap((house) => this.database.listSensors(house.id)).filter((sensor) => sensor.enabled);
    // Minute-aligned like the Energy page's rolling windows, so both share one summary.
    const summaryTo = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const from = new Date(summaryTo.getTime() - 24 * 3_600_000).toISOString();
    const reader = this.telemetryReader ?? new HybridTelemetryReader({ local: this.database });
    const costService = new EnergyCostService(
      reader,
      () => now,
      (sensorId) => this.database.getSensor(sensorId)?.energyMeterRole ?? "standalone",
      databaseTariffContext(this.database),
    );
    const [pricesWithHistory, powerProfile, costResults] = await Promise.all([
        reader.electricityPriceHistory({
          propertyId,
          from: priceFrom,
          to: priceUntil,
          limit: 5_000,
          ...(signal ? { signal } : {}),
        }).then((result) => result.records),
        reader.measurementCoverage({ sensorIds: sensors.map(sensor => sensor.id), metrics: ["power"],
          ...(signal ? { signal } : {}),
        }).then(coverage => reader.optimizerPowerProfile(sensors, {
          // Empty climate-only sensors otherwise turn an indexed single-meter
          // read into a global sort across the whole Property.
          sensorIds: coverage.complete ? [...new Set(coverage.records.map(record => record.sensorId))]
            : sensors.map(sensor => sensor.id),
          metrics: ["power"],
          from: new Date(Date.parse(from) - OPTIMIZER_POWER_HOLD_MS).toISOString(),
          to: now.toISOString(),
          limit: POWER_SAMPLE_LIMIT,
          ...(signal ? { signal } : {}),
        }, from)),
        Promise.allSettled(houses.map((house) => {
          const houseSensors = sensors.filter((sensor) => sensor.houseId === house.id);
          return this.summaryCache
            ? this.summaryCache.get({
              houseId: house.id,
              propertyId,
              timeZone: house.timezone,
              sensors: houseSensors,
              from,
              to: summaryTo.toISOString(),
              ...(signal ? { signal } : {}),
            }).then((result) => result.summary)
            : costService.summarize({
              houseId: house.id,
              propertyId,
              sensorIds: houseSensors.map((sensor) => sensor.id),
              from,
              to: summaryTo.toISOString(),
              ...(signal ? { signal } : {}),
            });
        })),
      ]);
    const prices = pricesWithHistory.filter((price) => Date.parse(price.endAt) > reportPricesFrom);
    const flexibleLoads = await measureFlexibleLoads({
      reader,
      sensors,
      prices: pricesWithHistory,
      now: now.getTime(),
      ...(signal ? { signal } : {}),
    });
    const futurePrices = prices.filter((price) => Number.isFinite(price.effectivePriceCentsPerKwh)
      && Number.isFinite(Date.parse(price.startAt)) && Number.isFinite(Date.parse(price.endAt))
      && Date.parse(price.endAt) > Math.max(now.getTime(), Date.parse(price.startAt)))
      .map((price) => ({ ...price, startAt: new Date(Math.max(now.getTime(), Date.parse(price.startAt))).toISOString() }))
      .sort((left, right) => left.startAt.localeCompare(right.startAt));
    const averagePrice = durationWeightedPrice(futurePrices);
    const current = futurePrices.find((price) => Date.parse(price.startAt) === now.getTime()) ?? null;
    const futureDuration = futurePrices.reduce((sum, price) => sum + Date.parse(price.endAt) - Date.parse(price.startAt), 0);
    const percentileRank = current && futureDuration > 0
      ? futurePrices.filter((price) => price.effectivePriceCentsPerKwh <= current.effectivePriceCentsPerKwh)
        .reduce((sum, price) => sum + Date.parse(price.endAt) - Date.parse(price.startAt), 0) / futureDuration * 100
      : null;
    const costSummaries = costResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const reportedConsumption = costSummaries
      .map((summary) => summary.consumptionKwh)
      .filter((value): value is number => value !== null);
    const reportedCosts = costSummaries
      .map((summary) => summary.costEur)
      .filter((value): value is number => value !== null);
    const consumption = reportedConsumption.reduce((total, value) => total + value, 0);
    const historicalCost = reportedCosts.reduce((total, value) => total + value, 0);
    // A point-limited suffix cannot establish the daily Property profile.
    const { baseline, peak } = powerProfile;
    const windows = rankedWindows(futurePrices, hours);
    const insights: EnergyOptimizationInsight[] = [];
    if (current && percentileRank !== null && percentileRank <= 25) {
      insights.push({ id: "price-low-now", severity: "opportunity", title: "Electricity is relatively inexpensive now",
        explanation: "Flexible, non-critical loads may be cheaper to run during the current price interval.", estimatedSavingsEur: null });
    }
    if (baseline !== null && baseline >= 150) {
      // Nothing measured says how much of the baseload could go, so no saving is claimed.
      insights.push({ id: "baseload-high", severity: "warning", title: "Continuous baseload looks material",
        explanation: "The lower edge of recent power use suggests equipment may be drawing power continuously. Inspect before switching anything off.",
        estimatedSavingsEur: null });
    }
    for (const load of flexibleLoads) {
      if (!load.cheapestWindow || load.estimatedDailySavingsEur === null || load.estimatedDailySavingsEur < 0.01) continue;
      insights.push({ id: `flexible-load:${load.sensorId}`, severity: "opportunity", title: `${load.sensorName} could run in cheaper hours`,
        explanation: `Its measured runs in the last week paid ${load.paidCentsPerKwh.toFixed(2)} c/kWh on average; the cheapest ${load.typicalRunMinutes}-minute window in the next 24 hours averages ${load.cheapestWindow.averagePriceCentsPerKwh.toFixed(2)} c/kWh. The saving is per day if its runs can move.`,
        estimatedSavingsEur: load.estimatedDailySavingsEur });
    }
    if (peak !== null && baseline !== null && peak > Math.max(1_000, baseline * 5)) {
      insights.push({ id: "peak-load", severity: "info", title: "Recent peak use is much higher than baseload",
        explanation: "Avoiding overlap between large flexible loads may reduce property peak demand.", estimatedSavingsEur: null });
    }
    if (reportedConsumption.length === 0) {
      insights.push({ id: "energy-meter-missing", severity: "info", title: "Add a cumulative energy meter for cost estimates",
        explanation: "Power readings show current load, but a cumulative kWh series is needed for reliable daily consumption and savings estimates.", estimatedSavingsEur: null });
    }
    return {
      propertyId,
      generatedAt: now.toISOString(),
      priceCoverageFrom: prices[0]?.startAt ?? null,
      priceCoverageUntil: prices.at(-1)?.endAt ?? null,
      averagePriceCentsPerKwh: averagePrice === null ? null : Number(averagePrice.toFixed(3)),
      currentPriceCentsPerKwh: current?.effectivePriceCentsPerKwh ?? null,
      currentPricePercentile: percentileRank === null ? null : Number(percentileRank.toFixed(1)),
      suggestedWindows: windows,
      recentDailyConsumptionKwh: reportedConsumption.length ? Number(consumption.toFixed(3)) : null,
      estimatedDailyCostEur: reportedCosts.length ? Number(historicalCost.toFixed(2)) : null,
      baselinePowerWatts: baseline === null ? null : Number(baseline.toFixed(1)),
      peakPowerWatts: peak === null ? null : Number(peak.toFixed(1)),
      insights,
      flexibleLoads,
      limitations: [
        "Recommendations are advisory and never control equipment.",
        "Price windows use available property price data; taxes and grid tariffs may not be represented.",
        "Daily consumption and cost use matching historical usage and price intervals.",
        "Savings come from each device's measured runs over the last week and the price spread to the cheapest upcoming window of the same length; they assume the runs can move.",
        "Power estimates use simultaneous readings from selected Home meters; stale, missing and submeter-only intervals are excluded.",
      ],
    };
  }
}
