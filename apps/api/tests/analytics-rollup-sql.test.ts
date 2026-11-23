import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import { HybridTelemetryReader, type ArchiveTelemetryReader } from "../src/timeseries/read-facade.js";
import { mergeableAnalyticsSql } from "../src/timeseries/store/measurement-analytics-rollup-sql.js";
import { FakePool, queryResult, storeFor } from "./timeseries-store-test-support.js";

it("combines a lagging aggregate with raw boundaries without dropping or duplicating observations", async () => {
  const db = new PGlite();
  try {
    await db.exec(`SET TIME ZONE 'UTC'; CREATE SCHEMA telemetry;
    CREATE TABLE telemetry.measurement_samples (
     sensor_id text, metric text, observed_at timestamptz, source text, quality text, canonical_unit text, value double precision);
    INSERT INTO telemetry.measurement_samples
    SELECT 'room', 'temperature', '2026-09-01'::timestamptz + n * interval '1 minute',
     CASE WHEN n % 13 = 0 THEN 'mock' ELSE 'tp-link' END,
     CASE WHEN n % 17 = 0 THEN 'stale' WHEN n % 7 = 0 THEN 'estimated' ELSE 'good' END,
     'C', 12 + n % 20 FROM generate_series(0, 10079) n;
    CREATE TABLE telemetry.measurement_analytics_v2_5m AS
    SELECT sensor_id, metric, date_bin(interval '5 minutes',observed_at,'1970-01-01'::timestamptz) bucket_start,
     source,quality,canonical_unit,count(*) sample_count,sum(value) sum_value,min(value) minimum,max(value) maximum,
     (array_agg(value ORDER BY observed_at))[1] first_value,min(observed_at) first_at,
     (array_agg(value ORDER BY observed_at DESC))[1] last_value,max(observed_at) last_at
    FROM telemetry.measurement_samples WHERE observed_at < '2026-09-07 23:42:00Z'
    GROUP BY sensor_id,metric,bucket_start,source,quality,canonical_unit;
    CREATE TABLE telemetry.saved AS SELECT * FROM telemetry.measurement_analytics_v2_5m;`);
    const sql = mergeableAnalyticsSql("telemetry", "5m");
    const argsFor = (aggregation: string, quality: string[], real: boolean) => [
      JSON.stringify([{ sensor_id: "room", metric: "temperature", aggregation }]),
      "2026-09-01T00:02:00Z", "2026-09-07T23:59:30Z", quality, "15 minutes", real, "5 minutes",
    ];
    let checks = 0;
    for (const aggregation of ["mean", "sum", "last", "min", "max"]) {
      for (const quality of [["good"], ["good", "estimated"], ["good", "estimated", "stale"]]) {
        for (const real of [true, false]) {
          const args = argsFor(aggregation, quality, real);
          await db.exec(`TRUNCATE telemetry.measurement_analytics_v2_5m;
            INSERT INTO telemetry.measurement_analytics_v2_5m SELECT * FROM telemetry.saved;`);
          const cached = (await db.query(sql, args)).rows;
          await db.exec("TRUNCATE telemetry.measurement_analytics_v2_5m;");
          const raw = (await db.query(sql, args)).rows;
          assert.deepEqual(cached, raw, `${aggregation}/${quality}/${real}`);
          checks++;
        }
      }
    }
    await db.exec("INSERT INTO telemetry.measurement_analytics_v2_5m SELECT * FROM telemetry.saved;");
    const countSql = sql.slice(0, sql.indexOf("), series_counts AS"))
      + ") SELECT count(*) AS rows, sum(sample_count) AS samples FROM source_rows WHERE $5::INTERVAL IS NOT NULL";
    const count = (await db.query<{ rows: string; samples: string }>(
      countSql, argsFor("mean", ["good", "estimated"], false),
    )).rows[0]!;
    assert.equal(Number(count.samples), 10078);
    assert.ok(Number(count.rows) < 6000, JSON.stringify(count));
    assert.equal(checks, 30);
  } finally {
    await db.close();
  }
}, 30_000);

