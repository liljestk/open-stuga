import { addLocalDays, localDateStart } from "@climate-twin/analytics-kernel";
import {
  ELECTRICITY_INVOICE_TOLERANCE_PERCENT,
  type ElectricityCostComponent,
  type ElectricityInvoice,
  type ElectricityInvoiceComparison,
  type ElectricityInvoiceReconciliation,
  type HomeEnergySummary,
} from "@climate-twin/contracts";

function dateParts(key: string): { year: number; month: number; day: number } {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  return { year, month, day };
}

/** The instants an invoice's inclusive local billing dates cover. */
export function invoiceRange(invoice: Pick<ElectricityInvoice, "periodStart" | "periodEnd">, timeZone: string): {
  from: string;
  to: string;
} | null {
  const from = localDateStart(dateParts(invoice.periodStart), timeZone);
  const to = localDateStart(addLocalDays(dateParts(invoice.periodEnd), 1), timeZone);
  if (from === null || to === null || to <= from) return null;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

function errorPercent(calculated: number | null, invoiced: number): number | null {
  if (calculated === null || invoiced === 0) return null;
  return Number(((calculated - invoiced) / Math.abs(invoiced) * 100).toFixed(2));
}

function comparison(invoiced: number, calculated: number | null): ElectricityInvoiceComparison {
  return { invoicedEur: invoiced, calculatedEur: calculated, errorPercent: errorPercent(calculated, invoiced) };
}

/**
 * Compares a calculated summary with an invoice. Only the total decides the
 * status; per-component errors show where a difference comes from.
 */
export function reconcileInvoice(
  invoice: ElectricityInvoice,
  summary: HomeEnergySummary,
  tolerancePercent = ELECTRICITY_INVOICE_TOLERANCE_PERCENT,
): ElectricityInvoiceReconciliation {
  const breakdown = summary.costBreakdown;
  const total = comparison(invoice.totalEur, summary.totalCostEur);
  const components: Partial<Record<ElectricityCostComponent, ElectricityInvoiceComparison>> = {};
  const invoiced: Array<[ElectricityCostComponent, number | null, number | null]> = [
    ["energy", invoice.energyEur, breakdown?.energyEur ?? null],
    ["network", invoice.networkEur, breakdown?.networkEur ?? null],
    ["tax", invoice.taxEur, breakdown?.taxEur ?? null],
    ["fees", invoice.feesEur, breakdown?.feesEur ?? null],
  ];
  for (const [component, amount, calculated] of invoiced) {
    if (amount !== null) components[component] = comparison(amount, calculated);
  }
  const status = !summary.complete || total.errorPercent === null
    ? "incomplete"
    : Math.abs(total.errorPercent) <= tolerancePercent ? "reconciled" : "outside_tolerance";
  return {
    invoiceId: invoice.id,
    status,
    tolerancePercent,
    from: summary.from,
    to: summary.to,
    consumption: invoice.consumptionKwh === null ? null : {
      invoicedKwh: invoice.consumptionKwh,
      calculatedKwh: summary.consumptionKwh,
      errorPercent: errorPercent(summary.consumptionKwh, invoice.consumptionKwh),
    },
    total,
    components,
    breakdown,
    priceCoveragePercent: summary.priceCoveragePercent,
    calculatedAt: summary.calculatedAt,
  };
}
