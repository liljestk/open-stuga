import type { ApiReadSchedulingClass } from "./support/requestScheduler";
import type { MaintenanceTask, MaintenanceTaskInput, MaintenanceTaskPatch, MaintenanceTaskRevision, ManualObservation, ManualObservationInput, ManualObservationPatch, ObservationRevision, StaticParameter } from "@climate-twin/contracts";
import { completeCollection, list, request } from "./support/request";
import type { MaintenanceTaskFilters } from "./support/response-types";

/** Observations, maintenance tasks and static parameters. */
export const maintenanceApi = {
  observations: async (houseId: string, schedulingClass: ApiReadSchedulingClass = "background") => list<ManualObservation>(await request<unknown>(`/observations?houseId=${encodeURIComponent(houseId)}`, { schedulingClass }), "observations"),
  createObservation: async (observation: ManualObservationInput) => (await request<{ observation: ManualObservation }>("/observations", { method: "POST", body: JSON.stringify(observation) })).observation,
  updateObservation: async (id: string, patch: ManualObservationPatch) => (await request<{ observation: ManualObservation }>(`/observations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) })).observation,
  observationRevisions: async (id: string) => list<ObservationRevision>(await request<unknown>(`/observations/${encodeURIComponent(id)}/revisions`), "revisions"),
  maintenanceTasks: async (filters: MaintenanceTaskFilters = {}, schedulingClass: ApiReadSchedulingClass = "background") => {
      const query = new URLSearchParams();
      if (filters.propertyId) query.set("propertyId", filters.propertyId);
      if (filters.houseId) query.set("houseId", filters.houseId);
      if (filters.areaId) query.set("areaId", filters.areaId);
      if (filters.equipmentId) query.set("equipmentId", filters.equipmentId);
      const suffix = query.size ? `?${query.toString()}` : "";
      return completeCollection<MaintenanceTask>(`/maintenance-tasks${suffix}`, "maintenanceTasks", { schedulingClass });
    },
  createMaintenanceTask: (input: MaintenanceTaskInput) => request<MaintenanceTask>("/maintenance-tasks", { method: "POST", body: JSON.stringify(input) }),
  maintenanceTask: (id: string) => request<MaintenanceTask>(`/maintenance-tasks/${encodeURIComponent(id)}`),
  updateMaintenanceTask: (id: string, patch: MaintenanceTaskPatch) => request<MaintenanceTask>(`/maintenance-tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  maintenanceTaskRevisions: async (id: string) => list<MaintenanceTaskRevision>(await request<unknown>(`/maintenance-tasks/${encodeURIComponent(id)}/revisions`), "revisions"),
  deleteMaintenanceTask: (id: string) => request<void>(`/maintenance-tasks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  staticParameters: async (houseId: string, schedulingClass: ApiReadSchedulingClass = "background") => list<StaticParameter>(await request<unknown>(`/parameters?houseId=${encodeURIComponent(houseId)}`, { schedulingClass }), "parameters"),
  createStaticParameter: async (parameter: Omit<StaticParameter, "id">) => (await request<{ parameter: StaticParameter }>("/parameters", { method: "POST", body: JSON.stringify(parameter) })).parameter,
};
