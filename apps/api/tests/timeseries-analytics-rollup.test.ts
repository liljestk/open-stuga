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
    return queryResult(query.text.includes("jsonb_to_recordset") ? [{
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

    const rollup = pool.queries.find(({ text }) => text.includes("jsonb_to_recordset"))!;
    expect(rollup.values).toEqual([
      JSON.stringify([{ sensor_id: "meter-1", metric: "power", aggregation: "time_weighted_mean" }]),
      FROM,
      TO,
      ["good", "estimated"],
      "1 hour",
      true,
    ]);
    expect(rollup.text).toContain("sample.observed_at < $3::TIMESTAMPTZ");
    expect(rollup.text).toContain("date_bin($5::INTERVAL");
    expect(rollup.text).toContain("cadences.cadence_seconds * 1.5");
    expect(rollup.text).not.toContain("LIMIT");
  });
});
