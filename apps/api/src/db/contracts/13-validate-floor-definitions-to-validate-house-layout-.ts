import type {
  Floor,
  HouseLocation,
  HouseMapPlacement,
} from "@climate-twin/contracts";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    parseFloorDefinitions(value: unknown): Floor[];
    validateHouseLocation(location: HouseLocation): void;
    validateHouseTimezone(timezone: string): void;
    validateHouseMapPlacement(mapPlacement: HouseMapPlacement, floors: Floor[]): void;
    validateHouseOrientation(orientationDegrees: number): void;
    validateHouseLayoutForSensors(houseId: string, floors: Floor[]): void;
    validateHouseLayoutForConnectedDevices(houseId: string, floors: Floor[]): void;
    validateHouseLayoutForMaintenanceTasks(houseId: string, floors: Floor[]): void;
  }

  interface ClimateDatabaseCore {
    /** `value` as a floor list once every floor, wall, room and plan element is valid; a 400 validation error otherwise. */
    parseFloorDefinitions(value: unknown): Floor[];
  }
}
