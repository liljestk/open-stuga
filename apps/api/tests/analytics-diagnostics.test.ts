import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { MEASUREMENT_FORECAST_ALGORITHM_VERSION, type MeasurementForecastEvaluation } from "@climate-twin/contracts";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  histogramPercentile,
  latencyBucket,
  queryLatencyOperation,
  summaryLatencyOperation,
} from "../src/analytics/diagnostics/latency.js";
import { forecastEvidence, latencyEvidence } from "../src/analytics/diagnostics/service.js";

const DAY = 86_400_000;

describe("latency evidence", () => {
  it("classifies requests like the release benchmark and reads percentiles from day histograms", () => {
    expect(queryLatencyOperation(DAY)).toBe("query-24h");
    expect(queryLatencyOperation(7 * DAY)).toBe("query-7d");
    expect(queryLatencyOperation(30 * DAY)).toBe("query-30d");
    expect(queryLatencyOperation(365 * DAY)).toBe("query-365d");
    expect(summaryLatencyOperation(30 * DAY)).toBe("energy-summary-30d");
    expect(summaryLatencyOperation(DAY)).toBeNull();
    expect(latencyBucket(7)).toBe(10);
    expect(latencyBucket(120)).toBe(250);
    // 90 fast requests and 10 slow ones: the median is fast, p95 is slow.
    const buckets = new Map([[25, 90], [2_500, 10]]);
    expect(histogramPercentile(buckets, 0.5)).toBe(25);
    expect(histogramPercentile(buckets, 0.95)).toBe(2_500);
    expect(histogramPercentile(new Map(), 0.95)).toBeNull();
    const evidence = latencyEvidence(new Map([["query-30d", buckets], ["query-24h", new Map([[250, 40]])]]));
    expect(evidence.find((item) => item.operation === "query-30d")).toMatchObject({ requests: 100, p95Ms: 2_500, targetP95Ms: 1_500, meetsTarget: false });
    expect(evidence.find((item) => item.operation === "query-24h")).toMatchObject({ requests: 40, p95Ms: 250, meetsTarget: true });
    expect(evidence.find((item) => item.operation === "query-365d")).toMatchObject({ requests: 0, p95Ms: null, meetsTarget: null });
  });

  it("judges forecasts by median skill and interval coverage", () => {
    const evaluation = (sensorId: string, skill6h: number, skill24h: number, coverage90: number, status = "ready") => ({
      sensorId, metric: "temperature", status, skill6h, skill24h, coverage90,
    });
    const [temperature] = forecastEvidence([
      evaluation("a", 0.4, 0.2, 0.9), evaluation("a", 0.5, 0.25, 0.92), evaluation("b", 0.3, 0.1, 0.88),
      evaluation("b", -0.1, -0.2, 0.7, "no-skill"),
    ]);
    expect(temperature).toMatchObject({ metric: "temperature", sensors: 2, evaluations: 4, withheld: 1, meetsTarget: true });
    expect(temperature!.medianCoverage90).toBeCloseTo(0.89, 3);
  });
});

describe("analytics diagnostics API", () => {
  let runtime: ApiRuntime | null = null;
  afterEach(async () => { await runtime?.close(); runtime = null; });

  it("reports live latency, stored forecast skill, invoices and the findings control for a Home", async () => {
    runtime = createApi({ config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }), startBackground: false });
    const sensor = runtime.database.listSensors("house-main")[0]!;
    const mode = runtime.database.isRealDataMode() ? "live" : "demo";
    const end = Date.now();
    for (const days of [1, 1, 30]) {
      await request(runtime.app).post("/api/v2/analytics/query").send({
        apiVersion: "1.0", dataMode: mode,
        scope: { kind: "house", id: "house-main", entityIds: [sensor.id] },
        measurementIds: ["temperature"],
        range: { start: new Date(end - days * DAY).toISOString(), end: new Date(end).toISOString(), timezone: "UTC" },
        resolution: "1h", aggregation: "default", requestId: `diagnostics-${days}`,
      }).expect(200);
    }
    const evaluation: MeasurementForecastEvaluation = {
      algorithmVersion: MEASUREMENT_FORECAST_ALGORITHM_VERSION, sensorId: sensor.id, metric: "temperature", status: "ready",
      model: "thermal-relaxation", computedAt: new Date(end - DAY).toISOString(), historyFrom: null, historyTo: null,
      origins: 30, outdoorDriver: "weather-forecast", horizons: [], skill6h: 0.5, skill24h: 0.3, coverage90: 0.91,
    };
    runtime.database.saveForecastEvaluation(evaluation);
    const today = new Date(end).toISOString().slice(0, 10);
    runtime.database.createElectricityInvoice("property-main", {
      houseId: "house-main", periodStart: new Date(end - 40 * DAY).toISOString().slice(0, 10), periodEnd: today, totalEur: 50,
    });

    const response = await request(runtime.app).get("/api/v2/analytics/diagnostics?houseId=house-main").expect(200);
    const diagnostics = response.body.diagnostics;
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(diagnostics).toMatchObject({ houseId: "house-main", windowDays: 30 });
    expect(diagnostics.latency.find((item: { operation: string }) => item.operation === "query-24h")).toMatchObject({ requests: 2 });
    expect(diagnostics.latency.find((item: { operation: string }) => item.operation === "query-30d")).toMatchObject({ requests: 1 });
    expect(diagnostics.latency.find((item: { operation: string }) => item.operation === "query-24h").p95Ms).toBeGreaterThan(0);
    expect(diagnostics.forecasts).toEqual([expect.objectContaining({
      metric: "temperature", sensors: 1, evaluations: 1, medianSkill6h: 0.5, medianCoverage90: 0.91, meetsTarget: true,
    })]);
    // Demo data cannot price the invoice, so it is counted but not reconciled.
    expect(diagnostics.bills).toMatchObject({ invoices: 1, reconciled: 0, tolerancePercent: 2, meetsTarget: false });

    await request(runtime.app).get("/api/v2/analytics/diagnostics?houseId=missing").expect(404);
    await request(runtime.app).get("/api/v2/analytics/diagnostics").expect(400);
  });
});
