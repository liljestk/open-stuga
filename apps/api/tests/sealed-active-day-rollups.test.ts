import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildBaseSchemaSql } from "../src/timeseries/schema.js";
import { FakePool, queryResult, storeFor } from "./timeseries-store-test-support.js";

/*
 * The active day's ordered states are sealed at a settled bucket edge so cost
 * reads only scan the open tail. A planted sample proves which path a read
 * took: inside the sealed range it is invisible until the day is invalidated,
 * after the seal it is read raw. Appends after the seal keep the seal valid; a
 * late sample before it invalidates the day like any other late data.
 */
const DAY = "2026-09-03T00:00:00.000Z";
const NOW = "2026-09-03T13:47:00.000Z";
const SEAL = "2026-09-03T13:30:00.000Z";
const CLOCK = `TIMESTAMPTZ '${NOW}'`;

describe("sealed active-day ordered states", () => {
  const db = new PGlite();
  const store = storeFor(new FakePool(async ({ text, values }) => {
    const result = await db.query<Record<string, unknown>>(text.replaceAll("clock_timestamp()", CLOCK), values);
    return queryResult(result.rows, result.affectedRows);
  }));
  const cost = () => store.powerCostAggregate({
    sensorId: "meter", propertyId: "property", from: DAY, to: NOW, excludeSynthetic: true,
  });
  const variant = async () => (await db.query<{ sealed_until: Date | null; clean: boolean }>(`SELECT dirty.sealed_until,
      GREATEST(dirty.current_seq, generation.current_seq) = dirty.clean_seq AS clean
    FROM telemetry.measurement_ordered_rollup_dirty dirty
    JOIN telemetry.measurement_ordered_rollup_generations generation USING (sensor_id, metric, day_start)
    WHERE dirty.sensor_id = 'meter' AND dirty.day_start = $1 AND dirty.bucket_seconds = 900`, [DAY])).rows[0];
  const drain = async () => {
    while ((await store.rebuildNextMeasurementOrderedRollup({ timeoutMs: 15_000 })).processed) { /* drain */ }
  };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    await db.exec("SET TIME ZONE 'UTC'");
    for (const sql of buildBaseSchemaSql("telemetry")) await db.exec(sql);
    await db.exec(`CREATE TABLE telemetry.measurement_analytics_v2_1h (
        sensor_id text, metric text, bucket_start timestamptz, source text, quality text, sample_count bigint);
      INSERT INTO telemetry.measurement_samples
        (sensor_id,metric,observed_at,source,quality,canonical_unit,value)
      SELECT 'meter', 'power', TIMESTAMPTZ '${DAY}' + n * INTERVAL '1 minute', 'tp-link', 'good', 'W', 1000
      FROM generate_series(0, 826) n;
      INSERT INTO telemetry.electricity_price_samples
        (property_id,starts_at,ends_at,source,raw_price_cents_per_kwh,margin_cents_per_kwh,fetched_at)
      SELECT 'property', quarter, quarter + INTERVAL '15 minutes' - INTERVAL '1 millisecond', 'api', 10, 0, quarter
      FROM generate_series(TIMESTAMPTZ '${DAY}', TIMESTAMPTZ '${DAY}' + INTERVAL '1 day', INTERVAL '15 minutes') quarter;`);
  }, 30_000);
  afterAll(async () => {
    vi.useRealTimers();
    await db.close();
  });

  it("reads the active day raw until it is sealed, then reads sealed states up to the seal", async () => {
    const unsealed = await cost();
    expect(unsealed.consumptionKwh).toBeCloseTo(827 / 60, 9);
    await drain();
    expect(await variant()).toEqual({ sealed_until: new Date(SEAL), clean: true });

    // Planted without a write, so nothing invalidates the sealed day.
    await db.exec(`INSERT INTO telemetry.measurement_samples
      (sensor_id,metric,observed_at,source,quality,canonical_unit,value)
      VALUES ('meter','power','2026-09-03T10:00:30Z','tp-link','good','W',1000000)`);
    const sealed = await cost();
    expect(sealed.consumptionKwh).toBeCloseTo(unsealed.consumptionKwh, 9);
    expect(sealed.spotCostEur).toBeCloseTo(unsealed.spotCostEur, 9);

    await db.exec(`INSERT INTO telemetry.measurement_samples
      (sensor_id,metric,observed_at,source,quality,canonical_unit,value)
      VALUES ('meter','power','2026-09-03T13:35:30Z','tp-link','good','W',1000000)`);
    expect((await cost()).consumptionKwh).toBeGreaterThan(unsealed.consumptionKwh + 1);
  });

  it("keeps the seal through appends and invalidates it for a late sample before the seal", async () => {
    await store.upsertMeasurementSamples([{
      sensorId: "meter", metric: "power", value: 1000, canonicalUnit: "W",
      timestamp: "2026-09-03T13:46:30.000Z", source: "tp-link", quality: "good",
    }]);
    expect(await variant()).toEqual({ sealed_until: new Date(SEAL), clean: true });

    await store.upsertMeasurementSamples([{
      sensorId: "meter", metric: "power", value: 1000, canonicalUnit: "W",
      timestamp: "2026-09-03T09:00:30.000Z", source: "tp-link", quality: "good",
    }]);
    expect((await variant())?.clean).toBe(false);
    // The invalidated day is read raw again, so the planted 10:00 sample now counts.
    const raw = await cost();
    expect(raw.consumptionKwh).toBeGreaterThan(14);
    await drain();
    expect(await variant()).toEqual({ sealed_until: new Date(SEAL), clean: true });
  });

  it("answers analytics from the same sealed states up to the seal", async () => {
    const query = () => store.measurementAnalyticsRollup({
      series: [{ sensorId: "meter", metric: "power", aggregation: "time_weighted_mean" }],
      from: DAY, to: NOW, resolution: "15m", qualities: ["good", "estimated"], excludeSynthetic: true,
    });
    await query();
    await drain();
    const before = await query();
    await db.exec(`INSERT INTO telemetry.measurement_samples
      (sensor_id,metric,observed_at,source,quality,canonical_unit,value)
      VALUES ('meter','power','2026-09-03T11:00:30Z','tp-link','good','W',1000000)`);
    expect(await query()).toEqual(before);
  });
});
