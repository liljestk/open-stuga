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
  PowerCostAggregateQuery,
  QueryControl,
  TelemetryHealth,
  TimeseriesQueryDiagnostics,
  TelemetrySchemaInitResult,
  TelemetryStorageStats,
  TelemetryStoreOptions,
  TelemetryTableStorage,
} from "../../types.js";
import { EnergyCostAggregateRow, ExtensionRow, HealthRow, QUERY_TAG_PREFIX, SqlValue, StorageRow, TimescaleStorageRow, abortError, describeError, timeoutValue, timestamp } from "../support/01-default-schema-to-measurement-bucket-from-row.js";
import "../core.js";

declare module "../core.js" {
  interface TimeseriesStoreInternals {
    energyCostAggregate(query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord>;
    powerCostAggregate(query: PowerCostAggregateQuery): Promise<EnergyCostAggregateRecord>;
    refreshMeasurementAggregates(query?: AggregateRefreshQuery): Promise<number>;
    health(control?: QueryControl): Promise<TelemetryHealth>;
    storageStats(control?: QueryControl): Promise<TelemetryStorageStats>;
    __poolHealth(): { total: number; idle: number; waiting: number };
    diagnostics(): TimeseriesQueryDiagnostics;
    close(): Promise<void>;
    __query<Row extends QueryResultRow = QueryResultRow>(
        sql: string,
        values?: readonly SqlValue[] ,
        control?: QueryControl ,
      ): Promise<QueryResult<Row>>;
    __runQuery<Row extends QueryResultRow>(
        sql: string,
        values: readonly SqlValue[],
        signal: AbortSignal | undefined,
      ): Promise<QueryResult<Row>>;
    __connect(signal: AbortSignal | undefined): Promise<PoolClient>;
    __cancelBackendQuery(client: PoolClient, token: string): Promise<void>;
  }

  interface TimeseriesStoreCore {
    energyCostAggregate(query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord>;
    powerCostAggregate(query: PowerCostAggregateQuery): Promise<EnergyCostAggregateRecord>;
    refreshMeasurementAggregates(query?: AggregateRefreshQuery): Promise<number>;
    health(control?: QueryControl): Promise<TelemetryHealth>;
    storageStats(control?: QueryControl): Promise<TelemetryStorageStats>;
    diagnostics(): TimeseriesQueryDiagnostics;
    close(): Promise<void>;
  }
}
