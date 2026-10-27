import type {
  Sensor,
} from "@climate-twin/contracts";
import { SensorRow } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { SensorUpdate } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    listSensors(houseId?: string): Sensor[];
    detachTpLinkConnection(connectionId: string, unscopedHouseId?: string): string[];
    reassignTpLinkSensors(houseId: string, assignments: Array<{
            sensorId: string;
            fromConnectionId: string | null;
            toConnectionId: string | null;
        }>): Sensor[];
    getSensor(id: string): Sensor | null;
    sensorWithMeasurementBindings(row: SensorRow): Sensor;
    createSensor(input: Omit<Sensor, "id"> & {
            id?: string;
        }): Sensor;
    updateSensor(id: string, patch: SensorUpdate): Sensor | null;
    bulkUpdateSensorBindings(houseId: string, mappings: Array<{
            sensorId: string;
            measurementEntityIds: Record<string, string>;
        }>): Sensor[];
  }

  interface ClimateDatabaseCore {
    listSensors(houseId?: string): Sensor[];
    detachTpLinkConnection(connectionId: string, unscopedHouseId?: string): string[];
    reassignTpLinkSensors(houseId: string, assignments: Array<{
            sensorId: string;
            fromConnectionId: string | null;
            toConnectionId: string | null;
        }>): Sensor[];
    getSensor(id: string): Sensor | null;
    createSensor(input: Omit<Sensor, "id"> & {
            id?: string;
        }): Sensor;
    updateSensor(id: string, patch: SensorUpdate): Sensor | null;
    bulkUpdateSensorBindings(houseId: string, mappings: Array<{
            sensorId: string;
            measurementEntityIds: Record<string, string>;
        }>): Sensor[];
  }
}
