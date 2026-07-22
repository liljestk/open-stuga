import type { HouseWeather, MeasurementSample, OutdoorTemperatureSample } from "@climate-twin/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApi, persistWeatherObservation, type ApiRuntime } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { outdoorLocationKey } from "../src/db.js";
import { runThermalSimulation, simulateThermalStep } from "../src/thermal-simulation.js";

const config: AppConfig = {
  port: 0,
  apiHost: "127.0.0.1",
  databasePath: ":memory:",
  integrationSecretsFile: "integration-secrets.test.json",
  assetDirectory: ".",
  mockEnabled: false,
  mockIntervalMs: 25,
  retentionDays: 730,
  ingestApiKey: null,
  haUrl: null,
  haToken: null,
  haEntityMapFile: null,
  tpLinkHost: null,
  tpLinkUsername: null,
  tpLinkPassword: null,
  tpLinkDeviceMapFile: null,
  tpLinkPollIntervalMs: 10_000,
  tpLinkPython: "python",
  tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
  alertWebhookUrl: null,
  alertWebhookBearerToken: null,
  corsOrigin: null,
};

function syntheticSeries(hours = 96, intervalMinutes = 15): { indoor: MeasurementSample[]; outdoor: OutdoorTemperatureSample[] } {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  const tauHours = 24;
  const liftC = 18;
  let indoorC = 20;
  const indoor: MeasurementSample[] = [];
  const outdoor: OutdoorTemperatureSample[] = [];
  const stepHours = intervalMinutes / 60;
  for (let step = 0; step <= Math.floor(hours / stepHours); step += 1) {
    const timestamp = new Date(start + step * intervalMinutes * 60_000).toISOString();
    const outdoorC = 3 + 6 * Math.sin(step / 19) + 1.5 * Math.cos(step / 7);
    indoor.push({
      sensorId: "sensor-synthetic",
      metric: "temperature",
      value: indoorC,
      canonicalUnit: "°C",
      timestamp,
      source: "api",
      quality: "good",
    });
    outdoor.push({
      houseId: "house-synthetic",
      locationKey: "60.000000,24.000000",
      timestamp,
      temperatureC: outdoorC,
      source: "api",
      fetchedAt: timestamp,
      stationId: null,
      stationName: null,
    });
    indoorC = simulateThermalStep(indoorC, outdoorC, stepHours, tauHours, liftC);
  }
  return { indoor, outdoor };
}

