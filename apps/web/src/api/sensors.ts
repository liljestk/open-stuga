import type { ApiReadSchedulingClass } from "./support/requestScheduler";
import { type Sensor, type SensorLabelDescriptor, type SensorPatch, type SensorSnapshot, withSignal, type MeasurementDefinition, type SensorDataGap } from "@climate-twin/contracts";
import { list, request, requestV2 } from "./support/request";
import type { CreateSensorInput } from "./support/response-types";

/** Sensors, their snapshots, labels, mappings and data gaps, and the measurement registry. */
export const sensorsApi = {
  sensors: async (houseId?: string, schedulingClass: ApiReadSchedulingClass = "background") => list<Sensor>(await request<unknown>(
      houseId === undefined ? "/sensors" : `/sensors?houseId=${encodeURIComponent(houseId)}`, { schedulingClass },
    ), "sensors"),
  snapshot: async (houseId: string, schedulingClass: ApiReadSchedulingClass = "background") => list<SensorSnapshot>(await request<unknown>(`/sensors/snapshots?houseId=${encodeURIComponent(houseId)}`, { schedulingClass }), "sensors"),
  createSensor: async (sensor: CreateSensorInput) => (await request<{ sensor: Sensor }>("/sensors", {
      method: "POST",
      body: JSON.stringify(sensor),
    })).sensor,
  updateSensor: async (sensorId: string, sensor: SensorPatch) => (await request<{ sensor: Sensor }>(`/sensors/${encodeURIComponent(sensorId)}`, {
      method: "PATCH",
      body: JSON.stringify(sensor),
    })).sensor,
  deleteSensor: (sensorId: string) => request<void>(`/sensors/${encodeURIComponent(sensorId)}`, { method: "DELETE" }),
  sensorLabel: async (sensorId: string) => (await request<{ label: SensorLabelDescriptor }>(`/sensors/${encodeURIComponent(sensorId)}/label`)).label,
  bulkSensorMappings: (houseId: string, mappings: Array<{ sensorId: string; measurementEntityIds: Record<string, string> }>) => request<{ sensors: Sensor[] }>("/setup/bulk-sensor-mappings", {
      method: "POST",
      body: JSON.stringify({ houseId, mappings }),
    }),
  sensorDataGaps: async (houseId?: string, limit = 500, signal?: AbortSignal): Promise<SensorDataGap[]> => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (houseId) query.set("houseId", houseId);
      return list<SensorDataGap>(
        await request<unknown>(`/integrations/sensor-data-gaps?${query}`, withSignal(signal)),
        "gaps",
      );
    },
  measurementDefinitions: async (schedulingClass: ApiReadSchedulingClass = "background") => (await requestV2<{ definitions: MeasurementDefinition[] }>("/measurement-definitions", { schedulingClass })).definitions,
};
