import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEASUREMENT_ANALYTICS_BUCKETS,
  buildBaseSchemaSql,
  measurementAnalyticsAggregateName,
  type MeasurementAnalyticsBaseBucket,
} from "../src/timeseries/schema.js";
import { aggregateBucketedHistorySql } from "../src/timeseries/store/measurement-history-bucketed-sql.js";
import type { MeasurementHistoryBucketedQuery, MeasurementSampleRecord } from "../src/timeseries/types.js";
import { FakePool, queryResult, storeFor } from "./timeseries-store-test-support.js";

/*
 * Chart history merges the analytics continuous aggregates with raw edges.
 * Every answer must match the raw grouping it replaces: unaligned and exact
 * range edges, a hole in the series, tied and synthetic sources, mixed
 * quality, and an aggregate that lags behind or has not backfilled yet.
 */

type ChartQuery = Omit<MeasurementHistoryBucketedQuery, "sensorId" | "metric" | "includeMetadata">;

const DATA_START = "2026-09-01T00:00:00Z";
const HOLE = { from: "2026-09-02T05:13:00Z", to: "2026-09-02T09:47:00Z" };
// Mid-bucket for every base, so the newest materialized bucket is partial.
const LAG_CUTOFF = "2026-09-03T17:42:31.5Z";
const BACKFILLED_FROM = "2026-09-02T12:00:00Z";
const STATES = {
  complete: { cutoff: "infinity", earliest: "-infinity" },
  lagging: { cutoff: LAG_CUTOFF, earliest: "-infinity" },
  backfilling: { cutoff: LAG_CUTOFF, earliest: BACKFILLED_FROM },
  empty: { cutoff: "-infinity", earliest: "-infinity" },
} as const;

const CASES: ReadonlyArray<readonly [string, ChartQuery]> = [
  ["30d-style 5 min buckets with unaligned edges", {
    from: "2026-09-01T00:03:17.250Z", to: "2026-09-03T23:58:41Z", bucketSeconds: 300, limit: 100_000,
  }],
  ["1 min buckets across the hole", {
    from: "2026-09-02T04:00:30Z", to: "2026-09-02T11:15:10.75Z", bucketSeconds: 60, limit: 100_000,
  }],
  ["15 min buckets over aligned edges and an inclusive end sample", {
    from: "2026-09-01T06:00:00Z", to: "2026-09-03T12:00:00Z", bucketSeconds: 900, limit: 100_000,
  }],
  ["hourly forecast history", {
    from: "2026-09-01T00:59:59.999Z", to: "2026-09-03T21:00:00.001Z", bucketSeconds: 3_600, limit: 50,
  }],
  ["two-hour buckets", {
    from: "2026-09-01T01:30:00Z", to: "2026-09-03T22:10:00Z", bucketSeconds: 7_200, limit: 100_000,
  }],
  ["day buckets from hourly rows", {
    from: "2026-09-01T03:00:00Z", to: "2026-09-03T23:00:00Z", bucketSeconds: 86_400, limit: 100_000,
  }],
  ["newest 40 buckets only", {
    from: "2026-09-01T00:00:00Z", to: "2026-09-03T18:00:00Z", bucketSeconds: 300, limit: 40,
  }],
  ["a range inside one base bucket", {
    from: "2026-09-01T10:00:10Z", to: "2026-09-01T10:00:50Z", bucketSeconds: 60, limit: 100_000,
  }],
  ["a range inside the hole", {
    from: "2026-09-02T06:00:00Z", to: "2026-09-02T07:00:00Z", bucketSeconds: 300, limit: 100_000,
  }],
  ["buckets no aggregate divides", {
    from: "2026-09-01T00:00:00Z", to: "2026-09-01T06:00:00Z", bucketSeconds: 90, limit: 100_000,
  }],
];

