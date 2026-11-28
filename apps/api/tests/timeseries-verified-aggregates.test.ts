import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import { FakePool, queryResult, storeFor } from "./timeseries-store-test-support.js";
import { verifiedAggregateFreshnessSql } from "../src/timeseries/store/verified-aggregate-freshness.js";

const from = "2026-07-18T12:01:30.000Z";
const to = "2026-07-18T12:04:00.000Z";
const bucketNames = ["1m", "5m", "1h", "1d"].map((bucket) => `measurement_analytics_verified_v1_${bucket}`);

describe("verified Timescale aggregate maintenance", () => {
  it("creates mode-keyed aggregates and only refreshes explicit bucket windows", async () => {
    const aggregates = new Set<string>();
    const bounds = {
      "1 minute": ["2026-07-18T12:01:00.000Z", to],
      "5 minutes": ["2026-07-18T12:00:00.000Z", "2026-07-18T12:05:00.000Z"],
      "1 hour": ["2026-07-18T12:00:00.000Z", "2026-07-18T13:00:00.000Z"],
      "1 day": ["2026-07-18T00:00:00.000Z", "2026-07-19T00:00:00.000Z"],
    } as const;
    const pool = new FakePool(({ text, values }) => {
      if (text.includes("AS timescale_version")) return queryResult([{ timescale_version: "2.28.3" }]);
      if (text.includes("timescaledb_information.continuous_aggregates")) {
        return queryResult([{ configured: aggregates.has(String(values[1])) }]);
      }
      if (text.includes("CREATE MATERIALIZED VIEW")) {
        aggregates.add(text.match(/"telemetry"\."([^"]+)"/u)![1]!);
        return queryResult();
      }
      if (text.startsWith("SELECT\n      date_bin")) {
        expect(values.slice(0, 2)).toEqual([from, to]);
        const [start, end] = bounds[values[2] as keyof typeof bounds];
        return queryResult([{ from: start, to: end }]);
      }
      return queryResult();
    });
    const store = storeFor(pool);

    await expect(store.refreshMeasurementAggregates({ scope: "verified", from, to })).resolves.toBe(4);
    const created = pool.queries.filter(({ text }) => text.includes("CREATE MATERIALIZED VIEW"));
    expect([...aggregates]).toEqual(bucketNames);
    for (const { text } of created) {
      expect(text).toContain("WHERE data_mode IN ('demo', 'live')");
      expect(text).toContain("GROUP BY data_mode, sensor_id, metric");
      expect(text).toContain("WITH NO DATA");
    }
    expect(pool.queries.filter(({ text }) => text.includes("CREATE INDEX IF NOT EXISTS")))
      .toHaveLength(4);
    expect(pool.queries.filter(({ text }) => text.includes("CALL refresh_continuous_aggregate")).map(({ values }) => values))
      .toEqual(bucketNames.map((name, index) => [`"telemetry"."${name}"`, ...Object.values(bounds)[index]!]));

    const sql = pool.queries.find(({ text }) => text.startsWith("SELECT\n      date_bin"))!.text;
    const postgres = new PGlite();
    try {
      await postgres.exec("SET TIME ZONE 'Europe/Helsinki'");
      const window = (await postgres.query<{ from: Date; to: Date }>(sql,
        ["2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z", "1 day"])).rows[0]!;
      expect(window.from.toISOString()).toBe("2026-10-25T00:00:00.000Z");
      expect(window.to.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    } finally {
      await postgres.close();
    }

    await expect(store.refreshMeasurementAggregates({ scope: "verified", from, to })).resolves.toBe(4);
    expect(pool.queries.filter(({ text }) => text.includes("CREATE MATERIALIZED VIEW"))).toHaveLength(4);
    expect(pool.queries.some(({ text }) => text.includes("add_continuous_aggregate_policy"))).toBe(false);
  }, 30_000);

  it("rejects invalid or empty ranges before sending archive commands", async () => {
    const pool = new FakePool();
    const store = storeFor(pool);
    await expect(store.refreshMeasurementAggregates({ scope: "verified", from: to, to })).rejects.toThrow(RangeError);
    await expect(store.refreshMeasurementAggregates({ scope: "verified", from: "invalid", to })).rejects.toThrow(RangeError);
    expect(pool.queries).toEqual([]);
  });

  it("joins certified days with raw gaps and stops using stored rows after corrections or restore", async () => {
    const postgres = new PGlite();
    try {
      await postgres.exec(`CREATE SCHEMA telemetry;
        CREATE TABLE telemetry.stugu_archive_generation (id INT PRIMARY KEY, generation UUID NOT NULL);
        INSERT INTO telemetry.stugu_archive_generation VALUES (1, gen_random_uuid());
        CREATE TABLE telemetry.measurement_samples (
          sensor_id TEXT, metric TEXT, observed_at TIMESTAMPTZ, source TEXT, quality TEXT,
          canonical_unit TEXT, value DOUBLE PRECISION, data_mode TEXT
        );
        CREATE TABLE telemetry.measurement_analytics_verified_v1_1d (
          sensor_id TEXT, metric TEXT, bucket_start TIMESTAMPTZ, source TEXT, quality TEXT, canonical_unit TEXT,
          data_mode TEXT, sample_count BIGINT, sum_value DOUBLE PRECISION, minimum DOUBLE PRECISION,
          maximum DOUBLE PRECISION, last_value DOUBLE PRECISION, last_at TIMESTAMPTZ
        );`);
      await postgres.exec(verifiedAggregateFreshnessSql("telemetry"));
      await postgres.exec(`INSERT INTO telemetry.measurement_samples VALUES
        ('sensor','temperature','2026-07-17T14:00Z','api','good','C',1,'live'),
        ('sensor','temperature','2026-07-18T12:00Z','api','good','C',10,'live'),
        ('sensor','temperature','2026-07-19T10:00Z','api','good','C',3,'live');
        INSERT INTO telemetry.measurement_analytics_verified_v1_1d VALUES
        ('sensor','temperature','2026-07-18T00:00Z','api','good','C','live',1,100,100,100,100,'2026-07-18T12:00Z'),
        ('sensor','temperature','2026-07-18T00:00Z','mock','good','C','demo',1,200,200,200,200,'2026-07-18T12:00Z');`);
      const certify = () => postgres.exec(`UPDATE telemetry.verified_measurement_aggregate_days SET
        archive_generation = (SELECT generation FROM telemetry.stugu_archive_generation),
        delete_epoch = (SELECT revision FROM telemetry.verified_measurement_aggregate_epoch)
        WHERE day_start = '2026-07-18'`);
      await certify();
      const pool = new FakePool(async ({ text, values }) =>
        queryResult((await postgres.query<Record<string, unknown>>(text, values)).rows));
      const store = storeFor(pool);
      const window = {
        from: "2026-07-17T12:00Z", to: "2026-07-19T12:00Z", dataMode: "live",
        resolution: "1d", qualities: ["good"], series: [{ sensorId: "sensor", metric: "temperature", aggregation: "sum" }],
      } as const;
      const values = async () => (await store.measurementAnalyticsRollup(window)).series[0]!.buckets.map((bucket) => bucket.value);
      // A distinct value identifies the materialized branch in this fixture.
      await expect(values()).resolves.toEqual([1, 100, 3]);
      await postgres.exec("BEGIN; UPDATE telemetry.measurement_samples SET value = 12 WHERE value = 10; ROLLBACK;");
      await expect(values()).resolves.toEqual([1, 100, 3]);
      await postgres.exec("UPDATE telemetry.measurement_samples SET value = 12 WHERE value = 10");
      await expect(values()).resolves.toEqual([1, 12, 3]);
      await certify();
      await postgres.exec("UPDATE telemetry.stugu_archive_generation SET generation = gen_random_uuid()");
      await expect(values()).resolves.toEqual([1, 12, 3]);
      await certify();
      await postgres.exec("DELETE FROM telemetry.measurement_samples WHERE value = 12");
      await expect(values()).resolves.toEqual([1, 3]);
    } finally {
      await postgres.close();
    }
  }, 30_000);

  it("selects the latest closed day first, then resumes dirty historical days", async () => {
    const postgres = new PGlite();
    try {
      await postgres.exec(`CREATE SCHEMA telemetry;
        CREATE TABLE telemetry.stugu_archive_generation (id INT PRIMARY KEY, generation UUID);
        INSERT INTO telemetry.stugu_archive_generation VALUES (1, gen_random_uuid());
        CREATE TABLE telemetry.measurement_samples (observed_at TIMESTAMPTZ, data_mode TEXT);`);
      const pool = new FakePool(async ({ text, values }) =>
        queryResult((await postgres.query<Record<string, unknown>>(
          text.replaceAll("clock_timestamp()", "TIMESTAMPTZ '2026-07-20T01:00:00Z'"), values,
        )).rows));
      const store = storeFor(pool);
      const refresh = vi.spyOn(store, "refreshMeasurementAggregates").mockResolvedValue(4);
      await expect(store.refreshNextVerifiedMeasurementDay()).resolves.toBe(true);
      expect(refresh).toHaveBeenLastCalledWith({
        scope: "verified", from: "2026-07-19T00:00:00.000Z", to: "2026-07-20T00:00:00.000Z",
      });

      await postgres.exec(verifiedAggregateFreshnessSql("telemetry"));
      await postgres.exec(`INSERT INTO telemetry.measurement_samples VALUES
        ('2026-07-17T03:00Z', 'live'), ('2026-07-19T03:00Z', 'demo'), ('2026-07-20T00:30Z','live');
        UPDATE telemetry.verified_measurement_aggregate_days SET
          archive_generation = (SELECT generation FROM telemetry.stugu_archive_generation),
          delete_epoch = (SELECT revision FROM telemetry.verified_measurement_aggregate_epoch)
        WHERE day_start = '2026-07-19';`);
      await expect(store.refreshNextVerifiedMeasurementDay()).resolves.toBe(true);
      expect(refresh).toHaveBeenLastCalledWith({
        scope: "verified", from: "2026-07-17T00:00:00.000Z", to: "2026-07-18T00:00:00.000Z",
      });
      await postgres.exec(`UPDATE telemetry.verified_measurement_aggregate_days SET
        archive_generation = (SELECT generation FROM telemetry.stugu_archive_generation),
        delete_epoch = (SELECT revision FROM telemetry.verified_measurement_aggregate_epoch)
        WHERE day_start = '2026-07-17';`);
      await expect(store.refreshNextVerifiedMeasurementDay()).resolves.toBe(false);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      await postgres.close();
    }
  }, 30_000);
});
