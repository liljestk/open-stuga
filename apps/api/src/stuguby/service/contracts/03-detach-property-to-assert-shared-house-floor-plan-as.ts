import type {
  Floor,
  House,
} from "@climate-twin/contracts";
import {
  type StugubyPropertyAdoption,
} from "../../store.js";
import "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    detachProperty(stugubyId: string): StugubyPropertyAdoption;
    promoteFullRecovery(stugubyId: string, house: House): void;
    assertPropertyWriteAllowed(propertyId: string): void;
    assertHouseWriteAllowed(houseId: string): void;
    assertHouseLocalAuthority(houseId: string): void;
    assertSharedHouseFloorPlanAssetsUnchanged(houseId: string, floors: Floor[]): void;
  }

  interface StugubyServiceCore {
    detachProperty(stugubyId: string): StugubyPropertyAdoption;
    assertPropertyWriteAllowed(propertyId: string): void;
    assertHouseWriteAllowed(houseId: string): void;
    assertHouseLocalAuthority(houseId: string): void;
    assertSharedHouseFloorPlanAssetsUnchanged(houseId: string, floors: Floor[]): void;
  }
}
