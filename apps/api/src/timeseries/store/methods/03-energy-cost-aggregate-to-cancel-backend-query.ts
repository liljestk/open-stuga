import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  HYPERTABLE_DEFINITIONS,
  MEASUREMENT_ANALYTICS_BUCKETS,
  MEASUREMENT_BUCKETS,
  TELEMETRY_TABLES,
  buildBaseSchemaSql,
  buildContinuousAggregateSql,
  buildFallbackAggregateSql,
  measurementAnalyticsAggregateName,
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
  TelemetrySchemaInitResult,
  TelemetryStorageStats,
  TelemetryStoreOptions,
  TelemetryTableStorage,
} from "../../types.js";
import { RollupsMaterializingError } from "../../read-support.js";
import { EnergyCostAggregateRow, ExtensionRow, HealthRow, QUERY_TAG_PREFIX, SqlValue, StorageRow, TimescaleStorageRow, abortError, describeError, timeoutValue, timestamp } from "../support/01-default-schema-to-measurement-bucket-from-row.js";
import { registerTimeseriesStoreMethods, timeseriesStoreState, type TimeseriesStoreInternals } from "../core.js";
import {
  measurementCostRollupRequirementsSql,
  measurementCostRollupSql,
} from "../measurement-cost-rollup-sql.js";

interface CostRollupRequirementRow extends QueryResultRow {
  day_start: string | Date;
  bucket_seconds: string | number;
  ready: boolean;
}

function postgresErrorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : null;
}

async function refreshContinuousAggregate(
  store: TimeseriesStoreInternals,
  aggregate: string,
  query: AggregateRefreshQuery,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await store.__query(
        "CALL refresh_continuous_aggregate($1::REGCLASS, $2::TIMESTAMPTZ, $3::TIMESTAMPTZ)",
        [qualifiedName(store.schema, aggregate), query.from ?? null, query.to ?? null],
        query,
      );
      return;
    } catch (error) {
      if (postgresErrorCode(error) !== "55P03" || attempt >= 6) throw error;
      await new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          query.signal?.removeEventListener("abort", cancel);
          resolve();
        };
        const cancel = (): void => {
          clearTimeout(timer);
          reject(abortError(query.signal!));
        };
        const timer = setTimeout(finish, Math.min(2_000, 100 * 2 ** attempt));
        timer.unref();
        query.signal?.addEventListener("abort", cancel, { once: true });
      });
    }
  }
}

async function orderedCostAggregate(
  store: TimeseriesStoreInternals,
  query: EnergyCostAggregateQuery,
  metric: "energy" | "power",
): Promise<EnergyCostAggregateRecord> {
  const series = [{
    sensorId: query.sensorId,
    metric,
    aggregation: metric === "energy" ? "delta" as const : "time_weighted_mean" as const,
  }];
  const parameters = [
    query.sensorId, query.from, query.to, query.propertyId, Boolean(query.excludeSynthetic),
  ];
  const requirements = await store.__query<CostRollupRequirementRow>(
    measurementCostRollupRequirementsSql(store.schema),
    [...parameters, metric],
    query,
  );
  const byBucket = new Map<60 | 900 | 3600, string[]>();
  for (const row of requirements.rows) {
    const bucketSeconds = Number(row.bucket_seconds);
    if (bucketSeconds !== 60 && bucketSeconds !== 900 && bucketSeconds !== 3600) {
      throw new Error("Telemetry cost planner returned an invalid ordered-state resolution");
    }
    const days = byBucket.get(bucketSeconds) ?? [];
    days.push(new Date(row.day_start).toISOString());
    byBucket.set(bucketSeconds, days);
  }
  for (const bucketSeconds of [3600, 900, 60] as const) {
    const days = byBucket.get(bucketSeconds);
    if (!days?.length) continue;
    await store.enqueueMeasurementOrderedRollups(
      series,
      query.from,
      query.to,
      3,
      query.excludeSynthetic === true ? "real" : "all",
      bucketSeconds,
      query,
      days,
    );
  }
  // Do not run the full pricing join just to discover known unfinished work.
  if (requirements.rows.some((row) => row.ready === false)) throw new RollupsMaterializingError();
  const result = await store.__query<EnergyCostAggregateRow>(
    measurementCostRollupSql(store.schema, metric),
    [...parameters, metric],
    query,
  );
  const row = result.rows[0];
  if (!row || row.coverage_complete !== true) {
    throw new RollupsMaterializingError();
  }
  return {
    deltaCount: Number(row.delta_count ?? 0),
    consumptionKwh: Number(row.consumption_kwh ?? 0),
    pricedConsumptionKwh: Number(row.priced_consumption_kwh ?? 0),
    costEur: Number(row.cost_eur ?? 0),
    totalDurationMs: Number(row.total_duration_ms ?? 0),
    pricedDurationMs: Number(row.priced_duration_ms ?? 0),
    maximumIntervalDurationMs: Number(row.maximum_interval_duration_ms ?? 0),
    coverageFrom: row.coverage_from === null ? null : timestamp(row.coverage_from),
    coverageUntil: row.coverage_until === null ? null : timestamp(row.coverage_until),
  };
}

