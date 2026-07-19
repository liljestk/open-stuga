import type { Pool, PoolClient, QueryConfig, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  buildBaseSchemaSql,
  buildContinuousAggregateSql,
  buildFallbackAggregateSql,
  validateSchemaName,
} from "../src/timeseries/schema.js";
import { TimeseriesStore } from "../src/timeseries/store.js";

interface CapturedQuery {
  text: string;
  values: unknown[];
  direct: boolean;
}

type QueryHandler = (query: CapturedQuery) => Promise<QueryResult<QueryResultRow>> | QueryResult<QueryResultRow>;

function queryResult(rows: QueryResultRow[] = [], rowCount = rows.length): QueryResult<QueryResultRow> {
  return {
    command: "SELECT",
    rowCount,
    oid: 0,
    fields: [],
    rows,
  };
}

class FakePool {
  readonly queries: CapturedQuery[] = [];
  readonly releases: ReturnType<typeof vi.fn> = vi.fn();
  readonly end = vi.fn(async () => undefined);
  readonly on = vi.fn(() => this);
  readonly off = vi.fn(() => this);
  totalCount = 1;
  idleCount = 1;
  waitingCount = 0;
  handler: QueryHandler;

  readonly client = {
    processID: 4_242,
    query: async (config: QueryConfig) => this.dispatch(config, false),
    release: this.releases,
  } as unknown as PoolClient;

  readonly connect = vi.fn(async () => this.client);
  readonly query = vi.fn(async (config: QueryConfig) => this.dispatch(config, true));

  constructor(handler: QueryHandler = ({ text }) => {
    if (text.includes("AS timescale_version")) return queryResult([{ timescale_version: null }]);
    return queryResult();
  }) {
    this.handler = handler;
  }

  private dispatch(config: QueryConfig, direct: boolean): Promise<QueryResult<QueryResultRow>> {
    const query = {
      text: config.text,
      values: config.values ?? [],
      direct,
    };
    this.queries.push(query);
    return Promise.resolve(this.handler(query));
  }
}

function storeFor(pool: FakePool): TimeseriesStore {
  return new TimeseriesStore({
    pool: pool as unknown as Pool,
    statementTimeoutMs: 0,
  });
}

describe("time-series schema", () => {
  it("creates append-only raw tables with time-inclusive idempotency keys and no data expiry", () => {
    const sql = buildBaseSchemaSql("telemetry").join("\n");
    expect(sql).toContain("PRIMARY KEY (sensor_id, metric, observed_at, source)");
    expect(sql).toContain("PRIMARY KEY (sensor_id, observed_at, source)");
    expect(sql).toContain("PRIMARY KEY (house_id, location_key, observed_at, source)");
    expect(sql).toContain("PRIMARY KEY (property_id, starts_at, source)");
    expect(sql).toContain("PRIMARY KEY (source_id, table_name)");
    expect(sql).toContain("last_row_id BIGINT NOT NULL CHECK (last_row_id >= 0)");
    expect(sql).toContain("USING BRIN (observed_at)");
    expect(sql.toLowerCase()).not.toContain("drop_chunks");
    expect(sql.toLowerCase()).not.toContain("add_retention_policy");
    expect(sql.toLowerCase()).not.toContain("delete from");
  });

  it("builds equivalent Timescale and PostgreSQL aggregate projections", () => {
    const continuous = buildContinuousAggregateSql("telemetry", "5m");
    const fallback = buildFallbackAggregateSql("telemetry", "5m");
    expect(continuous).toContain("timescaledb.continuous");
    expect(continuous).toContain("time_bucket(INTERVAL '5 minutes', observed_at)");
    expect(continuous).toContain("timescaledb.materialized_only = false");
    expect(fallback).toContain("CREATE OR REPLACE VIEW");
    expect(fallback).toContain("date_bin(INTERVAL '5 minutes', observed_at");
    for (const column of ["sample_count", "average", "minimum", "maximum", "canonical_unit"]) {
      expect(continuous).toContain(column);
      expect(fallback).toContain(column);
    }
  });

  it("rejects dynamic schema identifiers instead of interpolating them", () => {
    expect(validateSchemaName("telemetry_2")).toBe("telemetry_2");
    expect(() => validateSchemaName("telemetry; DROP SCHEMA public")).toThrow(/Invalid PostgreSQL schema/);
  });
});

