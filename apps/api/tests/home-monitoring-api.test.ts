import type { IntegrationStatus } from "@climate-twin/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { IncompleteTelemetryHistoryError } from "../src/timeseries/read-facade.js";

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
  corsOrigin: null,
  localAuthTestBypass: true,
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
    runtime.database.createSensor({
      id: "wilfa-projection",
      houseId: "home-one",
      floorId: "ground",
      room: "Kitchen",
      name: "Wilfa return air",
      model: "Wilfa",
      x: 2,
      y: 2,
      z: 2,
      tags: ["equipment:heat-pump"],
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
    }, {
      sensorId: "wilfa-projection",
      metric: "temperature",
      value: 35,
      canonicalUnit: "\u00b0C",
      timestamp,
      source: "gree",
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
    expect(detail.body).toMatchObject({
      completeness: "complete",
      warnings: [],
      provenance: { sourceIds: ["kitchen-t310"] },
    });
    expect(detail.body.evidenceSources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sensorId: "kitchen-t310",
        metric: "humidity",
        source: "tp-link",
        quality: "good",
        freshness: expect.objectContaining({ state: "fresh" }),
      }),
    ]));
    expect(detail.body.sensorCoverage[0]).toMatchObject({
      sensorId: "kitchen-t310",
      freshness: { state: "fresh" },
    });
    expect(detail.body.insights[0]).toMatchObject({
      kind: "humidity",
      titleCode: "monitoring.insight.humidity.title",
      freshness: { state: "fresh" },
      evidence: expect.arrayContaining([
        expect.objectContaining({
          metric: "humidity",
          sensorId: "kitchen-t310",
          source: "tp-link",
          quality: "good",
          freshness: expect.objectContaining({ state: "fresh" }),
        }),
      ]),
    });

    const cachedDetail = await request(runtime.app)
      .get("/api/v2/monitoring/houses/home-one?dataMode=live&include=insights")
      .expect(200);
    expect(cachedDetail.headers["x-stugu-cache"]).toBe("hit");
    expect(groupedRead).toHaveBeenCalledOnce();

    // New readings are bounded by the TTL rather than by clearing the cache.
    runtime.bus.publish({
      type: "measurement",
      data: {
        sensorId: "kitchen-t310",
        metric: "temperature",
        value: 22,
        canonicalUnit: "\u00b0C",
        timestamp: new Date().toISOString(),
        source: "tp-link",
        quality: "good",
      },
    });
    const afterReading = await request(runtime.app)
      .get("/api/v2/monitoring/houses/home-one?dataMode=live&include=insights")
      .expect(200);
    expect(afterReading.headers["x-stugu-cache"]).toBe("hit");

    // A workspace write clears the answer; trend history is recomputed with it.
    runtime.bus.publish({
      type: "mutation",
      data: { method: "POST", resource: "/alerts/alert-1/acknowledge", occurredAt: new Date().toISOString() },
    });
    const refreshedDetail = await request(runtime.app)
      .get("/api/v2/monitoring/houses/home-one?dataMode=live&include=insights")
      .expect(200);
    expect(refreshedDetail.headers["x-stugu-cache"]).toBe("miss");
    expect(groupedRead).toHaveBeenCalledTimes(2);
  });

  it("keeps cached answers through poll-only integration status and drops them when health changes", async () => {
    const status = (await request(runtime.app).get("/api/v1/integrations/status").expect(200)).body as IntegrationStatus;
    const polledAt = (iso: string): IntegrationStatus => ({
      ...status,
      tpLink: { ...status.tpLink, lastPollAt: iso },
      homeAssistant: { ...status.homeAssistant, lastEventAt: iso },
      weather: { ...status.weather, lastSuccessAt: iso },
    });
    const detail = () => request(runtime.app)
      .get("/api/v2/monitoring/houses/home-one?dataMode=live")
      .expect(200);
    const collection = () => request(runtime.app)
      .get("/api/v2/monitoring/houses?dataMode=live")
      .expect(200);

    runtime.bus.publish({ type: "integration", data: polledAt("2026-10-28T10:00:00.000Z") });
    expect((await detail()).headers["x-stugu-cache"]).toBe("miss");
    expect((await collection()).headers["x-stugu-cache"]).toBe("miss");

    runtime.bus.publish({ type: "integration", data: polledAt("2026-10-28T10:01:00.000Z") });
    runtime.bus.publish({ type: "integration", data: polledAt("2026-10-28T10:02:00.000Z") });
    expect((await detail()).headers["x-stugu-cache"]).toBe("hit");
    expect((await collection()).headers["x-stugu-cache"]).toBe("hit");

    const disconnected = polledAt("2026-10-28T10:03:00.000Z");
    runtime.bus.publish({
      type: "integration",
      data: { ...disconnected, tpLink: { ...disconnected.tpLink, configured: true, connected: !status.tpLink.connected } },
    });
    expect((await detail()).headers["x-stugu-cache"]).toBe("miss");
    expect((await collection()).headers["x-stugu-cache"]).toBe("miss");
  });

  it("reports estimated and missing evidence as partial or unavailable", async () => {
    const timestamp = new Date(Date.now() + 1_000).toISOString();
    runtime.database.insertMeasurementSamples([{
      sensorId: "kitchen-t310",
      metric: "temperature",
      value: 21.7,
      canonicalUnit: "\u00b0C",
      timestamp,
      source: "home-assistant",
      quality: "estimated",
    }, {
      sensorId: "kitchen-t310",
      metric: "humidity",
      value: 77,
      canonicalUnit: "%",
      timestamp,
      source: "home-assistant",
      quality: "estimated",
    }]);

    const partial = await request(runtime.app)
      .get("/api/v2/monitoring/houses/home-one?dataMode=live&include=insights")
      .expect(200);
    expect(partial.body.completeness).toBe("partial");
    expect(partial.body.warnings).toContainEqual(expect.objectContaining({
      code: "monitoring.estimated-evidence",
    }));
    expect(partial.body.evidenceSources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sensorId: "kitchen-t310",
        source: "home-assistant",
        quality: "estimated",
        freshness: expect.objectContaining({ state: "estimated" }),
      }),
    ]));

    runtime.database.createHouse({
      id: "home-without-evidence",
      name: "Home without evidence",
      timezone: "UTC",
      floors: [{
        id: "ground-empty",
        name: "Ground",
        width: 10,
        height: 10,
        elevation: 0,
        walls: [],
        rooms: [],
      }],
    });
    runtime.database.createSensor({
      id: "empty-sensor",
      houseId: "home-without-evidence",
      floorId: "ground-empty",
      room: "Utility",
      name: "Empty sensor",
      model: "Generic",
      x: 1,
      y: 1,
      z: 1,
      tags: [],
      enabled: true,
    });
    const unavailable = await request(runtime.app)
      .get("/api/v2/monitoring/houses/home-without-evidence?dataMode=live")
      .expect(200);
    expect(unavailable.body).toMatchObject({
      completeness: "unavailable",
      provenance: { sourceIds: [] },
      evidenceSources: [],
    });
    expect(unavailable.body.warnings).toContainEqual(expect.objectContaining({
      code: "monitoring.missing-evidence",
    }));
  });

  it("returns explicit partial evidence while the telemetry archive recovers", async () => {
    const history = vi.spyOn(runtime.telemetryReader, "measurementAnalyticsRollup")
      .mockRejectedValue(new IncompleteTelemetryHistoryError("failed"));

    const detail = await request(runtime.app)
      .get("/api/v2/monitoring/houses/home-one?dataMode=live&include=insights")
      .expect(200);

    expect(history).toHaveBeenCalledOnce();
    expect(detail.body).toMatchObject({
      completeness: "partial",
      warnings: expect.arrayContaining([expect.objectContaining({
        code: "TELEMETRY_ARCHIVE_REQUIRED",
        details: { archiveState: "failed" },
      })]),
    });
    expect(detail.body.evidenceSources).not.toHaveLength(0);
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
