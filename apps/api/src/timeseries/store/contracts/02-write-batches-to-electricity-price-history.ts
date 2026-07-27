import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  HYPERTABLE_DEFINITIONS,
  MEASUREMENT_BUCKETS,
  TELEMETRY_TABLES,
  buildBaseSchemaSql,
  buildContinuousAggregateSql,
  buildFallbackAggregateSql,
  measurementAggregateName,
  qualifiedName,
  quoteIdentifier,
  validateSchemaName,
} from "../../schema.js";
import type {
  AggregateRefreshQuery,
  ArchiveCheckpoint,
  ArchiveTableName,
  BatchWriteResult,
  ColdStorageMode,
  EnergyCostAggregateQuery,
  EnergyCostAggregateRecord,
  ElectricityPriceHistoryQuery,
  ElectricityPriceRecord,
  LegacyReadingHistoryQuery,
  LegacyReadingRecord,
  MeasurementBucketQuery,
  MeasurementBucketRecord,
  MeasurementCoverageQuery,
  MeasurementCoverageRecord,
  MeasurementHistoryQuery,
  MeasurementSampleRecord,
  MeasurementWindowQuery,
  OutdoorTemperatureHistoryQuery,
  OutdoorTemperatureRecord,
  QueryControl,
  TelemetryHealth,
  TelemetrySchemaInitResult,
  TelemetryStorageStats,
  TelemetryStoreOptions,
  TelemetryTableStorage,
} from "../../types.js";
import { ArchiveCheckpointRow, ElectricityPriceRow, LatestLegacyReadingFilter, LatestMeasurementFilter, LegacyReadingRow, MAX_HISTORY_LIMIT, MAX_MEASUREMENT_WINDOW_LIMIT, MeasurementBucketRow, MeasurementCoverageRow, MeasurementRow, OutdoorTemperatureRow, SqlValue, electricityPriceFromRow, legacyReadingFromRow, measurementBucketFromRow, measurementFromRow, outdoorTemperatureFromRow, positiveInteger, timestamp } from "../support/01-default-schema-to-measurement-bucket-from-row.js";
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
    measurementWindow(query: MeasurementWindowQuery): Promise<MeasurementSampleRecord[]>;
    measurementCoverage(query: MeasurementCoverageQuery): Promise<MeasurementCoverageRecord[]>;
    measurementBuckets(query: MeasurementBucketQuery): Promise<MeasurementBucketRecord[]>;
    latestLegacyReadings(filter?: LatestLegacyReadingFilter): Promise<LegacyReadingRecord[]>;
    legacyReadingHistory(query: LegacyReadingHistoryQuery): Promise<LegacyReadingRecord[]>;
    outdoorTemperatureHistory(query: OutdoorTemperatureHistoryQuery): Promise<OutdoorTemperatureRecord[]>;
    electricityPriceHistory(query: ElectricityPriceHistoryQuery): Promise<ElectricityPriceRecord[]>;
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
    measurementWindow(query: MeasurementWindowQuery): Promise<MeasurementSampleRecord[]>;
    measurementCoverage(query: MeasurementCoverageQuery): Promise<MeasurementCoverageRecord[]>;
    measurementBuckets(query: MeasurementBucketQuery): Promise<MeasurementBucketRecord[]>;
    latestLegacyReadings(filter?: LatestLegacyReadingFilter): Promise<LegacyReadingRecord[]>;
    legacyReadingHistory(query: LegacyReadingHistoryQuery): Promise<LegacyReadingRecord[]>;
    outdoorTemperatureHistory(query: OutdoorTemperatureHistoryQuery): Promise<OutdoorTemperatureRecord[]>;
    electricityPriceHistory(query: ElectricityPriceHistoryQuery): Promise<ElectricityPriceRecord[]>;
  }
}
