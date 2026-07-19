import type {
  EnergyOptimizationInsight,
  EnergyOptimizationReport,
  EnergyOptimizationWindow,
  MeasurementSample,
} from "@climate-twin/contracts";
import type { ClimateDatabase } from "./db.js";

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * fraction)));
  return sorted[index] ?? null;
}

function cumulativeConsumption(samples: readonly MeasurementSample[]): number {
  const ordered = [...samples].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  let consumption = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!.value;
    const current = ordered[index]!.value;
    consumption += current >= previous ? current - previous : Math.max(0, current);
  }
  return consumption;
}

function rankedWindows(
  prices: ReturnType<ClimateDatabase["listPropertyElectricityPrices"]>,
  hours: number,
): EnergyOptimizationWindow[] {
  if (prices.length === 0) return [];
  const average = prices.reduce((sum, price) => sum + price.effectivePriceCentsPerKwh, 0) / prices.length;
  const candidates: Array<EnergyOptimizationWindow & { indexes: number[] }> = [];
  for (let start = 0; start < prices.length; start += 1) {
    const first = prices[start]!;
    const desiredEnd = Date.parse(first.startAt) + hours * 3_600_000;
    const members = prices.slice(start).filter((price) => Date.parse(price.startAt) < desiredEnd);
    if (members.length === 0 || Date.parse(members.at(-1)!.endAt) < desiredEnd) continue;
    const value = members.reduce((sum, price) => sum + price.effectivePriceCentsPerKwh, 0) / members.length;
    candidates.push({
      startAt: first.startAt,
      endAt: new Date(desiredEnd).toISOString(),
      averagePriceCentsPerKwh: Number(value.toFixed(3)),
      relativeToAveragePercent: average === 0 ? 0 : Number(((value - average) / Math.abs(average) * 100).toFixed(1)),
      rank: value <= average * 0.7 ? "best" : value <= average ? "good" : "expensive",
      indexes: members.map((member) => prices.indexOf(member)),
    });
  }
  const selected: typeof candidates = [];
  for (const candidate of candidates.sort((left, right) => left.averagePriceCentsPerKwh - right.averagePriceCentsPerKwh)) {
    if (selected.some((existing) => existing.indexes.some((index) => candidate.indexes.includes(index)))) continue;
    selected.push(candidate);
    if (selected.length === 3) break;
  }
  return selected.sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt))
    .map(({ indexes: _indexes, ...window }) => window);
}

export class EnergyOptimizer {
  constructor(private readonly database: ClimateDatabase) {}

  report(propertyId: string, windowHours = 2, now = new Date()): EnergyOptimizationReport {
    const property = this.database.getProperty(propertyId);
    if (!property) throw new Error("Property not found");
    const hours = Math.max(1, Math.min(12, Math.round(windowHours)));
    const priceFrom = new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const priceUntil = new Date(now.getTime() + 72 * 3_600_000).toISOString();
    const prices = this.database.listPropertyElectricityPrices(propertyId, priceFrom, priceUntil);
    const futurePrices = prices.filter((price) => Date.parse(price.endAt) > now.getTime());
    const averagePrice = futurePrices.length
      ? futurePrices.reduce((sum, price) => sum + price.effectivePriceCentsPerKwh, 0) / futurePrices.length
      : null;
    const current = prices.find((price) => Date.parse(price.startAt) <= now.getTime() && Date.parse(price.endAt) > now.getTime()) ?? null;
    const percentileRank = current && futurePrices.length
      ? futurePrices.filter((price) => price.effectivePriceCentsPerKwh <= current.effectivePriceCentsPerKwh).length / futurePrices.length * 100
      : null;
    const houses = this.database.listHouses(propertyId);
    const sensors = houses.flatMap((house) => this.database.listSensors(house.id)).filter((sensor) => sensor.enabled);
    const from = new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const powerSamples = this.database.measurementWindow(sensors.map((sensor) => sensor.id), ["power"], from, now.toISOString(), 100_000)
      .filter((sample) => sample.quality !== "stale");
    const energySamples = this.database.measurementWindow(sensors.map((sensor) => sensor.id), ["energy"], from, now.toISOString(), 100_000)
      .filter((sample) => sample.quality !== "stale");
    const bySensor = new Map<string, MeasurementSample[]>();
    for (const sample of energySamples) {
      const series = bySensor.get(sample.sensorId) ?? [];
      series.push(sample);
      bySensor.set(sample.sensorId, series);
    }
    const consumption = [...bySensor.values()].reduce((total, samples) => total + cumulativeConsumption(samples), 0);
    const powerValues = powerSamples.map((sample) => sample.value).filter(Number.isFinite);
    const baseline = percentile(powerValues, 0.1);
    const peak = percentile(powerValues, 0.95);
    const windows = rankedWindows(futurePrices, hours);
    const insights: EnergyOptimizationInsight[] = [];
    if (current && percentileRank !== null && percentileRank <= 25) {
      insights.push({ id: "price-low-now", severity: "opportunity", title: "Electricity is relatively inexpensive now",
        explanation: "Flexible, non-critical loads may be cheaper to run during the current price interval.", estimatedSavingsEur: null });
    }
    if (baseline !== null && baseline >= 150) {
      const potentialKwh = baseline / 1_000 * 24 * 0.2;
      insights.push({ id: "baseload-high", severity: "warning", title: "Continuous baseload looks material",
        explanation: "The lower edge of recent power use suggests equipment may be drawing power continuously. Inspect before switching anything off.",
        estimatedSavingsEur: averagePrice === null ? null : Number((potentialKwh * averagePrice / 100).toFixed(2)) });
    }
    if (peak !== null && baseline !== null && peak > Math.max(1_000, baseline * 5)) {
      insights.push({ id: "peak-load", severity: "info", title: "Recent peak use is much higher than baseload",
        explanation: "Avoiding overlap between large flexible loads may reduce property peak demand.", estimatedSavingsEur: null });
    }
    if (energySamples.length === 0) {
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
      recentDailyConsumptionKwh: energySamples.length ? Number(consumption.toFixed(3)) : null,
      estimatedDailyCostEur: energySamples.length && averagePrice !== null ? Number((consumption * averagePrice / 100).toFixed(2)) : null,
      baselinePowerWatts: baseline === null ? null : Number(baseline.toFixed(1)),
      peakPowerWatts: peak === null ? null : Number(peak.toFixed(1)),
      insights,
      limitations: [
        "Recommendations are advisory and never control equipment.",
        "Price windows use available property price data; taxes and grid tariffs may not be represented.",
        "Savings estimates require representative energy and power measurements.",
      ],
    };
  }
}
