import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import { analyticsConsumptionBuckets } from "../src/analytics/query/consumption.js";
import { buildBaseSchemaSql } from "../src/timeseries/schema.js";
import { orderedAnalyticsSql } from "../src/timeseries/store/measurement-analytics-rollup-sql.js";
import type { MeasurementSample } from "@climate-twin/contracts";
import { FakePool, queryResult, storeFor } from "./timeseries-store-test-support.js";

const day = "2026-09-01T00:00:00.000Z";
const base = Date.parse(day);
const at = (minute: number) => new Date(base + minute * 60_000).toISOString();

describe("consumption range anchors", () => {
  it.each(["energy", "power"] as const)("limits ordered %s samples and consumption anchors to verified mode", async (metric) => {
    const db = new PGlite();
    try {
      // Deliberately omit the compatibility aggregates and ordered cache.
      await db.exec(`CREATE SCHEMA telemetry;
        CREATE TABLE telemetry.measurement_samples (
          sensor_id text, metric text, observed_at timestamptz, source text, quality text, canonical_unit text,
          value double precision, data_mode text, ingested_at timestamptz NOT NULL DEFAULT clock_timestamp()
        );`);
      const values = metric === "energy" ? [100, 102, 0.5, 1.5] : [1000, 2000, 0, 0];
      const rows: MeasurementSample[] = [0, 10, 20, 35].map((minute, index) => ({
        sensorId: "meter", metric, value: values[index]!, canonicalUnit: metric === "energy" ? "kWh" : "W",
        timestamp: at(minute), source: "api", quality: "good",
      }));
      for (const row of rows) await db.query(`INSERT INTO telemetry.measurement_samples
        (sensor_id,metric,observed_at,source,quality,canonical_unit,value,data_mode)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'live')`, [row.sensorId, row.metric, row.timestamp, row.source, row.quality, row.canonicalUnit, row.value]);
      const unit = rows[0]!.canonicalUnit;
      await db.query(`INSERT INTO telemetry.measurement_samples
        (sensor_id,metric,observed_at,source,quality,canonical_unit,value,data_mode) VALUES
        ('meter',$1,$3,'tp-link','good',$2,600,NULL),
        ('meter',$1,$4,'tp-link','good',$2,600,NULL),
        ('meter',$1,$5,'tp-link','good',$2,600,NULL),
        ('meter',$1,$6,'mock','stale',$2,600,'demo'),
        ('meter',$1,$7,'api','stale',$2,600,'live')`, [metric, unit, at(4), at(10), at(35), at(22), at(23)]);
      const pool = new FakePool(async ({ text, values: args }) => queryResult(
        (await db.query<Record<string, unknown>>(text, args)).rows,
      ));
      const store = storeFor(pool);
      const aggregation = metric === "energy" ? "delta" : "time_weighted_mean";
      const series = [{ sensorId: "meter", metric, aggregation }] as const;
      const query = { series, from: at(5), to: at(35), resolution: "15m",
        qualities: ["good", "estimated"], dataMode: "live" } as const;
      const read = await store.measurementAnalyticsRollup({ ...query, summary: { resolution: "1h", series } });
      const expected = [...analyticsConsumptionBuckets(rows, metric, 900_000, base + 35 * 60_000, base + 5 * 60_000)];
      expect(read.dataMode).toBe("live");
      expect(read.series[0]).toMatchObject({ sampleCount: 2, excludedSampleCount: 1 });
      expect(read.series[0]!.buckets.map((bucket) => [Date.parse(bucket.bucketStart), bucket.consumptionKwh])).toEqual(expected);
      expect(read.summary?.series[0]?.sampleCount).toBe(2);
      const demo = await store.measurementAnalyticsRollup({ ...query, dataMode: "demo" });
      expect(demo.series[0]).toMatchObject({ sampleCount: 0, excludedSampleCount: 1, buckets: [] });
      expect(pool.queries.every(({ text }) => !/measurement_ordered_rollup|measurement_analytics_v2/u.test(text))).toBe(true);
    } finally { await db.close(); }
  }, 30_000);

  it("uses indexed scoped seeks, excludes stale/synthetic anchors and retains simultaneous conflicts", () => {
    const database = new ClimateDatabase(":memory:");
    try {
      database.db.exec("DELETE FROM measurement_samples");
      const insert = database.db.prepare(`INSERT INTO measurement_samples
        (sensor_id,metric,value,canonical_unit,timestamp,source,quality)
        VALUES ('sensor-01','energy',?,'kWh',?,?,?)`);
      insert.run(100, at(0), "api", "good");
      insert.run(101, at(0), "tp-link", "good");
      insert.run(999, at(4), "mock", "good");
      insert.run(999, at(3), "api", "stale");
      insert.run(103, at(35), "api", "good");
      const prepare = database.db.prepare.bind(database.db);
      let sql = "";
      const spy = vi.spyOn(database.db, "prepare").mockImplementation((statement) => { sql = statement; return prepare(statement); });
      const rows = database.measurementBoundarySamples({ sensorId: "sensor-01", metric: "energy",
        from: at(5), to: at(35), qualities: ["good", "estimated"], excludeSynthetic: true });
      spy.mockRestore();
      expect(rows.map((row) => row.value).sort((left, right) => left - right)).toEqual([100, 101, 103]);
      const plan = database.db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array(sql.match(/\?/g)?.length ?? 0).fill(null)).map((row) => String(row.detail)).join("\n");
      expect(plan).not.toMatch(/SCAN measurement_samples\b/);
      expect(plan).toMatch(/sensor_id=\? AND metric=\? AND timestamp<\?/);
    } finally { database.close(); }
  });

  it.each(["energy", "power"] as const)("matches raw and cached PostgreSQL %s consumption at a partial opening bucket and exact range end", async (metric) => {
    const db = new PGlite();
    try {
      for (const sql of buildBaseSchemaSql("telemetry")) await db.exec(sql);
      await db.exec(`CREATE TABLE telemetry.measurement_analytics_v2_1h (
        sensor_id text, metric text, bucket_start timestamptz, source text, quality text, sample_count bigint)`);
      const values = metric === "energy" ? [100, 102, 0.5, 1.5] : [1000, 2000, 0, 0];
      const rows: MeasurementSample[] = [0, 10, 20, 35].map((minute, index) => ({
        sensorId: "meter", metric, value: values[index]!, canonicalUnit: metric === "energy" ? "kWh" : "W",
        timestamp: at(minute), source: "api", quality: "good",
      }));
      for (const row of rows) await db.query(`INSERT INTO telemetry.measurement_samples
        (sensor_id,metric,observed_at,source,quality,canonical_unit,value)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [row.sensorId, row.metric, row.timestamp, row.source, row.quality, row.canonicalUnit, row.value]);
      const args = [JSON.stringify([{ sensor_id: "meter", metric, aggregation: metric === "energy" ? "delta" : "time_weighted_mean" }]),
        at(5), at(35), ["good", "estimated"], "15 minutes", true, 3, 900];
      const sql = orderedAnalyticsSql("telemetry");
      const currentSql = sql.replaceAll("clock_timestamp()", "TIMESTAMPTZ '2026-09-01T12:00:00Z'");
      const expected = [...analyticsConsumptionBuckets(rows, metric, 900_000, base + 35 * 60_000, base + 5 * 60_000)];
      const verify = async (querySql: string) => {
        const result = (await db.query<{ bucket_start: Date; consumption_kwh: number; included_sample_count: number }>(querySql, args)).rows;
        expect(result.map((row) => [row.bucket_start.getTime(), row.consumption_kwh])).toEqual(expected);
        expect(result.every((row) => Number(row.included_sample_count) === 2)).toBe(true);
      };
      await verify(currentSql);
      const statesSql = currentSql.slice(0, currentSql.indexOf("), states AS ("))
        + ") SELECT * FROM edge_and_current_states WHERE $5::interval IS NOT NULL AND $7::integer IS NOT NULL";
      for (const state of (await db.query<Record<string, unknown>>(statesSql, args)).rows) {
        const record = { ...state, algorithm_version: 2, day_start: day, bucket_seconds: 900,
          quality_mask: 3, source_scope: "real", generation: 1 };
        const keys = Object.keys(record);
        await db.query(`INSERT INTO telemetry.measurement_ordered_rollups (${keys.join(",")})
          VALUES (${keys.map((_, index) => `$${index + 1}`).join(",")})`, Object.values(record));
      }
      await db.query(`INSERT INTO telemetry.measurement_ordered_rollup_generations
        (sensor_id,metric,day_start,current_seq,synced_seq) VALUES ('meter',$1,$2,1,1)`, [metric, day]);
      await db.query(`INSERT INTO telemetry.measurement_ordered_rollup_dirty
        (sensor_id,metric,day_start,bucket_seconds,quality_mask,source_scope,current_seq,clean_seq)
        VALUES ('meter',$1,$2,900,3,'real',1,1)`, [metric, day]);
      // Full interior buckets come from cached states; only the partial edge
      // and the indexed outside anchors remain in the raw table.
      await db.query("DELETE FROM telemetry.measurement_samples WHERE observed_at = $1::TIMESTAMPTZ", [at(20)]);
      await verify(sql);
    } finally { await db.close(); }
  }, 30_000);
});
