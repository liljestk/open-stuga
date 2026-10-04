import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBaseSchemaSql } from "../src/timeseries/schema.js";
import { FakePool, queryResult, storeFor } from "./timeseries-store-test-support.js";

describe("closed-day rollup replacement", () => {
  const db = new PGlite();
  const pool = new FakePool(async ({ text, values }) => {
    const result = await db.query<Record<string, unknown>>(text, values);
    return queryResult(result.rows, result.affectedRows);
  });
  const store = storeFor(pool);
  beforeAll(async () => {
    await db.exec("SET TIME ZONE 'UTC'");
    for (const sql of buildBaseSchemaSql("telemetry")) await db.exec(sql);
    await db.exec(`ALTER TABLE telemetry.measurement_ordered_rollups RENAME TO rollups_shape;
      CREATE TABLE telemetry.measurement_ordered_rollups
        (LIKE telemetry.rollups_shape INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
        PARTITION BY RANGE (bucket_start);
      CREATE TABLE telemetry.rollup_august PARTITION OF telemetry.measurement_ordered_rollups
        FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
      CREATE TABLE telemetry.rollup_september PARTITION OF telemetry.measurement_ordered_rollups
        FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
      CREATE TABLE telemetry.rollup_october PARTITION OF telemetry.measurement_ordered_rollups
        FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
      INSERT INTO telemetry.measurement_samples
        (sensor_id,metric,observed_at,source,value,canonical_unit,quality)
      SELECT 'meter','power',TIMESTAMPTZ '2026-09-02' + n * INTERVAL '5 minutes','api',1000,'W','good'
      FROM generate_series(0,12) n;`);
    await store.enqueueMeasurementOrderedRollups([
      { sensorId: "meter", metric: "power", aggregation: "time_weighted_mean" },
    ], "2026-09-02", "2026-09-03", 3, "real", 900);
  }, 30_000);
  afterAll(async () => { await db.close(); });

  it("rebuilds a closed day and prunes every unrelated time partition", async () => {
    await expect(store.rebuildNextMeasurementOrderedRollup({ timeoutMs: 15_000 }))
      .resolves.toMatchObject({ processed: true, stale: false, generatedRows: 5 });
    const current = (await db.query<Record<string, unknown>>(`SELECT clean_seq,current_seq,last_error
      FROM telemetry.measurement_ordered_rollup_dirty WHERE sensor_id='meter'`)).rows[0]!;
    expect(current.clean_seq).toBe(current.current_seq);
    expect(current.last_error).toBeNull();
    const totals = (await db.query<Record<string, unknown>>(`SELECT sum(sample_count) samples,
      sum(sum_value) sum_value FROM telemetry.measurement_ordered_rollups`)).rows[0]!;
    expect(Number(totals.samples)).toBe(13);
    expect(Number(totals.sum_value)).toBe(13000);
    const deletion = pool.queries.find(item => item.text.startsWith("DELETE FROM")
      && item.text.includes("measurement_ordered_rollups"))!;
    const plan = (await db.query<Record<string, unknown>>(
      `EXPLAIN (FORMAT JSON) ${deletion.text}`, deletion.values,
    )).rows[0]!["QUERY PLAN"] as Array<{ Plan: Record<string, unknown> }>;
    const relations = new Set<string>();
    const visit = (node: Record<string, unknown>): void => {
      const relation = node["Relation Name"];
      if (typeof relation === "string" && relation.startsWith("rollup_")) relations.add(relation);
      for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) visit(child);
    };
    visit(plan[0]!.Plan);
    expect([...relations]).toEqual(["rollup_september"]);
  });
});
