import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBaseSchemaSql } from "../src/timeseries/schema.js";
import { FakePool, queryResult, storeFor } from "./timeseries-store-test-support.js";

describe("bounded generic bucket provenance", () => {
  const db = new PGlite();
  const pool = new FakePool(async ({ text, values }) => {
    const result = await db.query<Record<string, unknown>>(text, values);
    return queryResult(result.rows, result.affectedRows);
  });
  const store = storeFor(pool);
  beforeAll(async () => {
    await db.exec("SET TIME ZONE 'UTC'");
    for (const sql of buildBaseSchemaSql("telemetry")) await db.exec(sql);
    await db.exec(`INSERT INTO telemetry.measurement_samples
      (sensor_id,metric,observed_at,source,value,canonical_unit,quality,metadata)
      SELECT 'meter','power',TIMESTAMPTZ '2026-09-01' + n * INTERVAL '2 seconds',
        source,(n % 7) * 25,'W',CASE WHEN n % 19 = 0 THEN 'stale' ELSE 'good' END,
        jsonb_build_object('sample',n,'payload',repeat('x',512))
      FROM generate_series(0,12000) n
      CROSS JOIN (VALUES ('api'),('alternate'),('mock'),('replay')) sources(source);
      ANALYZE telemetry.measurement_samples;`);
  }, 30_000);
  afterAll(async () => { await db.close(); });

  it.each([
    ["2026-09-01T00:00:07Z", "2026-09-01T06:00:00Z", 900, 3, true],
    ["2026-09-01T00:00:07Z", "2026-09-01T00:15:00Z", 900, 20, false],
    ["2026-09-01T00:00:02Z", "2026-09-01T00:00:02Z", 15, 20, true],
  ] as const)("retains means, ties, exact boundaries and metadata for %s to %s", async (from, to, seconds, limit, real) => {
    const actual = await store.measurementHistoryBucketed({
      sensorId: "meter", metric: "power", from, to, bucketSeconds: seconds, limit, excludeSynthetic: real,
    });
    const expected = (await db.query<Record<string, unknown>>(`WITH buckets AS (
      SELECT date_bin(make_interval(secs=>$3::INT),observed_at,TIMESTAMPTZ '1970-01-01') at,
        avg(value)::DOUBLE PRECISION value,
        (array_agg(source ORDER BY observed_at DESC,source DESC))[1] source,
        (array_agg(canonical_unit ORDER BY observed_at DESC,source DESC))[1] unit,
        CASE WHEN count(*) > 1 THEN 'estimated'
          ELSE (array_agg(quality ORDER BY observed_at DESC,source DESC))[1] END quality,
        (array_agg(metadata ORDER BY observed_at DESC,source DESC))[1] metadata
      FROM telemetry.measurement_samples WHERE sensor_id='meter' AND metric='power'
        AND observed_at >= $1 AND observed_at <= $2
        AND (NOT $5::BOOLEAN OR source NOT IN ('mock','replay'))
      GROUP BY at ORDER BY at DESC LIMIT $4
    ) SELECT * FROM buckets ORDER BY at`, [from,to,seconds,limit,real])).rows;
    expect(actual).toEqual(expected.map(row => ({
      sensorId: "meter", metric: "power", timestamp: (row.at as Date).toISOString(),
      value: row.value, canonicalUnit: row.unit, source: row.source, quality: row.quality, metadata: row.metadata,
    })));
    const samplesOnly = await store.measurementHistoryBucketed({
      sensorId: "meter", metric: "power", from, to, bucketSeconds: seconds, limit,
      excludeSynthetic: real, includeMetadata: false,
    });
    expect(samplesOnly).toEqual(actual.map(sample => ({ ...sample, metadata: {} })));
  });

  it("never reads the compressed metadata column for sample-only projections", async () => {
    await store.measurementHistoryBucketed({
      sensorId: "meter", metric: "power", from: "2026-09-01", to: "2026-09-02",
      bucketSeconds: 900, limit: 3, excludeSynthetic: true, includeMetadata: false,
    });
    const query = pool.queries.findLast(item => item.text.includes("recent_buckets AS"))!;
    const explain = (await db.query<Record<string, unknown>>(
      `EXPLAIN (VERBOSE, FORMAT JSON) ${query.text}`, query.values,
    )).rows[0]!["QUERY PLAN"] as Array<{ Plan: Record<string, unknown> }>;
    const visit = (node: Record<string, unknown>): void => {
      if (String(node["Node Type"]).includes("Scan")) {
        expect(String(node.Output)).not.toMatch(/(?:measurement_samples|latest_rows)\.metadata/);
      }
      for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) visit(child);
    };
    visit(explain[0]!.Plan);
  });

  it("keeps wide metadata out of sorts over the dense historical input", async () => {
    await store.measurementHistoryBucketed({
      sensorId: "meter", metric: "power", from: "2026-09-01", to: "2026-09-02",
      bucketSeconds: 900, limit: 3, excludeSynthetic: true,
    });
    const query = pool.queries.findLast(item => item.text.includes("recent_buckets AS"))!;
    const explain = (await db.query<Record<string, unknown>>(
      `EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON) ${query.text}`, query.values,
    )).rows[0]!["QUERY PLAN"] as Array<{ Plan: Record<string, unknown> }>;
    const visit = (node: Record<string, unknown>): void => {
      if (node["Node Type"] === "Sort" && String(node.Output).includes("metadata")) {
        // The fixture has two real sources tied at each latest timestamp.
        expect(Number(node["Actual Rows"]), "wide payload sort must be bounded by returned provenance candidates")
          .toBeLessThanOrEqual(3 * 2);
      }
      for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) visit(child);
    };
    visit(explain[0]!.Plan);
  });

  it("does not sort every dense input row to aggregate the bucket means", async () => {
    await store.measurementHistoryBucketed({
      sensorId: "meter", metric: "power", from: "2026-09-01", to: "2026-09-02",
      bucketSeconds: 900, limit: 3, excludeSynthetic: true,
    });
    const query = pool.queries.findLast(item => item.text.includes("recent_buckets AS"))!;
    const explain = (await db.query<Record<string, unknown>>(
      `EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON) ${query.text}`, query.values,
    )).rows[0]!["QUERY PLAN"] as Array<{ Plan: Record<string, unknown> }>;
    const maximumBuckets = 24 * 60 * 60 / 900 + 1;
    const visit = (node: Record<string, unknown>): void => {
      const children = (node.Plans ?? []) as Array<Record<string, unknown>>;
      if (node["Node Type"] === "Sort") {
        for (const child of children) {
          expect(Number(child["Actual Rows"]), "sort input must be buckets or bounded provenance rows")
            .toBeLessThanOrEqual(maximumBuckets);
        }
      }
      for (const child of children) visit(child);
    };
    visit(explain[0]!.Plan);
  });

  it("retains the quality and provenance of a bucket with one sample", async () => {
    await db.exec(`INSERT INTO telemetry.measurement_samples
      (sensor_id,metric,observed_at,source,value,canonical_unit,quality,metadata)
      VALUES ('single','power','2026-09-01T00:00:02Z','api',12.5,'W','good','{"only":true}'),
        ('other','power','2026-09-01T00:00:02Z','zzzz',999,'W','estimated','{"wrong":true}'),
        ('single','energy','2026-09-01T00:00:02Z','zzzz',999,'kWh','estimated','{"wrong":true}')`);
    expect(await store.measurementHistoryBucketed({
      sensorId: "single", metric: "power", from: "2026-09-01", to: "2026-09-02",
      bucketSeconds: 900, limit: 3, excludeSynthetic: true,
    })).toEqual([{
      sensorId: "single", metric: "power", timestamp: "2026-09-01T00:00:00.000Z",
      value: 12.5, canonicalUnit: "W", source: "api", quality: "good", metadata: { only: true },
    }]);
  });
});