describe("effective thermal simulation", () => {
  it("uses the exact discrete first-order equation", () => {
    expect(simulateThermalStep(20, 0, 1, 10, 30)).toBeCloseTo(20.95162582, 8);
  });

  it("recovers a known model and keeps observed, simulated, and residual values separate", () => {
    const series = syntheticSeries();
    const result = runThermalSimulation({
      houseId: "house-synthetic",
      sensorId: "sensor-synthetic",
      roomLabel: "Test room",
      from: series.indoor[0]!.timestamp,
      to: series.indoor.at(-1)!.timestamp,
      indoorSamples: series.indoor,
      outdoorSamples: series.outdoor,
      horizonHours: 4,
      scenarioOutdoorTemperatureC: -10,
      generatedAt: "2026-02-01T00:00:00.000Z",
    });

    expect(result.calibration.model?.parameters.timeConstantHours).toBe(24);
    expect(result.calibration.model?.parameters.effectiveEquilibriumLiftC).toBeCloseTo(18, 2);
    expect(result.calibration.quality.validationRmseC).toBeLessThan(0.01);
    const fit = result.points.filter((point) => point.phase === "fit")[1]!;
    expect(fit.residualC).toBeCloseTo((fit.observedTemperatureC ?? 0) - fit.simulatedTemperatureC, 3);
    expect(result.points.filter((point) => point.phase === "scenario")).toHaveLength(4);
    expect(result.points.every((point) => point.lowC <= point.simulatedTemperatureC && point.highC >= point.simulatedTemperatureC)).toBe(true);
  });

  it("returns a typed collecting state instead of inventing missing boundary history", () => {
    const series = syntheticSeries(6);
    const result = runThermalSimulation({
      houseId: "house-synthetic",
      sensorId: "sensor-synthetic",
      roomLabel: "Test room",
      from: series.indoor[0]!.timestamp,
      to: series.indoor.at(-1)!.timestamp,
      indoorSamples: series.indoor,
      outdoorSamples: [],
      generatedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(result.calibration.status).toBe("insufficient-data");
    expect(result.calibration.model).toBeNull();
    expect(result.calibration.warnings).toContain("INSUFFICIENT_OVERLAP");
    expect(result.points).toEqual([]);
  });

  it("canonicalizes dense telemetry and accepts a complete edge-aligned 24-hour window", () => {
    const dense = syntheticSeries(25, 1 / 6);
    const denseResult = runThermalSimulation({
      houseId: "house-synthetic",
      sensorId: "sensor-synthetic",
      roomLabel: "Dense room",
      from: dense.indoor[0]!.timestamp,
      to: dense.indoor.at(-1)!.timestamp,
      indoorSamples: dense.indoor,
      outdoorSamples: dense.outdoor.filter((_, index) => index % 60 === 0),
      horizonHours: 0,
    });
    expect(denseResult.calibration.model).not.toBeNull();
    expect(denseResult.calibration.quality.transitionsUsed).toBeGreaterThanOrEqual(48);
    expect(denseResult.points.length).toBeLessThan(400);

    const edgeWindow = syntheticSeries(24, 5);
    edgeWindow.indoor.pop();
    edgeWindow.outdoor.pop();
    const edgeResult = runThermalSimulation({
      houseId: "house-synthetic",
      sensorId: "sensor-synthetic",
      roomLabel: "Edge room",
      from: edgeWindow.indoor[0]!.timestamp,
      to: new Date(Date.parse(edgeWindow.indoor[0]!.timestamp) + 24 * 3_600_000).toISOString(),
      indoorSamples: edgeWindow.indoor,
      outdoorSamples: edgeWindow.outdoor,
      horizonHours: 0,
    });
    expect(edgeResult.calibration.model).not.toBeNull();
    expect(edgeResult.calibration.quality.durationHours).toBeCloseTo(23.92, 1);
  });

  it("requires continuous usable coverage and suppresses scenarios with a stale anchor", () => {
    const short = syntheticSeries(4, 5);
    const oldTimestamp = new Date(Date.parse(short.indoor[0]!.timestamp) - 25 * 3_600_000).toISOString();
    short.indoor.unshift({ ...short.indoor[0]!, timestamp: oldTimestamp });
    short.outdoor.unshift({ ...short.outdoor[0]!, timestamp: oldTimestamp, fetchedAt: oldTimestamp });
    const gapped = runThermalSimulation({
      houseId: "house-synthetic",
      sensorId: "sensor-synthetic",
      roomLabel: "Gapped room",
      from: oldTimestamp,
      to: short.indoor.at(-1)!.timestamp,
      indoorSamples: short.indoor,
      outdoorSamples: short.outdoor,
      horizonHours: 0,
    });
    expect(gapped.calibration.status).toBe("insufficient-data");
    expect(gapped.calibration.quality.durationHours).toBeCloseTo(4, 1);

    const history = syntheticSeries(48);
    const staleTo = new Date(Date.parse(history.indoor.at(-1)!.timestamp) + 6 * 3_600_000).toISOString();
    const stale = runThermalSimulation({
      houseId: "house-synthetic",
      sensorId: "sensor-synthetic",
      roomLabel: "Stale room",
      from: history.indoor[0]!.timestamp,
      to: staleTo,
      indoorSamples: history.indoor,
      outdoorSamples: history.outdoor,
      horizonHours: 6,
    });
    expect(stale.scenarioAnchorTimestamp).toBe(history.indoor.at(-1)!.timestamp);
    expect(stale.calibration.warnings).toContain("STALE_SCENARIO_ANCHOR");
    expect(stale.points.filter((point) => point.phase === "scenario")).toEqual([]);

    const old = syntheticSeries(48);
    const recent = syntheticSeries(1);
    const recentStart = Date.parse(old.indoor.at(-1)!.timestamp) + 6 * 3_600_000;
    const templateStart = Date.parse(recent.indoor[0]!.timestamp);
    const moveTimestamp = (timestamp: string) => new Date(recentStart + Date.parse(timestamp) - templateStart).toISOString();
    recent.indoor = recent.indoor.map((sample) => ({ ...sample, timestamp: moveTimestamp(sample.timestamp) }));
    recent.outdoor = recent.outdoor.map((sample) => ({
      ...sample,
      timestamp: moveTimestamp(sample.timestamp),
      fetchedAt: moveTimestamp(sample.fetchedAt),
    }));
    const postGap = runThermalSimulation({
      houseId: "house-synthetic",
      sensorId: "sensor-synthetic",
      roomLabel: "Recovered room",
      from: old.indoor[0]!.timestamp,
      to: recent.indoor.at(-1)!.timestamp,
      indoorSamples: [...old.indoor, ...recent.indoor],
      outdoorSamples: [...old.outdoor, ...recent.outdoor],
      horizonHours: 2,
    });
    expect(postGap.calibration.model?.trainedTo).toBe(old.indoor.at(-1)!.timestamp);
    expect(postGap.scenarioAnchorTimestamp).toBe(recent.indoor.at(-1)!.timestamp);
    expect(postGap.points.filter((point) => point.phase === "scenario")).toHaveLength(2);
  });
});

describe("thermal simulation API and outdoor persistence", () => {
  let runtime: ApiRuntime;

  beforeEach(() => {
    runtime = createApi({ config, startBackground: false });
  });

  afterEach(async () => { await runtime.close(); });

  it("exposes the product release independently from the API contract version", async () => {
    const response = await request(runtime.app).get("/api/v1/health").expect(200);
    expect(response.body).toMatchObject({ status: "ok", systemVersion: "0.4.0", apiVersion: "v1" });
  });

  it("stores boundary samples idempotently and isolates changed locations", () => {
    const base: OutdoorTemperatureSample = {
      houseId: "house-main",
      locationKey: "60.000000,24.000000",
      timestamp: "2026-07-14T10:00:00.000Z",
      temperatureC: 12,
      source: "api",
      fetchedAt: "2026-07-14T10:01:00.000Z",
      stationId: null,
      stationName: null,
    };
    runtime.database.upsertOutdoorTemperatureSample(base);
    runtime.database.upsertOutdoorTemperatureSample({ ...base, temperatureC: 13 });
    runtime.database.upsertOutdoorTemperatureSample({ ...base, locationKey: "61.000000,25.000000", temperatureC: 2 });

    expect(runtime.database.outdoorTemperatureHistory(base.houseId, base.locationKey, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"))
      .toEqual([{ ...base, temperatureC: 13 }]);
    expect(runtime.database.outdoorTemperatureHistory(base.houseId, "61.000000,25.000000", "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"))
      .toHaveLength(1);
  });

  it("uses opaque location keys, erases boundaries on location change, and applies retention", () => {
    const location = { latitude: 60, longitude: 24 };
    const key = outdoorLocationKey(location);
    expect(key).not.toContain("60.000000");
    expect(outdoorLocationKey(location)).toBe(key);
    runtime.database.updateHouse("house-main", { location });
    const old: OutdoorTemperatureSample = {
      houseId: "house-main",
      locationKey: key,
      timestamp: "2025-01-01T00:00:00.000Z",
      temperatureC: -2,
      source: "api",
      fetchedAt: "2025-01-01T00:01:00.000Z",
      stationId: null,
      stationName: null,
    };
    runtime.database.upsertOutdoorTemperatureSample(old);
    runtime.database.upsertOutdoorTemperatureSample({ ...old, timestamp: "2026-07-14T10:00:00.000Z" });
    expect(runtime.database.purgeReadingsBefore("2026-01-01T00:00:00.000Z")).toBeGreaterThanOrEqual(1);
    runtime.database.updateHouse("house-main", { location: null });
    expect(runtime.database.outdoorTemperatureHistory("house-main", key, "2025-01-01T00:00:00Z", "2027-01-01T00:00:00Z"))
      .toEqual([]);
  });

  it("aggregates dense database telemetry before fitting", () => {
    const start = Date.parse("2026-07-14T10:00:00.000Z");
    runtime.database.insertMeasurementSamples(Array.from({ length: 60 }, (_, index) => ({
      sensorId: "sensor-01",
      metric: "temperature",
      value: 20 + index / 100,
      canonicalUnit: "°C",
      timestamp: new Date(start + index * 10_000).toISOString(),
      source: "api" as const,
      quality: "good" as const,
    })));
    const buckets = runtime.database.thermalTemperatureHistory(
      "sensor-01",
      "2026-07-14T10:00:00.000Z",
      "2026-07-14T10:10:00.000Z",
    );
    expect(buckets).toHaveLength(2);
    expect(buckets.map((sample) => sample.timestamp)).toEqual([
      "2026-07-14T10:00:00.000Z",
      "2026-07-14T10:05:00.000Z",
    ]);
  });

  it("persists only fresh observed weather", () => {
    const weather = (stale: boolean): HouseWeather => ({
      houseId: "house-main",
      location: { latitude: 60, longitude: 24 },
      provider: "fmi",
      attribution: "FMI",
      fetchedAt: "2026-07-14T10:01:00.000Z",
      forecastIssuedAt: null,
      stale,
      current: { timestamp: "2026-07-14T10:00:00.000Z", temperatureC: 12 },
      observationStation: null,
      forecast: [],
      warnings: [],
      unavailable: [],
    });
    persistWeatherObservation(runtime.database, weather(true));
    expect(runtime.database.outdoorTemperatureHistory("house-main", outdoorLocationKey(weather(true).location), "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"))
      .toEqual([]);
    runtime.database.updateHouse("house-main", { location: weather(false).location });
    persistWeatherObservation(runtime.database, weather(false));
    expect(runtime.database.outdoorTemperatureHistory("house-main", outdoorLocationKey(weather(false).location), "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"))
      .toHaveLength(1);
  });

  it("serves the explicitly synthetic demo model and validates house scope", async () => {
    const response = await request(runtime.app).get("/api/v1/houses/house-main/thermal-simulation")
      .query({ sensorId: "sensor-01", horizonHours: 3, scenarioOutdoorTemperatureC: -15 })
      .expect(200);
    expect(response.body.simulation).toMatchObject({
      systemVersion: "0.4.0",
      houseId: "house-main",
      sensorId: "sensor-01",
      horizonHours: 3,
      calibration: { status: "provisional", model: { method: "first-order-lumped-v1" } },
    });
    expect(response.body.simulation.calibration.warnings).toContain("SYNTHETIC_OUTDOOR_BOUNDARY");
    expect(response.body.simulation.points.some((point: { phase: string }) => point.phase === "scenario")).toBe(true);

    await request(runtime.app).post("/api/v1/houses").send({
      id: "other-house",
      name: "Other",
      timezone: "Europe/Helsinki",
      floors: [{ id: "main", name: "Main", width: 2, height: 2, elevation: 0, walls: [], rooms: [] }],
    }).expect(201);
    await request(runtime.app).get("/api/v1/houses/other-house/thermal-simulation")
      .query({ sensorId: "sensor-01" })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("SENSOR_HOUSE_MISMATCH"));

    await request(runtime.app).get("/api/v1/houses/house-main/thermal-simulation")
      .query({ sensorId: "sensor-01", from: "2026-01-01T00:00:00.000Z", to: "2026-01-16T00:00:00.000Z" })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("RANGE_TOO_LARGE"));
  });

  it("compares thermal isolation across rooms, floors, and the whole demo home", async () => {
    const response = await request(runtime.app)
      .get("/api/v1/houses/house-main/thermal-isolation")
      .expect(200);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.isolation).toMatchObject({
      systemVersion: "0.4.0",
      houseId: "house-main",
      methodology: {
        scoreMethod: "modeled-24h-retention-v1",
        aggregationMethod: "median-child-score-v1",
      },
    });
    const entries = response.body.isolation.entries as Array<{
      scope: { type: string };
      score: number | null;
    }>;
    expect(new Set(entries.map((entry) => entry.scope.type))).toEqual(new Set(["house", "floor", "room", "sensor"]));
    expect(entries.find((entry) => entry.scope.type === "house")?.score).toEqual(expect.any(Number));

    await request(runtime.app)
      .get("/api/v1/houses/house-main/thermal-isolation")
      .query({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-16T00:00:00.000Z" })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("RANGE_TOO_LARGE"));
  });
});
