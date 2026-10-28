import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { TELEMETRY_TABLES } from "../../schema.js";
import type { QueryControl, TelemetryHealth, TelemetryStorageStats, TelemetryTableStorage, TimeseriesQueryDiagnostics } from "../../types.js";
import { HealthRow, SqlValue, StorageRow, TimescaleStorageRow } from "../support/row-types.js";
import { QUERY_TAG_PREFIX } from "../support/store-limits.js";
import { abortError, describeError, timeoutValue } from "../support/query-values.js";
import { registerTimeseriesStoreMethods, timeseriesStoreState, type TimeseriesStoreInternals } from "../core.js";

export function postgresErrorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : null;
}

declare module "../core.js" {
  interface TimeseriesStoreInternals {
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
    health(control?: QueryControl): Promise<TelemetryHealth>;
    storageStats(control?: QueryControl): Promise<TelemetryStorageStats>;
    diagnostics(): TimeseriesQueryDiagnostics;
    close(): Promise<void>;
  }
}

registerTimeseriesStoreMethods({
  async health(this: TimeseriesStoreInternals, control: QueryControl = {}): Promise<TelemetryHealth> {
      const state = this[timeseriesStoreState];
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
          lastPoolError: state.lastPoolError ? describeError(state.lastPoolError) : null,
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
          lastPoolError: state.lastPoolError ? describeError(state.lastPoolError) : null,
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
      const state = this[timeseriesStoreState];
      if (state.closed) return;
      state.closed = true;
      this.pool.off("error", state.poolErrorListener);
      if (state.ownsPool || state.closeInjectedPool) await this.pool.end();
    },
  async __query<Row extends QueryResultRow = QueryResultRow>(this: TimeseriesStoreInternals,
      sql: string,
      values: readonly SqlValue[] = [],
      control: QueryControl = {},
    ): Promise<QueryResult<Row>> {
      const state = this[timeseriesStoreState];
      if (state.closed) throw new Error("TimeseriesStore is closed");
      const timeoutMs = timeoutValue(control.timeoutMs, state.defaultTimeoutMs);
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

      const metrics = state.queryMetrics;
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