registerTimeseriesStoreMethods({
  async energyCostAggregate(
    this: TimeseriesStoreInternals,
    query: EnergyCostAggregateQuery,
  ): Promise<EnergyCostAggregateRecord> {
      return this[timeseriesStoreState].costWorkLimiter.run(
        "energy-cost-rollup",
        () => orderedCostAggregate(this, query, "energy"),
        query.signal,
      );
    },
  async powerCostAggregate(
    this: TimeseriesStoreInternals,
    query: PowerCostAggregateQuery,
  ): Promise<EnergyCostAggregateRecord> {
      return this[timeseriesStoreState].costWorkLimiter.run(
        "power-cost-rollup",
        () => orderedCostAggregate(this, query, "power"),
        query.signal,
      );
    },
  /** Refreshes mergeable Timescale rollups after a historical import. */
  async refreshMeasurementAggregates(this: TimeseriesStoreInternals, query: AggregateRefreshQuery = {}): Promise<number> {
      const extension = await this.__query<ExtensionRow>(`SELECT (
        SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'
      ) AS timescale_version`, [], query);
      if (!extension.rows[0]?.timescale_version) return 0;

      let refreshed = 0;
      for (const bucket of Object.keys(MEASUREMENT_BUCKETS) as Array<keyof typeof MEASUREMENT_BUCKETS>) {
        const aggregate = measurementAggregateName(bucket);
        if (!await this.__isContinuousAggregate(aggregate, query)) continue;
        await refreshContinuousAggregate(this, aggregate, query);
        refreshed += 1;
      }
      for (const bucket of Object.keys(MEASUREMENT_ANALYTICS_BUCKETS) as Array<keyof typeof MEASUREMENT_ANALYTICS_BUCKETS>) {
        const aggregate = measurementAnalyticsAggregateName(bucket);
        if (!await this.__isContinuousAggregate(aggregate, query)) continue;
        await refreshContinuousAggregate(this, aggregate, query);
        refreshed += 1;
      }
      return refreshed;
    },
  async health(this: TimeseriesStoreInternals, control: QueryControl = {}): Promise<TelemetryHealth> {
      const startedAt = performance.now();
      try {
        const result = await this.__query<HealthRow>(`SELECT
          current_database() AS database_name,
          pg_database_size(current_database())::BIGINT AS database_size_bytes,
          (SELECT extversion FROM pg_extension WHERE extname = 'timescaledb') AS timescale_version`, [], control);
        const row = result.rows[0];
        return {
          ok: row !== undefined,
          checkedAt: new Date().toISOString(),
          latencyMs: Math.max(0, performance.now() - startedAt),
          database: row?.database_name ?? null,
          databaseSizeBytes: row ? Number(row.database_size_bytes) : null,
          timescaleAvailable: row?.timescale_version != null,
          timescaleVersion: row?.timescale_version ?? null,
          pool: this.__poolHealth(),
          lastPoolError: this[timeseriesStoreState].lastPoolError ? describeError(this[timeseriesStoreState].lastPoolError) : null,
        };
      } catch (error) {
        if (control.signal?.aborted) throw abortError(control.signal);
        return {
          ok: false,
          checkedAt: new Date().toISOString(),
          latencyMs: Math.max(0, performance.now() - startedAt),
          database: null,
          databaseSizeBytes: null,
          timescaleAvailable: false,
          timescaleVersion: null,
          pool: this.__poolHealth(),
          lastPoolError: this[timeseriesStoreState].lastPoolError ? describeError(this[timeseriesStoreState].lastPoolError) : null,
          error: describeError(error),
        };
      }
    },
  async storageStats(this: TimeseriesStoreInternals, control: QueryControl = {}): Promise<TelemetryStorageStats> {
      const result = await this.__query<StorageRow>(`SELECT
          c.relname AS table_name,
          COALESCE(s.n_live_tup, 0)::BIGINT AS estimated_rows,
          pg_total_relation_size(c.oid)::BIGINT AS total_bytes,
          pg_relation_size(c.oid)::BIGINT AS table_bytes,
          pg_indexes_size(c.oid)::BIGINT AS index_bytes
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
        WHERE n.nspname = $1 AND c.relname = ANY($2::TEXT[])
        ORDER BY c.relname`, [this.schema, TELEMETRY_TABLES], control);
      const byTable = new Map<string, TelemetryTableStorage>();
      for (const row of result.rows) {
        if (!TELEMETRY_TABLES.includes(row.table_name as (typeof TELEMETRY_TABLES)[number])) continue;
        byTable.set(row.table_name, {
          table: row.table_name as TelemetryTableStorage["table"],
          estimatedRows: Number(row.estimated_rows),
          totalBytes: Number(row.total_bytes),
          tableBytes: Number(row.table_bytes),
          indexBytes: Number(row.index_bytes),
        });
      }

      try {
        const timescale = await this.__query<TimescaleStorageRow>(`SELECT
            h.hypertable_name AS table_name,
            size.total_bytes::BIGINT AS total_bytes,
            size.table_bytes::BIGINT AS table_bytes,
            size.index_bytes::BIGINT AS index_bytes
          FROM timescaledb_information.hypertables h
          CROSS JOIN LATERAL hypertable_detailed_size(
            format('%I.%I', h.hypertable_schema, h.hypertable_name)::REGCLASS
          ) size
          WHERE h.hypertable_schema = $1 AND h.hypertable_name = ANY($2::TEXT[])`, [this.schema, TELEMETRY_TABLES], control);
        for (const row of timescale.rows) {
          const current = byTable.get(row.table_name);
          if (!current) continue;
          current.totalBytes = Number(row.total_bytes);
          current.tableBytes = Number(row.table_bytes);
          current.indexBytes = Number(row.index_bytes);
        }
      } catch (error) {
        if (control.signal?.aborted) throw abortError(control.signal);
        // Plain PostgreSQL has no Timescale information schema; base sizes remain valid.
      }

      const database = await this.__query<{ database_size_bytes: string | number }>(
        "SELECT pg_database_size(current_database())::BIGINT AS database_size_bytes",
        [],
        control,
      );
      return {
        capturedAt: new Date().toISOString(),
        databaseSizeBytes: Number(database.rows[0]?.database_size_bytes ?? 0),
        tables: TELEMETRY_TABLES.map((table) => byTable.get(table) ?? {
          table,
          estimatedRows: 0,
          totalBytes: 0,
          tableBytes: 0,
          indexBytes: 0,
        }),
      };
    },
  __poolHealth(this: TimeseriesStoreInternals): { total: number; idle: number; waiting: number } {
      return {
        total: this.pool.totalCount,
        idle: this.pool.idleCount,
        waiting: this.pool.waitingCount,
      };
    },
  diagnostics(this: TimeseriesStoreInternals) {
      const metrics = this[timeseriesStoreState].queryMetrics;
      const completed = metrics.succeeded + metrics.failed;
      return {
        active: metrics.active,
        started: metrics.started,
        succeeded: metrics.succeeded,
        failed: metrics.failed,
        averageDurationMs: completed === 0 ? 0 : metrics.totalDurationMs / completed,
        maxDurationMs: metrics.maxDurationMs,
        averagePoolWaitMs: metrics.poolAcquisitions === 0
          ? 0
          : metrics.totalPoolWaitMs / metrics.poolAcquisitions,
        maxPoolWaitMs: metrics.maxPoolWaitMs,
      };
    },
  async close(this: TimeseriesStoreInternals): Promise<void> {
      if (this[timeseriesStoreState].closed) return;
      this[timeseriesStoreState].closed = true;
      this.pool.off("error", this[timeseriesStoreState].poolErrorListener);
      if (this[timeseriesStoreState].ownsPool || this[timeseriesStoreState].closeInjectedPool) await this.pool.end();
    },
  async __query<Row extends QueryResultRow = QueryResultRow>(this: TimeseriesStoreInternals,
      sql: string,
      values: readonly SqlValue[] = [],
      control: QueryControl = {},
    ): Promise<QueryResult<Row>> {
      if (this[timeseriesStoreState].closed) throw new Error("TimeseriesStore is closed");
      const timeoutMs = timeoutValue(control.timeoutMs, this[timeseriesStoreState].defaultTimeoutMs);
      const timeoutController = timeoutMs > 0 ? new AbortController() : null;
      const timeout = timeoutController
        ? setTimeout(() => timeoutController.abort(new DOMException(
          `Telemetry query timed out after ${timeoutMs}ms`,
          "TimeoutError",
        )), timeoutMs)
        : null;
      timeout?.unref();
      const signal = control.signal && timeoutController
        ? AbortSignal.any([control.signal, timeoutController.signal])
        : control.signal ?? timeoutController?.signal;

      const metrics = this[timeseriesStoreState].queryMetrics;
      const startedAt = performance.now();
      metrics.active += 1;
      metrics.started += 1;
      try {
        const result = await this.__runQuery<Row>(sql, values, signal);
        metrics.succeeded += 1;
        return result;
      } catch (error) {
        metrics.failed += 1;
        throw error;
      } finally {
        const durationMs = Math.max(0, performance.now() - startedAt);
        metrics.active -= 1;
        metrics.totalDurationMs += durationMs;
        metrics.maxDurationMs = Math.max(metrics.maxDurationMs, durationMs);
        if (timeout) clearTimeout(timeout);
      }
    },
  async __runQuery<Row extends QueryResultRow>(this: TimeseriesStoreInternals,
      sql: string,
      values: readonly SqlValue[],
      signal: AbortSignal | undefined,
    ): Promise<QueryResult<Row>> {
      if (signal?.aborted) throw abortError(signal);
      const client = await this.__connect(signal);
      if (signal?.aborted) {
        client.release();
        throw abortError(signal);
      }

      const token = randomUUID();
      const taggedSql = `${sql}\n/* ${QUERY_TAG_PREFIX}${token} */`;
      let settled = false;
      let releaseDeferred = false;
      let abortListener: (() => void) | null = null;
      const rawQuery = client.query<Row>({ text: taggedSql, values: [...values] });
      const query = rawQuery.then(
        (result) => {
          settled = true;
          return result;
        },
        (error: unknown) => {
          settled = true;
          throw error;
        },
      );

      const raced = signal
        ? Promise.race([
          query,
          new Promise<never>((_resolve, reject) => {
            abortListener = () => {
              void this.__cancelBackendQuery(client, token);
              reject(abortError(signal));
            };
            signal.addEventListener("abort", abortListener, { once: true });
          }),
        ])
        : query;

      try {
        return await raced;
      } catch (error) {
        if (signal?.aborted && !settled) {
          releaseDeferred = true;
          void query.then(
            () => client.release(),
            () => client.release(),
          );
          throw abortError(signal);
        }
        throw error;
      } finally {
        if (abortListener && signal) signal.removeEventListener("abort", abortListener);
        if (!releaseDeferred) client.release();
      }
    },
  async __connect(this: TimeseriesStoreInternals, signal: AbortSignal | undefined): Promise<PoolClient> {
      const startedAt = performance.now();
      try {
        const connecting = this.pool.connect();
        if (!signal) return await connecting;
        if (signal.aborted) {
          void connecting.then((client) => client.release(), () => undefined);
          throw abortError(signal);
        }

        return await new Promise<PoolClient>((resolve, reject) => {
          let completed = false;
          const onAbort = () => {
            if (completed) return;
            completed = true;
            reject(abortError(signal));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          void connecting.then(
            (client) => {
              signal.removeEventListener("abort", onAbort);
              if (completed || signal.aborted) {
                client.release();
                if (!completed) reject(abortError(signal));
                return;
              }
              completed = true;
              resolve(client);
            },
            (error: unknown) => {
              signal.removeEventListener("abort", onAbort);
              if (completed) return;
              completed = true;
              reject(error);
            },
          );
        });
      } finally {
        const waitMs = Math.max(0, performance.now() - startedAt);
        const metrics = this[timeseriesStoreState].queryMetrics;
        metrics.poolAcquisitions += 1;
        metrics.totalPoolWaitMs += waitMs;
        metrics.maxPoolWaitMs = Math.max(metrics.maxPoolWaitMs, waitMs);
      }
    },
  async __cancelBackendQuery(this: TimeseriesStoreInternals, client: PoolClient, token: string): Promise<void> {
      const processId = (client as PoolClient & { processID?: number }).processID;
      if (!Number.isInteger(processId)) return;
      try {
        await this.pool.query({
          text: `SELECT pg_cancel_backend($1)
            FROM pg_stat_activity
            WHERE pid = $1 AND query LIKE $2`,
          values: [processId, `%${QUERY_TAG_PREFIX}${token}%`],
        });
      } catch {
        // The caller has already been released from waiting. The store-level
        // server statement timeout remains the final safety net.
      }
    },
});
