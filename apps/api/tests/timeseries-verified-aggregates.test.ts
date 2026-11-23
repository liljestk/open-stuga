import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { FakePool, queryResult, storeFor } from "./timeseries-store-test-support.js";

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
});
