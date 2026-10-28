import type { ApiReadSchedulingClass } from "./support/requestScheduler";
import { type SensorPatch, withSignal, type SensorDataGap } from "@climate-twin/contracts";
import { request, requestV2 } from "./support/request";
import type { CreateSensorInput } from "./support/response-types";
import { measurementDefinitionShape, sensorDataGapShape, sensorLabelDescriptorShape, sensorShape, sensorSnapshotShape } from "./support/entity-shapes";
import { noContent, arrayOf, fields } from "./support/response-shapes";

/** Sensors, their snapshots, labels, mappings and data gaps, and the measurement registry. */
export const sensorsApi = {
  sensors: async (houseId?: string, schedulingClass: ApiReadSchedulingClass = "background") => (await request(houseId === undefined ? "/sensors" : `/sensors?houseId=${encodeURIComponent(houseId)}`, fields({ sensors: arrayOf(sensorShape) }), { schedulingClass })).sensors,
  snapshot: async (houseId: string, schedulingClass: ApiReadSchedulingClass = "background") => (await request(`/sensors/snapshots?houseId=${encodeURIComponent(houseId)}`, fields({ sensors: arrayOf(sensorSnapshotShape) }), { schedulingClass })).sensors,
  createSensor: async (sensor: CreateSensorInput) => (await request("/sensors", fields({ sensor: sensorShape }), {
      method: "POST",
      body: JSON.stringify(sensor),
    })).sensor,
  updateSensor: async (sensorId: string, sensor: SensorPatch) => (await request(`/sensors/${encodeURIComponent(sensorId)}`, fields({ sensor: sensorShape }), {
      method: "PATCH",
      body: JSON.stringify(sensor),
    })).sensor,
  deleteSensor: (sensorId: string) => request(`/sensors/${encodeURIComponent(sensorId)}`, noContent, { method: "DELETE" }),
  sensorLabel: async (sensorId: string) => (await request(`/sensors/${encodeURIComponent(sensorId)}/label`, fields({ label: sensorLabelDescriptorShape }))).label,
  bulkSensorMappings: (houseId: string, mappings: Array<{ sensorId: string; measurementEntityIds: Record<string, string> }>) => request("/setup/bulk-sensor-mappings", fields({ sensors: arrayOf(sensorShape) }), {
      method: "POST",
      body: JSON.stringify({ houseId, mappings }),
    }),
  sensorDataGaps: async (houseId?: string, limit = 500, signal?: AbortSignal): Promise<SensorDataGap[]> => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (houseId) query.set("houseId", houseId);
      return (await request(`/integrations/sensor-data-gaps?${query}`, fields({ gaps: arrayOf(sensorDataGapShape) }), withSignal(signal))).gaps;
    },
  measurementDefinitions: async (schedulingClass: ApiReadSchedulingClass = "background") => (await requestV2("/measurement-definitions", fields({ definitions: arrayOf(measurementDefinitionShape) }), { schedulingClass })).definitions,
};
