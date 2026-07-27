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
  };
}

export interface TimeseriesStoreInternals {
  readonly [timeseriesStoreState]: TimeseriesStoreState;
  readonly schema: string;
  readonly pool: Pool;
}

export type TimeseriesStoreMethodSet = Record<string, unknown> & ThisType<TimeseriesStoreInternals>;

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

export function registerTimeseriesStoreMethods(methods: TimeseriesStoreMethodSet): void {
  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(TimeseriesStoreCore.prototype, name, {
      value: method, configurable: true, writable: true, enumerable: false,
    });
  }
}
