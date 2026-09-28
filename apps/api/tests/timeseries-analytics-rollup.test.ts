import type { Pool, PoolClient, QueryConfig, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import { TimeseriesStore } from "../src/timeseries/store.js";

const FROM = "2026-07-18T00:00:00.000Z";
const TO = "2026-07-18T01:00:00.000Z";

interface CapturedQuery {
  text: string;
  values: unknown[];
}

function queryResult(rows: QueryResultRow[]): QueryResult<QueryResultRow> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

class RollupPool {
  constructor(private readonly overrides: QueryResultRow = {}) {}
  readonly queries: CapturedQuery[] = [];
  readonly on = vi.fn(() => this);
  readonly off = vi.fn(() => this);
  readonly end = vi.fn(async () => undefined);
  totalCount = 1;
  idleCount = 1;
  waitingCount = 0;

  readonly client = {
    processID: 4_242,
    query: async (config: QueryConfig) => this.dispatch(config),
    release: vi.fn(),
  } as unknown as PoolClient;

  readonly connect = vi.fn(async () => this.client);

  private dispatch(config: QueryConfig): QueryResult<QueryResultRow> {
    const query = { text: config.text, values: config.values ?? [] };
    this.queries.push(query);
    return queryResult(query.text.includes("AS requested(sensor_id TEXT, metric TEXT, aggregation TEXT)") ? [{
      sensor_id: "meter-1",
      metric: "power",
      canonical_unit: "W",
      included_sample_count: "180000",
      excluded_sample_count: "4",
      cadence_seconds: 2,
      bucket_start: new Date("2026-07-18T08:00:00.000Z"),
      rollup_value: 412.5,
      minimum: 100,
      maximum: 900,
      bucket_sample_count: "1800",
      estimated_sample_count: "2",
      stale_sample_count: "0",
      counter_reset_count: "0",
      ...this.overrides,
    }] : []);
  }
}

describe("TimeseriesStore analytics rollup", () => {
  it("rolls up an unbounded source range into bounded buckets inside PostgreSQL", async () => {
    const pool = new RollupPool();
    const store = new TimeseriesStore({
      pool: pool as unknown as Pool,
      statementTimeoutMs: 0,
    });

    await expect(store.measurementAnalyticsRollup({
      series: [{ sensorId: "meter-1", metric: "power", aggregation: "time_weighted_mean" }],
      from: FROM,
      to: TO,
      resolution: "1h",
      qualities: ["good", "estimated"],
      excludeSynthetic: true,
    })).resolves.toEqual({
      series: [{
        sensorId: "meter-1",
        metric: "power",
        canonicalUnit: "W",
        sampleCount: 180_000,
        excludedSampleCount: 4,
        cadenceSeconds: 2,
        buckets: [{
          bucketStart: "2026-07-18T08:00:00.000Z",
          value: 412.5,
          minimum: 100,
          maximum: 900,
          sampleCount: 1_800,
          estimatedSampleCount: 2,
          staleSampleCount: 0,
          counterResetCount: 0,
        }],
      }],
    });

    const rollup = pool.queries.find(({ text }) => text.includes("AS requested(sensor_id TEXT, metric TEXT, aggregation TEXT)"))!;
    expect(rollup.values).toEqual([
      JSON.stringify([{ sensor_id: "meter-1", metric: "power", aggregation: "time_weighted_mean" }]),
      FROM,
      TO,
      ["good", "estimated"],
      "1 hour",
      true,
      3,
      900,
    ]);
    expect(rollup.text).toContain("measurement_ordered_rollups");
    expect(rollup.text).toContain("measurement_ordered_rollup_generations");
    expect(rollup.text).toContain("required_days AS");
    expect(rollup.text).toContain("required.day_start IS NOT NULL");
    expect(rollup.text).toContain("dirty.day_start = required.day_start");
    expect(rollup.text).toContain("dirty.sensor_id IS NULL OR generation.sensor_id IS NULL");
    expect(rollup.text).toContain("GREATEST(dirty.current_seq, generation.current_seq)");
    expect(rollup.text).toContain("date_bin($5::INTERVAL");
    expect(rollup.text).toContain("rollup.bucket_seconds = $8::INTEGER");
    expect(rollup.text).toContain("counts.cadence_seconds * 1.5");
    expect(rollup.text).toContain("ORDER BY sample.observed_at ASC LIMIT 1");
    expect(rollup.text).not.toMatch(/LIMIT \$\d/u);
  });

  it.each([0.05, null])("retains empty-bucket extrema as null with consumption %s", async (consumption) => {
    const pool = new RollupPool({ rollup_value: null, minimum: null, maximum: null,
      bucket_sample_count: 0, consumption_kwh: consumption });
    const store = new TimeseriesStore({ pool: pool as unknown as Pool, statementTimeoutMs: 0 });
    const result = await store.measurementAnalyticsRollup({
      series: [{ sensorId: "meter-1", metric: "power", aggregation: "time_weighted_mean" }],
      from: FROM, to: TO, resolution: "5m", qualities: ["good", "estimated"],
    });
    expect(result.series[0]!.buckets).toEqual([expect.objectContaining({
      value: null, minimum: null, maximum: null, sampleCount: 0, consumptionKwh: consumption,
    })]);
  });

  it("passes a validated custom minute interval to PostgreSQL", async () => {
    const pool = new RollupPool();
    const store = new TimeseriesStore({ pool: pool as unknown as Pool, statementTimeoutMs: 0 });

    await store.measurementAnalyticsRollup({
      series: [{ sensorId: "meter-1", metric: "power", aggregation: "mean" }],
      from: FROM,
      to: TO,
      resolution: "7m",
      qualities: ["good"],
    });

    const rollup = pool.queries.find(({ text }) => text.includes("AS requested(sensor_id TEXT, metric TEXT, aggregation TEXT)"))!;
    expect(rollup.values[4]).toBe("7 minutes");
    expect(rollup.text).toContain("sample.bucket_start >= coverage.cached_from AND sample.bucket_start < coverage.cached_to");
    expect(rollup.text).toContain("sample.observed_at >= boundary.raw_from AND sample.observed_at < boundary.raw_to");
    expect(rollup.text).toContain("TRUE AS coverage_complete");
  });
});
