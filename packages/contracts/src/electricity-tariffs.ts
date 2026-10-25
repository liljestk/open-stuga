/**
 * Time-varying electricity contract terms. Every rate includes VAT, as on a
 * consumer invoice, and is entered in cents per kWh; fees are in euros per
 * calendar month. Raw spot prices are never rewritten: costs and effective
 * prices are derived at read time from the version valid for each interval.
 */

/** Local 07:00–22:00 is daytime for day/night and seasonal schedules. */
export const ELECTRICITY_DAY_START_HOUR = 7;
export const ELECTRICITY_DAY_END_HOUR = 22;

/** validFrom of a Property's first, open-ended tariff version. */
export const ELECTRICITY_TARIFF_EPOCH = "2000-01-01";

/**
 * Flat, day/night (daytime 07–22 local) or seasonal (winter weekday daytime:
 * November–March, Monday–Saturday 07–22 local; every other hour is "other").
 */
export type ElectricityRateSchedule =
  | { kind: "flat"; centsPerKwh: number }
  | { kind: "day_night"; dayCentsPerKwh: number; nightCentsPerKwh: number }
  | { kind: "seasonal"; winterDayCentsPerKwh: number; otherCentsPerKwh: number };

export type ElectricityRateScheduleKind = ElectricityRateSchedule["kind"];

/** Spot follows the raw feed plus a margin; fixed uses its own schedule. */
export type ElectricityEnergyPricing =
  | { kind: "spot"; marginCentsPerKwh: number }
  | { kind: "fixed"; schedule: ElectricityRateSchedule };

export interface ElectricityTariffVersion {
  /** First local date (YYYY-MM-DD) this version applies; the earliest version also covers all earlier time. */
  validFrom: string;
  /** Null until the energy price of a fixed contract is known; energy cost is then unavailable. */
  energy: ElectricityEnergyPricing | null;
  /** Distribution (network transfer) charge, when the operator invoices it per kWh. */
  network: ElectricityRateSchedule | null;
  electricityTaxCentsPerKwh: number | null;
  retailerMonthlyFeeEur: number | null;
  networkMonthlyFeeEur: number | null;
}

export interface PropertyElectricityTariff {
  propertyId: string;
  /** Sorted by validFrom, unique dates, at least one version. */
  versions: ElectricityTariffVersion[];
  /** Increments on every save so cached costs can be keyed by it. */
  revision: number;
  updatedAt: string;
}

export type ElectricityCostComponent = "energy" | "network" | "tax" | "fees";

/** Euro amounts per invoice component; null when that component is not configured for the period. */
export interface ElectricityCostBreakdown {
  energyEur: number | null;
  networkEur: number | null;
  taxEur: number | null;
  feesEur: number | null;
  /** Components the cost includes, in invoice order. */
  included: ElectricityCostComponent[];
  /** True when some consumption fell in a version without an energy price. */
  energyPriceMissing: boolean;
}

/** A manually entered invoice used to check the cost model. */
export interface ElectricityInvoice {
  id: string;
  propertyId: string;
  houseId: string;
  /** Inclusive local billing dates (YYYY-MM-DD). */
  periodStart: string;
  periodEnd: string;
  totalEur: number;
  consumptionKwh: number | null;
  energyEur: number | null;
  networkEur: number | null;
  taxEur: number | null;
  feesEur: number | null;
  note: string | null;
  createdAt: string;
}

export type ElectricityInvoiceInput = Pick<ElectricityInvoice,
  "houseId" | "periodStart" | "periodEnd" | "totalEur"
> & Partial<Pick<ElectricityInvoice,
  "consumptionKwh" | "energyEur" | "networkEur" | "taxEur" | "feesEur" | "note"
>>;

export type ElectricityReconciliationStatus = "reconciled" | "outside_tolerance" | "incomplete";

export interface ElectricityInvoiceComparison {
  invoicedEur: number;
  calculatedEur: number | null;
  /** (calculated − invoiced) / invoiced × 100, null when either side is missing or the invoice is zero. */
  errorPercent: number | null;
}

/** Calculated cost for an invoice period compared with the invoiced amounts. */
export interface ElectricityInvoiceReconciliation {
  invoiceId: string;
  status: ElectricityReconciliationStatus;
  /** Allowed absolute error in percent. */
  tolerancePercent: number;
  from: string;
  to: string;
  consumption: { invoicedKwh: number; calculatedKwh: number | null; errorPercent: number | null } | null;
  total: ElectricityInvoiceComparison;
  components: Partial<Record<ElectricityCostComponent, ElectricityInvoiceComparison>>;
  breakdown: ElectricityCostBreakdown | null;
  /** Price coverage and completeness of the calculated summary. */
  priceCoveragePercent: number | null;
  calculatedAt: string;
}

export const ELECTRICITY_INVOICE_TOLERANCE_PERCENT = 2;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const RATE_LIMIT_CENTS = 1_000;
const FEE_LIMIT_EUR = 10_000;

export function isLocalDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validRate(value: unknown, allowNegative = false): value is number {
  return typeof value === "number" && Number.isFinite(value)
    && value <= RATE_LIMIT_CENTS && value >= (allowNegative ? -RATE_LIMIT_CENTS : 0);
}

