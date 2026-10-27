import type { HomeEnergySummary, MeasurementSample } from "@climate-twin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AnalyticsWorkLimiter } from "../src/analytics/work-limiter.js";
import type { ClimateDatabase } from "../src/db.js";
import type { EnergyCostService } from "../src/energy-cost.js";
import { EnergySummaryCache } from "../src/energy-summary-cache.js";
import {
  HybridTelemetryReader,
  type ArchiveTelemetryReader,
  type LocalTelemetryReader,
} from "../src/timeseries/read-facade.js";

const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const DAY = 86_400_000;

function measurement(timestamp: string, value: number): MeasurementSample {
  return { sensorId: "sensor-a", metric: "temperature", value, canonicalUnit: "C", timestamp, source: "api", quality: "good" };
}

function readers(local: Partial<LocalTelemetryReader>, archive: Partial<ArchiveTelemetryReader>, lastPassAgoMs: number) {
  return new HybridTelemetryReader({
    local: {
      isRealDataMode: vi.fn(() => false),
      measurementCoverage: vi.fn(() => []),
      measurementHistory: vi.fn(() => []),
      measurementHistoryBucketed: vi.fn(() => []),
      measurementWindow: vi.fn(() => []),
      history: vi.fn(() => []),
      outdoorTemperatureHistory: vi.fn(() => []),
      listPropertyElectricityPrices: vi.fn(() => []),
      listOpeningStateObservations: vi.fn(() => []),
      listOpeningStateObservationHistory: vi.fn(() => []),
      ...local,
    },
    archive: {
      measurementHistory: vi.fn(async () => []),
      legacyReadingHistory: vi.fn(async () => []),
      outdoorTemperatureHistory: vi.fn(async () => []),
      electricityPriceHistory: vi.fn(async () => []),
      openingStateHistory: vi.fn(async () => []),
      openingStateSnapshot: vi.fn(async () => []),
      ...archive,
    },
    archivePhase: () => "ready",
    archiveLastSuccessAt: () => new Date(NOW - lastPassAgoMs).toISOString(),
    now: () => NOW,
  });
}

describe("raw history reads", () => {
  const from = new Date(NOW - 3 * DAY).toISOString();
  const to = new Date(NOW).toISOString();

  it("starts the archive query before SQLite and reads only the hot tail while the archive is fresh", async () => {
    const order: string[] = [];
    const local = vi.fn(() => {
      order.push("local");
      return [measurement(new Date(NOW - 60_000).toISOString(), 22)];
    });
    const archive = vi.fn(async () => {
      order.push("archive");
      return [measurement(new Date(NOW - 2 * DAY).toISOString(), 20)];
    });
    const reader = readers({ measurementHistory: local }, { measurementHistory: archive }, 60_000);

    const result = await reader.measurementHistory({ sensorId: "sensor-a", metric: "temperature", from, to });

    expect(order).toEqual(["archive", "local"]);
    expect(local.mock.calls[0]![2]).toBe(new Date(NOW - DAY).toISOString());
    expect(result.records.map((record) => record.value)).toEqual([20, 22]);
  });

  it("reads the whole window from SQLite when no recent archive pass is proven", async () => {
    const local = vi.fn(() => []);
    const reader = readers({ measurementHistory: local }, {}, 3_600_000);
    await reader.measurementHistory({ sensorId: "sensor-a", metric: "temperature", from, to });
    expect(local.mock.calls[0]![2]).toBe(from);
  });

  it("re-reads the whole window from SQLite when the archive fails after a hot-tail read", async () => {
    const local = vi.fn((_sensor: string, _metric: string, windowFrom: string) => (
      windowFrom === from ? [measurement(new Date(NOW - 2 * DAY).toISOString(), 19)] : []
    ));
    const archive = vi.fn(async () => { throw new Error("archive unavailable"); });
    const reader = readers({ measurementHistory: local }, { measurementHistory: archive }, 60_000);

    const result = await reader.measurementHistory({ sensorId: "sensor-a", metric: "temperature", from, to });

    expect(local.mock.calls.map((call) => call[2])).toEqual([new Date(NOW - DAY).toISOString(), from]);
    expect(result.records.map((record) => record.value)).toEqual([19]);
    expect(result.provenance.archiveState).toBe("failed");
  });
});

