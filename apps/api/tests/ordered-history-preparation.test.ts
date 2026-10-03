import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBaseSchemaSql } from "../src/timeseries/schema.js";
import { RollupsMaterializingError } from "../src/timeseries/read-support.js";
import { FakePool, queryResult, storeFor } from "./timeseries-store-test-support.js";

const FROM = "2025-09-03T00:00:00.000Z";
const TO = "2026-09-03T00:00:00.000Z";
const DAYS = ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"];

describe("ordered history preparation bounds", () => {
  const db = new PGlite();
  const store = storeFor(new FakePool(async ({ text, values }) => {
    const result = await db.query<Record<string, unknown>>(text, values);
    return queryResult(result.rows, result.affectedRows);
  }));

  beforeAll(async () => {
    for (const sql of buildBaseSchemaSql("telemetry")) await db.exec(sql);
    await db.exec(`CREATE TABLE telemetry.measurement_analytics_v2_1h (
      sensor_id text, metric text, bucket_start timestamptz, source text, quality text, sample_count bigint);
      INSERT INTO telemetry.measurement_samples
        (sensor_id,metric,observed_at,source,quality,canonical_unit,value)
      SELECT sensor_id, metric, observed_at, 'api', 'good', unit, value
      FROM (VALUES ('cost-meter'),('chart-meter')) AS meters(sensor_id)
      CROSS JOIN (VALUES ('energy','kWh',10),('power','W',100)) AS metrics(metric,unit,value)
      CROSS JOIN (VALUES (TIMESTAMPTZ '2026-09-01T12:00:00Z'),
        (TIMESTAMPTZ '2026-09-02T12:00:00Z')) AS times(observed_at);
      INSERT INTO telemetry.measurement_samples
        (sensor_id,metric,observed_at,source,quality,canonical_unit,value) VALUES
        ('cost-meter','energy','2025-09-03T00:00:00Z','mock','good','kWh',1),
        ('cost-meter','energy','2026-09-02T23:59:00Z','api','stale','kWh',1000),
        ('chart-meter','energy','2025-09-03T00:00:00Z','mock','good','kWh',1),
        ('chart-meter','energy','2026-09-02T23:59:00Z','api','stale','kWh',1000);`);
  }, 30_000);
  afterAll(async () => { await db.close(); });

  const requestedDays = async (sensorId: string) => (
    await db.query<{ day_start: Date }>(`SELECT DISTINCT day_start
      FROM telemetry.measurement_ordered_rollup_dirty WHERE sensor_id = $1 ORDER BY day_start`, [sensorId])
  ).rows.map((row) => row.day_start.toISOString());

  it("prepares only recorded days for a year of cost, excluding synthetic and stale boundaries", async () => {
    await expect(store.energyCostAggregate({
      sensorId: "cost-meter", propertyId: "property-a", from: FROM, to: TO, excludeSynthetic: true,
    })).rejects.toBeInstanceOf(RollupsMaterializingError);
    expect(await requestedDays("cost-meter")).toEqual(DAYS);
  });

  it("prepares only recorded days for a year chart and keeps preparation retryable", async () => {
    await expect(store.measurementAnalyticsRollup({
      series: [{ sensorId: "chart-meter", metric: "energy", aggregation: "delta" }],
      from: FROM, to: TO, resolution: "1d", qualities: ["good", "estimated"], excludeSynthetic: true,
    })).rejects.toBeInstanceOf(RollupsMaterializingError);
    expect(await requestedDays("chart-meter")).toEqual(DAYS);
  });

  it("does not enqueue a year of work for a meter with no recorded history", async () => {
    await expect(store.powerCostAggregate({
      sensorId: "empty-meter", propertyId: "property-a", from: FROM, to: TO, excludeSynthetic: true,
    })).resolves.toMatchObject({ consumptionKwh: 0, deltaCount: 0 });
    expect(await requestedDays("empty-meter")).toEqual([]);
  });

  it("retains internal counter gaps and bounded power holds across midnight", async () => {
    await db.exec(`INSERT INTO telemetry.measurement_samples
      (sensor_id,metric,observed_at,source,quality,canonical_unit,value) VALUES
      ('gap-meter','energy','2026-08-30T12:00:00Z','api','good','kWh',10),
      ('gap-meter','energy','2026-09-01T12:00:00Z','api','estimated','kWh',12),
      ('hold-meter','power','2026-09-01T23:59:00Z','api','good','W',100),
      ('hold-meter','power','2027-01-01T00:00:00Z','api','good','W',100);`);
    await store.enqueueMeasurementOrderedRollups([
      { sensorId: "gap-meter", metric: "energy", aggregation: "delta" },
      { sensorId: "hold-meter", metric: "power", aggregation: "time_weighted_mean" },
    ], FROM, TO, 3, "real", 900);
    expect(await requestedDays("gap-meter")).toEqual([
      "2026-08-30T00:00:00.000Z", "2026-08-31T00:00:00.000Z", DAYS[0],
    ]);
    expect(await requestedDays("hold-meter")).toEqual(DAYS);
  });
});
