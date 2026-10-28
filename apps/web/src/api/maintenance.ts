import type { ApiReadSchedulingClass } from "./support/requestScheduler";
import type { MaintenanceTaskInput, MaintenanceTaskPatch, ManualObservationInput, ManualObservationPatch, StaticParameter } from "@climate-twin/contracts";
import { completeCollection, request } from "./support/request";
import type { MaintenanceTaskFilters } from "./support/response-types";
import { maintenanceTaskRevisionShape, maintenanceTaskShape, manualObservationShape, observationRevisionShape, staticParameterShape } from "./support/entity-shapes";
import { noContent, arrayOf, fields } from "./support/response-shapes";

/** Observations, maintenance tasks and static parameters. */
export const maintenanceApi = {
  observations: async (houseId: string, schedulingClass: ApiReadSchedulingClass = "background") => (await request(`/observations?houseId=${encodeURIComponent(houseId)}`, fields({ observations: arrayOf(manualObservationShape) }), { schedulingClass })).observations,
  createObservation: async (observation: ManualObservationInput) => (await request("/observations", fields({ observation: manualObservationShape }), { method: "POST", body: JSON.stringify(observation) })).observation,
  updateObservation: async (id: string, patch: ManualObservationPatch) => (await request(`/observations/${encodeURIComponent(id)}`, fields({ observation: manualObservationShape }), { method: "PATCH", body: JSON.stringify(patch) })).observation,
  observationRevisions: async (id: string) => (await request(`/observations/${encodeURIComponent(id)}/revisions`, fields({ revisions: arrayOf(observationRevisionShape) }))).revisions,
  maintenanceTasks: async (filters: MaintenanceTaskFilters = {}, schedulingClass: ApiReadSchedulingClass = "background") => {
      const query = new URLSearchParams();
      if (filters.propertyId) query.set("propertyId", filters.propertyId);
      if (filters.houseId) query.set("houseId", filters.houseId);
      if (filters.areaId) query.set("areaId", filters.areaId);
      if (filters.equipmentId) query.set("equipmentId", filters.equipmentId);
      const suffix = query.size ? `?${query.toString()}` : "";
      return completeCollection(`/maintenance-tasks${suffix}`, { key: "maintenanceTasks", item: maintenanceTaskShape, schedulingClass });
    },
  createMaintenanceTask: (input: MaintenanceTaskInput) => request("/maintenance-tasks", maintenanceTaskShape, { method: "POST", body: JSON.stringify(input) }),
  maintenanceTask: (id: string) => request(`/maintenance-tasks/${encodeURIComponent(id)}`, maintenanceTaskShape),
  updateMaintenanceTask: (id: string, patch: MaintenanceTaskPatch) => request(`/maintenance-tasks/${encodeURIComponent(id)}`, maintenanceTaskShape, { method: "PATCH", body: JSON.stringify(patch) }),
  maintenanceTaskRevisions: async (id: string) => (await request(`/maintenance-tasks/${encodeURIComponent(id)}/revisions`, fields({ revisions: arrayOf(maintenanceTaskRevisionShape) }))).revisions,
  deleteMaintenanceTask: (id: string) => request(`/maintenance-tasks/${encodeURIComponent(id)}`, noContent, { method: "DELETE" }),
  staticParameters: async (houseId: string, schedulingClass: ApiReadSchedulingClass = "background") => (await request(`/parameters?houseId=${encodeURIComponent(houseId)}`, fields({ parameters: arrayOf(staticParameterShape) }), { schedulingClass })).parameters,
  createStaticParameter: async (parameter: Omit<StaticParameter, "id">) => (await request("/parameters", fields({ parameter: staticParameterShape }), { method: "POST", body: JSON.stringify(parameter) })).parameter,
};
