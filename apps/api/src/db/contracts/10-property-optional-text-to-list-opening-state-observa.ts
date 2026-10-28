import type {
  AreaEquipment,
  House,
  OpeningStateObservation,
  Property,
  PropertyArea,
  PropertyNote,
  StugubyHouseLink,
} from "@climate-twin/contracts";
import { PropertyMigrationResult } from "../support/01-json-value-to-area-equipment-row.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    propertyOptionalText(value: string | null, field: string, maximumLength: number): string | null;
    equipmentLinkUrl(value: string): string;
    nextUpdatedAt(previous: string): string;
    validatePropertyArea(area: PropertyArea): void;
    validateAreaEquipment(equipment: AreaEquipment, retainedHiddenHouseId?: string | null): void;
    validatePropertyNote(note: PropertyNote, retainedHiddenHouseId?: string | null): void;
    ensureDefaultProperty(): Property;
    listHouses(propertyId?: string): House[];
    getHouse(id: string): House | null;
    setHouseStugubyLink(id: string, link: StugubyHouseLink | null): House | null;
    clearStugubyLinks(stugubyId: string): {
            properties: number;
            houses: number;
        };
    migratePropertyInto(sourcePropertyId: string, targetPropertyId: string, houseLinks: Readonly<Record<string, StugubyHouseLink>>): PropertyMigrationResult;
    listOpeningStateObservations(houseId: string, options?: { limit?: number; at?: string | number | Date }): OpeningStateObservation[];
    listCurrentOpeningStateCandidates(houseId: string, at?: string | number | Date, limit?: number): OpeningStateObservation[];
  }

  interface ClimateDatabaseCore {
    listHouses(propertyId?: string): House[];
    getHouse(id: string): House | null;
    setHouseStugubyLink(id: string, link: StugubyHouseLink | null): House | null;
    clearStugubyLinks(stugubyId: string): {
            properties: number;
            houses: number;
        };
    migratePropertyInto(sourcePropertyId: string, targetPropertyId: string, houseLinks: Readonly<Record<string, StugubyHouseLink>>): PropertyMigrationResult;
    listOpeningStateObservations(houseId: string, options?: { limit?: number; at?: string | number | Date }): OpeningStateObservation[];
    listCurrentOpeningStateCandidates(houseId: string, at?: string | number | Date, limit?: number): OpeningStateObservation[];
  }
}