describe("analytics query cache", () => {
  let runtime: ApiRuntime | null = null;
  afterEach(async () => { await runtime?.close(); runtime = null; });

  const query = (sensorId: string, mode: "live" | "demo", start: number, end: number, requestId: string) => ({
    apiVersion: "1.0", dataMode: mode,
    scope: { kind: "house", id: "house-main", entityIds: [sensorId] },
    measurementIds: ["temperature"],
    range: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), timezone: "UTC" },
    resolution: "1h", aggregation: "default", requestId,
  });

  it("serves a repeated query from the cache and recomputes after late history arrives", async () => {
    runtime = createApi({ config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }), startBackground: false });
    const database = runtime.database as ClimateDatabase;
    const sensorId = database.listSensors("house-main")[0]!.id;
    const end = Math.floor((Date.now() - 2 * DAY) / 3_600_000) * 3_600_000;
    const start = end - DAY;
    database.insertMeasurementSamples(Array.from({ length: 24 }, (_, hour) => ({
      sensorId, metric: "temperature", value: 20, canonicalUnit: "°C",
      timestamp: new Date(start + hour * 3_600_000 + 60_000).toISOString(), source: "api" as const, quality: "good" as const,
    })));
    // Real readings switch the database out of demo mode.
    const mode = database.isRealDataMode() ? "live" : "demo";

    const first = await request(runtime.app).post("/api/v2/analytics/query").send(query(sensorId, mode, start, end, "first")).expect(200);
    const second = await request(runtime.app).post("/api/v2/analytics/query").send(query(sensorId, mode, start, end, "second")).expect(200);
    expect(first.body.cache).toEqual({ hit: false, keyVersion: "analytics-query-v2" });
    expect(second.body.cache).toEqual({ hit: true, keyVersion: "analytics-query-v2" });
    expect(second.headers["x-stugu-cache"]).toBe("hit");
    expect(second.body.requestId).toBe("second");
    expect(second.body.series).toEqual(first.body.series);

    // An import into the closed range changes the answer, so it is not served from the cache.
    database.insertMeasurementSamples([{
      sensorId, metric: "temperature", value: 30, canonicalUnit: "°C",
      timestamp: new Date(start + 3_600_000 + 120_000).toISOString(), source: "api", quality: "good",
    }]);
    const third = await request(runtime.app).post("/api/v2/analytics/query").send(query(sensorId, mode, start, end, "third")).expect(200);
    expect(third.body.cache.hit).toBe(false);
    expect(third.body.series[0].summary.maximum).toBe(30);
  });
});

describe("energy summary cache", () => {
  const summary = (complete: boolean) => ({ complete, consumptionKwh: 1 }) as unknown as HomeEnergySummary;
  const limiter = { run: (_name: string, task: () => unknown) => task() } as unknown as AnalyticsWorkLimiter;
  const database = { getPropertyElectricityTariff: () => null } as unknown as ClimateDatabase;
  const input = {
    houseId: "house-main", propertyId: "property-main", timeZone: "UTC", sensors: [{ id: "meter" }],
    from: "2026-08-01T00:00:00.000Z", to: "2026-08-31T00:00:00.000Z",
  };

  it("shares an incomplete summary briefly instead of recomputing it for every caller", async () => {
    const summarize = vi.fn(async () => summary(false));
    const cache = new EnergySummaryCache(database, { summarize } as unknown as EnergyCostService, limiter);
    expect((await cache.get(input)).source).toBe("miss");
    expect((await cache.get(input)).source).toBe("hit");
    expect(summarize).toHaveBeenCalledOnce();
  });
});

describe("energy optimization cache", () => {
  let runtime: ApiRuntime | null = null;
  afterEach(async () => { await runtime?.close(); runtime = null; });

  it("keeps reports through live device events and drops them when the Property changes", async () => {
    runtime = createApi({ config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }), startBackground: false });
    const report = vi.spyOn(runtime.energyOptimizer, "report");
    const read = () => request(runtime!.app).get("/api/v1/properties/property-main/energy-optimization").expect(200);
    await read();
    await read();
    expect(report).toHaveBeenCalledOnce();
    runtime.bus.publish({ type: "heat-pump", data: {} as never });
    runtime.bus.publish({ type: "mutation", data: { method: "POST", resource: "/action-runs/run-1", occurredAt: new Date().toISOString() } });
    await read();
    expect(report).toHaveBeenCalledOnce();
    runtime.bus.publish({ type: "mutation", data: { method: "PUT", resource: "/properties/property-main/electricity/config", occurredAt: new Date().toISOString() } });
    await read();
    expect(report).toHaveBeenCalledTimes(2);
  });
});
