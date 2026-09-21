import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { it } from "vitest";
import { mergeableAnalyticsSql } from "../src/timeseries/store/measurement-analytics-rollup-sql.js";

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