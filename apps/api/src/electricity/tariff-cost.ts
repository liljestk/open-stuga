import {
  addLocalDays,
  daysInMonth,
  localDate,
  localDateStart,
  zonedParts,
  type LocalDateParts,
} from "@climate-twin/analytics-kernel";
import {
  ELECTRICITY_DAY_END_HOUR,
  ELECTRICITY_DAY_START_HOUR,
  type ElectricityCostBreakdown,
  type ElectricityCostComponent,
  type ElectricityPriceComponents,
  type ElectricityRateSchedule,
  type ElectricityTariffVersion,
} from "@climate-twin/contracts";
import type { HourlyEnergyUsage } from "../timeseries/types.js";

interface LocalHour {
  dateKey: string;
  month: number;
  hour: number;
  /** 0 = Sunday. */
  weekday: number;
}

const pad = (value: number): string => String(value).padStart(2, "0");

export function localDateKey(parts: LocalDateParts): string {
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function localHour(timestamp: number, timeZone: string): LocalHour {
  const [year, month, day, hour] = zonedParts(timestamp, timeZone);
  return {
    dateKey: localDateKey({ year, month, day }),
    month,
    hour,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function daytime(local: LocalHour): boolean {
  return local.hour >= ELECTRICITY_DAY_START_HOUR && local.hour < ELECTRICITY_DAY_END_HOUR;
}

/** November–March, Monday–Saturday daytime: the Finnish seasonal ("kausi") split. */
function winterWeekdayDaytime(local: LocalHour): boolean {
  return (local.month >= 11 || local.month <= 3) && local.weekday !== 0 && daytime(local);
}

export function scheduleRateCents(schedule: ElectricityRateSchedule, local: LocalHour): number {
  switch (schedule.kind) {
    case "flat": return schedule.centsPerKwh;
    case "day_night": return daytime(local) ? schedule.dayCentsPerKwh : schedule.nightCentsPerKwh;
    case "seasonal": return winterWeekdayDaytime(local) ? schedule.winterDayCentsPerKwh : schedule.otherCentsPerKwh;
  }
}

/** The version in force on a local date; the earliest version also covers earlier dates. */
export function tariffVersionOn(
  versions: readonly ElectricityTariffVersion[],
  dateKey: string,
): ElectricityTariffVersion | null {
  let selected: ElectricityTariffVersion | null = versions[0] ?? null;
  for (const version of versions) {
    if (version.validFrom > dateKey) break;
    selected = version;
  }
  return selected;
}

export interface EffectivePrice {
  /** Energy component; null when the version has no energy price. */
  energyCentsPerKwh: number | null;
  networkCentsPerKwh: number | null;
  taxCentsPerKwh: number | null;
  /** Variable price per kWh; uses the raw spot price while the energy price is missing. */
  totalCentsPerKwh: number;
}

export function effectivePriceAt(
  rawCentsPerKwh: number,
  timestamp: number,
  versions: readonly ElectricityTariffVersion[],
  timeZone: string,
): EffectivePrice {
  const local = localHour(timestamp, timeZone);
  const version = tariffVersionOn(versions, local.dateKey);
  const energy = version?.energy ?? null;
  const energyCents = energy === null
    ? null
    : energy.kind === "spot"
      ? rawCentsPerKwh + energy.marginCentsPerKwh
      : scheduleRateCents(energy.schedule, local);
  const networkCents = version?.network ? scheduleRateCents(version.network, local) : null;
  const taxCents = version?.electricityTaxCentsPerKwh ?? null;
  return {
    energyCentsPerKwh: energyCents,
    networkCentsPerKwh: networkCents,
    taxCentsPerKwh: taxCents,
    totalCentsPerKwh: (energyCents ?? rawCentsPerKwh) + (networkCents ?? 0) + (taxCents ?? 0),
  };
}

/** Recomputes a price point's effective values from its raw price and the tariff for its start. */
export function withTariffPrice<T extends {
  startAt: string;
  rawPriceCentsPerKwh: number;
  effectivePriceCentsPerKwh: number;
  effectivePriceEurPerKwh: number;
}>(point: T, versions: readonly ElectricityTariffVersion[], timeZone: string): T & { components: ElectricityPriceComponents } {
  const price = effectivePriceAt(point.rawPriceCentsPerKwh, Date.parse(point.startAt), versions, timeZone);
  return {
    ...point,
    effectivePriceCentsPerKwh: price.totalCentsPerKwh,
    effectivePriceEurPerKwh: price.totalCentsPerKwh / 100,
    components: {
      energyCentsPerKwh: price.energyCentsPerKwh,
      networkCentsPerKwh: price.networkCentsPerKwh,
      taxCentsPerKwh: price.taxCentsPerKwh,
    },
  };
}

export interface TariffCost {
  consumptionKwh: number;
  /** kWh that had an energy price: every kWh of a fixed version, spot-priced kWh of a spot version. */
  pricedConsumptionKwh: number;
  energyEur: number;
  networkEur: number | null;
  taxEur: number | null;
  energyPriceMissing: boolean;
}

/**
 * Applies the contract in force for each hour. Network and tax are charged on
 * the same priced kWh as energy, so a partially priced period stays a
 * consistent "priced so far" figure.
 */
export function tariffCost(
  hours: readonly HourlyEnergyUsage[],
  versions: readonly ElectricityTariffVersion[],
  timeZone: string,
): TariffCost {
  let consumptionKwh = 0;
  let pricedConsumptionKwh = 0;
  let energyCents = 0;
  let networkCents: number | null = null;
  let taxCents: number | null = null;
  let energyPriceMissing = false;
  for (const usage of hours) {
    consumptionKwh += usage.kwh;
    if (usage.kwh <= 0 && usage.spotPricedKwh <= 0) continue;
    const local = localHour(usage.hourStart, timeZone);
    const version = tariffVersionOn(versions, local.dateKey);
    const energy = version?.energy ?? null;
    if (!version || energy === null) {
      energyPriceMissing = true;
      continue;
    }
    const priced = energy.kind === "spot" ? usage.spotPricedKwh : usage.kwh;
    energyCents += energy.kind === "spot"
      ? usage.spotCostCents + energy.marginCentsPerKwh * priced
      : scheduleRateCents(energy.schedule, local) * priced;
    pricedConsumptionKwh += priced;
    if (version.network) networkCents = (networkCents ?? 0) + scheduleRateCents(version.network, local) * priced;
    if (version.electricityTaxCentsPerKwh !== null) {
      taxCents = (taxCents ?? 0) + version.electricityTaxCentsPerKwh * priced;
    }
  }
  return {
    consumptionKwh,
    pricedConsumptionKwh,
    energyEur: energyCents / 100,
    networkEur: networkCents === null ? null : networkCents / 100,
    taxEur: taxCents === null ? null : taxCents / 100,
    energyPriceMissing,
  };
}

/**
 * Retailer and network monthly fees pro-rated by local calendar day: each day
 * carries fee / days-in-month, scaled by the part of the day inside the range.
 * Returns null when no version in the range has a fee.
 */
export function proratedMonthlyFeesEur(
  fromMs: number,
  toMs: number,
  versions: readonly ElectricityTariffVersion[],
  timeZone: string,
): number | null {
  if (!(toMs > fromMs)) return null;
  let total = 0;
  let configured = false;
  let day = localDate(fromMs, timeZone);
  let dayStart = localDateStart(day, timeZone);
  for (let guard = 0; dayStart !== null && dayStart < toMs && guard < 800; guard += 1) {
    const next = addLocalDays(day, 1);
    const nextStart = localDateStart(next, timeZone);
    if (nextStart === null) break;
    const overlap = Math.min(nextStart, toMs) - Math.max(dayStart, fromMs);
    if (overlap > 0) {
      const version = tariffVersionOn(versions, localDateKey(day));
      if (version && (version.retailerMonthlyFeeEur !== null || version.networkMonthlyFeeEur !== null)) {
        configured = true;
        const monthly = (version.retailerMonthlyFeeEur ?? 0) + (version.networkMonthlyFeeEur ?? 0);
        total += monthly / daysInMonth(day.year, day.month) * overlap / (nextStart - dayStart);
      }
    }
    day = next;
    dayStart = nextStart;
  }
  return configured ? total : null;
}

export function costBreakdown(input: {
  energyEur: number | null;
  networkEur: number | null;
  taxEur: number | null;
  feesEur: number | null;
  energyPriceMissing: boolean;
}): ElectricityCostBreakdown {
  const included: ElectricityCostComponent[] = [];
  if (input.energyEur !== null) included.push("energy");
  if (input.networkEur !== null) included.push("network");
  if (input.taxEur !== null) included.push("tax");
  if (input.feesEur !== null) included.push("fees");
  return { ...input, included };
}
