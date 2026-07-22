import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { AppConfig } from "../src/config.js";
import { createApi, type ApiRuntime } from "../src/app.js";
import { dailyFindingPeriods } from "../src/daily-analytics-findings.js";
import { outdoorLocationKey } from "../src/db.js";

const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const config: AppConfig = {
  port: 0, apiHost: "127.0.0.1", databasePath: ":memory:", integrationSecretsFile: "integration-secrets.test.json", assetDirectory: ".",
  mockEnabled: false, mockIntervalMs: 25, retentionDays: 730, ingestApiKey: null,
  haUrl: null, haToken: null, haEntityMapFile: null,
  tpLinkHost: null, tpLinkUsername: null, tpLinkPassword: null, tpLinkDeviceMapFile: null,
  tpLinkPollIntervalMs: 10_000, tpLinkPython: "python", tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
  alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
};

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
    const opening = findings.find((finding) => finding.category === "opening") as { current: { value: number }; baselineMedian: number };
    expect(opening.current.value).toBe(13);
    expect(opening.baselineMedian).toBe(3);

    const second = await runtime.dailyAnalyticsFindings.runOnce();
    expect(second.skipped).toBe(2);
    expect(second.generated).toBe(0);
  });
});
