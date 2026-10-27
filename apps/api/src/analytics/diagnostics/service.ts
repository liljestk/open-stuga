import {
  ELECTRICITY_INVOICE_TOLERANCE_PERCENT,
  type AnalyticsBillEvidence,
  type AnalyticsDiagnostics,
  type AnalyticsForecastEvidence,
  type AnalyticsLatencyEvidence,
  type AnalyticsLatencyOperation,
  type House,
  type Sensor,
} from "@climate-twin/contracts";
import { median } from "@climate-twin/analytics-kernel";
import type { ClimateDatabase } from "../../db.js";
import type { EnergySummaryCache } from "../../energy-summary-cache.js";
import type { EnergyProjectionCache } from "../../electricity/projection-cache.js";
import { invoiceRange, reconcileInvoice } from "../../electricity/invoice-reconciliation.js";
import { LATENCY_TARGET_P95_MS, histogramPercentile } from "./latency.js";

const DAY_MS = 86_400_000;
export const DIAGNOSTICS_WINDOW_DAYS = 30;
/** The latest invoices checked; each needs one summary over its billing period. */
const MAX_INVOICES = 12;
const MIN_RECONCILED_INVOICES = 3;
const COVERAGE_LOW = 0.85;
const COVERAGE_HIGH = 0.95;

const rounded = (value: number | null, digits: number) => (value === null ? null : Number(value.toFixed(digits)));

export function latencyEvidence(histograms: ReadonlyMap<string, ReadonlyMap<number, number>>): AnalyticsLatencyEvidence[] {
  return (Object.keys(LATENCY_TARGET_P95_MS) as AnalyticsLatencyOperation[]).map((operation) => {
    const buckets = histograms.get(operation) ?? new Map<number, number>();
    const requests = [...buckets.values()].reduce((sum, count) => sum + count, 0);
    const p95Ms = histogramPercentile(buckets, 0.95);
    return {
      operation,
      requests,
      p50Ms: histogramPercentile(buckets, 0.5),
      p95Ms,
      targetP95Ms: LATENCY_TARGET_P95_MS[operation],
      meetsTarget: p95Ms === null ? null : p95Ms <= LATENCY_TARGET_P95_MS[operation],
    };
  });
}

export function forecastEvidence(
  evaluations: ReadonlyArray<{ sensorId: string; metric: string; status: string; skill6h: number | null; skill24h: number | null; coverage90: number | null }>,
): AnalyticsForecastEvidence[] {
  const byMetric = new Map<string, typeof evaluations[number][]>();
  for (const evaluation of evaluations) {
    const list = byMetric.get(evaluation.metric) ?? [];
    list.push(evaluation);
    byMetric.set(evaluation.metric, list);
  }
  return [...byMetric].sort(([left], [right]) => left.localeCompare(right)).map(([metric, list]) => {
    const values = (key: "skill6h" | "skill24h" | "coverage90") => list.flatMap((item) => (item[key] === null ? [] : [item[key]!]));
    const skill6h = median(values("skill6h"));
    const skill24h = median(values("skill24h"));
    const coverage = median(values("coverage90"));
    return {
      metric,
      sensors: new Set(list.map((item) => item.sensorId)).size,
      evaluations: list.length,
      withheld: list.filter((item) => item.status !== "ready").length,
      medianSkill6h: rounded(skill6h, 3),
      medianSkill24h: rounded(skill24h, 3),
      medianCoverage90: rounded(coverage, 3),
      meetsTarget: skill6h === null || skill24h === null || coverage === null
        ? null
        : skill6h > 0 && skill24h > 0 && coverage >= COVERAGE_LOW && coverage <= COVERAGE_HIGH,
    };
  });
}

/** How the analytics performed for this Home on this appliance over the last thirty days. */
export class AnalyticsDiagnosticsService {
  constructor(
    private readonly database: ClimateDatabase,
    private readonly summaries: EnergySummaryCache,
    private readonly projections: EnergyProjectionCache,
    private readonly now: () => number = Date.now,
  ) {}

  async diagnose(house: House, sensors: readonly Sensor[], signal?: AbortSignal): Promise<AnalyticsDiagnostics> {
    const now = this.now();
    const sinceDay = new Date(now - DIAGNOSTICS_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
    const sensorIds = new Set(sensors.map((sensor) => sensor.id));
    const [bills, projection] = await Promise.all([
      this.#bills(house, sensors, signal),
      this.projections.get(house, sensors, signal).catch(() => null),
    ]);
    const stored = this.database.dailyAnalyticsFindings(house.id, this.database.isRealDataMode() ? "live" : "demo")?.snapshot ?? null;
    return {
      houseId: house.id,
      generatedAt: new Date(now).toISOString(),
      windowDays: DIAGNOSTICS_WINDOW_DAYS,
      latency: latencyEvidence(this.database.analyticsLatencyHistogram(house.id, sinceDay)),
      forecasts: forecastEvidence(this.database.listForecastEvaluations(sinceDay)
        .filter((evaluation) => sensorIds.has(evaluation.sensorId))),
      bills,
      projection: projection ? {
        method: projection.method,
        origins: projection.backtest.origins,
        meanAbsolutePercentError: projection.backtest.meanAbsolutePercentError,
        baselineMeanAbsolutePercentError: projection.backtest.baselineMeanAbsolutePercentError,
        skill: projection.backtest.skill,
        meetsTarget: projection.backtest.skill === null ? null : projection.backtest.skill > 0,
      } : null,
      findings: stored ? {
        evaluatedThrough: stored.evaluatedThrough,
        seriesTested: stored.seriesTested ?? null,
        findings: stored.findings.length,
        falseDiscoveryRate: stored.falseDiscoveryRate ?? null,
      } : null,
    };
  }

  async #bills(house: House, sensors: readonly Sensor[], signal?: AbortSignal): Promise<AnalyticsBillEvidence> {
    const invoices = this.database.listElectricityInvoices(house.propertyId)
      .filter((invoice) => invoice.houseId === house.id)
      .sort((left, right) => right.periodEnd.localeCompare(left.periodEnd))
      .slice(0, MAX_INVOICES);
    const results = [];
    for (const invoice of invoices) {
      const range = invoiceRange(invoice, house.timezone);
      if (!range) continue;
      try {
        const { summary } = await this.summaries.get({
          houseId: house.id, propertyId: house.propertyId, timeZone: house.timezone, sensors, ...range,
          ...(signal ? { signal } : {}),
        });
        results.push(reconcileInvoice(invoice, summary));
      } catch {
        if (signal?.aborted) throw signal.reason;
      }
    }
    const reconciled = results.filter((result) => result.status === "reconciled").length;
    const outsideTolerance = results.filter((result) => result.status === "outside_tolerance").length;
    const errors = results.flatMap((result) => (result.total.errorPercent === null ? [] : [Math.abs(result.total.errorPercent)]));
    return {
      invoices: invoices.length,
      reconciled,
      outsideTolerance,
      incomplete: invoices.length - reconciled - outsideTolerance,
      medianAbsoluteErrorPercent: rounded(median(errors), 2),
      tolerancePercent: ELECTRICITY_INVOICE_TOLERANCE_PERCENT,
      meetsTarget: invoices.length === 0 ? null : reconciled >= MIN_RECONCILED_INVOICES && outsideTolerance === 0,
    };
  }
}
