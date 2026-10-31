import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RollupsMaterializingError } from "../src/timeseries/read-support.js";
import { buildBaseSchemaSql } from "../src/timeseries/schema.js";
import type { MeasurementAnalyticsRollupQuery } from "../src/timeseries/types.js";
import { FakePool, queryResult, storeFor } from "./timeseries-store-test-support.js";

/*
 * One analytics query reads each ordered series once: its display buckets and
 * the base buckets its summary needs are re-bucketed from the same stored
 * states, and a read whose variants are prepared and clean writes nothing.
 * Excluded-sample counts take the active day's settled hours from the 1h
 * aggregate; a planted sample proves which path a count took.
 */
const DAY = "2026-09-03T00:00:00.000Z";
const NOW = "2026-09-03T13:47:00.000Z";
const CLOCK = `TIMESTAMPTZ '${NOW}'`;
const FROM = "2026-09-01T00:07:00.000Z";
const ORDERED_READ = "summary_width INTERVAL)";
const ENQUEUE = "INSERT INTO \"telemetry\".\"measurement_ordered_rollup_dirty\" AS dirty";

describe("ordered analytics read path", () => {
  const db = new PGlite();
  const statements: string[] = [];
  const store = storeFor(new FakePool(async ({ text, values }) => {
    statements.push(text);
    const result = await db.query<Record<string, unknown>>(text.replaceAll("clock_timestamp()", CLOCK), values);
    return queryResult(result.rows, result.affectedRows);
  }));
  const power = { sensorId: "meter", metric: "power", aggregation: "time_weighted_mean" } as const;
  const energy = { sensorId: "counter", metric: "energy", aggregation: "delta" } as const;
  const temperature = { sensorId: "probe", metric: "temperature", aggregation: "time_weighted_mean" } as const;
  const query = (overrides: Partial<MeasurementAnalyticsRollupQuery> = {}): MeasurementAnalyticsRollupQuery => ({
    series: [power, energy], from: FROM, to: NOW, resolution: "1h",
    qualities: ["good", "estimated"], excludeSynthetic: true, ...overrides,
  });
  const drain = async () => {
    while ((await store.rebuildNextMeasurementOrderedRollup({ timeoutMs: 15_000 })).processed) { /* drain */ }
  };
  const settled = async (input: MeasurementAnalyticsRollupQuery) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await store.measurementAnalyticsRollup(input).catch((error: unknown) => {
        if (error instanceof RollupsMaterializingError) return null;
        throw error;
      });
      if (result && (!input.summary || result.summary)) return result;
      await drain();
    }
    throw new Error("rollups did not settle");
  };
  const counted = (marker: string) => statements.filter((text) => text.includes(marker)).length;
  /** Materializes the 1h count aggregate for hours that start before `until`. */
  const refreshHourlyCounts = (until: string) => db.exec(`TRUNCATE telemetry.measurement_analytics_v2_1h;
    INSERT INTO telemetry.measurement_analytics_v2_1h
    SELECT sensor_id, metric, date_bin(INTERVAL '1 hour', observed_at, TIMESTAMPTZ '1970-01-01 00:00:00+00'),
      source, quality, count(*)
    FROM telemetry.measurement_samples WHERE observed_at < TIMESTAMPTZ '${until}'
    GROUP BY 1, 2, 3, 4, 5`);
  const staleSamples = async (sensorId: string) => Number((await db.query<{ count: number }>(`SELECT count(*)::INTEGER AS count
    FROM telemetry.measurement_samples WHERE sensor_id = $1 AND quality = 'stale'
      AND observed_at >= $2 AND observed_at < $3`, [sensorId, FROM, NOW])).rows[0]!.count);

  beforeAll(async () => {
    await db.exec("SET TIME ZONE 'UTC'");
    for (const sql of buildBaseSchemaSql("telemetry")) await db.exec(sql);
    await db.exec(`CREATE TABLE telemetry.measurement_analytics_v2_1h (
        sensor_id text, metric text, bucket_start timestamptz, source text, quality text, sample_count bigint);
      INSERT INTO telemetry.measurement_samples
        (sensor_id,metric,observed_at,source,quality,canonical_unit,value)
      SELECT 'meter', 'power', TIMESTAMPTZ '2026-09-01T00:00:00Z' + n * INTERVAL '1 minute', 'tp-link',
        CASE WHEN n % 17 = 0 THEN 'stale' WHEN n % 11 = 0 THEN 'estimated' ELSE 'good' END, 'W',
        round(500 + 400 * sin(n / 37.0))
      FROM generate_series(0, 3706) n;
      INSERT INTO telemetry.measurement_samples
        (sensor_id,metric,observed_at,source,quality,canonical_unit,value)
      SELECT 'counter', 'energy', TIMESTAMPTZ '2026-09-01T00:00:00Z' + n * INTERVAL '5 minutes', 'tp-link',
        CASE WHEN n % 13 = 0 THEN 'stale' ELSE 'good' END, 'kWh', n * 0.02
      FROM generate_series(0, 741) n;
      INSERT INTO telemetry.measurement_samples
        (sensor_id,metric,observed_at,source,quality,canonical_unit,value)
      SELECT 'probe', 'temperature', TIMESTAMPTZ '2026-09-01T00:00:00Z' + n * INTERVAL '2 minutes', 'api',
        'good', '°C', 20 + sin(n / 50.0)
      FROM generate_series(0, 1853) n;`);
    await refreshHourlyCounts(NOW);
  }, 30_000);
  afterAll(async () => { await db.close(); });
  beforeEach(() => { statements.length = 0; });

  it("re-buckets an ordered series for display and summary in one pass", async () => {
    const summary = { resolution: "15m", series: [power] } as const;
    await settled(query({ summary }));
    statements.length = 0;
    const combined = await store.measurementAnalyticsRollup(query({ summary }));
    expect(counted(ORDERED_READ)).toBe(1);
    expect(counted(ENQUEUE)).toBe(0);

    const display = await settled(query());
    const separate = await settled(query({ series: [power], resolution: "15m" }));
    expect(combined.series).toEqual(display.series);
    expect(combined.summary).toEqual({ resolution: "15m", series: separate.series });
    expect(combined.summary?.series[0]!.buckets.length).toBeGreaterThan(combined.series[0]!.buckets.length);
  });

  it("reads a summary separately when it needs a narrower stored variant", async () => {
    // A time-weighted mean keeps hour-wide states for an hourly display, but
    // quarter-hour base buckets need quarter-hour states.
    const input = query({ series: [temperature], summary: { resolution: "15m", series: [temperature] } });
    await settled(input);
    statements.length = 0;
    const combined = await store.measurementAnalyticsRollup(input);
    expect(counted(ORDERED_READ)).toBe(2);

    const separate = await settled(query({ series: [temperature], resolution: "15m" }));
    expect(combined.summary).toEqual({ resolution: "15m", series: separate.series });
  });

  it("enqueues only variants that are missing or not clean", async () => {
    // A quality mask no other test reads, so its stored variant starts missing.
    const pastDays = query({ series: [power], resolution: "1d", to: DAY, qualities: ["good"] });
    await expect(store.measurementAnalyticsRollup(pastDays)).rejects.toBeInstanceOf(RollupsMaterializingError);
    expect(counted(ENQUEUE)).toBe(1);
    await drain();
    statements.length = 0;
    await store.measurementAnalyticsRollup(pastDays);
    expect(counted(ENQUEUE)).toBe(0);

    // Past days are clean, so the read answers; the active day's variant is
    // still missing, so the read also prepares it for sealing.
    const throughToday = query({ series: [power], resolution: "1d", qualities: ["good"] });
    await store.measurementAnalyticsRollup(throughToday);
    expect(counted(ENQUEUE)).toBe(1);
    await drain();
    statements.length = 0;
    await store.measurementAnalyticsRollup(throughToday);
    expect(counted(ENQUEUE)).toBe(0);

    // A late sample invalidates its day; the next read prepares it again.
    await store.upsertMeasurementSamples([{
      sensorId: "meter", metric: "power", value: 700, canonicalUnit: "W",
      timestamp: "2026-09-02T09:00:30.000Z", source: "tp-link", quality: "good",
    }]);
    statements.length = 0;
    await expect(store.measurementAnalyticsRollup(throughToday)).rejects.toBeInstanceOf(RollupsMaterializingError);
    expect(counted(ENQUEUE)).toBe(1);
    await drain();
  });

  it("counts the active day's settled hours from the 1h aggregate", async () => {
    const excluded = async () => (await settled(query({ series: [power] }))).series[0]!.excludedSampleCount;
    await refreshHourlyCounts("2026-09-03T11:00:00Z");
    expect(await excluded()).toBe(await staleSamples("meter"));

    // Inside an aggregated hour: invisible until the aggregate refreshes.
    await db.exec(`INSERT INTO telemetry.measurement_samples
      (sensor_id,metric,observed_at,source,quality,canonical_unit,value)
      VALUES ('meter','power','2026-09-03T08:30:30Z','tp-link','stale','W',1)`);
    expect(await excluded()).toBe(await staleSamples("meter") - 1);
    // The newest aggregated hour and the hours after it are counted raw.
    await db.exec(`INSERT INTO telemetry.measurement_samples
      (sensor_id,metric,observed_at,source,quality,canonical_unit,value)
      VALUES ('meter','power','2026-09-03T10:30:30Z','tp-link','stale','W',1),
        ('meter','power','2026-09-03T12:30:30Z','tp-link','stale','W',1)`);
    expect(await excluded()).toBe(await staleSamples("meter") - 1);
    await refreshHourlyCounts(NOW);
    expect(await excluded()).toBe(await staleSamples("meter"));
  });

  it("still requires past hours to be aggregated before counting from them", async () => {
    await refreshHourlyCounts("2026-09-02T20:00:00Z");
    try {
      await expect(store.measurementAnalyticsRollup(query({ series: [power] })))
        .rejects.toBeInstanceOf(RollupsMaterializingError);
    } finally {
      await refreshHourlyCounts(NOW);
    }
  });
});
