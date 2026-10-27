import type { ClimateDatabase } from "../db.js";
import type { ElectricityTariffContext } from "../energy-cost.js";

type TariffDatabase = Pick<ClimateDatabase, "getPropertyElectricityTariff" | "propertyElectricityTimeZone" | "getHouse">;

/** Looks up a Property's tariff, read in the Home's time zone when a Home is given. */
export function databaseTariffContext(database: TariffDatabase) {
  return (propertyId: string, houseId?: string): ElectricityTariffContext | null => {
    const tariff = database.getPropertyElectricityTariff(propertyId);
    if (!tariff) return null;
    const houseTimeZone = houseId ? database.getHouse(houseId)?.timezone : undefined;
    return {
      versions: tariff.versions,
      revision: tariff.revision,
      timeZone: houseTimeZone || database.propertyElectricityTimeZone(propertyId),
    };
  };
}
