import { useCallback } from "react";
import type {
  StaticParameter,
} from "@climate-twin/contracts";
import {
  api,
} from "../../api";
import type { MaintenanceActions, OperationsContext } from "./pipelineTypes";
export function useMaintenanceActions(
  context: OperationsContext,
): OperationsContext & MaintenanceActions {
  const { setState, apiAvailable, stateRef, recordHouseMutation } = context;
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
  return Object.assign(context, { deleteMaintenanceTask, createStaticParameter });
}