describe("TimeseriesStore", () => {
  it("initializes a complete plain-PostgreSQL fallback when Timescale is unavailable", async () => {
    const pool = new FakePool();
    const store = storeFor(pool);
    const initialized = await store.initialize();

    expect(initialized).toMatchObject({
      schema: "telemetry",
      timescaleAvailable: false,
      hypertables: [],
      aggregateMode: "view",
      coldStorageMode: "none",
    });
    expect(pool.queries.some(({ text }) => text.includes("CREATE EXTENSION IF NOT EXISTS timescaledb"))).toBe(true);
    expect(pool.queries.filter(({ text }) => text.includes("CREATE OR REPLACE VIEW"))).toHaveLength(3);
    expect(pool.queries.some(({ text }) => text.includes("add_retention_policy"))).toBe(false);
    await store.close();
    expect(pool.end).not.toHaveBeenCalled();
  });

  it("can invalidate a resolved initialization so transient DDL failures are retried", async () => {
    const pool = new FakePool();
    const store = storeFor(pool);
    await store.initialize();
    const firstQueryCount = pool.queries.length;
    await store.initialize();
    expect(pool.queries).toHaveLength(firstQueryCount);

    store.invalidateInitialization();
    await store.initialize();
    expect(pool.queries.length).toBeGreaterThan(firstQueryCount);
  });

  it("enables hypertables, 2.20+ columnstore policies, and continuous aggregates when detected", async () => {
    const pool = new FakePool(({ text }) => {
      if (text.includes("AS timescale_version")) return queryResult([{ timescale_version: "2.28.0" }]);
      if (text.includes("columnstore_available")) {
        return queryResult([{
          columnstore_available: true,
          compression_available: true,
          continuous_policy_available: true,
        }]);
      }
      if (text.includes("timescaledb_information.hypertables")) {
        return queryResult([{ configured: true }]);
      }
      return queryResult();
    });
    const store = storeFor(pool);
    const initialized = await store.initialize();

    expect(initialized).toMatchObject({
      timescaleAvailable: true,
      timescaleVersion: "2.28.0",
      hypertables: [
        "measurement_samples",
        "legacy_readings",
        "outdoor_temperature_samples",
        "electricity_price_samples",
      ],
      aggregateMode: "continuous",
      coldStorageMode: "columnstore",
      warnings: [],
    });
    expect(pool.queries.filter(({ text }) => text.includes("create_hypertable("))).toHaveLength(4);
    expect(pool.queries.filter(({ text }) => text.includes("CALL add_columnstore_policy"))).toHaveLength(4);
    expect(pool.queries.filter(({ text }) => text.includes("CREATE MATERIALIZED VIEW"))).toHaveLength(3);
    expect(pool.queries.filter(({ text }) => text.includes("SELECT add_continuous_aggregate_policy("))).toHaveLength(3);
    expect(pool.queries.some(({ text }) => text.includes("add_retention_policy"))).toBe(false);
  });

  it("recognizes Timescale 2.28 continuous aggregates by catalog instead of relkind", async () => {
    const pool = new FakePool(({ text }) => {
      if (text.includes("AS timescale_version")) return queryResult([{ timescale_version: "2.28.3" }]);
      if (text.includes("columnstore_available")) {
        return queryResult([{
          columnstore_available: false,
          compression_available: false,
          continuous_policy_available: true,
        }]);
      }
      if (text.includes("timescaledb_information.hypertables")) {
        return queryResult([{ configured: true }]);
      }
      if (text.includes("timescaledb_information.continuous_aggregates")) {
        return queryResult([{ configured: true }]);
      }
      // This is the real pg_class representation on Timescale 2.28. The
      // implementation must not use it to classify a continuous aggregate.
      if (text.includes("FROM pg_class c")) return queryResult([{ relkind: "v" }]);
      return queryResult();
    });
    const store = storeFor(pool);

    await expect(store.initialize()).resolves.toMatchObject({
      aggregateMode: "continuous",
      warnings: [],
    });
    expect(pool.queries.filter(({ text }) => text.includes("timescaledb_information.continuous_aggregates")))
      .toHaveLength(3);
    expect(pool.queries.some(({ text }) => text.includes("DROP VIEW"))).toBe(false);
    expect(pool.queries.some(({ text }) => text.includes("CREATE MATERIALIZED VIEW"))).toBe(false);

    await expect(store.refreshMeasurementAggregates({
      from: "2026-07-18T00:00:00.000Z",
      to: "2026-07-19T00:00:00.000Z",
    })).resolves.toBe(3);
    expect(pool.queries.filter(({ text }) => text.includes("CALL refresh_continuous_aggregate"))).toHaveLength(3);
  });

  it("writes samples in one parameterized multi-row upsert and ignores byte-identical retries", async () => {
    const pool = new FakePool(({ text }) => queryResult([], text.includes("INSERT INTO") ? 2 : 0));
    const store = storeFor(pool);
    const result = await store.upsertMeasurementSamples([
      {
        sensorId: "sensor-1",
        metric: "temperature",
        value: 20.5,
        canonicalUnit: "°C",
        timestamp: "2026-07-18T08:00:00.000Z",
        source: "home-assistant",
        quality: "good",
      },
      {
        sensorId: "sensor-1",
        metric: "humidity",
        value: 45,
        canonicalUnit: "%",
        timestamp: "2026-07-18T08:00:00.000Z",
        source: "home-assistant",
        quality: "good",
      },
    ]);

    expect(result).toEqual({ attempted: 2, affected: 2 });
    const insert = pool.queries.find(({ text }) => text.includes("INSERT INTO"))!;
    expect(insert.text).toContain("VALUES ($1, $2, $3, $4, $5, $6, $7, $8), ($9, $10, $11, $12, $13, $14, $15, $16)");
    expect(insert.text).toContain('ON CONFLICT ("sensor_id", "metric", "observed_at", "source") DO UPDATE');
    expect(insert.text).toContain("IS DISTINCT FROM");
    expect(insert.text).not.toContain("sensor-1");
    expect(insert.values.slice(0, 7)).toEqual([
      "sensor-1", "temperature", "2026-07-18T08:00:00.000Z", "home-assistant", 20.5, "°C", "good",
    ]);
  });

  it("maps timestamps consistently and bounds latest/history queries with parameters", async () => {
    const pool = new FakePool(({ text }) => {
      if (text.includes("LIMIT 1")) return queryResult([{
        sensor_id: "sensor-1",
        metric: "co2",
        value: 720,
        canonical_unit: "ppm",
        observed_at: new Date("2026-07-18T08:00:00.000Z"),
        source: "api",
        quality: "good",
        metadata: {},
      }]);
      return queryResult();
    });
    const store = storeFor(pool);
    await expect(store.latestMeasurementSample("sensor-1", "co2")).resolves.toEqual({
      sensorId: "sensor-1",
      metric: "co2",
      value: 720,
      canonicalUnit: "ppm",
      timestamp: "2026-07-18T08:00:00.000Z",
      source: "api",
      quality: "good",
      metadata: {},
    });
    const select = pool.queries.find(({ text }) => text.includes("LIMIT 1"))!;
    expect(select.values).toEqual(["sensor-1", "co2"]);
    expect(select.text).not.toContain("sensor-1");
  });

  it("reads one deterministic bounded window across sensor and metric sets", async () => {
    const pool = new FakePool(({ text }) => text.includes("sensor_id = ANY($1::TEXT[])")
      ? queryResult([
        {
          sensor_id: "sensor-1",
          metric: "humidity",
          value: 44,
          canonical_unit: "%",
          observed_at: new Date("2026-07-18T08:00:00.000Z"),
          source: "home-assistant",
          quality: "good",
          metadata: { bridge: "ha" },
        },
        {
          sensor_id: "sensor-2",
          metric: "temperature",
          value: 21.5,
          canonical_unit: "°C",
          observed_at: "2026-07-18T08:01:00.000Z",
          source: "api",
          quality: "estimated",
          metadata: {},
        },
      ])
      : queryResult());
    const store = storeFor(pool);
    const from = "2026-07-18T07:00:00.000Z";
    const to = "2026-07-18T09:00:00.000Z";

    await expect(store.measurementWindow({
      sensorIds: ["sensor-2", "sensor-1"],
      metrics: ["temperature", "humidity"],
      from,
      to,
      limit: 250_000,
      timeoutMs: 1_000,
    })).resolves.toEqual([
      {
        sensorId: "sensor-1",
        metric: "humidity",
        value: 44,
        canonicalUnit: "%",
        timestamp: "2026-07-18T08:00:00.000Z",
        source: "home-assistant",
        quality: "good",
        metadata: { bridge: "ha" },
      },
      {
        sensorId: "sensor-2",
        metric: "temperature",
        value: 21.5,
        canonicalUnit: "°C",
        timestamp: "2026-07-18T08:01:00.000Z",
        source: "api",
        quality: "estimated",
        metadata: {},
      },
    ]);

    const select = pool.queries.find(({ text }) => text.includes("sensor_id = ANY($1::TEXT[])"))!;
    expect(select.values).toEqual([
      ["sensor-2", "sensor-1"],
      ["temperature", "humidity"],
      from,
      to,
      250_000,
    ]);
    expect(select.text).toContain("metric = ANY($2::TEXT[])");
    expect(select.text).toContain("ORDER BY observed_at DESC, sensor_id DESC, metric DESC, source DESC");
    expect(select.text).toContain("ORDER BY observed_at ASC, sensor_id ASC, metric ASC, source ASC");
    expect(select.text).not.toContain("sensor-1");
  });

  it("short-circuits empty measurement window filters without acquiring a connection", async () => {
    const pool = new FakePool();
    const store = storeFor(pool);
    const common = {
      from: "2026-07-18T07:00:00.000Z",
      to: "2026-07-18T09:00:00.000Z",
    };

    await expect(store.measurementWindow({ ...common, sensorIds: [], metrics: ["temperature"] }))
      .resolves.toEqual([]);
    await expect(store.measurementWindow({ ...common, sensorIds: ["sensor-1"], metrics: [] }))
      .resolves.toEqual([]);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.queries).toEqual([]);
  });

  it("honors cancellation controls for batched measurement windows", async () => {
    const pool = new FakePool();
    const store = storeFor(pool);
    const controller = new AbortController();
    controller.abort();

    await expect(store.measurementWindow({
      sensorIds: ["sensor-1"],
      metrics: ["temperature"],
      from: "2026-07-18T07:00:00.000Z",
      to: "2026-07-18T09:00:00.000Z",
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("maintains a monotonic per-archive cursor for crash-safe reconciliation", async () => {
    const pool = new FakePool(({ text, values }) => {
      if (text.includes("RETURNING source_id")) return queryResult([{
        source_id: values[0],
        table_name: values[1],
        last_row_id: values[2],
        updated_at: "2026-07-18T08:01:00.000Z",
      }], 1);
      return queryResult();
    });
    const store = storeFor(pool);
    await expect(store.archiveCheckpoint("new-archive", "measurement_samples")).resolves.toBe(0);
    await expect(store.saveArchiveCheckpoint("sqlite-main", "measurement_samples", 42)).resolves.toBeUndefined();
    const update = pool.queries.find(({ text }) => text.includes("RETURNING source_id"))!;
    expect(update.text).toContain("GREATEST(checkpoint.last_row_id, EXCLUDED.last_row_id)");
    expect(update.values).toEqual(["sqlite-main", "measurement_samples", 42]);
    await expect(store.setArchiveCheckpoint("sqlite-main", "measurement_samples", -1)).rejects.toThrow(/non-negative/);
  });

  it("returns promptly on AbortSignal and issues a token-scoped backend cancellation", async () => {
    let rejectActive: ((error: Error) => void) | undefined;
    const pool = new FakePool(({ text }) => {
      if (text.includes("pg_cancel_backend")) {
        rejectActive?.(new Error("canceling statement due to user request"));
        return queryResult([{ pg_cancel_backend: true }]);
      }
      return new Promise<QueryResult<QueryResultRow>>((_resolve, reject) => {
        rejectActive = reject;
      });
    });
    const store = storeFor(pool);
    const controller = new AbortController();
    const pending = store.latestMeasurementSample("sensor-1", "temperature", { signal: controller.signal });
    await vi.waitFor(() => expect(pool.queries).toHaveLength(1));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(pool.queries.some(({ text, direct }) => (
      direct && text.includes("pg_cancel_backend") && text.includes("query LIKE $2")
    ))).toBe(true));
  });
});
