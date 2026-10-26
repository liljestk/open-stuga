import { minimum } from "@climate-twin/analytics-kernel";
import {
  HOME_ENERGY_SUMMARY_ALGORITHM_VERSION,
  type EnergyMeterRole,
  type HomeEnergyArchiveState,
  type HomeEnergyConsumptionBasis,
  type HomeEnergyCost,
  type HomeEnergyCostQuality,
  type HomeEnergySummary,
  type ElectricityCostBreakdown,
  type ElectricityTariffVersion,
} from "@climate-twin/contracts";
import { costBreakdown, proratedMonthlyFeesEur, tariffCost, type TariffCost } from "./electricity/tariff-cost.js";
import {
  HybridTelemetryReader,
  IncompleteTelemetryHistoryError,
} from "./timeseries/read-facade.js";
import { RollupsMaterializingError } from "./timeseries/read-support.js";
import { AnalyticsCapacityError } from "./analytics/work-limiter.js";
import type { EnergyCostAggregateRecord } from "./timeseries/types.js";
import { compareCodeUnits } from "./text-order.js";

const MEASUREMENT_EDGE_TOLERANCE_MS = 5 * 60_000;
const MINIMUM_MEASUREMENT_DURATION_COVERAGE = 0.999;
const POWER_HOLD_MS = 15 * 60_000;
const MAXIMUM_MEASURED_COUNTER_INTERVAL_MS = 15 * 60_000 + 1_000;
const SUMMARY_CONCURRENCY = 2;

