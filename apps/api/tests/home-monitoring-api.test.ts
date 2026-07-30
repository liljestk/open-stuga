import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

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

describe("Home monitoring API", () => {
  let runtime: ApiRuntime;

  beforeEach(() => {
    runtime = createApi({ config, startBackground: false });
    runtime.database.activateRealDataMode();
    runtime.database.createHouse({
      id: "home-one",
      name: "Home one",
      timezone: "UTC",
      floors: [{
        id: "ground",
        name: "Ground",
        width: 10,
        height: 10,
        elevation: 0,
        walls: [],
        rooms: [],
      }],
    });
    runtime.database.createSensor({
      id: "kitchen-t310",
      houseId: "home-one",
      floorId: "ground",
      room: "Kitchen",
      name: "Kitchen T310",
      model: "T310",
      x: 1,
      y: 1,
      z: 1,
      tags: [],
      enabled: true,
    });
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    runtime.database.insertMeasurementSamples([{
      sensorId: "kitchen-t310",
      metric: "temperature",
      value: 21.5,
      canonicalUnit: "\u00b0C",
      timestamp,
      source: "tp-link",
      quality: "good",
    }, {
      sensorId: "kitchen-t310",
      metric: "humidity",
      value: 78,
      canonicalUnit: "%",
      timestamp,
      source: "tp-link",
      quality: "good",
    }]);
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("returns consistent collection and detail semantics from current projections", async () => {
    const collection = await request(runtime.app)
      .get("/api/v2/monitoring/houses?dataMode=live")
      .expect(200);
    expect(collection.headers["cache-control"]).toBe("private, no-store");
    expect(collection.body).toMatchObject({
      apiVersion: "1.0",
      dataMode: "live",
      algorithm: {
        key: "home-monitoring",
        version: "home-monitoring-v2.0.0",
      },
    });
    const collectionHome = collection.body.houses.find(
      (item: { houseId: string }) => item.houseId === "home-one",
    );
    expect(collectionHome).toMatchObject({
        houseId: "home-one",
        pulseStatus: "attention",
        status: "monitoring-ok",
        coverage: {
          enabledSensors: 1,
          freshSensors: 1,
          sensorsWithoutData: 0,
        },
    });

    const groupedRead = vi.spyOn(runtime.database, "measurementHistoryBucketedMulti");
    const legacyPerSeriesRead = vi.spyOn(runtime.database, "measurementHistoryBucketed");
    const cacheClock = vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-07-30T09:00:10.000Z"),
    );
    const detail = await request(runtime.app)
      .get("/api/v2/monitoring/houses/home-one?dataMode=live&include=insights")
      .expect(200);
    expect(detail.headers["x-stugu-cache"]).toBe("miss");
    expect(groupedRead).toHaveBeenCalledOnce();
    expect(legacyPerSeriesRead).not.toHaveBeenCalled();
    expect(detail.body.house).toMatchObject({
      houseId: collectionHome.houseId,
      pulseStatus: collectionHome.pulseStatus,
      status: collectionHome.status,
      coverage: collectionHome.coverage,
      activeAlertCount: collectionHome.activeAlertCount,
      blockers: collectionHome.blockers,
    });
    expect(detail.body.sensorCoverage[0]).toMatchObject({
      sensorId: "kitchen-t310",
      freshness: { state: "fresh" },
    });
    expect(detail.body.insights[0]).toMatchObject({
      kind: "humidity",
      titleCode: "monitoring.insight.humidity.title",
      freshness: { state: "fresh" },
    });

    const cachedDetail = await request(runtime.app)
      .get("/api/v2/monitoring/houses/home-one?dataMode=live&include=insights")
      .expect(200);
    expect(cachedDetail.headers["x-stugu-cache"]).toBe("hit");
    expect(groupedRead).toHaveBeenCalledOnce();

    runtime.bus.publish({
      type: "measurement",
      data: {
        sensorId: "kitchen-t310",
        metric: "temperature",
        value: 22,
        canonicalUnit: "\u00b0C",
        timestamp: "2026-07-30T09:00:11.000Z",
        source: "tp-link",
        quality: "good",
      },
    });
    cacheClock.mockReturnValue(Date.parse("2026-07-30T09:00:12.100Z"));
    const refreshedDetail = await request(runtime.app)
      .get("/api/v2/monitoring/houses/home-one?dataMode=live&include=insights")
      .expect(200);
    expect(refreshedDetail.headers["x-stugu-cache"]).toBe("miss");
    expect(groupedRead).toHaveBeenCalledOnce();
    cacheClock.mockRestore();
  });

  it("rejects cross-mode, invalid includes, and unknown Homes", async () => {
    await request(runtime.app)
      .get("/api/v2/monitoring/houses?dataMode=demo")
      .expect(409);
    await request(runtime.app)
      .get("/api/v2/monitoring/houses/home-one?dataMode=live&include=raw")
      .expect(400);
    await request(runtime.app)
      .get("/api/v2/monitoring/houses/missing?dataMode=live")
      .expect(404);
  });
});
