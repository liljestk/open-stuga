import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBaseSchemaSql } from "../src/timeseries/schema.js";
import { orderedAnalyticsSql } from "../src/timeseries/store/measurement-analytics-rollup-sql.js";
import { measurementCostRollupSql } from "../src/timeseries/store/measurement-cost-rollup-sql.js";

describe("bounded electricity SQL windows", () => {
  const db = new PGlite();
  beforeAll(async () => {
    await db.exec("SET TIME ZONE 'UTC'");
    for (const sql of buildBaseSchemaSql("telemetry")) await db.exec(sql);
    await db.exec(`CREATE TABLE telemetry.measurement_analytics_v2_1h (
      sensor_id text, metric text, bucket_start timestamptz, source text, quality text, sample_count bigint);
      INSERT INTO telemetry.measurement_samples
        (sensor_id,metric,observed_at,source,quality,canonical_unit,value)
      SELECT 'meter', metric, TIMESTAMPTZ '2026-08-01' + n * INTERVAL '5 minutes',
        'tp-link', 'good', unit, CASE WHEN metric = 'power' THEN 1000 ELSE n / 12.0 END
      FROM generate_series(0, 17570) n
      CROSS JOIN (VALUES ('power','W'),('energy','kWh')) metrics(metric,unit);
      INSERT INTO telemetry.electricity_price_samples
        (property_id,starts_at,ends_at,source,raw_price_cents_per_kwh,margin_cents_per_kwh,fetched_at)
      SELECT 'property', hour, hour + INTERVAL '1 hour' - INTERVAL '1 millisecond', 'api',10,2,hour
      FROM generate_series(TIMESTAMPTZ '2026-08-01', TIMESTAMPTZ '2026-10-01', INTERVAL '1 hour') hour;
      DELETE FROM telemetry.electricity_price_samples WHERE starts_at = TIMESTAMPTZ '2026-09-15 04:00:00Z';
      UPDATE telemetry.electricity_price_samples SET ends_at = TIMESTAMPTZ '2026-09-05 12:10:00Z'
        WHERE starts_at = TIMESTAMPTZ '2026-09-05 12:00:00Z';
      UPDATE telemetry.electricity_price_samples SET ends_at = TIMESTAMPTZ '2026-09-06 06:45:30Z'
        WHERE starts_at = TIMESTAMPTZ '2026-09-06 06:00:00Z';
      INSERT INTO telemetry.electricity_price_samples
        (property_id,starts_at,ends_at,source,raw_price_cents_per_kwh,margin_cents_per_kwh,fetched_at) VALUES
        ('property','2026-09-05 12:10:00Z','2026-09-05 13:00:00Z','api',20,2,'2026-09-05'),
        ('property','2026-09-06 06:45:30Z','2026-09-06 07:00:00Z','api',30,2,'2026-09-06');
      INSERT INTO telemetry.measurement_ordered_rollups (
        algorithm_version,sensor_id,metric,day_start,bucket_start,bucket_seconds,quality_mask,source_scope,
        generation,sample_count,sum_value,minimum,maximum,first_at,first_source,first_value,
        last_at,last_source,last_value,internal_positive_delta,internal_counter_consumption,
        weighted_value_seconds,weighted_seconds,maximum_internal_interval_seconds,canonical_unit_min,canonical_unit_max)
      SELECT 2,'meter',metric,date_bin(INTERVAL '1 day',bucket,TIMESTAMPTZ '1970-01-01'),bucket,seconds,3,'real',1,
        count(*),sum(value),min(value),max(value),min(observed_at),'tp-link',min(value),
        max(observed_at),'tp-link',max(value),max(value)-min(value),max(value)-min(value),
        1000 * EXTRACT(EPOCH FROM (max(observed_at)-min(observed_at))),
        EXTRACT(EPOCH FROM (max(observed_at)-min(observed_at))),
        CASE WHEN count(*) > 1 THEN 300 ELSE 0 END,min(canonical_unit),max(canonical_unit)
      FROM (SELECT sample.*, seconds,
        date_bin(make_interval(secs=>seconds),observed_at,TIMESTAMPTZ '1970-01-01') bucket
        FROM telemetry.measurement_samples sample CROSS JOIN (VALUES (60),(900),(3600)) widths(seconds)) samples
      GROUP BY metric,bucket,seconds;
      INSERT INTO telemetry.measurement_ordered_rollup_generations (sensor_id,metric,day_start,current_seq,synced_seq)
        SELECT DISTINCT sensor_id,metric,day_start,1,1 FROM telemetry.measurement_ordered_rollups;
      INSERT INTO telemetry.measurement_ordered_rollup_dirty
        (sensor_id,metric,day_start,bucket_seconds,quality_mask,source_scope,current_seq,clean_seq)
        SELECT DISTINCT sensor_id,metric,day_start,bucket_seconds,quality_mask,source_scope,1,1
        FROM telemetry.measurement_ordered_rollups;`);
  }, 30_000);
  afterAll(async () => { await db.close(); });

  it.each([
    ["2026-09-01T00:05:00Z", "2026-09-02T00:07:00Z"],
    ["2026-09-02T00:01:00Z", "2026-09-02T00:04:00Z"],
    ["2026-09-01T00:05:00Z", "2026-09-01T00:07:00Z"],
    ["2026-09-01T00:00:00Z", "2026-09-01T00:15:00Z"],
    ["2026-07-01T00:02:00Z", "2026-09-02T00:07:00Z"],
  ])("reads each raw edge once for %s to %s", async (from, to) => {
    const today = Date.parse("2026-09-02T00:00:00Z");
    const sql = orderedAnalyticsSql("telemetry").replaceAll("clock_timestamp()", "TIMESTAMPTZ '2026-09-02T12:00:00Z'");
    const prefix = sql.slice(0, sql.indexOf("), edge_and_current_deduplicated AS ("));
    const args = [JSON.stringify([{ sensor_id: "meter", metric: "power", aggregation: "time_weighted_mean" }]),
      from, to, ["good", "estimated"], "15 minutes", true, 3, 900];
    const actual = (await db.query<{ observed_at: Date }>(prefix + `) SELECT observed_at
      FROM edge_and_current_bucketed WHERE $5::INTERVAL IS NOT NULL AND $7::SMALLINT IS NOT NULL
      ORDER BY observed_at`, args)).rows.map(row => row.observed_at.getTime());
    const fullFrom = Math.ceil(Date.parse(from) / 900000) * 900000;
    const fullTo = Math.floor(Date.parse(to) / 900000) * 900000;
    const expected = (await db.query<{ observed_at: Date }>(`SELECT observed_at FROM telemetry.measurement_samples
      WHERE sensor_id='meter' AND metric='power' AND observed_at >= $1 AND observed_at < $2 ORDER BY observed_at`,
    [from, to])).rows.map(row => row.observed_at.getTime())
      .filter(at => at < fullFrom || at >= fullTo || at >= today);
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
  });

  it.each(["power", "energy"] as const)("keeps exact %s costs with hourly, quarter, minute and raw price edges", async metric => {
    const from = "2026-08-01T00:02:15Z";
    const to = "2026-10-01T00:02:45Z";
    const args = ["meter",from,to,"property",true,metric];
    const sql = measurementCostRollupSql("telemetry", metric);
    const historical = sql.replaceAll("clock_timestamp()", "TIMESTAMPTZ '2026-10-02T00:00:00Z'");
    const raw = sql.replaceAll("clock_timestamp()", "TIMESTAMPTZ '2026-08-01T00:00:00Z'");
    const result = (await db.query<Record<string, unknown>>(historical,args)).rows[0]!;
    const reference = (await db.query<Record<string, unknown>>(raw,args)).rows[0]!;
    expect(result.coverage_complete).toBe(true);
    for (const field of ["consumption_kwh","priced_consumption_kwh","cost_eur","total_duration_ms","priced_duration_ms"]) {
      expect(Number(result[field]), field).toBeCloseTo(Number(reference[field]),6);
    }
    const stop = Date.parse(metric === "power" ? to : "2026-10-01T00:00:00Z");
    expect(Number(result.consumption_kwh)).toBeCloseTo((stop-Date.parse(from))/3600000,6);
    const prices = (await db.query<{ starts_at: Date; ends_at: Date; raw_price_cents_per_kwh: number }>(
      "SELECT starts_at,ends_at,raw_price_cents_per_kwh FROM telemetry.electricity_price_samples WHERE property_id='property'",
    )).rows;
    let expectedCost = 0;
    let pricedKwh = 0;
    for (const price of prices) {
      const end = price.ends_at.getTime();
      const edge = Math.floor((end+1000)/60000)*60000;
      const hours = Math.max(0,Math.min(stop,edge>end ? edge:end)-Math.max(Date.parse(from),price.starts_at.getTime()))/3600000;
      pricedKwh += hours;
      expectedCost += hours*(price.raw_price_cents_per_kwh+2)/100;
    }
    expect(Number(result.priced_consumption_kwh)).toBeCloseTo(pricedKwh,6);
    expect(Number(result.cost_eur)).toBeCloseTo(expectedCost,6);
    // Stale generation metadata must still prevent a result claiming completeness.
    await db.exec("UPDATE telemetry.measurement_ordered_rollup_dirty SET clean_seq=0 WHERE day_start=TIMESTAMPTZ '2026-09-10' AND bucket_seconds=3600");
    expect((await db.query<{ coverage_complete: boolean }>(historical,args)).rows[0]?.coverage_complete).toBe(false);
    await db.exec("UPDATE telemetry.measurement_ordered_rollup_dirty SET clean_seq=1");
  }, 30_000);
});
