import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import { HybridTelemetryReader } from "../src/timeseries/read-facade.js";
import { LocalTelemetryWorker } from "../src/timeseries/local-telemetry-worker.js";

const from = "2026-09-01T00:00:00.000Z";
const to = "2026-09-02T00:00:00.000Z";
const query = { sensorId: "sensor-01", metric: "power", from, to, bucketSeconds: 900, limit: 20000 };

function fixture(count: number) {
  const directory = mkdtempSync(join(tmpdir(), "stugu-history-worker-"));
  const path = join(directory, "fixture.sqlite");
  const database = new ClimateDatabase(path);
  database.insertMeasurementSamples([{ sensorId: "sensor-01", metric: "power", value: 25,
    canonicalUnit: "W", timestamp: from, source: "api", quality: "good" }]);
  database.db.exec("DELETE FROM measurement_samples");
  const insert = database.db.prepare(`INSERT INTO measurement_samples
    (sensor_id,metric,value,canonical_unit,timestamp,source,quality)
    VALUES ('sensor-01','power',25,'W',?,'api','good')`);
  database.transaction(() => {
    for (let index = 0; index <= count; index++) insert.run(new Date(Date.parse(from) + index * 86400000 / count).toISOString());
  });
  return { database, path, close() { database.close(); rmSync(directory, { recursive: true, force: true }); } };
}

describe("isolated local history reads", () => {
  it("serves dense hybrid hot tails without running SQLite on the API thread", async () => {
    const context = fixture(43200);
    try {
      const reader = new HybridTelemetryReader({ local: context.database, now: () => Date.parse(to),
        archiveLastSuccessAt: () => to, archive: { measurementHistoryBucketed: async () => [] } as never });
      const mainRead = vi.spyOn(context.database, "measurementHistoryBucketed")
        .mockImplementation(() => { throw new Error("History query ran on the request thread"); });
      let completed = false;
      const history = reader.measurementHistoryBucketed(query).finally(() => { completed = true; });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(completed).toBe(false);
      const result = await history;
      expect(mainRead).not.toHaveBeenCalled();
      expect(result.records).toHaveLength(97);
      expect(result.records.every(row => row.value === 25 && row.source === "api" && row.canonicalUnit === "W")).toBe(true);
      expect(result.records[0]?.quality).toBe("estimated");
      expect(result.records.at(-1)?.quality).toBe("good");
    } finally { context.close(); }
  }, 30000);

  it("observes committed writes and tiles archive fallback without duplicating shared edges", async () => {
    const context = fixture(24);
    try {
      const reader = new HybridTelemetryReader({ local: context.database,
        archive: { measurementHistoryBucketed: async () => { throw new Error("Archive unavailable"); } } as never });
      const longQuery = { ...query, to: "2026-09-03T00:00:00.000Z" };
      const first = await reader.measurementHistoryBucketed(longQuery);
      expect(first.provenance.archiveState).toBe("failed");
      expect(first.records).toHaveLength(25);
      context.database.db.exec("UPDATE measurement_samples SET value=50");
      expect((await reader.measurementHistoryBucketed(longQuery)).records.every(row => row.value === 50)).toBe(true);
      expect((await context.database.measurementHistoryBucketedAsync({ ...query, toExclusive: true })).at(-1)?.timestamp).toBe("2026-09-01T23:00:00.000Z");
    } finally { context.close(); }
  }, 30000);

  it("cancels queued and running history scans, recovers, and bounds their duration", async () => {
    const context = fixture(24);
    const worker = new LocalTelemetryWorker(context.path);
    const timedWorker = new LocalTelemetryWorker(context.path, 1);
    try {
      const running = new AbortController();
      const queued = new AbortController();
      const settled = Promise.allSettled([worker.readBuckets({ ...query, signal: running.signal }),
        worker.readBuckets({ ...query, signal: queued.signal })]);
      queued.abort(); running.abort();
      expect((await settled).every(result => result.status === "rejected")).toBe(true);
      expect(await worker.readBuckets(query)).toHaveLength(25);
      await expect(timedWorker.readBuckets(query)).rejects.toMatchObject({ code: "LOCAL_HISTORY_TIMEOUT" });
      const closing = Promise.allSettled([worker.readBuckets(query), worker.readBuckets(query)]);
      worker.close();
      expect((await closing).every(result => result.status === "rejected")).toBe(true);
    } finally { worker.close(); timedWorker.close(); context.close(); }
  }, 30000);
});