function validFee(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= FEE_LIMIT_EUR);
}

function scheduleProblem(schedule: unknown, field: string): string | null {
  if (!schedule || typeof schedule !== "object") return `${field} must be a rate schedule`;
  const value = schedule as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  switch (value.kind) {
    case "flat":
      return keys === "centsPerKwh,kind" && validRate(value.centsPerKwh) ? null : `${field} needs a flat centsPerKwh between 0 and ${RATE_LIMIT_CENTS}`;
    case "day_night":
      return keys === "dayCentsPerKwh,kind,nightCentsPerKwh" && validRate(value.dayCentsPerKwh) && validRate(value.nightCentsPerKwh)
        ? null : `${field} needs dayCentsPerKwh and nightCentsPerKwh between 0 and ${RATE_LIMIT_CENTS}`;
    case "seasonal":
      return keys === "kind,otherCentsPerKwh,winterDayCentsPerKwh" && validRate(value.winterDayCentsPerKwh) && validRate(value.otherCentsPerKwh)
        ? null : `${field} needs winterDayCentsPerKwh and otherCentsPerKwh between 0 and ${RATE_LIMIT_CENTS}`;
    default:
      return `${field} kind must be flat, day_night or seasonal`;
  }
}

/** Returns the first problem in a tariff version list, or null when it can be saved. */
export function electricityTariffProblem(versions: unknown): string | null {
  if (!Array.isArray(versions) || versions.length === 0) return "A tariff needs at least one version";
  if (versions.length > 120) return "A tariff can have at most 120 versions";
  let previous = "";
  for (const [index, candidate] of versions.entries()) {
    const field = `versions[${index}]`;
    if (!candidate || typeof candidate !== "object") return `${field} must be an object`;
    const version = candidate as Record<string, unknown>;
    const allowed = new Set(["validFrom", "energy", "network", "electricityTaxCentsPerKwh", "retailerMonthlyFeeEur", "networkMonthlyFeeEur"]);
    const unknown = Object.keys(version).find((key) => !allowed.has(key));
    if (unknown) return `${field}.${unknown} is not a tariff field`;
    if (!isLocalDateKey(version.validFrom)) return `${field}.validFrom must be a YYYY-MM-DD date`;
    if (version.validFrom <= previous) return "Tariff versions must have unique validFrom dates in ascending order";
    previous = version.validFrom;
    const energy = version.energy ?? null;
    if (energy !== null) {
      if (!energy || typeof energy !== "object") return `${field}.energy must be spot, fixed or null`;
      const pricing = energy as Record<string, unknown>;
      if (pricing.kind === "spot") {
        if (Object.keys(pricing).sort().join(",") !== "kind,marginCentsPerKwh" || !validRate(pricing.marginCentsPerKwh, true)) {
          return `${field}.energy needs a spot marginCentsPerKwh between -${RATE_LIMIT_CENTS} and ${RATE_LIMIT_CENTS}`;
        }
      } else if (pricing.kind === "fixed") {
        if (Object.keys(pricing).sort().join(",") !== "kind,schedule") return `${field}.energy needs a fixed schedule`;
        const problem = scheduleProblem(pricing.schedule, `${field}.energy.schedule`);
        if (problem) return problem;
      } else {
        return `${field}.energy kind must be spot or fixed`;
      }
    }
    if ((version.network ?? null) !== null) {
      const problem = scheduleProblem(version.network, `${field}.network`);
      if (problem) return problem;
    }
    const tax = version.electricityTaxCentsPerKwh ?? null;
    if (tax !== null && !validRate(tax)) {
      return `${field}.electricityTaxCentsPerKwh must be between 0 and ${RATE_LIMIT_CENTS}`;
    }
    if (!validFee(version.retailerMonthlyFeeEur ?? null) || !validFee(version.networkMonthlyFeeEur ?? null)) {
      return `${field} monthly fees must be between 0 and ${FEE_LIMIT_EUR} euros`;
    }
  }
  return null;
}

/** A validated version with omitted optional terms stored as explicit nulls. */
export function normalizedElectricityTariffVersion(version: ElectricityTariffVersion): ElectricityTariffVersion {
  return {
    validFrom: version.validFrom,
    energy: version.energy ?? null,
    network: version.network ?? null,
    electricityTaxCentsPerKwh: version.electricityTaxCentsPerKwh ?? null,
    retailerMonthlyFeeEur: version.retailerMonthlyFeeEur ?? null,
    networkMonthlyFeeEur: version.networkMonthlyFeeEur ?? null,
  };
}

/** The tariff a Property gets from its pre-0.43 contract fields; a fixed contract still needs its energy price. */
export function legacyElectricityTariffVersion(input: {
  contractType: "spot" | "fixed" | "other";
  marginCentsPerKwh: number;
  monthlyFeeEur: number | null;
}): ElectricityTariffVersion {
  return {
    validFrom: ELECTRICITY_TARIFF_EPOCH,
    energy: input.contractType === "fixed" ? null : { kind: "spot", marginCentsPerKwh: input.marginCentsPerKwh },
    network: null,
    electricityTaxCentsPerKwh: null,
    retailerMonthlyFeeEur: input.monthlyFeeEur,
    networkMonthlyFeeEur: null,
  };
}
