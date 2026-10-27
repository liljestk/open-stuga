import {
  TELEMETRY_TABLES,
} from "../../schema.js";
import type {
  ArchiveCheckpoint,
  ArchiveTableName,
  BatchWriteResult,
  ElectricityPriceHistoryQuery,
  ElectricityPriceRecord,
  HeatPumpStateHistoryQuery,
  HeatPumpStateRecord,
  LegacyReadingHistoryQuery,
  LegacyReadingRecord,
  MeasurementBucketQuery,
  MeasurementBucketRecord,
  MeasurementCoverageQuery,
  MeasurementCoverageRecord,
  MeasurementGapQuery,
  MeasurementGapRecord,
  MeasurementHistoryBucketedQuery,
  MeasurementHistoryQuery,
  MeasurementSampleRecord,
  MeasurementWindowQuery,
  ThermalMeasurementHistoryQuery,
  OpeningStateHistoryQuery,
  OpeningStateRecord,
  OpeningStateSnapshotQuery,
  OutdoorTemperatureHistoryQuery,
  OutdoorTemperatureRecord,
  QueryControl,
} from "../../types.js";
import { LatestLegacyReadingFilter, LatestMeasurementFilter, SqlValue } from "../support/01-default-schema-to-measurement-bucket-from-row.js";
import "../core.js";

declare module "../core.js" {
  interface TimeseriesStoreInternals {
    __writeBatches<T>(
        table: (typeof TELEMETRY_TABLES)[number],
        columns: readonly string[],
        conflictColumns: readonly string[],
        updateColumns: readonly string[],
        records: readonly T[],
        valuesFor: (record: T) => readonly SqlValue[],
        control: QueryControl,
        markOrderedRollups?: boolean,
      ): Promise<BatchWriteResult>;
    getArchiveCheckpoint(sourceId: string, tableName: ArchiveTableName, control?: QueryControl): Promise<ArchiveCheckpoint | null>;
    archiveCheckpoint(sourceId: string, tableName: ArchiveTableName, control?: QueryControl): Promise<number>;
    setArchiveCheckpoint(sourceId: string, tableName: ArchiveTableName, lastRowId: number, control?: QueryControl): Promise<ArchiveCheckpoint>;
    saveArchiveCheckpoint(sourceId: string, tableName: ArchiveTableName, lastRowId: number, control?: QueryControl): Promise<void>;
    deleteTelemetrySources(sources: readonly string[], control?: QueryControl): Promise<number>;
    enforceRealDataBoundary(sourceId: string, activatedAt: string, control?: QueryControl): Promise<number>;
    latestMeasurementSample(sensorId: string, metric: string, control?: QueryControl): Promise<MeasurementSampleRecord | null>;
    latestMeasurementSamples(filter?: LatestMeasurementFilter): Promise<MeasurementSampleRecord[]>;
    measurementHistory(query: MeasurementHistoryQuery): Promise<MeasurementSampleRecord[]>;
    measurementHistoryBucketed(query: MeasurementHistoryBucketedQuery): Promise<MeasurementSampleRecord[]>;
    measurementSampleGaps(query: MeasurementGapQuery): Promise<MeasurementGapRecord[]>;
    thermalMeasurementHistory(query: ThermalMeasurementHistoryQuery): Promise<MeasurementSampleRecord[]>;
    measurementWindow(query: MeasurementWindowQuery): Promise<MeasurementSampleRecord[]>;
    measurementCoverage(query: MeasurementCoverageQuery): Promise<MeasurementCoverageRecord[]>;
    measurementBuckets(query: MeasurementBucketQuery): Promise<MeasurementBucketRecord[]>;
    latestLegacyReadings(filter?: LatestLegacyReadingFilter): Promise<LegacyReadingRecord[]>;
    legacyReadingHistory(query: LegacyReadingHistoryQuery): Promise<LegacyReadingRecord[]>;
    outdoorTemperatureHistory(query: OutdoorTemperatureHistoryQuery): Promise<OutdoorTemperatureRecord[]>;
    electricityPriceHistory(query: ElectricityPriceHistoryQuery): Promise<ElectricityPriceRecord[]>;
    openingStateHistory(query: OpeningStateHistoryQuery): Promise<OpeningStateRecord[]>;
    openingStateSnapshot(query: OpeningStateSnapshotQuery): Promise<OpeningStateRecord[]>;
    heatPumpStateHistory(query: HeatPumpStateHistoryQuery): Promise<HeatPumpStateRecord[]>;
  }

  interface TimeseriesStoreCore {
    getArchiveCheckpoint(sourceId: string, tableName: ArchiveTableName, control?: QueryControl): Promise<ArchiveCheckpoint | null>;
    archiveCheckpoint(sourceId: string, tableName: ArchiveTableName, control?: QueryControl): Promise<number>;
    setArchiveCheckpoint(sourceId: string, tableName: ArchiveTableName, lastRowId: number, control?: QueryControl): Promise<ArchiveCheckpoint>;
    saveArchiveCheckpoint(sourceId: string, tableName: ArchiveTableName, lastRowId: number, control?: QueryControl): Promise<void>;
    deleteTelemetrySources(sources: readonly string[], control?: QueryControl): Promise<number>;
    enforceRealDataBoundary(sourceId: string, activatedAt: string, control?: QueryControl): Promise<number>;
    latestMeasurementSample(sensorId: string, metric: string, control?: QueryControl): Promise<MeasurementSampleRecord | null>;
    latestMeasurementSamples(filter?: LatestMeasurementFilter): Promise<MeasurementSampleRecord[]>;
    measurementHistory(query: MeasurementHistoryQuery): Promise<MeasurementSampleRecord[]>;
    measurementHistoryBucketed(query: MeasurementHistoryBucketedQuery): Promise<MeasurementSampleRecord[]>;
    measurementSampleGaps(query: MeasurementGapQuery): Promise<MeasurementGapRecord[]>;
    thermalMeasurementHistory(query: ThermalMeasurementHistoryQuery): Promise<MeasurementSampleRecord[]>;
    measurementWindow(query: MeasurementWindowQuery): Promise<MeasurementSampleRecord[]>;
    measurementCoverage(query: MeasurementCoverageQuery): Promise<MeasurementCoverageRecord[]>;
    measurementBuckets(query: MeasurementBucketQuery): Promise<MeasurementBucketRecord[]>;
    latestLegacyReadings(filter?: LatestLegacyReadingFilter): Promise<LegacyReadingRecord[]>;
    legacyReadingHistory(query: LegacyReadingHistoryQuery): Promise<LegacyReadingRecord[]>;
    outdoorTemperatureHistory(query: OutdoorTemperatureHistoryQuery): Promise<OutdoorTemperatureRecord[]>;
    electricityPriceHistory(query: ElectricityPriceHistoryQuery): Promise<ElectricityPriceRecord[]>;
    openingStateHistory(query: OpeningStateHistoryQuery): Promise<OpeningStateRecord[]>;
    openingStateSnapshot(query: OpeningStateSnapshotQuery): Promise<OpeningStateRecord[]>;
    heatPumpStateHistory(query: HeatPumpStateHistoryQuery): Promise<HeatPumpStateRecord[]>;
  }
}
