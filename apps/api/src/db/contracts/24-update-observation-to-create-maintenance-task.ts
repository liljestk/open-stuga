import type {
  MaintenanceTask,
  MaintenanceTaskInput,
  MaintenanceTaskRevision,
  ManualObservation,
  ManualObservationPatch,
  ObservationChangedField,
} from "@climate-twin/contracts";
import { LocalMaintenanceTaskRevisionActor, LocalObservationRevisionActor, StoredObservation } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    updateObservation(id: string, patch: ManualObservationPatch, actor?: LocalObservationRevisionActor): ManualObservation | null;
    deleteObservation(id: string): boolean;
    insertObservationRevision(
        observation: StoredObservation,
        actor: LocalObservationRevisionActor,
        changedFields: ObservationChangedField[],
      ): void;
    validateObservation(observation: StoredObservation, validateSensorRelation?: boolean): void;
    listMaintenanceTasks(filters?: {
            propertyId?: string;
            houseId?: string;
            areaId?: string;
            equipmentId?: string;
            limit?: number;
            offset?: number;
        }): MaintenanceTask[];
    getMaintenanceTask(id: string): MaintenanceTask | null;
    listMaintenanceTaskRevisions(maintenanceTaskId: string): MaintenanceTaskRevision[];
    getOrCreateMaintenanceTask(input: MaintenanceTaskInput, actor?: LocalMaintenanceTaskRevisionActor): {
            task: MaintenanceTask;
            created: boolean;
        };
    createMaintenanceTask(input: MaintenanceTaskInput, actor?: LocalMaintenanceTaskRevisionActor): MaintenanceTask;
  }

  interface ClimateDatabaseCore {
    updateObservation(id: string, patch: ManualObservationPatch, actor?: LocalObservationRevisionActor): ManualObservation | null;
    deleteObservation(id: string): boolean;
    listMaintenanceTasks(filters?: {
            propertyId?: string;
            houseId?: string;
            areaId?: string;
            equipmentId?: string;
            limit?: number;
            offset?: number;
        }): MaintenanceTask[];
    getMaintenanceTask(id: string): MaintenanceTask | null;
    listMaintenanceTaskRevisions(maintenanceTaskId: string): MaintenanceTaskRevision[];
    getOrCreateMaintenanceTask(input: MaintenanceTaskInput, actor?: LocalMaintenanceTaskRevisionActor): {
            task: MaintenanceTask;
            created: boolean;
        };
    createMaintenanceTask(input: MaintenanceTaskInput, actor?: LocalMaintenanceTaskRevisionActor): MaintenanceTask;
  }
}
