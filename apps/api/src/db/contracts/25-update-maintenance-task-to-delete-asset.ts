import type {
  MaintenanceTask,
  MaintenanceTaskChangedField,
  MaintenanceTaskPatch,
  MaintenanceTaskRevisionActor,
  StaticParameter,
} from "@climate-twin/contracts";
import { LocalMaintenanceTaskRevisionActor } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { AssetRecord } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    updateMaintenanceTask(id: string, patch: MaintenanceTaskPatch, actor?: LocalMaintenanceTaskRevisionActor): MaintenanceTask | null;
    deleteMaintenanceTask(id: string): boolean;
    maintenanceTaskObservationIds(maintenanceTaskId: string): string[];
    replaceMaintenanceTaskObservationLinks(maintenanceTaskId: string, observationIds: string[]): void;
    insertMaintenanceTaskRevision(
        task: MaintenanceTask,
        actor: MaintenanceTaskRevisionActor,
        changedFields: MaintenanceTaskChangedField[],
      ): void;
    ensureScopeMoveCanDetachHouses(where: string, values: string[], propertyId: string): void;
    maintenanceTasksBeforeScopeMove(where: string, values: string[]): MaintenanceTask[];
    recordScopeMoveMaintenanceRevisions(
        previousTasks: readonly MaintenanceTask[],
        actor?: MaintenanceTaskRevisionActor,
      ): void;
    validateMaintenanceTask(task: MaintenanceTask, retainedHiddenHouseId?: string | null): void;
    listParameters(houseId?: string): StaticParameter[];
    saveParameter(input: Omit<StaticParameter, "id"> & {
            id?: string;
        }): StaticParameter;
    deleteParameter(id: string): boolean;
    createAsset(input: Omit<AssetRecord, "id" | "size" | "createdAt"> & {
            data: Uint8Array;
        }): AssetRecord;
    listAssets(houseId?: string): AssetRecord[];
    getAsset(id: string): (AssetRecord & {
            data: Uint8Array;
        }) | null;
    deleteAsset(id: string): boolean;
  }

  interface ClimateDatabaseCore {
    updateMaintenanceTask(id: string, patch: MaintenanceTaskPatch, actor?: LocalMaintenanceTaskRevisionActor): MaintenanceTask | null;
    deleteMaintenanceTask(id: string): boolean;
    listParameters(houseId?: string): StaticParameter[];
    saveParameter(input: Omit<StaticParameter, "id"> & {
            id?: string;
        }): StaticParameter;
    deleteParameter(id: string): boolean;
    createAsset(input: Omit<AssetRecord, "id" | "size" | "createdAt"> & {
            data: Uint8Array;
        }): AssetRecord;
    listAssets(houseId?: string): AssetRecord[];
    getAsset(id: string): (AssetRecord & {
            data: Uint8Array;
        }) | null;
    deleteAsset(id: string): boolean;
  }
}
