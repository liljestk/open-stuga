import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { AppConfig } from "../src/config.js";
import { createApi, type ApiRuntime } from "../src/app.js";
import { DailyAnalyticsFindingsWorker, dailyFindingPeriods } from "../src/daily-analytics-findings.js";
import { outdoorLocationKey } from "../src/db.js";

const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const config: AppConfig = {
  port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: "integration-secrets.test.json", assetDirectory: ".",
  mockEnabled: false, mockIntervalMs: 25, retentionDays: 730, ingestApiKey: null,
  haUrl: null, haToken: null, haEntityMapFile: null,
  tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null, tpLinkDeviceMapFile: null,
  tpLinkPollIntervalMs: 10_000, tpLinkPython: "python", tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
  corsOrigin: null,
  localAuthTestBypass: true,
};

it.each(["success", "failure"])("discards a demo run that reaches %s after live activation", async (outcome) => {
  const runtime = createApi({ config, startBackground: false, dailyAnalyticsNow: () => NOW });
  try {
    const house = runtime.database.listHouses()[0]!;
    expect(runtime.database.isRealDataMode()).toBe(false);
    const coverage = runtime.telemetryReader.measurementCoverage.bind(runtime.telemetryReader);
    vi.spyOn(runtime.telemetryReader, "measurementCoverage").mockImplementationOnce(async (query) => {
      runtime.database.activateRealDataMode();
      if (outcome === "failure") throw new Error("Telemetry unavailable");
      return coverage(query);
    });

    const run = await runtime.dailyAnalyticsFindings.runOnce();
    expect(runtime.database.isRealDataMode()).toBe(true);
    expect(run.generated).toBe(0);
    expect(runtime.database.dailyAnalyticsFindings(house.id, "demo")).toBeNull();
    expect(runtime.database.dailyAnalyticsFindings(house.id, "live")).toBeNull();

    expect((await runtime.dailyAnalyticsFindings.runOnce()).generated).toBe(1);
    expect(runtime.database.dailyAnalyticsFindings(house.id, "live")?.snapshot?.dataMode).toBe("live");
  } finally {
    await runtime.close();
  }
});