describe("bucketed chart history from continuous aggregates", () => {
  const db = new PGlite();
  const run = async ({ text, values }: { text: string; values: unknown[] }) => {
    const result = await db.query<Record<string, unknown>>(text, values);
    return queryResult(result.rows, result.affectedRows);
  };
  const pool = new FakePool(run);
  const store = storeFor(pool);
  // A plain-PostgreSQL archive has no analytics aggregates, so the same store
  // code answers from raw samples only.
  const rawStore = storeFor(new FakePool((query) => query.text.includes("FROM pg_class") ? queryResult() : run(query)));

  beforeAll(async () => {
    await db.exec("SET TIME ZONE 'UTC'");
    for (const sql of buildBaseSchemaSql("telemetry")) await db.exec(sql);
    await db.query(`INSERT INTO telemetry.measurement_samples
      (sensor_id, metric, observed_at, source, value, canonical_unit, quality)
      SELECT 'plug', 'power', at, source,
        (n % 23) * 13.37 + CASE source WHEN 'api' THEN 0.1 ELSE 7.25 END,
        CASE source WHEN 'alternate' THEN 'kW' ELSE 'W' END,
        CASE WHEN n % 17 = 0 THEN 'stale' WHEN n % 7 = 0 THEN 'estimated' ELSE 'good' END
      FROM generate_series(0, 25_919) n
      CROSS JOIN LATERAL (SELECT $1::TIMESTAMPTZ + n * INTERVAL '10 seconds'
        + (n % 4) * INTERVAL '250 milliseconds' AS at) sample
      CROSS JOIN (VALUES ('api'), ('alternate'), ('mock'), ('replay')) sources(source)
      WHERE (source = 'api' OR (source = 'alternate' AND n % 5 = 0)
          OR (source = 'mock' AND n % 11 = 0) OR (source = 'replay' AND n % 13 = 0))
        AND NOT (at >= $2::TIMESTAMPTZ AND at < $3::TIMESTAMPTZ)`, [DATA_START, HOLE.from, HOLE.to]);
    await db.exec(`INSERT INTO telemetry.measurement_samples
      (sensor_id, metric, observed_at, source, value, canonical_unit, quality) VALUES
      ('plug', 'power', '2026-09-03T12:00:00Z', 'boundary', 4321.5, 'W', 'good'),
      ('plug', 'energy', '2026-09-01T10:00:20Z', 'api', 99, 'kWh', 'good'),
      ('other', 'power', '2026-09-01T10:00:20Z', 'zzzz', 99, 'W', 'good');
      ANALYZE telemetry.measurement_samples;`);
    for (const bucket of Object.keys(MEASUREMENT_ANALYTICS_BUCKETS) as MeasurementAnalyticsBaseBucket[]) {
      await db.exec(`CREATE TABLE telemetry.${measurementAnalyticsAggregateName(bucket)} (
        sensor_id TEXT, metric TEXT, source TEXT, quality TEXT, canonical_unit TEXT, bucket_start TIMESTAMPTZ,
        sample_count BIGINT, sum_value DOUBLE PRECISION, minimum DOUBLE PRECISION, maximum DOUBLE PRECISION,
        first_value DOUBLE PRECISION, first_at TIMESTAMPTZ, last_value DOUBLE PRECISION, last_at TIMESTAMPTZ)`);
    }
  }, 60_000);

  afterAll(async () => { await db.close(); });

  /** Mirrors the continuous aggregate definition over what a refresh has reached. */
  async function materialize(state: (typeof STATES)[keyof typeof STATES]): Promise<void> {
    for (const [bucket, { interval }] of Object.entries(MEASUREMENT_ANALYTICS_BUCKETS)) {
      const name = `telemetry.${measurementAnalyticsAggregateName(bucket as MeasurementAnalyticsBaseBucket)}`;
      await db.exec(`TRUNCATE ${name}`);
      await db.query(`INSERT INTO ${name}
        SELECT * FROM (
          SELECT sensor_id, metric, source, quality, canonical_unit,
            date_bin(INTERVAL '${interval}', observed_at, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS bucket_start,
            count(*), sum(value), min(value), max(value),
            (array_agg(value ORDER BY observed_at))[1], min(observed_at),
            (array_agg(value ORDER BY observed_at DESC))[1], max(observed_at)
          FROM telemetry.measurement_samples
          WHERE observed_at < $1::TIMESTAMPTZ
          GROUP BY 1, 2, 3, 4, 5, 6
        ) refreshed WHERE bucket_start >= $2::TIMESTAMPTZ`, [state.cutoff, state.earliest]);
    }
  }

  function expectSameHistory(actual: MeasurementSampleRecord[], expected: MeasurementSampleRecord[]): void {
    expect(actual.map(({ value: _value, ...row }) => row)).toEqual(expected.map(({ value: _value, ...row }) => row));
    actual.forEach((row, index) => {
      const reference = expected[index]!.value;
      expect(Math.abs(row.value - reference), row.timestamp).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(reference)));
    });
  }

  it.each(Object.keys(STATES) as Array<keyof typeof STATES>)("matches the raw grouping with a %s aggregate", async (state) => {
    await materialize(STATES[state]);
    let aggregateReads = 0;
    for (const [name, chart] of CASES) {
      for (const excludeSynthetic of [true, false]) {
        const query = { ...chart, sensorId: "plug", metric: "power", excludeSynthetic, includeMetadata: false };
        const before = pool.queries.length;
        const actual = await store.measurementHistoryBucketed(query);
        if (pool.queries.slice(before).some(({ text }) => text.includes("measurement_analytics_v2_"))) aggregateReads += 1;
        const expected = await rawStore.measurementHistoryBucketed(query);
        if (name !== "a range inside the hole") expect(expected.length, name).toBeGreaterThan(0);
        expectSameHistory(actual, expected);
      }
    }
    expect(aggregateReads).toBe((CASES.length - 1) * 2);
  }, 120_000);

  it.each([
    // Six source/quality/unit groups per five-minute bucket, two raw edges.
    ["complete", 4],
    // The six hours behind the lag cutoff come from raw samples.
    ["lagging", 2],
  ] as const)("reads every sample once, mostly from a %s aggregate", async (state, reduction) => {
    await materialize(STATES[state]);
    const sql = aggregateBucketedHistorySql("telemetry", "5m", { excludeSynthetic: true });
    const countSql = `${sql.slice(0, sql.indexOf("), source_groups AS"))})
      SELECT count(*) AS rows, sum(sample_count) AS samples FROM source_rows
      WHERE $5::INT IS NOT NULL AND $6::INT IS NOT NULL`;
    const from = "2026-09-01T00:03:17.250Z";
    const to = "2026-09-03T23:58:41Z";
    const counted = (await db.query<{ rows: string; samples: string }>(countSql, [
      "plug", "power", from, to, 300, 100_000, MEASUREMENT_ANALYTICS_BUCKETS["5m"].interval,
    ])).rows[0]!;
    const raw = (await db.query<{ samples: string }>(`SELECT count(*) AS samples FROM telemetry.measurement_samples
      WHERE sensor_id = 'plug' AND metric = 'power' AND observed_at >= $1 AND observed_at <= $2
        AND source NOT IN ('mock', 'replay')`, [from, to])).rows[0]!;
    expect(Number(counted.samples)).toBe(Number(raw.samples));
    expect(Number(counted.rows)).toBeLessThan(Number(raw.samples) / reduction);
  });

  it("keeps metadata reads and plain-PostgreSQL archives on raw samples", async () => {
    await materialize(STATES.complete);
    const before = pool.queries.length;
    const withMetadata = await store.measurementHistoryBucketed({
      sensorId: "plug", metric: "power", from: "2026-09-01T10:00:00Z", to: "2026-09-01T11:00:00Z",
      bucketSeconds: 300, limit: 100, excludeSynthetic: true,
    });
    expect(pool.queries.slice(before).some(({ text }) => text.includes("measurement_analytics_v2_"))).toBe(false);
    expect(withMetadata).toHaveLength(13);
    expect(withMetadata.every((sample) => sample.quality === "estimated")).toBe(true);
  });
});
