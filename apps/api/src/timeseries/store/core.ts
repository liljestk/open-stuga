import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  installRegisteredMethods,
  type AssertNoMethodKeys,
  type IncompatibleMethodKeys,
  type RegisteredMethodSet,
} from "../../method-registry.js";
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
} from "../schema.js";
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
  TelemetrySchemaInitResult,
  TelemetryStorageStats,
  TelemetryStoreOptions,
  TelemetryTableStorage,
} from "../types.js";
import { DEFAULT_BATCH_SIZE, DEFAULT_CONNECTION_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_POOL_SIZE, DEFAULT_SCHEMA, DEFAULT_STATEMENT_TIMEOUT_MS, positiveInteger, timeoutValue } from "./support/01-default-schema-to-measurement-bucket-from-row.js";

export const timeseriesStoreState = Symbol("TimeseriesStore.state");

export interface TimeseriesStoreState {
  ownsPool: boolean;
  closeInjectedPool: boolean;
  batchSize: number;
  defaultTimeoutMs: number;
  poolErrorListener: (error: Error) => void;
  closed: boolean;
  lastPoolError: Error | null;
  initializePromise: Promise<TelemetrySchemaInitResult> | null;
  queryMetrics: {
    active: number;
    started: number;
    succeeded: number;
    failed: number;
    totalDurationMs: number;
    maxDurationMs: number;
    poolAcquisitions: number;
    totalPoolWaitMs: number;
    maxPoolWaitMs: number;
  };
}

export function createTimeseriesStoreState(): TimeseriesStoreState {
  return {
    ownsPool: undefined as unknown as boolean,
    closeInjectedPool: undefined as unknown as boolean,
    batchSize: undefined as unknown as number,
    defaultTimeoutMs: undefined as unknown as number,
    poolErrorListener: undefined as unknown as (error: Error) => void,
    closed: false,
    lastPoolError: null,
    initializePromise: null,
    queryMetrics: {
      active: 0,
      started: 0,
      succeeded: 0,
      failed: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      poolAcquisitions: 0,
      totalPoolWaitMs: 0,
      maxPoolWaitMs: 0,
    },
  };
}

export interface TimeseriesStoreInternals {
  readonly [timeseriesStoreState]: TimeseriesStoreState;
  readonly schema: string;
  readonly pool: Pool;
}

export type TimeseriesStoreMethodSet = RegisteredMethodSet<TimeseriesStoreInternals>;

export class TimeseriesStoreCore {
  readonly schema: string;
  readonly pool: Pool;
  readonly [timeseriesStoreState] = createTimeseriesStoreState();
  constructor(options: TelemetryStoreOptions = {}) {
      const service = this as unknown as TimeseriesStoreInternals;

      this.schema = validateSchemaName(options.schema ?? DEFAULT_SCHEMA);
      this[timeseriesStoreState].batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE, 5_000);
      this[timeseriesStoreState].defaultTimeoutMs = timeoutValue(options.statementTimeoutMs, DEFAULT_STATEMENT_TIMEOUT_MS);
      this[timeseriesStoreState].ownsPool = options.pool === undefined;
      this[timeseriesStoreState].closeInjectedPool = options.closeInjectedPool ?? false;

      const max = positiveInteger(
        options.maxConnections ?? options.poolConfig?.max,
        DEFAULT_POOL_SIZE,
        100,
      );
      const connectionTimeoutMillis = timeoutValue(
        options.connectionTimeoutMs ?? (
          typeof options.poolConfig?.connectionTimeoutMillis === "number"
            ? options.poolConfig.connectionTimeoutMillis
            : undefined
        ),
        DEFAULT_CONNECTION_TIMEOUT_MS,
      );
      const idleTimeoutMillis = timeoutValue(
        options.idleTimeoutMs ?? (
          typeof options.poolConfig?.idleTimeoutMillis === "number" ? options.poolConfig.idleTimeoutMillis : undefined
        ),
        DEFAULT_IDLE_TIMEOUT_MS,
      );
      const statementTimeout = timeoutValue(
        options.statementTimeoutMs ?? (
          typeof options.poolConfig?.statement_timeout === "number" ? options.poolConfig.statement_timeout : undefined
        ),
        DEFAULT_STATEMENT_TIMEOUT_MS,
      );

      this.pool = options.pool ?? new Pool({
        ...options.poolConfig,
        ...(options.connectionString === undefined ? {} : { connectionString: options.connectionString }),
        max,
        connectionTimeoutMillis,
        idleTimeoutMillis,
        statement_timeout: statementTimeout,
        application_name: options.applicationName ?? "stugu-telemetry",
        allowExitOnIdle: options.poolConfig?.allowExitOnIdle ?? true,
        keepAlive: options.poolConfig?.keepAlive ?? true,
      });

      this[timeseriesStoreState].poolErrorListener = (error) => {
        this[timeseriesStoreState].lastPoolError = error;
        options.onPoolError?.(error);
      };
      this.pool.on("error", this[timeseriesStoreState].poolErrorListener);
    }
}

type TimeseriesStorePublicMethodMismatch = AssertNoMethodKeys<
  IncompatibleMethodKeys<TimeseriesStoreCore, TimeseriesStoreInternals>
>;

export function registerTimeseriesStoreMethods(methods: TimeseriesStoreMethodSet): void {
  installRegisteredMethods("TimeseriesStore", TimeseriesStoreCore.prototype, methods);
}