describe("daily analytics findings", () => {
  let runtime: ApiRuntime;

  beforeEach(() => {
    runtime = createApi({ config, startBackground: false, dailyAnalyticsNow: () => NOW });
    const floor = {
      id: "main", name: "Main floor", type: "ground" as const, width: 10, height: 8, elevation: 0,
      walls: [{ id: "north", from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }],
      rooms: [{ id: "living", name: "Living room", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }] }],
      planElements: [{
        id: "front-door", kind: "door" as const, label: "Front door", position: { x: 4, y: 0 },
        rotationDegrees: 0, width: 1, wallId: "north", variant: "exterior" as const, state: "closed" as const,
      }],
    };
    runtime.database.createHouse({
      id: "finding-house",
      name: "Finding house",
      timezone: "UTC",
      floors: [floor],
      location: { latitude: 60.1699, longitude: 24.9384 },
    });
    runtime.database.createSensor({
      id: "finding-sensor", houseId: "finding-house", floorId: "main", roomId: "living", room: "Living room",
      name: "Living room meter", model: "Test", x: 5, y: 4, z: 1.2, tags: [], enabled: true,
    });
    runtime.database.createSensor({
      id: "wilfa-projection", houseId: "finding-house", floorId: "main", roomId: "living", room: "Living room",
      name: "Wilfa return air", model: "Wilfa", x: 6, y: 4, z: 2, tags: ["equipment:heat-pump"], enabled: true,
    });
    runtime.database.activateRealDataMode();

    const measurements = [2025, 2026].flatMap((year) => Array.from({ length: 21 }, (_, day) => {
      const timestamp = new Date(Date.UTC(year, 6, day + 1, 12)).toISOString();
      const current = year === 2026;
      return [
        { sensorId: "finding-sensor", metric: "temperature", value: current ? 21 : 18, canonicalUnit: "°C", timestamp, source: "api" as const, quality: "good" as const },
        { sensorId: "finding-sensor", metric: "energy", value: day * (current ? 2 : 1), canonicalUnit: "kWh", timestamp, source: "api" as const, quality: "good" as const },
      ];
    })).flat();
    runtime.database.insertMeasurementSamples(measurements);
    runtime.database.insertMeasurementSamples([2025, 2026].flatMap((year) => (
      Array.from({ length: 21 }, (_, day) => ({
        sensorId: "wilfa-projection",
        metric: "temperature",
        value: year === 2026 ? 35 : 10,
        canonicalUnit: "°C",
        timestamp: new Date(Date.UTC(year, 6, day + 1, 12)).toISOString(),
        source: "gree" as const,
        quality: "good" as const,
      }))
    )));

    const key = outdoorLocationKey({ latitude: 60.1699, longitude: 24.9384 });
    for (const year of [2025, 2026]) {
      for (let day = 1; day <= 21; day += 1) {
        const timestamp = new Date(Date.UTC(year, 6, day, 12)).toISOString();
        runtime.database.upsertOutdoorTemperatureSample({
          houseId: "finding-house", locationKey: key, timestamp, temperatureC: year === 2026 ? 20 : 17,
          source: "api", fetchedAt: timestamp, stationId: "test", stationName: "Test station",
        });
      }
    }

    const recordOpenings = (year: number, count: number): void => {
      runtime.database.recordOpeningStateObservation("finding-house", {
        floorId: "main", elementId: "front-door", state: "closed", source: "api",
        observedAt: new Date(Date.UTC(year, 6, 1, 0, 5)).toISOString(),
      });
      for (let index = 0; index < count; index += 1) {
        const openAt = Date.UTC(year, 6, 1, 1 + index * 2);
        runtime.database.recordOpeningStateObservation("finding-house", {
          floorId: "main", elementId: "front-door", state: "open", source: "api",
          observedAt: new Date(openAt).toISOString(),
        });
        // A repeated provider heartbeat must not be counted as another opening.
        runtime.database.recordOpeningStateObservation("finding-house", {
          floorId: "main", elementId: "front-door", state: "open", source: "api",
          observedAt: new Date(openAt + 10 * 60_000).toISOString(),
        });
        runtime.database.recordOpeningStateObservation("finding-house", {
          floorId: "main", elementId: "front-door", state: "closed", source: "api",
          observedAt: new Date(openAt + 30 * 60_000).toISOString(),
        });
      }
    };
    recordOpenings(2025, 3);
    recordOpenings(2026, 13);
  });

  afterEach(async () => { await runtime.close(); });

  function measurement(timestamp: string, sensorId = "finding-sensor") {
    return {
      sensorId, metric: "temperature", canonicalUnit: "°C", value: 22,
      timestamp, quality: "good" as const, source: "api" as const,
    };
  }

  it("refreshes only the affected Home when evidence lands in a current or peer window", async () => {
    const worker = runtime.dailyAnalyticsFindings;
    expect((await worker.runOnce()).generated).toBe(2);
    const unrelatedSensor = runtime.database.listSensors("house-main")[0]!;
    // A sparse batch straddles a peer window without adding evidence inside it.
    runtime.database.insertMeasurementSamples([
      measurement("2025-06-30T23:59:59.999Z"),
      measurement("2025-07-22T00:00:00.000Z"),
    ]);
    expect((await worker.runOnce()).skipped).toBe(2);

    for (const timestamp of ["2025-07-08T10:00:00.000Z", "2026-07-08T10:00:00.000Z"]) {
      const coverage = vi.spyOn(runtime.telemetryReader, "measurementCoverage");
      runtime.database.insertMeasurementSamples([measurement(timestamp)]);
      expect(await worker.runOnce()).toMatchObject({ generated: 1, skipped: 1, failed: 0 });
      expect(coverage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        sensorIds: ["finding-sensor"],
      }));
      coverage.mockRestore();
      expect((await worker.runOnce()).skipped).toBe(2);
    }

    runtime.database.insertMeasurementSamples([measurement("2026-07-09T09:00:00.000Z", unrelatedSensor.id)]);
    expect(await worker.runOnce()).toMatchObject({ generated: 1, skipped: 1, failed: 0 });
  });

  it("refreshes for a weather correction at the selected location and a late leading opening state", async () => {
    const worker = runtime.dailyAnalyticsFindings;
    expect((await worker.runOnce()).generated).toBe(2);
    const timestamp = "2025-07-01T12:00:00.000Z";
    const weather = {
      houseId: "finding-house", locationKey: outdoorLocationKey({ latitude: 60.1699, longitude: 24.9384 }),
      timestamp, source: "api", temperatureC: 17, fetchedAt: timestamp, stationId: "test", stationName: "Test station",
    };
    runtime.database.upsertOutdoorTemperatureSample(weather);
    runtime.database.upsertOutdoorTemperatureSample({ ...weather, locationKey: "previous-location", temperatureC: 28 });
    expect((await worker.runOnce()).skipped).toBe(2);

    runtime.database.upsertOutdoorTemperatureSample({ ...weather, temperatureC: 28 });
    expect(await worker.runOnce()).toMatchObject({ generated: 1, skipped: 1 });

    const opening = {
      floorId: "main", elementId: "front-door", state: "open" as const, source: "api" as const,
      observedAt: "2025-06-30T22:00:00.000Z",
    };
    runtime.database.recordOpeningStateObservation("finding-house", { ...opening, validUntil: "2025-07-01T00:00:00.000Z" });
    expect((await worker.runOnce()).skipped).toBe(2);
    runtime.database.recordOpeningStateObservation("finding-house", { ...opening, validUntil: "2025-07-01T00:05:00.000Z" });
    expect(await worker.runOnce()).toMatchObject({ generated: 1, skipped: 1 });
  });

  it("discards a calculation if its registered evidence changes while reads are in flight", async () => {
    const worker = runtime.dailyAnalyticsFindings;
    const coverage = runtime.telemetryReader.measurementCoverage.bind(runtime.telemetryReader);
    const hook = vi.spyOn(runtime.telemetryReader, "measurementCoverage").mockImplementation(async (query) => {
      if (query.sensorIds.includes("finding-sensor")) {
        runtime.database.insertMeasurementSamples([measurement("2025-07-07T10:00:00.000Z")]);
      }
      return coverage(query);
    });
    expect(await worker.runOnce()).toMatchObject({ generated: 1, skipped: 1, failed: 0 });
    expect(runtime.database.dailyAnalyticsFindings("finding-house", "live")).toBeNull();
    hook.mockRestore();
    expect(await worker.runOnce()).toMatchObject({ generated: 1, skipped: 1, failed: 0 });
    expect(runtime.database.dailyAnalyticsFindings("finding-house", "live")?.snapshot?.evaluatedThrough).toBe("2026-07-21");
  });

  it("reconciles archive history before refreshing a dirty snapshot after worker restart", async () => {
    expect((await runtime.dailyAnalyticsFindings.runOnce()).generated).toBe(2);
    runtime.database.insertMeasurementSamples([measurement("2025-07-07T10:00:00.000Z")]);
    const reconcileArchive = vi.fn(async () => undefined);
    const coverage = vi.spyOn(runtime.telemetryReader, "measurementCoverage");
    const worker = new DailyAnalyticsFindingsWorker({
      database: runtime.database, telemetryReader: runtime.telemetryReader, reconcileArchive, now: () => NOW,
    });
    expect(await worker.runOnce()).toMatchObject({ generated: 1, skipped: 1, failed: 0 });
    expect(reconcileArchive).toHaveBeenCalledExactlyOnceWith();
    expect(reconcileArchive.mock.invocationCallOrder[0]).toBeLessThan(coverage.mock.invocationCallOrder[0]!);
    expect((await worker.runOnce()).skipped).toBe(2);
    expect(reconcileArchive).toHaveBeenCalledTimes(1);
  });

  it("refreshes stored findings when an archive changes even without new SQLite telemetry", async () => {
    const worker = runtime.dailyAnalyticsFindings;
    runtime.database.adoptDailyFindingsArchiveGeneration("first-archive");
    expect((await worker.runOnce()).generated).toBe(2);
    runtime.database.adoptDailyFindingsArchiveGeneration("first-archive");
    expect((await worker.runOnce()).skipped).toBe(2);

    const pending = vi.spyOn(runtime.telemetryReader, "measurementCoverage").mockImplementationOnce(async () => {
      runtime.database.adoptDailyFindingsArchiveGeneration("restored-archive");
      return { records: [], complete: true, archiveState: "not-configured" };
    });
    const interrupted = await worker.runOnce({ force: true });
    expect(interrupted.skipped).toBeGreaterThan(0);
    const waiting = await request(runtime.app).get("/api/v2/analytics/findings?houseId=finding-house").expect(200);
    expect(waiting.body).toMatchObject({ snapshot: null, status: { state: "pending" } });
    pending.mockRestore();

    expect((await worker.runOnce()).generated).toBe(2);
    expect((await worker.runOnce()).skipped).toBe(2);
  });

  it("uses equal month-to-date windows across DST-aware local calendars", () => {
    const periods = dailyFindingPeriods(NOW, "Europe/Helsinki");
    expect(periods).toMatchObject({
      evaluatedThrough: "2026-07-21",
      current: { start: "2026-06-30T21:00:00.000Z", end: "2026-07-21T21:00:00.000Z" },
    });
    expect(periods.baseline[0]).toMatchObject({
      start: "2025-06-30T21:00:00.000Z", end: "2025-07-21T21:00:00.000Z",
    });
  });

  it("persists sensor, weather, electricity, and deduplicated opening comparisons", async () => {
    const run = await runtime.dailyAnalyticsFindings.runOnce({ force: true });
    expect(run.failed).toBe(0);
    expect(run.generated).toBe(2);

    const response = await request(runtime.app)
      .get("/api/v2/analytics/findings?houseId=finding-house")
      .expect(200);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({
      status: { state: "ready", lastError: null },
      snapshot: {
        houseId: "finding-house",
        dataMode: "live",
        periodKind: "month-to-date",
        evaluatedThrough: "2026-07-21",
        warnings: [],
      },
    });
    const findings = response.body.snapshot.findings as Array<Record<string, unknown>>;
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "sensor", subjectLabel: "Living room meter", metric: "temperature", direction: "higher", absoluteDifference: 3 }),
      expect.objectContaining({ category: "electricity", subjectLabel: "Living room meter", metric: "energy", direction: "higher" }),
      expect.objectContaining({ category: "outdoor-weather", metric: "outdoor_temperature", direction: "higher", absoluteDifference: 3 }),
      expect.objectContaining({ category: "opening", subjectLabel: "Front door", metric: "opening_events", direction: "higher", absoluteDifference: 10 }),
    ]));
    expect(findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectLabel: "Wilfa return air" }),
    ]));
    const opening = findings.find((finding) => finding.category === "opening") as { current: { value: number }; baselineMedian: number };
    expect(opening.current.value).toBe(13);
    expect(opening.baselineMedian).toBe(3);

    // Every compared series counts towards the false-discovery control, reported or not.
    expect(response.body.snapshot).toMatchObject({ algorithmVersion: "calendar-peer-findings-v4.0.0", falseDiscoveryRate: 0.1 });
    expect(response.body.snapshot.seriesTested).toBeGreaterThanOrEqual(findings.length);
    for (const finding of findings) {
      expect(finding.qValue).toBeLessThanOrEqual(0.1);
      expect(typeof finding.zScore).toBe("number");
    }
    // One earlier year cannot show how much years vary, so the spread is assumed and the strength stays modest.
    expect(findings.find((finding) => finding.metric === "temperature")).toMatchObject({ spreadBasis: "assumed", strength: "notable" });
    expect(findings.find((finding) => finding.category === "opening")).toMatchObject({ spreadBasis: "counts" });

    const second = await runtime.dailyAnalyticsFindings.runOnce();
    expect(second.skipped).toBe(2);
    expect(second.generated).toBe(0);
  });
});
