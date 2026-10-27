import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import { HybridTelemetryReader } from "../src/timeseries/read-facade.js";
import { LocalCostIsolate } from "../src/timeseries/local-cost-isolate.js";

const from = "2026-09-01T00:00:00.000Z";
const query = { sensorId: "sensor-01", propertyId: "property-main", from,
  to: "2026-09-02T00:00:00.000Z" };

function fixture(count: number) {
  const directory = mkdtempSync(join(tmpdir(), "stugu-cost-worker-"));
  const path = join(directory, "fixture.sqlite");
  const database = new ClimateDatabase(path);
  database.db.exec("DELETE FROM measurement_samples; DELETE FROM electricity_price_points;");
  const insert = database.db.prepare(`INSERT INTO measurement_samples
    (sensor_id,metric,value,canonical_unit,timestamp,source,quality)
    VALUES ('sensor-01',?,?,?,?,'api','good')`);
  database.transaction(() => {
    for (let index = 0; index <= count; index += 1) {
      const timestamp = new Date(Date.parse(from) + index * 86_400_000 / count).toISOString();
      insert.run("energy", index * 24 / count, "kWh", timestamp);
      insert.run("power", 1000, "W", timestamp);
    }
    database.db.prepare(`INSERT INTO electricity_price_points
      (property_id,start_at,end_at,raw_price_cents_per_kwh,margin_cents_per_kwh,fetched_at)
      VALUES ('property-main',?,?,10,0,?)`).run(from, query.to, from);
  });
  return { database, path, close() { database.close(); rmSync(directory, { recursive: true, force: true }); } };
}

describe("isolated local electricity costs", () => {
  it("keeps the event loop responsive and uses the production query on a separate read-only connection", async () => {
    const context = fixture(86_400);
    try {
      const reader = new HybridTelemetryReader({ local: context.database });
      const mainRead = vi.spyOn(context.database, "energyCostAggregate")
        .mockImplementation(() => { throw new Error("Cost query ran on the request thread"); });
      let completed = false;
      const cost = reader.energyCostAggregate(query).finally(() => { completed = true; });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(completed).toBe(false);
      const result = await cost;
      expect(mainRead).not.toHaveBeenCalled();
      expect(result.archiveState).toBe("local-only");
      expect(result.consumptionKwh).toBeCloseTo(24, 5);
      expect(result.spotCostEur).toBeCloseTo(2.4, 5);
      mainRead.mockRestore();
      const power = await reader.powerCostAggregate(query);
      expect(power.consumptionKwh).toBeCloseTo(24, 4);
      expect(power.spotCostEur).toBeCloseTo(2.4, 4);
    } finally { context.close(); }
  }, 30_000);

  it("uses the isolated reader for archive fallback and observes subsequent committed writes", async () => {
    const context = fixture(24);
    try {
      const reader = new HybridTelemetryReader({ local: context.database,
        archive: { energyCostAggregate: async () => { throw new Error("Archive unavailable"); } } as never });
      expect((await reader.energyCostAggregate(query)).archiveState).toBe("pending");
      context.database.db.prepare("UPDATE measurement_samples SET value = value * 2 WHERE metric = 'energy'").run();
      expect((await reader.energyCostAggregate(query)).consumptionKwh).toBeCloseTo(48, 5);
    } finally { context.close(); }
  });

  it("cancels both queued and running reads without poisoning the next query", async () => {
    const context = fixture(24);
    const worker = new LocalCostIsolate(context.path);
    try {
      const running = new AbortController();
      const queued = new AbortController();
      const reads = [worker.read("energy", { ...query, signal: running.signal }),
        worker.read("power", { ...query, signal: queued.signal })];
      const settled = Promise.allSettled(reads);
      queued.abort();
      running.abort();
      expect((await settled).map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect((await worker.read("energy", query)).consumptionKwh).toBeCloseTo(24, 5);
    } finally { worker.close(); context.close(); }
  });

  it("bounds scan duration and shuts down queued work", async () => {
    const context = fixture(24);
    const worker = new LocalCostIsolate(context.path, 1);
    try {
      await expect(worker.read("energy", query)).rejects.toMatchObject({ code: "LOCAL_COST_TIMEOUT" });
      const reads = Promise.allSettled([worker.read("energy", query), worker.read("power", query)]);
      worker.close();
      expect((await reads).every((result) => result.status === "rejected")).toBe(true);
    } finally { worker.close(); context.close(); }
  });
});
