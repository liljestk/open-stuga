import { useCallback } from "react";
import type { MaintenanceTask, MaintenanceTaskInput, MaintenanceTaskPatch, StaticParameter } from "@climate-twin/contracts";
import { replayMaintenanceTaskMutation } from "./support";
import type { HouseMutationBuffer } from "./support";
import {
  api,
} from "../../api";
import type { ClimateDataStore, MaintenanceActions } from "./pipelineTypes";
export function useMaintenanceActions(
  store: Pick<ClimateDataStore,
    | "activeHouseMutationBuffers" | "apiAvailable" | "recordHouseMutation" | "setState" | "state"
    | "stateRef"
  >,
): MaintenanceActions {
  const { apiAvailable, recordHouseMutation, setState, stateRef, activeHouseMutationBuffers } = store;
  const createMaintenanceTask = useCallback(async (input: MaintenanceTaskInput): Promise<MaintenanceTask> => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The maintenance task was not saved.");
      const saved = await api.createMaintenanceTask(input);
      recordHouseMutation({ resource: "maintenance", action: "upsert", houseId: saved.houseId, value: saved });
      setState((current) => ({ ...current, maintenanceTasks: [...current.maintenanceTasks, saved] }));
      return saved;
    }, [recordHouseMutation]);
  const reloadMaintenanceTask = useCallback(async (id: string): Promise<MaintenanceTask> => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The maintenance task could not be reloaded.");
      const current = stateRef.current.maintenanceTasks.find((task) => task.id === id);
      if (!current) throw new Error("The maintenance task is no longer available.");
      const concurrentMutations: HouseMutationBuffer = new Map();
      activeHouseMutationBuffers.current.add(concurrentMutations);
      try {
        let fresh: MaintenanceTask | undefined;
        try {
          fresh = await api.maintenanceTask(id);
        } catch (error) {
          const status = error && typeof error === "object" && "status" in error
            ? (error as { status?: unknown }).status
            : null;
          if (status !== 404) throw error;
        }
        const reloaded = replayMaintenanceTaskMutation(
          id,
          fresh,
          concurrentMutations,
        );
        activeHouseMutationBuffers.current.delete(concurrentMutations);
        if (!reloaded) {
          recordHouseMutation({ resource: "maintenance", action: "delete", houseId: current.houseId, id });
          setState((state) => ({
            ...state,
            maintenanceTasks: state.maintenanceTasks.filter((item) => item.id !== id),
          }));
          throw new Error("The maintenance task is no longer available.");
        }
        if (current.houseId !== reloaded.houseId) {
          recordHouseMutation({ resource: "maintenance", action: "delete", houseId: current.houseId, id });
        }
        recordHouseMutation({ resource: "maintenance", action: "upsert", houseId: reloaded.houseId, value: reloaded });
        setState((state) => ({
          ...state,
          maintenanceTasks: [...state.maintenanceTasks.filter((item) => item.id !== id), reloaded],
        }));
        return reloaded;
      } finally {
        activeHouseMutationBuffers.current.delete(concurrentMutations);
      }
    }, [recordHouseMutation]);
  const updateMaintenanceTask = useCallback(async (id: string, patch: MaintenanceTaskPatch): Promise<MaintenanceTask> => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The maintenance task was not updated.");
      const current = stateRef.current.maintenanceTasks.find((task) => task.id === id);
      if (!current) throw new Error("The maintenance task is no longer available.");
      if (current.revision !== patch.baseRevision) throw new Error("The maintenance task changed before this edit could be saved.");
      const saved = await api.updateMaintenanceTask(id, patch);
      if (current.houseId !== saved.houseId) {
        recordHouseMutation({ resource: "maintenance", action: "delete", houseId: current.houseId, id });
      }
      recordHouseMutation({ resource: "maintenance", action: "upsert", houseId: saved.houseId, value: saved });
      setState((state) => ({
        ...state,
        maintenanceTasks: [...state.maintenanceTasks.filter((task) => task.id !== id), saved],
      }));
      return saved;
    }, [recordHouseMutation]);
  const maintenanceTaskRevisions = useCallback(async (id: string) => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. Revision history could not be loaded.");
      return api.maintenanceTaskRevisions(id);
    }, []);
  const deleteMaintenanceTask = useCallback(async (id: string): Promise<void> => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The maintenance task was not deleted.");
      const task = stateRef.current.maintenanceTasks.find((item) => item.id === id);
      await api.deleteMaintenanceTask(id);
      if (task) recordHouseMutation({ resource: "maintenance", action: "delete", houseId: task.houseId, id });
      setState((current) => ({ ...current, maintenanceTasks: current.maintenanceTasks.filter((task) => task.id !== id) }));
    }, [recordHouseMutation]);
  const createStaticParameter = useCallback(async (parameter: Omit<StaticParameter, "id">) => {
      const matchesScopeAndKey = (item: StaticParameter) => item.houseId === parameter.houseId
        && item.scopeType === parameter.scopeType && item.scopeId === parameter.scopeId && item.key === parameter.key;
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The parameter was not saved.");
      const saved = await api.createStaticParameter(parameter);
      recordHouseMutation({ resource: "static", action: "upsert", houseId: saved.houseId, value: saved });
      setState((current) => ({ ...current, staticParameters: [...current.staticParameters.filter((item) => !matchesScopeAndKey(item)), saved] }));
      return saved;
    }, [recordHouseMutation]);
  return { createMaintenanceTask, reloadMaintenanceTask, updateMaintenanceTask, maintenanceTaskRevisions, deleteMaintenanceTask, createStaticParameter };
}
