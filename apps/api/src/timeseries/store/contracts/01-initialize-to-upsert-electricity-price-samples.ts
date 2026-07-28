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
  OpeningStateRecord,
  OutdoorTemperatureHistoryQuery,
  OutdoorTemperatureRecord,
  QueryControl,
  TelemetryHealth,
  TelemetrySchemaInitResult,
  TelemetryStorageStats,
  TelemetryStoreOptions,
  TelemetryTableStorage,
} from "../../types.js";
import { ContinuousAggregateRow, ExtensionRow, ProcedureFeatureRow, RelationKindRow, abortError, describeError, timestamp } from "../support/01-default-schema-to-measurement-bucket-from-row.js";
import "../core.js";

declare module "../core.js" {
  interface TimeseriesStoreInternals {
    initialize(control?: QueryControl): Promise<TelemetrySchemaInitResult>;
    invalidateInitialization(): void;
    __initialize(control: QueryControl): Promise<TelemetrySchemaInitResult>;
    __detectTimescaleFeatures(control: QueryControl): Promise<ProcedureFeatureRow>;
    __configureColdStorage(
        hypertables: readonly string[],
        features: ProcedureFeatureRow,
        warnings: string[],
        control: QueryControl,
      ): Promise<ColdStorageMode>;
    __configureContinuousAggregates(
        policyAvailable: boolean,
        warnings: string[],
        control: QueryControl,
      ): Promise<"continuous" | "view" | "unavailable">;
    __configureFallbackAggregates(
        warnings: string[],
        control: QueryControl,
        preserveContinuousAggregates?: boolean ,
      ): Promise<"continuous" | "view" | "unavailable">;
    __relationKind(relation: string, control: QueryControl): Promise<string | null>;
    __isContinuousAggregate(relation: string, control: QueryControl): Promise<boolean>;
    upsertMeasurementSamples(samples: readonly MeasurementSampleRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertLegacyReadings(readings: readonly LegacyReadingRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertOutdoorTemperatureSamples(samples: readonly OutdoorTemperatureRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertElectricityPriceSamples(samples: readonly ElectricityPriceRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertOpeningStateSamples(samples: readonly OpeningStateRecord[], control?: QueryControl): Promise<BatchWriteResult>;
  }

  interface TimeseriesStoreCore {
    initialize(control?: QueryControl): Promise<TelemetrySchemaInitResult>;
    invalidateInitialization(): void;
    upsertMeasurementSamples(samples: readonly MeasurementSampleRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertLegacyReadings(readings: readonly LegacyReadingRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertOutdoorTemperatureSamples(samples: readonly OutdoorTemperatureRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertElectricityPriceSamples(samples: readonly ElectricityPriceRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertOpeningStateSamples(samples: readonly OpeningStateRecord[], control?: QueryControl): Promise<BatchWriteResult>;
  }
}
