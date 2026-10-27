import type {
  Floor,
  HouseLocation,
  HouseMapPlacement,
} from "@climate-twin/contracts";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    validateFloorDefinitions(floors: Floor[]): void;
    validateHouseLocation(location: HouseLocation): void;
    validateHouseTimezone(timezone: string): void;
    validateHouseMapPlacement(mapPlacement: HouseMapPlacement, floors: Floor[]): void;
    validateHouseOrientation(orientationDegrees: number): void;
    validateHouseLayoutForSensors(houseId: string, floors: Floor[]): void;
    validateHouseLayoutForConnectedDevices(houseId: string, floors: Floor[]): void;
    validateHouseLayoutForMaintenanceTasks(houseId: string, floors: Floor[]): void;
  }
}
