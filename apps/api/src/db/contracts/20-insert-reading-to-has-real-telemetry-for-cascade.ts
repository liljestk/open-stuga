import type {
  MeasurementSample,
  OutdoorTemperatureSample,
  Reading,
} from "@climate-twin/contracts";
import { ElectricityPriceArchiveRecord, OpeningStateArchiveRecord, TelemetryArchiveDirtyRow, TelemetryArchiveMutableTable, TelemetryArchiveRow, TelemetryCascadeScope } from "../support/01-json-value-to-area-equipment-row.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    insertReading(reading: Reading, enqueueAlertEvaluation?: boolean): boolean;
    insertLegacyReading(reading: Reading): boolean;
    upsertLegacyReading(reading: Reading): boolean;
    insertLegacyReadingUnchecked(reading: Reading): boolean;
    insertReadings(readings: Reading[], options?: { enqueueAlertEvaluation?: boolean }): Reading[];
    latestReadings(sensorIds?: string[]): Reading[];
    getLatestReading(sensorId: string): Reading | null;
    history(sensorIds: string[], from: string, to: string, limit?: number): Reading[];
    historyBucketed(sensorIds: string[], from: string, to: string, bucketSeconds: number, limit?: number): Reading[];
    measurementArchivePage(afterRowId: number, limit: number): TelemetryArchiveRow<MeasurementSample>[];
    readingArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<Reading>[];
    outdoorTemperatureArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<OutdoorTemperatureSample>[];
    electricityPriceArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<ElectricityPriceArchiveRecord>[];
    openingStateArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<OpeningStateArchiveRecord>[];
    readingArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<Reading>[];
    outdoorTemperatureArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<OutdoorTemperatureSample>[];
    electricityPriceArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<ElectricityPriceArchiveRecord>[];
    acknowledgeTelemetryArchiveDirtyRows(table: TelemetryArchiveMutableTable, rows: Array<{
            dirtyId: number;
            version: number;
        }>): number;
    telemetryArchiveStateToken(): string;
    hasRealTelemetryForCascade(scope: TelemetryCascadeScope, resourceId: string): boolean;
  }

  interface ClimateDatabaseCore {
    insertLegacyReading(reading: Reading): boolean;
    upsertLegacyReading(reading: Reading): boolean;
    insertReadings(readings: Reading[], options?: { enqueueAlertEvaluation?: boolean }): Reading[];
    latestReadings(sensorIds?: string[]): Reading[];
    getLatestReading(sensorId: string): Reading | null;
    history(sensorIds: string[], from: string, to: string, limit?: number): Reading[];
    historyBucketed(sensorIds: string[], from: string, to: string, bucketSeconds: number, limit?: number): Reading[];
    measurementArchivePage(afterRowId: number, limit: number): TelemetryArchiveRow<MeasurementSample>[];
    readingArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<Reading>[];
    outdoorTemperatureArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<OutdoorTemperatureSample>[];
    electricityPriceArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<ElectricityPriceArchiveRecord>[];
    openingStateArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<OpeningStateArchiveRecord>[];
    readingArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<Reading>[];
    outdoorTemperatureArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<OutdoorTemperatureSample>[];
    electricityPriceArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<ElectricityPriceArchiveRecord>[];
    acknowledgeTelemetryArchiveDirtyRows(table: TelemetryArchiveMutableTable, rows: Array<{
            dirtyId: number;
            version: number;
        }>): number;
    telemetryArchiveStateToken(): string;
    hasRealTelemetryForCascade(scope: TelemetryCascadeScope, resourceId: string): boolean;
  }
}
