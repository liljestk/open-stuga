import type { Floor, MeasurementDefinition, MeasurementSample, Sensor, SensorDataGapSource } from "@climate-twin/contracts";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    validateHouseLayoutForObservations(houseId: string, floors: Floor[]): void;
    validateSensorPlacement(sensor: Sensor): void;
    normalizeSensorRoom(
        sensor: Sensor,
        options: { roomIdProvided: boolean; roomProvided: boolean; resolveLegacyLabel: boolean },
      ): Sensor;
    validateTpLinkDeviceBinding(sensor: Sensor): void;
    writeSensor(sensor: Sensor, insert: boolean): void;
    deleteSensor(id: string): boolean;
    listMeasurementDefinitions(includeDisabled?: boolean): MeasurementDefinition[];
    getMeasurementDefinition(id: string): MeasurementDefinition | null;
    createMeasurementDefinition(definition: MeasurementDefinition): MeasurementDefinition;
    updateMeasurementDefinition(id: string, patch: Partial<Omit<MeasurementDefinition, "id" | "builtin">>): MeasurementDefinition | null;
    disableMeasurementDefinition(id: string): MeasurementDefinition | null;
    insertMeasurementSample(
        sample: MeasurementSample,
        deduplicateAcrossSources?: boolean,
        enqueueAlertEvaluation?: boolean,
        deferDerivedInvalidation?: boolean,
      ): boolean;
    insertMeasurementSamples(samples: MeasurementSample[], options?: {
            deduplicateAcrossSources?: boolean;
            enqueueAlertEvaluation?: boolean;
        }): MeasurementSample[];
    latestMeasurementSamples(houseId?: string): MeasurementSample[];
    getLatestMeasurementSample(sensorId: string, metric: string): MeasurementSample | null;
    measurementSampleAtOrBefore(sensorId: string, metric: string, source: SensorDataGapSource, timestamp: string): MeasurementSample | null;
    measurementHistory(sensorId: string, metric: string, from: string, to: string, limit?: number,
      before?: { timestamp: string; source: string }): MeasurementSample[];
  }

  interface ClimateDatabaseCore {
    deleteSensor(id: string): boolean;
    listMeasurementDefinitions(includeDisabled?: boolean): MeasurementDefinition[];
    getMeasurementDefinition(id: string): MeasurementDefinition | null;
    createMeasurementDefinition(definition: MeasurementDefinition): MeasurementDefinition;
    updateMeasurementDefinition(id: string, patch: Partial<Omit<MeasurementDefinition, "id" | "builtin">>): MeasurementDefinition | null;
    disableMeasurementDefinition(id: string): MeasurementDefinition | null;
    insertMeasurementSamples(samples: MeasurementSample[], options?: {
            deduplicateAcrossSources?: boolean;
            enqueueAlertEvaluation?: boolean;
        }): MeasurementSample[];
    latestMeasurementSamples(houseId?: string): MeasurementSample[];
    getLatestMeasurementSample(sensorId: string, metric: string): MeasurementSample | null;
    measurementSampleAtOrBefore(sensorId: string, metric: string, source: SensorDataGapSource, timestamp: string): MeasurementSample | null;
    measurementHistory(sensorId: string, metric: string, from: string, to: string, limit?: number,
      before?: { timestamp: string; source: string }): MeasurementSample[];
  }
}