it("discards an unscoped archive rollup and fences a verified demo read across activation", async () => {
  const local = new ClimateDatabase(":memory:");
  try {
    const measurementAnalyticsRollup = vi.fn<NonNullable<ArchiveTelemetryReader["measurementAnalyticsRollup"]>>()
      .mockResolvedValueOnce({ series: [] })
      .mockResolvedValueOnce({ series: [], dataMode: "demo" })
      .mockImplementationOnce(async () => {
        local.activateRealDataMode();
        return { series: [], dataMode: "demo" };
      });
    const archive = {
      measurementAnalyticsRollup,
      measurementHistory: async () => [],
      legacyReadingHistory: async () => [],
      outdoorTemperatureHistory: async () => [],
    };
    const reader = new HybridTelemetryReader({ local, archive });
    const query = {
      series: [], resolution: "15m", qualities: ["good"], dataMode: "demo",
      from: "2026-09-01T00:02:00.000Z", to: "2026-09-01T00:15:00.000Z",
    } as const;
    await expect(reader.measurementAnalyticsRollup(query)).resolves.toBeNull();
    await expect(reader.measurementAnalyticsRollup(query)).resolves.toMatchObject({
      archiveState: "merged", result: { series: [], dataMode: "demo" },
    });
    await expect(reader.measurementAnalyticsRollup(query)).rejects.toMatchObject({ code: "ANALYTICS_DATA_MODE_MISMATCH" });
    expect(measurementAnalyticsRollup).toHaveBeenLastCalledWith({ ...query, excludeSynthetic: false });
  } finally { local.close(); }
});

it("calculates verified display and summary buckets without reading compatibility aggregates", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA telemetry;
      CREATE TABLE telemetry.measurement_samples (
        sensor_id text, metric text, observed_at timestamptz, source text, quality text, canonical_unit text,
        value double precision, data_mode text);
      INSERT INTO telemetry.measurement_samples VALUES
        ('room','temperature','2026-09-01T00:01Z','api','good','C',90,'live'),
        ('room','temperature','2026-09-01T00:02Z','api','good','C',12,'live'),
        ('room','temperature','2026-09-01T00:03Z','api','estimated','C',16,'live'),
        ('room','temperature','2026-09-01T00:04Z','mock','good','C',99,'demo'),
        ('room','temperature','2026-09-01T00:05Z','api','good','C',100,NULL),
        ('room','temperature','2026-09-01T00:06Z','api','stale','C',110,'live'),
        ('room','temperature','2026-09-01T00:15Z','api','good','C',120,'live');`);
    const pool = new FakePool(async ({ text, values }) => queryResult(
      (await db.query<Record<string, unknown>>(text, values)).rows,
    ));
    const store = storeFor(pool);
    const query = {
      from: "2026-09-01T00:02:00.000Z", to: "2026-09-01T00:15:00.000Z",
      resolution: "15m", qualities: ["good", "estimated"], dataMode: "live",
    } as const;
    const expected = { mean: 14, sum: 28, min: 12, max: 16, last: 16 } as const;

    for (const aggregation of Object.keys(expected) as Array<keyof typeof expected>) {
      const series = [{ sensorId: "room", metric: "temperature", aggregation }];
      const result = await store.measurementAnalyticsRollup({ ...query, series, summary: { resolution: "1m", series } });
      assert.equal(result.dataMode, "live");
      assert.equal(result.series[0]?.sampleCount, 2);
      assert.equal(result.series[0]?.excludedSampleCount, 1);
      assert.equal(result.series[0]?.buckets[0]?.value, expected[aggregation]);
      assert.deepEqual(result.summary?.series[0]?.buckets.map(({ value }) => value), [12, 16]);
    }
    const series = [{ sensorId: "room", metric: "temperature", aggregation: "mean" }] as const;
    const demo = await store.measurementAnalyticsRollup({ ...query, dataMode: "demo", series });
    assert.equal(demo.series[0]?.sampleCount, 1);
    assert.equal(demo.series[0]?.excludedSampleCount, 0);
    assert.equal(demo.series[0]?.buckets[0]?.value, 99);

  } finally {
    await db.close();
  }
}, 30_000);
