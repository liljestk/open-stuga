import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { HybridTelemetryReader } from "../src/timeseries/read-facade.js";
import { LocalTelemetryTimeoutError } from "../src/timeseries/local-telemetry-worker.js";

const from = "2026-09-01T00:00:00.000Z";
const to = "2026-09-02T00:00:00.000Z";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "stugu-api-reads-"));
  const runtime = createApi({ config: loadConfig({
    NODE_ENV: "test", DATABASE_PATH: join(directory, "fixture.sqlite"), MOCK_ENABLED: "false",
    ASSET_DIRECTORY: join(directory, "assets"), INTEGRATION_SECRETS_FILE: join(directory, "private", "integrations.json"),
  }), startBackground: false });
  const database = runtime.database;
  database.insertMeasurementSamples([{ sensorId: "sensor-01", metric: "power", canonicalUnit: "W",
    timestamp: from, value: 100, quality: "good", source: "api" }]);
  database.db.exec("DELETE FROM measurement_samples");
  const insert = database.db.prepare(`INSERT INTO measurement_samples
    (sensor_id,metric,value,canonical_unit,timestamp,source,quality) VALUES ('sensor-01',?,?,?,?,'api','good')`);
  database.transaction(() => {
    for (let index = 0; index < 24_000; index++) {
      const timestamp = new Date(Date.parse(from) + index * 2_000).toISOString();
      for (const [metric, unit, value] of [["temperature", "°C", 20], ["humidity", "%", 50], ["power", "W", 100]] as const) {
        insert.run(metric, value, unit, timestamp);
      }
    }
  });
  return { runtime, database, async close() { await runtime.close(); rmSync(directory, { recursive: true, force: true }); } };
}

describe("dense file-backed API reads", () => {
  it("does not scan excluded telemetry and keeps export counts and integrity scans off the request thread", async () => {
    const context = fixture();
    const original = context.database.db.prepare.bind(context.database.db);
    const mainQuery = vi.spyOn(context.database.db, "prepare").mockImplementation(sql => {
      if (/PRAGMA (?:quick_check|foreign_key_check)|SELECT COUNT\(\*\).*FROM (?:measurement_samples|readings)/i.test(sql)) {
        throw Error("Telemetry or integrity scan ran on the API thread");
      }
      return original(sql);
    });
    const counts = vi.spyOn(context.database, "exportTableCountsAsync");
    try {
      const preview = await request(context.runtime.app).get("/api/v1/data-export/preview?privacyLevel=structure").expect(200);
      expect(preview.body.preview.estimatedTelemetryRows).toBe(0);
      expect(preview.body.preview.counts).not.toHaveProperty("measurement_samples");
      expect(counts.mock.calls[0]![0]).not.toContain("measurement_samples");
      const withTelemetry = await request(context.runtime.app).get("/api/v1/data-export/preview?includeTelemetry=true").expect(200);
      expect(withTelemetry.body.preview.counts.measurement_samples).toBe(72_000);
      expect(withTelemetry.body.preview.estimatedTelemetryRows).toBeGreaterThanOrEqual(72_000);
      const inspection = request(context.runtime.app).get("/api/v1/setup/doctor").then(response => response);
      await request(context.runtime.app).get("/api/v1/health").expect(200);
      expect((await inspection).status).toBe(200);
      const exported = await request(context.runtime.app).get("/api/v1/data-export?privacyLevel=structure").expect(200);
      expect(exported.body.includesTelemetry).toBe(false);
      expect(exported.body.privacyPreview.estimatedTelemetryRows).toBe(0);
    } finally { mainQuery.mockRestore(); await context.close(); }
  }, 30_000);

  it("pages tied timestamps without full sorts or repeated samples", async () => {
    const context = fixture();
    const mainPage = vi.spyOn(context.database, "sensorMeasurementPage").mockImplementation(() => {
      throw Error("Sensor page ran on the API thread");
    });
    try {
      const first = await request(context.runtime.app).get("/api/v2/sensors/sensor-01/measurements?limit=2").expect(200);
      const second = await request(context.runtime.app).get("/api/v2/sensors/sensor-01/measurements")
        .query({ limit: 2, cursor: first.body.nextCursor }).expect(200);
      expect(first.body.samples).toHaveLength(2);
      expect(second.body.samples).toHaveLength(2);
      const identities = [...first.body.samples, ...second.body.samples]
        .map(sample => JSON.stringify([sample.timestamp, sample.metric, sample.source]));
      expect(new Set(identities).size).toBe(4);
      expect(mainPage).not.toHaveBeenCalled();
      const plan = context.database.db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM measurement_samples
        WHERE sensor_id=? AND (timestamp,id)<(?,?) ORDER BY timestamp DESC,id DESC LIMIT 3`)
        .all("sensor-01", to, Number.MAX_SAFE_INTEGER) as Array<{ detail: string }>;
      expect(plan.some(row => /USE TEMP B-TREE/.test(row.detail))).toBe(false);
    } finally { mainPage.mockRestore(); await context.close(); }
  }, 30_000);

  it("serves complete power and thermal windows using the shared worker and preserves their values", async () => {
    const context = fixture();
    const mainWindow = vi.spyOn(context.database, "measurementWindow").mockImplementation(() => {
      throw Error("Power window ran on the API thread");
    });
    const mainThermal = vi.spyOn(context.database, "thermalClimateHistory").mockImplementation(() => {
      throw Error("Thermal aggregation ran on the API thread");
    });
    try {
      const reader = new HybridTelemetryReader({ local: context.database });
      const power = await reader.measurementWindow({ sensorIds: ["sensor-01"], metrics: ["power"], from, to, limit: 30_000 });
      expect(power.records).toHaveLength(24_000);
      expect(power.records.every(sample => sample.value === 100 && sample.source === "api")).toBe(true);
      const profile = await reader.optimizerPowerProfile(context.database.listSensors("house-main"),
        { sensorIds: ["sensor-01"], metrics: ["power"], from, to, limit: 30_000 }, from);
      expect(profile).toEqual({ baseline: 100, peak: 100 });
      const truncated = await reader.optimizerPowerProfile(context.database.listSensors("house-main"),
        { sensorIds: ["sensor-01"], metrics: ["power"], from, to, limit: 2 }, from);
      expect(truncated).toEqual({ baseline: null, peak: null });
      const thermal = await reader.thermalMeasurementHistory({
        sensorId: "sensor-01", metrics: ["temperature", "humidity"], from, to, bucketMinutes: 5, limitPerMetric: 5_000,
      });
      expect(thermal.records.length).toBeGreaterThan(100);
      expect(thermal.records.every(sample => sample.value === (sample.metric === "temperature" ? 20 : 50))).toBe(true);
      expect(mainWindow).not.toHaveBeenCalled();
      expect(mainThermal).not.toHaveBeenCalled();
    } finally { mainWindow.mockRestore(); mainThermal.mockRestore(); await context.close(); }
  }, 30_000);

  it("returns a retryable 503 when a worker deadline expires", async () => {
    const context = fixture();
    vi.spyOn(context.database, "integrityAsync").mockRejectedValue(new LocalTelemetryTimeoutError(true));
    try {
      const response = await request(context.runtime.app).get("/api/v1/setup/doctor").expect(503);
      expect(response.headers["retry-after"]).toBe("1");
      expect(response.body.error.code).toBe("LOCAL_HISTORY_TIMEOUT");
      await request(context.runtime.app).get("/api/v1/health").expect(200);
    } finally { await context.close(); }
  }, 30_000);
});
