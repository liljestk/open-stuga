import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { TimeseriesStore } from "../src/timeseries/store.js";
import { FakePool, queryResult } from "./timeseries-store-test-support.js";

describe("TimeseriesStore ordered-rollup maintenance", () => {
  it("bounds deletion-ledger growth to configured or existing ordered variants", async () => {
    const pool = new FakePool(({ text }) => (
      text.includes("WITH removed AS") ? queryResult([{ affected: "2" }]) : queryResult()
    ));
    const store = new TimeseriesStore({
      pool: pool as unknown as Pool,
      orderedMetricIds: ["energy"],
      statementTimeoutMs: 0,
    });

    await expect(store.deleteTelemetrySources(["mock", "replay"])).resolves.toBe(2);

    const deletion = pool.queries.find(({ text }) => text.includes("WITH removed AS"))!;
    expect(deletion.text).toContain("ordered_days AS");
    expect(deletion.text).toContain("day.metric = ANY($2::TEXT[])");
    expect(deletion.text).toContain("dirty.day_start = day.day_start");
    expect(deletion.values).toEqual([["mock", "replay"], ["energy"]]);
    expect(pool.queries.some(({ text }) => (
      text.includes("DELETE FROM") && text.includes("heat_pump_state_samples")
    ))).toBe(false);
  });

  it("applies the caller's timeout to both heavy rebuild transactions", async () => {
    const claimed = {
      sensor_id: "meter-1",
      metric: "energy",
      day_start: new Date("2026-07-17T00:00:00.000Z"),
      bucket_seconds: 3_600,
      quality_mask: 3,
      source_scope: "all",
      current_seq: "4",
    };
    const pool = new FakePool(({ text }) => {
      if (text.includes("lease_token = $2") && text.includes("RETURNING dirty.sensor_id")) {
        return queryResult([claimed]);
      }
      if (text.includes("dirty.lease_token = $7") && text.includes("FOR UPDATE OF dirty")) {
        return queryResult([claimed]);
      }
      if (text.includes("INSERT INTO stugu_ordered_rollup_stage")) return queryResult([], 1);
      return queryResult();
    });
    const store = new TimeseriesStore({
      pool: pool as unknown as Pool,
      orderedMetricIds: ["energy"],
      statementTimeoutMs: 0,
    });

    await expect(store.rebuildNextMeasurementOrderedRollup({ timeoutMs: 15_000 }))
      .resolves.toMatchObject({ processed: true, metric: "energy", generatedRows: 1, stale: false });

    const timeouts = pool.queries.filter(({ text }) => text.includes("set_config('statement_timeout'"));
    expect(timeouts).toHaveLength(2);
    expect(timeouts.map(({ values }) => values)).toEqual([["15000ms"], ["15000ms"]]);
  });
});
