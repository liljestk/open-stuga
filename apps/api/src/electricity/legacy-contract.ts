import type {
  ElectricityContractType,
  ElectricityTariffVersion,
  PropertyElectricityConfig,
  PropertyElectricityTariff,
} from "@climate-twin/contracts";
import { tariffVersionOn } from "./tariff-cost.js";

/** The pre-0.43 contract fields, which still exist on the configuration API. */
export interface LegacyElectricityContract {
  contractType: ElectricityContractType;
  marginCentsPerKwh: number;
  monthlyFeeEur: number | null;
}

export function utcDateKey(at = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** Shows a saved tariff's version in force today through the legacy contract fields. */
export function projectedElectricityConfig(
  config: PropertyElectricityConfig,
  tariff: PropertyElectricityTariff | null,
  today = utcDateKey(),
): PropertyElectricityConfig {
  if (!tariff || tariff.revision === 0) return config;
  const version = tariffVersionOn(tariff.versions, today);
  if (!version) return config;
  const energy = version.energy;
  return {
    ...config,
    contractType: energy?.kind === "spot" ? config.contractType === "other" ? "other" : "spot" : "fixed",
    marginCentsPerKwh: energy?.kind === "spot" ? energy.marginCentsPerKwh : config.marginCentsPerKwh,
    monthlyFeeEur: version.retailerMonthlyFeeEur,
  };
}

/**
 * Applies legacy contract fields to the version in force today. Returns null
 * when nothing changes, so clients that resend the projection never create
 * a new tariff revision.
 */
export function versionsWithLegacyContract(
  tariff: PropertyElectricityTariff,
  contract: LegacyElectricityContract,
  today = utcDateKey(),
): ElectricityTariffVersion[] | null {
  const current = tariffVersionOn(tariff.versions, today);
  if (!current) return null;
  const energy: ElectricityTariffVersion["energy"] = contract.contractType === "fixed"
    ? current.energy?.kind === "fixed" ? current.energy : null
    : { kind: "spot", marginCentsPerKwh: contract.marginCentsPerKwh };
  const next: ElectricityTariffVersion = { ...current, energy, retailerMonthlyFeeEur: contract.monthlyFeeEur };
  if (JSON.stringify(next) === JSON.stringify(current)) return null;
  return tariff.versions.map((version) => version === current ? next : version);
}
