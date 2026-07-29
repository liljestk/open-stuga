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
  TelemetrySchemaInitResult,
  TelemetryStorageStats,
  TelemetryStoreOptions,
  TelemetryTableStorage,
} from "../../types.js";
import { EnergyCostAggregateRow, ExtensionRow, HealthRow, QUERY_TAG_PREFIX, SqlValue, StorageRow, TimescaleStorageRow, abortError, describeError, timeoutValue, timestamp } from "../support/01-default-schema-to-measurement-bucket-from-row.js";
import { registerTimeseriesStoreMethods, timeseriesStoreState, type TimeseriesStoreInternals } from "../core.js";

registerTimeseriesStoreMethods({
  async energyCostAggregate(this: TimeseriesStoreInternals, query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord> {
      const measurements = qualifiedName(this.schema, "measurement_samples");
      const prices = qualifiedName(this.schema, "electricity_price_samples");
      const result = await this.__query<EnergyCostAggregateRow>(`WITH boundary_sample AS (
          SELECT observed_at, value, ingested_at, source FROM ${measurements}
          WHERE sensor_id = $1 AND metric = 'energy' AND quality <> 'stale'
            AND observed_at < $2::TIMESTAMPTZ
            AND (NOT $5::BOOLEAN OR source NOT IN ('mock', 'replay'))
          ORDER BY observed_at DESC, ingested_at DESC, source DESC LIMIT 1
        ), window_samples AS (
          SELECT observed_at, value, ingested_at, source FROM ${measurements}
          WHERE sensor_id = $1 AND metric = 'energy' AND quality <> 'stale'
            AND observed_at >= $2::TIMESTAMPTZ AND observed_at <= $3::TIMESTAMPTZ
            AND (NOT $5::BOOLEAN OR source NOT IN ('mock', 'replay'))
        ), deduplicated AS (
          SELECT DISTINCT ON (observed_at) observed_at, value
          FROM (SELECT * FROM boundary_sample UNION ALL SELECT * FROM window_samples) samples
          ORDER BY observed_at, ingested_at DESC, source DESC
        ), ordered AS (
          SELECT observed_at AS current_at, value AS current_value,
            lag(observed_at) OVER (ORDER BY observed_at) AS previous_at,
            lag(value) OVER (ORDER BY observed_at) AS previous_value
          FROM deduplicated
        ), deltas AS (
          SELECT previous_at, current_at, GREATEST(previous_at, $2::TIMESTAMPTZ) AS window_start,
            CASE WHEN current_value >= previous_value THEN current_value - previous_value
              ELSE GREATEST(0, current_value) END AS base_delta_kwh,
            EXTRACT(EPOCH FROM (current_at - previous_at)) * 1000.0 AS full_duration_ms
          FROM ordered
          WHERE previous_at IS NOT NULL AND current_at > $2::TIMESTAMPTZ
            AND current_value >= 0 AND previous_value >= 0 AND current_at > previous_at
        ), normalized AS (
          SELECT *,
            base_delta_kwh * EXTRACT(EPOCH FROM (current_at - window_start)) * 1000.0
              / full_duration_ms AS window_delta_kwh,
            EXTRACT(EPOCH FROM (current_at - window_start)) * 1000.0 AS window_duration_ms
          FROM deltas
        ), price_intervals AS (
          SELECT DISTINCT ON (starts_at)
            starts_at, ends_at, raw_price_cents_per_kwh, margin_cents_per_kwh
          FROM ${prices}
          WHERE property_id = $4
            AND (NOT $5::BOOLEAN OR source NOT IN ('mock', 'replay'))
          ORDER BY starts_at, ingested_at DESC, source DESC
        ), priced AS (
          SELECT normalized.*, price.raw_price_cents_per_kwh, price.margin_cents_per_kwh,
            EXTRACT(EPOCH FROM (LEAST(normalized.current_at, price.ends_at)
              - GREATEST(normalized.window_start, price.starts_at))) * 1000.0 AS overlap_ms
          FROM normalized JOIN price_intervals AS price
            ON price.starts_at < normalized.current_at
            AND price.ends_at > normalized.window_start
        ), allocations AS (
          SELECT overlap_ms, base_delta_kwh * overlap_ms / full_duration_ms AS allocated_kwh,
            raw_price_cents_per_kwh + margin_cents_per_kwh AS effective_price_cents_per_kwh
          FROM priced WHERE overlap_ms > 0
        )
        SELECT
          (SELECT count(*) FROM normalized) AS delta_count,
          (SELECT COALESCE(sum(window_delta_kwh), 0) FROM normalized) AS consumption_kwh,
          (SELECT COALESCE(sum(allocated_kwh), 0) FROM allocations) AS priced_consumption_kwh,
          (SELECT COALESCE(sum(allocated_kwh * effective_price_cents_per_kwh / 100.0), 0) FROM allocations) AS cost_eur,
          (SELECT COALESCE(sum(window_duration_ms), 0) FROM normalized) AS total_duration_ms,
          (SELECT COALESCE(sum(overlap_ms), 0) FROM allocations) AS priced_duration_ms,
          (SELECT min(window_start) FROM normalized) AS coverage_from,
          (SELECT max(current_at) FROM normalized) AS coverage_until`,
      [query.sensorId, query.from, query.to, query.propertyId, Boolean(query.excludeSynthetic)], query);
      const row = result.rows[0]!;
      return {
        deltaCount: Number(row.delta_count ?? 0),
        consumptionKwh: Number(row.consumption_kwh ?? 0),
        pricedConsumptionKwh: Number(row.priced_consumption_kwh ?? 0),
        costEur: Number(row.cost_eur ?? 0),
        totalDurationMs: Number(row.total_duration_ms ?? 0),
        pricedDurationMs: Number(row.priced_duration_ms ?? 0),
        coverageFrom: row.coverage_from === null ? null : timestamp(row.coverage_from),
        coverageUntil: row.coverage_until === null ? null : timestamp(row.coverage_until),
      };
    },
  async powerCostAggregate(this: TimeseriesStoreInternals, query: PowerCostAggregateQuery): Promise<EnergyCostAggregateRecord> {
      const measurements = qualifiedName(this.schema, "measurement_samples");
      const prices = qualifiedName(this.schema, "electricity_price_samples");
      const result = await this.__query<EnergyCostAggregateRow>(`WITH boundary_sample AS (
          SELECT observed_at, value, ingested_at, source FROM ${measurements}
          WHERE sensor_id = $1 AND metric = 'power' AND quality <> 'stale'
            AND observed_at <= $2::TIMESTAMPTZ
            AND (NOT $5::BOOLEAN OR source NOT IN ('mock', 'replay'))
          ORDER BY observed_at DESC, ingested_at DESC, source DESC LIMIT 1
        ), window_samples AS (
          SELECT observed_at, value, ingested_at, source FROM ${measurements}
          WHERE sensor_id = $1 AND metric = 'power' AND quality <> 'stale'
            AND observed_at > $2::TIMESTAMPTZ AND observed_at <= $3::TIMESTAMPTZ
            AND (NOT $5::BOOLEAN OR source NOT IN ('mock', 'replay'))
        ), deduplicated AS (
          SELECT DISTINCT ON (observed_at) observed_at, value
          FROM (SELECT * FROM boundary_sample UNION ALL SELECT * FROM window_samples) samples
          ORDER BY observed_at, ingested_at DESC, source DESC
        ), ordered AS (
          SELECT observed_at AS sample_at, value AS power_watts,
            lead(observed_at) OVER (ORDER BY observed_at) AS next_at
          FROM deduplicated
        ), candidates AS (
          SELECT power_watts,
            GREATEST(sample_at, $2::TIMESTAMPTZ) AS window_start,
            LEAST(
              COALESCE(next_at, $3::TIMESTAMPTZ),
              $3::TIMESTAMPTZ,
              sample_at + INTERVAL '15 minutes'
            ) AS window_end
          FROM ordered
          WHERE power_watts >= 0 AND power_watts < 'Infinity'::DOUBLE PRECISION
        ), normalized AS (
          SELECT *,
            EXTRACT(EPOCH FROM (window_end - window_start)) * 1000.0 AS window_duration_ms,
            power_watts * EXTRACT(EPOCH FROM (window_end - window_start)) / 3600000.0
              AS window_energy_kwh
          FROM candidates
          WHERE window_end > window_start
        ), price_intervals AS (
          SELECT DISTINCT ON (starts_at)
            starts_at, ends_at, raw_price_cents_per_kwh, margin_cents_per_kwh
          FROM ${prices}
          WHERE property_id = $4
            AND (NOT $5::BOOLEAN OR source NOT IN ('mock', 'replay'))
          ORDER BY starts_at, ingested_at DESC, source DESC
        ), priced AS (
          SELECT normalized.*, price.raw_price_cents_per_kwh, price.margin_cents_per_kwh,
            EXTRACT(EPOCH FROM (
              LEAST(normalized.window_end, price.ends_at)
              - GREATEST(normalized.window_start, price.starts_at)
            )) * 1000.0 AS overlap_ms
          FROM normalized JOIN price_intervals AS price
            ON price.starts_at < normalized.window_end
            AND price.ends_at > normalized.window_start
        ), allocations AS (
          SELECT overlap_ms, window_energy_kwh * overlap_ms / window_duration_ms AS allocated_kwh,
            raw_price_cents_per_kwh + margin_cents_per_kwh AS effective_price_cents_per_kwh
          FROM priced WHERE overlap_ms > 0
        )
        SELECT
          (SELECT count(*) FROM normalized) AS delta_count,
          (SELECT COALESCE(sum(window_energy_kwh), 0) FROM normalized) AS consumption_kwh,
          (SELECT COALESCE(sum(allocated_kwh), 0) FROM allocations) AS priced_consumption_kwh,
          (SELECT COALESCE(sum(allocated_kwh * effective_price_cents_per_kwh / 100.0), 0) FROM allocations) AS cost_eur,
          (SELECT COALESCE(sum(window_duration_ms), 0) FROM normalized) AS total_duration_ms,
          (SELECT COALESCE(sum(overlap_ms), 0) FROM allocations) AS priced_duration_ms,
          (SELECT min(window_start) FROM normalized) AS coverage_from,
          (SELECT max(window_end) FROM normalized) AS coverage_until`,
      [query.sensorId, query.from, query.to, query.propertyId, Boolean(query.excludeSynthetic)], query);
      const row = result.rows[0]!;
      return {
        deltaCount: Number(row.delta_count ?? 0),
        consumptionKwh: Number(row.consumption_kwh ?? 0),
        pricedConsumptionKwh: Number(row.priced_consumption_kwh ?? 0),
        costEur: Number(row.cost_eur ?? 0),
        totalDurationMs: Number(row.total_duration_ms ?? 0),
        pricedDurationMs: Number(row.priced_duration_ms ?? 0),
        coverageFrom: row.coverage_from === null ? null : timestamp(row.coverage_from),
        coverageUntil: row.coverage_until === null ? null : timestamp(row.coverage_until),
      };
    },
  /** Refreshes all three Timescale rollups after a historical import. */
  async refreshMeasurementAggregates(this: TimeseriesStoreInternals, query: AggregateRefreshQuery = {}): Promise<number> {
      const extension = await this.__query<ExtensionRow>(`SELECT (
        SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'
      ) AS timescale_version`, [], query);
      if (!extension.rows[0]?.timescale_version) return 0;

      let refreshed = 0;
      for (const bucket of Object.keys(MEASUREMENT_BUCKETS) as Array<keyof typeof MEASUREMENT_BUCKETS>) {
        const aggregate = measurementAggregateName(bucket);
        if (!await this.__isContinuousAggregate(aggregate, query)) continue;
        await this.__query(
          "CALL refresh_continuous_aggregate($1::REGCLASS, $2::TIMESTAMPTZ, $3::TIMESTAMPTZ)",
          [qualifiedName(this.schema, aggregate), query.from ?? null, query.to ?? null],
          query,
        );
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

      try {
        return await this.__runQuery<Row>(sql, values, signal);
      } finally {
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
      const connecting = this.pool.connect();
      if (!signal) return connecting;
      if (signal.aborted) {
        void connecting.then((client) => client.release(), () => undefined);
        throw abortError(signal);
      }

      return new Promise<PoolClient>((resolve, reject) => {
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
