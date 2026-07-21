import type { HomeEnergyCost } from "@climate-twin/contracts";
import type { HybridTelemetryReader } from "./timeseries/read-facade.js";

const MEASUREMENT_EDGE_TOLERANCE_MS = 5 * 60_000;

function rounded(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

export class EnergyCostService {
  constructor(
    private readonly telemetryReader: HybridTelemetryReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async calculate(input: {
    houseId: string;
    propertyId: string;
    sensorId: string;
    from: string;
    to: string;
    signal?: AbortSignal;
  }): Promise<HomeEnergyCost> {
    const aggregate = await this.telemetryReader.energyCostAggregate({
      sensorId: input.sensorId,
      propertyId: input.propertyId,
      from: input.from,
      to: input.to,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const priceCoveragePercent = aggregate.totalDurationMs <= 0
      ? 0
      : Math.min(100, aggregate.pricedDurationMs / aggregate.totalDurationMs * 100);
    const fromMs = Date.parse(input.from);
    const toMs = Date.parse(input.to);
    const coverageFromMs = aggregate.coverageFrom ? Date.parse(aggregate.coverageFrom) : NaN;
    const coverageUntilMs = aggregate.coverageUntil ? Date.parse(aggregate.coverageUntil) : NaN;
    const measurementComplete = aggregate.deltaCount > 0
      && Number.isFinite(coverageFromMs) && coverageFromMs <= fromMs + MEASUREMENT_EDGE_TOLERANCE_MS
      && Number.isFinite(coverageUntilMs) && coverageUntilMs >= toMs - MEASUREMENT_EDGE_TOLERANCE_MS;
    const hasPricedUsage = aggregate.deltaCount > 0 && aggregate.pricedDurationMs > 0;
    return {
      houseId: input.houseId,
      sensorId: input.sensorId,
      from: input.from,
      to: input.to,
      consumptionKwh: aggregate.deltaCount > 0 ? rounded(aggregate.consumptionKwh, 6) : null,
      pricedConsumptionKwh: hasPricedUsage ? rounded(aggregate.pricedConsumptionKwh, 6) : null,
      costEur: hasPricedUsage ? rounded(aggregate.costEur, 6) : null,
      priceCoveragePercent: rounded(priceCoveragePercent, 1),
      measurementCoverageFrom: aggregate.coverageFrom,
      measurementCoverageUntil: aggregate.coverageUntil,
      complete: measurementComplete && priceCoveragePercent >= 99.9,
      calculatedAt: this.now().toISOString(),
    };
  }
}
