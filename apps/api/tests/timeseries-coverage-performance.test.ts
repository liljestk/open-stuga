import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { buildBaseSchemaSql } from "../src/timeseries/schema.js";
import { FakePool, queryResult, storeFor } from "./timeseries-store-test-support.js";

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  Plans?: PlanNode[];
}

function measurementRowsRead(node: PlanNode): number {
  return (node["Relation Name"] === "measurement_samples"
    ? (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)) * node["Actual Loops"] : 0)
    + (node.Plans ?? []).reduce((sum, child) => sum + measurementRowsRead(child), 0);
}

describe("archive coverage boundary probes", () => {
  it("preserves boundaries and source filtering without aggregating the full retained history", async () => {
    const db = new PGlite();
    try {
      for (const sql of buildBaseSchemaSql("telemetry")) await db.exec(sql);
      await db.exec(`INSERT INTO telemetry.measurement_samples
        (sensor_id, metric, observed_at, source, quality, canonical_unit, value)
        SELECT 'meter', metric, TIMESTAMPTZ '2026-01-01T00:00:00Z' + n * INTERVAL '1 minute',
          'tp-link', 'good', 'W', n
        FROM generate_series(0, 49999) AS n CROSS JOIN unnest(ARRAY['energy','power']) AS metric;
        INSERT INTO telemetry.measurement_samples
        (sensor_id, metric, observed_at, source, quality, canonical_unit, value) VALUES
          ('meter','power','2025-01-01T00:00:00Z','mock','good','W',1),
          ('meter','power','2027-01-01T00:00:00Z','replay','good','W',1),
          ('synthetic-only','power','2026-01-01T00:00:00Z','mock','good','W',1),
          ('single','power','2026-01-02T00:00:00Z','home-assistant','good','W',1);
        ANALYZE telemetry.measurement_samples;`);
      let coverageSql = "";
      let coverageValues: unknown[] = [];
      const pool = new FakePool(async ({ text, values }) => {
        if (!text.includes("AS coverage_start")) return queryResult();
        coverageSql = text;
        coverageValues = values;
        return queryResult((await db.query<Record<string, unknown>>(text, values)).rows);
      });
      const store = storeFor(pool);
      const input = {
        sensorIds: ["meter", "meter", "missing", "synthetic-only", "single"],
        metrics: ["energy", "power", "power"],
      };
      const all = await store.measurementCoverage(input);
      expect(all).toEqual([
        { sensorId: "meter", metric: "energy", start: "2026-01-01T00:00:00.000Z", end: "2026-02-04T17:19:00.000Z" },
        { sensorId: "meter", metric: "power", start: "2025-01-01T00:00:00.000Z", end: "2027-01-01T00:00:00.000Z" },
        { sensorId: "single", metric: "power", start: "2026-01-02T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z" },
        { sensorId: "synthetic-only", metric: "power", start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T00:00:00.000Z" },
      ]);
      const real = await store.measurementCoverage({ ...input, excludeSynthetic: true });
      expect(real).toEqual([
        all[0], { ...all[0], metric: "power" }, all[2],
      ]);
      const explain = async (sql: string, values: unknown[]) => {
        const result = await db.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, values);
        return measurementRowsRead(result.rows[0]!["QUERY PLAN"][0]!.Plan);
      };
      // The original grouped aggregation reads every retained row before a
      // 24-hour or 30-day energy summary can start its actual cost queries.
      const originalRows = await explain(`SELECT sensor_id, metric,
        MIN(observed_at) AS coverage_start, MAX(observed_at) AS coverage_end
        FROM telemetry.measurement_samples
        WHERE sensor_id = ANY($1::text[]) AND metric = ANY($2::text[])
          AND source NOT IN ('mock','replay') GROUP BY sensor_id, metric`, coverageValues);
      expect(originalRows).toBeGreaterThanOrEqual(100_000);
      expect(await explain(coverageSql, coverageValues)).toBeLessThanOrEqual(24);
      await expect(store.measurementCoverage({ sensorIds: [], metrics: ["power"] })).resolves.toEqual([]);
    } finally { await db.close(); }
  }, 30_000);
});
