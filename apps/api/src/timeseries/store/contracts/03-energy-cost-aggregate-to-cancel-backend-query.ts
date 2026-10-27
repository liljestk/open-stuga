import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import type {
  AggregateRefreshQuery,
  EnergyCostAggregateQuery,
  EnergyCostAggregateRecord,
  PowerCostAggregateQuery,
  QueryControl,
  TelemetryHealth,
  TimeseriesQueryDiagnostics,
  TelemetryStorageStats,
} from "../../types.js";
import { SqlValue } from "../support/01-default-schema-to-measurement-bucket-from-row.js";
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
