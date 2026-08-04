import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { HeatPumpStateStore } from "../src/heat-pump-state.js";
import { readIntegrationSecrets, writeIntegrationSecrets } from "../src/integration-secrets.js";
import type { TimeseriesStore } from "../src/timeseries/store.js";

const MAC = "AABBCCDDEEFF";
const BINDING_KEY = "bound-key-123456";

describe("Gree/Wilfa integration", () => {
  let directory: string | null = null;
  let runtime: ApiRuntime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  it("binds explicitly, keeps the key write-only, stores typed state, and retains history on disconnect", async () => {
    directory = mkdtempSync(join(tmpdir(), "stugu-gree-"));
    const helper = join(directory, "gree-helper.mjs");
    const secretsPath = join(directory, "private", "integrations.json");
    writeFileSync(helper, `
      if (process.argv.includes("--discover")) {
        process.stdout.write(JSON.stringify({ type: "discovery", devices: [{
          host: "192.168.1.55", port: 7000, mac: "${MAC}",
          name: "Nordkapp", brand: "Wilfa", model: "Nordkapp 30", version: "4.0"
        }] }) + "\\n");
        process.exit(0);
      }
      const message = {
        type: "bound",
        device: {
          host: "192.168.1.55", port: 7000, mac: "${MAC}",
          name: "Nordkapp", brand: "Wilfa", model: "Nordkapp 30", version: "4.0"
        },
        key: "${BINDING_KEY}",
        cipherVersion: 1,
        state: {
          observedAt: "2026-07-29T08:00:00.000Z",
          available: true,
          power: true,
          selectedMode: "cool",
          targetTemperatureC: 22,
          currentTemperatureC: 25.5,
          currentTemperatureSource: "reported",
          currentHumidityPercent: 48,
          targetHumidityPercent: 50,
          fanSpeed: "Auto",
          horizontalSwing: "Default",
          verticalSwing: "FullSwing",
          freshAir: true,
          anion: true,
          sleep: false,
          light: true,
          quiet: false,
          turbo: false,
          xfan: true,
          steadyHeat: false,
          powerSave: true,
          cleanFilter: false,
          waterFull: false,
          dehumidifierMode: "AnionOnly",
          diagnostics: {
            sleepModeRaw: 0,
            temperatureUnitRaw: 0,
            temperatureRecordRaw: 0,
            heatCoolTypeRaw: 0
          },
          activity: "unknown",
          activityEvidence: "unavailable"
        }
      };
      process.stdout.write(JSON.stringify(message) + "\\n");
    `);
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      INTEGRATION_SECRETS_FILE: secretsPath,
      GREE_PYTHON: process.execPath,
      GREE_BRIDGE_SCRIPT: helper,
      SPATIAL_LAYERS_ENABLED: "true",
      SPATIAL_LAYERS_DATABASE_PATH: ":memory:",
    });
    runtime = createApi({ config, startBackground: false });

    expect(runtime.status.value.gree).toBeUndefined();
    const discovered = await request(runtime.app)
      .post("/api/v1/integrations/gree/discover")
      .send({ houseId: "house-main" })
      .expect(200);
    expect(discovered.body.devices).toEqual([expect.objectContaining({
      mac: MAC,
      model: "Nordkapp 30",
    })]);
    expect(runtime.status.value.gree).toBeUndefined();

    const configured = await request(runtime.app)
      .put("/api/v1/integrations/gree/config")
      .send({ houseId: "house-main", mac: "aa:bb:cc:dd:ee:ff" })
      .expect(200);

    expect(configured.body).toMatchObject({
      ok: true,
      configured: true,
      connectionId: "gree-aabbccddeeff",
      houseId: "house-main",
      state: {
        power: true,
        selectedMode: "cool",
        currentHumidityPercent: 48,
        targetHumidityPercent: 50,
        activity: "unknown",
        activityEvidence: "unavailable",
      },
      integration: {
        gree: { configured: true, connections: [{ mac: MAC, name: "Nordkapp" }] },
      },
    });
    expect(JSON.stringify(configured.body)).not.toContain(BINDING_KEY);

    const secrets = readIntegrationSecrets(secretsPath);
    expect(secrets.greeConnections).toEqual([expect.objectContaining({
      id: "gree-aabbccddeeff",
      houseId: "house-main",
      host: "192.168.1.55",
      mac: MAC,
      key: BINDING_KEY,
      cipherVersion: 1,
    })]);
    expect(readFileSync(secretsPath, "utf8")).toContain(BINDING_KEY);
    expect(runtime.database.getAreaEquipment(`heat-pump-${MAC.toLowerCase()}`)).toMatchObject({
      houseId: "house-main",
      kind: "air-source-heat-pump",
      manufacturer: "Wilfa",
      model: "Nordkapp 30",
      serialNumber: MAC,
    });
    const sensorId = "sensor-gree-aabbccddeeff";
    expect(runtime.database.getSensor(sensorId)).toMatchObject({
      id: sensorId,
      houseId: "house-main",
      name: "Nordkapp",
      model: "Wilfa Nordkapp 30",
      enabled: false,
      tags: expect.arrayContaining(["integration:gree", "equipment:heat-pump", "unplaced"]),
    });
    await request(runtime.app).get("/api/v1/houses/house-main/layers/config").expect(200)
      .expect(({ body }) => {
        expect(body.topology.sensorBindings).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ sensorId }),
        ]));
      });
    expect(runtime.database.latestMeasurementSamples("house-main")
      .filter((sample) => sample.sensorId === sensorId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "temperature", value: 25.5, source: "gree" }),
      expect.objectContaining({ metric: "humidity", value: 48, source: "gree" }),
      expect.objectContaining({ metric: "heat_pump_power", value: 1, source: "gree" }),
      expect.objectContaining({ metric: "heat_pump_target_humidity", value: 50, source: "gree" }),
      expect.objectContaining({ metric: "heat_pump_dehumidifier_mode", value: 9, source: "gree" }),
      expect.objectContaining({ metric: "heat_pump_sleep_mode_raw", value: 0, source: "gree" }),
    ]));

    const states = await request(runtime.app).get("/api/v1/heat-pumps?houseId=house-main").expect(200);
    expect(states.body.states).toEqual([expect.objectContaining({
      connectionId: "gree-aabbccddeeff",
      currentTemperatureC: 25.5,
      currentTemperatureSource: "reported",
    })]);
    await request(runtime.app)
      .get("/api/v1/heat-pumps/gree-aabbccddeeff/history")
      .expect(200)
      .expect(({ body }) => expect(body.states).toHaveLength(1));
    expect(runtime.heatPumpStates.archivePage(0, 10)).toEqual([
      expect.objectContaining({
        rowId: 1,
        record: expect.objectContaining({ currentTemperatureC: 25.5 }),
      }),
    ]);

    runtime.heatPumpStates.record({
      ...configured.body.state,
      observedAt: "2026-07-29T08:05:00.000Z",
      receivedAt: "2026-07-29T08:05:01.000Z",
      power: false,
      activity: "off",
      activityEvidence: "protocol",
    });
    await request(runtime.app).get("/api/v2/measurements/history").query({
      sensorId,
      metric: "heat_pump_power",
      from: "2026-07-29T07:59:00.000Z",
      to: "2026-07-29T08:06:00.000Z",
    }).expect(200).expect(({ body }) => {
      expect(body.samples.map((sample: { value: number }) => sample.value)).toEqual([1, 0]);
    });
    await request(runtime.app).post("/api/v2/analytics/query").send({
      apiVersion: "1.0",
      dataMode: "live",
      scope: { kind: "house", id: "house-main", entityIds: [sensorId] },
      measurementIds: ["heat_pump_power"],
      range: {
        start: "2026-07-29T07:59:00.000Z",
        end: "2026-07-29T08:06:00.000Z",
        timezone: "Europe/Helsinki",
      },
      resolution: "5m",
      aggregation: "default",
      include: ["series", "summary", "quality", "provenance"],
      maxPointsPerSeries: 500,
      requestId: "gree-power-analytics",
    }).expect(200).expect(({ body }) => {
      expect(body.series).toEqual([expect.objectContaining({
        entityId: sensorId,
        measurementId: "heat_pump_power",
        summary: expect.objectContaining({ count: 2, minimum: 0, maximum: 1 }),
      })]);
    });
    await request(runtime.app).patch(`/api/v1/sensors/${sensorId}`)
      .send({ name: "Changed outside Set up" })
      .expect(409);
    await request(runtime.app).delete(`/api/v1/sensors/${sensorId}`).expect(409);

    const disconnected = await request(runtime.app)
      .delete("/api/v1/integrations/gree/config/gree-aabbccddeeff")
      .expect(200);
    expect(disconnected.body.integration.gree).toBeUndefined();
    expect(readIntegrationSecrets(secretsPath).greeConnections).toEqual([]);
    expect(runtime.database.getSensor(sensorId)).toMatchObject({
      id: sensorId,
      enabled: false,
      tags: expect.arrayContaining(["integration:gree:detached", "equipment:heat-pump", "unplaced"]),
    });
    expect(runtime.database.getSensor(sensorId)?.tags).not.toContain("integration:gree");
    await request(runtime.app).patch(`/api/v1/sensors/${sensorId}`)
      .send({ name: "Retained heat-pump history" })
      .expect(200)
      .expect(({ body }) => expect(body.sensor).toMatchObject({
        name: "Retained heat-pump history",
        enabled: false,
      }));
    expect(runtime.database.measurementHistory(
      sensorId,
      "heat_pump_power",
      "2026-07-29T07:59:00.000Z",
      "2026-07-29T08:06:00.000Z",
    ).map((sample) => sample.value)).toEqual([1, 0]);
    await request(runtime.app).get("/api/v1/heat-pumps?houseId=house-main").expect(200)
      .expect(({ body }) => expect(body.states).toEqual([]));
    await request(runtime.app).get("/api/v1/heat-pumps/gree-aabbccddeeff/history").expect(200)
      .expect(({ body }) => {
        expect(body.states).toHaveLength(3);
        expect(body.states).toEqual(expect.arrayContaining([
          expect.objectContaining({ available: false }),
        ]));
      });

    await request(runtime.app)
      .put("/api/v1/integrations/gree/config")
      .send({ houseId: "house-main", mac: "aa:bb:cc:dd:ee:ff" })
      .expect(200);
    expect(runtime.database.getSensor(sensorId)).toMatchObject({
      id: sensorId,
      name: "Nordkapp",
      enabled: false,
      tags: expect.arrayContaining(["integration:gree", "equipment:heat-pump", "unplaced"]),
    });
    expect(runtime.database.getSensor(sensorId)?.tags).not.toContain("integration:gree:detached");
  });

  it("rejects conflicting Gree identities before writing the protected file", () => {
    directory = mkdtempSync(join(tmpdir(), "stugu-gree-secrets-"));
    const path = join(directory, "integrations.json");
    expect(() => writeIntegrationSecrets(path, {
      version: 1,
      greeConnections: [
        {
          id: "first", houseId: "house-main", host: "192.168.1.10", port: 7000,
          mac: MAC, key: "first-key", cipherVersion: 1,
        },
        {
          id: "second", houseId: "house-main", host: "192.168.1.11", port: 7000,
          mac: "aa:bb:cc:dd:ee:ff", key: "second-key", cipherVersion: 2,
        },
      ],
    })).toThrow(/conflicting identities/u);
  });

  it("discovers and binds EWPE read-only state, protects credentials, and saves Home placement", async () => {
    directory = mkdtempSync(join(tmpdir(), "stugu-ewpe-"));
    const secretsPath = join(directory, "private", "integrations.json");
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      INTEGRATION_SECRETS_FILE: secretsPath,
      SPATIAL_LAYERS_ENABLED: "true",
      SPATIAL_LAYERS_DATABASE_PATH: ":memory:",
    });
    runtime = createApi({ config, startBackground: false });
    const device = {
      transport: "ewpe-cloud" as const,
      host: "mqtt-eu.gree.com",
      port: 1984,
      mac: MAC,
      name: "AC3a95",
      brand: "Wilfa",
      model: "10001",
      version: "19.4",
      cloudHomeName: "Home",
      cloudRoomName: "Living room",
    };
    vi.spyOn(runtime.gree, "discoverCloud").mockResolvedValue([device]);
    vi.spyOn(runtime.gree, "bindCloud").mockResolvedValue({
      device,
      key: "device-envelope-key",
      cipherVersion: 1,
      state: {
        observedAt: "2026-08-03T17:20:00.000Z",
        available: true,
        power: true,
        selectedMode: "cool",
        targetTemperatureC: 20,
        currentTemperatureC: 20,
        currentTemperatureSource: "reported",
        currentHumidityPercent: 47,
        targetHumidityPercent: 50,
        fanSpeed: "auto",
        horizontalSwing: "middle",
        verticalSwing: "full",
        freshAir: true,
        anion: true,
        sleep: false,
        light: true,
        quiet: false,
        turbo: false,
        xfan: true,
        steadyHeat: false,
        powerSave: true,
        cleanFilter: false,
        waterFull: false,
        dehumidifierMode: "anion-only",
        compressorFrequencyHz: 12,
        diagnostics: { wifiStatus: 1, faultCode: 0 },
        activity: "unknown",
        activityEvidence: "unavailable",
      },
    });

    await request(runtime.app)
      .post("/api/v1/integrations/gree/cloud/discover")
      .send({ houseId: "house-main", username: "reader@example.com", password: "secret" })
      .expect(200)
      .expect("cache-control", "no-store")
      .expect(({ body }) => expect(body.devices).toEqual([device]));
    expect(existsSync(secretsPath)).toBe(false);

    const configured = await request(runtime.app)
      .put("/api/v1/integrations/gree/cloud/config")
      .send({ houseId: "house-main", mac: MAC, username: "reader@example.com", password: "secret" })
      .expect(200);
    expect(configured.headers["cache-control"]).toBe("no-store");
    expect(configured.body).toMatchObject({
      connectionId: "gree-aabbccddeeff",
      state: {
        transport: "ewpe-cloud",
        compressorFrequencyHz: 12,
        diagnostics: { wifiStatus: 1, faultCode: 0 },
        floorId: null,
      },
    });
    expect(JSON.stringify(configured.body)).not.toContain("secret");
    expect(JSON.stringify(configured.body)).not.toContain("device-envelope-key");
    expect(readIntegrationSecrets(secretsPath).greeConnections).toEqual([
      expect.objectContaining({
        transport: "ewpe-cloud",
        cloudUsername: "reader@example.com",
        cloudPassword: "secret",
        key: "device-envelope-key",
      }),
    ]);

    await request(runtime.app)
      .patch("/api/v1/heat-pumps/gree-aabbccddeeff/placement")
      .send({ floorId: "floor-ground", roomId: "living", x: 2.5, y: 1.2, z: 2.3 })
      .expect(200)
      .expect(({ body }) => expect(body.state).toMatchObject({
        floorId: "floor-ground", roomId: "living", x: 2.5, y: 1.2, z: 2.3,
      }));
    expect(runtime.database.getSensor("sensor-gree-aabbccddeeff")).toMatchObject({
      floorId: "floor-ground",
      roomId: "living",
      room: "Living room",
      x: 2.5,
      y: 1.2,
      z: 2.3,
      enabled: true,
      tags: ["integration:gree", "equipment:heat-pump"],
    });
    await request(runtime.app).get("/api/v1/houses/house-main/layers/config").expect(200)
      .expect(({ body }) => {
        expect(body.topology.sensorBindings).toEqual(expect.arrayContaining([
          expect.objectContaining({ sensorId: "sensor-gree-aabbccddeeff" }),
        ]));
      });
    await request(runtime.app)
      .patch("/api/v1/heat-pumps/gree-aabbccddeeff/placement")
      .send({ floorId: "floor-ground", x: 99, y: 1 })
      .expect(422);
    await request(runtime.app)
      .get("/api/v1/heat-pumps?houseId=house-main")
      .expect(200)
      .expect(({ body }) => expect(body.states[0]).toMatchObject({
        floorId: "floor-ground", roomId: "living", x: 2.5, y: 1.2, z: 2.3,
      }));
    await request(runtime.app)
      .post("/api/v1/heat-pumps/gree-aabbccddeeff/commands")
      .send({ power: false })
      .expect(404);
  });

  it("journals every timestamped poll while reporting only semantic changes", () => {
    const config = loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" });
    runtime = createApi({ config, startBackground: false });
    const store = new HeatPumpStateStore(runtime.database);
    const base = {
      connectionId: "gree-history",
      houseId: "house-main",
      equipmentId: null,
      deviceId: MAC,
      name: "Heat pump",
      brand: "Wilfa",
      model: "Nordkapp 30",
      observedAt: "2026-07-29T08:00:00.000Z",
      receivedAt: "2026-07-29T08:00:01.000Z",
      available: true,
      power: true,
      selectedMode: "cool" as const,
      targetTemperatureC: 22,
      currentTemperatureC: null,
      currentTemperatureSource: "unavailable" as const,
      currentHumidityPercent: null,
      targetHumidityPercent: null,
      fanSpeed: "Auto",
      horizontalSwing: null,
      verticalSwing: null,
      freshAir: null,
      anion: null,
      sleep: null,
      light: null,
      quiet: false,
      turbo: false,
      xfan: false,
      steadyHeat: null,
      powerSave: null,
      cleanFilter: null,
      waterFull: null,
      dehumidifierMode: null,
      activity: "unknown" as const,
      activityEvidence: "unavailable" as const,
    };
    expect(store.record(base)).toBe(true);
    expect(store.record({
      ...base,
      observedAt: "2026-07-29T08:01:00.000Z",
      receivedAt: "2026-07-29T08:01:01.000Z",
    })).toBe(false);
    expect(store.record({
      ...base,
      observedAt: "2026-07-29T08:02:00.000Z",
      receivedAt: "2026-07-29T08:02:01.000Z",
      targetTemperatureC: 21,
    })).toBe(true);
    expect(store.history("gree-history")).toHaveLength(3);
    expect(store.archivePage(0, 10).map(({ record }) => record.observedAt)).toEqual([
      "2026-07-29T08:00:00.000Z",
      "2026-07-29T08:01:00.000Z",
      "2026-07-29T08:02:00.000Z",
    ]);
  });

  it("merges TimeDB history and fails closed when retained history cannot be read", async () => {
    const archivedState = {
      connectionId: "gree-history",
      houseId: "house-main",
      equipmentId: null,
      deviceId: MAC,
      name: "Nordkapp",
      brand: "Wilfa",
      model: "Nordkapp 30",
      observedAt: "2024-01-01T08:00:00.000Z",
      receivedAt: "2024-01-01T08:00:01.000Z",
      available: true,
      power: true,
      selectedMode: "heat" as const,
      targetTemperatureC: 21,
      currentTemperatureC: 20,
      currentTemperatureSource: "reported" as const,
      currentHumidityPercent: null,
      targetHumidityPercent: null,
      fanSpeed: "Auto",
      horizontalSwing: null,
      verticalSwing: null,
      freshAir: null,
      anion: null,
      sleep: null,
      light: null,
      quiet: false,
      turbo: false,
      xfan: false,
      steadyHeat: null,
      powerSave: null,
      cleanFilter: null,
      waterFull: null,
      dehumidifierMode: null,
      activity: "unknown" as const,
      activityEvidence: "unavailable" as const,
    };
    const archiveHistory = vi.fn(async () => [archivedState]);
    const timeseriesStore = {
      heatPumpStateHistory: archiveHistory,
      initialize: vi.fn(async () => { throw new Error("TimeDB unavailable"); }),
      close: vi.fn(async () => undefined),
    } as unknown as TimeseriesStore;
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      TIMESERIES_ENABLED: "true",
      RETENTION_DAYS: "30",
    });
    runtime = createApi({ config, startBackground: false, timeseriesStore });
    runtime.heatPumpStates.record({
      ...archivedState,
      observedAt: "2026-07-29T08:00:00.000Z",
      receivedAt: "2026-07-29T08:00:01.000Z",
      currentTemperatureC: 21,
    });

    await request(runtime.app)
      .get("/api/v1/heat-pumps/gree-history/history")
      .expect(200)
      .expect(({ body }) => {
        expect(body.states.map((state: { observedAt: string }) => state.observedAt)).toEqual([
          "2026-07-29T08:00:00.000Z",
          "2024-01-01T08:00:00.000Z",
        ]);
      });

    archiveHistory.mockRejectedValueOnce(new Error("TimeDB unavailable"));
    await request(runtime.app)
      .get("/api/v1/heat-pumps/gree-history/history?from=2024-01-01T00:00:00.000Z")
      .expect(503)
      .expect(({ body }) => {
        expect(body.error).toMatchObject({ code: "TELEMETRY_ARCHIVE_REQUIRED" });
      });
  });
});