function rounded(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

function roundedBreakdown(breakdown: ElectricityCostBreakdown): ElectricityCostBreakdown {
  const round = (value: number | null) => value === null ? null : rounded(value, 6);
  return {
    ...breakdown,
    energyEur: round(breakdown.energyEur),
    networkEur: round(breakdown.networkEur),
    taxEur: round(breakdown.taxEur),
    feesEur: round(breakdown.feesEur),
  };
}

function sumNullable(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? present.reduce((sum, value) => sum + value, 0) : null;
}

async function mapSettledWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: "fulfilled", value: await operation(values[index]!) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

/** Tariff versions and the local time zone their dates and schedules use. */
export interface ElectricityTariffContext {
  versions: readonly ElectricityTariffVersion[];
  revision: number;
  timeZone: string;
}

/** Without a tariff, usage is priced at the raw spot price. */
function rawSpotCost(aggregate: EnergyCostAggregateRecord): TariffCost {
  return {
    consumptionKwh: aggregate.consumptionKwh,
    pricedConsumptionKwh: aggregate.pricedConsumptionKwh,
    energyEur: aggregate.spotCostEur,
    networkEur: null,
    taxEur: null,
    energyPriceMissing: false,
  };
}

interface BasisCalculation {
  aggregate: EnergyCostAggregateRecord;
  cost: HomeEnergyCost;
  measurementComplete: boolean;
  estimated: boolean;
}

function temporarilyUnavailable(error: unknown): boolean {
  return error instanceof RollupsMaterializingError
    || error instanceof AnalyticsCapacityError
    || error instanceof IncompleteTelemetryHistoryError;
}

export class EnergyCostService {
  constructor(
    private readonly telemetryReader: HybridTelemetryReader,
    private readonly now: () => Date = () => new Date(),
    private readonly meterRole: (sensorId: string) => EnergyMeterRole = () => "standalone",
    private readonly tariffFor: (propertyId: string, houseId: string) => ElectricityTariffContext | null = () => null,
  ) {}

  #tariff(propertyId: string, houseId: string): ElectricityTariffContext | null {
    try {
      return this.tariffFor(propertyId, houseId);
    } catch {
      return null;
    }
  }

  async calculate(input: {
    houseId: string;
    propertyId: string;
    sensorId: string;
    from: string;
    to: string;
    signal?: AbortSignal;
  }): Promise<HomeEnergyCost> {
    // One basis being temporarily unavailable (rollups materializing, load
    // shed, archive gap) must not take down the other: the fallback basis is
    // often already serveable, and attempting it also enqueues its own rollup
    // variants so both families converge in the same catch-up round.
    let energy: BasisCalculation | null = null;
    let unavailable: unknown = null;
    try {
      energy = await this.calculateBasis(input, "energy_counter");
    } catch (error) {
      if (!temporarilyUnavailable(error)) throw error;
      unavailable = error;
    }
    if (energy?.measurementComplete && !energy.estimated) return energy.cost;

    let power: BasisCalculation | null = null;
    try {
      power = await this.calculateBasis(input, "integrated_power");
    } catch (error) {
      if (!temporarilyUnavailable(error)) throw error;
      unavailable ??= error;
    }
    if (!energy && !power) throw unavailable;
    if (!power) return energy!.cost;
    if (!energy) return power.cost;
    if (energy.measurementComplete && energy.estimated && power.measurementComplete) return power.cost;
    if (energy.measurementComplete) return energy.cost;
    if (power.measurementComplete) return power.cost;
    if (energy.aggregate.deltaCount === 0) return power.cost;
    if (power.aggregate.deltaCount === 0) return energy.cost;
    return power.aggregate.totalDurationMs > energy.aggregate.totalDurationMs ? power.cost : energy.cost;
  }

  async summarize(input: {
    houseId: string;
    propertyId: string;
    sensorIds: readonly string[];
    from: string;
    to: string;
    signal?: AbortSignal;
  }): Promise<HomeEnergySummary> {
    const coverage = await this.telemetryReader.measurementCoverage({
      sensorIds: input.sensorIds,
      metrics: ["energy", "power"],
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!coverage.complete) {
      throw new IncompleteTelemetryHistoryError(
        coverage.archiveState === "merged" ? "not-ready" : coverage.archiveState,
      );
    }

    const fromMs = Date.parse(input.from);
    const toMs = Date.parse(input.to);
    const candidates = [...new Set(coverage.records.filter((record) => {
      const start = Date.parse(record.start);
      const end = Date.parse(record.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > toMs) return false;
      return record.metric === "energy"
        ? end >= fromMs
        : record.metric === "power" && end >= fromMs - POWER_HOLD_MS;
    }).map((record) => record.sensorId))].sort(compareCodeUnits);

    const roleFor = (sensorId: string): EnergyMeterRole => {
      try {
        return this.meterRole(sensorId);
      } catch {
        return "standalone";
      }
    };
    const wholeHome = candidates.filter((sensorId) => roleFor(sensorId) === "whole_home");
    const standalone = candidates.filter((sensorId) => roleFor(sensorId) === "standalone");
    const aggregationMode = wholeHome.length > 0
      ? "whole_home"
      : standalone.length > 0
        ? "independent_sources"
        : "submeters_only";
    const selected = aggregationMode === "whole_home"
      ? wholeHome.slice(0, 1)
      : aggregationMode === "independent_sources"
        ? standalone
        : candidates.filter((sensorId) => roleFor(sensorId) === "submeter");
    const excludedSourceCount = candidates.length - selected.length;

    const settled = await mapSettledWithConcurrency(selected, SUMMARY_CONCURRENCY, (sensorId) => (
      this.calculate({ ...input, sensorId })
    ));
    if (input.signal?.aborted) {
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new DOMException("The operation was aborted", "AbortError");
    }
    // A whole summary still preparing has no usable contribution to display.
    // Preserve the retryable API response instead of caching an empty failure.
    const preparationFailures = settled.filter((result) => result.status === "rejected");
    if (settled.length > 0 && preparationFailures.length === settled.length
      && preparationFailures.every((result) => result.reason instanceof RollupsMaterializingError)) {
      throw preparationFailures[0]!.reason;
    }
    const contributions = settled.flatMap((result) => (
      result.status === "fulfilled" ? [result.value] : []
    ));
    const failedSourceCount = settled.length - contributions.length;
    const reporting = contributions.filter((cost) => cost.consumptionKwh !== null);
    const consumptionKwh = sumNullable(reporting.map((cost) => cost.consumptionKwh));
    const pricedConsumptionKwh = sumNullable(reporting.map((cost) => cost.pricedConsumptionKwh));
    const costEur = sumNullable(reporting.map((cost) => cost.costEur));
    const component = (key: "energyEur" | "networkEur" | "taxEur") => sumNullable(
      reporting.map((cost) => cost.costBreakdown?.[key] ?? null),
    );
    const tariff = this.#tariff(input.propertyId, input.houseId);
    // Monthly fees belong to the metering point, so only a summary that
    // stands for the whole Home carries them, once.
    const feesEur = tariff && selected.length > 0 && aggregationMode !== "submeters_only"
      ? proratedMonthlyFeesEur(fromMs, toMs, tariff.versions, tariff.timeZone)
      : null;
    const breakdown = reporting.length > 0 || feesEur !== null
      ? costBreakdown({
        energyEur: component("energyEur"),
        networkEur: component("networkEur"),
        taxEur: component("taxEur"),
        feesEur,
        energyPriceMissing: reporting.some((cost) => cost.costBreakdown?.energyPriceMissing === true),
      })
      : null;
    const priceCoveragePercent = consumptionKwh !== null && consumptionKwh > 0
      ? Math.min(100, (pricedConsumptionKwh ?? 0) / consumptionKwh * 100)
      : reporting.length
        ? (minimum(reporting.map((cost) => cost.priceCoveragePercent)) ?? Number.POSITIVE_INFINITY)
        : 0;
    const archiveState: HomeEnergyArchiveState = contributions.some((cost) => cost.archiveState === "pending")
      ? "pending"
      : contributions.length > 0 && contributions.every((cost) => cost.archiveState === "archived")
        ? "archived"
        : "local-only";
    const complete = selected.length > 0
      && aggregationMode !== "submeters_only"
      && failedSourceCount === 0
      && reporting.length === selected.length
      && contributions.every((cost) => cost.complete);
    const quality: HomeEnergyCostQuality = !complete
      ? "partial"
      : contributions.some((cost) => cost.quality === "estimated")
        ? "estimated"
        : "measured";
    const calculatedAt = this.now().toISOString();

    return {
      schemaVersion: 3,
      algorithmVersion: HOME_ENERGY_SUMMARY_ALGORITHM_VERSION,
      houseId: input.houseId,
      from: input.from,
      to: input.to,
      consumptionKwh: consumptionKwh === null ? null : rounded(consumptionKwh, 6),
      pricedConsumptionKwh: pricedConsumptionKwh === null ? null : rounded(pricedConsumptionKwh, 6),
      costEur: costEur === null ? null : rounded(costEur, 6),
      totalCostEur: costEur === null ? null : rounded(costEur + (feesEur ?? 0), 6),
      costBreakdown: breakdown && roundedBreakdown(breakdown),
      tariffRevision: tariff?.revision ?? 0,
      priceCoveragePercent: rounded(priceCoveragePercent, 1),
      quality,
      archiveState,
      aggregationMode,
      complete,
      sourceCount: reporting.length,
      totalSources: candidates.length,
      excludedSourceCount,
      failedSourceCount,
      contributions,
      calculatedAt,
    };
  }

  private async calculateBasis(
    input: {
      houseId: string;
      propertyId: string;
      sensorId: string;
      from: string;
      to: string;
      signal?: AbortSignal;
    },
    measurementBasis: HomeEnergyConsumptionBasis,
  ): Promise<BasisCalculation> {
    const query = {
      sensorId: input.sensorId,
      propertyId: input.propertyId,
      from: input.from,
      to: input.to,
      ...(input.signal ? { signal: input.signal } : {}),
    };
    const aggregate = measurementBasis === "energy_counter"
      ? await this.telemetryReader.energyCostAggregate(query)
      : await this.telemetryReader.powerCostAggregate(query);
    const requestedDurationMs = Date.parse(input.to) - Date.parse(input.from);
    const tariff = this.#tariff(input.propertyId, input.houseId);
    const applied = tariff ? tariffCost(aggregate.hourly, tariff.versions, tariff.timeZone) : rawSpotCost(aggregate);
    // Spot pricing depends on price intervals, so its coverage stays measured
    // in time; a fixed price covers every kWh it applies to.
    const spotOnly = !tariff || tariff.versions.every((version) => version.energy?.kind === "spot");
    const priceCoveragePercent = spotOnly
      ? aggregate.totalDurationMs <= 0
        ? 0
        : Math.min(100, aggregate.pricedDurationMs / aggregate.totalDurationMs * 100)
      : aggregate.consumptionKwh > 0
        ? Math.min(100, applied.pricedConsumptionKwh / aggregate.consumptionKwh * 100)
        : applied.energyPriceMissing ? 0 : 100;
    const fromMs = Date.parse(input.from);
    const toMs = Date.parse(input.to);
    const coverageFromMs = aggregate.coverageFrom ? Date.parse(aggregate.coverageFrom) : NaN;
    const coverageUntilMs = aggregate.coverageUntil ? Date.parse(aggregate.coverageUntil) : NaN;
    const durationComplete = measurementBasis === "energy_counter"
      || aggregate.totalDurationMs >= requestedDurationMs * MINIMUM_MEASUREMENT_DURATION_COVERAGE;
    const measurementComplete = aggregate.deltaCount > 0
      && durationComplete
      && Number.isFinite(coverageFromMs) && coverageFromMs <= fromMs + MEASUREMENT_EDGE_TOLERANCE_MS
      && Number.isFinite(coverageUntilMs) && coverageUntilMs >= toMs - MEASUREMENT_EDGE_TOLERANCE_MS;
    const estimated = measurementBasis === "integrated_power"
      || aggregate.maximumIntervalDurationMs > MAXIMUM_MEASURED_COUNTER_INTERVAL_MS;
    const hasUsage = aggregate.deltaCount > 0;
    const hasPricedUsage = hasUsage && (spotOnly ? aggregate.pricedDurationMs > 0 : priceCoveragePercent > 0);
    const variableCostEur = applied.energyEur + (applied.networkEur ?? 0) + (applied.taxEur ?? 0);
    const archiveState = aggregate.archiveState ?? "local-only";
    const complete = measurementComplete
      && priceCoveragePercent >= 99.9
      && archiveState !== "pending";
    return {
      aggregate,
      measurementComplete,
      estimated,
      cost: {
        houseId: input.houseId,
        sensorId: input.sensorId,
        from: input.from,
        to: input.to,
        measurementBasis,
        consumptionKwh: hasUsage ? rounded(aggregate.consumptionKwh, 6) : null,
        pricedConsumptionKwh: hasPricedUsage ? rounded(applied.pricedConsumptionKwh, 6) : null,
        costEur: hasPricedUsage ? rounded(variableCostEur, 6) : null,
        costBreakdown: hasUsage
          ? roundedBreakdown(costBreakdown({
            energyEur: hasPricedUsage ? applied.energyEur : null,
            networkEur: hasPricedUsage ? applied.networkEur : null,
            taxEur: hasPricedUsage ? applied.taxEur : null,
            feesEur: null,
            energyPriceMissing: applied.energyPriceMissing,
          }))
          : null,
        priceCoveragePercent: rounded(priceCoveragePercent, 1),
        measurementCoverageFrom: aggregate.coverageFrom,
        measurementCoverageUntil: aggregate.coverageUntil,
        quality: complete ? estimated ? "estimated" : "measured" : "partial",
        archiveState,
        complete,
        calculatedAt: this.now().toISOString(),
      },
    };
  }
}
