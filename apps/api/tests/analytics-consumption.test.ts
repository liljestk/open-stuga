import { PGlite } from "@electric-sql/pglite";
import type { MeasurementSample } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import { analyticsConsumptionBuckets } from "../src/analytics-consumption.js";
import { buildBaseSchemaSql } from "../src/timeseries/schema.js";
import { orderedAnalyticsSql } from "../src/timeseries/store/measurement-analytics-rollup-sql.js";

const day = "2026-09-01T00:00:00.000Z";
const base = Date.parse(day);
const samples = (metric: "energy" | "power", values: Array<[number, number]>): MeasurementSample[] => values.map(([minute, value]) => ({
  sensorId: "meter", metric, value, canonicalUnit: metric === "energy" ? "kWh" : "W",
  timestamp: new Date(base + minute * 60_000).toISOString(), source: "tp-link", quality: "good",
}));

describe("consumption before history aggregation", () => {
  it("keeps resets within and between buckets, including a nonzero post-reset reading", () => {
    for (const values of [[100, 101, 102, 0, 1, 2], [100, 101, 102, 0.5, 1.5, 2.5], [100, 101, 0.5, 1.5, 2.5, 3.5]]) {
      const rows = samples("energy", values.map((value, index) => [index, value]));
      const total = [...analyticsConsumptionBuckets(rows, "energy", 2 * 60_000, base + 6 * 60_000).values()]
        .reduce<number>((sum, value) => sum + (value ?? 0), 0);
      expect(total).toBe(values.includes(0) ? 4 : 4.5);
    }
  });

  it("splits a bounded power hold across empty buckets without covering an hour-long gap", () => {
    const buckets = analyticsConsumptionBuckets(samples("power", [[4, 1000], [64, 0]]), "power", 5 * 60_000, base + 90 * 60_000);
    expect([...buckets.values()].reduce<number>((sum, value) => sum + (value ?? 0), 0)).toBeCloseTo(0.25);
    expect(buckets.get(base + 5 * 60_000)).toBeCloseTo(5 / 60);
    expect(buckets.has(base + 30 * 60_000)).toBe(false);
  });

  it("keeps signed power unavailable through held buckets and retains later positive usage", () => {
    const buckets = analyticsConsumptionBuckets(samples("power", [[4, -1000], [64, 1000]]), "power", 5 * 60_000, base + 90 * 60_000);
    expect(buckets.get(base)).toBeNull();
    expect(buckets.get(base + 10 * 60_000)).toBeNull();
    expect(buckets.has(base + 30 * 60_000)).toBe(false);
    expect(buckets.get(base + 65 * 60_000)).toBeCloseTo(5 / 60);
  });

  it("matches PostgreSQL ordered states to raw consumption, including cached resets and sparse power", async () => {
    const db = new PGlite();
    try {
      for (const sql of buildBaseSchemaSql("telemetry")) await db.exec(sql);
      await db.exec(`CREATE TABLE telemetry.measurement_analytics_v2_1h (
        sensor_id text, metric text, bucket_start timestamptz, source text, quality text, sample_count bigint);`);
      const query = orderedAnalyticsSql("telemetry");
      for (const [metric, input, width, seconds] of [
        ["energy", [100, 101, 102, 0, 1, 2].map((value, index) => [index, value]), 2, 60],
        ["energy", [100, 101, 0.5, 1.5, 2.5, 3.5].map((value, index) => [index, value]), 2, 60],
        ["power", [[4, 1000], [64, 0]], 5, 60],
        ["power", [[4, 1000], [14, 500], [64, 0]], 60, 900],
        ["power", [[4, -1000], [14, 1000]], 60, 900],
        ["power", [[4, 1000], [5, -1000], [6, 1000]], 60, 900],
        ["power", [[4, -1000], [64, 1000]], 5, 60],
        ["power", [[4, -1000], [14, 1000]], 5, 60],
      ] as const) {
        await db.exec(`TRUNCATE telemetry.measurement_samples, telemetry.measurement_ordered_rollups,
          telemetry.measurement_ordered_rollup_dirty, telemetry.measurement_ordered_rollup_generations,
          telemetry.measurement_analytics_v2_1h;`);
        const rows = samples(metric, input.map(([at, value]) => [at, value]));
        for (const row of rows) await db.query(`INSERT INTO telemetry.measurement_samples
          (sensor_id, metric, observed_at, source, quality, canonical_unit, value)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [row.sensorId, row.metric, row.timestamp, row.source, row.quality, row.canonicalUnit, row.value]);
        const args = [JSON.stringify([{ sensor_id: "meter", metric, aggregation: metric === "energy" ? "delta" : "time_weighted_mean" }]),
          day, new Date(base + 90 * 60_000).toISOString(), ["good", "estimated"], `${width} minutes`, true, 3, seconds];
        // Pin the current day for a deterministic uncached/raw execution.
        const rawSql = query.replaceAll("clock_timestamp()", "TIMESTAMPTZ '2026-09-01T12:00:00Z'");
        const raw = (await db.query<{ bucket_start: Date; consumption_kwh: number | null }>(rawSql, args)).rows;
        const expected = analyticsConsumptionBuckets(rows, metric, width * 60_000, base + 90 * 60_000);
        expect(raw.map((row) => [row.bucket_start.getTime(), row.consumption_kwh])).toEqual([...expected]);
        // Persist exactly the states the raw boundary builder produced, then
        // exercise the historical path with all raw samples removed.
        const statesSql = rawSql.slice(0, rawSql.indexOf("), states AS ("))
          + ") SELECT * FROM edge_and_current_states WHERE $5::interval IS NOT NULL AND $7::integer IS NOT NULL";
        const states = (await db.query<Record<string, unknown>>(statesSql, args)).rows;
        for (const state of states) {
          const values = { ...state, algorithm_version: 2, day_start: day, bucket_seconds: seconds,
            quality_mask: 3, source_scope: "real", generation: 1 };
          const keys = Object.keys(values);
          await db.query(`INSERT INTO telemetry.measurement_ordered_rollups (${keys.join(",")})
            VALUES (${keys.map((_, index) => `$${index + 1}`).join(",")})`, Object.values(values));
        }
        await db.query(`INSERT INTO telemetry.measurement_ordered_rollup_generations
          (sensor_id,metric,day_start,current_seq,synced_seq) VALUES ('meter',$1,$2,1,1)`, [metric, day]);
        await db.query(`INSERT INTO telemetry.measurement_ordered_rollup_dirty
          (sensor_id,metric,day_start,bucket_seconds,quality_mask,source_scope,current_seq,clean_seq)
          VALUES ('meter',$1,$2,$3,3,'real',1,1)`, [metric, day, seconds]);
        await db.exec("TRUNCATE telemetry.measurement_samples");
        const cached = (await db.query<{ bucket_start: Date; consumption_kwh: number | null }>(query, args)).rows;
        expect(cached.map((row) => [row.bucket_start.getTime(), row.consumption_kwh])).toEqual([...expected]);
      }
    } finally { await db.close(); }
  }, 30_000);
});
